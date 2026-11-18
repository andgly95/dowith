// Today's question: one a day, the same for both of you, and you answer it to
// see theirs. The two of you build a streak, and each of you picks which kinds
// of question come up.
//
// PURE, like spaces.js and pleasure.js: everything here takes the record and
// returns, and the routes do the saving. The rules that make it worth having
// are all in this file, each with a truth table in the suite:
//
// - THEIR ANSWER IS NOT SENT UNTIL YOU HAVE ANSWERED. Not blurred, not hidden in
//   the DOM: absent from the response (`dayView`). Once both have answered,
//   neither can change theirs — or the second could read the first and the first
//   rewrite theirs to match.
// - YOUR KINDS ARE YOURS. A kind is in play when both of you turned it on; the
//   wire carries your own list and the kinds in play, never theirs. "I wanted
//   romance questions and you didn't" is not a message this app delivers.
// - SPICY KEEPS TO THE ROSE. Its text, answers, reactions and replies travel
//   only on the rose's route (`roomView`); everywhere else a Spicy day is
//   `justUs: true` and two answered flags. Never in a push, never on
//   /api/state, never in the history.
// - NO PUSH CARRIES QUESTION TEXT, of any kind (`nudge`). A lock screen reads
//   itself out loud, and a Friends question looks like a Spicy one from across
//   a room.
//
// Keyed by the PAIR OF PEOPLE (pleasure.pairKey), never by list, and deleted
// when either leaves the pair: those answers were given to one person.
const crypto = require('crypto');

/* ── the catalogue ───────────────────────────────────────────────────────────
   Ids are stable once shipped: past days store the id, so an id is never reused
   for different words. Add freely; a new question joins its kind's rotation. */
const KINDS = ['friends', 'romance', 'spicy'];
const DEFAULT_DECKS = ['friends'];
// The evening nudge, on unless you turn it off. Never set means 8 PM; turned
// off is stored as null, so it stays off.
const DEFAULT_REMIND = '20:00';
const remindOf = (rec, uid) => (rec && rec.remind && Object.prototype.hasOwnProperty.call(rec.remind, uid) ? rec.remind[uid] : DEFAULT_REMIND);
const REACTS = ['❤️', '😂', '🥹', '🔥'];
const MAX_ANSWER = 1000;
const MAX_REPLY = 500;
const REPLIES_A_DAY = 20;

const open = (kind, id, text) => ({ id, kind, type: 'open', text });
const pick = (kind, id, a, b) => ({ id, kind, type: 'pick', text: `${a} or ${b.charAt(0).toLowerCase()}${b.slice(1)}?`, options: [a, b] });
const CATALOGUE = [
  open('friends', 'fr-week', 'What’s a small thing that made your week?'),
  open('friends', 'fr-month-food', 'What could you eat every day for a month?'),
  open('friends', 'fr-learn', 'What’s something you’ve always wanted to learn?'),
  open('friends', 'fr-concert', 'What’s the best concert you’ve ever been to?'),
  open('friends', 'fr-go-back', 'Where’s a place you’d go back to tomorrow?'),
  open('friends', 'fr-ten', 'What did you want to be when you were ten?'),
  open('friends', 'fr-never-skip', 'What’s a song you never skip?'),
  open('friends', 'fr-laughed', 'When did you last laugh so hard it hurt?'),
  open('friends', 'fr-hill', 'What’s a hill you’ll happily die on?'),
  open('friends', 'fr-good-at', 'What’s something you’re weirdly good at?'),
  open('friends', 'fr-repeat', 'What’s a film you could watch on repeat?'),
  open('friends', 'fr-weekend', 'What should we do this weekend?'),
  pick('friends', 'fr-beach-cabin', 'Beach town', 'Mountain cabin'),
  pick('friends', 'fr-breakfast', 'Breakfast for dinner', 'Dinner for breakfast'),
  pick('friends', 'fr-seat', 'Window seat', 'Aisle seat'),
  pick('friends', 'fr-plan', 'Plan every minute', 'Wing it'),

  open('romance', 'ro-first', 'When did you first think we might be something?'),
  open('romance', 'ro-small-thing', 'What’s a small thing I do that makes your day better?'),
  open('romance', 'ro-never-done', 'What’s something you’ve never done that you’d want to try with me?'),
  open('romance', 'ro-memory', 'What’s your favorite memory of us so far?'),
  open('romance', 'ro-looked-after', 'When do you feel most looked after by me?'),
  open('romance', 'ro-noticed', 'What did you notice about me early on that you still love?'),
  open('romance', 'ro-perfect-day', 'Where would you take me for a perfect day?'),
  open('romance', 'ro-tradition', 'What’s a tradition you’d like us to start?'),
  open('romance', 'ro-more-of', 'What’s something you’d like more of from me?'),
  open('romance', 'ro-song', 'What song makes you think of us?'),
  open('romance', 'ro-proud', 'When were you last proud of me?'),
  open('romance', 'ro-trip', 'Where should we go together this year?'),
  open('romance', 'ro-again', 'What’s something we should do again soon?'),
  pick('romance', 'ro-night', 'Night in', 'Night out'),
  pick('romance', 'ro-surprise', 'Plan the surprise', 'Be surprised'),

  open('spicy', 'sp-kiss', 'Where’s somewhere unexpected you’d like me to kiss you?'),
  open('spicy', 'sp-secretly', 'What’s something I do that you secretly love?'),
  open('spicy', 'sp-didnt-say', 'When did you last want me and not say so?'),
  open('spicy', 'sp-out-loud', 'What’s a fantasy you’d be willing to say out loud?'),
  open('spicy', 'sp-wear', 'What’s your favorite thing to see me wear?'),
  open('spicy', 'sp-never-asked', 'What’s something you’ve wanted to try but never asked about?'),
  open('spicy', 'sp-daring', 'Where’s the most daring place you’d want to be with me?'),
  open('spicy', 'sp-compliment', 'What’s a compliment you’d love to hear more often?'),
  open('spicy', 'sp-slowly', 'What should I do more slowly?'),
  open('spicy', 'sp-replay', 'What’s a memory of us you like to replay?'),
  pick('spicy', 'sp-morning', 'Morning', 'Night'),
  pick('spicy', 'sp-lights', 'Lights on', 'Lights off'),
];
const BY_ID = new Map(CATALOGUE.map(q => [q.id, q]));

