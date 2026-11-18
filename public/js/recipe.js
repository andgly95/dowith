// One recipe, opened: its own page rather than the generic form, the way a
// place has its page. Servings that rescale, ingredients checked against a
// kitchen, the steps with their timers, your notes and what you changed last
// time — and Start cooking.
//
// Amounts are rescaled HERE, by `amount()`, which is pure and is asserted from
// the browser check. Times never scale; the servings line says so.
import { S } from './state.js';
import { $, esc, toast, openSheet, closeSheet, leadEmoji, shortDate } from './util.js';
import { get, post, patch, del, applyWire } from './api.js';
import { icon } from './icons.js';
import { refresh, changed, kindOf, kindOrDefault, ideaLine, openItem } from './space.js';
import { openRead, leadRun } from './recipes.js';
import { getKitchen, setPantry, addToBuy } from './kitchen.js';
import { openCook, pickUp } from './cook.js';
import { haptic, fadeIn } from './motion.js';
import { openSwap } from './swap.js';

/* ── amounts ────────────────────────────────────────────────────────────── */

const GLYPH = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔'], [3 / 4, '¾'], [1, '']];
const HALVES = new Set(['clove', 'can', 'slice', 'stick', 'jar', 'package', 'head', 'bunch', 'sprig']);
const PLURAL = { cup: 'cups', clove: 'cloves', can: 'cans', pinch: 'pinches', dash: 'dashes', stick: 'sticks',
  slice: 'slices', bunch: 'bunches', sprig: 'sprigs', package: 'packages', jar: 'jars', head: 'heads', qt: 'qt', pt: 'pt' };

// Cups, spoons and plain counts: the nearest of ⅛ ¼ ⅓ ½ ⅔ ¾, whole from ten up.
function fraction(v) {
  if (v >= 10) return String(Math.round(v));
  let whole = Math.floor(v);
  const rest = v - whole;
  let best = GLYPH[0];
  for (const g of GLYPH) if (Math.abs(rest - g[0]) < Math.abs(rest - best[0])) best = g;
  if (best[0] === 1) { whole += 1; best = GLYPH[0]; }
  if (!whole && !best[1]) return '⅛';                     // never "0"
  return `${whole || ''}${best[1]}`;
}

function number(v, unit) {
  if (unit === 'g' || unit === 'ml') {
    // Nearest 5 under 100, nearest 10 above — nobody weighs 237 g of anything.
    if (v < 100) return String(Math.max(5, Math.round(v / 5) * 5));
    return String(Math.round(v / 10) * 10);
  }
  if (unit === 'kg' || unit === 'l') return String(Math.round(v * 10) / 10);
  if (HALVES.has(unit)) {
    // Cloves, cans and the like: the nearest half, never below one half.
    const h = Math.max(0.5, Math.round(v * 2) / 2);
    return fraction(h);
  }
  return fraction(v);
}

// "1½ cups", "2–3 tbsp", "4 cloves". `q: null` is a line this could not read:
// it is shown exactly as published and never scaled, so this returns null.
export function amount(q, scale = 1, unit = null, q2 = null) {
  if (q === null || q === undefined || !Number.isFinite(Number(q))) return null;
  const s = Number(scale) > 0 ? Number(scale) : 1;
  const v = Number(q) * s;
  const a = number(v, unit);
  const b = q2 ? number(Number(q2) * s, unit) : null;
  const n = b && b !== a ? `${a}–${b}` : a;
  if (!unit) return n;
  const many = (b ? Number(q2) * s : v) > 1;
  const word = many && PLURAL[unit] ? PLURAL[unit] : unit;
  return `${n} ${word}`;
}

// One ingredient as a row shows it: the scaled amount in bold, then the rest.
export function ingredientHtml(ing, scale) {
  const a = amount(ing.q, scale, ing.unit, ing.q2);
  if (!a) return `<span class="ig-t">${esc(ing.text)}</span>`;
  return `<span class="ig-t"><b>${esc(a)}</b> ${esc(ing.name)}${ing.note ? `<span class="ig-n">, ${esc(ing.note)}</span>` : ''}</span>`;
}

