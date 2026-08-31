// One list: the things to do with somebody, and the composer for adding more.
//
// The visibility control sits ABOVE the input rather than behind a menu, because
// choosing who a thing is for is part of writing it down, not an afterthought —
// and because a private thing filed as shared by accident is the one mistake this
// app must not make easy.
import { S } from './state.js';
import { $, esc, toast, showScreen, ago, openSheet, closeSheet } from './util.js';
import { get, post, patch, del, applyWire } from './api.js';

let onChange = () => {};
let onBack = () => {};
let editing = null;      // item id open in the sheet
let editingVis = 'shared';

const VIS = [
  { id: 'private', label: 'Just me', hint: 'only you' },
  { id: 'shared', label: 'Us', hint: 'this list' },
  { id: 'public', label: 'Anyone', hint: 'all your people' },
];

export async function openSpace(id) {
  S.spaceId = id;
  S.compose = 'shared';
  showScreen('scr-space');
  $('itemList').innerHTML = '<div class="empty">Loading…</div>';
  await refresh();
}

export async function refresh() {
  if (!S.spaceId) return;
  try {
    const b = await get(`/api/space/${S.spaceId}/items`);
    S.space = b.space;
    S.items = b.items;
    render();
  } catch (_) { toast('Could not load that list'); }
}

/* ── render ─────────────────────────────────────────────────────────────── */

// One three-way control, used by both the composer and the item sheet. `read`
// and `write` are passed in so the control never has to know which of the two it
// is driving — and so picking a value repaints from the same source of truth it
// just wrote to, rather than from a copy.
function visRow(el, read, write) {
  const paint = () => {
    const cur = read();
    el.innerHTML = VIS.map(v => `<button data-v="${v.id}" class="${v.id === cur ? 'on' : ''}">
      <b>${esc(v.label)}</b>${esc(v.hint)}</button>`).join('');
    el.querySelectorAll('[data-v]').forEach(b =>
      b.addEventListener('click', () => { write(b.dataset.v); paint(); }));
  };
  paint();
}

function itemHtml(it) {
  const bits = [];
  if (it.visibility === 'private') bits.push('<span class="chip private">just you</span>');
  if (it.visibility === 'public') bits.push('<span class="chip public">anyone</span>');
  // A wish that drifted in from one of the author's other lists. Worth saying —
  // "Andrew wants to do this with anyone" reads differently from something
  // written here for you.
  if (it.fromElsewhere) bits.push(`<span class="chip elsewhere">${esc(it.author.name)}'s standing wish</span>`);
  const place = it.mod && it.mod.place;
  if (place) bits.push(`<span class="chip place">${esc(place.name)}</span>`);
  const link = it.mod && it.mod.link;
  if (link) bits.push(`<a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">link</a>`);
  if (it.done && it.doneByName) bits.push(`<span class="who">${esc(it.doneByName)} ticked it off ${esc(ago(it.doneAt))}</span>`);
  else if (!it.mine) bits.push(`<span class="who">${esc(it.author.name)}</span>`);

  return `<div class="it ${it.done ? 'done' : ''}" data-it="${esc(it.id)}">
    <button class="tick" data-tick aria-label="${it.done ? 'Not done after all' : 'Done'}">✓</button>
    <div class="it-bd" data-open>
      <b>${esc(it.title)}</b>
      ${it.notes ? `<p>${esc(it.notes)}</p>` : ''}
      ${bits.length ? `<div class="it-meta">${bits.join('')}</div>` : ''}
    </div>
  </div>`;
}

function render() {
  const sp = S.space;
  if (!sp) return;
  $('spaceTitle').textContent = sp.title;

  $('itemList').innerHTML = S.items.length
    ? S.items.map(itemHtml).join('')
    : `<div class="empty">Nothing here yet.<br>What do you keep meaning to do together?</div>`;

  $('itemList').querySelectorAll('[data-it]').forEach((row) => {
    const id = row.dataset.it;
    row.querySelector('[data-tick]').addEventListener('click', () => toggle(id));
    row.querySelector('[data-open]').addEventListener('click', () => openItem(id));
  });

  visRow($('visRow'), () => S.compose, (v) => { S.compose = v; });
}

/* ── writing ────────────────────────────────────────────────────────────── */

async function add() {
  const input = $('newItem');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  try {
    const b = await post(`/api/space/${S.spaceId}/item`, { title, visibility: S.compose });
    applyWire(b.state);
    await refresh();
    onChange();
  } catch (_) { toast('Could not add that'); input.value = title; }
}

async function toggle(id) {
  const it = S.items.find(x => x.id === id);
  if (!it) return;
  // Optimistic: ticking something off should feel instant, and the worst case is
  // it flips back when the server disagrees.
  it.done = !it.done;
  render();
  try {
    const b = await post(`/api/item/${id}/done`, { done: it.done });
    applyWire(b.state);
    await refresh();
    onChange();
  } catch (e) {
    it.done = !it.done;
    render();
    toast(e.status === 403 ? 'That one is not yours to tick off' : 'Could not save that');
  }
}

