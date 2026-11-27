// Places: a map with the list under it, and a page for each place.
//
// The same items as every other tab — `place` is just the kind whose only
// field is a place — drawn the way you actually think about places: where they
// are, how far, and whether you have been. Their emojis are the pins.
//
// Built on the map and the place suggestions the app already has (OpenStreetMap
// tiles, Photon as you type, Nominatim for a place's hours), not Google: no key,
// no billing account, and the pins agree with the tiles because both are OSM.
// The handoff's Google design swaps in later at `lib/places.js` and here.
//
// Three rules carried over from the rest of the app:
//   · CHOOSING, NOT GUESSING. Nothing gets a pin unless somebody tapped the
//     place it is. Typing offers three; the + still adds it as words.
//   · The phone's position is used for distance and to bias the search, and is
//     never stored — not here, not on the server.
//   · Rights are the server's answers (canEdit, canCredit…), never worked out here.
import { S } from './state.js';
import { $, esc, toast, openSheet, closeSheet, leadEmoji, initialOf, metres, distLabel, shortDate, calm } from './util.js';
import { haptic, burst, skeleton } from './motion.js';
import { get, post, patch, del, applyWire } from './api.js';
import { createMap } from './map.js';
import { icon, iconFor } from './icons.js';
import { dayLabel, timeLabel } from './calendar.js';
import { wxOf, deg, hourWords } from './wx.js';
import {
  render, refresh, changed, rowHtml, visRow, kindList, kindOf, kindOrDefault,
  kindPicker, ideaControl, whenHint, setTab, tileHtml,
} from './space.js';
import { ideasNear, addIdea, askNote, ideaHtml } from './suggest.js';

// A kind whose only field is a place IS a place. Read off the manifest rather
// than a hard-coded id, the same test the Where field uses.
export const isPlaceKind = (k) => {
  const mods = (k && k.mods) || [];
  return mods.length === 1 && mods[0] === 'place';
};
const placeKindId = () => (kindList().find(isPlaceKind) || {}).id || 'place';

const AGAIN = [
  { id: 'soon', label: 'Can’t wait', line: 'Can’t wait to go back' },
  { id: 'maybe', label: 'Maybe someday', line: 'Maybe someday' },
  { id: 'once', label: 'Once was enough', line: 'Once was enough' },
];

let here = null;          // the phone's position, if it said; memory only
let askedHere = false;
let sel = null;           // the place whose pin is grown
let preds = [];           // Which one? — up to three, while typing
let predState = null;     // null | 'loading' | 'ok' | 'down'
let lastQ = '';
let predSeq = 0;
let predTimer = null;
let justPinned = null;    // { id, text, name } — for Undo
let shown = { open: [], done: [], been: false };
let big = null;           // the Places map
let snip = null;          // the map at the top of a place's page
let page = null;          // the place open in its page
let ideaSt = null;
let editingVis = 'shared';
let renaming = false;

const me = () => S.wire && S.wire.me && S.wire.me.id;
const pinOf = (it) => {
  const p = it && it.mod && it.mod.place;
  return p && typeof p.lat === 'number' && typeof p.lon === 'number' ? p : null;
};
const away = (p) => (here && p ? metres(here, p) : null);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function leavePlaces() {
  sel = null; preds = []; predState = null; lastQ = ''; justPinned = null; framed = null;
}

// Asked once, the first time the tab opens. Denied is fine: no distances, and
// the list sorts newest first instead.
function askHere() {
  if (askedHere || !navigator.geolocation) return;
  askedHere = true;
  try {
    navigator.geolocation.getCurrentPosition((pos) => {
      here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      render();
    }, () => {}, { maximumAge: 10 * 60 * 1000, timeout: 10000 });
  } catch (_) { /* no position, no distances */ }
}

/* ── the list under the map ─────────────────────────────────────────────── */

function placeLine(it) {
  if (it.done) {
    const again = AGAIN.find(a => a.id === (it.visit && it.visit.again));
    return [`Went ${shortDate(it.doneAt)}`, again ? again.line : null];
  }
  const p = it.mod && it.mod.place;
  const pin = pinOf(it);
  if (!pin) return [p && p.name ? p.name : 'Not on the map yet'];
  const { rest } = leadEmoji(it.title);
  return [p.name !== rest ? p.name : null, p.area, distLabel(away(pin))];
}

function sortPlaces(list, been) {
  if (been) return [...list].sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  // Closest first when the phone has said where it is; the unpinned after,
  // newest first, because there is nothing to measure them by.
  return [...list].sort((a, b) => {
    const da = away(pinOf(a)), db = away(pinOf(b));
    if (da !== null && db !== null) return da - db;
    if (da !== null) return -1;
    if (db !== null) return 1;
    return b.createdAt - a.createdAt;
  });
}

