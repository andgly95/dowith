// Nudges, over Web Push. The transport half is lifted from the workout app —
// lazily-minted VAPID keys, subscriptions in the store, dead endpoints pruned,
// bounded retries — because that part is solved and tested and this is not the
// place to have a second opinion about it.
//
// What is different here, and what matters: **who is allowed to be told.**
//
// In the workout app a notification was about your own training, so there was no
// audience question. Here every nudge is about somebody else's item, which means
// the notification surface is a second, quieter copy of the visibility model. A
// private item that generates a notification has leaked, and it has leaked
// somewhere worse than a screen — onto a lock screen, out loud, in a room. So
// `audienceFor()` below asks lib/spaces.js rather than reasoning about it, and
// there is nothing in this file that decides for itself who can see what.
const webpush = require('web-push');
const store = require('./../store');
const { state } = store;
const config = require('./config');
const SP = require('./spaces');

const CHECK_MS = 60000;
const MAX_TRIES = 5;
// Digests go out once a week, on a Sunday evening, when "what shall we do" is an
// actual question somebody is asking.
const DIGEST_DOW = 0;
const DIGEST_HOUR = 18;
let timer = null;

function keys() {
  let k = config.get('vapid');
  if (!k || !k.publicKey || !k.privateKey) {
    k = webpush.generateVAPIDKeys();
    config.set({ vapid: k });
    console.log('push: generated a VAPID keypair in', config.FILE);
  }
  return k;
}

const subject = () => config.get('vapidSubject', 'mailto:dowith@localhost');
const publicKey = () => { try { return keys().publicKey; } catch (_) { return null; } };

const devicesOf = (u) => (u && Array.isArray(u.push) ? u.push : []);

function addSub(user, raw) {
  const sub = raw && typeof raw === 'object' ? raw : {};
  const ok = typeof sub.endpoint === 'string'
    && (/^https:\/\//.test(sub.endpoint)
      || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(sub.endpoint));
  if (!ok) return null;
  const k = sub.keys && typeof sub.keys === 'object' ? sub.keys : {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return null;
  const clean = {
    endpoint: sub.endpoint.slice(0, 800),
    keys: { p256dh: String(k.p256dh).slice(0, 200), auth: String(k.auth).slice(0, 100) },
    at: Date.now(),
  };
  if (!Array.isArray(user.push)) user.push = [];
  // One row per endpoint — re-subscribing the same device must not stack up
  // duplicate notifications.
  user.push = user.push.filter(s => s.endpoint !== clean.endpoint);
  user.push.push(clean);
  store.save();
  return clean;
}

function removeSub(user, endpoint) {
  const before = devicesOf(user).length;
  user.push = devicesOf(user).filter(s => s.endpoint !== String(endpoint || ''));
  if (user.push.length !== before) store.save();
  return before - user.push.length;
}

// Send to one person's devices. There is no way to address anybody else's.
async function sendTo(user, payload) {
  const subs = devicesOf(user);
  if (!subs.length) return 0;
  let k;
  // Mint here rather than gating on "is it configured": gating meant the very
  // first send returned nothing and said nothing, which is the workout app's
  // one genuinely nasty bug and not worth repeating.
  try { k = keys(); } catch (e) { console.error('push: no keypair —', e.message); return 0; }
  webpush.setVapidDetails(subject(), k.publicKey, k.privateKey);
  const body = JSON.stringify(payload);
  let sent = 0;
  for (const sub of [...subs]) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body);
      sent++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) removeSub(user, sub.endpoint);
      else console.error('push send failed:', code || (e && e.message));
    }
  }
  return sent;
}

/* ── who may be told ─────────────────────────────────────────────────────── */

// THE gate for this file. Everyone who can see the item, minus whoever caused
// the nudge — by default its author, who does not need telling about their own
// thought.
//
// Derived from canSee rather than reimplemented: a nudge must never be able to
// reach further than the screen would, and the only way to guarantee that is to
// ask the same function.
function audienceFor(item, except = item && item.authorId) {
  if (!item || item.visibility === 'private') return [];
  return Object.values(state.users || {})
    .filter(u => u.id !== except && SP.canSee(item, u.id, state.spaces))
    // A user record can be aliased under two ids when somebody signs in through a
    // second door; dedupe so they are not told twice.
    .filter((u, i, all) => all.findIndex(x => x.id === u.id) === i);
}

// Somebody added something. Sent immediately, because "Linnea just added
// something" is only interesting for about an hour.
async function itemAdded(item, spaceTitleFor) {
  const author = (state.users || {})[item.authorId];
  const who = author ? (author.name || 'Someone') : 'Someone';
  let total = 0;
  for (const u of audienceFor(item)) {
    total += await sendTo(u, {
      title: `${who} added something`,
      body: item.title,
      // The list from THEIR side — "to do with Andrew", not "to do with Linnea".
      detail: spaceTitleFor ? spaceTitleFor(item.spaceId, u.id) : null,
      spaceId: item.spaceId,
      tag: `added:${item.spaceId}`,
    });
  }
  return total;
}

/* ── somebody ticked something off ───────────────────────────────────────

   "Linnea ticked off record shopping" is the nice bit, and it used to reach
   nobody until they happened to open the list. */

