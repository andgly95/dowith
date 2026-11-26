// Suggestions: of everything on a list, what would be good for THEN — the
// energy you said you have, the time and day you set, the weather at that hour,
// whether a place is open, how long it takes each of you to get there, what is
// already planned, and what your thumbs have said before.
//
// PURE. The routes gather the facts (weather, hours, journeys, kitchens) and
// this weighs them, in one tested place, the way kitchen.match decides what is
// in the cupboard. Every number here is a judgement call written down once, so
// it can be argued with: they are in WEIGHTS, and each one that moves a thing
// says why in words the screen shows.
//
// Two honest limits. It ranks what it is given, so it can only be as right as
// the profiles (lib/itemfit.js, lib/placefit.js) — which is why a thing whose
// profile is still a guess from its kind says `rough`. And it never hides a
// thing silently: what is ruled out for then (closed, rained off) comes back
// in its own list with the reason.
//
// A reason against a thing is not only a number. Weighing alone once put a
// garden in a wet afternoon and a dinner recipe at lunch, because nothing else
// on a short list scored higher. So two flags ride with the score: `hidden`
// (ruled out for then: closed, rained off) and `wrong` (not ruled out, but it
// has a reason against it, the kind the screen shows in coral: the wrong part
// of the day, more than you have in you, a trek, built around what the list
// does not eat). A plan never puts either in a slot by itself — a slot with
// nothing clean says so and offers ideas — though a person still can; and in
// the list, what has something against it comes after everything that has not.

const placefit = require('./placefit');
const itemfit = require('./itemfit');
const kinds = require('./kinds');
const diet = require('./diet');

const W = {
  fits: 10, push: -14, under: -3,           // energy: exactly right · each level too much · each level to spare
  time: 6, wrongTime: -10, lateLong: -6,    // part of the day
  wxGood: 10, wxPoor: -18, niceOut: 8, wetOut: -14, cosy: 9, indoorsWet: 4,
  open: 4, closed: -45, closing: -6,
  near: 8, close: 4, far: -6, trek: -14, apart: -3, tiredTravel: 1.6,
  home: 5,
  planned: 30, plannedElse: -4,           // on the calendar for then · for another hour or day
  keepGoing: 7, caughtUp: -10,
  haveAll: 6, nearlyAll: 2,
  up: 9, down: -22, pref: 5,
  fresh: 2, sameKind: 5,
  otherDinner: 8,                          // a plan over two days: one dinner out, one cooked
  // What the list eats (lib/diet.js), by what is known: OpenStreetMap says no ·
  // built around it · a recipe with lines to swap · a few options · options ·
  // nothing but. `strict` (celiac, an allergy) makes the cautions weigh more.
  diet: { no: -40, hard: -18, swap: -5, limited: 2, yes: 6, only: 10 }, dietStrict: 1.5,
};
const HALF_LIFE_MS = 21 * 24 * 60 * 60 * 1000;   // a thumb fades: "not tonight" is not "never"
const THEN_MIN = 90;                             // a plan this near the hour asked about is "for then"
const HOLD_MIN = 180;                            // how far a calendar plan may sit from the part of the day it takes
const STEP = 0.2;                                // how far one thumb moves a preference
const MAX_IDEAS = 40;

