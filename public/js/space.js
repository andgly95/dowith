// One list: the things to do with somebody, and the composer for adding more.
//
// The visibility control sits ABOVE the input rather than behind a menu, because
// choosing who a thing is for is part of writing it down, not an afterthought —
// and because a private thing filed as shared by accident is the one mistake this
// app must not make easy.
import { S } from './state.js';
import { $, esc, toast, showScreen, ago, openSheet, closeSheet, leadEmoji, initialOf } from './util.js';
import { get, post, patch, del, applyWire } from './api.js';
import { calendarHtml, dayKey, todayKey, dayLabel, timeLabel } from './calendar.js';
import { initRose, openRose, peekRose } from './rose.js';
import { iconFor, icon } from './icons.js';
import { isPlaceKind, renderPlaces, initPlaces, openPlace, placesTyping, leavePlaces } from './pl.js';
import { tilesHtml, cardHtml as recipeCardHtml, bindRecipes, initRecipes, openRead, urlIn } from './recipes.js';
import { openRecipe, initRecipe } from './recipe.js';
import { initSwap } from './swap.js';
import { loadQuestion, questionCardHtml, bindQuestionCard, initQuestion, openQuestionSettings } from './question.js';
import { initKitchen } from './kitchen.js';
import { initCook } from './cook.js';
import { haptic, fadeIn, skeleton } from './motion.js';

let onChange = () => {};
let onBack = () => {};
let editing = null;      // item id open in the sheet
let editingVis = 'shared';
let tab = 'open';        // 'open' | 'done' | 'cal'
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
  { id: 'private', label: 'Just me', hint: 'only you', icon: 'lock' },
  { id: 'shared', label: 'Us', hint: 'this list', icon: 'people' },
  { id: 'public', label: 'Anyone', hint: 'all your people', icon: 'globe' },
];
// "Us" means somebody in particular. In a pair it names them — "you and
// Linnea" — because "this list" makes you work out who that is.
function visHint(v) {
  if (v.id !== 'shared') return v.hint;
  const sp = S.space;
  const me = S.wire && S.wire.me && S.wire.me.id;
  const other = sp && sp.isPair ? (sp.members || []).find(m => m.id !== me) : null;
  return other ? `you and ${other.name}` : v.hint;
}

export async function openSpace(id) {
  S.spaceId = id;
  S.compose = 'shared';
  leavePlaces();
  tab = 'open';
  kindTab = null;
  pillX = null;   // a new list starts on its first tab; nothing to travel from
  showScreen('scr-space');
  // The shape of a list, breathing, rather than the word "Loading…".
  $('itemList').innerHTML = skeleton();
  await refresh();
  peekRose();   // a dot on the rose if there is a match you have not seen
}

// Somebody else's screen may need repainting too — the shelf's counts.
export const changed = () => onChange();

// `arrived`: coming back to the app. Whatever is new since the list was last
// drawn glows as it lands — on this tab, or as a pop on the count of the tab it
// went to — so "Linnea added something" is something you see, not something
// you have to spot.
export async function refresh({ arrived = false } = {}) {
  if (!S.spaceId) return;
  const sid = S.spaceId;
  const before = arrived && S.items ? new Set(S.items.map(i => i.id)) : null;
  try {
    // Today's question comes with it, so the card is there on the first paint.
    const [b] = await Promise.all([get(`/api/space/${sid}/items`), loadQuestion(sid)]);
    if (S.spaceId !== sid) return;   // moved to another list meanwhile
    S.space = b.space;
    S.items = b.items;
    S.groups = b.groups || [];
    S.tabs = b.tabs || [];
    // A row mid-celebration would be destroyed by a repaint; its own refresh
    // follows the moment it finishes.
    if (arrived && $('itemList').querySelector('.celebrating')) return;
    render();
    if (before) landed(S.items.filter(i => !before.has(i.id)));
  } catch (_) { if (!arrived) toast('Could not load that list'); }
}

function landed(items) {
  if (!items.length) return;
  const tabs = new Set();
  for (const it of items) {
    const row = $('itemList').querySelector(`[data-it="${CSS.escape(it.id)}"]`);
    if (row) row.classList.add('arrived');
    else if (!it.done) tabs.add(kindOrDefault(it));
  }
  for (const k of tabs) pop($('kindNav').querySelector(`[data-kind="${CSS.escape(k)}"] .n`));
}

/* ── render ─────────────────────────────────────────────────────────────── */

