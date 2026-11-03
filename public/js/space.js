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
import { calendarHtml, dayKey, todayKey, dayLabel, timeLabel } from './calendar.js';

let onChange = () => {};
let onBack = () => {};
let editing = null;      // item id open in the sheet
let editingVis = 'shared';
let tab = 'open';        // 'open' | 'done' | 'cal' | 'map'
// Which month the calendar shows and which day is selected. Lives across
// renders, so ticking something off from the agenda doesn't page you away.
let cal = { month: null, sel: null };
const calToday = () => {
  const n = new Date();
  cal = { month: new Date(n.getFullYear(), n.getMonth(), 1), sel: todayKey() };
};
// Which kind you are looking at. Always one of them: the bottom nav IS the
// navigation now, so there is no "looking at the list of groups" state to be in
// and no way to be nowhere. Defaults to the kind everything starts as.
let kindTab = null;   // resolved on first render, once the wire has the table

const VIS = [
  { id: 'private', label: 'Just me', hint: 'only you' },
  { id: 'shared', label: 'Us', hint: 'this list' },
  { id: 'public', label: 'Anyone', hint: 'all your people' },
];

export async function openSpace(id) {
  S.spaceId = id;
  S.compose = 'shared';
  tab = 'open';
  kindTab = null;
  pillX = null;   // a new list starts on its first tab; nothing to travel from
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
    S.tabs = b.tabs || [];
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
  // No kind badge. It earned its place when one list held everything mixed
  // together; the bottom nav means every row on screen is already the kind the
  // tab says, so the badge had become a label repeating the page title once per
  // row. The link action still carries the identity where it is useful — COOK
  // on a recipe, WATCH on a film.
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
let editingKind = null;   // set from the item when the sheet opens

// Everything of one kind. `kindTab` holds the kind id, so this is one
// comparison; a null tab has not been resolved yet and means the default.
const inGroup = (items, key) =>
  items.filter(i => kindOrDefault(i) === (key || defaultKind()));

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
  // Resolved before anything reads it: every count and every filter below is
  // "of this kind", so the kind has to be settled first.
  if (!kindTab) kindTab = defaultKind();

  // One toggle. "To do" was a tab for the state you were already in, and the
  // count that mattered was never on it — the list underneath is the count.
  const doneBtn = $('tabDone');
  doneBtn.classList.toggle('on', tab === 'done');
  doneBtn.setAttribute('aria-pressed', String(tab === 'done'));
  // The number has to be the number of things the button would show you. It was
  // the whole list's done count while the list underneath was one kind's, so
  // tapping "Done together 15" on the Recipes tab produced two.
  const doneHere = inGroup(done, kindTab).length;
  doneBtn.innerHTML = `Done together${doneHere ? `<span class="n">${doneHere}</span>` : ''}`;
  $('tabCal').classList.toggle('on', tab === 'cal');
  $('tabCal').setAttribute('aria-pressed', String(tab === 'cal'));

  const list = $('itemList');
  // The map is parked until it has something worth showing. Its renderer and
  // every path into it are untouched — only the way in is gone — so turning it
  // back on is deleting this line and putting the control back.
  if (tab === 'map') tab = 'open';
  list.hidden = false;
  list.classList.remove('after-groups');
  $('mapWrap').hidden = tab !== 'map';
  list.classList.toggle('record', tab === 'done');
  // The composer has no job in the record or on the map — you do not add things
  // you have already done, and you do not type into a map.
  $('spaceScroll').nextElementSibling.hidden = tab !== 'open';

  // The bottom nav. One tab per kind, straight from the table on the server, so
  // adding a kind is still one line and still arrives everywhere at once.
  renderNav();
  // The calendar spans every kind, so a bar saying which kind you are looking
  // at would be a lie while it is open.
  $('kindNav').hidden = tab === 'cal';

  // Two axes, and they are orthogonal: WHICH KIND you are looking at, and
  // whether you want what is still to do or what you have already done.
  //
  // A third thing follows from the first: a kind with art is a shelf, not a
  // list. The server says which (`art` on the manifest) so there is no second
  // list of film-ish kinds here to fall out of step with it.
  const art = !!(kindList().find(k => k.id === kindTab) || {}).art;
  list.classList.toggle('shelf', art && tab === 'open');
  if (tab === 'cal') {
    if (!cal.sel) calToday();
    list.innerHTML = calendarHtml(S.items, cal, iconFor);
    bindCalendar(list);
  } else if (tab === 'done') {
    const seen = inGroup(done, kindTab);
    list.innerHTML = art && seen.length
      ? `<div class="grid">${seen.map(cardHtml).join('')}</div>`
      : recordHtml(seen);
  } else {
    const shown = inGroup(open, kindTab);
    list.innerHTML = shown.length
      ? (art ? `<div class="grid">${shown.map(cardHtml).join('')}</div>`
        : shown.map(itemHtml).join(''))
      : `<div class="empty">${esc(emptyLine())}</div>`;
  }

  list.querySelectorAll('[data-it]').forEach((row) => {
    const id = row.dataset.it;
    // All of them: a card has two ways in — the poster and the caption — and
    // its tick sits INSIDE the poster, so without stopping the click there,
    // marking something seen would also open it.
    row.querySelectorAll('[data-tick]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle(id);
    }));
    row.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openItem(id)));
  });

  // A poster that 404s must fall back to the typographic card, not sit there as
  // a broken-image glyph. TMDB paths go stale, art gets pulled, and the network
  // is the network — the card already has a way to look without a poster, so
  // use it rather than inventing a second failure state.
  list.querySelectorAll('.card .art img').forEach((img) => {
    img.addEventListener('error', () => {
      const art = img.closest('.art');
      const title = (art.closest('.card').querySelector('.cap b') || {}).textContent || '';
      img.remove();
      art.insertAdjacentHTML('afterbegin', `<div class="noart"><span>${esc(title)}</span></div>`);
    }, { once: true });
  });
  // Same for a provider's logo: the name is already in the alt, so show that.
  list.querySelectorAll('.card .prov img').forEach((img) => {
    img.addEventListener('error', () => {
      img.replaceWith(Object.assign(document.createElement('span'),
        { textContent: img.getAttribute('alt') || '' }));
    }, { once: true });
  });

  visRow($('visRow'), () => S.compose, (v) => { S.compose = v; });
  syncComposer();
}

