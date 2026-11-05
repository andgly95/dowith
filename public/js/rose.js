// Just us — the pleasure inventory sheet, opened from the rose in a pair list.
//
// Everything about who sees what is decided on the server (lib/pleasure.js);
// this draws what came back. The partner's "things to try" answers are never
// sent here at all, only the matches, so there is nothing to hide client-side.
//
// Three ways in, one scale (Yes, please → No) drawn as five dots, warm to cool:
//   · Body  — a figure, front and back, that you tap where you mean. Each area
//     warms with how much the two of you like it, so the figure IS the summary.
//   · Cards — things to try one at a time, gentlest first. Swipe or tap a dot.
//   · List  — every answer, by group, with your own questions and the matches.
import { S } from './state.js';
import { $, esc, toast, openSheet, closeSheet } from './util.js';
import { get, post } from './api.js';

let data = null;        // last answer from the server
let pane = 'body';      // 'body' | 'try'
let tryMode = 'cards';  // 'cards' | 'list'
let part = null;        // which body part is open
let fresh = new Set();  // matches not seen before this opening — marked "new"
const skipped = new Set();
let busy = false;

const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const lvl = (id) => data.levels.find(l => l.id === id);
const WARM = { love: 1, yes: 0.75, maybe: 0.45, soft: 0.15, no: 0 };
const allTry = () => [...data.try, ...data.custom];
const tryLabel = (id) => (allTry().find(t => t.id === id) || {}).label || '';
const scroller = () => $('roseSheet').querySelector('.modal-in');

/* ── which matches you have seen — per device, a convenience ─────────────── */

const seenKey = () => `dw-rose-seen-${S.spaceId}`;
function seenSet() {
  try { return new Set(JSON.parse(localStorage.getItem(seenKey()) || '[]')); } catch (_) { return new Set(); }
}
function markSeen() {
  if (!data) return;
  try { localStorage.setItem(seenKey(), JSON.stringify(data.matches.map(m => m.id))); } catch (_) {}
  paintDot();
}
function paintDot() {
  const s = seenSet();
  $('spaceRose').classList.toggle('fresh', !!(data && data.matches.some(m => !s.has(m.id))));
}

// On opening a pair list: is there a match you have not seen? Only a dot on the
// rose — never a notification, so nothing of this reaches a lock screen.
export async function peekRose() {
  const id = S.spaceId;
  $('spaceRose').classList.remove('fresh');
  if (!S.space || !S.space.isPair) return;
  try {
    const d = await get(`/api/space/${id}/pleasure`);
    if (S.spaceId !== id) return;
    data = d;
    paintDot();
  } catch (_) {}
}

/* ── the five-dot scale ──────────────────────────────────────────────────── */

// `theirs` draws a ring on the dot your partner chose (body answers only).
// Drawn cool → warm, left to right, so a dot and a swipe agree: yes is RIGHT.
function dots(attrs, cur, theirs) {
  const L = [...data.levels].reverse();
  const i = L.findIndex(l => l.id === cur);
  const edge = (k) => (k === 0 ? 'l' : k === L.length - 1 ? 'r' : '');
  return `<div class="rs-dots" role="radiogroup">${L.map(l =>
    `<button type="button" role="radio" aria-checked="${cur === l.id}" aria-label="${esc(l.label)}"
      class="d d-${l.id}${cur === l.id ? ' on' : ''}${theirs === l.id ? ' th' : ''}" ${attrs}
      data-level="${l.id}"><i></i></button>`).join('')}</div>
    <div class="rs-dl">${i >= 0
      ? `<span style="grid-column:${i + 1}" class="${edge(i)}">${esc(L[i].label)}</span>`
      : `<span class="end l" style="grid-column:1">${esc(L[0].label)}</span>
         <span class="end r" style="grid-column:${L.length}">${esc(L[L.length - 1].label)}</span>`}</div>`;
}

/* ── the body ────────────────────────────────────────────────────────────── */

