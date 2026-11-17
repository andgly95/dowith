// Cooking timers that still go off when the phone is locked.
//
// A countdown in a web page stops being useful the moment the phone locks,
// which in a kitchen is constantly. So a started timer is ALSO registered here,
// and a ten-second tick sends the ones that are due as a push — to the person
// who started it, and nobody else. It is their timer; a nudge on somebody
// else's phone about somebody else's pan is noise.
//
// `endsAt` is the SERVER's clock: the client sends a length, never an end, and
// is told the server's `now` so it can correct for its own clock.

const SP = require('./spaces');

const MAX_EACH = 6;
const MAX_SECS = 6 * 60 * 60;
const TICK_MS = 10 * 1000;

const list = (state) => {
  if (!Array.isArray(state.timers)) state.timers = [];
  return state.timers;
};

function add(state, { id, uid, itemId, secs, label, step }, now = Date.now()) {
  const s = Math.round(Number(secs));
  if (!Number.isFinite(s) || s < 5 || s > MAX_SECS) return { error: 'a timer is 5 seconds to 6 hours' };
  const mine = list(state).filter(t => t.uid === uid);
  if (mine.length >= MAX_EACH) return { error: 'six timers at once is the most' };
  const t = {
    id, uid, itemId,
    step: Number.isInteger(step) && step >= 0 && step < 40 ? step : 0,
    label: String(label == null ? '' : label).replace(/\s+/g, ' ').trim().slice(0, 24) || 'Timer',
    endsAt: now + s * 1000,
  };
  list(state).push(t);
  return { timer: t };
}

// Only your own. Somebody else's timer is the same 404 as anything else.
function remove(state, id, uid) {
  const before = list(state).length;
  state.timers = list(state).filter(t => !(t.id === id && t.uid === uid));
  return state.timers.length !== before;
}

// The due ones, taken off the list and handed to `send(user, payload)`. A timer
// whose item has gone, or that its starter can no longer see, goes quietly.
async function fire(state, send, now = Date.now()) {
  const due = list(state).filter(t => t.endsAt <= now);
  if (!due.length) return { due: 0, sent: 0 };
  state.timers = list(state).filter(t => t.endsAt > now);
  let sent = 0;
  for (const t of due) {
    const item = (state.items || []).find(i => i.id === t.itemId);
    const user = state.users && state.users[t.uid];
    if (!item || !user || !SP.canSee(item, t.uid, state.spaces)) continue;
    try {
      await send(user, {
        title: `${t.label} is done`,
        body: item.title,
        tag: `timer-${t.id}`,
        url: `/?list=${encodeURIComponent(item.spaceId)}&cook=${encodeURIComponent(item.id)}&step=${t.step}`,
        spaceId: item.spaceId,
      });
      sent++;
    } catch (_) { /* a failed push is not a crash */ }
  }
  return { due: due.length, sent };
}

let timer = null;
function start(store, send) {
  if (timer || process.env.NO_PUSH) return;
  timer = setInterval(() => {
    fire(store.state, send).then((r) => { if (r.due) store.save(); })
      .catch(e => console.error('timers:', e.message));
  }, TICK_MS);
  if (timer.unref) timer.unref();
}

module.exports = { add, remove, fire, start, MAX_EACH, MAX_SECS, TICK_MS };