export function renderPlaces(list, { open, done, been }) {
  lastPlaces = [list, { open, done, been }];
  shown = { open, done, been };
  askHere();
  $('plGo').setAttribute('aria-pressed', String(!been));
  $('plBeen').setAttribute('aria-pressed', String(been));
  $('plGo').querySelector('.n').textContent = open.length ? String(open.length) : '';
  $('plBeen').querySelector('.n').textContent = done.length ? String(done.length) : '';

  const items = sortPlaces(been ? done : open, been);
  const sp = S.space || {};
  const n = items.length;
  const head = `<div class="pl-hd"><button type="button" class="grab" data-grab aria-label="${
      detent === 'list' ? 'Show more of the map' : 'Show more of the list'}"></button><div>
      <b>${been ? `${n || 'Nowhere'} ${n ? (n === 1 ? 'place' : 'places') : ''} you’ve been`.replace('Nowhere  you’ve been', 'Nowhere yet')
        : `${n} ${n === 1 ? 'place' : 'places'} to go`}</b>
      <small>with ${esc(sp.title || 'this list')} · ${been ? 'most recent first' : here ? 'closest first' : 'newest first'}</small>
    </div>
    <button type="button" class="round" data-plsug aria-label="Suggestions"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 4.2l1.7 4.6 4.6 1.7-4.6 1.7-1.7 4.6-1.7-4.6-4.6-1.7 4.6-1.7z"/><path d="M18 14.6l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/></svg></button>
    <button type="button" class="round" data-plcal aria-label="Calendar">${icon('cal', 19)}</button></div>`;

  let body;
  if (!been && (predState || preds.length)) {
    body = `<div class="preds-hd"><b>Which one?</b><small>Results from OpenStreetMap</small></div>${
      predState === 'loading' && !preds.length ? '<p class="preds-note">Looking…</p>'
        : !preds.length ? `<p class="preds-note">${predState === 'down'
          ? 'No suggestions right now. Tap + to add it as words.'
          : 'Nothing by that name nearby. Tap + to add it as words.'}</p>`
          : `<div class="preds">${preds.map((p, i) => `<button type="button" class="pred" data-pred="${i}">
              <span class="num">${i + 1}</span>
              <span class="pb"><b>${esc(p.name)}</b><small>${esc([p.what && cap(p.what), p.area || p.address].filter(Boolean).join(' · '))}</small></span>
              <span class="mi">${esc(distLabel(away(p)))}</span></button>`).join('')}</div>
            <p class="preds-note">Tap the right one to pin it. Tap + to add it as words, with no pin.</p>`}`;
  } else {
    const together = (sp.members || []).length > 1;
    body = (justPinned && !been ? `<div class="pinned-card">${icon('check', 22)}
        <span class="pb"><b>Pinned to the map</b><small>${esc(justPinned.name)}</small></span>
        <button type="button" data-undo>Undo</button></div>` : '')
      + (items.length ? `<div class="group">${items.map((it) => {
        const bits = placeLine(it).filter(Boolean).map(t => `<span>${esc(t)}</span>`);
        if (it.visibility === 'private') bits.unshift('<span class="chip private">Just you</span>');
        const oc = been ? '' : openChip(openStates.get(it.id));
        if (oc) bits.unshift(oc.replace('<span ', '<span data-oc '));
        return rowHtml(it, bits, {
          by: together ? initialOf(it.ideaByName || it.author.name) : null,
          sel: it.id === sel,
        });
      }).join('')}</div>`
        : `<p class="pl-empty">${been
          ? 'Nowhere yet. Tick a place off and it lands here.'
          : 'No places yet. Type one below — it suggests real ones as you go.'}</p>`);
  }
  list.innerHTML = head + body;

  list.querySelector('[data-plcal]').addEventListener('click', () => $('tabCal').click());
  list.querySelector('[data-plsug]').addEventListener('click', () => $('tabSug').click());
  // The grabber is a button too, for anyone not dragging: it steps between the
  // list and the map rather than leaving a gesture as the only way.
  list.querySelector('[data-grab]').addEventListener('click', () => snapTo(detent === 'half' ? 'list' : 'half'));
  list.querySelectorAll('[data-pred]').forEach(b => b.addEventListener('click', () => pinPrediction(Number(b.dataset.pred))));
  const undo = list.querySelector('[data-undo]');
  if (undo) undo.addEventListener('click', undoPin);
  drawBig();
  paintTabWeather();
  loadOpenStates();
}

/* ── the list is a sheet you can pull ─────────────────────────────────────
   Three heights, the ones a map app has: mostly MAP (the list's heading and a
   row showing), HALF (where it opens), and mostly LIST (the map a strip under
   the floating buttons). Drag the heading anywhere; drag the list down when it
   is at its top to see more map, or up while it is not yet as tall as it goes
   to see more list. Let go and it settles on the nearest — or the one a flick
   was heading for. Kept for the visit, not stored: it is how you are looking,
   not a setting. */
let detent = 'half';
let snapT = null;

function heights() {
  const H = $('scr-space').clientHeight || window.innerHeight;
  const fl = $('placesTop').querySelector('.pl-float');
  // The sheet tucks up over the map by its own top margin (-26px), so the
  // floor is that much lower or its edge slides under the floating buttons.
  const tuck = -parseFloat(getComputedStyle($('spaceScroll')).marginTop) || 0;
  const floor = (fl ? fl.offsetTop + fl.offsetHeight + 12 : 60) + tuck;
  const below = ($('kindNav').offsetHeight || 0) + ($('spaceScroll').nextElementSibling.offsetHeight || 0);
  const half = Math.round(Math.max(220, H * 0.44));
  return { list: Math.round(floor), half, map: Math.round(Math.max(half, H - below - 150)) };
}

function setTop(h) {
  const top = $('placesTop');
  top.style.flexBasis = `${Math.round(h)}px`;
  top.style.minHeight = '0px';
}

function snapTo(name) {
  const top = $('placesTop');
  const D = heights();
  if (!(name in D)) name = 'half';
  const changed = name !== detent;
  detent = name;
  clearTimeout(snapT);
  if (!calm()) top.classList.add('snapping');
  setTop(D[name]);
  if (changed) haptic('snap');
  const g = $('itemList').querySelector('[data-grab]');
  if (g) g.setAttribute('aria-label', name === 'list' ? 'Show more of the map' : 'Show more of the list');
  // The map is redrawn for its new size once it has one — keeping what was at
  // the top where it was, so the map does not jump as the list settles.
  snapT = setTimeout(() => { top.classList.remove('snapping'); if (big) big.resized(); }, calm() ? 0 : 330);
}

function listDrag() {
  const sc = $('spaceScroll');
  let g = null;
  sc.addEventListener('touchstart', (e) => {
    g = null;
    if (!$('scr-space').classList.contains('places') || e.touches.length !== 1) return;
    if (e.target.closest('input, textarea, select, [data-nodrag]')) return;
    const p = e.touches[0];
    g = { y0: p.clientY, x0: p.clientX, last: p.clientY, t: e.timeStamp, v: 0,
      h0: $('placesTop').offsetHeight, head: !!e.target.closest('.pl-hd'), live: false };
  }, { passive: true });
  sc.addEventListener('touchmove', (e) => {
    if (!g) return;
    const p = e.touches[0];
    if (!g.live) {
      const dy = p.clientY - g.y0, dx = p.clientX - g.x0;
      if (!dy && !dx) return;
      const D = heights();
      const ok = e.cancelable && Math.abs(dy) >= Math.abs(dx)
        && (g.head || (dy > 0 && sc.scrollTop <= 0) || (dy < 0 && g.h0 > D.list + 4));
      if (!ok) { g = null; return; }
      g.live = true;
      g.D = D;
      clearTimeout(snapT);
      $('placesTop').classList.remove('snapping');
    }
    e.preventDefault();
    const { list: lo, map: hi } = g.D;
    const raw = g.h0 + (p.clientY - g.y0);
    // Past either end it gives, grudgingly.
    setTop(raw < lo ? lo - (lo - raw) / 3 : raw > hi ? hi + (raw - hi) / 3 : raw);
    const dt = Math.max(1, e.timeStamp - g.t);
    g.v = 0.8 * ((p.clientY - g.last) / dt) + 0.2 * g.v;
    g.last = p.clientY;
    g.t = e.timeStamp;
  }, { passive: false });
  const end = () => {
    if (!g || !g.live) { g = null; return; }
    const { D, v } = g;
    g = null;
    const aim = $('placesTop').offsetHeight + v * 200;   // where a flick was heading
    snapTo(['list', 'half', 'map'].reduce((a, b) => (Math.abs(D[b] - aim) < Math.abs(D[a] - aim) ? b : a)));
  };
  sc.addEventListener('touchend', end);
  sc.addEventListener('touchcancel', end);
}

