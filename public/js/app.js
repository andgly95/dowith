// Entry point: identity first, then the shelf.
import { S } from './state.js';
import { $, showScreen, toast, closeSheet, openSheet, initialOf } from './util.js';
import { loadState, get, subscribePush, unsubscribePush } from './api.js';
import { initAuth, checkAuth, showAuth, signOut } from './auth.js';
import { initShelf, renderShelf } from './shelf.js';
import { initSpace, openSpace } from './space.js';
import { initShare, incoming, openShare } from './share.js';

function toShelf() {
  S.spaceId = null;
  renderShelf();
  showScreen('scr-shelf');
}

async function openAccount() {
  const me = S.wire && S.wire.me;
  if (!me) return;
  $('meName').textContent = me.name || me.email;
  $('meEmail').textContent = me.email;
  $('meCircle').textContent = S.wire.circle || 0;
  // The Square bridge, said plainly. It is plumbing today and the screen should
  // not imply otherwise.
  try {
    const sq = await get('/api/square/status');
    $('squareState').textContent = !sq.configured ? 'not connected'
      : sq.linkable ? 'connected'
      : `${sq.people} people found · linking not built yet`;
  } catch (_) { $('squareState').textContent = 'unavailable'; }
  paintNudge();
  openSheet('meSheet');
}

function paintNudge() {
  const supported = 'PushManager' in window && 'Notification' in window;
  $('nudgeRow').hidden = !supported;
  if (!supported) return;
  const on = !!(S.wire && S.wire.push && S.wire.push.subscribed);
  $('optNudge').checked = on;
  $('nudgeSub').textContent = on
    ? 'on for this device — and a nudge on Sundays'
    : 'when someone adds something to a list';
}

async function start() {
  await loadState();
  initShelf((id) => openSpace(id), openAccount);
  initSpace(renderShelf, toShelf);
  initShare((spaceId) => openSpace(spaceId));
  // From a gesture, which a change event is — iOS ignores the prompt otherwise.
  $('optNudge').addEventListener('change', async (e) => {
    if (!e.target.checked) { await unsubscribePush(); return paintNudge(); }
    const r = await subscribePush();
    if (!r.ok) toast(r.why);
    paintNudge();
  });
  $('meSignOut').addEventListener('click', signOut);
  $('meCancel').addEventListener('click', () => closeSheet('meSheet'));
  $('meSheet').addEventListener('click', (e) => { if (e.target === $('meSheet')) closeSheet('meSheet'); });
  toShelf();

  // A share survives the sign-in round trip because it lives in the URL, so this
  // runs after auth rather than before it.
  const inc = incoming();
  if (inc) openShare(inc);

  // Somebody else may have added something while you were away.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    loadState().then(() => { if (S.spaceId) return; renderShelf(); }).catch(() => {});
  });
}

async function boot() {
  initAuth(() => start());
  const status = await checkAuth();
  if (status !== 'in') return showAuth();
  await start();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

boot();
