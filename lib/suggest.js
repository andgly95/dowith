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

const placefit = require('./placefit');
const itemfit = require('./itemfit');
const kinds = require('./kinds');

const W = {
  fits: 10, push: -14, under: -3,           // energy: exactly right · each level too much · each level to spare
  time: 6, wrongTime: -10, lateLong: -6,    // part of the day
  wxGood: 10, wxPoor: -18, niceOut: 8, wetOut: -14, cosy: 9, indoorsWet: 4,
  open: 4, closed: -45, closing: -6,
  near: 8, close: 4, far: -6, trek: -14, apart: -3, tiredTravel: 1.6,
  home: 5,
  planned: 30, plannedElse: -4,
  keepGoing: 7, caughtUp: -10,
  haveAll: 6, nearlyAll: 2,
  up: 9, down: -22, pref: 5,
  fresh: 2, sameKind: 5,
  otherDinner: 8,                          // a plan over two days: one dinner out, one cooked
};
const HALF_LIFE_MS = 21 * 24 * 60 * 60 * 1000;   // a thumb fades: "not tonight" is not "never"
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

// Weather, read coarsely: is it a day to be out in, or one to stay in for.
const rough = (w) => !!w && ((Number.isFinite(w.rain) && w.rain >= 50)
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
//        transitOf(it), readyOf(it), tastes: [taste…] }
function score(it, ctx) {
  const fit = itemfit.fitOf(it);
  const kind = kinds.clean(it.kind);
  const bucket = bucketOf(ctx.time);
  const reasons = [];
  let pts = 0;
  let hidden = false;
  const say = (tone, text, n) => { pts += n; if (text) reasons.push({ tone, text, n }); };

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
      say('bad', `Weather’s against it · ${j.why.map(x => x.replace(/_/g, ' ')).join(', ')}`, W.wxPoor);
      if (wf.setting === 'outdoors') hidden = true;
    } else if (j) say('note', `Not quite the weather · ${j.why.map(x => x.replace(/_/g, ' ')).join(', ')}`, 0);
  } else if (w && wf && !wf.matters) {
    if (rough(w)) say('good', 'Indoors, so the weather won’t matter', W.indoorsWet);
  } else if (w) {
    if (fit.weather === 'needs_good') {
      if (nice(w)) say('good', 'Nice out for it', W.niceOut);
      else if (rough(w)) say('bad', 'Wet then', W.wetOut);
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

  // Already on a day.
  if (it.when && it.when.date) {
    if (it.when.date === ctx.date) say('good', `Planned for then${it.when.time ? ` · ${hm(it.when.time)}` : ''}`, W.planned);
    else if (it.when.date > ctx.date) say('note', null, W.plannedElse);
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
    id: it.id, kind, score: Math.round(pts), hidden,
    reasons: reasons.filter(r => r.text).sort((a, b) => Math.abs(b.n) - Math.abs(a.n)).slice(0, 3).map(({ tone, text }) => ({ tone, text })),
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
function rank(items, ctx) {
  const all = items.filter(it => !it.done).map(it => score(it, ctx));
  const shown = all.filter(x => !x.hidden).sort((a, b) => b.score - a.score);
  const picked = [];
  const pool = shown.slice();
  const seen = {};
  while (pool.length && picked.length < 12) {
    let bi = 0, bv = -Infinity;
    pool.forEach((x, i) => { const v = x.score - W.sameKind * (seen[x.kind] || 0); if (v > bv) { bv = v; bi = i; } });
    const [x] = pool.splice(bi, 1);
    seen[x.kind] = (seen[x.kind] || 0) + 1;
    picked.push(x);
  }
  return {
    good: picked.concat(pool),
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

// ctxFor(slot) gives the facts for that slot's hour. `keep` is the pieces the
// person chose themselves ({ slotKey: itemId }): they stay where they were put.
function plan(items, slots, ctxFor, { keep = {} } = {}) {
  const open = items.filter(it => !it.done);
  const byId = new Map(open.map(it => [it.id, it]));
  const used = new Set(Object.values(keep).filter(id => byId.has(id)));
  let firstDinner = null;
  return slots.map((slot) => {
    const ctx = ctxFor(slot);
    const lean = slot.other && firstDinner ? (firstDinner === 'place' ? 'recipe' : 'place') : null;
    const weigh = (it) => {
      const x = score(it, ctx);
      if (lean && x.kind === lean) x.score += W.otherDinner;
      return x;
    };
    const kept = byId.get(keep[slot.key]);
    const field = open.filter(it => fills(slot.role, itemfit.fitOf(it)) && (!used.has(it.id) || (kept && it.id === kept.id)))
      .map(weigh).filter(x => !x.hidden || (kept && x.id === kept.id)).sort((a, b) => b.score - a.score);
    const pick = kept ? (field.find(x => x.id === kept.id) || weigh(kept)) : field[0] || null;
    if (pick) used.add(pick.id);
    if (pick && slot.role === 'eat' && !firstDinner && slot.label === 'Dinner') firstDinner = pick.kind;
    return { ...slot, energy: ctx.energy, lean, kept: !!kept, pick, alts: field.filter(x => !pick || x.id !== pick.id).slice(0, 6) };
  });
}

module.exports = { W, HALF_LIFE_MS, STEP, MAX_IDEAS, bucketOf, rough, nice, blankTaste, featuresOf, learn, vote, voteIdea, faded, score, rank,
  slotsFor, plan, fills, addDay };
