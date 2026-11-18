// Just us — the pleasure inventory, opened from the rose in a pair list.
//
// Everything about who sees what is decided on the server (lib/pleasure.js);
// this draws what came back. The partner's "things to try" answers are never
// sent here except as MATCHES, so there is nothing to hide client-side — and
// nothing here may ever ask for more.
//
// Five screens, all in one sheet:
//   · the FRONT DOOR — the count of what you both want, and doors in. It names
//     nothing: a phone gets glanced at, and this is what is open when it is.
//     The rose opens here every time, never straight onto the matches.
//   · Body — points on a figure that glow with how much you like it there,
//     Together / Yours / theirs, and a row of five tiles per act.
//   · Things to try — a deck, one card at a time, with Back and Not now.
//   · You both want — the matches, grouped by how keen, and Pick one for us.
//   · All answers — every try answer, by group, to change.
//
// One colour ramp throughout, cool (No) to warm (Yes, please): `--rose-cool`
// to `--rose`. `--accent` appears nowhere in the room.
import { S } from './state.js';
import { $, esc, toast, openSheet, closeSheet } from './util.js';
import { haptic } from './motion.js';
import { get, post } from './api.js';

let data = null;          // last answer from the server
let view = 'door';        // 'door' | 'body' | 'try' | 'both' | 'list'
let bodyView = 'together';// 'together' | 'mine' | 'theirs'
let side = 'front';       // 'front' | 'back'
let part = 'neck';        // the part the body panel shows — never none
let fresh = new Set();    // matches not seen before this opening — marked "new"
const skipped = new Set();// Not now, this sitting
let history = [];         // card ids answered this sitting, for Back
let revisit = null;       // a card brought back by Back, answer showing
let picked = null;        // Pick one for us — on this device, never stored or sent
let busy = false;

const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const lvl = (id) => data.levels.find(l => l.id === id);
// Warmth, 0 (No) → 1 (Yes, please). Heat is the average of these.
const WARM = { love: 1, yes: 0.78, maybe: 0.5, soft: 0.2, no: 0 };
const warm = (w) => `color-mix(in oklab, var(--rose) ${Math.round(w * 100)}%, var(--rose-cool))`;
const COOL_TO_WARM = ['no', 'soft', 'maybe', 'yes', 'love'];
const allTry = () => [...data.try, ...data.custom];
const tryLabel = (id) => (allTry().find(t => t.id === id) || {}).label || '';
const partLabel = (id) => (data.parts.find(p => p.id === id) || {}).label || id;
const scroller = () => $('roseSheet').querySelector('.modal-in');
const initial = () => esc(String(data.partner || '?').trim().charAt(0).toUpperCase() || '?');

const svg = (d, size = 22, sw = 1.8) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
  stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ROSE_D = '<path d="M7 5.2c0 3.3 2.2 5.8 5 5.8s5-2.5 5-5.8c-1.4.9-2.7.9-3.6 0-.6-.6-1-1.5-1.4-2.7-.4 1.2-.8 2.1-1.4 2.7-.9.9-2.2.9-3.6 0z"/><path d="M9.8 6.9c.6.8 1.4 1.2 2.2 1.2s1.6-.4 2.2-1.2"/><path d="M12 11v10"/><path d="M12 16.2c-1.9-.2-3.5-1.3-4.1-3.2 2 0 3.5 1 4.1 3.2z"/><path d="M12 18.6c1.9-.2 3.5-1.3 4.1-3.2-2 0-3.5 1-4.1 3.2z"/>';