// A swapped line: what is going in instead, and, under it, what it replaced.
// Scaled only when the swap is the same amount (or a fraction of it) in the
// original's unit — `ratio`. A measured line the app cannot read is shown as
// it was written and says so, the same rule as an unreadable ingredient.
export function swapLine(ing, sw, sv) {
  if (sw.ratio !== null && sw.ratio !== undefined && typeof ing.q === 'number') {
    const a = amount(ing.q * sw.ratio, sv.scale, ing.unit, ing.q2 ? ing.q2 * sw.ratio : null);
    if (a) return `<b>${esc(a)}</b> ${esc(sw.use)}`;
  }
  if (sw.amount) {
    return `${esc(sw.amount)}${sv.scale !== 1 ? `<span class="ig-n"> · ${esc(sv.base ? `for ${sv.base}, as written` : 'as written')}</span>` : ''}`;
  }
  return esc(sw.use);
}
export function lineHtml(it, i, sv) {
  const ing = it.mod.recipe.ingredients[i];
  const sw = it.swaps && it.swaps[i];
  if (!sw) return ingredientHtml(ing, sv.scale);
  return `<span class="ig-t">${swapLine(ing, sw, sv)}<span class="ig-was">instead of ${esc(ing.text)}</span></span>`;
}
// What a line needs from a kitchen: the swap's things, or the ingredient.
const needsOf = (it, i) => {
  const sw = it.swaps && it.swaps[i];
  const ing = it.mod.recipe.ingredients[i];
  return sw ? sw.needs : [ing.name || ing.text];
};

/* ── servings ───────────────────────────────────────────────────────────── */

// Per DEVICE: how many you are feeding is about tonight, not about the recipe,
// so it is not stored on the item.
const MULTS = [0.5, 1, 1.5, 2, 3];
export function servings(it) {
  const r = it.mod && it.mod.recipe;
  const base = r && r.yield && r.yield.n;
  let saved = null;
  try { saved = Number(localStorage.getItem(`dw-serves:${it.id}`)); } catch (_) {}
  if (base) {
    const n = saved >= 1 && saved <= 24 ? saved : base;
    return { base, n, scale: n / base, label: `Serves ${n}` };
  }
  // No yield on the recipe: a multiplier instead.
  const m = MULTS.includes(saved / 100) ? saved / 100 : 1;
  return { base: null, n: m, scale: m, label: m === 1 ? 'As written' : `×${multLabel(m)}` };
}
const multLabel = (m) => ({ 0.5: '½', 1: '1', 1.5: '1½', 2: '2', 3: '3' }[m] || String(m));
function stepServings(it, dir) {
  const sv = servings(it);
  let v;
  if (sv.base) v = Math.max(1, Math.min(24, sv.n + dir));
  else v = Math.round(MULTS[Math.max(0, Math.min(MULTS.length - 1, MULTS.indexOf(sv.n) + dir))] * 100);
  try { localStorage.setItem(`dw-serves:${it.id}`, String(v)); } catch (_) {}
}

/* ── the page ───────────────────────────────────────────────────────────── */

let page = null;          // item id
let cookIn = null;        // whose kitchen the ingredients are checked against