// How long a tick sits before anybody is told. Long enough to undo a mis-tap —
// the row vanishes into the record, so noticing and fixing it takes a few
// seconds — and short enough that the news is still news.
const DONE_GRACE_MS = 30000;
const pendingDone = new Map();   // item id → timer

// Who hears about it: everyone who can see it, minus whoever ticked it. NOT
// minus the author — when Linnea ticks off Andrew's thing, Andrew is exactly who
// wants to know.
//
// Asked at SEND time, from the store as it is then, not as it was at the tap:
// un-ticked in the meantime, ticked by somebody else since, deleted, or made
// private — any of those and the answer is nobody.
//
// And only people who share a list with whoever ticked it. A standing wish is
// visible in every one of its author's lists, so without this Sam would get
// "Linnea ticked something off" about somebody he has never shared a list with.
// That narrows what audienceFor allows; it never widens it.
function doneAudienceFor(itemId, byUid) {
  const it = (state.items || []).find(x => x.id === itemId);
  if (!it || !it.done || it.doneBy !== byUid) return [];
  const knows = SP.circleOf(state.spaces, byUid);
  return audienceFor(it, byUid).filter(u => knows.has(u.id));
}

async function itemDone(itemId, byUid, spaceTitleFor) {
  const who = (state.users[byUid] && state.users[byUid].name) || 'Someone';
  const audience = doneAudienceFor(itemId, byUid);
  if (!audience.length) return 0;
  // Resolved once, before the first send: a delete landing between two sends
  // must not leave the second one reading a title off nothing.
  const it = state.items.find(x => x.id === itemId);
  let total = 0;
  for (const u of audience) {
    total += await sendTo(u, {
      title: `${who} ticked something off`,
      body: it.title,
      detail: spaceTitleFor ? spaceTitleFor(it.spaceId, u.id) : null,
      spaceId: it.spaceId,
      // Per item, so ticking the same thing twice replaces rather than stacks.
      tag: `done:${it.id}`,
    });
  }
  return total;
}

// The route calls this on the not-done → done transition only. Un-ticking is a
// state change, not an occasion, and nobody is told about it. A second tick of
// the same item restarts the wait rather than queueing a second nudge.
function doneLater(item, byUid, spaceTitleFor, wait = DONE_GRACE_MS) {
  clearTimeout(pendingDone.get(item.id));
  const t = setTimeout(() => {
    pendingDone.delete(item.id);
    itemDone(item.id, byUid, spaceTitleFor).catch(e => console.error('push:', e.message));
  }, wait);
  if (t.unref) t.unref();
  pendingDone.set(item.id, t);
}

/* ── the weekly digest ───────────────────────────────────────────────────── */

// What is still open, for one person, across every list. Same visibility rule.
function openFor(uid) {
  const out = [];
  for (const sp of SP.spacesOf(state.spaces, uid)) {
    for (const it of SP.visibleIn(state.items, sp, uid, state.spaces)) {
      if (!it.done && !out.some(x => x.id === it.id)) out.push(it);
    }
  }
  return out;
}

async function digestFor(u, today) {
  const open = openFor(u.id);
  if (open.length < 3) return 0;                 // not worth a notification
  // Oldest first: the things that have been sitting longest are the ones worth
  // being reminded of.
  const pick = open.slice().sort((a, b) => a.createdAt - b.createdAt).slice(0, 3);
  const sent = await sendTo(u, {
    title: `${open.length} things waiting`,
    body: pick.map(i => i.title).join(' · '),
    detail: 'Any of these this weekend?',
    tag: 'digest',
  });
  if (sent) { u.digestOn = today; store.save(); }
  return sent;
}

/* ── the loop ────────────────────────────────────────────────────────────── */

const dayStr = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// One pass. `now` is a parameter so this is drivable from a test instead of
// being a branch nobody runs until Sunday.
async function tick(now = new Date()) {
  if (now.getDay() !== DIGEST_DOW || now.getHours() < DIGEST_HOUR) return [];
  const today = dayStr(now);
  const fired = [];
  for (const u of Object.values(state.users || {})) {
    if (u.digestOn === today) continue;          // one a week, not one a minute
    if (!devicesOf(u).length) continue;
    const tries = u.digestTries;
    if (tries && tries.day === today && tries.n >= MAX_TRIES) continue;
    const sent = await digestFor(u, today);
    if (sent) { delete u.digestTries; fired.push(u.id); }
    else {
      // Only count an attempt if there was something to send — "fewer than three
      // things open" is not a failure and must not burn the retry budget.
      if (openFor(u.id).length >= 3) {
        u.digestTries = tries && tries.day === today ? { day: today, n: tries.n + 1 } : { day: today, n: 1 };
        store.save();
      }
    }
  }
  return fired;
}

function start() {
  if (timer || process.env.NO_PUSH) return;
  timer = setInterval(() => { tick().catch(e => console.error('push tick:', e.message)); }, CHECK_MS);
  if (timer.unref) timer.unref();
}
const stop = () => {
  clearInterval(timer); timer = null;
  for (const t of pendingDone.values()) clearTimeout(t);
  pendingDone.clear();
};

module.exports = {
  publicKey, addSub, removeSub, sendTo, audienceFor, itemAdded,
  doneAudienceFor, itemDone, doneLater,
  openFor, digestFor, tick, start, stop, devicesOf,
  CHECK_MS, MAX_TRIES, DIGEST_DOW, DIGEST_HOUR, DONE_GRACE_MS,
};