const I = {
  rose: (s = 44) => svg(ROSE_D, s, 1.6),
  body: svg('<circle cx="12" cy="5" r="2.4"/><path d="M9 9.2h6l-.8 6.2H9.8zM10 15.4 9.4 21M14 15.4l.6 5.6M8.6 10.5 7 14M15.4 10.5 17 14"/>'),
  cards: svg('<rect x="7" y="4.5" width="12" height="15" rx="2.4"/><path d="M4.6 7.4v10.4a2.2 2.2 0 0 0 2.2 2.2"/>'),
  ask: svg('<path d="M5 17.6V7.4A2.4 2.4 0 0 1 7.4 5h9.2A2.4 2.4 0 0 1 19 7.4v6.4a2.4 2.4 0 0 1-2.4 2.4H9z"/>'),
  chev: svg('<path d="M9 5.5l6.5 6.5L9 18.5"/>', 20, 2),
  back: svg('<path d="m15 18-6-6 6-6"/>', 20, 2.2),
  lock: svg('<rect x="5.6" y="10.6" width="12.8" height="9.4" rx="2.2"/><path d="M8.6 10.6V8.2a3.4 3.4 0 0 1 6.8 0v2.4"/>', 18),
  shuffle: svg('<path d="M4 7h3.2c2.4 0 3.6 1.4 4.8 5s2.4 5 4.8 5H20M4 17h3.2c1.6 0 2.6-.6 3.4-1.8M13.4 8.8c.8-1.2 1.8-1.8 3.4-1.8H20M17.6 4.6 20 7l-2.4 2.4M17.6 14.6 20 17l-2.4 2.4"/>', 20),
  undo: svg('<path d="M9 14 4.5 9.5 9 5"/><path d="M4.8 9.5H14a5.5 5.5 0 0 1 0 11h-3"/>', 20),
  plus: svg('<path d="M12 5.5v13M5.5 12h13"/>', 22, 2.2),
};

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

/* ── the front door ──────────────────────────────────────────────────────── */

// Counts and doors. NOT ONE label of a thing to try or a part of the body: the
// suite asserts that on the open sheet's text.
function doorHtml() {
  const n = data.matches.length;
  const nNew = data.matches.filter(m => fresh.has(m.id)).length;
  const parts = data.parts.filter(p => Object.keys(data.mine.body[p.id] || {}).length).length;
  const total = allTry().length;
  const done = allTry().filter(t => data.mine.try[t.id]).length;
  return `<button type="button" class="rs-matches" data-go="both" aria-label="${n} things you both want${nNew ? `, ${nNew} new` : ''}">
      ${nNew ? `<em class="rs-new">${nNew} new</em>` : ''}
      <span class="rs-rose">${I.rose(44)}</span>
      <b class="rs-n">${n}</b>
      <span>${n ? (n === 1 ? 'thing you both want' : 'things you both want') : 'Anything you both lean yes to shows up here'}</span>
    </button>
    <button type="button" class="rs-door" data-rs="body"><i>${I.body}</i>
      <span><b>Body</b><small>Where each of you likes it · ${parts} of ${data.parts.length} places</small></span>${I.chev}</button>
    <button type="button" class="rs-door" data-rs="try"><i>${I.cards}</i>
      <span><b>Things to try</b><small>${done} of ${total} answered${total - done ? ` · ${total - done} left` : ''}</small></span>
      <span class="rs-ring" style="--p:${Math.round((done / Math.max(total, 1)) * 100)}%" aria-hidden="true"></span>${I.chev}</button>
    <button type="button" class="rs-door" data-rs="ask"><i>${I.ask}</i>
      <span><b>Ask your own</b><small>A question for the two of you</small></span>${I.chev}</button>
    <p class="rs-lock">${I.lock}<span>Only the two of you can open this. Things to try show up only when you both lean yes,
      so a no never gives anything away.</span></p>`;
}

/* ── body ────────────────────────────────────────────────────────────────── */