const bucketOf = (time) => {
  const h = Number(String(time || '12:00').slice(0, 2));
  return h >= 5 && h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night';
};
const band = (e) => (e <= 2 ? 'low' : e === 3 ? 'mid' : 'high');
const hm = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  const h12 = h % 12 || 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h >= 12 && h < 24 ? 'PM' : 'AM'}`;
};
const listOf = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
const minsOf = (t) => { const [h, m] = String(t || '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
// Minutes between two times of one day, either way round. Infinity when one is not a time.
const gap = (a, b) => { const x = minsOf(a), y = minsOf(b); return x === null || y === null ? Infinity : Math.abs(x - y); };

// Weather, read coarsely: is it a day to be out in, or one to stay in for.
const rough = (w) => !!w && ((Number.isFinite(w.rain) && w.rain >= 50)
  || ['rain', 'drizzle', 'snow', 'thunderstorm'].includes(placefit.conditionOf(w.code)));
// Wet for certain: the hour's own code says so, or the chance is 70% or more.
// Between that and `rough` (50%) is a coin toss: said, but not ruled out.
const wet = (w) => !!w && ((Number.isFinite(w.rain) && w.rain >= placefit.WET_PCT)
  || ['rain', 'drizzle', 'snow', 'thunderstorm'].includes(placefit.conditionOf(w.code)));
const nice = (w) => !!w && !rough(w) && ['clear', 'partly_cloudy'].includes(placefit.conditionOf(w.code))
  && Number.isFinite(w.t) && w.t >= 12 && w.t <= 30;

/* ── taste: what thumbs teach ───────────────────────────────────────────────
   One record per person per list: their thumb on each thing (kept with its
   date, because it fades), the ideas they liked or passed on, and a small set
   of learned leanings — toward a kind, toward staying in, toward films late at
   night. A thumb moves every leaning the thing has by a step; they are bounded,
   so no number of thumbs makes a kind impossible. */

const blankTaste = () => ({ votes: {}, ideas: [], w: {} });

// What a thing IS, for learning from: its kind, in or out, how much it asks,
// whether it is long, and its kind at this part of the day.
function featuresOf(it, fit, bucket) {
  const kind = kinds.clean(it.kind);
  const out = [`kind:${kind}`, `energy:${band(fit.energy)}`];
  if (fit.where !== 'either') out.push(`where:${fit.where}`);
  if (Number.isFinite(fit.minutes) && fit.minutes > 150) out.push('long');
  if (bucket) out.push(`${bucket}:${kind}`);
  return out;
}

function learn(taste, features, delta) {
  if (!delta) return;
  for (const f of features) {
    const next = Math.max(-1, Math.min(1, (taste.w[f] || 0) + STEP * delta));
    if (Math.abs(next) < 1e-9) delete taste.w[f]; else taste.w[f] = Math.round(next * 100) / 100;
  }
}

// A thumb on a thing. v is 1, -1, or 0 to take it back; changing your mind
// moves the leanings by the difference, so up-then-down is not two lessons.
function vote(taste, itemId, v, features, now = Date.now()) {
  const was = (taste.votes[itemId] || {}).v || 0;
  const to = v > 0 ? 1 : v < 0 ? -1 : 0;
  if (to) taste.votes[itemId] = { v: to, at: now }; else delete taste.votes[itemId];
  learn(taste, features, to - was);
  return taste;
}

// A thumb on an idea that is not on the list. Kept by its words, newest last.
function voteIdea(taste, idea, v, features, now = Date.now()) {
  const title = String(idea.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) return taste;
  const k = title.toLowerCase();
  const old = taste.ideas.find(x => x.title.toLowerCase() === k);
  const was = old ? old.v : 0;
  const to = v > 0 ? 1 : v < 0 ? -1 : 0;
  taste.ideas = taste.ideas.filter(x => x.title.toLowerCase() !== k);
  if (to) taste.ideas.push({ title, kind: kinds.clean(idea.kind), v: to, at: now });
  taste.ideas = taste.ideas.slice(-MAX_IDEAS);
  learn(taste, features, to - was);
  return taste;
}

const faded = (rec, now) => (rec ? rec.v * 0.5 ** (Math.max(0, now - rec.at) / HALF_LIFE_MS) : 0);

/* ── one thing, weighed ─────────────────────────────────────────────────── */

// ctx: { energy, date, time, viewer, now, general, weatherOf(it), openOf(it),
//        transitOf(it), readyOf(it), tastes: [taste…], diet, eatsOf(it) }
function score(it, ctx) {
  const fit = itemfit.fitOf(it);
  const kind = kinds.clean(it.kind);
  const bucket = bucketOf(ctx.time);
  const reasons = [];
  let pts = 0;
  let hidden = false;   // ruled out for then
  let wrong = false;    // not ruled out, but nothing to put in a plan unasked
  // `keep` is for a reason that must be on screen however little it weighs. A
  // reason AGAINST a thing always is: it is why the thing is where it is.
  const say = (tone, text, n, keep = false) => {
    pts += n;
    if (!text) return;
    if (tone === 'bad') wrong = true;
    reasons.push({ tone, text, n, keep: keep || tone === 'bad' });
  };

  // Energy.
  const d = fit.energy - ctx.energy;
  if (d === 0) say('good', ctx.energy <= 2 ? 'Low effort' : 'Fits your energy', W.fits);
  else if (d > 0) say(d >= 2 ? 'bad' : 'note', d >= 2 ? 'Takes more than you’ve got' : 'A bit of a push', W.push * d);
  else say('good', ctx.energy <= 2 ? 'Low effort' : null, W.under * -d);
  if (fit.where === 'home' && ctx.energy <= 2) say('good', 'No going anywhere', W.home);

  // The part of the day.
  if (fit.times) {
    if (fit.times.includes(bucket)) say('good', null, W.time);
    else say('bad', `More of ${/^[aeiou]/.test(fit.times[0]) ? 'an' : 'a'} ${listOf(fit.times)} thing`, W.wrongTime);
  }
  if (bucket === 'night' && Number.isFinite(fit.minutes) && fit.minutes > 150) say('note', 'Long for this late', W.lateLong);

  // The weather, at its own pin when it has one.
  const here = ctx.weatherOf ? ctx.weatherOf(it) : null;
  const w = here || ctx.general || null;
  const wf = it.weatherFit && !placefit.stale(it) ? it.weatherFit : null;
  if (w && wf && wf.matters) {
    const j = placefit.judge(wf, w);
    if (j && j.verdict === 'good') say('good', 'Good weather for it', W.wxGood);
    else if (j && j.verdict === 'poor') {
      // Its own profile says this weather spoils it, so it is rained off —
      // whatever part of it is under a roof. Only places wholly outdoors were
      // ruled out at first, and a garden with a glasshouse stayed in the plan.
      say('bad', `Weather’s against it · ${j.why.map(x => x.replace(/_/g, ' ')).join(', ')}`, W.wxPoor);
      hidden = true;
    } else if (j) say('note', `Not quite the weather · ${j.why.map(x => x.replace(/_/g, ' ')).join(', ')}`, 0);
  } else if (w && wf && !wf.matters) {
    if (rough(w)) say('good', 'Indoors, so the weather won’t matter', W.indoorsWet);
  } else if (w) {
    if (fit.weather === 'needs_good') {
      if (nice(w)) say('good', 'Nice out for it', W.niceOut);
      else if (wet(w)) { say('bad', 'Wet then', W.wetOut); hidden = true; }
      else if (rough(w)) say('bad', `${w.rain}% chance of rain`, W.wetOut);
    } else if (fit.weather === 'better_when_bad' && rough(w)) say('good', 'Good for a wet one', W.cosy);
  }

  // Open or closed, then.
  const st = ctx.openOf ? ctx.openOf(it) : null;
  if (st && st.known) {
    if (st.open === false || (st.open === null && st.closedAllDay)) {
      say('bad', st.closedAllDay ? `Closed that day${st.holiday ? ` · ${st.holiday}` : ''}` : `Closed then${st.opens && st.opens.date === ctx.date ? ` · opens ${hm(st.opens.time)}` : ''}`, W.closed);
      hidden = true;
    } else if (st.open) {
      const left = st.until && st.until !== '24:00' ? minsBetween(ctx.time, st.until) : null;
      if (left !== null && left > 0 && left <= 60) say('note', `Closes ${hm(st.until)}`, W.closing);
      else say('good', null, W.open);
    }
  }
  if (st && st.mayDiffer) say('note', `${st.holiday} · hours may differ`, 0);

  // What the list eats. A caution, or a source's own word — never a promise
  // that something is safe — and always shown: a note that a recipe has flour
  // in it must not lose its place to "Close by".
  if (ctx.diet) {
    const facts = (ctx.eatsOf ? ctx.eatsOf(it) : null) || {};
    const j = diet.judge(ctx.diet, { kind, built: fit.built || null, lines: facts.lines || null, osm: facts.osm || null });
    if (j) {
      const n = W.diet[j.level];
      say(j.level === 'no' || j.level === 'hard' ? 'bad' : n > 5 ? 'good' : 'note', j.text,
        Math.round(n < 0 && ctx.diet.strict ? n * W.dietStrict : n), true);
    }
  }

  // Getting there, for whoever has furthest to come.
  const legs = (ctx.transitOf ? ctx.transitOf(it) : null) || [];
  const known = legs.filter(l => Number.isFinite(l.minutes));
  if (known.length) {
    const worst = known.reduce((a, b) => (b.minutes > a.minutes ? b : a));
    const best = known.reduce((a, b) => (b.minutes < a.minutes ? b : a));
    const tired = ctx.energy <= 2 ? W.tiredTravel : 1;
    const who = worst.mine ? 'you' : worst.name;
    if (worst.minutes <= 15) say('good', 'Close by', W.near);
    else if (worst.minutes <= 30) say('good', null, W.close);
    else if (worst.minutes <= 45) say('note', null, 0);
    else if (worst.minutes <= 60) say('note', `${worst.minutes} min for ${who}`, Math.round(W.far * tired));
    else say('bad', `A trek · ${worst.minutes} min for ${who}`, Math.round(W.trek * tired));
    if (known.length > 1 && worst.minutes - best.minutes >= 30) say('note', null, W.apart);
  }

  // Already on a day — and, when the plan has an hour, on that hour. A dinner
  // planned for 6:30 is not planned for lunch: any hour of its day used to
  // count as "then", and a plan put it in the first slot it reached.
  if (it.when && it.when.date) {
    const t = minsOf(it.when.time) === null ? null : it.when.time;
    if (it.when.date === ctx.date) {
      if (!t) say('good', 'Planned for that day', W.planned);
      else if (gap(t, ctx.time) <= THEN_MIN) say('good', `Planned for then · ${hm(t)}`, W.planned);
      else say('note', `Planned for ${hm(t)}`, W.plannedElse, true);
    } else if (it.when.date > ctx.date) say('note', null, W.plannedElse);
  }

  // A show you are in the middle of; a recipe you have everything for.
  const pr = it.progress;
  if (pr && pr.total) {
    if (pr.caughtUp) say('note', 'Caught up', W.caughtUp);
    else if (pr.seen && pr.next) say('good', `Keep going · S${pr.next.s} E${pr.next.e}`, W.keepGoing);
  }
  const ready = ctx.readyOf ? ctx.readyOf(it) : null;
  if (Array.isArray(ready) && ready.length) {
    const missing = ready.filter(x => !x).length;
    if (!missing) say('good', 'You have everything for it', W.haveAll);
    else if (missing <= 2) say('note', `Missing ${missing === 1 ? 'one thing' : 'two things'}`, W.nearlyAll);
  }

  // What thumbs have said: on this thing (fading), and on things like it.
  const feats = featuresOf(it, fit, bucket);
  const tastes = ctx.tastes || [];
  let voted = 0;
  for (const t of tastes) {
    const f = faded(t.votes[it.id], ctx.now);
    voted += f > 0 ? f * W.up : f * -W.down;
  }
  if (voted) say(voted > 0 ? 'good' : 'note', null, Math.round(voted));
  if (tastes.length) {
    const lean = feats.reduce((sum, f) => sum + tastes.reduce((a, t) => a + (t.w[f] || 0), 0) / tastes.length, 0);
    if (lean) say('note', null, Math.round(lean * W.pref));
  }
  if (ctx.now - (it.createdAt || 0) < 5 * 864e5) say('note', null, W.fresh);

  return {
    id: it.id, kind, score: Math.round(pts), hidden, wrong,
    reasons: reasons.filter(r => r.text).sort((a, b) => (b.keep - a.keep) || Math.abs(b.n) - Math.abs(a.n)).slice(0, 3).map(({ tone, text }) => ({ tone, text })),
    fit: { role: fit.role, energy: fit.energy, minutes: fit.minutes, where: fit.where, rough: !!fit.rough },
    features: feats,
  };
}

function minsBetween(a, b) {
  const [h1, m1] = String(a || '').split(':').map(Number);
  const [h2, m2] = String(b || '').split(':').map(Number);
  if (![h1, m1, h2, m2].every(Number.isFinite)) return null;
  const d = (h2 * 60 + m2) - (h1 * 60 + m1);
  return d < 0 ? d + 1440 : d;
}

/* ── the list, in order ─────────────────────────────────────────────────── */

// Best first — but not eight films in a row: each thing already chosen of a
// kind costs the next of that kind a little, for the top of the list.
// What has a reason against it for then (`wrong`) comes after everything that
// has not, however the numbers fall.
function rank(items, ctx) {
  const all = items.filter(it => !it.done).map(it => score(it, ctx));
  const shown = all.filter(x => !x.hidden).sort((a, b) => b.score - a.score);
  const picked = [];
  const pool = shown.filter(x => !x.wrong);
  const seen = {};
  while (pool.length && picked.length < 12) {
    let bi = 0, bv = -Infinity;
    pool.forEach((x, i) => { const v = x.score - W.sameKind * (seen[x.kind] || 0); if (v > bv) { bv = v; bi = i; } });
    const [x] = pool.splice(bi, 1);
    seen[x.kind] = (seen[x.kind] || 0) + 1;
    picked.push(x);
  }
  return {
    good: picked.concat(pool, shown.filter(x => x.wrong)),
    notThen: all.filter(x => x.hidden).sort((a, b) => b.score - a.score),
  };
}

/* ── a plan: one thing after another ────────────────────────────────────────
   "Dinner, then something to watch — and tomorrow something to do, and cook
   together." A plan is a run of SLOTS, each a part of the day with a role
   (eat, watch, do), and each filled with the best thing on the list for THAT
   slot's hour: its weather, whether it is open then, how long it takes to get
   there then. Every slot carries its runners-up, so any one piece can be
   swapped for another without the rest moving.

   The slots are a template, not a schedule: they say "dinner is around seven",
   which is true of most evenings, and the screen says "around". Nothing here
   knows how long dinner takes. */

const addDay = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const later = (a, b) => (a > b ? a : b);
function plus(time, mins) {
  const [h, m] = time.split(':').map(Number);
  const t = Math.min(23 * 60 + 45, h * 60 + m + mins);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// The parts of the day still ahead from a start, and — with `through` — the
// next day's: a late morning, an afternoon, and dinner.
function slotsFor(start, { through = false } = {}) {
  const t = /^\d{2}:\d{2}$/.test(String(start.time)) ? start.time : '12:00';
  const d0 = start.date;
  const out = [];
  const add = (role, label, date, time, extra = {}) => out.push({ key: `s${out.length}`, role, label, date, time, day: date === d0 ? 0 : 1, ...extra });
  if (t < '11:00') {
    add('do', 'Morning', d0, later(t, '10:00'));
    add('eat', 'Lunch', d0, '12:30');
    add('do', 'Afternoon', d0, '14:30');
    add('eat', 'Dinner', d0, '19:00');
    add('watch', 'Evening', d0, '21:00');
  } else if (t < '14:00') {
    const lunch = later(t, '12:30');
    add('eat', 'Lunch', d0, lunch);
    add('do', 'Afternoon', d0, later(plus(lunch, 90), '14:30'));
    add('eat', 'Dinner', d0, '19:00');
    add('watch', 'Evening', d0, '21:00');
  } else if (t < '17:00') {
    add('do', 'Afternoon', d0, t);
    add('eat', 'Dinner', d0, '19:00');
    add('watch', 'Evening', d0, '21:00');
  } else if (t < '20:30') {
    const dinner = later(t, '19:00');
    add('eat', 'Dinner', d0, dinner);
    add('watch', 'Evening', d0, later(plus(dinner, 105), '21:00'));
  } else {
    add('watch', 'Evening', d0, t);
  }
  if (through) {
    const d1 = addDay(d0, 1);
    add('do', 'Morning', d1, '11:00');
    add('do', 'Afternoon', d1, '14:30');
    // One dinner out and one cooked, across the two days: `other` is decided
    // once the first day's dinner is known.
    add('eat', 'Dinner', d1, '18:30', { other: true });
  }
  return out;
}

const fills = (role, fit) => (role === 'do' ? fit.role === 'do' || fit.role === 'drink' : fit.role === role);

// Where the calendar already puts things, for the days a plan covers. A thing
// planned for an hour belongs to the part of that day nearest it (of its own
// role, and within three hours): dinner at 6:30 is the Dinner slot's, and is
// offered nowhere else — not at lunch, and not the night before. One planned
// before the plan starts, or for an hour no part of the day covers, is in no
// slot at all. A thing planned for a day with no hour may go in any part of
// that day, and no other.
function holds(open, slots) {
  const dates = new Set(slots.map(s => s.date));
  const at = new Map();      // item id → the one slot key it may be in ('' for none)
  const dayOf = new Map();   // item id → the only date it may be on
  const bySlot = new Map();  // slot key → [{ it, away }], nearest first
  for (const it of open) {
    const w = it.when;
    if (!w || !dates.has(w.date)) continue;
    dayOf.set(it.id, w.date);
    if (minsOf(w.time) === null) continue;
    const day = slots.filter(s => s.date === w.date);
    const fit = itemfit.fitOf(it);
    let home = null;
    if (minsOf(w.time) >= minsOf(day[0].time) - 60) {
      for (const s of day) {
        const away = gap(w.time, s.time);
        if (fills(s.role, fit) && away <= HOLD_MIN && (!home || away < home.away)) home = { key: s.key, away };
      }
    }
    at.set(it.id, home ? home.key : '');
    if (home) bySlot.set(home.key, (bySlot.get(home.key) || []).concat({ it, away: home.away }).sort((a, b) => a.away - b.away));
  }
  return {
    may: (it, slot) => (at.has(it.id) ? at.get(it.id) === slot.key : !dayOf.has(it.id) || dayOf.get(it.id) === slot.date),
    of: (slot) => (bySlot.get(slot.key) || []).map(x => x.it),
  };
}

// ctxFor(slot) gives the facts for that slot's hour. `keep` is the pieces the
// person chose themselves ({ slotKey: itemId }): they stay where they were put.
//
// Each slot comes back with its `pick`, its runners-up (`alts`), and:
//   planned  the pick is on the calendar for this part of the day already
//   bumped   what IS on the calendar for it but is ruled out now (closed, rained
//            off): it is said, and something else is offered in its place
// A slot that holds a calendar plan takes that plan's hour as its own, so
// everything in it is weighed for 6:30 and not for "around 7".
function plan(items, slots, ctxFor, { keep = {} } = {}) {
  const open = items.filter(it => !it.done);
  const byId = new Map(open.map(it => [it.id, it]));
  const used = new Set(Object.values(keep).filter(id => byId.has(id)));
  const cal = holds(open, slots);
  let firstDinner = null;
  return slots.map((tmpl) => {
    const mine = cal.of(tmpl);
    const slot = mine.length ? { ...tmpl, time: mine[0].when.time } : tmpl;
    const ctx = ctxFor(slot);
    const lean = slot.other && firstDinner ? (firstDinner === 'place' ? 'recipe' : 'place') : null;
    const weigh = (it) => {
      const x = score(it, ctx);
      if (lean && x.kind === lean) x.score += W.otherDinner;
      return x;
    };
    const kept = byId.get(keep[slot.key]);
    const held = new Set(mine.map(it => it.id));
    const field = open.filter(it => fills(slot.role, itemfit.fitOf(it)) && cal.may(it, slot) && (!used.has(it.id) || (kept && it.id === kept.id)))
      .map(weigh).sort((a, b) => b.score - a.score);
    // Yours first; then what the calendar says, unless it is ruled out; then the
    // best thing that has nothing against it. Never the best of a bad lot.
    const onCal = mine.map(it => field.find(x => x.id === it.id)).filter(Boolean);
    const stands = onCal.find(x => !x.hidden);
    const pick = kept ? (field.find(x => x.id === kept.id) || weigh(kept))
      : stands || field.find(x => !x.hidden && !x.wrong) || null;
    const bumped = onCal.find(x => x.hidden && (!pick || x.id !== pick.id)) || null;
    if (pick) used.add(pick.id);
    if (pick && slot.role === 'eat' && !firstDinner && slot.label === 'Dinner') firstDinner = pick.kind;
    const rest = field.filter(x => !pick || x.id !== pick.id);
    const alts = [
      ...rest.filter(x => held.has(x.id)),                               // on the calendar for then, whatever is against it
      ...rest.filter(x => !held.has(x.id) && !x.hidden && !x.wrong),
      ...rest.filter(x => !held.has(x.id) && !x.hidden && x.wrong),      // yours to choose, eyes open
    ].slice(0, 6);
    return { ...slot, energy: ctx.energy, lean, kept: !!kept, planned: !!pick && held.has(pick.id), bumped, pick, alts };
  });
}

module.exports = { W, HALF_LIFE_MS, STEP, MAX_IDEAS, bucketOf, rough, wet, nice, blankTaste, featuresOf, learn, vote, voteIdea, faded, score, rank,
  slotsFor, plan, holds, fills, addDay, THEN_MIN, HOLD_MIN };