// Who a new thing is for is a question about the thing you are writing, so it
// should not be sitting there before there is one. It appears on the first
// keystroke and goes again when the box is empty — which also gives the list
// back two rows of height for the whole time you are not typing.
function syncComposer() {
  $('visRow').hidden = !$('newItem').value.trim();
  // Ask for what you are looking at. "Something to do together…" under the
  // Recipes tab is the app forgetting which screen it is on.
  const k = kindList().find(x => x.id === kindTab);
  $('newItem').placeholder = (!k || k.id === defaultKind())
    ? 'Something to do together…'
    : `Add a ${k.label.toLowerCase()}…`;
}

/* ── kinds ──────────────────────────────────────────────────────────────── */

// The table lives on the server (lib/kinds.js) and arrives on the wire, so
// there is no second list here to fall out of step with it.
const kindList = () => ((S.wire && S.wire.kinds) && S.wire.kinds.length
  ? S.wire.kinds
  : [{ id: 'activity', label: 'Activity', plural: 'Activities', mods: [] }]);
// The first kind in the table IS the default — the one everything starts as.
// Read rather than written down, so renaming it on the server renames it here.
const defaultKind = () => kindList()[0].id;
const kindOrDefault = (it) => (it && it.kind) || defaultKind();
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

// The icons.
//
// Presentation, so they live here rather than in the kinds table — the server
// owns the vocabulary, the client owns how it looks. Keyed by id, and a kind
// added without one falls back to a plain mark rather than to nothing, so the
// nav can never ship a hole.
//
// One set, drawn to one spec: 24-unit box, 1.6 stroke, round caps and joins, no
// fills. That consistency is the whole job at this size — five icons from five
// different drawing conventions read as five mistakes.
const ICON = {
  // A spark. The app's own flourish when you finish something is sparks, so the
  // kind that means "something to do together" borrows it.
  activity: '<path d="M12 3.5l1.7 5.1a2 2 0 0 0 1.3 1.3l5.1 1.7-5.1 1.7a2 2 0 0 0-1.3 1.3L12 19.8l-1.7-5.2a2 2 0 0 0-1.3-1.3L3.9 11.6l5.1-1.7a2 2 0 0 0 1.3-1.3z"/>',
  // A strip of film. The sprockets are FILLED squares rather than more stroked
  // lines: at 23px a third and fourth hairline inside an 18px box turns to
  // mush, and the first attempt read as a book with two pages.
  movie: '<rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2.4"/>'
    + '<path d="M7.4 4.8v14.4M16.6 4.8v14.4"/>'
    + '<g fill="currentColor" stroke="none">'
    + '<rect x="4.6" y="7.4" width="1.6" height="1.6" rx=".4"/>'
    + '<rect x="4.6" y="11.2" width="1.6" height="1.6" rx=".4"/>'
    + '<rect x="4.6" y="15" width="1.6" height="1.6" rx=".4"/>'
    + '<rect x="17.8" y="7.4" width="1.6" height="1.6" rx=".4"/>'
    + '<rect x="17.8" y="11.2" width="1.6" height="1.6" rx=".4"/>'
    + '<rect x="17.8" y="15" width="1.6" height="1.6" rx=".4"/>'
    + '</g>',
  // A set with its ears up.
  show: '<rect x="3.2" y="7.6" width="17.6" height="11.6" rx="2.4"/><path d="M8.4 3.6L12 7.6l3.6-4"/>',
  // A pin.
  place: '<path d="M12 20.8s6.6-5.4 6.6-10.1a6.6 6.6 0 1 0-13.2 0C5.4 15.4 12 20.8 12 20.8z"/><circle cx="12" cy="10.5" r="2.4"/>',
  // A pot, steaming.
  recipe: '<path d="M4.4 10.2h15.2v4.6a4 4 0 0 1-4 4H8.4a4 4 0 0 1-4-4z"/><path d="M2.9 10.2h18.2"/><path d="M9 7.4c0-1.1 1-1.5 1-2.6M12.6 7.4c0-1.1 1-1.5 1-2.6"/>',
};
const FALLBACK = '<circle cx="12" cy="12" r="6.4"/>';