// The figure, in a 200×420 box: one fill, no outline. Points are real buttons
// laid over it, so each has a label and takes focus.
const FIGURE = `<svg viewBox="0 0 200 420" aria-hidden="true" class="rs-figsvg">
  <ellipse cx="100" cy="44" rx="24" ry="29"/><rect x="90" y="66" width="20" height="24" rx="7"/>
  <path d="M62 98 Q60 88 74 86 L126 86 Q140 88 138 98 L132 150 Q127 178 134 208 L140 234 Q100 250 60 234 L66 208 Q73 178 68 150 Z"/>
  <g class="limb"><polyline points="57,100 49,160 43,214" stroke-width="15"/><polyline points="143,100 151,160 157,214" stroke-width="15"/>
  <polyline points="85,238 83,318" stroke-width="30"/><polyline points="115,238 117,318" stroke-width="30"/>
  <polyline points="83,318 83,394" stroke-width="21"/><polyline points="117,318 117,394" stroke-width="21"/></g>
  <circle cx="41" cy="226" r="9"/><circle cx="159" cy="226" r="9"/>
  <ellipse cx="82" cy="404" rx="13" ry="7"/><ellipse cx="118" cy="404" rx="13" ry="7"/></svg>`;
const POINTS = {
  front: [['hair', 100, 18], ['ears', 76, 44], ['ears', 124, 44], ['lips', 100, 58], ['neck', 100, 80],
    ['shoulders', 68, 96], ['shoulders', 132, 96], ['chest', 100, 106], ['nipples', 85, 124], ['nipples', 115, 124],
    ['stomach', 100, 172], ['hips', 70, 214], ['hips', 130, 214], ['genitals', 100, 238], ['thighs', 91, 274],
    ['thighs', 109, 274], ['hands', 41, 226], ['hands', 159, 226], ['feet', 82, 404], ['feet', 118, 404]],
  back: [['hair', 100, 30], ['ears', 76, 46], ['ears', 124, 46], ['neck', 100, 80], ['shoulders', 68, 96],
    ['shoulders', 132, 96], ['back', 100, 150], ['butt', 86, 240], ['butt', 114, 240], ['hands', 41, 226],
    ['hands', 159, 226], ['feet', 82, 404], ['feet', 118, 404]],
};

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
// Together: both sides; Yours or theirs: that side alone.
function heatOf(p, which = 'together') {
  const mine = data.mine.body[p] || {}, theirs = data.theirs.body[p] || {};
  const pick = which === 'mine' ? [mine] : which === 'theirs' ? [theirs] : [mine, theirs];
  const heat = avg(pick.flatMap(o => Object.values(o)).map(v => WARM[v]).filter(v => v !== undefined));
  const both = Object.keys(mine).some(a => ['love', 'yes'].includes(mine[a]) && ['love', 'yes'].includes(theirs[a]));
  return { heat, both };
}

