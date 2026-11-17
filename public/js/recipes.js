// The Recipes tab: a shelf of cards, like Films, with your pantry and your list
// to buy at the top — and the sheet that reads a recipe from its link.
//
// Reading follows CLAUDE.md's choosing, not guessing: the read is SHOWN to the
// person who asked for it — what came with it, what you are short — and nothing
// is saved until they press Save. The title stays exactly as typed.
import { S } from './state.js';
import { $, esc, toast, openSheet, closeSheet, leadEmoji } from './util.js';
import { post, patch, applyWire } from './api.js';
import { icon, iconFor } from './icons.js';
import { refresh, changed, kindList, kindOrDefault } from './space.js';
import { getKitchen, openKitchen, pantryCount, buyCount } from './kitchen.js';
import { imgSrc, minutesLabel, openRecipe, repaintRecipe, currentRecipe } from './recipe.js';

const me = () => S.wire && S.wire.me && S.wire.me.id;
export const cookKindId = () => (kindList().find(k => k.cook) || {}).id || 'recipe';
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;
export const urlIn = (text) => ((String(text || '').match(URL_RE) || [])[0] || null);

// The leading emoji RUN, up to two (💍🐣): a 4:3 tile has the room. Rows keep
// leadEmoji, which takes one.
export function leadRun(title) {
  const a = leadEmoji(title);
  if (!a.emoji) return '';
  const b = leadEmoji(a.rest);
  return b.emoji && b.rest !== a.rest ? a.emoji + b.emoji : a.emoji;
}
const restAfterRun = (title) => {
  const a = leadEmoji(title);
  const b = a.emoji ? leadEmoji(a.rest) : a;
  return (b.emoji ? b.rest : a.rest) || title;
};

/* ── the shelf ──────────────────────────────────────────────────────────── */

export function tilesHtml() {
  const k = S.kitchens && S.kitchens[me()];
  const n = (x) => (k ? `${x} ${x === 1 ? 'thing' : 'things'}` : '…');
  return `<div class="ktiles">
    <button type="button" class="ktile" data-kitchen="pantry"><i class="sage">${icon('basket', 22)}</i>
      <span><b>Pantry</b><small data-kcount="pantry">${n(pantryCount(k))}</small></span></button>
    <button type="button" class="ktile" data-kitchen="buy"><i class="coral">${icon('list', 22)}</i>
      <span><b>To buy</b><small data-kcount="buy">${n(buyCount(k))}</small></span></button>
  </div>`;
}

export function cardHtml(it, { sectioned = false } = {}) {
  const r = it.mod && it.mod.recipe;
  const link = it.mod && it.mod.link && it.mod.link.url;
  const ready = it.ready && it.ready[me()];
  const run = leadRun(it.title);
  const via = sectioned && !it.mine && it.ideaBy !== it.author.id ? `via ${it.author.name}` : null;
  const time = r && (r.total || r.cook || r.prep);
  const facts = r ? [time ? minutesLabel(time) : null, r.yield ? `serves ${r.yield.n}` : null].filter(Boolean).join(' · ') : '';
  const have = ready ? ready.filter(Boolean).length : null;
  return `<div class="rcard ${it.done ? 'done' : ''}" data-it="${esc(it.id)}">
    <div class="rtile${r && r.image ? ' photo' : ''}" data-open>
      ${r && r.image ? `<img src="${esc(imgSrc(r.image))}" alt="" loading="lazy">` : `<span class="remoji" aria-hidden="true">${
        run ? esc(run) : iconFor(kindOrDefault(it), 40)}</span>`}
      ${r && r.image && r.site ? `<span class="rsite">${esc(r.site)}</span>` : ''}
      <button class="tick" data-tick aria-label="${it.done ? 'Not made after all' : 'Made it'}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.4l4.3 4.3L18.6 7.6"/></svg>
      </button>
    </div>
    <div class="rcap" data-open>
      <b>${esc(r ? it.title : restAfterRun(it.title))}</b>
      ${facts ? `<small>${esc(facts)}</small>` : ''}
      ${via ? `<small>${esc(via)}</small>` : ''}
      ${have !== null ? `<span class="rhave${have === ready.length ? ' all' : ''}">${
        have === ready.length ? 'Have everything' : `Have ${have} of ${ready.length}`}</span>` : ''}
    </div>
    ${!r ? `<button type="button" class="addrec" data-addrec="${esc(it.id)}"${link ? ` data-url="${esc(link)}"` : ''}>${icon('link', 17)}${
      link ? 'Read the recipe' : 'Add the recipe'}</button>` : ''}
  </div>`;
}

