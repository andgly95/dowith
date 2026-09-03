// The map: a second view of the same list, for the things that have a place.
//
// No mapping library. Tiles are plain `<img>` at an integer zoom in Web
// Mercator, which is the same approach the trips app uses and for the same
// reasons: it is about eighty lines, it has no dependency to break, and it fails
// gracefully — if the tiles don't load you still get pins in the right relative
// positions on an empty ground, which is enough to answer "is there anything
// near us".
import { S } from './state.js';
import { $, esc, toast } from './util.js';
import { post } from './api.js';

const TILE = 256;
const MAX_Z = 17;
let view = { z: null, cx: 0, cy: 0 };   // z===null means "fit to the pins"
let drag = null;
let moved = false;
let onOpen = () => {};

/* ── Web Mercator ────────────────────────────────────────────────────────── */

const lonToX = (lon) => (lon + 180) / 360;
const latToY = (lat) => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};

const pinned = () => (S.items || []).filter(i => {
  const p = i.mod && i.mod.place;
  return p && typeof p.lat === 'number' && typeof p.lon === 'number';
});

/* ── framing ─────────────────────────────────────────────────────────────── */

// Fit every pin, then back off one zoom so nothing sits on the very edge. A
// single pin gets a sensible neighbourhood zoom rather than the whole planet or
// a street corner.
function fit(items, w, h) {
  const pts = items.map(i => ({ x: lonToX(i.mod.place.lon), y: latToY(i.mod.place.lat) }));
  if (!pts.length) return { z: 2, cx: 0.5, cy: 0.5 };
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  if (pts.length === 1) return { z: 13, cx, cy };
  const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6);
  // Largest integer zoom at which the whole spread still fits the viewport.
  let z = Math.floor(Math.min(
    Math.log2(w / (TILE * spanX)),
    Math.log2(h / (TILE * spanY)),
  ));
  return { z: Math.max(1, Math.min(MAX_Z, z - 1)), cx, cy };
}

/* ── render ──────────────────────────────────────────────────────────────── */

export function renderMap() {
  const canvas = $('mapCanvas');
  if (!canvas) return;
  const items = pinned();
  const w = canvas.clientWidth || 360;
  const h = canvas.clientHeight || 400;

  const withPlace = (S.items || []).filter(i => i.mod && i.mod.place).length;
  if (!items.length) {
    canvas.innerHTML = `<div class="map-empty">${
      withPlace
        ? 'Working out where these are…'
        : 'Nothing here has a place yet.<br>Add one to an item and it turns up here.'
    }</div>`;
    return;
  }

  const f = view.z === null ? fit(items, w, h) : view;
  const scale = TILE * 2 ** f.z;
  // Pixel position of the viewport's top-left corner in world space.
  const originX = f.cx * scale - w / 2;
  const originY = f.cy * scale - h / 2;

  // Only the tiles the viewport can actually see.
  const t0x = Math.floor(originX / TILE), t1x = Math.floor((originX + w) / TILE);
  const t0y = Math.floor(originY / TILE), t1y = Math.floor((originY + h) / TILE);
  const n = 2 ** f.z;
  const tiles = [];
  for (let tx = t0x; tx <= t1x; tx++) {
    for (let ty = t0y; ty <= t1y; ty++) {
      if (ty < 0 || ty >= n) continue;
      const wrapped = ((tx % n) + n) % n;         // the world repeats east–west
      tiles.push(`<img class="tile" alt="" draggable="false"
        src="https://tile.openstreetmap.org/${f.z}/${wrapped}/${ty}.png"
        style="left:${tx * TILE - originX}px;top:${ty * TILE - originY}px">`);
    }
  }

  const pins = items.map((i) => {
    const x = lonToX(i.mod.place.lon) * scale - originX;
    const y = latToY(i.mod.place.lat) * scale - originY;
    const cls = [i.done ? 'done' : '', i.visibility === 'private' ? 'private' : ''].filter(Boolean).join(' ');
    return `<button class="pin ${cls}" data-pin="${esc(i.id)}"
      style="left:${x}px;top:${y}px" title="${esc(i.title)}">
      <i></i><span>${esc(i.mod.place.name)}</span></button>`;
  }).join('');

  canvas.innerHTML = `<div class="pan">${tiles.join('')}${pins}</div>
    <div class="attrib">© OpenStreetMap</div>`;

  canvas.querySelectorAll('[data-pin]').forEach((b) => {
    b.addEventListener('click', () => {
      // A drag that ends on a pin is a pan, not a tap. Cleared on the next tick,
      // because leaving it set disables every pin until you drag again.
      if (moved) return;
      onOpen(b.dataset.pin);
    });
  });
}

/* ── pan and zoom, by hand ───────────────────────────────────────────────── */

function currentView(items) {
  const canvas = $('mapCanvas');
  return view.z === null
    ? fit(items, canvas.clientWidth || 360, canvas.clientHeight || 400)
    : view;
}

function zoomBy(d) {
  const items = pinned();
  if (!items.length) return;
  const f = currentView(items);
  view = { z: Math.max(1, Math.min(MAX_Z, f.z + d)), cx: f.cx, cy: f.cy };
  renderMap();
}

export function initMap(openHandler) {
  onOpen = openHandler || (() => {});
  const canvas = $('mapCanvas');
  if (!canvas) return;

  $('mapFit').addEventListener('click', () => { view = { z: null, cx: 0, cy: 0 }; renderMap(); });
  $('mapIn').addEventListener('click', () => zoomBy(1));
  $('mapOut').addEventListener('click', () => zoomBy(-1));

  canvas.addEventListener('pointerdown', (e) => {
    const items = pinned();
    if (!items.length) return;
    const f = currentView(items);
    view = { ...f };
    drag = { x: e.clientX, y: e.clientY, cx: f.cx, cy: f.cy, z: f.z };
    moved = false;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    const scale = TILE * 2 ** drag.z;
    // Move the layer under a transform while dragging and only re-render on
    // release — re-rendering per pointermove re-requests every tile.
    const layer = canvas.querySelector('.pan');
    if (layer) layer.style.transform = `translate(${dx}px,${dy}px)`;
    view.cx = drag.cx - dx / scale;
    view.cy = drag.cy - dy / scale;
  });

  const release = () => {
    if (!drag) return;
    drag = null;
    renderMap();
    // Next tick, so the click that follows this pointerup is still suppressed.
    setTimeout(() => { moved = false; }, 0);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
}

// Ask the server to resolve any place names that don't have coordinates yet.
// Called when the map is opened, not on every render — it costs a request per
// unknown name and Nominatim is one-a-second.
export async function resolvePlaces() {
  const unresolved = (S.items || []).some(i => i.mod && i.mod.place && i.mod.place.lat === null);
  if (!unresolved || !S.spaceId) return false;
  try {
    const b = await post(`/api/space/${S.spaceId}/geocode`);
    return b.found > 0;
  } catch (_) { return false; }
}