function bodyHtml() {
  const partner = esc(data.partner);
  const seg = [['together', 'Together'], ['mine', 'Yours'], ['theirs', `${partner}’s`]];
  const points = POINTS[side].map(([p, x, y]) => {
    const { heat, both } = heatOf(p, bodyView);
    const h = heat === null ? 0 : heat;
    const label = `${partLabel(p)}, ${heat === null ? 'not answered yet' : 'answered'}`;
    return `<button type="button" class="pt${heat === null ? '' : ' ans'}${both && bodyView === 'together' ? ' both' : ''}${p === part ? ' sel' : ''}"
      data-part="${p}" aria-label="${esc(label)}" aria-pressed="${p === part}"
      style="left:${(x / 200) * 100}%;top:${(y / 420) * 100}%;--c:${warm(h)};--g:${Math.round(24 + 22 * h)}px;--o:${(0.3 + 0.6 * h).toFixed(2)}">
      <i class="glow"></i><i class="dot"></i></button>`;
  }).join('');
  const mine = data.mine.body[part] || {}, theirs = data.theirs.body[part] || {};
  const rows = data.acts.map((a) => {
    const my = mine[a.id], th = theirs[a.id];
    return `<div class="rs-act">
      <div class="rs-act-hd"><b>${esc(a.label)}</b>${my
        ? `<span style="color:${warm(WARM[my])}">You: ${esc(lvl(my).label)}</span>` : '<span class="none">Not answered</span>'}</div>
      ${tiles(`data-kind="body" data-act="${a.id}"`, my, th, a.label)}</div>`;
  }).join('');
  return `<h2 class="rs-h">Body</h2>
    <div class="rs-seg3" role="radiogroup" aria-label="Whose answers">${seg.map(([id, l]) =>
      `<button type="button" role="radio" aria-checked="${bodyView === id}" class="${bodyView === id ? 'on' : ''}" data-view="${id}">${l}</button>`).join('')}</div>
    <div class="rs-stage">
      <div class="rs-figure">${FIGURE}${points}</div>
      <div class="rs-side" role="radiogroup" aria-label="Which side">${['front', 'back'].map(sd =>
        `<button type="button" role="radio" aria-checked="${side === sd}" class="${side === sd ? 'on' : ''}" data-side="${sd}">${sd === 'front' ? 'Front' : 'Back'}</button>`).join('')}</div>
      <div class="rs-scale" aria-hidden="true"><i></i><span>No</span><span>Yes</span></div>
    </div>
    <div class="rs-panel" id="rsPanel">
      <div class="rs-panel-hd"><b>${esc(partLabel(part))}</b><span><i class="badge">${initial()}</i>${partner}’s answer</span></div>
      <div class="rs-legend"><span>← No</span><span>Yes, please →</span></div>
      ${rows}
    </div>
    <p class="rs-note">${partner} sees your answers here, and you see ${partner}’s. That’s the point of this half:
      “this, not that.” Tap your answer again to take it back.</p>`;
}

// Five tiles, cool → warm, left to right — a scale, not a form. Yours is filled
// with a ring; theirs (body only) is their initial on the top edge of its tile.
function tiles(attrs, cur, theirs, what) {
  return `<div class="rs-tiles" role="radiogroup" aria-label="${esc(what)}">${COOL_TO_WARM.map((id) => {
    const l = lvl(id);
    const th = theirs === id;
    return `<button type="button" role="radio" aria-checked="${cur === id}" class="tile${cur === id ? ' on' : ''}" ${attrs}
      data-level="${id}" style="--c:${warm(WARM[id])}"
      aria-label="${esc(`${l.label}${th ? ` (${data.partner}’s answer)` : ''}`)}">${th ? `<i class="badge">${initial()}</i>` : ''}</button>`;
  }).join('')}</div>`;
}

/* ── things to try ───────────────────────────────────────────────────────── */

function queue() {
  const un = allTry().filter(t => !data.mine.try[t.id]);
  const q = [...un.filter(t => !skipped.has(t.id)), ...un.filter(t => skipped.has(t.id))];
  const back = revisit && allTry().find(t => t.id === revisit);
  return back ? [back, ...q.filter(t => t.id !== revisit)] : q;
}
const groupLabel = (g) => (data.groups.find(x => x.id === g) || {}).label || '';

