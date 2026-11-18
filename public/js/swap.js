// Swapping an ingredient, from a recipe's page: write in what you are using
// instead, or have one suggested — from everything in the kitchen, or from the
// alternatives you tick — and choose it. Nothing is saved until you choose:
// the suggest route returns a shortlist and keeps nothing (lib/swap.js).
//
// Swaps belong to the recipe, so both of you see them, and the page, cook mode
// and the kitchen check all read the line as what it now is.
import { S } from './state.js';
import { $, esc, toast, openSheet, closeSheet } from './util.js';
import { post, applyWire } from './api.js';
import { icon } from './icons.js';
import { refresh, changed } from './space.js';
import { getKitchen, addToBuy } from './kitchen.js';
import { servings, swapLine, repaintRecipe, flashLine } from './recipe.js';
import { haptic, skeleton } from './motion.js';

let st = null;   // { id, i, kitchen, picks: Set, extra: [], musts: [], res, busy, why, seq }

/* ── what it has to be ────────────────────────────────────────────────────
   "gluten free" typed into the options box is not an option to weigh — nobody
   buys a gluten free — it is a RULE every suggestion has to keep. Read as one
   here, in its usual spellings ("GF", "gluten-free", "no dairy", "must be
   vegan"), and sent apart from the options. Anything else stays an option:
   "gluten free flour" is a thing you could buy. Kept on this phone, because a
   kitchen that cooks gluten free does so every night. */
const FREE = 'gluten|wheat|dairy|lactose|milk|eggs?|nuts?|tree[ -]?nuts?|peanuts?|soy|sesame|shellfish|corn|sugar|grains?|fodmap|alcohol|caffeine';
const FREE_OF = new RegExp(`^(${FREE})[ -]?free$`);
const NO = new RegExp(`^(?:no|without|zero)\\s+(${FREE})$`);
const DIETS = { vegan: 'vegan', vegetarian: 'vegetarian', veggie: 'vegetarian', 'plant based': 'plant-based', pescatarian: 'pescatarian',
  kosher: 'kosher', halal: 'halal', keto: 'keto', paleo: 'paleo', gf: 'gluten-free', df: 'dairy-free' };
export function requirement(text) {
  const t = String(text || '').toLowerCase().replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:it\s+)?(?:must|has to|needs to|should)\s+be|make it|keep it|something|anything|only)\s+/, '')
    .replace(/[.!]+$/, '');
  const m = t.match(FREE_OF) || t.match(NO);
  if (m) return `${m[1].replace(/[ -]+/g, ' ').replace(/s$/, '')}-free`;
  const low = t.match(/^low[ -]?(sodium|salt|carb|fat|sugar|fodmap)$/);
  if (low) return `low-${low[1]}`;
  return DIETS[t.replace(/-/g, ' ')] || null;
}
const MUSTS_KEY = 'dw-swap-musts';
function savedMusts() {
  try {
    const v = JSON.parse(localStorage.getItem(MUSTS_KEY) || '[]');
    return Array.isArray(v) ? v.map(requirement).filter(Boolean).slice(0, 4) : [];
  } catch (_) { return []; }
}
function keepMusts() { try { localStorage.setItem(MUSTS_KEY, JSON.stringify(st.musts)); } catch (_) { /* this visit only */ } }
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

const itemNow = () => st && (S.items || []).find(x => x.id === st.id);
const canSuggest = () => !!(S.wire && S.wire.swap && S.wire.swap.suggest);

const FIT = { great: 'Great swap', good: 'Good swap', 'in a pinch': 'In a pinch' };
const WHY = {
  off: 'Suggestions are off on this server.',
  'slow-down': 'That’s a lot of asking for one hour. Try again in a bit, or write your own below.',
  declined: 'It wouldn’t suggest anything for this one. Write your own below.',
  busy: 'Suggestions are busy right now. Try again in a moment.',
  down: 'Couldn’t get a suggestion right now. Try again, or write your own below.',
};

export async function openSwap(id, i, kitchenId) {
  // A line that offers a choice ("gluten free flour or cornstarch") opens with
  // its options already on the table, ticked: which one is the question.
  const it = (S.items || []).find(x => x.id === id);
  const alts = (it && it.choices && it.choices[i]) || [];
  st = { id, i, kitchen: kitchenId, alts, picks: new Set(alts), extra: [...alts], musts: savedMusts(), res: null, busy: false, why: null, verdict: null, seq: 0 };
  paint();
  openSheet('swapSheet');
  $('swapSheet').querySelector('.modal-in').scrollTop = 0;
  // Fresh every time: whoever you cook with may have changed the pantry since.
  if (kitchenId) {
    try { await getKitchen(kitchenId); if (st && st.id === id && st.i === i) paint(); } catch (_) { /* no list; suggesting still works */ }
  }
}

