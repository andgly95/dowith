// One list: the things to do with somebody, and the composer for adding more.
//
// The visibility control sits ABOVE the input rather than behind a menu, because
// choosing who a thing is for is part of writing it down, not an afterthought —
// and because a private thing filed as shared by accident is the one mistake this
// app must not make easy.
import { S } from './state.js';
import { $, esc, toast, showScreen, ago, openSheet, closeSheet } from './util.js';
import { get, post, patch, del, applyWire } from './api.js';
import { initMap, renderMap, resolvePlaces } from './map.js';

let onChange = () => {};
let onBack = () => {};
let editing = null;      // item id open in the sheet
let editingVis = 'shared';
let tab = 'open';        // 'open' | 'done' | 'map'
// Which group you have tapped into. `undefined` = the group list itself,
// `null` = the untagged bucket, a string = that tag.
let group;

const VIS = [
  { id: 'private', label: 'Just me', hint: 'only you' },
  { id: 'shared', label: 'Us', hint: 'this list' },
  { id: 'public', label: 'Anyone', hint: 'all your people' },
];

export async function openSpace(id) {
  S.spaceId = id;
  S.compose = 'shared';
  tab = 'open';
  group = undefined;
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
    S.groups = b.groups || [];
    S.ungrouped = b.ungrouped || 0;
    S.grouped = !!b.grouped;
    // A group you were inside can stop existing while you are in it — somebody
    // untagged the last item. Fall back to the group list rather than showing an
    // empty screen with a crumb pointing at nothing.
    if (group !== undefined && group !== null
        && !S.groups.some(g => g.key === group)) group = undefined;
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
  // What it is, first and quietly. A plain thing says nothing — the badge is
  // for telling a film from a recipe at a glance, and when everything is a
  // thing there is nothing to tell apart.
  if (it.kind && it.kind !== 'thing') {
    bits.push(`<span class="chip kind k-${esc(it.kind)}">${esc(kindOf(it.kind).label)}</span>`);
  }
  if (it.visibility === 'private') bits.push('<span class="chip private">just you</span>');
  if (it.visibility === 'public') bits.push('<span class="chip public">anyone</span>');
  // A wish that drifted in from one of the author's other lists. Worth saying —
  // "Andrew wants to do this with anyone" reads differently from something
  // written here for you.
  if (it.fromElsewhere) bits.push(`<span class="chip elsewhere">${esc(it.author.name)}'s standing wish</span>`);
  for (const t of it.tags || []) bits.push(`<span class="chip tag-chip">${esc(t)}</span>`);
  const place = it.mod && it.mod.place;
  if (place) bits.push(`<span class="chip place">${esc(place.name)}</span>`);
  const link = it.mod && it.mod.link;
  // The link is the whole point of a recipe — you do not cook from a title —
  // so for the kinds that lead with one it is named rather than called "link".
  if (link) {
    const k = kindOf(it.kind);
    const lead = (k.mods || [])[0] === 'link';
    // Never the same word as the badge beside it: "Watch ↗" on a show, not a
    // second "SHOW".
    bits.push(`<a class="${lead ? 'go' : ''}" href="${esc(link.url)}"
      target="_blank" rel="noopener noreferrer">${
      lead ? `${esc(k.go || 'Open')} ↗` : 'link'}</a>`);
  }
  if (it.done && it.doneByName) bits.push(`<span class="who">${esc(it.doneByName)} ticked it off ${esc(ago(it.doneAt))}</span>`);
  else if (!it.mine) bits.push(`<span class="who">${esc(it.author.name)}</span>`);

  return `<div class="it ${it.done ? 'done' : ''}" data-it="${esc(it.id)}">
    <button class="tick" data-tick aria-label="${it.done ? 'Not done after all' : 'Done'}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.4l4.3 4.3L18.6 7.6"/></svg>
    </button>
    <div class="it-bd" data-open>
      <b>${esc(it.title)}</b>
      ${it.notes ? `<p>${esc(it.notes)}</p>` : ''}
      ${bits.length ? `<div class="it-meta">${bits.join('')}</div>` : ''}
    </div>
  </div>`;
}