/* ── days ────────────────────────────────────────────────────────────────────
   A day is a calendar date in the pair's zone, never an instant — the same
   reason as item.when. The server runs in UTC, and its own date is wrong half
   the evening in New York. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fmts = new Map();
function fmt(zone) {
  if (!fmts.has(zone)) {
    fmts.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  return fmts.get(zone);
}
function validZone(z) {
  if (typeof z !== 'string' || !z || z.length > 64) return false;
  try { fmt(z); return true; } catch (_) { return false; }
}
function parts(zone, ms) {
  const o = {};
  for (const p of fmt(validZone(zone) ? zone : 'UTC').formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
const dateIn = (zone, ms) => { const p = parts(zone, ms); return `${p.year}-${p.month}-${p.day}`; };
const timeIn = (zone, ms) => { const p = parts(zone, ms); return `${p.hour}:${p.minute}`; };
const dayNum = (d) => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5);
function addDays(d, n) {
  const t = new Date((dayNum(d) + n) * 864e5);
  return t.toISOString().slice(0, 10);
}

function blank(zone, today) {
  return { zone: validZone(zone) ? zone : 'UTC', decks: {}, remind: {}, paused: null, pauses: [], startedOn: today, days: {}, nudged: {} };
}

/* ── kinds ─────────────────────────────────────────────────────────────────
   Each person's own opt-ins. Nobody has chosen yet means Friends: on by
   default, and the other two wait to be asked for. */
const decksOf = (rec, uid) => (rec && rec.decks && Array.isArray(rec.decks[uid]) ? rec.decks[uid] : DEFAULT_DECKS);
const inPlay = (rec, a, b) => KINDS.filter(k => decksOf(rec, a).includes(k) && decksOf(rec, b).includes(k));

/* ── which question ─────────────────────────────────────────────────────────
   Rotate through the kinds in play, in catalogue order, by the day's index
   since the pair started — two kinds alternate, three take turns. Within a
   kind, the next not yet asked, in an order shuffled once per pair so two pairs
   don't march through the same sequence; used up, it starts again. */