// Drawn to a 120×262 box. Neutral shapes are the body; zones are what you tap.
// Small zones (lips, ears, nipples, genitals) carry a larger invisible hit area,
// because a 5px target on a phone is a target nobody can hit.
const ARMS = `<line x1="33" y1="62" x2="25" y2="139"/><line x1="87" y1="62" x2="95" y2="139"/>`;
const SHINS = `<line x1="48" y1="202" x2="48" y2="243"/><line x1="72" y1="202" x2="72" y2="243"/>`;
const EARS = `<ellipse class="z" cx="44.5" cy="25" rx="2.6" ry="5"/><ellipse class="z" cx="75.5" cy="25" rx="2.6" ry="5"/>
  <circle class="hit" cx="44" cy="25" r="6"/><circle class="hit" cx="76" cy="25" r="6"/>`;
const NECK = `<rect class="z" x="54" y="40" width="12" height="12" rx="3"/>`;
const SHOULDERS = `<ellipse class="z" cx="37" cy="60" rx="9" ry="6.5"/><ellipse class="z" cx="83" cy="60" rx="9" ry="6.5"/>`;
const HANDS = `<circle class="z" cx="24" cy="147" r="6.5"/><circle class="z" cx="96" cy="147" r="6.5"/>`;
const FEET = `<ellipse class="z" cx="47" cy="250" rx="8" ry="5"/><ellipse class="z" cx="73" cy="250" rx="8" ry="5"/>`;

const FRONT = [
  [null, `<ellipse cx="60" cy="24" rx="15" ry="18"/>`],
  ['lips', `<ellipse class="z" cx="60" cy="33" rx="5" ry="2.4"/><circle class="hit" cx="60" cy="33" r="7"/>`],
  ['ears', EARS], ['neck', NECK], ['shoulders', SHOULDERS],
  ['chest', `<path class="z" d="M42 56Q60 51 78 56L80 90H40Z"/>`],
  ['nipples', `<circle class="z" cx="51" cy="76" r="2.6"/><circle class="z" cx="69" cy="76" r="2.6"/>
    <circle class="hit" cx="51" cy="76" r="6.5"/><circle class="hit" cx="69" cy="76" r="6.5"/>`],
  ['stomach', `<path class="z" d="M40 92H80L78 120H42Z"/>`],
  ['hips', `<path class="z" d="M42 122H78L83 140H37Z"/>`],
  ['thighs', `<path class="z" d="M37 142H58L56 199H41Z"/><path class="z" d="M62 142H83L79 199H64Z"/>`],
  ['genitals', `<path class="z" d="M53 137H67L60 151Z"/><circle class="hit" cx="60" cy="142" r="8"/>`],
  ['hands', HANDS], ['feet', FEET],
];
const BACK = [
  ['hair', `<ellipse class="z" cx="60" cy="24" rx="15" ry="18"/>`],
  ['ears', EARS], ['neck', NECK], ['shoulders', SHOULDERS],
  ['back', `<path class="z" d="M42 56Q60 51 78 56L80 90L78 121H42L40 90Z"/>`],
  ['butt', `<path class="z" d="M38 123Q60 118 82 123L84 149Q72 157 60 149Q48 157 36 149Z"/>`],
  [null, `<path d="M37 152H58L56 199H41Z"/><path d="M62 152H83L79 199H64Z"/>`],
  ['hands', HANDS], ['feet', FEET],
];

function heatOf(p) {
  const mine = data.mine.body[p] || {}, theirs = data.theirs.body[p] || {};
  const vals = [...Object.values(mine), ...Object.values(theirs)].map(v => WARM[v]);
  const both = Object.keys(mine).some(a => ['love', 'yes'].includes(mine[a]) && ['love', 'yes'].includes(theirs[a]));
  return { heat: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, both };
}

function figure(zones, label) {
  const name = (id) => (data.parts.find(p => p.id === id) || {}).label || id;
  return `<figure class="rs-fig"><svg viewBox="0 0 120 262" aria-label="${label}">
    <g class="base">${ARMS}${SHINS}</g>
    ${zones.map(([p, shape]) => {
      if (!p) return `<g class="base">${shape}</g>`;
      const { heat, both } = heatOf(p);
      return `<g class="zone${heat !== null ? ' ans' : ''}${both ? ' both' : ''}${p === part ? ' sel' : ''}"
        data-part="${p}" role="button" tabindex="0" aria-label="${esc(name(p))}"
        style="--heat:${heat === null ? 0 : heat.toFixed(2)}">${shape}</g>`;
    }).join('')}
  </svg><figcaption>${label}</figcaption></figure>`;
}