export function bindRecipes(list) {
  list.querySelectorAll('[data-kitchen]').forEach(b => b.addEventListener('click', () => openKitchen({ tab: b.dataset.kitchen })));
  list.querySelectorAll('[data-addrec]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    openRead({ itemId: b.dataset.addrec, url: b.dataset.url || '' });
  }));
  list.querySelectorAll('.rtile img').forEach(img => img.addEventListener('error', () => {
    const tile = img.closest('.rtile');
    tile.classList.remove('photo');
    img.replaceWith(Object.assign(document.createElement('span'), { className: 'remoji', textContent: '🍳' }));
  }, { once: true }));
  // Your kitchen, for the tiles and the "Have 8 of 11" — fetched once, then
  // kept fresh by whatever changes it.
  if (!(S.kitchens && S.kitchens[me()])) {
    getKitchen(me()).then((k) => {
      const set = (sel, v) => list.querySelectorAll(sel).forEach((el) => { el.textContent = `${v} ${v === 1 ? 'thing' : 'things'}`; });
      set('[data-kcount="pantry"]', pantryCount(k));
      set('[data-kcount="buy"]', buyCount(k));
    }).catch(() => {});
  }
}

/* ── reading a link ─────────────────────────────────────────────────────── */

let rd = null;   // { itemId, url, title, mode, recipe, ready, why, site, text, busy }

const WHY = {
  'no-recipe': 'This page doesn’t share its recipe',
  refused: 'That link can’t be read from here',
  unreachable: 'Couldn’t reach that page',
  'too-big': 'That page is too big to read',
  'slow-down': 'That’s a lot of reading — try again in a little while',
};
const NUMWORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const nw = (n) => NUMWORD[n] || String(n);
const shortUrl = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '');

// itemId: attach to an existing item. url: read it now. title: what was typed
// around the link. paste: open on the paste box.
export function openRead({ itemId = null, url = '', title = '', paste = false } = {}) {
  rd = { itemId, url: url || '', title: title || '', mode: url && !paste ? 'reading' : paste ? 'paste' : 'ask', recipe: null, ready: null, why: null, site: null, text: '' };
  paint();
  openSheet('readSheet');
  if (rd.mode === 'reading') read();
}

async function read() {
  const mine = rd;
  mine.mode = 'reading';
  paint();
  let b;
  try { b = await post('/api/recipe/read', { url: mine.url }); } catch (_) { b = { ok: false, why: 'unreachable' }; }
  if (rd !== mine) return;
  if (b.ok) Object.assign(mine, { mode: 'found', recipe: b.recipe, ready: b.ready, url: b.url || mine.url });
  else Object.assign(mine, { mode: 'none', why: b.why || 'unreachable', site: b.site || null });
  paint();
}

async function readPaste() {
  const mine = rd;
  mine.text = $('rdPaste').value;
  if (!mine.text.trim()) return;
  let b;
  try { b = await post('/api/recipe/paste', { text: mine.text }); } catch (_) { b = { ok: false }; }
  if (rd !== mine) return;
  if (b.ok) Object.assign(mine, { mode: 'found', recipe: b.recipe, ready: b.ready });
  else toast('Couldn’t find ingredients or steps in that');
  paint();
}

const itemOf = (id) => (S.items || []).find(x => x.id === id);