function paint() {
  const it = itemNow();
  const r = it && it.mod && it.mod.recipe;
  const ing = r && r.ingredients[st.i];
  if (!ing) return;
  const sw = it.swaps && it.swaps[st.i];
  const sv = servings(it);
  const name = ing.name || ing.text;
  $('swTitle').textContent = st.alts.length && !sw ? 'Which one?' : `Instead of ${name}`;
  $('swSub').textContent = ing.text;

  const now = sw ? `<div class="box sw-now">
      <small>${sw.by === (S.wire.me && S.wire.me.id) ? 'You swapped it for' : sw.byName ? `${esc(sw.byName)} swapped it for` : 'Using instead'}</small>
      <b>${swapLine(ing, sw, sv)}</b>
      ${sw.note ? `<p>${esc(sw.note)}</p>` : ''}
      <button type="button" class="ghost" id="swOriginal">Use the original</button></div>` : '';

  // The recipe's own choice, to take straight away when you already know.
  const takes = st.alts.length && !sw ? `<div class="sw-takes">${st.alts.map(a => `<button type="button" class="sw-take" data-take="${esc(a)}">
      ${icon('check', 18)}<span>Use <b>${esc(a)}</b></span></button>`).join('')}</div>` : '';

  let ask = '';
  if (canSuggest()) {
    const kit = S.kitchens && S.kitchens[st.kitchen];
    const have = kit ? kit.pantry.filter(e => e.state !== 'out').map(e => e.name).sort((a, b) => a.localeCompare(b)) : [];
    // Options first (the line's own, then any you added — from home or the
    // shop), then the kitchen. One of each, whatever the case.
    const seen = new Set();
    const names = [...st.extra, ...have].filter((nm) => { const k = nm.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    const n = st.picks.size;
    const rule = st.musts.join(', ');
    ask = `<h3 class="sec">${st.alts.length ? 'Which works best here?' : 'Weighing options?'}</h3>
      <p class="sw-hint">Tick what you have, or add what you could buy — or what it has to be, like gluten-free — and it says which works best in this recipe${
        n ? '.' : '. Tick nothing and it looks through everything you have.'}</p>
      ${st.musts.length ? `<div class="chips sw-musts" role="group" aria-label="It has to be"><span>Has to be</span>${st.musts.map(m => `<button type="button"
          class="on" data-must="${esc(m)}" aria-label="${esc(cap(m))}, take it off">${esc(cap(m))}${icon('x', 15, 2)}</button>`).join('')}</div>` : ''}
      ${names.length ? `<div class="chips sw-picks" role="group" aria-label="Options">${names.map(nm => `<button type="button" data-pick="${esc(nm)}"
          class="${st.picks.has(nm) ? 'on' : ''}" aria-pressed="${st.picks.has(nm)}">${esc(nm)}</button>`).join('')}</div>`
        : `<p class="sw-hint">${kit ? 'Nothing in this kitchen yet.' : ''}</p>`}
      <form class="sw-add" id="swAdd"><input id="swExtra" type="text" maxlength="60" autocomplete="off" placeholder="Add an option, or “gluten-free”…" aria-label="Add an option, or what it has to be"></form>
      <button type="button" class="primary sw-ask" id="swAsk"${st.busy ? ' disabled' : ''}>${icon('spark', 19)}${
        n === 0 ? (rule ? `Suggest ${/^[aeiou]/.test(rule) ? 'an' : 'a'} ${esc(rule)} swap` : 'Suggest a swap') : n === 1 ? 'Will it work here?' : `Which of these ${n} works best?`}</button>
      <div class="sw-res" aria-live="polite">${results(ing, sv)}</div>`;
  } else {
    ask = `<p class="sw-hint sw-off">${esc(WHY.off)}</p>`;
  }

  $('swBody').innerHTML = `${now}${takes}${ask}
    <h3 class="sec">Your own</h3>
    <form class="sw-own" id="swOwn">
      <input id="swOwnIn" type="text" maxlength="80" autocomplete="off" placeholder="What are you using instead?" aria-label="What are you using instead">
      <button type="submit" class="primary">Use</button></form>
    <p class="sw-hint">${typeof ing.q === 'number' ? 'The same amount, unless you write one in — “½ cup oat milk”.' : 'Write it as you’d say it.'}</p>`;
  bind();
}

function results(ing, sv) {
  if (st.busy) {
    return `<p class="sw-wait">Looking at what ${esc(ing.name || 'it')} does in this recipe…</p>${skeleton(2)}`;
  }
  if (st.why) return `<p class="sw-hint">${esc(st.why === 'none' ? (st.verdict || 'Nothing it would recommend here.') : WHY[st.why] || WHY.down)}</p>`;
  if (!st.res) return '';
  return `${st.res.verdict ? `<p class="sw-verdict">${esc(st.res.verdict)}</p>` : ''}
    ${st.res.suggestions.map((s, k) => `<div class="box sw-card">
      <div class="sw-top"><b>${esc(s.name)}</b><span class="fit ${esc(s.fit.replace(/\s+/g, '-'))}">${esc(FIT[s.fit] || 'Good swap')}</span></div>
      ${s.amount || s.ratio !== null ? `<p class="sw-amt">${swapLine(ing, { use: s.name, amount: s.amount, ratio: s.ratio }, sv)}</p>` : ''}
      ${s.why ? `<p>${esc(s.why)}</p>` : ''}
      ${s.adjust ? `<p class="sw-adj">${esc(s.adjust)}</p>` : ''}
      <div class="sw-foot"><span class="${s.ready ? 'have' : ''}">${s.ready ? `${icon('check', 16)}In this kitchen` : 'Not in this kitchen'}</span>
        <button type="button" class="sw-use" data-use="${k}"${s.ready ? '' : ' data-list'}>${s.ready ? 'Use this' : `${icon('list', 17)}Use · add to list`}</button></div></div>`).join('')}`;
}

function bind() {
  const body = $('swBody');
  body.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
    const nm = b.dataset.pick;
    if (st.picks.has(nm)) st.picks.delete(nm); else st.picks.add(nm);
    haptic('tick');
    paint();
  }));
  body.querySelectorAll('[data-must]').forEach(b => b.addEventListener('click', () => {
    st.musts = st.musts.filter(m => m !== b.dataset.must);
    keepMusts();
    haptic('tick');
    paint();
  }));
  const add = $('swAdd');
  if (add) add.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!addTyped($('swExtra').value)) return;
    paint();
    $('swExtra').focus();
  });
  const ask = $('swAsk');
  if (ask) ask.addEventListener('click', suggest);
  // Not in the kitchen: choosing it is also deciding what to get at the shop,
  // so the same tap puts it on the list to buy.
  body.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => {
    const s = st.res && st.res.suggestions[Number(b.dataset.use)];
    if (s) choose({ use: s.name, amount: s.amount, ratio: s.ratio, needs: s.needs, note: s.adjust, why: s.why, suggested: true }, b.hasAttribute('data-list') ? s.needs : null);
  }));
  body.querySelectorAll('[data-take]').forEach(b => b.addEventListener('click', () => choose({ use: b.dataset.take })));
  $('swOwn').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('swOwnIn').value.trim();
    if (!v) return;
    // "Gluten free" is not something to cook with: it is the question.
    if (canSuggest() && requirement(v)) { addTyped(v); suggest(); return; }
    choose({ use: v });
  });
  const orig = $('swOriginal');
  if (orig) orig.addEventListener('click', () => choose(null));
}