function bodyHtml() {
  let detail = `<p class="rs-note">Tap anywhere on the body. ${esc(data.partner)} sees these answers,
    and you see theirs. The warmer it glows, the more the two of you like it there.</p>`;
  if (part) {
    const p = data.parts.find(x => x.id === part);
    const mine = data.mine.body[part] || {}, theirs = data.theirs.body[part] || {};
    detail = `<div class="month">${esc(p.label)}</div>` + data.acts.map(a => {
      const th = theirs[a.id];
      return `<div class="rs-row"><div class="rs-q"><b>${esc(a.label)}</b>${
        th ? `<small>${esc(data.partner)}: <em class="lv-${th}">${esc(lvl(th).label)}</em></small>` : ''}</div>
        ${dots(`data-kind="body" data-act="${a.id}"`, mine[a.id], th)}</div>`;
    }).join('');
  }
  return `<div class="rs-figs">${figure(FRONT, 'Front')}${figure(BACK, 'Back')}</div>${detail}`;
}

/* ── things to try ───────────────────────────────────────────────────────── */

function matchesHtml() {
  if (!data.matches.length) {
    return `<p class="rs-note">Anything you both say yes or maybe to shows up here.
      ${esc(data.partner)} never sees your no's, and only sees a yes once theirs matches it.</p>`;
  }
  return `<div class="month">You both want</div>${data.matches.map(m =>
    `<div class="rs-match${fresh.has(m.id) ? ' new' : ''}"><b>${esc(tryLabel(m.id))}</b><small>you: ${
      esc(lvl(m.mine).label)} · ${esc(data.partner)}: ${esc(lvl(m.theirs).label)}</small></div>`).join('')}`;
}

function queue() {
  const un = allTry().filter(t => !data.mine.try[t.id]);
  return [...un.filter(t => !skipped.has(t.id)), ...un.filter(t => skipped.has(t.id))];
}
const groupLabel = (g) => (data.groups.find(x => x.id === g) || {}).label || '';

function cardsHtml() {
  const all = allTry(), q = queue(), done = all.length - q.length;
  const link = data.matches.length
    ? `<button type="button" class="rs-mlink" data-mode="list">You both want ${data.matches.length} →</button>` : '';
  const prog = `<div class="rs-prog"><span>${done} of ${all.length} answered</span>${link}
    <i><b style="width:${Math.round((done / Math.max(all.length, 1)) * 100)}%"></b></i></div>`;
  if (!q.length) {
    return prog + `<div class="rs-card end"><b>That's all of them.</b>
      <p>Change anything, or add something of your own, in the list.</p>
      <button type="button" class="primary" data-mode="list">See the list</button></div>`;
  }
  const t = q[0];
  return prog + `<div class="rs-card" id="rsCard" data-id="${esc(t.id)}">
      <small>${esc(groupLabel(t.group))}</small>
      <b>${esc(t.label)}</b>
      ${dots(`data-kind="try" data-id="${esc(t.id)}"`, null)}
      <div class="rs-swipe">swipe → for yes · ← for no · ↑ for maybe</div>
    </div>
    <button type="button" class="ghost" data-skip="${esc(t.id)}">Skip for now</button>`;
}

function listHtml() {
  const rows = (t) => `<div class="rs-row"><div class="rs-q"><b>${esc(t.label)}</b>${
    t.byMe ? `<button type="button" class="rs-x" data-remove="${esc(t.id)}" aria-label="Take this question back">✕</button>` : ''}</div>
    ${dots(`data-kind="try" data-id="${esc(t.id)}"`, data.mine.try[t.id])}</div>`;
  const sections = data.groups.map(g => {
    const ts = allTry().filter(t => t.group === g.id);
    return ts.length ? `<div class="month">${esc(g.label)}</div>${ts.map(rows).join('')}` : '';
  }).join('');
  return matchesHtml() + sections + `<div class="rs-add">
      <input id="rsNew" type="text" maxlength="80" placeholder="Add something of your own…">
      <button type="button" class="primary" id="rsAdd">Add</button>
    </div>
    <p class="rs-note small">${esc(data.partner)} will see the question, never your answer to it.</p>`;
}

