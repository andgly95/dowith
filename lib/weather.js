// Weather for a place: what it is like there now, whether rain is coming in the
// next few hours, and the forecast for the day it is planned for. Open-Meteo —
// no key, no account — through this server, so the phone's own position is
// never sent anywhere: only a place's pin, rounded to ~1 km, and only for a
// place the person asking can already see (the routes go through myItem).
//
// The same shape as geo.js: an in-memory cache (a forecast is a quarter of an
// hour fresh, and nobody's private business), a failure that is NOT remembered
// (a blip is not "no weather"), and a pure `shape`/`summary` the suite drives
// with a fixture and no network.
const config = require('./config');

const TTL_MS = 15 * 60 * 1000;
const MAX_CACHE = 300;
const DAYS = 14;
const ENDPOINT = () => config.get('weatherEndpoint', 'https://api.open-meteo.com/v1/forecast');

const cache = new Map();
const round = (x) => Math.round(Number(x) * 100) / 100;
const okPoint = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  && !(lat === 0 && lon === 0);
const num = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const int = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// Open-Meteo's arrays into rows, everything checked: it is somebody else's
// JSON, and it ends up on a screen.
function shape(raw) {
  if (!raw || typeof raw !== 'object' || !raw.current || !raw.daily || !raw.hourly) return null;
  const c = raw.current;
  if (!STAMP.test(String(c.time)) || !Number.isFinite(c.temperature_2m)) return null;
  const d = raw.daily;
  const days = (Array.isArray(d.time) ? d.time : []).map((date, i) => ({
    date, code: int(d.weather_code && d.weather_code[i]),
    hi: num(d.temperature_2m_max && d.temperature_2m_max[i]), lo: num(d.temperature_2m_min && d.temperature_2m_min[i]),
    rain: int(d.precipitation_probability_max && d.precipitation_probability_max[i]),
  })).filter(x => DATE.test(String(x.date))).slice(0, DAYS);
  const h = raw.hourly;
  const hours = (Array.isArray(h.time) ? h.time : []).map((time, i) => ({
    time, t: num(h.temperature_2m && h.temperature_2m[i]), code: int(h.weather_code && h.weather_code[i]),
    rain: int(h.precipitation_probability && h.precipitation_probability[i]),
  })).filter(x => STAMP.test(String(x.time))).slice(0, DAYS * 24);
  return {
    at: c.time,
    zone: typeof raw.timezone === 'string' ? raw.timezone.slice(0, 60) : null,
    now: { t: num(c.temperature_2m), feels: num(c.apparent_temperature), code: int(c.weather_code), day: c.is_day !== 0, wind: num(c.wind_speed_10m) },
    days,
    hours,
  };
}

// What a screen needs, from a whole forecast. Times are the PLACE's local
// times, as strings, so they compare as text and need no zone arithmetic. The
// plan is a calendar date (and maybe an "HH:MM"), the way the app stores one.
function summary(fc, { plan = null } = {}) {
  if (!fc) return null;
  const hourNow = `${fc.at.slice(0, 13)}:00`;
  const i0 = fc.hours.findIndex(x => x.time >= hourNow);
  const next = i0 < 0 ? [] : fc.hours.slice(i0 + 1, i0 + 13);
  // Rain worth mentioning: the first hour in the next twelve at 50% or more —
  // unless it is raining now, which the now line already says.
  const wet = next.find(x => x.rain !== null && x.rain >= 50);
  const today = fc.days.find(x => x.date === fc.at.slice(0, 10)) || fc.days[0] || null;
  let planned = null;
  if (plan && DATE.test(String(plan.date)) && plan.date >= fc.at.slice(0, 10)) {
    const day = fc.days.find(x => x.date === plan.date);
    if (day) {
      const hr = plan.time && /^\d{2}:\d{2}$/.test(plan.time) ? fc.hours.find(x => x.time === `${plan.date}T${plan.time.slice(0, 2)}:00`) : null;
      planned = { ...day, time: hr ? plan.time : null, hour: hr ? { t: hr.t, code: hr.code, rain: hr.rain } : null };
    }
  }
  return { at: fc.at, zone: fc.zone, now: fc.now, today, rainSoon: wet ? { time: wet.time.slice(11), rain: wet.rain } : null, plan: planned };
}

async function forecast(lat, lon, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!okPoint(lat, lon)) return null;
  const key = `${round(lat)},${round(lon)}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const q = new URLSearchParams({
    latitude: String(round(lat)), longitude: String(round(lon)),
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m',
    hourly: 'temperature_2m,precipitation_probability,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto', forecast_days: String(DAYS),
  });
  try {
    const r = await fetchImpl(`${ENDPOINT()}?${q}`, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`open-meteo ${r.status}`);
    const value = shape(await r.json());
    if (!value) throw new Error('open-meteo: unreadable');
    cache.set(key, { value, at: now });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return value;
  } catch (e) {
    console.error('weather:', e.message);
    return null;
  }
}

// The middle of a set of pins — the median, not the mean, so one holiday pin
// does not put the Places tab's weather in the sea (the same call as places.js).
function middle(points) {
  const pts = points.filter(p => p && okPoint(p.lat, p.lon));
  if (!pts.length) return null;
  const mid = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return { lat: mid(pts.map(p => p.lat)), lon: mid(pts.map(p => p.lon)) };
}

module.exports = { TTL_MS, DAYS, shape, summary, forecast, middle, okPoint };