const me = () => S.wire && S.wire.me && S.wire.me.id;
const itemNow = () => (S.items || []).find(x => x.id === page);
// In a pair list, you and your partner; in a group, just you.
function kitchensHere() {
  const sp = S.space;
  const mine = me();
  const list = ((S.wire && S.wire.kitchens) || []).filter(k => k.id === mine
    || (sp && sp.isPair && (sp.members || []).some(m => m.id === k.id)));
  return list.length ? list : [{ id: mine, name: 'You' }];
}
export const imgSrc = (name) => `/api/img/${encodeURIComponent(name)}`;
export const minutesLabel = (m) => (m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

export function openRecipe(id) {
  const it = (S.items || []).find(x => x.id === id);
  if (!it) return;
  page = id;
  if (!cookIn || !kitchensHere().some(k => k.id === cookIn)) cookIn = me();
  paint();
  openSheet('recipeSheet');
  $('recipeSheet').querySelector('.modal-in').scrollTop = 0;
  getKitchen(cookIn).then(() => { if (page === id) paint(); }).catch(() => {});
}

export function repaintRecipe() { if (page && !$('recipeSheet').hidden) paint(); }
// A line just changed (a swap chosen): it glows as it lands, like anything new.
export function flashLine(i) {
  const row = $('rpBody').querySelector(`.ig[data-i="${Number(i)}"]`);
  if (row) row.classList.add('arrived');
}

function paint() {
  const it = itemNow();
  if (!it) return;
  const r = it.mod && it.mod.recipe;
  const link = it.mod && it.mod.link && it.mod.link.url;
  const sv = servings(it);
  const box = $('rpBody');
  const kitchens = kitchensHere();
  const ready = (it.ready && it.ready[cookIn]) || null;
  const site = (r && r.site) || (link ? hostOf(link) : null);
  const emoji = leadRun(it.title);

  const hero = `<div class="rp-hero${r && r.image ? '' : ' bare'}">
      ${r && r.image ? `<img class="fade" src="${esc(imgSrc(r.image))}" alt="">` : `<span class="rp-emoji" aria-hidden="true">${esc(emoji || '🍳')}</span>`}
      ${link ? `<a class="site-chip" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(site || 'Original')} ↗</a>` : ''}
    </div>`;

  const times = r ? [['Prep', r.prep], ['Cook', r.cook], ['Total', r.total]].filter(([, v]) => v) : [];

  let ingredients = '';
  if (r && r.ingredients.length) {
    const have = ready ? ready.filter(Boolean).length : null;
    const missing = ready ? r.ingredients.map((ing, i) => (ready[i] ? null : { ing, i })).filter(Boolean) : [];
    const kit = S.kitchens && S.kitchens[cookIn];
    const listed = new Set(((kit && kit.buy) || []).filter(b => b.for === it.id).map(b => keyish(b.name)));
    const onList = missing.length && missing.every(m => needsOf(it, m.i).every(n => listed.has(keyish(n))));
    const whose = kitchens.find(k => k.id === cookIn);
    ingredients = `<div class="rp-sec"><h3>Ingredients</h3>${kitchens.length > 1 ? `<div class="segs small" id="rpWho">${
      kitchens.map(k => `<button type="button" data-k="${esc(k.id)}" class="${k.id === cookIn ? 'on' : ''}" aria-pressed="${k.id === cookIn}">${
        k.id === me() ? 'Mine' : `${esc(k.name)}’s`}</button>`).join('')}</div>` : ''}</div>
      ${ready && missing.length ? `<div class="box ready">
        <div class="rd-top"><b>${cookIn === me() ? 'In your kitchen' : `In ${esc(whose ? whose.name : 'their')}’s kitchen`}</b><span>${have} of ${r.ingredients.length}</span></div>
        <i class="bar"><b style="width:${Math.round((have / r.ingredients.length) * 100)}%"></b></i>
        <button type="button" class="tolist${onList ? ' on' : ''}" id="rpToList">${icon(onList ? 'check' : 'list', 18)}${
          onList ? 'On the list' : `Add ${missing.length} to the list`}</button>
      </div>` : ''}
      <div class="box rows ings">${r.ingredients.map((ing, i) => {
        const has = ready ? !!ready[i] : false;
        const sw = it.swaps && it.swaps[i];
        const what = sw ? sw.use : (ing.name || ing.text);
        // A line offering a choice asks which, until one is chosen.
        const alts = !sw && it.choices && it.choices[i];
        return `<div class="ig${has ? ' has' : ''}${sw ? ' swapped' : ''}" data-i="${i}">
          <button type="button" class="ring" data-ing="${i}" aria-pressed="${has}" aria-label="${esc(`${has ? 'Have it' : 'Need it'}: ${what}`)}">${icon('tick', 14, 3)}</button>
          ${lineHtml(it, i, sv)}
          <button type="button" class="swapb${sw ? ' on' : ''}${alts ? ' which' : ''}" data-swap="${i}" aria-label="${esc(sw ? `Swapped: ${what}. Change it`
            : alts ? `Which one: ${alts.join(' or ')}?` : `Swap ${what}`)}">${alts ? 'Which?' : icon('swap', 18)}</button></div>`;
      }).join('')}</div>`;
  } else if (!r) {
    ingredients = `<div class="box rp-empty">
      <p>${link ? 'The recipe is behind the link. Read it, and the ingredients, steps and timers come here.'
        : 'No recipe yet. Paste its link, or the recipe itself.'}</p>
      <button type="button" class="primary" id="rpRead">${link ? 'Read the recipe' : 'Add the recipe'}</button></div>`;
  }

  const steps = r && r.steps.length ? `<div class="rp-sec"><h3>Steps</h3></div><ol class="box steps">${r.steps.map((st, i) => `<li>
      <span class="n">${i + 1}</span><div><p>${esc(st.text)}</p>${st.timers.map(t => `<button type="button" class="tchip" data-cook="${i}">${
        icon('timer', 16)}${esc(minutesLabel(Math.max(1, Math.round(t.secs / 60))))} timer</button>`).join('')}</div></li>`).join('')}</ol>` : '';

  const cooked = Array.isArray(it.cooked) ? it.cooked : [];
  const tweaks = cooked.filter(c => c.tweaks).slice().reverse();
  const notes = (it.notes || tweaks.length || cooked.length) ? `<div class="rp-sec"><h3>Our notes</h3></div>
    ${cooked.length ? `<p class="made-n">Made ${cooked.length === 1 ? 'once' : `${cooked.length} times`} · last ${esc(shortDate(cooked[cooked.length - 1].at))}</p>` : ''}
    <div class="box notes">${it.notes ? `<p>${esc(it.notes)}</p>` : ''}${tweaks.map(c => `<p class="tw"><small>${esc(shortDate(c.at))} · ${
      esc(nameOf(c.by))}</small>${esc(c.tweaks)}</p>`).join('')}</div>` : '';

  const more = `<div class="box rows more">
      <button type="button" class="crow" id="rpEdit"><i>${icon('pencil', 20)}</i><span class="cb"><b>Edit details</b></span><span class="val">${
        esc(`${ideaLine(it)} · ${{ private: 'Just me', shared: 'Us', public: 'Anyone' }[it.visibility] || 'Us'}`)}</span></button>
      ${link ? `<button type="button" class="crow" id="rpReread"><i>${icon('link', 20)}</i><span class="cb"><b>${r ? 'Read the link again' : 'Read the recipe'}</b></span></button>` : ''}
      ${r ? `<button type="button" class="crow" id="rpPaste"><i>${icon('list', 20)}</i><span class="cb"><b>Paste it instead</b></span></button>` : ''}
      ${it.canEdit ? `<button type="button" class="crow warn" id="rpDelete"><i>${icon('trash', 20)}</i><span class="cb"><b>Delete</b></span></button>` : ''}
    </div>`;

  box.innerHTML = `${hero}
    <h2 class="rp-title">${esc(it.title)}</h2>
    <p class="rp-sub">${esc(ideaLine(it))} · ${esc(kindOf(kindOrDefault(it)).label)}${it.when && it.when.date ? ` · planned ${esc(it.when.date)}` : ''}</p>
    ${times.length ? `<div class="rp-times">${times.map(([k, v]) => `<div><small>${k}</small><b>${esc(minutesLabel(v))}</b></div>`).join('')}</div>` : ''}
    ${r && r.ingredients.length ? `<div class="box serves">
      <span class="cb"><b>Servings</b><small>Amounts change, times don’t</small></span>
      <button type="button" class="round" id="rpLess" aria-label="Fewer">${icon('minus', 20)}</button>
      <b class="sv" aria-live="polite">${esc(sv.base ? String(sv.n) : `×${multLabel(sv.n)}`)}</b>
      <button type="button" class="round" id="rpMore" aria-label="More">${icon('plus', 20)}</button></div>` : ''}
    ${ingredients}${steps}${notes}${more}`;

  // The sticky bar: plan it, and start — or pick up where you left off.
  const at = pickUp(it.id);
  $('rpCook').hidden = !(r && r.steps.length);
  $('rpCookLabel').textContent = at ? `Pick up at step ${at + 1}` : 'Start cooking';
  $('rpDate').value = (it.when && it.when.date) || '';
  bind(it);
}

const keyish = (n) => String(n || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().replace(/s\b/g, '');
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return null; } };
function nameOf(uid) {
  if (uid === me()) return 'You';
  const m = ((S.space && S.space.members) || []).find(x => x.id === uid);
  return m ? m.name : 'Someone';
}

function bind(it) {
  const box = $('rpBody');
  fadeIn(box);
  const on = (id, fn) => { const el = box.querySelector(`#${id}`); if (el) el.addEventListener('click', fn); };
  on('rpLess', () => { stepServings(it, -1); paint(); });
  on('rpMore', () => { stepServings(it, 1); paint(); });
  on('rpRead', () => openRead({ itemId: it.id, url: it.mod && it.mod.link && it.mod.link.url }));
  on('rpReread', () => openRead({ itemId: it.id, url: it.mod && it.mod.link && it.mod.link.url }));
  on('rpPaste', () => openRead({ itemId: it.id, url: (it.mod && it.mod.link && it.mod.link.url) || '', paste: true }));
  on('rpEdit', () => { closeSheet('recipeSheet'); openItem(it.id, { generic: true }); });
  on('rpDelete', async () => {
    if (!confirm('Delete this?')) return;
    try {
      applyWire(await del(`/api/item/${it.id}`));
      closeSheet('recipeSheet');
      page = null;
      await refresh();
      changed();
    } catch (_) { toast('Could not delete that'); }
  });
  on('rpToList', async () => {
    const r = it.mod.recipe;
    const ready = (it.ready && it.ready[cookIn]) || [];
    const sv = servings(it);
    // A swapped line goes on the list as what it now is.
    const rows = r.ingredients.flatMap((ing, i) => {
      if (ready[i]) return [];
      if (it.swaps && it.swaps[i]) return it.swaps[i].needs.map(name => ({ name, amount: null, for: it.id }));
      return [{ name: ing.name || ing.text, amount: amount(ing.q, sv.scale, ing.unit, ing.q2), for: it.id }];
    });
    try { await addToBuy(cookIn, rows); paint(); toast('On the list to buy'); } catch (_) { toast('Could not add those'); }
  });
  box.querySelectorAll('#rpWho [data-k]').forEach(b => b.addEventListener('click', async () => {
    cookIn = b.dataset.k;
    paint();
    try { await getKitchen(cookIn); paint(); } catch (_) {}
  }));
  // Tapping a ring writes that kitchen's pantry: need → Have, have → Out —
  // for a swapped line, the things the swap uses. Have also takes it off the
  // list to buy, on the server (kitchen.bought).
  box.querySelectorAll('[data-ing]').forEach(b => b.addEventListener('click', async () => {
    const i = Number(b.dataset.ing);
    // "Flour or cornstarch": having it (or running out) means ONE of them, so
    // until one is chosen the ring asks which, rather than writing the whole
    // phrase into the pantry as if it were a thing you could own.
    if (!(it.swaps && it.swaps[i]) && it.choices && it.choices[i]) {
      openSwap(it.id, i, cookIn);
      return;
    }
    const has = b.getAttribute('aria-pressed') === 'true';
    haptic('tick');
    b.setAttribute('aria-pressed', String(!has));
    b.closest('.ig').classList.toggle('has', !has);
    try {
      for (const name of needsOf(it, i)) await setPantry(cookIn, name, has ? 'out' : 'have');
      await refresh();
      paint();
    } catch (_) { toast('Could not change that'); paint(); }
  }));
  box.querySelectorAll('[data-swap]').forEach(b => b.addEventListener('click', () => openSwap(it.id, Number(b.dataset.swap), cookIn)));
  box.querySelectorAll('[data-cook]').forEach(b => b.addEventListener('click', () => {
    closeSheet('recipeSheet');
    openCook(it.id, { step: Number(b.dataset.cook), kitchen: cookIn });
  }));
}

export function initRecipe() {
  $('rpClose').addEventListener('click', () => { closeSheet('recipeSheet'); page = null; });
  $('rpCook').addEventListener('click', () => {
    const it = itemNow();
    if (!it) return;
    closeSheet('recipeSheet');
    openCook(it.id, { step: pickUp(it.id) || 0, kitchen: cookIn });
  });
  // Plan it: the same When as everywhere, saving on change.
  $('rpPlan').addEventListener('click', () => { try { $('rpDate').showPicker(); } catch (_) { $('rpDate').focus(); } });
  $('rpDate').addEventListener('change', async () => {
    const it = itemNow();
    if (!it) return;
    const date = $('rpDate').value;
    try {
      const r = await post(`/api/item/${it.id}/when`, date ? { date, time: null } : { clear: true });
      applyWire(r.state);
      await refresh();
      changed();
      paint();
      toast(date ? 'Planned' : 'Off the calendar');
    } catch (_) { toast('Could not plan that'); }
  });
}

export const currentRecipe = () => page;
export { kitchensHere };
