// Kitchens: your pantry and your list to buy, and your partner's one switch
// away. A pushed SCREEN, not a sheet — you stand in front of a fridge with it.
//
// Who may open whose is the server's call (lib/kitchen.js canUse); the switch
// shows the kitchens the wire says you may open, and nothing else.
import { S } from './state.js';
import { $, esc, toast, showScreen } from './util.js';
import { get, post } from './api.js';
import { icon } from './icons.js';
import { haptic, skeleton } from './motion.js';

const enc = encodeURIComponent;
const me = () => S.wire && S.wire.me && S.wire.me.id;
const cache = () => { if (!S.kitchens) S.kitchens = {}; return S.kitchens; };

export async function getKitchen(uid) {
  const k = await get(`/api/kitchen/${enc(uid)}`);
  cache()[uid] = k;
  return k;
}
export async function setPantry(uid, name, state) {
  const k = await post(`/api/kitchen/${enc(uid)}/pantry`, { name, state });
  cache()[uid] = k;
  return k;
}
export async function addToBuy(uid, rows) {
  const k = await post(`/api/kitchen/${enc(uid)}/buy`, { add: rows });
  cache()[uid] = k;
  return k;
}
export const pantryCount = (k) => (k ? k.pantry.filter(e => e.state !== 'out').length : 0);
export const buyCount = (k) => (k ? k.buy.length + k.running.length : 0);

/* ── the screen ─────────────────────────────────────────────────────────── */

const NEXT = { have: 'low', low: 'out', out: 'have' };
const LABEL = { have: 'Have', low: 'Low', out: 'Out' };
const AISLES = ['Produce', 'Fridge and freezer', 'Cupboard', 'Spices', 'Other'];

let who = null;           // whose kitchen
let tab = 'pantry';       // 'pantry' | 'buy'
let ticked = new Map();   // row id or 'key:<key>' → true; committed on leaving
let onLeave = () => {};

const kitchens = () => {
  const list = (S.wire && S.wire.kitchens) || [];
  // In a pair list, you and your partner; anywhere else, the list the wire gave.
  const sp = S.space;
  const here = sp && sp.isPair ? list.filter(k => k.id === me() || (sp.members || []).some(m => m.id === k.id)) : list.filter(k => k.id === me());
  return here.length ? here : [{ id: me(), name: 'You' }];
};

export async function openKitchen(opts = {}) {
  who = opts.who || me();
  tab = opts.tab || 'pantry';
  ticked = new Map();
  showScreen('scr-kitchen');
  paint();
  try { await getKitchen(who); paint(); } catch (_) { toast('Could not open that kitchen'); }
}

function paint() {
  const k = cache()[who];
  const list = kitchens();
  $('kiWho').innerHTML = list.length > 1 ? list.map(x => `<button type="button" data-k="${esc(x.id)}" class="${x.id === who ? 'on' : ''}" aria-pressed="${x.id === who}">${
    x.id === me() ? 'Mine' : `${esc(x.name)}’s`}</button>`).join('') : '';
  $('kiWho').hidden = list.length < 2;
  const pc = k ? k.pantry.length : 0;
  const bc = buyCount(k);
  $('kiTabs').innerHTML = `<button type="button" data-t="pantry" class="${tab === 'pantry' ? 'on' : ''}" aria-pressed="${tab === 'pantry'}">Pantry <span class="n">${pc}</span></button>
    <button type="button" data-t="buy" class="${tab === 'buy' ? 'on' : ''}" aria-pressed="${tab === 'buy'}">To buy <span class="n">${bc}</span></button>`;
  const body = $('kiBody');
  if (!k) { body.innerHTML = skeleton(5); bindTop(); return; }
  if (tab === 'pantry') {
    const groups = AISLES.map(a => [a, k.pantry.filter(e => (e.aisle || 'Other') === a)]).filter(([, xs]) => xs.length);
    body.innerHTML = `<form class="ki-add" id="kiAdd"><span>${icon('plus', 20)}</span>
        <input id="kiNew" type="text" maxlength="80" placeholder="Add to the pantry…" autocomplete="off" aria-label="Add to the pantry"></form>
      ${groups.length ? groups.map(([a, xs]) => `<h3 class="ki-aisle">${esc(a)}</h3><div class="box rows">${xs.map(e => `<div class="crow ki-row">
          <span class="cb"><b>${esc(e.name)}</b></span>
          <button type="button" class="kstate ${e.state}" data-cycle="${esc(e.key)}" data-name="${esc(e.name)}" data-state="${e.state}"
            aria-label="${esc(`${e.name}: ${LABEL[e.state]}. Tap for ${LABEL[NEXT[e.state]]}`)}">${LABEL[e.state]}</button></div>`).join('')}</div>`).join('')
        : '<p class="ki-note">Nothing in the pantry yet. Add what you have, and recipes check against it.</p>'}
      <p class="ki-note">Tap to cycle: Have, Low, Out. Out goes on the list to buy. Recipes check against whichever kitchen you’re cooking in.</p>`;
  } else {
    const byFor = new Map();
    for (const b of k.buy) {
      const g = b.forTitle ? `For ${b.forTitle}` : 'On the list';
      if (!byFor.has(g)) byFor.set(g, []);
      byFor.get(g).push(b);
    }
    const groups = [...byFor.entries()];
    if (k.running.length) groups.push(['Running low', k.running.map(r => ({ id: `key:${r.key}`, name: r.name, amount: r.state === 'out' ? 'Out' : 'Low', running: true }))]);
    body.innerHTML = `${groups.length ? `<button type="button" class="primary" id="kiSend">${icon('share', 18)}Send the list</button>` : ''}
      ${groups.length ? groups.map(([g, xs]) => `<h3 class="ki-aisle">${esc(g)}</h3><div class="box rows">${xs.map(b => {
        const done = ticked.has(b.id);
        return `<button type="button" class="crow ki-buy${done ? ' got' : ''}" data-got="${esc(b.id)}" aria-pressed="${done}">
          <span class="ring">${icon('tick', 14, 3)}</span>
          <span class="cb"><b>${esc(b.name)}</b>${b.amount ? `<small>${esc(b.amount)}</small>` : ''}</span></button>`;
      }).join('')}</div>`).join('')
        : '<p class="ki-note">Nothing to buy. Add what a recipe is short of from its page, or mark something Out.</p>'}
      ${groups.length ? '<p class="ki-note">Tick what you bought. It moves into the pantry when you leave this screen.</p>' : ''}`;
  }
  bindTop();
  bindBody(k);
}

