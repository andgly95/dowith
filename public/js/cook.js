// Cook mode: one step per screen, readable from across a counter, with the
// step's own ingredients scaled to tonight's servings and its timer one tap
// away. Then Made it.
//
// Timers run here AND on the server. Here, because a countdown on screen is
// the point; on the server, because a phone in a kitchen locks constantly and a
// timer that dies with the screen is worse than none. The server keeps the
// clock (it is sent a length, never an end) and pushes to whoever started it.
import { S } from './state.js';
import { $, esc, toast, showScreen } from './util.js';
import { haptic, burst } from './motion.js';
import { get, post, del, applyWire } from './api.js';
import { icon } from './icons.js';
import { refresh, changed, doneLanded } from './space.js';
import { servings, amount, openRecipe } from './recipe.js';
import { setPantry } from './kitchen.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const AGAIN = [['soon', 'Can’t wait'], ['maybe', 'Maybe someday'], ['once', 'Once was enough']];

let id = null;            // the recipe being cooked
let step = 0;
let kitchen = null;       // whose kitchen it is being cooked from
const timers = new Map(); // `${itemId}:${step}:${i}` → { itemId, step, i, label, secs, remaining, endsAt, serverId, running, done, doneAt }
const SOON = 10 * 1000;   // the last ten seconds, a timer starts to breathe
const RINGING = 4000;     // and for a few seconds after it is done, it rings
let ticker = null;
let poller = null;
let wake = null;
let others = [];

const me = () => S.wire && S.wire.me && S.wire.me.id;
const itemNow = () => (S.items || []).find(x => x.id === id);
const recipeNow = () => { const it = itemNow(); return it && it.mod && it.mod.recipe; };
const calm = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const mmss = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const say = (msg) => { const el = $('ckSay'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 30); } };

/* ── picking up where you left off ─────────────────────────────────────── */

// The step you were on, remembered on this device for six hours.
export function pickUp(itemId) {
  try {
    const v = JSON.parse(localStorage.getItem(`dw-cook:${itemId}`) || 'null');
    if (v && Date.now() - v.at < SIX_HOURS && v.step > 0) return v.step;
  } catch (_) {}
  return 0;
}
function remember() {
  try { localStorage.setItem(`dw-cook:${id}`, JSON.stringify({ step, at: Date.now() })); } catch (_) {}
}
function forget(itemId) { try { localStorage.removeItem(`dw-cook:${itemId}`); } catch (_) {} }

/* ── the screen stays on ───────────────────────────────────────────────── */

// "Screen stays on" is shown only while the lock is actually HELD. Before iOS
// 18.4 a home-screen app could not hold one at all, and the line just is not
// there — which is honest.
async function holdScreen() {
  paintWake();
  if (!('wakeLock' in navigator) || wake) return;
  try {
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => { wake = null; paintWake(); });
  } catch (_) { wake = null; }
  paintWake();
}
function paintWake() { const el = $('ckWake'); if (el) el.hidden = !(wake && !wake.released); }
function letScreenGo() { if (wake) { wake.release().catch(() => {}); wake = null; } paintWake(); }

/* ── cook mode ─────────────────────────────────────────────────────────── */

export function openCook(itemId, opts = {}) {
  const it = (S.items || []).find(x => x.id === itemId);
  const r = it && it.mod && it.mod.recipe;
  if (!r || !r.steps.length) return toast('No steps to cook from yet');
  id = itemId;
  step = Math.max(0, Math.min(r.steps.length - 1, Number(opts.step) || 0));
  kitchen = opts.kitchen || me();
  others = [];
  showScreen('scr-cook');
  paint();
  holdScreen();
  remember();
  presence();
  clearInterval(poller);
  poller = setInterval(() => { if ($('scr-cook').classList.contains('active')) presence(true); }, 15000);
  ensureTicker();
}

function leaveCook() {
  letScreenGo();
  clearInterval(poller);
  poller = null;
  showScreen('scr-space');
  if (id) openRecipe(id);
}

