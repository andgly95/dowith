// Public holidays, for "is it open?" — PURE, worked out, never fetched.
//
// Two uses, and they are different:
//   * `ph`: the days OpenStreetMap's `PH` means. A place whose hours say
//     "PH off" or "PH 10:00-14:00" is told the truth on exactly these days.
//     In the US that is the federal list.
//   * `major`: the days most places close or change their hours whether or not
//     anybody wrote it down — Thanksgiving, Christmas. A place with no PH rule
//     gets "hours may differ" on these, never a confident "closed": a guess
//     that looks like a fact is the thing this app keeps refusing to show.
//
// The US only for now (`holidayRegion` in config, default US); another region
// is another table here, and with none the answer is simply "no holiday".

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
// The nth weekday (0 Sunday … 6 Saturday) of a month; n = -1 is the last.
function nth(y, m, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return iso(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return iso(y, m, lastDay - ((last - weekday + 7) % 7));
}
// Easter Sunday (the anonymous Gregorian algorithm).
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}

const US = (y) => [
  { date: iso(y, 1, 1), name: 'New Year’s Day', ph: true, major: true },
  { date: nth(y, 1, 1, 3), name: 'Martin Luther King Jr. Day', ph: true, major: false },
  { date: nth(y, 2, 1, 3), name: 'Presidents’ Day', ph: true, major: false },
  { date: easter(y), name: 'Easter', ph: false, major: true },
  { date: nth(y, 5, 1, -1), name: 'Memorial Day', ph: true, major: false },
  { date: iso(y, 6, 19), name: 'Juneteenth', ph: true, major: false },
  { date: iso(y, 7, 4), name: 'Independence Day', ph: true, major: true },
  { date: nth(y, 9, 1, 1), name: 'Labor Day', ph: true, major: false },
  { date: nth(y, 10, 1, 2), name: 'Indigenous Peoples’ Day', ph: true, major: false },
  { date: iso(y, 11, 11), name: 'Veterans Day', ph: true, major: false },
  { date: nth(y, 11, 4, 4), name: 'Thanksgiving', ph: true, major: true },
  { date: iso(y, 12, 25), name: 'Christmas Day', ph: true, major: true },
];
const REGIONS = { US };

const memo = new Map();
// { name, ph, major } for a calendar date, or null.
function holidayOn(date, region = 'US') {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(String(date || ''));
  const table = REGIONS[String(region || '').toUpperCase()];
  if (!m || !table) return null;
  const k = `${region}:${m[1]}`;
  if (!memo.has(k)) memo.set(k, new Map(table(Number(m[1])).map(h => [h.date, h])));
  const h = memo.get(k).get(date);
  return h ? { name: h.name, ph: h.ph, major: h.major } : null;
}

module.exports = { holidayOn, easter, nth };