function bindTop() {
  $('kiWho').querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', async () => {
    await commit();
    who = b.dataset.k;
    paint();
    try { await getKitchen(who); paint(); } catch (_) {}
  }));
  $('kiTabs').querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', async () => {
    if (tab === b.dataset.t) return;
    await commit();
    tab = b.dataset.t;
    paint();
  }));
}

function bindBody(k) {
  const add = $('kiAdd');
  if (add) add.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('kiNew').value.trim();
    if (!name) return;
    try { await setPantry(who, name, 'have'); paint(); $('kiNew').focus(); } catch (_) { toast('Could not add that'); }
  });
  $('kiBody').querySelectorAll('[data-cycle]').forEach(b => b.addEventListener('click', async () => {
    const next = NEXT[b.dataset.state] || 'have';
    haptic('tick');
    b.className = `kstate ${next}`;
    b.textContent = LABEL[next];
    b.dataset.state = next;
    try { await setPantry(who, b.dataset.name, next); } catch (_) { toast('Could not change that'); paint(); }
  }));
  // Ticking strikes a row through; it stays until you leave, then becomes
  // Have. A mis-tap is one more tap.
  $('kiBody').querySelectorAll('[data-got]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.got;
    if (ticked.has(id)) ticked.delete(id); else ticked.set(id, true);
    haptic('tick');
    b.classList.toggle('got', ticked.has(id));
    b.setAttribute('aria-pressed', String(ticked.has(id)));
  }));
  const send = $('kiSend');
  if (send) send.addEventListener('click', async () => {
    const lines = [...k.buy.map(b => `${b.name}${b.amount ? ` (${b.amount})` : ''}`), ...k.running.map(r => r.name)];
    const text = `To buy:\n${lines.map(l => `• ${l}`).join('\n')}`;
    try {
      if (navigator.share) await navigator.share({ title: 'To buy', text });
      else { await navigator.clipboard.writeText(text); toast('List copied'); }
    } catch (_) { /* dismissed */ }
  });
}

// What was ticked goes into the pantry as Have.
async function commit() {
  if (!ticked.size || !who) return;
  const ids = [...ticked.keys()];
  ticked = new Map();
  for (const id of ids) {
    try {
      const k = await post(`/api/kitchen/${enc(who)}/buy`, id.startsWith('key:') ? { gotKey: id.slice(4) } : { got: id });
      cache()[who] = k;
    } catch (_) { /* already gone */ }
  }
}

export async function leaveKitchen() {
  await commit();
  onLeave();
}

export function initKitchen(leaveHandler) {
  onLeave = leaveHandler || (() => {});
  $('kiBack').addEventListener('click', leaveKitchen);
  // Leaving the app is leaving the screen, as far as ticks are concerned.
  document.addEventListener('visibilitychange', () => { if (document.hidden && $('scr-kitchen').classList.contains('active')) commit(); });
}