function tryHtml() {
  const all = allTry(), done = all.filter(t => data.mine.try[t.id]).length, q = queue();
  const head = `<div class="rs-titlerow"><h2 class="rs-h">Things to try</h2>
      <button type="button" class="rs-link" data-mode="list">All answers</button></div>
    <div class="rs-prog"><span>${done} of ${all.length} answered</span><span>${all.length - done} left</span>
      <i><b style="width:${Math.round((done / Math.max(all.length, 1)) * 100)}%"></b></i></div>`;
  if (!q.length) {
    return head + `<div class="rs-end">${I.rose(64)}<b>That’s all of them</b>
      <p>You can change any answer from the list, or ask something of your own.</p>
      <button type="button" class="rs-btn" data-go="both">See what you both want</button></div>`;
  }
  const t = q[0];
  const inGroup = all.filter(x => x.group === t.group);
  const cur = data.mine.try[t.id] || null;     // only a card brought back by Back has one
  return head + `<div class="rs-deck"><i class="peek p2"></i><i class="peek p1"></i>
      <div class="rs-card" id="rsCard" data-id="${esc(t.id)}">
        <small class="rs-chip">${esc(groupLabel(t.group))} · ${inGroup.indexOf(t) + 1} of ${inGroup.length}</small>
        <b>${esc(t.label)}</b>
        <span class="rs-cardfoot">${esc(data.partner)} only finds out if you both lean yes.</span>
      </div></div>
    <div class="rs-bubbles" role="radiogroup" aria-label="${esc(t.label)}">${COOL_TO_WARM.map((id) => {
      const w = WARM[id];
      return `<button type="button" role="radio" aria-checked="${cur === id}" class="${cur === id ? 'on' : ''}"
        data-kind="try" data-id="${esc(t.id)}" data-level="${id}"
        style="--c:${warm(w)};--s:${Math.round(34 + 14 * w)}px;--f:${(0.35 + 0.5 * w).toFixed(2)}"><i></i><span>${esc(lvl(id).label)}</span></button>`;
    }).join('')}</div>
    <div class="rs-hints" aria-hidden="true"><span>← swipe for no</span><span>↑ maybe</span><span>yes →</span></div>
    <div class="rs-foot">${history.length ? `<button type="button" data-back>${I.undo}Back</button>` : '<span></span>'}
      <button type="button" data-skip="${esc(t.id)}">Not now</button></div>`;
}

// Every answer, by group, to change. No partner badge: their answers to these
// are never sent, and must not be. Opening this marks nothing seen.
function listHtml() {
  const sections = data.groups.map((g) => {
    const ts = allTry().filter(t => t.group === g.id);
    if (!ts.length) return '';
    return `<h3 class="rs-sec">${esc(g.label)}</h3><div class="rs-box">${ts.map((t) => {
      const my = data.mine.try[t.id];
      // Named in words, not only a filled tile: nothing here is told by colour alone.
      return `<div class="rs-act">
        <div class="rs-act-hd"><b>${esc(t.label)}</b>${my
          ? `<span style="color:${warm(WARM[my])}">You: ${esc(lvl(my).label)}</span>` : '<span class="none">Not answered</span>'}</div>
        ${tiles(`data-kind="try" data-id="${esc(t.id)}"`, my, null, t.label)}
        ${t.byMe ? `<button type="button" class="rs-take" data-remove="${esc(t.id)}">Take back this question</button>` : ''}</div>`;
    }).join('')}</div>`;
  }).join('');
  return `<h2 class="rs-h">All answers</h2>${sections}`;
}

/* ── you both want ───────────────────────────────────────────────────────── */

