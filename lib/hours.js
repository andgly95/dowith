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
function stateAt(week, ph, { date, time = null, holidayOf = () => null } = {}) {
  if (!DATE.test(String(date || ''))) return null;
  const hol = holidayOf(date);
  const rangesOn = (d) => {
    const h = holidayOf(d);
    if (h && h.ph && ph) return ph;
    return week ? week[dayIx(d)] : null;
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
    for (let i = 1; i <= 7 && !opens; i++) {
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

module.exports = { parse, phOf, stateAt, DAYS };