// The same fold as lib/groups.js. Duplicated deliberately and kept to one line:
// the server decides WHICH groups exist and ships them; this only has to answer
// "is this item in the one I tapped".
// The kind being edited in the item sheet, held separately so cancelling leaves
// the stored item untouched — the same shape as `editingVis` beside it.
let editingKind = 'thing';

// A group is the set of items of one kind. The server decides WHICH groups
// exist and ships them (lib/groups.js); this only has to answer "is this item in
// the one I tapped", and `group` holds the kind id, so that is one comparison.
// `null` is the loose pile — the plain things, listed under the groups.
const inGroup = (items, key) => (key === null
  ? items.filter(i => (i.kind || 'thing') === 'thing')
  : items.filter(i => (i.kind || 'thing') === key));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// "September 2026", or just "September" inside the current year — the year is
// noise until it isn't.
function monthLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    ? MONTHS[d.getMonth()]
    : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// The record: what you actually did, newest first, under the month it happened
// in. This is the half of the app that isn't a to-do list — a list you finish is
// empty, and this is the thing that makes finishing worth something.
function recordHtml(done) {
  if (!done.length) {
    return `<div class="record-empty">Nothing ticked off yet.<br>
      This fills up on its own.</div>`;
  }
  const rows = [];
  let last = null;
  for (const it of done) {
    const label = monthLabel(it.doneAt || it.updatedAt || it.createdAt);
    if (label !== last) { rows.push(`<div class="month">${esc(label)}</div>`); last = label; }
    rows.push(itemHtml(it));
  }
  return rows.join('');
}

function render() {
  const sp = S.space;
  if (!sp) return;
  $('spaceTitle').textContent = sp.title;

  const open = S.items.filter(i => !i.done);
  const done = S.items.filter(i => i.done)
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  // The counts sit on the tabs, because "12 open / 31 done together" is the one
  // number that says how the list is going.
  const placed = S.items.filter(i => i.mod && i.mod.place).length;
  const LABEL = { open: 'To do', done: 'Done together', map: 'Map' };
  const COUNT = { open: open.length, done: done.length, map: placed };
  $('spaceTabs').querySelectorAll('[data-tab]').forEach((b) => {
    const k = b.dataset.tab;
    b.classList.toggle('on', tab === k);
    // The map tab used to hide until something had a place, on the theory that an
    // empty tab is clutter. In practice that hid the feature from the only person
    // who needed to discover it — and the empty state behind it already explains
    // exactly what to do, which makes the tab an affordance rather than clutter.
    b.hidden = false;
    b.innerHTML = `${LABEL[k]}${COUNT[k] ? `<span class="n">${COUNT[k]}</span>` : ''}`;
  });

  const list = $('itemList');
  list.hidden = tab === 'map';
  list.classList.remove('after-groups');
  $('mapWrap').hidden = tab !== 'map';
  list.classList.toggle('record', tab === 'done');
  // The composer has no job in the record or on the map — you do not add things
  // you have already done, and you do not type into a map.
  $('spaceScroll').nextElementSibling.hidden = tab !== 'open';

  // Groups only exist on the to-do side, and only when they say something. The
  // server decides that (lib/groups.js) so the rule lives in one place.
  const gs = (S.groups || []);
  const showGroups = tab === 'open' && S.grouped && group === undefined;
  $('groupList').hidden = !showGroups;
  $('crumb').hidden = !(tab === 'open' && group !== undefined);
  if (group !== undefined) {
    const g = gs.find(x => x.key === group);
    $('crumbName').textContent = group === null ? 'Everything else' : (g ? g.name : group);
  }

  if (tab === 'map') {
    renderMap();
  } else if (tab === 'done') {
    list.innerHTML = recordHtml(done);
  } else if (showGroups) {
    // Groups you tap into, and then — right there underneath, not behind another
    // tap — everything that isn't in one. Untagged things are the majority in
    // most lists and they are not a category; putting them behind an "Everything
    // else" row made you navigate to reach the ordinary case.
    $('groupList').innerHTML = gs.map(g => `<button class="g-row" data-g="${esc(g.key)}">
        <div class="g-bd"><b>${esc(g.name)}</b><small>${g.open} to do${
          g.count > g.open ? ` · ${g.count - g.open} done` : ''}</small></div>
        <div class="g-n">${g.open || '·'}</div><div class="chev">›</div>
      </button>`).join('');
    $('groupList').querySelectorAll('[data-g]').forEach((b) => {
      b.addEventListener('click', () => {
        group = b.dataset.g;
        render();
      });
    });
    const loose = inGroup(open, null);
    list.innerHTML = loose.map(itemHtml).join('');
    list.classList.add('after-groups');
  } else {
    const shown = group === undefined ? open : inGroup(open, group);
    list.innerHTML = shown.length
      ? shown.map(itemHtml).join('')
      : `<div class="empty">Nothing here yet.<br>What do you keep meaning to do together?</div>`;
  }

  list.querySelectorAll('[data-it]').forEach((row) => {
    const id = row.dataset.it;
    row.querySelector('[data-tick]').addEventListener('click', () => toggle(id));
    row.querySelector('[data-open]').addEventListener('click', () => openItem(id));
  });

  visRow($('visRow'), () => S.compose, (v) => { S.compose = v; });
}