function tryHtml() {
  return `<div class="rs-mode" role="tablist">
      <button type="button" data-mode="cards" class="${tryMode === 'cards' ? 'on' : ''}">One at a time</button>
      <button type="button" data-mode="list" class="${tryMode === 'list' ? 'on' : ''}">The list</button>
    </div>` + (tryMode === 'cards' ? cardsHtml() : listHtml());
}

/* ── painting ────────────────────────────────────────────────────────────── */

function paint(keepScroll = false) {
  const top = scroller().scrollTop;
  $('rsWho').textContent = `with ${data.partner} · only the two of you`;
  document.querySelectorAll('#roseSheet [data-rs]').forEach(b => {
    b.classList.toggle('on', b.dataset.rs === pane);
    b.setAttribute('aria-selected', b.dataset.rs === pane);
  });
  $('rsBody').innerHTML = pane === 'body' ? bodyHtml() : tryHtml();
  scroller().scrollTop = keepScroll ? top : 0;
  if (pane === 'try' && tryMode === 'list') markSeen();
  bindCard();
}

/* ── answering ───────────────────────────────────────────────────────────── */

async function send(body) {
  if (busy) return false;
  busy = true;
  const before = new Set(data.matches.map(m => m.id));
  try {
    data = await post(`/api/space/${S.spaceId}/pleasure`, body);
  } catch (_) { toast('Could not save that'); busy = false; return false; }
  busy = false;
  const now = data.matches.find(m => !before.has(m.id));
  if (now) { fresh.add(now.id); bloom(tryLabel(now.id)); markSeen(); }
  return true;
}

async function answerDot(btn) {
  const kind = btn.dataset.kind, lv = btn.dataset.level;
  if (kind === 'try' && tryMode === 'cards' && $('rsCard')) {
    return fling(lv, WARM[lv] >= 0.45 ? 1 : -1, 0);
  }
  // Tapping the answer you already gave takes it back.
  const cur = kind === 'body' ? (data.mine.body[part] || {})[btn.dataset.act] : data.mine.try[btn.dataset.id];
  const level = cur === lv ? null : lv;
  const ok = await send(kind === 'body'
    ? { kind, part, act: btn.dataset.act, level }
    : { kind, id: btn.dataset.id, level });
  if (ok) paint(true);
}

// Send the card off in the direction of the answer, then show the next one.
async function fling(level, dx, dy) {
  const c = $('rsCard');
  if (!c || busy) return;
  const id = c.dataset.id;
  if (!calm()) {
    c.style.transition = 'transform .24s ease-in, opacity .24s ease-in';
    c.style.transform = `translate(${dx * 420}px, ${dy * 420}px) rotate(${dx * 14}deg)`;
    c.style.opacity = '0';
  }
  const [ok] = await Promise.all([
    send({ kind: 'try', id, level }),
    new Promise(r => setTimeout(r, calm() ? 0 : 240)),
  ]);
  skipped.delete(id);
  paint();
  if (!ok) return;
  const next = $('rsCard');
  if (next && !calm()) next.animate([{ transform: 'scale(.94)', opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 220, easing: 'cubic-bezier(.2,.8,.3,1.2)' });
}

function bindCard() {
  const c = $('rsCard');
  if (!c) return;
  let x0 = 0, y0 = 0, dx = 0, dy = 0, drag = false;
  c.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    drag = true; x0 = e.clientX; y0 = e.clientY; dx = dy = 0;
    c.setPointerCapture(e.pointerId);
    c.style.transition = 'none';
  });
  c.addEventListener('pointermove', (e) => {
    if (!drag) return;
    dx = e.clientX - x0; dy = Math.min(e.clientY - y0, 0);
    c.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    c.dataset.lean = dx > 50 ? 'yes' : dx < -50 ? 'no' : dy < -50 ? 'maybe' : '';
  });
  const end = () => {
    if (!drag) return;
    drag = false;
    const lv = dx > 90 ? 'yes' : dx < -90 ? 'no' : dy < -90 ? 'maybe' : null;
    if (lv) return fling(lv, Math.sign(dx) * (lv === 'maybe' ? 0 : 1), lv === 'maybe' ? -1 : 0);
    c.style.transition = 'transform .25s cubic-bezier(.2,.8,.3,1.3)';
    c.style.transform = '';
    c.dataset.lean = '';
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}

