// Getting there by public transport: how long from somebody's station to a
// place, and by which lines — and the station search behind "set your nearest
// station". Transitous (transitous.org), a community-run planner over public
// timetables: no key, no account, real routes.
//
// What is sent: a station's coordinates, a place's coordinates and a time.
// Never a person's own position — nobody's is known here. A station is
// something a person CHOSE to say (lib/stations.js), and it is as coarse as a
// neighbourhood.
//
// The same shape as geo.js and weather.js: an in-memory cache, a failure that
// is NOT remembered, a small pool so a list of places is not forty requests at
// once, and pure `shapeStops` / `shapePlan` the suite drives with fixtures.
// When it cannot answer, nothing is guessed: the caller is told the straight
// distance, which is a fact.
const config = require('./config');

const ENDPOINT = () => String(config.get('transitEndpoint', 'https://api.transitous.org')).replace(/\/+$/, '');
const AGENT = () => config.get('geoUserAgent', 'DoWith/1.0 (self-hosted)');
const PLAN_TTL_MS = 6 * 60 * 60 * 1000;
const STOP_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 1500;
const POOL = 4;
// Ordered: what "your nearest station" most likely means comes first.
const RAIL = ['SUBWAY', 'METRO', 'TRAM', 'RAIL', 'REGIONAL_RAIL', 'REGIONAL_FAST_RAIL', 'SUBURBAN', 'LONG_DISTANCE', 'HIGHSPEED_RAIL', 'FUNICULAR', 'CABLE_CAR'];
const MODES = [...RAIL, 'BUS', 'COACH', 'FERRY', 'AIRPLANE', 'OTHER'];

const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const onEarth = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
const r5 = (x) => Math.round(Number(x) * 1e5) / 1e5;

// Metres between two points (haversine).
function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ── stations, for the picker ───────────────────────────────────────────── */

// Transitous's geocoder → stations. Rail first, because that is what was asked
// for; a bus stop is still a stop, and is offered after.
function shapeStops(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map((x) => {
    if (!x || x.type !== 'STOP') return null;
    const lat = Number(x.lat), lon = Number(x.lon);
    const name = str(x.name, 80);
    if (!name || !onEarth(lat, lon)) return null;
    const modes = (Array.isArray(x.modes) ? x.modes : []).filter(m => MODES.includes(m)).slice(0, 6);
    const area = (Array.isArray(x.areas) ? x.areas : []).filter(a => a && a.default && a.name).map(a => str(a.name, 40))[0]
      || (Array.isArray(x.areas) ? x.areas : []).map(a => a && str(a.name, 40)).filter(Boolean).slice(-1)[0] || null;
    const key = `${name.toLowerCase()}|${Math.round(lat * 500)}|${Math.round(lon * 500)}`;   // one station, several platforms
    if (seen.has(key)) return null;
    seen.add(key);
    return { id: str(x.id, 80) || null, name, lat: r5(lat), lon: r5(lon), modes, area, rail: modes.some(m => RAIL.includes(m)) };
  }).filter(Boolean)
    .sort((a, b) => Number(b.rail) - Number(a.rail))
    .slice(0, 8);
}

const stopCache = new Map();
async function stops(q, near, { fetchImpl = fetch, now = Date.now() } = {}) {
  const text = str(q, 80);
  if (text.length < 2) return { ok: true, results: [] };
  const bias = near && onEarth(Number(near.lat), Number(near.lon)) ? { lat: Number(near.lat), lon: Number(near.lon) } : null;
  const k = `${text.toLowerCase()}|${bias ? `${bias.lat.toFixed(1)},${bias.lon.toFixed(1)}` : ''}`;
  const hit = stopCache.get(k);
  if (hit && now - hit.at < STOP_TTL_MS) return { ok: true, results: hit.value };
  const u = new URL(`${ENDPOINT()}/api/v1/geocode`);
  u.searchParams.set('text', text);
  u.searchParams.set('type', 'STOP');
  if (bias) { u.searchParams.set('place', `${bias.lat},${bias.lon}`); u.searchParams.set('placeBias', '4'); }
  try {
    const r = await fetchImpl(u, { signal: AbortSignal.timeout(7000), headers: { 'User-Agent': AGENT(), Accept: 'application/json' } });
    if (!r.ok) throw new Error(`transit ${r.status}`);
    const value = shapeStops(await r.json());
    stopCache.set(k, { value, at: now });
    if (stopCache.size > 400) stopCache.delete(stopCache.keys().next().value);
    return { ok: true, results: value };
  } catch (e) {
    console.error('transit stops:', e.message);
    return { ok: false, results: [] };
  }
}

/* ── a journey ──────────────────────────────────────────────────────────── */