/* ── kinds ──────────────────────────────────────────────────────────────── */

// The table lives on the server (lib/kinds.js) and arrives on the wire, so
// there is no second list here to fall out of step with it.
const kindList = () => ((S.wire && S.wire.kinds) && S.wire.kinds.length
  ? S.wire.kinds
  : [{ id: 'thing', label: 'Thing', plural: 'Things', mods: [] }]);
const kindOf = (id) => kindList().find(k => k.id === id) || kindList()[0];

// A row of kinds, used by both the composer and the item sheet — the same
// shape as visRow, and for the same reason: two copies of a control drift.
function kindPicker(el, read, write) {
  const paint = () => {
    const cur = read();
    el.innerHTML = kindList().map(k => `<button data-k="${esc(k.id)}"
      class="${k.id === cur ? 'on' : ''}">${esc(k.label)}</button>`).join('');
    el.querySelectorAll('[data-k]').forEach(b =>
      b.addEventListener('click', () => { write(b.dataset.k); paint(); }));
  };
  paint();
}

/* ── writing ────────────────────────────────────────────────────────────── */

async function add() {
  const input = $('newItem');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  try {
    const b = await post(`/api/space/${S.spaceId}/item`, {
      title,
      visibility: S.compose,
      // Written while inside a group, so it belongs to it. Typing into a group
      // and having the thing land outside it would be baffling. The group IS
      // the kind now, so this is the same promise through a different field.
      kind: group || 'thing',
    });
    applyWire(b.state);
    await refresh();
    onChange();
  } catch (_) { toast('Could not add that'); input.value = title; }
}

const calm = () => window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Finishing something, played out rather than announced.
//
// The row is animated IN PLACE and only then re-rendered — a re-render destroys
// the element, so anything that runs after it has nothing left to animate. The
// POST goes out at the same moment, so the network is never what you are waiting
// for; if it fails the row comes back and says why.
function celebrate(row) {
  if (!row || calm()) return Promise.resolve();
  const tick = row.querySelector('.tick');
  if (tick) {
    const bits = ['<i class="ripple"></i>'];
    // Six, spread evenly, each carrying its own angle. Enough to read as a
    // flourish; more would be a party.
    for (let i = 0; i < 6; i++) bits.push(`<i class="spark" style="--a:${i * 60}deg"></i>`);
    tick.insertAdjacentHTML('beforeend', bits.join(''));
  }
  row.classList.add('celebrating');

  return new Promise((done) => {
    setTimeout(() => {
      // Collapse from its real height, so the list closes up rather than snapping
      // when the re-render lands.
      row.style.maxHeight = `${row.scrollHeight}px`;
      row.classList.add('leaving');
      requestAnimationFrame(() => {
        row.style.maxHeight = '0px';
        row.style.paddingTop = '0px';
        row.style.paddingBottom = '0px';
      });
      setTimeout(done, 280);
    }, 420);
  });
}

