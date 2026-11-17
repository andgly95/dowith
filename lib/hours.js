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

module.exports = { parse, DAYS };