// The planner's answer → the quickest way there: minutes door to door, how
// many changes, and the lines in order (walking legs left out; they are in the
// total). Null when it found no way.
function shapePlan(raw) {
  const its = (raw && Array.isArray(raw.itineraries) ? raw.itineraries : [])
    .concat(raw && Array.isArray(raw.direct) ? raw.direct : [])
    .filter(i => i && Number.isFinite(i.duration) && i.duration > 0 && Array.isArray(i.legs));
  if (!its.length) return null;
  const best = its.sort((a, b) => a.duration - b.duration)[0];
  const lines = best.legs.filter(l => l && l.mode && l.mode !== 'WALK').map(l => ({
    mode: MODES.includes(l.mode) ? l.mode : 'OTHER',
    line: str(l.routeShortName || l.displayName || '', 12) || null,
    color: /^[0-9a-fA-F]{6}$/.test(String(l.routeColor || '')) ? String(l.routeColor).toLowerCase() : null,
    from: str(l.from && l.from.name, 60) || null,
    to: str(l.to && l.to.name, 60) || null,
  })).slice(0, 6);
  return {
    minutes: Math.max(1, Math.round(best.duration / 60)),
    transfers: Math.max(0, lines.length - 1),
    lines,
    walk: !lines.length,
  };
}

// A short walk is a short walk: under about 900 m nobody takes a train, and
// the planner need not be asked. 80 m a minute along streets that are ~1.3×
// the straight line — said as "about", because it is.
function walkOf(from, to) {
  const m = metres(from, to);
  return m <= 900 ? { minutes: Math.max(2, Math.round((m * 1.3) / 80)), transfers: 0, lines: [], walk: true, about: true } : null;
}

const planCache = new Map();
const flying = new Map();
let active = 0;
const waiting = [];
const slot = () => new Promise((go) => { if (active < POOL) { active++; go(); } else waiting.push(go); });
const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

// The key a journey is cached under: both ends to ~100 m, the half hour it
// leaves in. A Tuesday at 6 pm and a Sunday at 6 pm are different timetables.
const planKey = (from, to, at) => `${from.lat.toFixed(3)},${from.lon.toFixed(3)}>${to.lat.toFixed(3)},${to.lon.toFixed(3)}@${Math.floor(at / 18e5)}`;

// What is already known, without asking: undefined when it is not.
function planCached(from, to, at, now = Date.now()) {
  const w = walkOf(from, to);
  if (w) return w;
  const hit = planCache.get(planKey(from, to, at));
  return hit && now - hit.at < PLAN_TTL_MS ? hit.value : undefined;
}

// { minutes, transfers, lines, walk } or null (no way, or the planner is down —
// a failure is not remembered).
async function plan(from, to, at, { fetchImpl = fetch } = {}) {
  if (!from || !to || !onEarth(from.lat, from.lon) || !onEarth(to.lat, to.lon) || !Number.isFinite(at)) return null;
  const known = planCached(from, to, at);
  if (known !== undefined) return known;
  const k = planKey(from, to, at);
  if (flying.has(k)) return flying.get(k);
  const job = (async () => {
    await slot();
    try {
      const u = new URL(`${ENDPOINT()}/api/v5/plan`);
      u.searchParams.set('fromPlace', `${r5(from.lat)},${r5(from.lon)}`);
      u.searchParams.set('toPlace', `${r5(to.lat)},${r5(to.lon)}`);
      u.searchParams.set('time', new Date(at).toISOString());
      u.searchParams.set('directModes', 'WALK');
      const r = await fetchImpl(u, { signal: AbortSignal.timeout(9000), headers: { 'User-Agent': AGENT(), Accept: 'application/json' } });
      if (!r.ok) throw new Error(`transit ${r.status}`);
      const value = shapePlan(await r.json());
      planCache.set(k, { value, at: Date.now() });
      if (planCache.size > MAX_CACHE) planCache.delete(planCache.keys().next().value);
      return value;
    } catch (e) {
      console.error('transit plan:', e.message);
      return undefined;   // not known — and not cached
    } finally { release(); flying.delete(k); }
  })();
  flying.set(k, job);
  return job;
}

// A date and a clock time in a zone → the instant. "Saturday 7 pm" is a wall
// clock; a timetable wants an instant.
function instantOf(date, time, zone) {
  const [y, mo, d] = String(date).split('-').map(Number);
  const [h, mi] = String(time || '12:00').split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const wall = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  };
  try {
    const first = guess - (wall(guess) - guess);
    return first - (wall(first) - guess);   // a second pass, for the hour either side of a clock change
  } catch (_) { return guess; }
}

module.exports = { RAIL, MODES, metres, shapeStops, stops, shapePlan, walkOf, plan, planCached, instantOf, onEarth };