/* ── the map over the top ───────────────────────────────────────────────── */

function bubble(it, { selected = false } = {}) {
  const { emoji, rest } = leadEmoji(it.title);
  return `<span class="bub">${emoji ? esc(emoji) : iconFor(kindOrDefault(it), 19)}</span><i class="tip"></i>${
    selected ? `<span class="lab">${esc(rest)}</span>` : ''}`;
}

function bigPoints() {
  const { open, done, been } = shown;
  const pts = [];
  const choosing = !been && preds.length > 0;
  for (const it of been ? done : open) {
    const p = pinOf(it);
    if (!p) continue;
    pts.push({ id: it.id, lat: p.lat, lon: p.lon, label: it.title, fit: !choosing,
      cls: `epin ${been ? 'been' : 'go'}${it.id === sel ? ' sel' : ''}${!been && shutNow(it.id) ? ' shut' : ''}`, inner: bubble(it, { selected: it.id === sel }) });
  }
  // The other set stays as dots, so switching never empties the map.
  for (const it of been ? open : done) {
    const p = pinOf(it);
    if (p) pts.push({ lat: p.lat, lon: p.lon, cls: `mdot ${been ? 'go' : 'been'}`, fit: false });
  }
  preds.forEach((p, i) => pts.push({ id: `p:${i}`, lat: p.lat, lon: p.lon, cls: 'npin', inner: String(i + 1), label: p.name }));
  if (here) pts.push({ lat: here.lat, lon: here.lon, cls: 'you', fit: !pts.some(x => x.fit !== false) });
  return pts;
}

// Re-framed only when WHAT it shows changes — the other tab, a pin added or
// gone, suggestions arriving. Any other redraw keeps the view, or tapping a
// pin after you had zoomed in would throw the zoom away.
let framed = null;
function drawBig({ force = false } = {}) {
  if (!big) return;
  const key = JSON.stringify(bigPoints().filter(p => p.fit !== false).map(p => p.id || p.cls));
  if (force || key !== framed) { framed = key; big.refit(); } else big.render();
}

