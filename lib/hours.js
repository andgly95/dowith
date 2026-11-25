// Opening hours, as OpenStreetMap writes them — "Mo-Fr 08:00-17:00; Sa 10:00-14:00".
//
// PURE, and deliberately small. The full opening_hours grammar has holidays,
// week numbers, sunrise and "by appointment"; a place page needs one answer —
// is it open today, and when — so this reads the common shapes into a week
// and gives up on anything else. Giving up returns null and the page shows
// the raw string, which is still true. A wrong "Open today" is not.
//
// The week is Monday first. WHICH day is today is the client's business: the
// server runs in UTC, and a Saturday is the viewer's Saturday.

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const RANGE = /^([01]\d|2[0-4]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)\+?$/;
const DAYLIST = /^(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*/;

// "Fr-Mo" wraps the weekend, the way people write it.
function expand(list) {
  const out = new Set();
  for (const part of list.split(',')) {
    const [a, b] = part.split('-');
    const i = DAYS.indexOf(a);
    const j = b ? DAYS.indexOf(b) : i;
    for (let k = i; ; k = (k + 1) % 7) { out.add(k); if (k === j) break; }
  }
  return [...out];
}

// Seven entries, Monday first: an array of [open, close] pairs, or an empty
// array for closed. Null for the whole week when the string is not one this
// reads.
function parse(raw) {
  const s = String(raw || '').trim().slice(0, 300);
  if (!s) return null;
  const week = DAYS.map(() => null);
  for (let rule of s.split(';').map(x => x.trim()).filter(Boolean)) {
    // Public holidays are a calendar this does not have. Skipped, not guessed.
    if (/^PH\b/.test(rule)) continue;
    rule = rule.replace(/,\s*PH\b|\bPH\s*,/g, '');
    const m = DAYLIST.exec(rule);
    const days = m ? expand(m[0]) : [0, 1, 2, 3, 4, 5, 6];
    const t = (m ? rule.slice(m[0].length) : rule).trim();
    let ranges;
    if (/^(off|closed)$/i.test(t)) ranges = [];
    else if (t === '24/7' || t === '') ranges = t ? [['00:00', '24:00']] : null;
    else {
      ranges = [];
      for (const r of t.split(',').map(x => x.trim())) {
        const x = RANGE.exec(r);
        if (!x) return null;
        ranges.push([`${x[1]}:${x[2]}`, `${x[3]}:${x[4]}`]);
      }
    }
    if (!ranges) return null;
    for (const d of days) week[d] = ranges;
  }
  // A day no rule mentions is closed — that is what the format means, and
  // "Mo-Fr 08:00-17:00" is a shop that is shut at the weekend.
  return week.some(d => d !== null) ? week.map(d => d || []) : null;
}

/* ── the fuller reading: seasons and the sun ────────────────────────────────
   `parse` gives up on two shapes that turned out to be on the live list: a
   park open "sunrise-sunset", and a holiday market open "Nov 12-Dec 23: …".
   Both have a right answer on any given day, so `rulesOf` reads them into
   rules (a season, the days, the times) and `rangesOn` answers for one date.
   Anything else still gives up — "(sunrise+01:00)", week numbers, "by
   appointment" — and a place that gives up shows its raw hours, as before. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SUN = ['sunrise', 'sunset', 'dawn', 'dusk'];
const TOKEN = '(?:[01]\\d|2[0-4]):[0-5]\\d|sunrise|sunset|dawn|dusk';
const SPAN = new RegExp(`^(${TOKEN})-(${TOKEN})\\+?$`);
const MON = `(${MONTHS.join('|')})`;
// A season at the start of a rule: "Nov 12-Dec 23", "Dec 20-31", "May-Sep",
// "Dec 24" — with a colon after it or not, the way people write it.
const SEASON = new RegExp(`^${MON}(?:\\s+(\\d{1,2}))?(?:\\s*-\\s*(?:${MON}(?:\\s+(\\d{1,2}))?|(\\d{1,2})))?\\s*:?\\s+`);
const md = (mon, day) => `${String(MONTHS.indexOf(mon) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
function seasonOf(m) {
  const a = m[1], ad = m[2] ? Number(m[2]) : null;
  const b = m[3] || (m[5] ? a : null), bd = m[4] ? Number(m[4]) : m[5] ? Number(m[5]) : null;
  if ((ad && (ad < 1 || ad > 31)) || (bd && (bd < 1 || bd > 31))) return null;
  if (!b) return { from: md(a, ad || 1), to: md(a, ad || 31) };
  return { from: md(a, ad || 1), to: md(b, bd || 31) };
}
const inSeason = (mmdd, r) => (r.from <= r.to ? mmdd >= r.from && mmdd <= r.to : mmdd >= r.from || mmdd <= r.to);

// [{ season, days, ranges }] in order, or null when the string is not one this
// reads. A LATER rule replaces an earlier one for the days it names, as the
// format says.
//
// One reading on purpose: a season at the start of the FIRST rule carries to
// later rules that name none. "Nov 12-Dec 23: Mo-Fr 12:00-20:00; Sa-Su 11:00-
// 20:00" is a holiday market, and the strict reading — open every weekend of
// the year — is a confident "open" on a January Saturday for a market that is
// not there. That is the one kind of wrong this file exists not to be.
function rulesOf(raw) {
  const s = String(raw || '').trim().slice(0, 300);
  if (!s) return null;
  const out = [];
  let first = null;
  for (let rule of s.split(';').map(x => x.trim()).filter(Boolean)) {
    if (/^PH\b/.test(rule)) continue;   // phOf reads it
    rule = rule.replace(/,\s*PH\b|\bPH\s*,/g, '');
    let season = null;
    const sm = SEASON.exec(rule);
    if (sm) {
      season = seasonOf(sm);
      if (!season) return null;
      rule = rule.slice(sm[0].length);
    }
    if (!out.length) first = season;
    else if (!season && first) season = first;
    const m = DAYLIST.exec(rule);
    const days = m ? expand(m[0]) : [0, 1, 2, 3, 4, 5, 6];
    const t = (m ? rule.slice(m[0].length) : rule).trim();
    let ranges;
    if (/^(off|closed)$/i.test(t)) ranges = [];
    else if (t === '24/7') ranges = [['00:00', '24:00']];
    else if (!t) return null;
    else {
      ranges = [];
      for (const r of t.split(',').map(x => x.trim())) {
        const x = SPAN.exec(r);
        if (!x) return null;
        ranges.push([x[1], x[2]]);
      }
    }
    out.push({ season, days, ranges });
  }
  return out.length ? out : null;
}

// The ranges for one calendar date, the sun worked out — or null when they
// cannot be (a sun time with no pin or no zone to work it out for).
function rangesOn(rules, date, sun = () => null) {
  const mmdd = date.slice(5);
  const dow = dayIx(date);
  let day = [];   // a day no rule covers is closed — outside a season too
  for (const r of rules) if ((!r.season || inSeason(mmdd, r.season)) && r.days.includes(dow)) day = r.ranges;
  if (!day.some(([a, b]) => SUN.includes(a) || SUN.includes(b))) return day;
  const t = sun(date);
  if (!t) return null;
  return day.map(([a, b]) => [SUN.includes(a) ? t[a] : a, SUN.includes(b) ? t[b] : b]);
}

// Sunrise, sunset, dawn and dusk (civil twilight) at a place on a date, as
// "HH:MM" in a time zone — the NOAA approximation, good to a couple of
// minutes, which is plenty for "is the park open". Null where the sun does not
// rise or set that day.
function sunTimes(date, lat, lon, zone) {
  const [y, m, d] = date.split('-').map(Number);
  const rad = Math.PI / 180;
  const N = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5);
  const lngHour = lon / 15;
  const at = (rising, zenith) => {
    const t = N + ((rising ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = (M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634) % 360;
    if (L < 0) L += 360;
    let RA = (Math.atan(0.91764 * Math.tan(L * rad)) / rad) % 360;
    if (RA < 0) RA += 360;
    RA = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15;
    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(zenith * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return null;
    const H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
    let UT = (H + RA - 0.06571 * t - 6.622 - lngHour) % 24;
    if (UT < 0) UT += 24;
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(Date.UTC(y, m - 1, d) + UT * 3600e3)).map(x => [x.type, x.value]));
    return `${p.hour}:${p.minute}`;
  };
  const out = { sunrise: at(true, 90.833), sunset: at(false, 90.833), dawn: at(true, 96), dusk: at(false, 96) };
  return Object.values(out).every(Boolean) ? out : null;
}
// A `sun` for rangesOn, for one place — or one that knows nothing.
const sunFor = (lat, lon, zone) => (Number.isFinite(lat) && Number.isFinite(lon) && zone
  ? (date) => { try { return sunTimes(date, lat, lon, zone); } catch (_) { return null; } }
  : () => null);

// The public-holiday rule, read on its own: [] for "PH off", the ranges for
// "PH 10:00-14:00", and null when the hours say nothing about holidays —
// which is not the same as "open as usual", and is not treated as such.
function phOf(raw) {
  for (const rule of String(raw || '').slice(0, 300).split(';').map(x => x.trim())) {
    const m = /^PH\s+(.+)$/.exec(rule);
    if (!m) continue;
    const t = m[1].trim();
    if (/^(off|closed)$/i.test(t)) return [];
    const ranges = [];
    for (const r of t.split(',').map(x => x.trim())) {
      const x = RANGE.exec(r);
      if (!x) return null;
      ranges.push([`${x[1]}:${x[2]}`, `${x[3]}:${x[4]}`]);
    }
    return ranges;
  }
  return null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const dayIx = (date) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;   // Monday first
const addDay = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Is it open, at a moment, ON A CALENDAR DATE the caller chose — the phone's
// today and its clock, or a plan's day and hour. The server never decides what
// day it is (see the top). A holiday's PH rule wins on a PH day; a big holiday
// with no rule says "may differ" and still reads the usual hours, because
// "closed" would be a guess.
//
// → { known, open, closedAllDay, ranges, until, opens: { date, time } | null,
//     holiday, holidayRule, mayDiffer }
// `week` is a Monday-first week (from parse), or a function from a date to
// that date's ranges (rangesOn, for seasons and the sun).
function stateAt(week, ph, { date, time = null, holidayOf = () => null, horizon = 7 } = {}) {
  if (!DATE.test(String(date || ''))) return null;
  const hol = holidayOf(date);
  const usual = typeof week === 'function' ? week : (d) => (week ? week[dayIx(d)] : null);
  const rangesOn = (d) => {
    const h = holidayOf(d);
    if (h && h.ph && ph) return ph;
    return usual(d);
  };
  const base = { holiday: hol ? hol.name : null, holidayRule: !!(hol && hol.ph && ph), mayDiffer: !!(hol && hol.major && !(hol.ph && ph)) };
  const today = rangesOn(date);
  if (!today) return { known: false, open: null, closedAllDay: null, ranges: null, until: null, opens: null, ...base };
  const t = time && TIME.test(time) ? time : null;
  // Last night's hours that run past midnight ("18:00-02:00") count this morning.
  const late = (rangesOn(addDay(date, -1)) || []).find(([a, b]) => b < a && t && t < b);
  const now = t ? today.find(([a, b]) => (b <= a ? t >= a : t >= a && t < b)) : null;
  const open = t ? !!(now || late) : null;
  let opens = null;
  if (t && !open) {
    const later = today.map(r => r[0]).filter(a => a > t).sort()[0];
    if (later) opens = { date, time: later };
  }
  if (!opens && (!t || !open)) {
    for (let i = 1; i <= horizon && !opens; i++) {
      const d = addDay(date, i);
      const r = rangesOn(d);
      if (r && r.length) opens = { date: d, time: r.map(x => x[0]).sort()[0] };
    }
    if (t === null && today.length) opens = null;   // a whole day asked about, and it opens that day
  }
  return {
    known: true,
    open,
    closedAllDay: today.length === 0 && !late,
    ranges: today,
    until: now ? now[1] : late ? late[1] : null,
    opens,
    ...base,
  };
}

// Everything at once, from the raw string: what the routes call.
function openAt(raw, { date, time = null, holidayOf, sun } = {}) {
  const rules = rulesOf(raw);
  const seasonal = !!(rules && rules.some(r => r.season));
  return stateAt(rules ? (d) => rangesOn(rules, d, sun) : null, phOf(raw),
    { date, time, holidayOf, horizon: seasonal ? 370 : 7 });
}

module.exports = { parse, phOf, stateAt, rulesOf, rangesOn, sunTimes, sunFor, openAt, DAYS };