/* ── one item, opened ───────────────────────────────────────────────────── */

function openItem(id) {
  const it = S.items.find(x => x.id === id);
  if (!it) return;
  editing = id;
  $('isTitle').textContent = it.mine ? 'Your thing' : `${it.author.name}'s thing`;
  $('isMeta').textContent = `added ${ago(it.createdAt)}`;
  $('isName').value = it.title;
  $('isNotes').value = it.notes || '';
  $('isPlace').value = (it.mod && it.mod.place && it.mod.place.name) || '';
  $('isLink').value = (it.mod && it.mod.link && it.mod.link.url) || '';
  // Somebody else's wording is theirs. You can see it and tick it off; you cannot
  // rewrite it.
  const ro = !it.canEdit;
  for (const f of ['isName', 'isNotes', 'isPlace', 'isLink']) $(f).disabled = ro;
  $('isSave').hidden = ro;
  $('isDelete').hidden = ro;
  $('isVis').hidden = ro;
  editingVis = it.visibility;
  if (!ro) visRow($('isVis'), () => editingVis, (v) => { editingVis = v; });
  openSheet('itemSheet');
}

async function saveItem() {
  const it = S.items.find(x => x.id === editing);
  if (!it) return;
  const title = $('isName').value.trim();
  if (!title) return toast('It needs a name');
  const place = $('isPlace').value.trim();
  const url = $('isLink').value.trim();
  try {
    const b = await patch(`/api/item/${editing}`, {
      title,
      notes: $('isNotes').value.trim(),
      visibility: editingVis,
      // The module bag. The server drops anything it has no rules for.
      mod: {
        ...(place ? { place: { name: place } } : {}),
        ...(url ? { link: { url } } : {}),
      },
    });
    applyWire(b.state);
    closeSheet('itemSheet');
    await refresh();
    onChange();
  } catch (_) { toast('Could not save that'); }
}

async function deleteItem() {
  if (!editing || !confirm('Delete this?')) return;
  try {
    applyWire(await del(`/api/item/${editing}`));
    closeSheet('itemSheet');
    await refresh();
    onChange();
  } catch (_) { toast('Could not delete that'); }
}

/* ── list settings ──────────────────────────────────────────────────────── */

function openSettings() {
  const sp = S.space;
  if (!sp) return;
  $('ssTitle').textContent = sp.title;
  $('ssWho').textContent = sp.members.map(m => m.name).join(' · ');
  // A pair names itself after whoever you aren't; only a group needs a title.
  $('ssNameFld').hidden = sp.isPair;
  $('ssName').value = sp.name || '';
  $('ssLink').hidden = true;
  openSheet('spaceSheet');
}

async function makeInvite() {
  try {
    const b = await post(`/api/space/${S.spaceId}/invite`);
    const url = `${location.origin}/?invite=${encodeURIComponent(b.code)}`;
    const el = $('ssLink');
    el.textContent = url;
    el.hidden = false;
    try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch (_) {}
  } catch (_) { toast('Could not make a link'); }
}

async function saveSpaceName() {
  const name = $('ssName').value.trim();
  if (!S.space || S.space.isPair || name === (S.space.name || '')) return;
  try {
    const b = await patch(`/api/space/${S.spaceId}`, { name });
    applyWire(b.state);
    S.space = b.space;
    render();
    onChange();
  } catch (_) { toast('Could not rename'); }
}

async function leave() {
  if (!confirm('Leave this list? The others keep it.')) return;
  try {
    applyWire(await post(`/api/space/${S.spaceId}/leave`));
    closeSheet('spaceSheet');
    onBack();
    onChange();
  } catch (_) { toast('Could not leave'); }
}

/* ── wiring ─────────────────────────────────────────────────────────────── */

export function initSpace(changeHandler, backHandler) {
  onChange = changeHandler || (() => {});
  onBack = backHandler || (() => {});

  $('spaceBack').addEventListener('click', () => onBack());
  $('spaceMenu').addEventListener('click', openSettings);
  $('btnAdd').addEventListener('click', add);
  $('newItem').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  $('isSave').addEventListener('click', saveItem);
  $('isDelete').addEventListener('click', deleteItem);
  $('isCancel').addEventListener('click', () => closeSheet('itemSheet'));
  $('itemSheet').addEventListener('click', (e) => { if (e.target === $('itemSheet')) closeSheet('itemSheet'); });

  $('ssInvite').addEventListener('click', makeInvite);
  $('ssName').addEventListener('change', saveSpaceName);
  $('ssLeave').addEventListener('click', leave);
  $('ssCancel').addEventListener('click', () => closeSheet('spaceSheet'));
  $('spaceSheet').addEventListener('click', (e) => { if (e.target === $('spaceSheet')) closeSheet('spaceSheet'); });

  // The composer is not in a sheet, so nothing else puts the viewport back.
  document.addEventListener('focusout', (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) {
      requestAnimationFrame(() => window.scrollTo(0, 0));
    }
  });
}