function go(to) {
  const r = recipeNow();
  if (!r) return;
  step = Math.max(0, Math.min(r.steps.length - 1, to));
  remember();
  paint();
  presence();
  $('ckBody').scrollTop = 0;
  if (!calm()) {
    const el = $('ckBody').firstElementChild;
    if (el && el.animate) el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
  }
}

// "Linnea's on step 4". Posted on every step, polled every 15 s while open,
// never pushed.
async function presence(pollOnly = false) {
  if (!id) return;
  try {
    const b = pollOnly ? await get(`/api/item/${id}/cooking`) : await post(`/api/item/${id}/cooking`, { step });
    others = b.others || [];
    paintOthers();
  } catch (_) { /* nobody else, as far as we know */ }
}
function paintOthers() {
  const el = $('ckOther');
  if (!el) return;
  const o = others[0];
  el.hidden = !o;
  if (o) el.innerHTML = `<span class="av">${esc((o.name || '?')[0])}</span>${esc(o.name)}’s on step ${o.step + 1}`;
}

function keyOf(itemId, s, i) { return `${itemId}:${s}:${i}`; }
function timerFor(s, i) {
  const r = recipeNow();
  const t = r.steps[s].timers[i];
  const k = keyOf(id, s, i);
  if (!timers.has(k)) timers.set(k, { itemId: id, step: s, i, label: t.label, secs: t.secs, remaining: t.secs * 1000, endsAt: null, serverId: null, running: false, done: false });
  return timers.get(k);
}
const leftOf = (t) => (t.running ? t.endsAt - Date.now() : t.remaining);
const ringing = (t) => t.done && t.doneAt && Date.now() - t.doneAt < RINGING;

function paint() {
  const it = itemNow();
  const r = recipeNow();
  if (!it || !r) return;
  const n = r.steps.length;
  const st = r.steps[step];
  const sv = servings(it);
  $('ckStep').textContent = `Step ${step + 1} of ${n}`;
  $('ckServes').textContent = sv.label;
  $('ckProg').innerHTML = r.steps.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('');
  paintWake();
  paintOthers();
  paintTray();
  const uses = (st.uses || []).map(i => r.ingredients[i]).filter(Boolean);
  $('ckBody').innerHTML = `<div class="ck-step">
      <span class="ck-n">${step + 1}</span>
      <p class="ck-text">${esc(st.text)}</p>
      ${uses.length ? `<h3 class="ck-h">For this step</h3><div class="ck-uses">${uses.map((ing) => {
        const a = amount(ing.q, sv.scale, ing.unit, ing.q2);
        return `<span class="ck-use">${a ? `<b>${esc(a)}</b> ${esc(ing.name)}` : esc(ing.text)}</span>`;
      }).join('')}</div>` : ''}
      ${st.timers.map((t, i) => {
        const tm = timerFor(step, i);
        return `<div class="box ck-timer${tm.done ? ' done' : ''}${ringing(tm) ? ' ringing' : ''}" data-tk="${esc(keyOf(id, step, i))}">
          <span class="cb"><small>${esc(t.label)} · ${esc(mmss(t.secs * 1000).replace(/^0:/, '0:'))}</small>
          <b class="left" data-left="${esc(keyOf(id, step, i))}">${tm.done ? 'Done' : esc(mmss(leftOf(tm)))}</b></span>
          <button type="button" class="go" data-run="${i}" aria-label="${tm.running ? `Pause the ${esc(t.label)} timer` : `Start the ${esc(t.label)} timer`}">${
            icon(tm.running ? 'pause' : 'play', 26, 2.2)}</button></div>`;
      }).join('')}
    </div>`;
  const last = step === n - 1;
  $('ckBack').disabled = step === 0;
  $('ckNext').classList.toggle('finish', last);
  $('ckNext').innerHTML = last ? `${icon('check', 20)}Finish` : `Next step${icon('next', 20)}`;
  $('ckBody').querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => runToggle(step, Number(b.dataset.run))));
}