function seeded(seed) {
  let h = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {   // mulberry32
    h = (h + 0x6D2B79F5) >>> 0;
    let x = h;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function orderFor(kind, pairKey) {
  const ids = CATALOGUE.filter(q => q.kind === kind).map(q => q.id);
  const r = seeded(`${pairKey}|${kind}`);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  return ids;
}
function pickFor({ inPlay: play, asked = [], pairKey, index }) {
  if (!play || !play.length) return null;
  const kind = play[((index % play.length) + play.length) % play.length];
  const order = orderFor(kind, pairKey);
  const seen = asked.filter(id => (BY_ID.get(id) || {}).kind === kind);
  const fresh = order.find(id => !seen.includes(id));
  return fresh || order[seen.length % order.length];
}

const pausedOn = (rec, date) => !!((rec.paused && date >= rec.paused.from)
  || (rec.pauses || []).some(p => date >= p.from && date <= p.to));

// Today's question, picked once and STORED the first time anybody asks for the
// day, so changing the kinds later changes tomorrow and never today. Null when
// paused or when there is nothing in play.
function ensureDay(rec, date, pairKey, a, b) {
  if (rec.days[date]) return rec.days[date];
  if (pausedOn(rec, date)) return null;
  const play = inPlay(rec, a, b);
  const asked = Object.keys(rec.days).sort().map(d => rec.days[d].qid).filter(Boolean);
  const qid = pickFor({ inPlay: play, asked, pairKey, index: dayNum(date) - dayNum(rec.startedOn || date) });
  if (!qid) return null;
  rec.days[date] = { qid, kind: BY_ID.get(qid).kind, answers: {}, reacts: {}, replies: [] };
  return rec.days[date];
}

/* ── the streak ─────────────────────────────────────────────────────────────
   A day counts when both answered ON that day, in the pair's zone: catching up
   later shows in the history and unlocks theirs, but does not mend a streak.
   Today not done yet never breaks it — the day has to end first. Paused days
   neither count nor break. Never stored: always worked out from the days. */
function counted(rec, date, a, b) {
  const d = rec.days[date];
  const x = d && d.answers && d.answers[a];
  const y = d && d.answers && d.answers[b];
  return !!(x && y && dateIn(rec.zone, x.at) === date && dateIn(rec.zone, y.at) === date);
}
function streak(rec, a, b, today) {
  const none = { current: 0, longest: 0, together: 0, since: null };
  if (!rec || !DATE.test(today)) return none;
  let run = 0, since = null, longest = 0;
  for (let d = rec.startedOn && rec.startedOn <= today ? rec.startedOn : today; d <= today; d = addDays(d, 1)) {
    if (counted(rec, d, a, b)) { if (!run) since = d; run++; longest = Math.max(longest, run); }
    else if (d === today || pausedOn(rec, d)) { /* not over yet / paused: neither */ }
    else { run = 0; since = null; }
  }
  const together = Object.values(rec.days).filter(d => d.answers && d.answers[a] && d.answers[b]).length;
  return { current: run, longest, together, since };
}

/* ── what each of you sees ──────────────────────────────────────────────── */

const ansWire = (x) => ({ ...(typeof x.text === 'string' ? { text: x.text } : {}), ...(Number.isInteger(x.pick) ? { pick: x.pick } : {}), at: x.at });

// One day, from `uid`'s side. THEIR ANSWER ONLY ONCE YOU HAVE ANSWERED: before
// that the view carries `{ answered: true|false }` and nothing else of theirs.
// A Spicy day off the rose's route (`room` false) is `justUs` and two flags.
function dayView(rec, date, uid, other, { room = false } = {}) {
  const d = rec && rec.days[date];
  const q = d && BY_ID.get(d.qid);
  if (!q) return null;
  const mine = d.answers[uid] || null;
  const theirs = d.answers[other] || null;
  const both = !!(mine && theirs);
  if (q.kind === 'spicy' && !room) {
    return { date, justUs: true, mine: mine ? { answered: true } : null, theirs: { answered: !!theirs }, final: both };
  }
  return {
    date,
    kind: q.kind,
    type: q.type,
    text: q.text,
    options: q.options || null,
    justUs: q.kind === 'spicy',
    mine: mine ? ansWire(mine) : null,
    theirs: theirs ? (mine ? { answered: true, ...ansWire(theirs) } : { answered: true }) : { answered: false },
    reacts: both ? { mine: d.reacts[uid] || null, theirs: d.reacts[other] || null } : null,
    replies: both ? (d.replies || []).map(r => ({ mine: r.by === uid, text: r.text, at: r.at })) : null,
    matched: both && q.type === 'pick' && mine.pick === theirs.pick ? q.options[mine.pick] : null,
    final: both,
  };
}

// The list's view: today (unless paused), the streak, and YOUR settings. Their
// kinds are never in it; only the intersection is.
function listView(rec, uid, other, today) {
  return {
    today: rec.paused ? null : dayView(rec, today, uid, other),
    paused: rec.paused ? { mine: rec.paused.by === uid } : null,
    streak: streak(rec, uid, other, today),
    decks: [...decksOf(rec, uid)],
    inPlay: inPlay(rec, uid, other),
    remind: remindOf(rec, uid),
    zone: rec.zone,
  };
}

// For the shelf and the card's first paint: a number and a flag, no text, no kind.
function summary(rec, uid, other, today) {
  if (!rec) return null;
  const d = rec.days[today];
  return { streak: streak(rec, uid, other, today).current, waiting: !rec.paused && !!d && !d.answers[uid] };
}

// Every question so far — NEVER a Spicy day, which keeps to the rose. Days at
// least one of you answered, newest first, a page at a time.
function history(rec, uid, other, { before = null, limit = 31 } = {}) {
  const dates = Object.keys(rec.days)
    .filter(d => (!before || d < before) && rec.days[d].kind !== 'spicy' && BY_ID.has(rec.days[d].qid)
      && Object.keys(rec.days[d].answers || {}).length)
    .sort().reverse();
  const page = dates.slice(0, limit);
  return { days: page.map(d => dayView(rec, d, uid, other)), next: dates.length > limit ? page[page.length - 1] : null };
}

// The rose's half: today if today is Spicy, and the Spicy days so far. Null
// when Spicy was never in play — the front door shows no fourth door.
function roomView(rec, uid, other, today) {
  if (!rec) return null;
  const on = inPlay(rec, uid, other).includes('spicy');
  const spicyDays = Object.keys(rec.days).filter(d => rec.days[d].kind === 'spicy').sort().reverse();
  if (!on && !spicyDays.length) return null;
  const d = rec.days[today];
  return {
    on,
    today: !rec.paused && d && d.kind === 'spicy' ? dayView(rec, today, uid, other, { room: true }) : null,
    history: spicyDays.filter(x => x !== today && Object.keys(rec.days[x].answers || {}).length)
      .map(x => dayView(rec, x, uid, other, { room: true })),
    streak: streak(rec, uid, other, today).current,
  };
}

/* ── writing ─────────────────────────────────────────────────────────────────
   Each returns { ok } or { error: status }, and changes nothing on an error. */

function cleanAnswer(raw, q) {
  const b = raw && typeof raw === 'object' ? raw : {};
  if (q.type === 'pick') return b.pick === 0 || b.pick === 1 ? { pick: b.pick } : null;
  const text = typeof b.text === 'string' ? b.text.replace(/\r\n?/g, '\n').trim().slice(0, MAX_ANSWER) : '';
  return text ? { text } : null;
}

// Yours can change until both of you have answered; after that it is final
// (409). The FIRST time you answered is kept: the streak counts the day you
// answered on, not the day you fixed a typo.
function answer(rec, date, uid, other, raw, now) {
  const d = DATE.test(String(date)) && rec.days[date];
  const q = d && BY_ID.get(d.qid);
  if (!q) return { error: 404 };
  if (d.answers[uid] && d.answers[other]) return { error: 409 };
  const a = cleanAnswer(raw, q);
  if (!a) return { error: 400 };
  const was = d.answers[uid];
  d.answers[uid] = { ...a, at: was ? was.at : now, ...(was ? { editedAt: now } : {}) };
  return { ok: true, first: !was, completed: !!d.answers[other], kind: q.kind };
}

function bothIn(rec, date, uid, other) {
  const d = DATE.test(String(date)) && rec.days[date];
  if (!d || !BY_ID.has(d.qid)) return { error: 404 };
  if (!(d.answers[uid] && d.answers[other])) return { error: 409 };
  return { d };
}

// One reaction on THEIR answer, tap again (null) to take it back.
function react(rec, date, uid, other, emoji) {
  const r = bothIn(rec, date, uid, other);
  if (r.error) return r;
  if (emoji === null) { delete r.d.reacts[uid]; return { ok: true }; }
  if (!REACTS.includes(emoji)) return { error: 400 };
  r.d.reacts[uid] = emoji;
  return { ok: true };
}

function reply(rec, date, uid, other, text, now) {
  const r = bothIn(rec, date, uid, other);
  if (r.error) return r;
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, MAX_REPLY) : '';
  if (!t) return { error: 400 };
  if ((r.d.replies || []).length >= REPLIES_A_DAY) return { error: 429 };
  (r.d.replies = r.d.replies || []).push({ by: uid, text: t, at: now });
  return { ok: true };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// Your own kinds and reminder only; the zone and the pause are the pair's.
// Validated whole before anything is applied.
function settings(rec, uid, raw, today, now) {
  const b = raw && typeof raw === 'object' ? raw : {};
  if (b.decks !== undefined && (!Array.isArray(b.decks) || b.decks.some(k => !KINDS.includes(k)))) return { error: 400 };
  if (b.remind !== undefined && b.remind !== null && !HHMM.test(String(b.remind))) return { error: 400 };
  if (b.zone !== undefined && !validZone(b.zone)) return { error: 400 };
  if (b.paused !== undefined && typeof b.paused !== 'boolean') return { error: 400 };
  if (b.decks !== undefined) rec.decks[uid] = KINDS.filter(k => b.decks.includes(k));
  if (b.remind !== undefined) (rec.remind = rec.remind || {})[uid] = b.remind || null;
  if (b.zone !== undefined) rec.zone = b.zone;
  if (b.paused === true && !rec.paused) rec.paused = { by: uid, at: now, from: today };
  if (b.paused === false && rec.paused) {
    // Resumed today: the pause covered up to yesterday, and today is a day like any other.
    const to = addDays(today, -1);
    if (to >= rec.paused.from) (rec.pauses = rec.pauses || []).push({ from: rec.paused.from, to });
    rec.paused = null;
  }
  return { ok: true };
}

/* ── nudges ──────────────────────────────────────────────────────────────────
   NO QUESTION TEXT, on any day, of any kind — only the partner's name and a
   number. The one place pushes are worded, so the suite can check every one. */
function nudge(kind, { name = 'Someone', streak: n = 0 } = {}) {
  if (kind === 'answered-first') return { title: `${name} answered today’s question`, body: 'Answer to see theirs' };
  if (kind === 'answered-after') return { title: `${name} answered`, body: 'See what they said' };
  if (kind === 'remind') return { title: 'Today’s question is waiting', body: n ? `Keep your ${n}-day streak going` : '' };
  return null;
}

// At most one of each per person per day.
function once(rec, uid, what, date) {
  const n = rec.nudged || (rec.nudged = {});
  const m = n[uid] || (n[uid] = {});
  if (m[what] === date) return false;
  m[what] = date;
  return true;
}

// The reminders due at `now`: for each pair, each of you whose time (8 PM unless
// you changed it or turned it off) has come in the pair's zone, who hasn't
// answered today, unpaused. Picks
// today's question if nobody has opened the app yet, or there is nothing to
// remind about. Returns [{ uid, spaceId, payload }] and marks them sent.
function remindersDue(state, pairKeyOf, now) {
  const out = [];
  const seen = new Set();
  for (const s of state.spaces || []) {
    const ids = Array.isArray(s.memberIds) ? s.memberIds : [];
    if (ids.length !== 2) continue;   // a pair, as spaces.isPair has it
    const key = pairKeyOf(ids[0], ids[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = state.questions && state.questions[key];
    if (!rec || rec.paused) continue;
    const today = dateIn(rec.zone, now);
    const at = timeIn(rec.zone, now);
    for (const [uid, other] of [[ids[0], ids[1]], [ids[1], ids[0]]]) {
      const when = remindOf(rec, uid);
      if (!when || at < when || (rec.nudged && rec.nudged[uid] && rec.nudged[uid].remind === today)) continue;
      const d = ensureDay(rec, today, key, uid, other);
      if (!d || d.answers[uid]) continue;
      once(rec, uid, 'remind', today);
      const payload = nudge('remind', { streak: streak(rec, uid, other, today).current });
      out.push({ uid, spaceId: s.id, payload: { ...payload, tag: `dq-${s.id}`, url: `/?list=${encodeURIComponent(s.id)}`, spaceId: s.id } });
    }
  }
  return out;
}

const catalogue = () => CATALOGUE.map(q => ({ ...q }));

module.exports = {
  KINDS, DEFAULT_DECKS, DEFAULT_REMIND, REACTS, MAX_ANSWER, MAX_REPLY, REPLIES_A_DAY,
  catalogue, validZone, dateIn, timeIn, addDays, blank, decksOf, remindOf, inPlay, orderFor, pickFor, pausedOn, ensureDay,
  counted, streak, dayView, listView, summary, history, roomView, cleanAnswer, answer, react, reply, settings,
  nudge, once, remindersDue,
};