function bothHtml() {
  const n = data.matches.length;
  const ask = `<div class="rs-ask"><input id="rsNew" type="text" maxlength="80" placeholder="Something you’d like to try" aria-label="Ask your own">
      <button type="button" id="rsAdd" aria-label="Add it">${I.plus}</button></div>
    <p class="rs-note">${esc(data.partner)} sees the question, not who asked it. It shows up here only if you both
      lean yes, and only you can take it back.</p>`;
  if (!n) {
    return `<h2 class="rs-h">You both want</h2>
      <p class="rs-note">Anything you both say yes or maybe to shows up here. ${esc(data.partner)} never sees your no’s,
        and only sees a yes once theirs matches it.</p>${ask}`;
  }
  const hot = ['yes', 'love'];
  const groups = [
    ['You both said “yes, please”', 'g1', data.matches.filter(m => m.mine === 'love' && m.theirs === 'love')],
    ['You both said yes', 'g2', data.matches.filter(m => hot.includes(m.mine) && hot.includes(m.theirs) && !(m.mine === 'love' && m.theirs === 'love'))],
    ['One of you said maybe', 'g3', data.matches.filter(m => !(hot.includes(m.mine) && hot.includes(m.theirs)))],
  ];
  const sub = (m) => (m.mine === 'maybe' && m.theirs === 'maybe' ? 'Both of you: maybe'
    : m.mine === 'maybe' ? 'You: maybe' : `${data.partner}: maybe`);
  const pick = picked && data.matches.find(m => m.id === picked);
  return `<h2 class="rs-h">You both want <span>${n}</span></h2>
    <div class="rs-pick">${pick ? `<small>How about</small><b>${esc(tryLabel(pick.id))}</b>`
      : '<p>Can’t choose? Let it pick one of these for you.</p>'}
      <button type="button" class="rs-btn" data-pick>${I.shuffle}${pick ? 'Another' : 'Pick one for us'}</button></div>
    ${groups.filter(([, , ms]) => ms.length).map(([label, cls, ms]) => `<h3 class="rs-sec ${cls}">${label} · ${ms.length}</h3>
      <div class="rs-box">${ms.map(m => `<div class="rs-match${fresh.has(m.id) ? ' new' : ''}"><span><b>${esc(tryLabel(m.id))}</b>${
        cls === 'g3' ? `<small>${esc(sub(m))}</small>` : ''}</span>${fresh.has(m.id) ? '<em>New</em>' : ''}</div>`).join('')}</div>`).join('')}
    ${ask}`;
}

/* ── painting ────────────────────────────────────────────────────────────── */

function head() {
  if (view === 'door') {
    return `<b class="rs-title">Just us</b><span>with ${esc(data.partner)} · only the two of you</span>`;
  }
  const to = view === 'list' ? 'try' : 'door';
  return `<button type="button" class="rs-backpill" data-rs="${to}">${I.back}<span>${to === 'door' ? 'Just us' : 'Things to try'}</span></button>`;
}

function paint(keepScroll = false) {
  const top = scroller().scrollTop;
  $('rsHead').innerHTML = head();
  $('rsBody').innerHTML = view === 'door' ? doorHtml() : view === 'body' ? bodyHtml()
    : view === 'try' ? tryHtml() : view === 'both' ? bothHtml() : listHtml();
  scroller().scrollTop = keepScroll ? top : 0;
  // Only "You both want" marks the matches seen — it is the screen that shows them.
  if (view === 'both') markSeen();
  bindCard();
}

function go(to) {
  if (to === 'ask') { view = 'both'; paint(); const f = $('rsNew'); if (f) f.focus(); return; }
  view = to;
  paint();
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
  // The bloom names the match: fine, the person looking is the one who answered.
  if (now) { fresh.add(now.id); bloom(tryLabel(now.id)); }
  return true;
}

