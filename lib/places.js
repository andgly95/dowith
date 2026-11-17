// "Where is it?", answered while you type.
//
// The Where field used to be free text that Nominatim resolved later, on its
// own, with nobody watching — the same guess-when-nobody-is-there that watch.js
// gave up on, for the same reason: "Toki" is a ramen bar on H Street to you and
// a city in Japan to a geocoder, and a wrong pin looks exactly like a right one.
// So the field now ASKS, with a short list of real places as you type, and the
// one you tap is stored with its coordinates. Free text still works and still
// falls back to the old lazy lookup; it is just no longer the only way in.
//
// ── Why Photon, not Nominatim ───────────────────────────────────────────────
//
// Nominatim's usage policy forbids exactly this: "auto-complete search is not
// supported … you must not implement such a service on the client side". Photon
// is built by komoot on the same OpenStreetMap data, for type-ahead, prefix
// matching included ("toki undergr" finds Toki Underground), so the pins agree
// with the tiles they sit on. No key, which matters: a feature that needs a
// billing account before it does anything is a feature nobody turns on. Their
// public instance is fair-use, so a lookup is cached here and a two-person app
// never comes close.
//
// If OSM ever proves too thin for the places you actually go, the swap is this
// file: `suggest()` is the whole contract the route and the client rely on.
//
// ── What leaves the building ────────────────────────────────────────────────
//
// The text being typed and, as a bias, the middle of the pins already in your
// list — never who you are, never the list. Proxied by the server, so Photon
// sees this box rather than each phone. Same trade as geo.js makes.
const config = require('./config');

const ENDPOINT = () => config.get('placesEndpoint', 'https://photon.komoot.io/api/');
const AGENT = () => config.get('geoUserAgent', 'DoWith/1.0 (self-hosted; +https://github.com/andgly95)');
const LIMIT = 6;
const MIN_Q = 2;
const TIMEOUT_MS = 4000;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 400;

const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// The same rule as geo.onEarth, restated rather than imported: geo.js binds the
// store at require time, and this file is tested without one.
function onEarth(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
    && !(lat === 0 && lon === 0);
}

// OSM tags worth saying out loud, because they are what tells two places with
// the same name apart: the restaurant, not the street named after it. Anything
// else ("yes", "house", "residential") says nothing a person would use.
const WORTH_SAYING = new Set(['amenity', 'shop', 'leisure', 'tourism', 'historic', 'craft', 'office', 'natural']);
const pretty = (v) => str(v, 40).replace(/_/g, ' ');
const OSM_TYPES = { N: 'N', W: 'W', R: 'R', node: 'N', way: 'W', relation: 'R' };

// One Photon feature → one suggestion, or null. PURE.
//
// The address is the line under the name, built from parts rather than taken as
// a label, because Photon has no label and the parts are uneven: a restaurant
// has a house number, a park has a city, a city has a country.
function shapeOne(f) {
  const p = (f && f.properties) || {};
  const c = f && f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : [];
  const lon = Number(c[0]), lat = Number(c[1]);
  if (!onEarth(lat, lon)) return null;
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const name = str(p.name || street || p.city || p.county || p.state, 120);
  if (!name) return null;
  // Everything after the name that tells you where — minus anything that just
  // repeats it (a city's own name under a city). A street address is specific
  // enough to need only the city after it; without one, the country earns its
  // place, because "Adams Morgan Drive" is in Florida.
  const town = p.city || p.locality || p.county;
  const parts = (street ? [street, town, p.state] : [town, p.state, p.country])
    .map(x => str(x, 60)).filter(x => x && x !== name);
  const address = [...new Set(parts)].slice(0, 3).join(', ') || null;
  return {
    name,
    address: address ? address.slice(0, 200) : null,
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    what: WORTH_SAYING.has(p.osm_key) && p.osm_value && p.osm_value !== 'yes' ? pretty(p.osm_value) : null,
    // The neighbourhood, for "Blues Alley · Georgetown · 3.6 mi". The district
    // when OSM has one, then the locality; the city only as a last resort, and
    // never the place's own name.
    area: [p.district, p.locality, p.city].map(x => str(x, 60)).find(x => x && x !== name) || null,
    // Which OSM object, so a place page can fetch its hours and website later.
    osm: OSM_TYPES[p.osm_type] && /^[1-9]\d{0,18}$/.test(String(p.osm_id || ''))
      ? `${OSM_TYPES[p.osm_type]}${p.osm_id}` : null,
  };
}

// A whole response → the shortlist. Duplicates (the same name at the same
// address — OSM often has a node and a building for one place) appear once.
function shape(json) {
  const out = [];
  const seen = new Set();
  for (const f of (json && Array.isArray(json.features) ? json.features : [])) {
    const s = shapeOne(f);
    if (!s) continue;
    const k = `${s.name}|${s.address}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= LIMIT) break;
  }
  return out;
}

/* ── the cache ───────────────────────────────────────────────────────────────
   In memory, not in the store. Every prefix of everything anybody typed is not
   worth keeping in a JSON file forever; it is worth not asking twice in a minute,
   which is what typing, deleting and retyping does. */

const cache = new Map();
// Bias rounded to ~1km so a pin moving across the street is not a new query.
const keyOf = (q, near) => `${q.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : ''}`;

function remember(k, results) {
  cache.delete(k);
  cache.set(k, { results, at: Date.now() });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
}

// → { ok, results: [{ name, address, lat, lon, what }] }
//
// Never throws. Suggestions being unavailable means "type it and it will be
// looked up later", not an error on a sheet that is mostly about something else.
async function suggest(rawQ, near, { fetchImpl = fetch, now = Date.now() } = {}) {
  const q = str(rawQ, 120);
  if (q.length < MIN_Q) return { ok: true, results: [] };
  const bias = near && onEarth(Number(near.lat), Number(near.lon))
    ? { lat: Number(near.lat), lon: Number(near.lon) } : null;
  const k = keyOf(q, bias);
  const hit = cache.get(k);
  if (hit && now - hit.at < TTL_MS) return { ok: true, results: hit.results };

  const url = new URL(ENDPOINT());
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(LIMIT + 2));   // room for the duplicates shape() drops
  url.searchParams.set('lang', 'en');
  if (bias) {
    url.searchParams.set('lat', String(bias.lat));
    url.searchParams.set('lon', String(bias.lon));
    // Photon's default bias is gentle enough that "ramen" near DC led with a
    // place in Ryazan. These lean on distance over fame within roughly a city
    // (zoom 12), and a specific name still wins from anywhere — "Toki
    // Underground" biased to London still finds the one on H Street.
    url.searchParams.set('location_bias_scale', '0.1');
    url.searchParams.set('zoom', '12');
  }
  try {
    const r = await fetchImpl(url.toString(), {
      headers: { 'User-Agent': AGENT(), Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`photon ${r.status}`);
    const results = shape(await r.json());
    remember(k, results);
    return { ok: true, results };
  } catch (e) {
    console.error('places:', e.message);
    // Not remembered: a blip is not "there is nowhere by that name".
    return { ok: false, results: [] };
  }
}

module.exports = { suggest, shape, shapeOne, onEarth, LIMIT, MIN_Q, _cache: cache };