// What was typed into the options box: a rule, or an option to weigh (ticked).
function addTyped(raw) {
  const v = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!v) return false;
  const must = requirement(v);
  if (must) {
    if (!st.musts.includes(must)) { st.musts = [...st.musts, must].slice(-4); keepMusts(); }
  } else {
    if (!st.extra.includes(v)) st.extra.push(v);
    st.picks.add(v);
  }
  return true;
}

async function suggest() {
  if (!st || st.busy) return;
  // Typed and not entered: on a phone the button is the obvious next tap, and
  // the repaint below would otherwise throw the words away unasked.
  const typed = $('swExtra');
  if (typed) addTyped(typed.value);
  const seq = ++st.seq;
  st.busy = true;
  st.why = null;
  st.res = null;
  haptic('tick');
  paint();
  try {
    const b = await post(`/api/item/${st.id}/swap/suggest`, { i: st.i, kitchen: st.kitchen, picks: [...st.picks], musts: st.musts });
    if (!st || seq !== st.seq) return;
    if (b.ok) st.res = b; else { st.why = b.why; st.verdict = b.verdict || null; }
  } catch (_) {
    if (!st || seq !== st.seq) return;
    st.why = 'down';
  }
  st.busy = false;
  paint();
}

// `null` goes back to the original. `list`: names to put on the list to buy.
async function choose(body, list = null) {
  const { id, i, kitchen } = st;
  haptic('success');
  try {
    const r = await post(`/api/item/${id}/swap`, body ? { i, ...body } : { i, clear: true });
    applyWire(r.state);
    if (list && list.length && kitchen) {
      try { await addToBuy(kitchen, list.map(name => ({ name, for: id }))); toast('On the list to buy'); } catch (_) { toast('Could not add it to the list'); }
    }
    await refresh();
    changed();
    closeSheet('swapSheet');
    repaintRecipe();
    flashLine(i);
  } catch (_) { toast('Could not save that'); }
}

export function initSwap() {
  $('swClose').addEventListener('click', () => { closeSheet('swapSheet'); if (st) st.seq++; });
}