async function answer(btn) {
  const kind = btn.dataset.kind, lv = btn.dataset.level;
  haptic('tick');
  // On the deck: the card flies off toward its answer, and the next one comes.
  if (kind === 'try' && view === 'try' && $('rsCard')) {
    return fling(lv, WARM[lv] >= 0.5 ? (lv === 'maybe' ? 0 : 1) : -1, lv === 'maybe' ? -1 : 0);
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
  haptic('tick');
  if (!calm()) {
    c.style.transition = 'transform .24s ease-in, opacity .24s ease-in';
    c.style.transform = `translate(${dx * 420}px, ${dy * 420}px) rotate(${dx * 14}deg)`;
    c.style.opacity = '0';
  }
  const [ok] = await Promise.all([
    send({ kind: 'try', id, level }),
    new Promise(r => setTimeout(r, calm() ? 0 : 240)),
  ]);
  if (ok) {
    skipped.delete(id);
    if (revisit === id) revisit = null;
    history.push(id);
  }
  paint();
  const next = $('rsCard');
  if (ok && next && !calm()) next.animate([{ transform: 'scale(.94)', opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 220, easing: 'cubic-bezier(.2,.8,.3,1.2)' });
}

// Back: the last card answered in this sitting, with its answer showing.
// Answering it again replaces it. It never shows anything the queue would not.
function back() {
  const id = history.pop();
  if (!id) return;
  revisit = id;
  paint();
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
    const lean = dx > 50 ? 'yes' : dx < -50 ? 'no' : dy < -50 ? 'maybe' : '';
    // A small click under the thumb as the card starts to lean somewhere.
    if (lean && lean !== c.dataset.lean) haptic('snap');
    c.dataset.lean = lean;
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

// Pick one for us: random, never the same twice running, on this device only.
function pickOne() {
  const ms = data.matches;
  if (!ms.length) return;
  const pool = ms.length > 1 ? ms.filter(m => m.id !== picked) : ms;
  picked = pool[Math.floor(Math.random() * pool.length)].id;
  haptic('tick');
  paint(true);
}

/* ── a match is a moment ─────────────────────────────────────────────────── */

function bloom(label) {
  const el = document.createElement('div');
  el.className = 'rs-bloom';
  haptic('success');
  el.innerHTML = `<div>${I.rose(96)}<b>You both want</b><span>${esc(label)}</span></div>`;
  el.addEventListener('click', () => el.remove());
  $('roseSheet').appendChild(el);
  setTimeout(() => el.remove(), calm() ? 1600 : 2200);
}

/* ── opening ─────────────────────────────────────────────────────────────── */

// Always onto the front door — never straight onto the matches, which would
// put names on screen the moment the sheet opens. The "new" chip invites.
export async function openRose() {
  if (!S.space || !S.space.isPair) return;
  try {
    data = await get(`/api/space/${S.spaceId}/pleasure`);
  } catch (_) { return toast('Could not open that'); }
  const seen = seenSet();
  fresh = new Set(data.matches.filter(m => !seen.has(m.id)).map(m => m.id));
  view = 'door';
  bodyView = 'together';
  side = 'front';
  part = 'neck';
  history = [];
  revisit = null;
  picked = null;
  openSheet('roseSheet');
  paint();
}

async function addOwn() {
  const input = $('rsNew');
  const label = input.value.trim();
  if (!label) return;
  if (await send({ kind: 'custom-add', label })) { paint(true); toast('Added to things to try'); }
  else toast('Already on the list, or too many of your own');
}

export function initRose() {
  $('rsClose').addEventListener('click', () => { closeSheet('roseSheet'); paintDot(); });
  $('roseSheet').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'rsNew') addOwn();
  });
  $('roseSheet').addEventListener('click', async (e) => {
    if (e.target === $('roseSheet')) { closeSheet('roseSheet'); return paintDot(); }
    const t = e.target.closest('[data-rs],[data-go],[data-view],[data-side],[data-part],[data-level],[data-mode],[data-skip],[data-back],[data-pick],[data-remove],#rsAdd');
    if (!t || !data) return;
    if (t.dataset.rs) return go(t.dataset.rs);
    if (t.dataset.go) return go(t.dataset.go);
    if (t.dataset.mode) return go('list');
    if (t.dataset.view) { bodyView = t.dataset.view; return paint(true); }
    if (t.dataset.side) { side = t.dataset.side; return paint(true); }
    if (t.dataset.part) {
      part = t.dataset.part;
      paint(true);
      const p = $('rsPanel');
      if (p) p.scrollIntoView({ block: 'nearest', behavior: calm() ? 'auto' : 'smooth' });
      return;
    }
    if (t.dataset.level) return answer(t);
    if (t.dataset.skip) { skipped.add(t.dataset.skip); if (revisit === t.dataset.skip) revisit = null; return paint(); }
    if (t.hasAttribute('data-back')) return back();
    if (t.hasAttribute('data-pick')) return pickOne();
    if (t.dataset.remove) { if (await send({ kind: 'custom-remove', id: t.dataset.remove })) paint(true); return; }
    if (t.id === 'rsAdd') return addOwn();
  });
}