function select(id, { pan = true } = {}) {
  sel = id;
  render();
  if (pan && big) big.focus(id);
  const row = $('itemList').querySelector(`[data-it="${CSS.escape(id)}"]`);
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ── Which one? ─────────────────────────────────────────────────────────── */

// Called on every keystroke in the composer while the Places tab is open.
// Three characters before it asks, and a pause, because a keystroke is not a
// search. The emoji is not sent — Photon has never heard of "🍜".
export function placesTyping(value) {
  const q = leadEmoji(value).rest.trim();
  if (q === lastQ) return;
  lastQ = q;
  clearTimeout(predTimer);
  if (value.trim()) justPinned = null;
  if (q.length < 3) {
    if (preds.length || predState) { preds = []; predState = null; predSeq++; render(); }
    return;
  }
  predState = predState || 'loading';
  predTimer = setTimeout(() => fetchPreds(q), 280);
}

// Toward the phone if it said where it is; otherwise the middle of the pins
// already in this list — the median, so one holiday does not drag it away.
function biasPoint() {
  if (here) return here;
  const pts = (S.items || []).map(pinOf).filter(Boolean);
  if (!pts.length) return null;
  const mid = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return { lat: mid(pts.map(p => p.lat)), lon: mid(pts.map(p => p.lon)) };
}

async function fetchPreds(q) {
  const seq = ++predSeq;
  const b0 = biasPoint();
  let b;
  try {
    b = await get(`/api/place/suggest?q=${encodeURIComponent(q)}${b0 ? `&lat=${b0.lat}&lon=${b0.lon}` : ''}`);
  } catch (_) { b = { ok: false, results: [] }; }
  if (seq !== predSeq || lastQ !== q) return;     // a later keystroke already asked
  preds = (b.results || []).slice(0, 3);
  predState = b.ok ? 'ok' : 'down';
  render();
}

// One tap pins it: the item is created WITH the place you tapped, and the
// title stays exactly as typed.
async function pinPrediction(i) {
  const p = preds[i];
  if (!p) return;
  const input = $('newItem');
  const text = input.value.trim() || p.name;
  try {
    const b = await post(`/api/space/${S.spaceId}/item`, {
      title: text,
      visibility: S.compose,
      kind: placeKindId(),
      mod: { place: { name: p.name, address: p.address || null, lat: p.lat, lon: p.lon, area: p.area || null, what: p.what || null, osm: p.osm || null } },
    });
    applyWire(b.state);
    input.value = '';
    preds = []; predState = null; lastQ = ''; predSeq++;
    justPinned = { id: b.item.id, text, name: p.name };
    sel = b.item.id;
    await refresh();
    changed();
    if (big) big.focus(sel);
  } catch (_) { toast('Could not add that'); }
}

// Undo takes the place back off the list and puts your words back in the box.
async function undoPin() {
  const j = justPinned;
  if (!j) return;
  justPinned = null;
  try {
    applyWire(await del(`/api/item/${j.id}`));
    if (sel === j.id) sel = null;
    $('newItem').value = j.text;
    await refresh();
    changed();
    $('newItem').focus();
  } catch (_) { toast('Could not undo that'); }
}

/* ── one place, opened ──────────────────────────────────────────────────── */

const mapsUrl = (it) => {
  const p = pinOf(it);
  const place = it.mod && it.mod.place;
  const dest = p ? `${p.lat},${p.lon}` : (place && place.name) || leadEmoji(it.title).rest;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
};

/* ── suggest nearby ───────────────────────────────────────────────────────
   On a place's page: what else on the list is a walk from here, and — asked
   of Claude when the button is tapped, like every new idea (lib/ideas.js) —
   places and things to do around it that are not on the list yet.

   The first half is arithmetic over pins this phone already has, so it works
   with no key. The second asks about the place by NAME (and what it is, and
   its area), for the day and hour it is planned for when it has one. Nothing
   is added until somebody taps Add. */
const NEAR_M = 2000;       // about a 25 minute walk
let near = null;           // null until asked: { busy, ideas }
const canAskNear = () => !!(S.wire && S.wire.swap && S.wire.swap.suggest);
function nearOnList(it) {
  const p = pinOf(it);
  if (!p) return [];
  return (S.items || []).filter(x => x.id !== it.id && !x.done && pinOf(x) && isPlaceKind(kindOf(kindOrDefault(x))))
    .map(x => ({ it: x, m: metres(p, pinOf(x)) })).filter(x => x.m <= NEAR_M).sort((a, b) => a.m - b.m).slice(0, 5);
}
// As the crow flies, so "about": 80 metres a minute is an easy walk.
const walkWords = (m) => `about ${Math.max(1, Math.round(m / 80))} min walk`;
function paintNear(it) {
  const mine = nearOnList(it);
  const ask = canAskNear();
  $('plNear').hidden = !pinOf(it) || (!ask && !mine.length);
  if ($('plNear').hidden) return;
  $('plNearBtn').disabled = !!(near && near.busy);
  $('plNearBtn').querySelector('span').textContent = near && near.ideas && near.ideas.length ? 'Suggest different ones' : 'Suggest nearby';
  // Once the list's own places are showing and nothing can be asked, the button has said all it can.
  $('plNearBtn').hidden = !!near && !ask;
  const body = $('plNearBody');
  if (!near) { body.innerHTML = ''; return; }
  const plural = Object.fromEntries(kindList().map(k => [k.id, k.plural]));
  const onList = mine.length ? `<h3 class="sec">On your list, close by</h3><div class="group sg-list">${mine.map(({ it: x, m }) => `<button type="button" class="sg-it pl-nr" data-near="${esc(x.id)}">
      ${tileHtml(x)}<span class="sg-bd"><b>${esc(leadEmoji(x.title).rest)}</b><span class="sg-why">${esc([distLabel(m), walkWords(m)].filter(Boolean).join(' · '))}</span></span>${icon('chev', 18)}</button>`).join('')}</div>`
    : ask ? '' : '<p class="sg-none">Nothing else on your list is close to here.</p>';
  const fresh = !ask ? '' : `<h3 class="sec">Something new <em>not on your list yet</em></h3>${
    near.busy ? skeleton(3) : near.ideas && near.ideas.length ? `${askNote(near.ideas)}<div class="group sg-list">${near.ideas.map((x, i) => ideaHtml(x,
      `<button type="button" class="sg-add" data-nearadd="${i}"${x.added ? ' disabled' : ''}>${x.added ? 'On your list' : `Add to ${esc(plural[x.kind] || 'the list')}`}</button>`)).join('')}</div>`
      : '<p class="sg-none">Nothing new came back for around here.</p>'}`;
  body.innerHTML = onList + fresh;
  body.querySelectorAll('[data-near]').forEach(b => b.addEventListener('click', () => openPlace(b.dataset.near)));
  body.querySelectorAll('[data-nearadd]').forEach(b => b.addEventListener('click', async () => {
    const x = near && near.ideas && near.ideas[Number(b.dataset.nearadd)];
    if (!x) return;
    b.disabled = true;
    try {
      await addIdea(x);
      x.added = true;
      haptic('success');
      toast(`Added to ${plural[x.kind] || 'your list'}`);
    } catch (_) { toast('Could not add that'); }
    const now = pageItem();
    if (now) paintNear(now);
  }));
}
async function suggestNear() {
  const it = pageItem();
  if (!it || !pinOf(it) || (near && near.busy)) return;
  const id = it.id;
  near = { busy: canAskNear(), ideas: near ? near.ideas : null };
  haptic('tick');
  paintNear(it);
  if (!near.busy) return;
  // For when you will be there: its day and hour if it has one still to come.
  const w = it.when;
  const at = w && w.date && w.date >= localAt().slice(0, 10) ? `${w.date}T${w.time || '12:00'}` : localAt();
  let list = null;
  try { list = await ideasNear(id, at); } catch (_) { toast('Could not get ideas just now.'); }
  // The page may have moved on to another place while that was thinking.
  if (page !== id || !near) return;
  near = { busy: false, ideas: list || near.ideas || [] };
  const now = pageItem();
  if (now) paintNear(now);
}

export function openPlace(id) {
  const it = (S.items || []).find(x => x.id === id);
  if (!it) return;
  page = id;
  renaming = false;
  near = null;
  if (pinOf(it) && sel !== id) sel = id;
  paintPage(it, { fresh: true });
  if (snip) snip.resetDrops();
  openSheet('placeSheet');
  $('placeSheet').querySelector('.modal-in').scrollTop = 0;
  requestAnimationFrame(() => { if (snip) snip.refit(); });
  if (big && pinOf(it)) big.focus(id);
  loadDetails(it);
  loadWeather(it);
}

/* ── weather ──────────────────────────────────────────────────────────────
   At the place, now; rain coming in the next few hours; and the day it is
   planned for, at its hour when it has one. From lib/weather.js, through the
   server, by the place's pin — fetched fresh each time the page opens, and the
   Places tab's pill whenever it is drawn and ten minutes old. */
async function loadWeather(it) {
  const box = $('plWx');
  box.hidden = true;
  if (!pinOf(it)) return;
  let b;
  try { b = await get(`/api/item/${it.id}/weather`); } catch (_) { return; }
  if (page !== it.id || !b || !b.weather) return;
  const w = b.weather;
  const now = wxOf(w.now.code, w.now.day);
  const lines = [];
  const fit = b.fit;
  const verdict = (j, when) => (!j ? ''
    : j.verdict === 'good' ? `<span class="wx-ok">Good weather for it ${when}</span>`
    : j.verdict === 'poor' ? `<span class="wx-no">Not ideal ${when} · ${esc(j.why.map(words).join(', '))}</span>`
    : `<span class="wx-meh">Not quite ideal ${when} · ${esc(j.why.map(words).join(', '))}</span>`);
  if (b.judge && b.judge.now) lines.push(verdict(b.judge.now, 'right now'));
  if (w.rainSoon) lines.push(`${wxOf(61).icon} Rain likely around ${esc(hourWords(w.rainSoon.time))} · ${w.rainSoon.rain}%`);
  else if (w.today && w.today.rain >= 30) lines.push(`${w.today.rain}% chance of rain today`);
  const pl = w.plan;
  if (pl && !(pl.date === (w.today && w.today.date) && !pl.hour)) {
    const at = pl.hour
      ? `${wxOf(pl.hour.code).icon} ${deg(pl.hour.t)} · ${esc(wxOf(pl.hour.code).label.toLowerCase())}${pl.hour.rain >= 20 ? ` · ${pl.hour.rain}% rain` : ''}`
      : `${wxOf(pl.code).icon} ${deg(pl.hi)} / ${deg(pl.lo)}${pl.rain >= 20 ? ` · ${pl.rain}% rain` : ''}`;
    lines.push(`<b>Your plan</b>, ${esc(dayLabel(pl.date))}${pl.time ? ` · ${esc(timeLabel(pl.time))}` : ''}: ${at}`
      + (b.judge && b.judge.plan ? `<br>${verdict(b.judge.plan, 'then')}` : ''));
  }
  // What Claude said suits this place (lib/placefit.js) — only what applies.
  if (fit) lines.push(`<span class="wx-fit">${esc(fitWords(fit))}</span>`);
  box.innerHTML = `<div class="wx-now"><span class="wx-i" aria-hidden="true">${now.icon}</span>
      <span class="wx-t"><b>${deg(w.now.t)}</b><small>${esc(now.label)}${Number.isFinite(w.now.feels) && Math.abs(w.now.feels - w.now.t) >= 2 ? ` · feels ${deg(w.now.feels)}` : ''}</small></span>
      ${w.today ? `<span class="wx-hl">H ${deg(w.today.hi)} · L ${deg(w.today.lo)}</span>` : ''}</div>
    ${lines.map(l => `<div class="wx-line">${l}</div>`).join('')}
    <p class="wx-src">Weather there now · Open-Meteo</p>`;
  box.hidden = false;
}

// A profile's words for a condition, and the profile as one line.
const COND = { clear: 'clear skies', partly_cloudy: 'some cloud', overcast: 'cloud', fog: 'fog', drizzle: 'drizzle', rain: 'rain',
  snow: 'snow', thunderstorm: 'storms', windy: 'wind' };
const words = (x) => COND[x] || x;
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
function fitWords(f) {
  if (!f.matters) return f.setting === 'indoors' ? 'Indoors — the weather won’t matter.' : 'The weather won’t matter much here.';
  const best = [];
  if (f.ideal && f.ideal.conditions) best.push(andList(f.ideal.conditions.map(words)));
  if (f.ideal && (f.ideal.minC !== null || f.ideal.maxC !== null)) {
    best.push(f.ideal.minC !== null && f.ideal.maxC !== null ? `${deg(f.ideal.minC)}–${deg(f.ideal.maxC)}`
      : f.ideal.minC !== null ? `above ${deg(f.ideal.minC)}` : `below ${deg(f.ideal.maxC)}`);
  }
  if (f.bestTime && f.bestTime !== 'any') best.push(`in the ${f.bestTime}`);
  if (f.seasons) best.push(`in ${andList(f.seasons)}`);
  const worst = [];
  if (f.avoid && f.avoid.conditions && f.avoid.conditions.length) worst.push(andList(f.avoid.conditions.map(words)));
  if (f.avoid && f.avoid.belowC !== null) worst.push(`below ${deg(f.avoid.belowC)}`);
  if (f.avoid && f.avoid.aboveC !== null) worst.push(`above ${deg(f.avoid.aboveC)}`);
  const out = [best.length ? `Best with ${best.join(', ')}` : null, worst.length ? `spoiled by ${worst.join(', ')}` : null].filter(Boolean);
  return out.length ? `${out.join(' · ')}.` : (f.why || '');
}

// The pill over the Places map: the weather in the middle of this list's pins.
// Kept ten minutes per list and set of pins — a list that had none a moment
// ago and has one now is asked again.
const tabWx = { sig: null, at: 0, w: null };
async function paintTabWeather() {
  const pill = $('plWxPill');
  const sid = S.spaceId;
  const sig = `${sid}:${(S.items || []).filter(pinOf).length}`;
  const fresh = tabWx.sig === sig && Date.now() - tabWx.at < 10 * 60e3;
  const draw = (w) => {
    if (!w) { pill.hidden = true; return; }
    const now = wxOf(w.now.code, w.now.day);
    const extra = w.rainSoon ? `rain around ${hourWords(w.rainSoon.time)}` : now.label.toLowerCase();
    pill.innerHTML = `<span aria-hidden="true">${now.icon}</span> <b>${deg(w.now.t)}</b> <small>${esc(extra)}</small>`;
    pill.setAttribute('aria-label', `Weather: ${deg(w.now.t)}, ${extra}`);
    pill.hidden = false;
  };
  if (fresh) return draw(tabWx.w);
  if (!tabWx.sig || !tabWx.sig.startsWith(`${sid}:`)) pill.hidden = true;
  tabWx.sig = sig;
  tabWx.at = Date.now();
  let b;
  try { b = await get(`/api/space/${sid}/weather`); } catch (_) { tabWx.at = 0; return; }
  if (S.spaceId !== sid) return;
  tabWx.w = b && b.weather;
  draw(tabWx.w);
}

function paintPage(it, { fresh = false } = {}) {
  const pin = pinOf(it);
  const place = it.mod && it.mod.place;
  const edit = !!it.canEdit;
  const been = !!it.done;

  $('plFind').hidden = !!pin || !edit;
  $('plTitle').textContent = it.title;
  $('plTitle').hidden = renaming;
  $('plName').hidden = !renaming;
  if (fresh) $('plName').value = it.title;
  $('plEdit').hidden = !edit;
  $('plWhere').innerHTML = place ? `${icon('pin', 18)}<span>${esc(place.name)}</span>` : '';
  $('plSub').textContent = pin ? [cap(place.what), place.area, distLabel(away(pin))].filter(Boolean).join(' · ') : '';

  $('plDir').href = mapsUrl(it);
  $('plPlanLabel').textContent = been ? 'Go again' : 'Plan it';
  paintNear(it);
  if (fresh) {
    $('plWeb').removeAttribute('href');
    $('plWeb').setAttribute('aria-disabled', 'true');
    $('plInfo').hidden = true;
    $('plSrc').hidden = true;
  }

  // The plan, or — once you have been — the record.
  $('plPlanBox').hidden = been;
  $('plBeenBox').hidden = !been;
  const w = it.when;
  $('plDate').value = (w && w.date) || '';
  $('plTime').value = (w && w.time) || '';
  $('plTimeRow').hidden = !(w && w.date);
  $('plDayLabel').textContent = w && w.date ? 'Change' : 'Pick a day';
  $('plWhenSub').textContent = w && w.date
    ? `${dayLabel(w.date)}${w.time ? ` · ${timeLabel(w.time)}` : ''}${it.plannedByName ? ` · ${it.plannedBy === me() ? 'you' : it.plannedByName} planned it` : ''}`
    : `Not planned yet · ${whenHint(it).replace(/ can put it on a day too\. Saves as soon as you pick\./, ' can plan it too').replace(/^Saves as soon as you pick\.$/, 'saves as you pick')}`;
  $('plBook').checked = !!(it.visit && it.visit.book);
  if (been) {
    const who = it.doneBy === me() ? 'You' : it.doneByName;
    $('plBeenWhen').textContent = `${new Date(it.doneAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}${who ? ` · ${who} ticked it off` : ''}`;
    const cur = it.visit && it.visit.again;
    $('plAgain').innerHTML = AGAIN.map(a => `<button type="button" data-again="${a.id}" class="${a.id === cur ? 'on' : ''}"
      aria-pressed="${a.id === cur}">${esc(a.label)}</button>`).join('');
    $('plAgain').querySelectorAll('[data-again]').forEach(b => b.addEventListener('click', () =>
      saveVisit({ again: b.dataset.again === cur ? null : b.dataset.again })));
  }

  // The words, the credit and the audience are the author's (or an admin's):
  // the server says so, and the controls follow.
  if (fresh) {
    ideaSt = ideaControl(it, $('plIdeaFld'), $('plIdea'));
    $('plWhy').value = it.notes || '';
    $('plMem').value = (it.visit && it.visit.memory) || '';
    editingVis = it.visibility;
    const ownVis = edit && !!it.canSetVisibility;
    $('plVisFld').hidden = !ownVis;
    if (ownVis) visRow($('plVis'), () => editingVis, (v) => { editingVis = v; });
  }
  $('plWhyFld').hidden = been && !it.notes;
  $('plWhy').disabled = !edit;
  $('plMemFld').hidden = !been;
  $('plSave').hidden = !edit;

  const went = $('plWent');
  went.classList.toggle('quiet', been);
  // By class: a burst drops its own <span> into the button while it plays.
  went.querySelector('.went-t').textContent = been ? 'Not been after all' : 'We went here';

  $('plMore').hidden = !edit;
  $('plChange').querySelector('b').textContent = pin ? 'Change the place' : 'Find it on the map';
  $('plKinds').hidden = true;
}

// Hours, website and address, fetched fresh when the page opens. Which day is
// TODAY is decided here, on the phone — the server's Saturday is UTC's.
async function loadDetails(it) {
  if (!(it.mod && it.mod.place && it.mod.place.osm)) return;
  let b;
  try { b = await get(`/api/item/${it.id}/place?at=${localAt()}&tz=${encodeURIComponent(myZone())}`); } catch (_) { return; }
  if (page !== it.id || !b || !b.details) return;
  const d = b.details;
  const rows = [];
  const st = b.now;
  if (st && st.known) {
    // Now, and today's hours under it — the holiday's, when it has a rule.
    const lead = st.open ? `<span class="open">Open now</span> · until ${hm(st.until)}`
      : st.closedAllDay ? `<span class="shut">Closed today</span>${st.holiday ? ` · ${esc(st.holiday)}` : ''}${st.opens ? ` · opens ${esc(opensWords(st.opens))}` : ''}`
      : `<span class="shut">Closed now</span>${st.opens ? ` · opens ${esc(opensWords(st.opens))}` : ''}`;
    const all = st.ranges.length === 1 && st.ranges[0][0] === '00:00' && st.ranges[0][1] === '24:00';
    const todays = st.ranges.length ? `Today ${all ? 'all day' : st.ranges.map(r => `${hm(r[0])}–${hm(r[1])}`).join(', ')}` : '';
    rows.push(['clock', `${lead}${todays && !st.closedAllDay ? `<small>${esc(todays)}${st.holidayRule ? ` · ${esc(st.holiday)} hours` : ''}</small>` : ''}`]);
  } else if (d.hours) rows.push(['clock', esc(d.hours)]);
  // A big holiday with no rule written down: said, never guessed at.
  if (st && st.mayDiffer) rows.push(['cal', `<span class="hol">${esc(st.holiday)}</span> · hours may differ`]);
  // The day it is planned for: closed then is worth saying before you go.
  const pl = b.plan;
  if (pl && pl.known && it.when) {
    const when = `${dayLabel(it.when.date)}${it.when.time ? ` · ${timeLabel(it.when.time)}` : ''}`;
    const hrs = pl.ranges.length ? pl.ranges.map(r => `${hm(r[0])}–${hm(r[1])}`).join(', ') : '';
    rows.push(['cal', pl.closedAllDay
      ? `<span class="shut">Closed on your plan</span> · ${esc(when)}${pl.holiday ? ` · ${esc(pl.holiday)}` : ''}`
      : it.when.time && pl.open === false
        ? `<span class="shut">Closed at that time</span> · ${esc(when)}<small>Open ${esc(hrs)} that day</small>`
        : pl.mayDiffer
          ? `<span class="hol">${esc(pl.holiday)}</span> on your plan · hours may differ`
          : `<span class="open">Open for your plan</span> · ${esc(when)}${hrs ? `<small>${esc(hrs)}</small>` : ''}`]);
  }
  if (d.address) rows.push(['pin', esc(d.address)]);
  if (d.website) rows.push(['globe', `<a href="${esc(d.website)}" target="_blank" rel="noopener noreferrer">${esc(d.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>`]);
  if (d.phone) rows.push(['phone', `<a href="tel:${esc(d.phone.replace(/[^\d+]/g, ''))}">${esc(d.phone)}</a>`]);
  if (d.website) {
    $('plWeb').href = d.website;
    $('plWeb').removeAttribute('aria-disabled');
  }
  if (!rows.length) return;
  $('plInfo').innerHTML = rows.map(([ic, html]) => `<div class="crow"><i>${icon(ic, 20)}</i><span class="cb">${html}</span></div>`).join('');
  $('plInfo').classList.add('rows');
  $('plInfo').hidden = false;
  $('plSrc').hidden = false;
}

// The phone's own date and clock — what "now" means for open or closed.
const pad2 = (n) => String(n).padStart(2, '0');
function localAt(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// The phone's zone, for sunrise and sunset ("sunrise-sunset" parks).
const myZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } };
// When it next opens, said the way you would: "5 PM", "tomorrow 8 AM",
// "Fri 8 AM" — or, for a place out of season, the date: "Nov 12".
function opensWords(o) {
  const today = localAt().slice(0, 10);
  const tomorrow = localAt(new Date(Date.now() + 864e5)).slice(0, 10);
  if (o.date === today) return hm(o.time);
  if (o.date === tomorrow) return `tomorrow ${hm(o.time)}`;
  const day = new Date(`${o.date}T12:00:00`);
  if (day - Date.now() > 6 * 864e5) {
    return day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(day.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  }
  return `${day.toLocaleDateString('en-US', { weekday: 'short' })} ${hm(o.time)}`;
}

/* ── open or closed, on the Places tab ──────────────────────────────────
   For every place on the list, from the server (which reads the hours and the
   holidays in one tested place) at the phone's own time. Only what is known is
   answered at first; `pending` places are asked for again shortly. A row says
   so when a place is closed, or closing within the hour, or it is a holiday
   that may change its hours; its pin dims while it is shut. */
const openStates = new Map();
const hoursFor = { sig: null, at: 0, tries: 0 };
let lastPlaces = null;   // what renderPlaces last drew, so the hours know which tab is up
async function loadOpenStates({ force = false } = {}) {
  const sid = S.spaceId;
  const sig = `${sid}:${(S.items || []).length}`;
  if (!force && hoursFor.sig === sig && Date.now() - hoursFor.at < 5 * 60e3) return;
  if (hoursFor.sig !== sig) { openStates.clear(); hoursFor.tries = 0; }
  hoursFor.sig = sig;
  hoursFor.at = Date.now();
  let b;
  try { b = await get(`/api/space/${sid}/hours?at=${localAt()}&tz=${encodeURIComponent(myZone())}`); } catch (_) { hoursFor.at = 0; return; }
  if (S.spaceId !== sid || !b) return;
  const before = JSON.stringify([...openStates]);
  openStates.clear();
  for (const [id, st] of Object.entries(b.states || {})) openStates.set(id, st);
  if (JSON.stringify([...openStates]) !== before && !$('placesTop').hidden) paintOpenStates();
  if (b.pending && hoursFor.tries < 6) {
    hoursFor.tries++;
    setTimeout(() => { if (S.spaceId === sid) loadOpenStates({ force: true }); }, Math.min(8000, 1200 * b.pending));
  }
}
// Into the rows and pins already on screen — never a redraw of the list, which
// would swallow a tap that landed while the hours were still arriving.
function paintOpenStates() {
  if (!lastPlaces || lastPlaces[1].been) return;
  for (const row of $('itemList').querySelectorAll('.it[data-it]')) {
    const old = row.querySelector('[data-oc]');
    if (old) old.remove();
    const chip = openChip(openStates.get(row.dataset.it));
    if (!chip) continue;
    let meta = row.querySelector('.it-meta');
    if (!meta) {
      meta = document.createElement('div');
      meta.className = 'it-meta';
      row.querySelector('.it-bd').appendChild(meta);
    }
    meta.insertAdjacentHTML('afterbegin', chip.replace('<span ', '<span data-oc '));
  }
  drawBig();
}
const shutNow = (id) => { const st = openStates.get(id); return !!(st && st.known && st.open === false); };
function openChip(st) {
  if (!st) return '';
  if (st.known && st.open === false) {
    return `<span class="chip shut">${st.closedAllDay ? `Closed today${st.holiday ? ` · ${esc(st.holiday)}` : ''}`
      : `Closed now${st.opens && st.opens.date === localAt().slice(0, 10) ? ` · opens ${esc(hm(st.opens.time))}` : ''}`}</span>`;
  }
  if (st.mayDiffer) return `<span class="chip hol">${esc(st.holiday)} · hours may differ</span>`;
  if (st.known && st.open && st.until && st.until !== '24:00') {
    const [h, m] = st.until.split(':').map(Number);
    const now = new Date();
    const left = (h * 60 + m) - (now.getHours() * 60 + now.getMinutes());
    if (left > 0 && left <= 60) return `<span class="chip soon">Closes ${esc(hm(st.until))}</span>`;
  }
  return '';
}

// "08:00" → "8 AM", "17:30" → "5:30 PM".
function hm(t) {
  const [h, m] = t.split(':').map(Number);
  if (h === 24 || (h === 0 && m === 0)) return 'midnight';
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}

const pageItem = () => (S.items || []).find(x => x.id === page);

async function afterWrite(r) {
  if (r && r.state) applyWire(r.state);
  await refresh();
  changed();
  const it = pageItem();
  if (it && !$('placeSheet').hidden) paintPage(it);
}

async function saveVisit(body) {
  try { await afterWrite(await post(`/api/item/${page}/visit`, body)); } catch (e) {
    toast(e.status === 409 ? 'That one waits until you have been' : 'Could not save that');
  }
}

async function saveWhen() {
  const date = $('plDate').value;
  try {
    await afterWrite(await post(`/api/item/${page}/when`,
      date ? { date, time: $('plTime').value || null } : { clear: true }));
  } catch (_) { toast('Could not set the day'); }
}

async function savePage() {
  const it = pageItem();
  if (!it) return;
  const title = renaming ? $('plName').value.trim() : it.title;
  if (!title) return toast('It needs a name');
  try {
    // No `mod`: the place is not this button's to send, and leaving it out of
    // the PATCH is what keeps it.
    const r = await patch(`/api/item/${page}`, {
      title,
      notes: $('plWhy').value.trim(),
      ...(it.canSetVisibility ? { visibility: editingVis } : {}),
      ...(it.canCredit && ideaSt && ideaSt.value !== ideaSt.opened ? { ideaBy: ideaSt.value } : {}),
    });
    renaming = false;
    applyWire(r.state);
    closeSheet('placeSheet');
    page = null;
    await refresh();
    changed();
  } catch (_) { toast('Could not save that'); }
}

// We went here is the place's version of ticking it off, and gets the same
// moment: the ring fills where you tapped and throws its sparks, and then the
// page turns into the record — the Been together card blooms in and the sheet
// glides up to it, because "would you go back?" is the next thing to say.
// The POST goes at once; the moment is never what you are waiting on.
async function setDoneHere(done) {
  const btn = $('plWent');
  const sent = post(`/api/item/${page}/done`, { done });
  let shown = Promise.resolve();
  if (done) {
    haptic('success');
    if (!calm()) {
      btn.classList.add('going');
      burst(btn.querySelector('.went-i'), { r: 13, n: 6 });
      shown = new Promise(r => setTimeout(r, 480));
    }
  }
  try {
    const [r] = await Promise.all([sent, shown]);
    await afterWrite(r);
    if (done) bloomBeen();
  } catch (e) {
    toast(e.status === 403 ? 'That one is not yours to tick off' : 'Could not save that');
  }
  btn.classList.remove('going');
}

function bloomBeen() {
  const box = $('plBeenBox');
  if (box.hidden || calm()) return;
  const panel = $('placeSheet').querySelector('.modal-in');
  const top = box.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 16;
  if (panel.scrollTo) panel.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  const card = box.querySelector('.been');
  if (card && card.animate) {
    card.animate([
      { opacity: 0, transform: 'scale(.94)', boxShadow: '0 0 0 0 color-mix(in srgb, var(--accent2) 45%, transparent)' },
      { opacity: 1, transform: 'scale(1.02)', offset: 0.55 },
      { opacity: 1, transform: 'none', boxShadow: '0 0 0 14px transparent' },
    ], { duration: 620, delay: 120, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'backwards' });
    [...card.querySelectorAll('.chips button')].forEach((b, i) => b.animate && b.animate(
      [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: 280, delay: 420 + i * 60, easing: 'ease-out', fill: 'backwards' }));
  }
}

/* ── which place is it, actually ───────────────────────────────────────── */

let wsResults = [];
let wsSeq = 0;
let wsTimer = null;

function openWhere() {
  const it = pageItem();
  if (!it) return;
  $('wsQuery').value = leadEmoji(it.title).rest;
  $('wsResults').innerHTML = '';
  openSheet('whereSheet');
  searchWhere();
}

async function searchWhere() {
  const q = leadEmoji($('wsQuery').value).rest.trim();
  const seq = ++wsSeq;
  const box = $('wsResults');
  if (q.length < 2) { box.innerHTML = ''; wsResults = []; return; }
  box.innerHTML = '<p class="preds-note">Looking…</p>';
  const b0 = biasPoint();
  let b;
  try {
    b = await get(`/api/place/suggest?q=${encodeURIComponent(q)}${b0 ? `&lat=${b0.lat}&lon=${b0.lon}` : ''}`);
  } catch (_) { b = { ok: false, results: [] }; }
  if (seq !== wsSeq) return;
  wsResults = b.results || [];
  box.innerHTML = wsResults.length
    ? `<div class="preds">${wsResults.map((p, i) => `<button type="button" class="pred" data-ws="${i}">
        <span class="num">${i + 1}</span>
        <span class="pb"><b>${esc(p.name)}</b><small>${esc([p.what && cap(p.what), p.area || p.address].filter(Boolean).join(' · '))}</small></span>
        <span class="mi">${esc(distLabel(away(p)))}</span></button>`).join('')}</div>`
    : `<p class="preds-note">${b.ok ? 'Nothing by that name. Try other words.' : 'No suggestions right now.'}</p>`;
  box.querySelectorAll('[data-ws]').forEach(btn => btn.addEventListener('click', () => pinPage(wsResults[Number(btn.dataset.ws)])));
}

// The place you tapped, on this item. The link slice goes with it, because the
// sheet's PATCH replaces `mod` wholesale.
async function pinPage(p) {
  const it = pageItem();
  if (!it || !p) return;
  try {
    const r = await patch(`/api/item/${page}`, {
      title: it.title,
      mod: {
        ...(it.mod && it.mod.link ? { link: it.mod.link } : {}),
        place: { name: p.name, address: p.address || null, lat: p.lat, lon: p.lon, area: p.area || null, what: p.what || null, osm: p.osm || null },
      },
    });
    closeSheet('whereSheet');
    sel = page;                 // the place you just pinned is the one picked out
    await afterWrite(r);
    const now = pageItem();
    if (now) { paintPage(now, { fresh: true }); loadDetails(now); }
    requestAnimationFrame(() => { if (snip) snip.refit(); });
  } catch (_) { toast('Could not pin that'); }
}

/* ── wiring ─────────────────────────────────────────────────────────────── */

export function initPlaces() {
  big = createMap($('plCanvas'), {
    points: bigPoints,
    drop: true,
    pad: 0.08,
    single: 14,
    onPin: (id) => {
      if (id.startsWith('p:')) return pinPrediction(Number(id.slice(2)));
      // A tap on a pin finds its row; a second tap on the same pin opens it.
      if (sel === id) return openPlace(id);
      select(id, { pan: false });
    },
    // A tap on the map itself puts the selection down, and nothing else.
    onBlank: () => { if (sel) { sel = null; render(); } },
    empty: () => 'Nothing here is on the map yet.<br>Add a place below and pick it from the list.',
  });
  snip = createMap($('plSnip'), {
    still: true,
    drop: true,
    single: 15,
    points: () => {
      const it = pageItem();
      const p = pinOf(it);
      return p ? [{ key: it.id, lat: p.lat, lon: p.lon, cls: `epin ${it.done ? 'been' : 'go'} sel`, inner: bubble(it) }] : [];
    },
    empty: () => {
      const it = pageItem();
      return it && it.canEdit ? '' : 'Not on the map yet.';
    },
  });

  $('plBack').addEventListener('click', () => $('spaceBack').click());
  $('plRose').addEventListener('click', () => $('spaceRose').click());
  $('plGo').addEventListener('click', () => { if ($('plGo').getAttribute('aria-pressed') !== 'true') setTab('open'); });
  $('plBeen').addEventListener('click', () => { if ($('plBeen').getAttribute('aria-pressed') !== 'true') setTab('done'); });

  $('plClose').addEventListener('click', () => { closeSheet('placeSheet'); page = null; renaming = false; });
  $('plEdit').addEventListener('click', () => {
    renaming = !renaming;
    const it = pageItem();
    if (it) { $('plName').value = it.title; paintPage(it); }
    if (renaming) $('plName').focus();
  });
  $('plFind').addEventListener('click', openWhere);
  $('plChange').addEventListener('click', openWhere);
  $('plNearBtn').addEventListener('click', suggestNear);
  $('plShare').addEventListener('click', async () => {
    const it = pageItem();
    if (!it) return;
    const url = mapsUrl(it).replace('/dir/?api=1&destination=', '/search/?api=1&query=');
    try {
      if (navigator.share) await navigator.share({ title: leadEmoji(it.title).rest, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch (_) { /* dismissed */ }
  });
  $('plPlan').addEventListener('click', async () => {
    const it = pageItem();
    if (!it) return;
    // Going again puts it back on the list, then asks for a day.
    if (it.done) await setDoneHere(false);
    const d = $('plDate');
    try { d.showPicker(); } catch (_) { d.focus(); }
  });
  $('plDate').addEventListener('click', () => { try { $('plDate').showPicker(); } catch (_) {} });
  $('plDate').addEventListener('change', saveWhen);
  $('plTime').addEventListener('change', saveWhen);
  $('plBook').addEventListener('change', () => saveVisit({ book: $('plBook').checked }));
  $('plMem').addEventListener('change', () => saveVisit({ memory: $('plMem').value }));
  $('plWent').addEventListener('click', () => { const it = pageItem(); if (it) setDoneHere(!it.done); });
  $('plSave').addEventListener('click', savePage);
  $('plMove').addEventListener('click', () => {
    const it = pageItem();
    if (!it) return;
    const box = $('plKinds');
    box.hidden = !box.hidden;
    if (box.hidden) return;
    kindPicker(box, () => kindOrDefault(it), async (k) => {
      if (k === kindOrDefault(it)) return;
      try {
        const r = await patch(`/api/item/${page}`, { title: it.title, kind: k });
        applyWire(r.state);
        closeSheet('placeSheet');
        page = null;
        await refresh();
        changed();
        toast(`Moved to ${kindOf(k).plural}`);
      } catch (_) { toast('Could not move that'); }
    });
  });
  $('plDelete').addEventListener('click', async () => {
    if (!page || !confirm('Delete this?')) return;
    try {
      applyWire(await del(`/api/item/${page}`));
      closeSheet('placeSheet');
      if (sel === page) sel = null;
      page = null;
      await refresh();
      changed();
    } catch (_) { toast('Could not delete that'); }
  });

  $('wsClose').addEventListener('click', () => closeSheet('whereSheet'));
  $('wsQuery').addEventListener('input', () => {
    clearTimeout(wsTimer);
    wsTimer = setTimeout(searchWhere, 300);   // a keystroke is not a search
  });
  window.addEventListener('resize', () => {
    if ($('placesTop').hidden) return;
    if (detent !== 'half') setTop(heights()[detent]);
    drawBig({ force: true });
  });
  listDrag();
}
