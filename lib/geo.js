// Turning "that ramen bar in Adams Morgan" into a pin.
//
// Nominatim (OpenStreetMap) rather than a model: this is geocoding, a solved
// problem with a real answer, and asking a language model where something is
// gets you a plausible coordinate rather than a correct one — which on a map is
// worse than nothing, because a wrong pin looks exactly like a right one.
//
// Nominatim's usage policy is the constraint that shapes this file: one request
// per second, a real User-Agent, and cache aggressively. So every lookup goes
// through a store-backed cache first, requests are serialised behind a single
// queue, and a name that failed to resolve is remembered as having failed so it
// is not retried on every render.
const store = require('./../store');
const { state } = store;
const config = require('./config');

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
// Their policy asks for something identifying with a contact address. Falls back
// to something honest rather than pretending to be a browser.
const AGENT = () => config.get('geoUserAgent', 'DoWith/1.0 (self-hosted; +https://github.com/andgly95)');
const MIN_GAP_MS = 1100;          // one a second, with room to spare
const NEG_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // remember a failure for a week
const MAX_CACHE = 2000;

const key = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

const cache = () => {
  if (!state.places || typeof state.places !== 'object') state.places = {};
  return state.places;
};

// A coordinate is range-checked before it is ever stored. The trips app learned
// this the hard way: one bad pin sits in the sea forever, and it is far cheaper
// to refuse it here than to find it later.
function onEarth(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
    // 0,0 is in the Gulf of Guinea and is almost always a parsing failure rather
    // than a place anybody means.
    && !(lat === 0 && lon === 0);
}

function remember(name, value) {
  const c = cache();
  c[key(name)] = { ...value, at: Date.now() };
  const keys = Object.keys(c);
  if (keys.length > MAX_CACHE) {
    // Oldest out. A cache that grows forever is a slow leak in a single JSON file.
    keys.sort((a, b) => (c[a].at || 0) - (c[b].at || 0));
    for (const k of keys.slice(0, keys.length - MAX_CACHE)) delete c[k];
  }
  store.save();
  return value;
}

// Already known? Includes remembered failures, so a name that isn't a place
// doesn't cost a request on every single render.
function cached(name, { now = Date.now() } = {}) {
  const hit = cache()[key(name)];
  if (!hit) return null;
  if (hit.lat === null && (now - (hit.at || 0)) > NEG_TTL_MS) return null;   // worth another go
  return hit;
}

/* ── the queue ───────────────────────────────────────────────────────────── */

let chain = Promise.resolve();
let last = 0;

// Serialised, and spaced. Concurrent lookups from one page render would otherwise
// arrive as a burst, which is exactly what the usage policy asks you not to do.
function queued(fn) {
  chain = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    return fn();
  }).catch(() => null);
  return chain;
}

// → { name, lat, lon, label } | { name, lat: null } | null
//
// Never throws. A geocoder being down means "no pin yet", not a 500 on a page
// that is mostly about something else.
async function lookup(name, { fetchImpl = fetch, now = Date.now() } = {}) {
  const q = key(name);
  if (!q || q.length < 2) return null;
  const hit = cached(q, { now });
  if (hit) return hit;

  return queued(async () => {
    // Check again inside the queue: several items with the same place resolve to
    // one request rather than one each.
    const again = cached(q, { now: Date.now() });
    if (again) return again;
    try {
      const url = `${ENDPOINT}?format=jsonv2&limit=1&q=${encodeURIComponent(name)}`;
      const r = await fetchImpl(url, { headers: { 'User-Agent': AGENT(), 'Accept-Language': 'en' } });
      if (!r.ok) throw new Error(`nominatim ${r.status}`);
      const list = await r.json();
      const top = Array.isArray(list) ? list[0] : null;
      const lat = top ? Number(top.lat) : NaN;
      const lon = top ? Number(top.lon) : NaN;
      if (!top || !onEarth(lat, lon)) return remember(q, { name: q, lat: null, lon: null, label: null });
      return remember(q, {
        name: q,
        lat, lon,
        label: String(top.display_name || '').slice(0, 200) || null,
      });
    } catch (e) {
      console.error('geo:', e.message);
      // Deliberately NOT remembered: a network blip is not evidence that a place
      // does not exist, and caching that would be wrong for a week.
      return null;
    }
  });
}

module.exports = { lookup, cached, remember, onEarth, key, MIN_GAP_MS, NEG_TTL_MS, MAX_CACHE };
