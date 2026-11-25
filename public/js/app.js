// Entry point: identity first, then straight into your first list.
import { S } from './state.js';
import { $, showScreen, toast, closeSheet, openSheet, initialOf } from './util.js';
import { loadState, get, subscribePush, unsubscribePush } from './api.js';
import { initAuth, checkAuth, showAuth, signOut } from './auth.js';
import { initShelf, renderShelf } from './shelf.js';
import { initSpace, openSpace, refresh } from './space.js';
import { sheetDrag } from './motion.js';
import { openCook } from './cook.js';
import { initShare, incoming, openShare } from './share.js';
import { initClaude, paintClaudeRow } from './connect.js';

function toShelf() {
  S.spaceId = null;
  renderShelf();
  showScreen('scr-shelf');
}

// Themes. The palettes live in style.css, scoped by [data-theme]; this is only
// the list of names. Per device, in localStorage, because it is a preference
// about this screen — and an inline script in <head> applies it before first
// paint so the app never flashes the wrong colours on launch.
const THEMES = [
  { id: 'dusk', label: 'Dusk' },
  { id: 'forest', label: 'Forest' },
];
// A theme that was renamed, and what it is called now. Phones remember the old
// name, and without this they would fall back to Dusk with no way to tell why.
// The <head> script carries the same map, because it paints before this runs.
const RENAMED = { olive: 'forest' };
const currentTheme = () => {
  const t = document.documentElement.dataset.theme;
  const id = RENAMED[t] || t;
  return THEMES.some(x => x.id === id) ? id : THEMES[0].id;
};

function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem('dw-theme', id); } catch (_) {}
  // The status bar on Android/desktop reads theme-color; Safari 26 samples the
  // page instead, which follows on its own because html carries --bg.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.content = bg;
}

function paintThemes() {
  const cur = currentTheme();
  const el = $('themePick');
  // Each card carries data-theme itself, so the tiny list it draws is painted
  // from the very palette it would switch to — the attribute scoping in
  // style.css exists for exactly this.
  el.innerHTML = THEMES.map(t => `<button type="button" data-theme="${t.id}"
    class="${t.id === cur ? 'on' : ''}" aria-pressed="${t.id === cur}">
      <span class="mini" aria-hidden="true">
        <i><u></u><s></s><em></em></i>
        <i><u></u><s class="short"></s><em class="d"></em></i>
        <b></b>
      </span>${t.label}
      <span class="ck" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M5.5 12.4l4.3 4.3L18.6 7.6"/></svg></span>
    </button>`).join('');
  el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    applyTheme(b.dataset.theme);
    paintThemes();
  }));
}

async function openAccount() {
  const me = S.wire && S.wire.me;
  if (!me) return;
  $('meName').textContent = me.name || me.email;
  $('meAvatar').textContent = initialOf(me.name || me.email);
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
  paintClaudeRow();
  paintNudge();
  paintThemes();
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
    : 'when someone adds, plans or ticks off something';
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
  initClaude();
  $('meCancel').addEventListener('click', () => closeSheet('meSheet'));
  $('meSheet').addEventListener('click', (e) => { if (e.target === $('meSheet')) closeSheet('meSheet'); });
  // Every sheet closes on a tap on the scrim, through its own X — so whatever
  // closing that sheet has to do (forget a share, repaint the rose's dot)
  // happens whichever way you leave it.
  // Pulling one down by its grabber closes it the same way.
  document.querySelectorAll('.modal').forEach((m) => {
    const close = () => { const x = m.querySelector('.modal-hd .x, .pl-snip .x, .rp-x'); if (x) x.click(); };
    m.addEventListener('click', (e) => { if (e.target === m) close(); });
    sheetDrag(m, close);
  });
  // Land in the list, not on the shelf of lists.
  //
  // Almost everybody has one list and will have one list for a long time, so
  // the shelf was a screen you tapped through on the way to the only place you
  // were ever going. The back arrow in the header still gets you to it, which
  // is the right way round: the common case is free and the rare one costs a
  // tap, rather than the other way about.
  const first = (S.wire && S.wire.spaces) || [];
  // A nudge or a timer says which list — and, for a timer, which recipe and
  // step to cook from. Only a list you are in; anything else is the first.
  const deep = deepLink(location.href);
  const target = deep && first.find(x => x.id === deep.list);
  if (target) await openSpace(target.id);
  else if (first.length) await openSpace(first[0].id); else toShelf();
  if (deep) { followCook(deep); history.replaceState(null, '', '/'); }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', async (e) => {
      const d = e.data && e.data.type === 'open' ? deepLink(new URL(e.data.url, location.origin).href) : null;
      if (!d) return;
      if (d.list && d.list !== S.spaceId && first.some(x => x.id === d.list)) await openSpace(d.list);
      followCook(d);
    });
  }

  // A share survives the sign-in round trip because it lives in the URL, so this
  // runs after auth rather than before it.
  const inc = incoming();
  if (inc) openShare(inc);

  // Somebody else may have added something while you were away — and the list
  // you are standing in is the one that matters. It used to repaint only the
  // shelf, so a list left open on the phone showed none of it until you left
  // and came back. What arrived since you last looked glows as it lands.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    loadState().then(() => (S.spaceId ? refresh({ arrived: true }) : renderShelf())).catch(() => {});
  });
}

// `/?list=<space>&cook=<item>&step=<n>`, from a nudge or a cooking timer.
function deepLink(href) {
  const q = new URL(href).searchParams;
  const list = q.get('list');
  const cook = q.get('cook');
  if (!list && !cook) return null;
  return { list, cook, step: Math.max(0, Number(q.get('step')) || 0) };
}
function followCook(d) {
  if (d && d.cook && (S.items || []).some(i => i.id === d.cook)) openCook(d.cook, { step: d.step });
}

async function boot() {
  applyTheme(currentTheme());   // sync theme-color with whatever <head> chose
  initAuth(() => start());
  const status = await checkAuth();
  if (status !== 'in') return showAuth();
  await start();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

boot();