// One three-way control, used by both the composer and the item sheet. `read`
// and `write` are passed in so the control never has to know which of the two it
// is driving — and so picking a value repaints from the same source of truth it
// just wrote to, rather than from a copy.
export function visRow(el, read, write) {
  const big = el.classList.contains('big');
  const paint = () => {
    const cur = read();
    el.innerHTML = VIS.map(v => `<button type="button" data-v="${v.id}" class="${v.id === cur ? 'on' : ''}"
      aria-pressed="${v.id === cur}">${big ? icon(v.icon, 19) : ''}
      <b>${esc(v.label)}</b><span>${esc(visHint(v))}</span></button>`).join('');
    el.querySelectorAll('[data-v]').forEach(b =>
      b.addEventListener('click', () => { write(b.dataset.v); paint(); }));
  };
  paint();
}

// `sectioned` is the to-do list split by whose idea each thing was, where the
// heading already says whose it is and a name on every row would repeat it.
function itemHtml(it, { sectioned = false } = {}) {
  const bits = [];
  // No kind badge. It earned its place when one list held everything mixed
  // together; the bottom nav means every row on screen is already the kind the
  // tab says, so the badge had become a label repeating the page title once per
  // row. The link action still carries the identity where it is useful — COOK
  // on a recipe, WATCH on a film.
  if (it.visibility === 'private') bits.push('<span class="chip private">Just you</span>');
  if (it.visibility === 'public') bits.push('<span class="chip public">Anyone</span>');
  // A wish that drifted in from one of the author's other lists. Worth saying —
  // "Andrew wants to do this with anyone" reads differently from something
  // written here for you.
  if (it.fromElsewhere) bits.push(`<span class="chip elsewhere">${esc(it.author.name)}'s standing wish</span>`);
  for (const t of it.tags || []) bits.push(`<span class="chip">${esc(t)}</span>`);
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
      lead ? `${esc(k.go || 'Open')} ↗` : 'Link'}</a>`);
  }
  const madeAt = it.done && Array.isArray(it.cooked) && it.cooked.length ? it.cooked[it.cooked.length - 1] : null;
  if (madeAt) {
    // "Made Nov 17 · Can't wait": a recipe's record says when, and whether again.
    const again = { soon: 'Can’t wait', maybe: 'Maybe someday', once: 'Once was enough' }[madeAt.again];
    bits.push(`<span class="who">Made ${esc(new Date(madeAt.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</span>`);
    if (again) bits.push(`<span class="who">${esc(again)}</span>`);
  } else if (it.done && it.doneByName) bits.push(`<span class="who">${esc(it.doneByName)} ticked it off ${esc(ago(it.doneAt))}</span>`);
  // Under a heading saying it was your idea, a row you did not type says who
  // did — the same owning-up as "edited by" in the sheet.
  else if (sectioned) { if (!it.mine && it.ideaBy !== it.author.id) bits.push(`<span class="who">via ${esc(it.author.name)}</span>`); }
  else if (!it.mine) bits.push(`<span class="who">${esc(it.author.name)}</span>`);

  return rowHtml(it, bits);
}

// One row: [emoji tile] [title / one line of meta] [ring]. The tile shows the
// title's leading emoji — presentation only, the stored title is untouched —
// or the kind's icon when there is none. `by` puts whose idea it was on the
// tile's corner, for a list with no sections to say it.
export function tileHtml(it, { by = null, big = false } = {}) {
  const { emoji } = leadEmoji(it.title);
  return `<span class="etile${big ? ' big' : ''}" aria-hidden="true">${
    emoji ? esc(emoji) : iconFor(kindOrDefault(it), big ? 27 : 22)}${
    by ? `<span class="by">${esc(by)}</span>` : ''}</span>`;
}

export function rowHtml(it, bits, { by = null, sel = false } = {}) {
  const { rest } = leadEmoji(it.title);
  return `<div class="it ${it.done ? 'done' : ''}${sel ? ' sel' : ''}" data-it="${esc(it.id)}">
    ${tileHtml(it, { by })}
    <div class="it-bd" data-open>
      <b>${esc(rest)}</b>
      ${it.notes ? `<p>${esc(it.notes)}</p>` : ''}
      ${bits.length ? `<div class="it-meta">${bits.join('')}</div>` : ''}
    </div>
    <button class="tick" data-tick aria-label="${it.done ? 'Not done after all' : 'Done'}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.4l4.3 4.3L18.6 7.6"/></svg>
    </button>
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

// Whose idea each thing was, as sections — theirs first, yours last. A list you
// keep WITH someone is two people's wishes, and "one of yours tonight, one of
// mine next time" needs to be able to see which are which. Ordered by person,
// not interleaved, so the split is the first thing you see; within a section the
// order is the list's own, newest first.
//
// Keyed on `ideaBy`, which the server always fills — with the author when nobody
// was credited, and with the author again when the viewer may not be told who
// was (SP.ideaOf), so a name can never arrive here that should not.
function byIdea(items) {
  // "Yours" is decided against who is signed in, not only against the server's
  // flag: the order must hold — hers above yours — even on a wire that lacks it.
  const me = S.wire && S.wire.me && S.wire.me.id;
  const out = new Map();
  for (const it of items) {
    const id = it.ideaBy || it.author.id;
    if (!out.has(id)) {
      out.set(id, { id, name: it.ideaByName || it.author.name, mine: id === me || !!it.ideaMine, items: [] });
    }
    out.get(id).items.push(it);
  }
  return [...out.values()].sort((a, b) => (a.mine - b.mine)
    || (b.items.length - a.items.length) || a.name.localeCompare(b.name));
}

const whoseHd = (g) => `<div class="whose"><span class="av" aria-hidden="true">${esc(initialOf(g.name))}</span><b>${
  g.mine ? 'Your ideas' : `${esc(g.name)}'s ideas`}</b><span class="n">${g.items.length}</span></div>`;

// The record: what you actually did, newest first, under the month it happened
// in. This is the half of the app that isn't a to-do list — a list you finish is
// empty, and this is the thing that makes finishing worth something.
function recordHtml(done) {
  if (!done.length) {
    return `<div class="record-empty">Nothing ticked off yet.<br>
      This fills up on its own.</div>`;
  }
  // A month is a heading; its rows are one card, like a section of the list.
  const months = [];
  for (const it of done) {
    const label = monthLabel(it.doneAt || it.updatedAt || it.createdAt);
    if (!months.length || months[months.length - 1].label !== label) months.push({ label, items: [] });
    months[months.length - 1].items.push(it);
  }
  return months.map(m => `<div class="month">${esc(m.label)}</div><div class="group">${
    m.items.map(it => itemHtml(it)).join('')}</div>`).join('');
}

// What the count in the corner says it is counting. "8 to watch" on Films
// reads like the app knows which screen it is on; "8 to do" does not.
const VERB = { movie: 'to watch', show: 'to watch', place: 'to go', recipe: 'to make' };

export function render() {
  const sp = S.space;
  if (!sp) return;
  $('spaceTitle').textContent = sp.title;
  // The rose is for two people. A group list has no inventory, and no corner
  // button pretending it might.
  $('spaceRose').hidden = !sp.isPair;
  $('plRose').hidden = !sp.isPair;

  const open = S.items.filter(i => !i.done);
  const done = S.items.filter(i => i.done)
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  // Resolved before anything reads it: every count and every filter below is
  // "of this kind", so the kind has to be settled first.
  if (!kindTab) kindTab = defaultKind();

  // Places is a map with the list under it — the same two states (to go, been)
  // as every other tab, drawn differently. The calendar spans every kind, so it
  // is never the Places screen.
  const placeTab = (tab === 'open' || tab === 'done') && isPlaceKind(kindOf(kindTab));
  $('scr-space').classList.toggle('places', placeTab);
  $('placesTop').hidden = !placeTab;

  // One toggle. "To do" was a tab for the state you were already in, and the
  // count that mattered was never on it — the list underneath is the count.
  // Its icon and its number only: the words are the aria-label, because on a
  // narrow phone the words were what wrapped.
  const doneBtn = $('tabDone');
  doneBtn.classList.toggle('on', tab === 'done');
  doneBtn.setAttribute('aria-pressed', String(tab === 'done'));
  // The number has to be the number of things the button would show you. It was
  // the whole list's done count while the list underneath was one kind's, so
  // tapping "Done together 15" on the Recipes tab produced two.
  const doneHere = inGroup(done, kindTab).length;
  const openHere = inGroup(open, kindTab).length;
  doneBtn.innerHTML = `<span class="ok">${icon('check', 19)}</span>${doneHere ? `<span class="n">${doneHere}</span>` : ''}`;
  doneBtn.setAttribute('aria-label', `Done together${doneHere ? `, ${doneHere}` : ''}`);
  $('tabCal').classList.toggle('on', tab === 'cal');
  $('tabCal').setAttribute('aria-pressed', String(tab === 'cal'));
  // No Map chip any more: the Places tab is the map. A chip that opened a second,
  // lesser map of the same places was one way too many to get to it.
  $('spaceCount').textContent = tab === 'done' ? `${doneHere} done together`
    : tab === 'cal' ? 'Across every kind'
      : `${openHere} ${VERB[kindTab] || 'to do'}`;

  const list = $('itemList');
  list.classList.remove('after-groups');
  list.classList.toggle('record', tab === 'done' && !placeTab);
  list.classList.toggle('pl-list', placeTab);
  // The composer has no job in the record or the calendar — you do not add
  // things you have already done.
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
  const together = (sp.members || []).length > 1;
  if (placeTab) {
    renderPlaces(list, { open: inGroup(open, kindTab), done: inGroup(done, kindTab), been: tab === 'done' });
  } else if (tab === 'cal') {
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
    // A kind that cooks (recipes) is a shelf of cards under the kitchen tiles.
    const cook = !!(kindList().find(k => k.id === kindTab) || {}).cook;
    // Each section's rows are one card; a shelf's are a grid of posters.
    const rows = (xs) => (cook ? `<div class="rgrid">${xs.map(it => recipeCardHtml(it, { sectioned: together })).join('')}</div>`
      : art ? `<div class="grid">${xs.map(cardHtml).join('')}</div>`
        : `<div class="group">${xs.map(it => itemHtml(it, { sectioned: together })).join('')}</div>`);
    // Split by whose idea it was whenever there is anyone to split it with. A
    // single heading is still worth having: "all four recipes are Linnea's" is
    // exactly the kind of thing this is for.
    // Today's question sits at the top of a pair list, above whose idea
    // everything was, on every tab but Places and Done together.
    list.innerHTML = questionCardHtml() + (cook ? tilesHtml() : '') + (!shown.length ? `<div class="empty">${esc(emptyLine())}</div>`
      : together ? byIdea(shown).map(g => whoseHd(g) + rows(g.items)).join('')
        : rows(shown));
    bindQuestionCard(list);
    if (cook) bindRecipes(list);
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

  fadeIn(list);

  visRow($('visRow'), () => S.compose, (v) => { S.compose = v; });
  syncComposer();
}

// For the Places screen, which switches between To go and Been itself.
export function setTab(t) {
  tab = t;
  $('spaceScroll').scrollTop = 0;
  render();
  enter(0);
}
export const currentTab = () => tab;

// Who a new thing is for is a question about the thing you are writing, so it
// should not be sitting there before there is one. It appears on the first
// keystroke and goes again when the box is empty — which also gives the list
// back two rows of height for the whole time you are not typing.
function syncComposer() {
  const typed = $('newItem').value.trim();
  $('visRow').hidden = !typed;
  // Emptied by hand: whatever comes next is not the answer it was holding.
  if (!typed) credit = null;
  // The + inside the pill fills in once there is something for it to add.
  $('newItem').closest('.comp-in').classList.toggle('has', !!typed);
  // Ask for what you are looking at. "Something to do together…" under the
  // Recipes tab is the app forgetting which screen it is on.
  const k = kindList().find(x => x.id === kindTab);
  $('newItem').placeholder = (!k || k.id === defaultKind())
    ? 'Something to do together…'
    : k.cook ? `Add a ${k.label.toLowerCase()}, or paste a link…`
      : `Add a ${k.label.toLowerCase()}…`;
  // Under Places, typing is also searching — see pl.js.
  if (isPlaceKind(k) && tab === 'open') placesTyping($('newItem').value);
}

/* ── kinds ──────────────────────────────────────────────────────────────── */

// The table lives on the server (lib/kinds.js) and arrives on the wire, so
// there is no second list here to fall out of step with it.
export const kindList = () => ((S.wire && S.wire.kinds) && S.wire.kinds.length
  ? S.wire.kinds
  : [{ id: 'activity', label: 'Activity', plural: 'Activities', mods: [] }]);
// The first kind in the table IS the default — the one everything starts as.
// Read rather than written down, so renaming it on the server renames it here.
export const defaultKind = () => kindList()[0].id;
export const kindOrDefault = (it) => (it && it.kind) || defaultKind();
export const kindOf = (id) => kindList().find(k => k.id === id) || kindList()[0];

// A row of kinds, used by both the composer and the item sheet — the same
// shape as visRow, and for the same reason: two copies of a control drift.
export function kindPicker(el, read, write) {
  const paint = () => {
    const cur = read();
    el.innerHTML = kindList().map(k => `<button type="button" data-k="${esc(k.id)}"
      class="${k.id === cur ? 'on' : ''}" aria-pressed="${k.id === cur}">${iconFor(k.id, 18)}${esc(k.label)}</button>`).join('');
    el.querySelectorAll('[data-k]').forEach(b =>
      b.addEventListener('click', () => { write(b.dataset.k); paint(); }));
  };
  paint();
}

// The icons live in icons.js — one set, shared with the Places screen.

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
    ? `<img class="fade" src="${esc(src)}" alt="" loading="lazy" decoding="async">`
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
  $('isWhenBy').textContent = whenHint(it);
}

// Under a When field: who planned it, or — before anybody has — that the other
// person can, and that it saves as soon as you pick.
export function whenHint(it) {
  if (it.when && it.plannedByName) return `Planned by ${it.plannedBy === (S.wire && S.wire.me && S.wire.me.id) ? 'you' : it.plannedByName}.`;
  const me = S.wire && S.wire.me && S.wire.me.id;
  const others = ((S.space && S.space.members) || []).filter(m => m.id !== me);
  const who = others.length === 1 ? others[0].name : others.length ? 'The others' : null;
  return who ? `${who} can put it on a day too. Saves as soon as you pick.` : 'Saves as soon as you pick.';
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

// Where a finished thing went: the Done together count gives the same small
// spring, so the row leaving the list has somewhere to have gone.
export function doneLanded() {
  pop($('tabDone').querySelector('.n') || $('tabDone'));
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
export function enter(dir) {
  if (calm()) return;
  const list = $('itemList');
  // A shelf is a heading and a grid per person; the cards are what arrive.
  const els = [...list.children].flatMap(el => (el.classList.contains('grid') ? [...el.children] : [el]));
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

// An answer to today's question, turned into a thing to do: the Activities tab,
// the answer in the composer and selected so it can be trimmed, and — if it was
// theirs — credited to them once it is added (the author may; see Whose idea).
let credit = null;   // { uid, done }
export function composeFrom(text, creditTo, done) {
  tab = 'open';
  kindTab = defaultKind();
  render();
  enter(0);
  const input = $('newItem');
  input.value = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  syncComposer();
  credit = { uid: creditTo || null, done: done || null };
  input.focus();
  input.select();
}

async function add() {
  const input = $('newItem');
  const title = input.value.trim();
  if (!title) return;
  const c = credit;
  credit = null;
  // Under Recipes, a link is read first: the sheet shows what it found and
  // saves only when asked. Words around the link are the title; a bare link
  // takes the recipe's own name.
  const kk = kindList().find(x => x.id === (kindTab || defaultKind()));
  const url = kk && kk.cook ? urlIn(title) : null;
  if (url) {
    input.value = '';
    syncComposer();
    openRead({ url, title: title.replace(url, '').replace(/\s+/g, ' ').trim() });
    return;
  }
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
    if (c && b.item) {
      if (c.uid) { try { await patch(`/api/item/${b.item.id}`, { ideaBy: c.uid }); } catch (_) { /* still added, as yours */ } }
      if (c.done) c.done();
    }
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

  // A poster or a recipe card is a tile in a grid: it has no height to collapse
  // that would close the grid up. It shrinks away instead, a little later so
  // the art has visibly stepped back first, and hands over where every tile
  // was, so the shelf can glide shut once it has re-rendered (closeUp).
  if (row.matches('.card, .rcard')) {
    return new Promise((done) => {
      setTimeout(() => {
        const was = new Map([...$('itemList').querySelectorAll('[data-it]')]
          .map(el => [el.dataset.it, el.getBoundingClientRect()]));
        row.classList.add('leaving');
        setTimeout(() => done(was), 280);
      }, 560);
    });
  }

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

// The tiles that stayed glide from where they were to where they are now
// (first, last, invert, play), so a shelf closes up the way a list does
// instead of jumping a poster to the left.
function closeUp(was) {
  if (calm()) return;
  $('itemList').querySelectorAll('[data-it]').forEach((el) => {
    const a = was.get(el.dataset.it);
    if (!a || !el.animate) return;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
}

export async function toggle(id) {
  const it = S.items.find(x => x.id === id);
  if (!it) return;
  const finishing = !it.done;
  const row = $('itemList').querySelector(`[data-it="${CSS.escape(id)}"]`);

  // Optimistic, and in parallel: the animation and the request start together so
  // neither waits on the other.
  const sent = post(`/api/item/${id}/done`, { done: finishing });
  if (finishing) haptic('success');
  const shown = finishing ? celebrate(row) : Promise.resolve();

  it.done = finishing;
  if (!finishing) render();   // un-ticking is a state change, not an occasion

  try {
    const [b, was] = await Promise.all([sent, shown]);
    applyWire(b.state);
    await refresh();
    onChange();
    if (was) closeUp(was);
    if (finishing) doneLanded();
  } catch (e) {
    await shown;              // let it finish rather than yanking it mid-flight
    it.done = !finishing;
    render();
    toast(e.status === 403 ? 'That one is not yours to tick off' : 'Could not save that');
  }
}

/* ── one item, opened ───────────────────────────────────────────────────── */

export function openItem(id, { generic = false } = {}) {
  const it = S.items.find(x => x.id === id);
  if (!it) return;
  // A place has its own page — the map, the way there, the plan — rather than
  // the generic form. Whichever way in: a row, a pin, the calendar. A recipe
  // likewise; its page's Edit details asks for the generic sheet by name.
  if (!generic && isPlaceKind(kindOf(kindOrDefault(it)))) return openPlace(id);
  if (!generic && kindOf(kindOrDefault(it)).cook) return openRecipe(id);
  editing = id;
  // The header is the thing itself: its emoji in a tile, its words, and a line
  // saying whose idea it was and what kind of thing it is.
  const { rest } = leadEmoji(it.title);
  $('isEmoji').outerHTML = tileHtml(it, { big: true }).replace('class="etile big"', 'class="etile big" id="isEmoji"');
  $('isTitle').textContent = rest;
  $('isSub').textContent = `${ideaLine(it)} · ${kindOf(kindOrDefault(it)).label}`;
  // Said out loud when somebody else's hand was last on the wording — an admin
  // correcting a typo leaves the author's name on the row, so the sheet owns up.
  // Likewise when the idea was somebody else's: who typed it and whose it was
  // are both true, and the sheet says both.
  const credited = it.ideaBy && it.ideaBy !== it.author.id;
  $('isMeta').textContent = [
    credited || !it.mine ? `added by ${it.mine ? 'you' : it.author.name} ${ago(it.createdAt)}` : `added ${ago(it.createdAt)}`,
    credited ? (it.ideaMine ? 'your idea' : `${it.ideaByName}'s idea`) : null,
    it.editedByName ? `edited by ${it.editedByName}` : null,
  ].filter(Boolean).join(' · ');
  $('isName').value = it.title;
  $('isNotes').value = it.notes || '';
  $('isPlace').value = (it.mod && it.mod.place && it.mod.place.name) || '';
  editingPlace = it.mod && it.mod.place ? { ...it.mod.place } : null;
  hideSugs();
  $('isLink').value = (it.mod && it.mod.link && it.mod.link.url) || '';
  editingKind = kindOrDefault(it);
  kindPicker($('isKind'), () => editingKind, (k) => { editingKind = k; kindFields(); });
  kindFields();
  paintWatchRow(it);
  paintWhen(it);
  // Somebody else's wording is theirs. You can see it and tick it off; you cannot
  // rewrite it — unless the server says you can (an admin, correcting things).
  // `canEdit` is the server's answer, never worked out here.
  const ro = !it.canEdit;
  editingRo = ro;
  for (const f of ['isName', 'isNotes', 'isPlace', 'isLink']) $(f).disabled = ro;
  // Somebody else's classification is theirs too — the picker goes with the
  // fields rather than sitting there looking tappable and doing nothing.
  $('isKind').closest('.fld').hidden = ro;
  $('isSave').hidden = ro;
  $('isDelete').hidden = ro;
  // Who it is FOR — the author's, or an admin's. The server's answer again.
  const ownVis = !ro && !!it.canSetVisibility;
  $('isVis').hidden = !ownVis;
  $('isVisFld').hidden = !ownVis;
  editingVis = it.visibility;
  if (ownVis) visRow($('isVis'), () => editingVis, (v) => { editingVis = v; });
  paintIdea(it);
  paintWhere();
  openSheet('itemSheet');
}

// "Your idea", "Linnea's idea" — the header line in a sheet.
export function ideaLine(it) {
  const me = S.wire && S.wire.me && S.wire.me.id;
  const id = it.ideaBy || it.author.id;
  return id === me || it.ideaMine ? 'Your idea' : `${it.ideaByName || it.author.name}'s idea`;
}

// Whose idea it was. On something you wrote, or on anything if you are an admin
// (`canCredit` is the server's answer), to anyone in the list it lives in —
// that list's members, not this screen's: a standing wish from another list is
// credited among ITS people.
let editingIdea = null;
let openedIdea = null;
// Returns the control's state, so the place page can use the same one.
export function ideaControl(it, fld, el) {
  const home = ((S.wire && S.wire.spaces) || []).find(s => s.id === it.spaceId);
  const people = home ? home.members : [];
  const me = S.wire && S.wire.me && S.wire.me.id;
  const offer = !!it.canCredit && people.length > 1;
  const st = { value: it.ideaBy || it.author.id, opened: it.ideaBy || it.author.id, offer };
  fld.hidden = !offer;
  if (!offer) return st;
  // You first, then everyone else in the list.
  const order = [...people].sort((a, b) => (b.id === me) - (a.id === me));
  const paint = () => {
    el.innerHTML = order.map(p => `<button type="button" data-v="${esc(p.id)}"
      class="${p.id === st.value ? 'on' : ''}" aria-pressed="${p.id === st.value}">${p.id === me ? 'Mine' : `${esc(p.name)}'s`}</button>`).join('');
    el.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => {
      st.value = b.dataset.v;
      paint();
    }));
  };
  paint();
  return st;
}
let ideaState = null;
function paintIdea(it) {
  ideaState = ideaControl(it, $('isIdeaFld'), $('isIdea'));
  editingIdea = openedIdea = ideaState.value;
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

/* ── where is it ─────────────────────────────────────────────────────────────
   The Where field suggests real places as you type (lib/places.js), and the one
   you tap is kept WITH its coordinates, so it lands on the map exactly where you
   meant. Typing a name and not picking still works — it is looked up later, the
   old way — and the line under the field says which of the two you have. */

let editingPlace = null;   // what was picked, or what the item already had
let editingRo = true;
let sugs = [];
let sugSeq = 0;
let sugTimer = null;

// The place to send: the picked one if the box still says its name, otherwise
// whatever was typed, as a bare name. Editing the text after picking unpicks it,
// because the coordinates belong to the place you tapped, not to your edit.
function placeToSave() {
  const typed = $('isPlace').value.trim();
  if (!typed) return null;
  const p = editingPlace && editingPlace.name === typed ? editingPlace : null;
  return p && typeof p.lat === 'number'
    ? { name: p.name, address: p.address || null, lat: p.lat, lon: p.lon }
    : { name: typed };
}

function paintWhere() {
  const el = $('isPlaceAt');
  const p = placeToSave();
  const pinned = !!(p && typeof p.lat === 'number');
  el.classList.toggle('pinned', pinned);
  el.textContent = !p ? ''
    : pinned ? (p.address || 'On the map')
      // Not something to nag somebody about who cannot change it.
      : editingRo ? '' : 'Just words for now — pick a suggestion to pin the exact place';
}

function hideSugs() {
  sugs = [];
  sugSeq++;                 // and anything still in flight lands nowhere
  clearTimeout(sugTimer);
  const box = $('isPlaceSug');
  box.hidden = true;
  box.innerHTML = '';
}

// "Ramen" should mean ramen near you. The middle of the pins already in this
// list is the best guess there is without asking the phone where it is — and
// the median, so one place on holiday does not drag it into the ocean.
function nearHere() {
  const pts = (S.items || []).map(i => i.mod && i.mod.place)
    .filter(p => p && typeof p.lat === 'number' && typeof p.lon === 'number');
  if (!pts.length) return null;
  const mid = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return { lat: mid(pts.map(p => p.lat)), lon: mid(pts.map(p => p.lon)) };
}

async function suggestPlaces(q) {
  const seq = ++sugSeq;
  const box = $('isPlaceSug');
  if (q.trim().length < 2) { hideSugs(); return; }
  const n = nearHere();
  let b;
  try {
    b = await get(`/api/place/suggest?q=${encodeURIComponent(q.trim())}${
      n ? `&lat=${n.lat}&lon=${n.lon}` : ''}`);
  } catch (_) { b = { ok: false, results: [] }; }
  if (seq !== sugSeq || editingRo) return;   // a later keystroke already asked
  sugs = b.results || [];
  if (!sugs.length) {
    // Nothing found is not an error — a place can be just a name. Only say
    // something when the suggestions themselves are unavailable.
    box.innerHTML = b.ok ? '' : '<div class="sugs-note">No suggestions right now — it will be kept as words.</div>';
    box.hidden = b.ok;
    return;
  }
  box.innerHTML = sugs.map((s, i) => `<button type="button" class="sug" data-sug="${i}">
      <b>${esc(s.name)}</b><small>${esc([s.what, s.address].filter(Boolean).join(' · '))}</small>
    </button>`).join('')
    + '<div class="sugs-by">Places from OpenStreetMap</div>';
  box.hidden = false;
}

function pickPlace(i) {
  const s = sugs[i];
  if (!s) return;
  editingPlace = { name: s.name, address: s.address || null, lat: s.lat, lon: s.lon };
  $('isPlace').value = s.name;
  hideSugs();
  paintWhere();
  // A kind's fields fold away when empty; this one is not empty any more.
  kindFields();
}

// A kind whose only field is a place IS the place — "Toki Underground" under
// Places — so an empty Where field starts from the title rather than from
// nothing. Read off the manifest, not a hard-coded kind id.
function titleIsThePlace() {
  const mods = kindOf(editingKind).mods || [];
  return mods.length === 1 && mods[0] === 'place';
}

async function saveItem() {
  const it = S.items.find(x => x.id === editing);
  if (!it) return;
  const title = $('isName').value.trim();
  if (!title) return toast('It needs a name');
  const url = $('isLink').value.trim();
  try {
    const b = await patch(`/api/item/${editing}`, {
      title,
      kind: editingKind,
      notes: $('isNotes').value.trim(),
      // Only where it was offered. The server ignores it otherwise anyway.
      ...(it.canSetVisibility ? { visibility: editingVis } : {}),
      // Sent only when it changed, so saving a note never re-states the credit.
      ...(it.canCredit && ideaState && ideaState.value !== ideaState.opened ? { ideaBy: ideaState.value } : {}),
      // The module bag. The server drops anything it has no rules for, and
      // keeps the poster itself — that slice is not this sheet's to send.
      mod: {
        ...(placeToSave() ? { place: placeToSave() } : {}),
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
  // Today's question is a pair's; a group has none yet.
  $('ssQuestionBox').hidden = !sp.isPair;
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
  initPlaces();
  initRecipes();
  initRecipe();
  initSwap();
  initCook();
  initKitchen(() => { showScreen('scr-space'); render(); });
  $('spaceSettings').addEventListener('click', openSettings);
  $('spaceRose').addEventListener('click', () => openRose());
  initRose();
  initQuestion({ repaint: () => { if (S.space) render(); }, compose: composeFrom, openRose: (to) => openRose(to) });
  $('ssQuestion').addEventListener('click', () => { closeSheet('spaceSheet'); openQuestionSettings(); });
  $('btnAdd').addEventListener('click', add);

  // The Where field.
  $('isPlace').addEventListener('input', () => {
    paintWhere();
    clearTimeout(sugTimer);
    const q = $('isPlace').value;
    if (q.trim().length < 2) { hideSugs(); return; }
    sugTimer = setTimeout(() => suggestPlaces(q), 280);   // a keystroke is not a search
  });
  $('isPlace').addEventListener('focus', () => {
    if (editingRo || $('isPlace').value.trim() || !titleIsThePlace()) return;
    suggestPlaces($('isName').value);
  });
  // Delegated, and on the box rather than each row, because the rows are
  // rewritten on every keystroke. Deliberately NOT hidden on blur: on a phone
  // the input blurs before the tap on a suggestion lands, and hiding on blur
  // would make every suggestion untappable.
  $('isPlaceSug').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sug]');
    if (b) pickPlace(Number(b.dataset.sug));
  });
  $('isPlace').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('isPlaceSug').hidden) { e.stopPropagation(); hideSugs(); }
    // Enter takes the top suggestion — the one you were typing toward.
    if (e.key === 'Enter' && sugs.length) { e.preventDefault(); pickPlace(0); }
  });

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