// Timers from OTHER steps, still running or just done. Tapping one jumps to it.
function paintTray() {
  const list = [...timers.values()].filter(t => t.itemId === id && t.step !== step && (t.running || t.done));
  $('ckTray').innerHTML = list.map(t => `<button type="button" class="tray${t.done ? ' done' : ''}${ringing(t) ? ' ringing' : ''}" data-jump="${t.step}">${icon('timer', 17)}
      <span>Step ${t.step + 1} · ${esc(t.label)}</span><b data-left="${esc(keyOf(t.itemId, t.step, t.i))}">${t.done ? 'done' : esc(mmss(leftOf(t)))}</b></button>`).join('');
  $('ckTray').hidden = !list.length;
  $('ckTray').querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => go(Number(b.dataset.jump))));
}

async function runToggle(s, i) {
  const t = timerFor(s, i);
  if (t.running) {
    t.remaining = Math.max(0, t.endsAt - Date.now());
    t.running = false;
    t.endsAt = null;
    if (t.serverId) { del(`/api/timer/${t.serverId}`).catch(() => {}); t.serverId = null; }
    say(`${t.label} timer paused`);
  } else {
    if (t.done) { t.done = false; t.doneAt = null; t.remaining = t.secs * 1000; }
    haptic('tick');
    t.running = true;
    t.endsAt = Date.now() + t.remaining;
    say(`${t.label} timer started, ${Math.round(t.remaining / 60000) || 1} minutes`);
    // Registered so a locked phone is still told. The server's clock wins:
    // its `now` corrects for this phone's.
    try {
      const b = await post(`/api/item/${t.itemId}/timer`, { secs: Math.max(5, Math.round(t.remaining / 1000)), label: t.label, step: s });
      if (t.running) { t.serverId = b.id; t.endsAt = Date.now() + (b.endsAt - b.now); }
      else del(`/api/timer/${b.id}`).catch(() => {});
    } catch (_) { /* it still runs here */ }
  }
  paint();
}

function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    let finished = false;
    for (const [k, t] of timers) {
      if (!t.running) continue;
      const left = t.endsAt - Date.now();
      if (left <= 0) {
        t.running = false;
        t.done = true;
        t.doneAt = Date.now();
        t.remaining = 0;
        finished = true;
        say(`${t.label} is done`);
        try { if (navigator.vibrate) navigator.vibrate([250, 120, 250]); } catch (_) {}
        // Seen here, so the push would only say it twice.
        if (t.serverId && !document.hidden) { del(`/api/timer/${t.serverId}`).catch(() => {}); t.serverId = null; }
        if (!document.hidden && t.step !== step && t.itemId === id) toast(`${t.label} is done`);
      }
      document.querySelectorAll(`[data-left="${CSS.escape(k)}"]`).forEach((el) => {
        el.textContent = t.done ? 'done' : mmss(Math.max(0, left));
        // The last ten seconds breathe, so a glance across the kitchen says
        // "nearly" before the number does.
        const box = el.closest('.ck-timer, .tray');
        if (box) box.classList.toggle('soon', t.running && left <= SOON);
      });
    }
    if (finished && $('scr-cook').classList.contains('active')) paint();
    if (![...timers.values()].some(t => t.running)) { clearInterval(ticker); ticker = null; }
  }, 250);
}

/* ── made it ───────────────────────────────────────────────────────────── */

let again = null;
let ranOut = new Set();