/* ── a match is a moment ─────────────────────────────────────────────────── */

const ROSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.2c0 3.3 2.2 5.8 5 5.8s5-2.5 5-5.8c-1.4.9-2.7.9-3.6 0-.6-.6-1-1.5-1.4-2.7-.4 1.2-.8 2.1-1.4 2.7-.9.9-2.2.9-3.6 0z"/><path d="M9.8 6.9c.6.8 1.4 1.2 2.2 1.2s1.6-.4 2.2-1.2"/><path d="M12 11v10"/><path d="M12 16.2c-1.9-.2-3.5-1.3-4.1-3.2 2 0 3.5 1 4.1 3.2z"/><path d="M12 18.6c1.9-.2 3.5-1.3 4.1-3.2-2 0-3.5 1-4.1 3.2z"/></svg>`;

function bloom(label) {
  const el = document.createElement('div');
  el.className = 'rs-bloom';
  el.innerHTML = `<div>${ROSE}<b>You both want</b><span>${esc(label)}</span></div>`;
  el.addEventListener('click', () => el.remove());
  $('roseSheet').appendChild(el);
  setTimeout(() => el.remove(), calm() ? 1600 : 2200);
}

/* ── opening ─────────────────────────────────────────────────────────────── */

export async function openRose() {
  if (!S.space || !S.space.isPair) return;
  try {
    data = await get(`/api/space/${S.spaceId}/pleasure`);
  } catch (_) { return toast('Could not open that'); }
  // Something new to see? Open straight onto it, marked.
  const seen = seenSet();
  fresh = new Set(data.matches.filter(m => !seen.has(m.id)).map(m => m.id));
  part = null;
  if (fresh.size) { pane = 'try'; tryMode = 'list'; } else { pane = 'body'; tryMode = 'cards'; }
  openSheet('roseSheet');
  paint();
}

async function addOwn() {
  const input = $('rsNew');
  const label = input.value.trim();
  if (!label) return;
  if (await send({ kind: 'custom-add', label })) paint(true);
  else toast('Already on the list, or too many of your own');
}

export function initRose() {
  $('rsClose').addEventListener('click', () => { closeSheet('roseSheet'); paintDot(); });
  $('roseSheet').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'rsNew') return addOwn();
    const z = e.target.closest && e.target.closest('.zone');
    if (z && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); part = z.dataset.part; paint(true); }
  });
  $('roseSheet').addEventListener('click', async (e) => {
    if (e.target === $('roseSheet')) { closeSheet('roseSheet'); return paintDot(); }
    const t = e.target.closest('[data-rs],[data-part],[data-level],[data-mode],[data-skip],[data-remove],#rsAdd');
    if (!t) return;
    if (t.dataset.rs) { pane = t.dataset.rs; return paint(); }
    if (t.dataset.mode) { tryMode = t.dataset.mode; return paint(); }
    if (t.dataset.part) {
      part = part === t.dataset.part ? null : t.dataset.part;
      paint(true);
      // Bring the answers into view under the figure.
      if (part) { const m = $('rsBody').querySelector('.month'); if (m) m.scrollIntoView({ block: 'nearest', behavior: calm() ? 'auto' : 'smooth' }); }
      return;
    }
    if (t.dataset.level) return answerDot(t);
    if (t.dataset.skip) { skipped.add(t.dataset.skip); return paint(); }
    if (t.dataset.remove) { if (await send({ kind: 'custom-remove', id: t.dataset.remove })) paint(true); return; }
    if (t.id === 'rsAdd') return addOwn();
  });
}