const iconFor = (id) => `<svg viewBox="0 0 24 24" aria-hidden="true" width="23" height="23"
  fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" stroke-linejoin="round">${ICON[id] || FALLBACK}</svg>`;

/* ── the shelf ──────────────────────────────────────────────────────────── */

// Films and shows are drawn as a grid of posters rather than a list of titles.
// A shelf of covers is how anybody actually chooses what to watch, and the
// poster carries information no title does: whether you have seen it, what sort
// of thing it is, whether you are in the mood for it.
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const posterSrc = (w) => (w && w.poster ? `${TMDB_IMG}/w342${w.poster}` : null);
const logoSrc = (p) => (p && p.logo ? `${TMDB_IMG}/w92${p.logo}` : null);

// A card with no art is NOT a hole where a poster should be. It is the title
// set in the display face on a tinted ground — a legitimate way for a card to
// look, so the grid reads properly before TMDB has answered, when TMDB has
// never heard of the thing, and forever if there is no key at all.
function cardHtml(it) {
  const w = (it.mod && it.mod.watch) || null;
  const src = posterSrc(w);
  const year = w && w.year ? String(w.year) : '';
  const prov = (w && w.providers) || [];
  return `<div class="card ${it.done ? 'done' : ''}" data-it="${esc(it.id)}">
    <div class="art" data-open>
      ${src
    ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">`
    : `<div class="noart"><span>${esc(it.title)}</span></div>`}
      ${it.done ? '<div class="seen">Seen</div>' : ''}
      <button class="tick" data-tick aria-label="${it.done ? 'Not done after all' : 'Done'}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.4l4.3 4.3L18.6 7.6"/></svg>
      </button>
    </div>
    <div class="cap" data-open>
      <b>${esc(it.title)}</b>
      ${year ? `<small>${esc(year)}</small>` : ''}
    </div>
    ${prov.length ? `<div class="prov">${prov.map(p => (logoSrc(p)
    ? `<img src="${esc(logoSrc(p))}" alt="${esc(p.name)}" title="${esc(p.name)}" loading="lazy">`
    : `<span>${esc(p.name)}</span>`)).join('')}</div>` : ''}
  </div>`;
}

/* ── calendar ─────────────────────────────────────────────────────────────── */

function bindCalendar(list) {
  list.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.day;
    cal.sel = k;
    const [y, m] = k.split('-').map(Number);
    // Tapping a greyed day from the next or last month takes you there.
    const moved = y !== cal.month.getFullYear() || m - 1 !== cal.month.getMonth();
    const dir = k > dayKey(cal.month) ? 1 : -1;
    if (moved) cal.month = new Date(y, m - 1, 1);
    render();
    if (moved) slideMonth(dir); else enterAgenda();
  }));
  list.querySelectorAll('[data-cal="prev"],[data-cal="next"]').forEach(b => b.addEventListener('click', () => {
    const dir = b.dataset.cal === 'next' ? 1 : -1;
    cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() + dir, 1);
    // Keep the selection inside the month you are looking at: today if it is
    // there, otherwise the first.
    const t = todayKey();
    cal.sel = t.slice(0, 7) === dayKey(cal.month).slice(0, 7) ? t : dayKey(cal.month);
    render();
    slideMonth(dir);
  }));
  list.querySelectorAll('.cal [data-open]').forEach(b =>
    b.addEventListener('click', () => openItem(b.dataset.open)));
  const plan = list.querySelector('[data-cal="plan"]');
  if (plan) plan.addEventListener('click', () => openPlan(cal.sel));
}

function slideMonth(dir) {
  const g = document.querySelector('.cal-grid');
  if (!g || calm() || !g.animate) return;
  g.animate([{ opacity: 0, transform: `translateX(${dir * 26}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
  enterAgenda();
}