function paint() {
  const box = $('rdBody');
  const r = rd.recipe;
  const it = rd.itemId ? itemOf(rd.itemId) : null;
  const title = rd.title || (it && it.title) || (r && r.name) || '';
  const urlRow = rd.url ? `<div class="ifield ro">${icon('link', 19)}<span>${esc(shortUrl(rd.url))}</span></div>` : '';
  if (rd.mode === 'ask' || rd.mode === 'reading') {
    $('rdTitle').textContent = rd.mode === 'reading' ? 'Reading the recipe…' : 'Add the recipe';
    box.innerHTML = rd.mode === 'reading' ? `${urlRow}<p class="rd-wait">Looking for ingredients, steps and timers…</p>`
      : `<form id="rdAsk"><div class="ifield">${icon('link', 19)}<input id="rdUrl" type="url" placeholder="Paste the recipe’s link" value="${esc(rd.url)}" autocomplete="off"></div>
          <button class="primary" type="submit">Read it</button></form>
         <button type="button" class="ghost" id="rdToPaste">Or paste the recipe itself</button>`;
  } else if (rd.mode === 'none' || rd.mode === 'paste') {
    $('rdTitle').textContent = rd.mode === 'none' ? 'Couldn’t read this one' : 'Paste the recipe';
    box.innerHTML = `${urlRow}
      ${rd.mode === 'none' ? `<div class="box rd-none"><b>${esc(WHY[rd.why] || WHY.unreachable)}</b>
        <small>Paste the ingredients and the steps below, and it reads those instead.</small></div>` : ''}
      <label class="fld"><span>Paste the recipe</span><textarea id="rdPaste" rows="9" placeholder="Ingredients…&#10;Steps…">${esc(rd.text)}</textarea></label>
      <button class="primary" type="button" id="rdReadPaste">Read what I pasted</button>
      ${rd.url ? '<button class="ghost" type="button" id="rdKeep">Just keep the link</button>' : ''}`;
  } else {
    $('rdTitle').textContent = 'Found the recipe';
    const n = r.ingredients.length;
    const withQ = r.ingredients.filter(x => x.q !== null).length;
    const timed = r.steps.filter(s => s.timers.length).length;
    const facts = [r.total ? minutesLabel(r.total) : null, r.yield ? `serves ${r.yield.n}` : null].filter(Boolean).join(' · ');
    const row = (ok, label, detail) => `<div class="crow"><span class="ring${ok ? ' on' : ''}">${ok ? icon('tick', 14, 3) : ''}</span>
      <span class="cb"><b>${label}</b></span><span class="val">${esc(ok ? detail : 'not on this page')}</span></div>`;
    const have = rd.ready ? rd.ready.filter(Boolean).length : 0;
    const short = rd.ready ? r.ingredients.filter((_, i) => !rd.ready[i]).map(x => x.name || x.text) : [];
    const pair = S.space && S.space.isPair;
    box.innerHTML = `${urlRow}
      <div class="rd-found">
        <span class="rd-thumb">${r.image ? `<img src="${esc(imgSrc(r.image))}" alt="">` : `<span>${esc(leadRun(title) || '🍳')}</span>`}</span>
        <span class="rd-who">${r.site ? `<small>From ${esc(r.site)}</small>` : ''}<b>${esc(r.name || 'Your recipe')}</b>
          ${title && title !== r.name ? `<small>Saved under your title: ${esc(title)}</small>` : ''}</span>
      </div>
      <h3 class="sec">What came with it</h3>
      <div class="box rows rd-came">
        ${row(!!r.image, 'Photo', '1 picture')}
        ${row(n > 0, 'Ingredients', withQ === n ? `${n}, with amounts` : `${n}, ${withQ} with amounts`)}
        ${row(r.steps.length > 0, 'Steps', `${r.steps.length}${timed ? `, ${nw(timed)} with timer${timed === 1 ? '' : 's'}` : ''}`)}
        ${row(!!facts, 'Time and servings', facts)}
      </div>
      ${rd.ready && n ? `<div class="box ready"><div class="rd-top"><b>In your kitchen</b><span>${have} of ${n}</span></div>
        <i class="bar"><b style="width:${Math.round((have / n) * 100)}%"></b></i>
        ${short.length ? `<small class="short">To buy: ${esc(short.slice(0, 6).join(', '))}${short.length > 6 ? '…' : ''}</small>` : ''}</div>` : ''}
      <button class="primary big" type="button" id="rdSave">Save the recipe</button>
      <p class="rd-note">${pair ? 'Saved for the two of you' : 'Saved to this list'}${rd.url ? ', with the link back to the original.' : '.'}</p>`;
  }
  bind();
}

function bind() {
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('rdAsk', 'submit', (e) => {
    e.preventDefault();
    const u = $('rdUrl').value.trim();
    if (!/^https?:\/\//i.test(u)) return toast('That needs to be a web link');
    rd.url = u;
    read();
  });
  on('rdToPaste', 'click', () => { rd.mode = 'paste'; paint(); $('rdPaste').focus(); });
  on('rdReadPaste', 'click', readPaste);
  on('rdKeep', 'click', () => save({ withRecipe: false }));
  on('rdSave', 'click', () => save({ withRecipe: true }));
}

// Saving: onto the item it was read for, or as a new recipe in this list.
async function save({ withRecipe }) {
  const mine = rd;
  const r = withRecipe ? mine.recipe : null;
  try {
    if (mine.itemId) {
      const it = itemOf(mine.itemId);
      if (!it) throw new Error('gone');
      if (r) applyWire((await post(`/api/item/${it.id}/recipe`, { recipe: r })).state);
      // The link is the author's to set; offered only to them (or an admin),
      // and only where there was none. The place slice goes with it, because
      // a PATCH replaces `mod` wholesale.
      const hadLink = it.mod && it.mod.link && it.mod.link.url;
      if (mine.url && !hadLink && it.canEdit) {
        applyWire((await patch(`/api/item/${it.id}`, {
          title: it.title,
          mod: { ...(it.mod && it.mod.place ? { place: it.mod.place } : {}), link: { url: mine.url } },
        })).state);
      }
    } else {
      const title = mine.title || (r && r.name) || hostTitle(mine.url);
      applyWire((await post(`/api/space/${S.spaceId}/item`, {
        title,
        kind: cookKindId(),
        visibility: S.compose || 'shared',
        mod: { ...(mine.url ? { link: { url: mine.url } } : {}), ...(r ? { recipe: r } : {}) },
      })).state);
    }
    closeSheet('readSheet');
    rd = null;
    await refresh();
    changed();
    if (currentRecipe()) repaintRecipe();
    toast(r ? 'Recipe saved' : 'Link kept');
  } catch (_) { toast('Could not save that'); }
}
const hostTitle = (u) => { try { return `Something from ${new URL(u).hostname.replace(/^www\./, '')}`; } catch (_) { return 'A recipe'; } };

export function initRecipes() {
  $('rdClose').addEventListener('click', () => { closeSheet('readSheet'); rd = null; });
}

// For the item sheet's link field and the share sheet: whether a recipe
// page has been read for this URL already is not remembered — reading again
// costs one request, and a stale read is worse.
export { openRecipe };