async function toggle(id) {
  const it = S.items.find(x => x.id === id);
  if (!it) return;
  const finishing = !it.done;
  const row = $('itemList').querySelector(`[data-it="${CSS.escape(id)}"]`);

  // Optimistic, and in parallel: the animation and the request start together so
  // neither waits on the other.
  const sent = post(`/api/item/${id}/done`, { done: finishing });
  const shown = finishing ? celebrate(row) : Promise.resolve();

  it.done = finishing;
  if (!finishing) render();   // un-ticking is a state change, not an occasion

  try {
    const [b] = await Promise.all([sent, shown]);
    applyWire(b.state);
    await refresh();
    onChange();
  } catch (e) {
    await shown;              // let it finish rather than yanking it mid-flight
    it.done = !finishing;
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
  editingKind = it.kind || 'thing';
  kindPicker($('isKind'), () => editingKind, (k) => { editingKind = k; kindFields(); });
  kindFields();
  // Somebody else's wording is theirs. You can see it and tick it off; you cannot
  // rewrite it.
  const ro = !it.canEdit;
  for (const f of ['isName', 'isNotes', 'isPlace', 'isLink']) $(f).disabled = ro;
  // Somebody else's classification is theirs too — the picker goes with the
  // fields rather than sitting there looking tappable and doing nothing.
  $('isKind').closest('.fld').hidden = ro;
  $('isSave').hidden = ro;
  $('isDelete').hidden = ro;
  $('isVis').hidden = ro;
  editingVis = it.visibility;
  if (!ro) visRow($('isVis'), () => editingVis, (v) => { editingVis = v; });
  openSheet('itemSheet');
}

// Which fields the chosen kind puts in front of you.
//
// The kind SUGGESTS; it never confiscates. A field that already holds something
// stays on screen whatever the kind says, so reclassifying a row can never hide
// — and then, on save, silently drop — an address you typed. Only genuinely
// empty irrelevant fields fold away.
function kindFields() {
  const k = kindOf(editingKind);
  const mods = k.mods || [];
  const show = (id, wanted, keep) => { $(id).hidden = !(wanted || keep); };
  show('isLinkFld', mods.includes('link'), !!$('isLink').value.trim());
  show('isPlaceFld', mods.includes('place'), !!$('isPlace').value.trim());
  // "Recipe link" says what to paste. "Link" makes you guess.
  $('isLinkLabel').innerHTML = mods[0] === 'link'
    ? `${esc(k.label)} link <em>the point of it</em>`
    : 'Link <em>optional</em>';
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
      kind: editingKind,
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

  // Inside a group, back means back to the groups — not out of the list entirely.
  $('spaceBack').addEventListener('click', () => {
    if (tab === 'open' && group !== undefined) { group = undefined; return render(); }
    onBack();
  });
  $('crumb').addEventListener('click', () => { group = undefined; render(); });
  $('spaceTabs').querySelectorAll('[data-tab]').forEach((b) => {
    b.addEventListener('click', async () => {
      tab = b.dataset.tab;
      render();
      // Resolving a place name costs a request each and Nominatim is one a
      // second, so it happens when the map is opened rather than on every render.
      if (tab === 'map' && await resolvePlaces()) { await refresh(); }
    });
  });
  initMap((id) => openItem(id));
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