function enterAgenda() {
  if (calm()) return;
  [...document.querySelectorAll('.cal-day > *')].forEach((el, i) => el.animate && el.animate(
    [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
    { duration: 300, delay: Math.min(i, 8) * 30, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }));
}

// Plan something for a day: pick from what is still to do and has no day yet.
// Every kind, because a Saturday can hold a film and a recipe.
let planDay = null;
function openPlan(k) {
  planDay = k;
  $('psTitle').textContent = `Plan for ${dayLabel(k).toLowerCase().replace(/^(sun|mon|tue|wed|thu|fri|sat)/, (w) => w[0].toUpperCase() + w.slice(1))}`;
  $('psTime').value = '';
  const open = S.items.filter(i => !i.done && !(i.when && i.when.date));
  $('psList').innerHTML = open.length
    ? open.map(it => `<button class="ag" data-plan="${esc(it.id)}">
        <span class="gl">${iconFor(it.kind)}</span>
        <span class="t"><b>${esc(it.title)}</b><small>${esc(kindOf(it.kind).label)}${
          it.mine ? '' : ` · ${esc(it.author.name)}`}</small></span></button>`).join('')
    : '<div class="ag-empty">Everything on the list already has a day.</div>';
  $('psList').querySelectorAll('[data-plan]').forEach(b => b.addEventListener('click', async () => {
    try {
      const r = await post(`/api/item/${b.dataset.plan}/when`, { date: planDay, time: $('psTime').value || null });
      applyWire(r.state);
      closeSheet('planSheet');
      await refresh();
      onChange();
    } catch (_) { toast('Could not plan that'); }
  }));
  openSheet('planSheet');
}

// The When field in the item sheet. Saves on change rather than on Save,
// because it is not the author's alone: someone who cannot edit the item has no
// Save button, and is still allowed to put it on a day.
function paintWhen(it) {
  const fld = $('isWhenFld');
  fld.hidden = !!it.done;              // the record says when it happened
  $('isDate').value = (it.when && it.when.date) || '';
  $('isTime').value = (it.when && it.when.time) || '';
  $('isTime').disabled = !$('isDate').value;
  $('isWhenClear').hidden = !it.when;
  $('isWhenBy').textContent = it.when && it.plannedByName
    ? `planned by ${it.plannedByName}` : '';
}

async function saveWhen() {
  const id = editing;
  const date = $('isDate').value;
  try {
    const r = await post(`/api/item/${id}/when`,
      date ? { date, time: $('isTime').value || null } : { clear: true });
    applyWire(r.state);
    const i = S.items.findIndex(x => x.id === id);
    if (i >= 0) S.items[i] = r.item;
    paintWhen(r.item);
    if (tab === 'cal') render();
  } catch (_) { toast('Could not set the day'); }
}

// One tab per kind, built from what the server shipped. Empty tabs stay: this
// is furniture, it has to be in the same place every time you look, and an
// empty one is how you make your first recipe.
function renderNav() {
  const tabs = (S.tabs && S.tabs.length) ? S.tabs
    : kindList().map(k => ({ ...k, count: 0 }));
  if (!kindTab) kindTab = defaultKind();
  const nav = $('kindNav');
  nav.innerHTML = tabs.map(k => `<button data-kind="${esc(k.id)}"
      class="${k.id === kindTab ? 'on' : ''}" aria-current="${k.id === kindTab ? 'page' : 'false'}">
      <span class="ic"><span class="gl">${iconFor(k.id)}</span></span>
      <b>${k.count ? `<i class="n">${k.count > 99 ? '99+' : k.count}</i>` : ''}${
        esc(k.plural)}</b>
      </button>`).join('') + '<span class="pill" aria-hidden="true"></span>';
  placePill(nav);
  nav.querySelectorAll('[data-kind]').forEach((b) => {
    b.addEventListener('click', () => {
      if (kindTab === b.dataset.kind) return;
      const ids = tabs.map(t => t.id);
      const dir = Math.sign(ids.indexOf(b.dataset.kind) - ids.indexOf(kindTab)) || 1;
      kindTab = b.dataset.kind;
      $('spaceScroll').scrollTop = 0;
      render();
      enter(dir);
      pop(nav.querySelector('button.on .gl'));
    });
  });
}

/* ── tab motion ─────────────────────────────────────────────────────────────
   The marker is ONE element that travels, rather than five backgrounds that
   switch — the eye follows a thing that moves, and a thing that appears in a
   new place has to be found. It stretches toward where it is going and settles
   with a little overshoot, which is what makes it read as physical.
   renderNav() rewrites the bar on every render, so the pill is re-created each
   time; `pillX` is what carries it from where it was to where it is now.
   Everything here is entrance-only and the render is synchronous, so the DOM is
   already in its final state the moment a tap lands — motion is decoration on
   top of a correct screen, never a gate in front of one. */
let pillX = null;

function placePill(nav) {
  const pill = nav.querySelector('.pill');
  const ic = nav.querySelector('button.on .ic');
  if (!pill || !ic) return;
  const n = nav.getBoundingClientRect(), r = ic.getBoundingClientRect();
  if (!n.width) return;                       // not laid out (screen hidden)
  const x = r.left - n.left;
  pill.style.cssText = `width:${r.width}px;height:${r.height}px;top:${r.top - n.top}px;transform:translateX(${x}px)`;
  const from = pillX;
  pillX = x;
  if (from === null || from === x || calm() || !pill.animate) return;
  const mid = (from + x) / 2;
  const stretch = 1 + Math.min(Math.abs(x - from) / r.width, 3) * 0.28;
  pill.animate([
    { transform: `translateX(${from}px) scaleX(1)` },
    { transform: `translateX(${mid}px) scaleX(${stretch})`, offset: 0.45 },
    { transform: `translateX(${x}px) scaleX(1)` },
  ], { duration: 440, easing: 'cubic-bezier(.34,1.45,.55,1)' });
}

// The icon you just chose gives a small spring, so the tap has an answer
// at the place you tapped as well as in the list.
function pop(el) {
  if (!el || calm() || !el.animate) return;
  el.animate([
    { transform: 'scale(.78)' }, { transform: 'scale(1.14)', offset: 0.55 }, { transform: 'scale(1)' },
  ], { duration: 380, easing: 'cubic-bezier(.3,.7,.4,1)' });
}

// The list arrives from the side you moved toward, one row after another.
// dir 0 (the Done toggle) rises instead, because that is a change of state,
// not a step sideways. Staggering stops after ten — anything later is below
// the fold, and waiting on it would only make the screen feel slow.
function enter(dir) {
  if (calm()) return;
  const list = $('itemList');
  const grid = list.querySelector('.grid');
  const els = [...(grid || list).children];
  els.forEach((el, i) => {
    if (!el.animate) return;
    el.animate([
      { opacity: 0, transform: dir ? `translateX(${dir * 22}px)` : 'translateY(10px)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 360, delay: Math.min(i, 10) * 28, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
  });
}

// What an empty tab says. Naming the kind is the difference between a dead end
// and an invitation — "nothing here yet" over and over tells you nothing about
// which screen you are on.
function emptyLine() {
  const k = kindList().find(x => x.id === kindTab);
  if (tab === 'done') return `Nothing finished here yet.`;
  if (!k || k.id === defaultKind()) return 'Nothing here yet. What do you keep meaning to do together?';
  return `No ${k.plural.toLowerCase()} yet. Add one below.`;
}

/* ── which one is it ────────────────────────────────────────────────────── */

// Five things are called "Obsession" and the one you mean is fourth. A poster
// is the fastest way a person recognises a film, and recognising is a thing
// people do instantly and matchers do badly — so the app asks instead of
// deciding, and asking costs one tap.
let picking = null;      // the item id being pinned

async function runSearch() {
  const q = $('pkQuery').value.trim();
  const it = (S.items || []).find(x => x.id === picking);
  if (!it) return;
  const box = $('pkResults');
  if (!q) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="cands-note">Looking…</div>';
  try {
    const b = await get(`/api/watch/search?kind=${encodeURIComponent(it.kind)}&q=${encodeURIComponent(q)}`);
    if (!b.ok && b.why) {
      box.innerHTML = `<div class="cands-note">${esc(b.why === 'no tmdb key'
        ? 'No TMDB key set, so there is nothing to search.' : b.why)}</div>`;
      return;
    }
    if (!b.results.length) {
      box.innerHTML = '<div class="cands-note">Nothing found. Try a different wording.</div>';
      return;
    }
    const cur = it.mod && it.mod.watch;
    box.innerHTML = b.results.map(r => `<button class="cand ${
      cur && cur.tmdbId === r.tmdbId ? 'on' : ''}" data-pick="${r.tmdbId}">
      <span class="pa">${r.poster
    ? `<img src="${esc(`${TMDB_IMG}/w154${r.poster}`)}" alt="" loading="lazy">`
    : '<span class="pn"></span>'}</span>
      <b>${esc(r.title)}</b>
      <small>${r.year ? esc(String(r.year)) : '—'}</small>
    </button>`).join('');
    box.querySelectorAll('[data-pick]').forEach((b2) => {
      b2.addEventListener('click', () => choose(Number(b2.dataset.pick)));
    });
  } catch (_) {
    box.innerHTML = '<div class="cands-note">Could not reach the server.</div>';
  }
}

async function choose(tmdbId) {
  const id = picking;
  if (!id) return;
  $('pkResults').innerHTML = '<div class="cands-note">Getting it…</div>';
  try {
    const b = await post(`/api/item/${id}/watch`, { tmdbId });
    applyWire(b.state);
    closeSheet('pickSheet');
    await refresh();
    onChange();
  } catch (_) { toast('Could not pin that one'); }
}

// `auto` is the add path: it opens straight onto results for what you typed.
export function openPick(id, auto = false) {
  const it = (S.items || []).find(x => x.id === id);
  if (!it) return;
  picking = id;
  const k = kindList().find(x => x.id === kindOrDefault(it)) || {};
  $('pkTitle').textContent = auto ? `Which ${(k.label || 'one').toLowerCase()}?` : 'Change which one';
  $('pkSub').textContent = esc(it.title);
  $('pkQuery').value = it.title;
  $('pkClear').hidden = !(it.mod && it.mod.watch);
  $('pkResults').innerHTML = '';
  openSheet('pickSheet');
  runSearch();
}

/* ── writing ────────────────────────────────────────────────────────────── */

async function add() {
  const input = $('newItem');
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  syncComposer();
  try {
    const b = await post(`/api/space/${S.spaceId}/item`, {
      title,
      visibility: S.compose,
      // Written while looking at Recipes, so it is a recipe. Typing into a tab
      // and watching the thing vanish out of it would be baffling — the same
      // promise writing inside a group used to make.
      kind: kindTab || defaultKind(),
    });
    applyWire(b.state);
    await refresh();
    onChange();
    // A film or a show: ask which one straight away, while you still have it in
    // mind. Nothing guesses with somebody standing there who could be asked.
    if (b.item && (kindList().find(k => k.id === b.item.kind) || {}).art) openPick(b.item.id, true);
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
  editingKind = kindOrDefault(it);
  kindPicker($('isKind'), () => editingKind, (k) => { editingKind = k; kindFields(); });
  kindFields();
  paintWatchRow(it);
  paintWhen(it);
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
  const it = (S.items || []).find(x => x.id === editing);
  if (it) paintWatchRow(it);
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

// What this film is pinned to, and the way to change it. Only for the kinds
// that have art, and it reflects the kind you have SELECTED rather than the one
// stored — switching a thing to Film in the sheet should offer to find it.
function paintWatchRow(it) {
  const art = !!(kindList().find(k => k.id === editingKind) || {}).art;
  $('isWatchFld').hidden = !art;
  if (!art) return;
  const w = it.mod && it.mod.watch;
  $('isWatch').innerHTML = w
    ? `<span class="pa">${w.poster
      ? `<img src="${esc(`${TMDB_IMG}/w154${w.poster}`)}" alt="">`
      : '<span class="pn"></span>'}</span>
       <span class="mb"><b>${esc(w.title || it.title)}</b>
       <small>${w.year ? esc(String(w.year)) : ''}</small></span>
       <span class="ch">Change</span>`
    : `<span class="pa"><span class="pn"></span></span>
       <span class="mb"><b>Not matched yet</b><small>No poster, no year</small></span>
       <span class="ch">Find it</span>`;
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

  $('spaceBack').addEventListener('click', () => {
    onBack();
  });
  // A toggle, not a tab: it flips between what you still mean to do and what
  // you have already done together.
  $('tabDone').addEventListener('click', () => {
    tab = tab === 'done' ? 'open' : 'done';
    render();
    enter(0);
  });
  // The calendar: a view across every kind, of what you did and what you mean
  // to. Opens on today, every time — the question is always "what's coming".
  $('tabCal').addEventListener('click', () => {
    tab = tab === 'cal' ? 'open' : 'cal';
    if (tab === 'cal') calToday();
    $('spaceScroll').scrollTop = 0;
    render();
    if (tab === 'cal') enterAgenda(); else enter(0);
    if (tab === 'open') placePill($('kindNav'));
  });
  for (const f of ['isDate', 'isTime']) $(f).addEventListener('change', () => {
    $('isTime').disabled = !$('isDate').value;
    saveWhen();
  });
  $('isWhenClear').addEventListener('click', () => { $('isDate').value = ''; $('isTime').value = ''; saveWhen(); });
  $('psCancel').addEventListener('click', () => closeSheet('planSheet'));
  $('planSheet').addEventListener('click', (e) => { if (e.target === $('planSheet')) closeSheet('planSheet'); });
  // Rotating moves every tab, so put the marker back under its icon — without
  // travelling, since nothing was chosen.
  window.addEventListener('resize', () => { pillX = null; placePill($('kindNav')); });
  initMap((id) => openItem(id));
  $('spaceMenu').addEventListener('click', openSettings);
  $('btnAdd').addEventListener('click', add);
  $('newItem').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  $('newItem').addEventListener('input', syncComposer);

  // The chooser, from the sheet and from the add path.
  $('isWatch').addEventListener('click', () => {
    if (!editing) return;
    closeSheet('itemSheet');
    openPick(editing, false);
  });
  let typing = null;
  $('pkQuery').addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(runSearch, 320);   // a keystroke is not a search
  });
  $('pkQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(typing); runSearch(); }
  });
  $('pkClear').addEventListener('click', async () => {
    try {
      applyWire((await post(`/api/item/${picking}/watch`, { clear: true })).state);
      closeSheet('pickSheet');
      await refresh();
      onChange();
    } catch (_) { toast('Could not clear that'); }
  });
  $('pkCancel').addEventListener('click', () => closeSheet('pickSheet'));
  $('pickSheet').addEventListener('click', (e) => {
    if (e.target === $('pickSheet')) closeSheet('pickSheet');
  });

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