function openMade() {
  const it = itemNow();
  const r = recipeNow();
  if (!it || !r) return;
  letScreenGo();
  clearInterval(poller);
  again = null;
  ranOut = new Set();
  const when = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const ready = (it.ready && it.ready[kitchen]) || [];
  // The things the kitchen you cooked from HAD — the ones that could have run out.
  const had = [...new Map(r.ingredients.map((ing, i) => [i, ing]).filter(([i]) => ready[i])
    .map(([, ing]) => [(ing.name || ing.text).toLowerCase(), ing.name || ing.text])).values()].slice(0, 16);
  $('mdTitle').textContent = it.title;
  $('mdWhen').textContent = `Cooked together · ${when}`;
  const chips = (el, list, on, fn) => {
    el.innerHTML = list.map(([v, l]) => `<button type="button" data-v="${esc(v)}" class="${on(v) ? 'on' : ''}" aria-pressed="${on(v)}">${esc(l)}</button>`).join('');
    el.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => { fn(b.dataset.v); chips(el, list, on, fn); }));
  };
  chips($('mdAgain'), AGAIN, v => again === v, (v) => { again = again === v ? null : v; });
  $('mdOutBox').hidden = !had.length;
  chips($('mdOut'), had.map(n => [n, n[0].toUpperCase() + n.slice(1)]), v => ranOut.has(v), (v) => { if (ranOut.has(v)) ranOut.delete(v); else ranOut.add(v); });
  $('mdTweaks').value = '';
  showScreen('scr-made');
  $('scr-made').querySelector('.scroll').scrollTop = 0;
  arrive();
}

// Finishing the last step is the moment, so the screen marks it: the badge
// springs in, its mark draws itself and throws its sparks, and the rest of the
// page rises in behind it. Reduced motion gets the page, already there.
function arrive() {
  haptic('success');
  if (calm()) return;
  const ok = $('scr-made').querySelector('.md-ok');
  const mark = ok && ok.querySelector('path');
  if (!ok || !ok.animate) return;
  ok.animate([
    { transform: 'scale(.3)', opacity: 0 },
    { transform: 'scale(1.12)', opacity: 1, offset: 0.6 },
    { transform: 'none', opacity: 1 },
  ], { duration: 560, delay: 140, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'backwards' });
  if (mark) {
    mark.animate([{ strokeDashoffset: 24 }, { strokeDashoffset: 0 }],
      { duration: 340, delay: 420, easing: 'ease-out', fill: 'backwards' });
  }
  setTimeout(() => burst(ok, { r: 46, n: 8, size: 6, ring: 1.5 }), 470);
  [...$('scr-made').querySelectorAll('.md-in > :not(.md-ok)')].forEach((el, i) => el.animate([
    { opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' },
  ], { duration: 380, delay: 300 + Math.min(i, 6) * 55, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }));
}

// Done answers where you tapped it — it fills sage and says Saved — and then
// the screen goes back to the list, where the Done together count takes it.
// That replaced a "Made it · Nov 17" toast: the feedback should be the thing.
// The POST goes at once; the moment runs beside it, never in front of it.
async function madeIt() {
  const it = itemNow();
  if (!it) return;
  const btn = $('mdDone');
  btn.disabled = true;
  haptic('success');
  const sent = post(`/api/item/${it.id}/cooked`, { again, tweaks: $('mdTweaks').value });
  btn.classList.add('saved');
  btn.innerHTML = `${icon('check', 20)}Saved`;
  const shown = calm() ? Promise.resolve() : new Promise(r => setTimeout(r, 600));
  try {
    const b = await sent;
    applyWire(b.state);
    // What ran out goes on the list to buy — it is Out in that kitchen.
    for (const name of ranOut) { try { await setPantry(kitchen, name, 'out'); } catch (_) {} }
    forget(it.id);
    for (const [k, t] of timers) if (t.itemId === it.id) { if (t.serverId) del(`/api/timer/${t.serverId}`).catch(() => {}); timers.delete(k); }
    await shown;
    showScreen('scr-space');
    await refresh();
    changed();
    doneLanded();
  } catch (_) { toast('Could not save that'); }
  btn.disabled = false;
  btn.classList.remove('saved');
  btn.textContent = 'Done';
}

export function initCook() {
  $('ckClose').addEventListener('click', leaveCook);
  $('ckBack').addEventListener('click', () => go(step - 1));
  $('ckNext').addEventListener('click', () => {
    const r = recipeNow();
    if (r && step >= r.steps.length - 1) openMade(); else go(step + 1);
  });
  $('mdClose').addEventListener('click', () => { showScreen('scr-cook'); paint(); holdScreen(); });
  $('mdDone').addEventListener('click', madeIt);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && $('scr-cook').classList.contains('active')) { holdScreen(); presence(true); }
  });
}
