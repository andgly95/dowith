// The map: plain tiles, hand-rolled pan and zoom, pins in the right places.
//
// No mapping library. Tiles are plain `<img>` at an integer zoom in Web
// Mercator, which is the same approach the trips app uses and for the same
// reasons: it is about eighty lines, it has no dependency to break, and it fails
// gracefully — if the tiles don't load you still get pins in the right relative
// positions on an empty ground, which is enough to answer "is there anything
// near us".
//
// One engine, two maps: the Places tab, and the snippet at the top of a place's
// page. `createMap` is the engine; each caller says what goes on it. (There was
// a third — a Map view across every kind, behind a chip — and it went: the
// Places tab is the map.)
import { esc } from './util.js';

const TILE = 256;
const MAX_Z = 17;

/* ── Web Mercator ────────────────────────────────────────────────────────── */

const lonToX = (lon) => (lon + 180) / 360;
const latToY = (lat) => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};
const onMap = (p) => p && typeof p.lat === 'number' && typeof p.lon === 'number';

/* ── framing ─────────────────────────────────────────────────────────────── */

// Fit every point, then back off one zoom so nothing sits on the very edge. A
// single point gets a neighbourhood rather than the whole planet or a corner.
// `pad` is the share of the height covered by something else (the list sheet
// over the bottom of the Places map), so the fit happens in what is visible.
function fit(pts, w, h, { single = 13, pad = 0 } = {}) {
  const xy = pts.map(p => ({ x: lonToX(p.lon), y: latToY(p.lat) }));
  if (!xy.length) return { z: 2, cx: 0.5, cy: 0.42 };
  const xs = xy.map(p => p.x), ys = xy.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  let cy = (minY + maxY) / 2;
  const vh = h * (1 - pad);
  let z;
  if (xy.length === 1) z = single;
  else {
    const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6);
    z = Math.floor(Math.min(Math.log2(w / (TILE * spanX)), Math.log2(vh / (TILE * spanY))));
    z = Math.max(1, Math.min(MAX_Z - 1, z - 1));
  }
  // Shift the centre down by half the covered strip, so the points sit in the
  // middle of what you can SEE rather than the middle of the canvas.
  if (pad) cy += (h * pad) / 2 / (TILE * 2 ** z);
  return { z, cx, cy };
}

/* ── the engine ──────────────────────────────────────────────────────────── */

// opts:
//   points()  [{ id?, key?, lat, lon, cls, inner, tag?, fit? }] — what to draw.
//             `fit: false` points are drawn but not framed (the other set's dots).
//             `key` names a point with no id, for `drop`.
//   onPin(id) a tap on a point with an id.
//   onBlank() a tap on the map itself, not on a point.
//   empty()   HTML for a map with nothing to frame; null draws the world.
//   pad       share of the height under something else.
//   single    the zoom for a lone point.
//   still     no pan or zoom (the snippet on a place's page).
//   drop      a pin falls into place the first time it is drawn (`.drop`);
//             `resetDrops()` lets them fall again.
//
// Zoom is CONTINUOUS. Tiles only come in whole zoom levels, so they are drawn
// at the nearest one and scaled by what is left over (between ×0.71 and ×1.41).
// That is what lets a pinch end exactly where your fingers left it, rather than
// snapping to the nearest power of two — which on a phone reads as the map
// flinching away from you.
const MIN_Z = 1;
const clampZ = (z) => Math.max(MIN_Z, Math.min(MAX_Z, z));

export function createMap(canvas, opts = {}) {
  let view = { z: null, cx: 0, cy: 0 };   // z===null means "fit to the points"
  let moved = false;
  let drawnH = 0;                          // the height the tiles were last laid out for
  // Pins that have been drawn before, and when. With `drop`, a pin falls into
  // place the FIRST time it appears and is simply there on every redraw after —
  // a map redraws on every pan, and pins that kept falling would be a slot
  // machine. A redraw DURING the fall (they come in twos: a render, then a
  // focus) carries it on with a negative delay rather than cutting it off.
  const dropped = new Map();   // key → { at, d }
  const FALL = 700;
  const pts = () => (opts.points ? opts.points() : []).filter(onMap);

  const size = () => ({ w: canvas.clientWidth || 360, h: canvas.clientHeight || 400 });
  const current = () => {
    if (view.z !== null) return view;
    const all = pts();
    const framed = all.filter(p => p.fit !== false);
    const { w, h } = size();
    return fit(framed.length ? framed : all, w, h, { single: opts.single || 13, pad: opts.pad || 0 });
  };

  function render() {
    if (!canvas) return;
    const all = pts();
    const { w, h } = size();
    if (!all.length && opts.empty) {
      const msg = opts.empty();
      if (msg !== null && msg !== undefined) {
        canvas.innerHTML = `<div class="map-empty">${msg}</div>`;
        return;
      }
    }
    const f = current();
    drawnH = h;
    const scale = TILE * 2 ** f.z;               // the world, in CSS pixels
    const tz = Math.max(0, Math.min(MAX_Z, Math.round(f.z)));
    const ts = TILE * 2 ** (f.z - tz);           // one tile at that level, on screen
    const ox = f.cx * scale - w / 2;
    const oy = f.cy * scale - h / 2;

    // Only the tiles the viewport can actually see.
    const t0x = Math.floor(ox / ts), t1x = Math.floor((ox + w) / ts);
    const t0y = Math.floor(oy / ts), t1y = Math.floor((oy + h) / ts);
    const n = 2 ** tz;
    const tiles = [];
    // A tile is drawn a fraction of a pixel oversize so the seams between
    // scaled tiles never show the ground through them.
    const sz = Math.ceil(ts * 100) / 100 + 0.5;
    for (let tx = t0x; tx <= t1x; tx++) {
      for (let ty = t0y; ty <= t1y; ty++) {
        if (ty < 0 || ty >= n) continue;
        const wrapped = ((tx % n) + n) % n;         // the world repeats east–west
        tiles.push(`<img class="tile" alt="" draggable="false"
          src="https://tile.openstreetmap.org/${tz}/${wrapped}/${ty}.png"
          style="left:${tx * ts - ox}px;top:${ty * ts - oy}px;width:${sz}px;height:${sz}px">`);
      }
    }
    let fell = 0;
    const now = Date.now();
    const marks = all.map((p) => {
      const x = lonToX(p.lon) * scale - ox;
      const y = latToY(p.lat) * scale - oy;
      const tag = p.tag || (p.id ? 'button' : 'span');
      const k = opts.drop && (p.key || p.id);
      if (k && !dropped.has(k)) dropped.set(k, { at: now, d: Math.min(fell++, 8) * 45 });
      const f = k && dropped.get(k);
      const fresh = f && now - f.at < FALL + f.d;
      return `<${tag} class="${esc(p.cls || '')}${fresh ? ' drop' : ''}"${p.id ? ` data-pin="${esc(p.id)}"` : ''}${
        tag === 'button' ? ' type="button"' : ''}${p.label ? ` aria-label="${esc(p.label)}"` : ''}
        style="left:${x}px;top:${y}px${fresh ? `;--d:${f.d - (now - f.at)}ms` : ''}">${p.inner || ''}</${tag}>`;
    }).join('');

    canvas.innerHTML = `<div class="pan">${tiles.join('')}${marks}</div>
      <div class="attrib">© OpenStreetMap</div>`;

    // A tile that does not load goes, rather than sitting there as a broken-image
    // glyph with a seam round it. Points on a blank ground is the designed
    // fallback — it still answers "is there anything near us".
    canvas.querySelectorAll('.tile').forEach((img) => {
      img.addEventListener('error', () => img.remove(), { once: true });
    });
    canvas.querySelectorAll('[data-pin]').forEach((b) => {
      b.addEventListener('click', (e) => {
        // A drag or a pinch that ends on a pin is not a tap. Cleared on the next
        // tick, because leaving it set disables every pin until you drag again.
        if (moved) return;
        e.stopPropagation();
        if (opts.onPin) opts.onPin(b.dataset.pin);
      });
    });
  }

  // Zoom by `dz` levels keeping the world point under screen point `at` (canvas
  // pixels) where it is — so a pinch zooms into what is between your fingers,
  // and a wheel into what is under the cursor, not into the middle of the map.
  // `to` is where that point should end up, for a pinch whose fingers moved.
  function zoomAround(f, dz, at, to = at) {
    const { w, h } = size();
    const z = clampZ(f.z + dz);
    const s0 = TILE * 2 ** f.z, s1 = TILE * 2 ** z;
    const wx = f.cx + (at.x - w / 2) / s0;     // the world point under `at`
    const wy = f.cy + (at.y - h / 2) / s0;
    return { z, cx: wx - (to.x - w / 2) / s1, cy: wy - (to.y - h / 2) / s1 };
  }

  function zoomBy(d) {
    if (!pts().length) return;
    const f = current();
    view = { z: clampZ(f.z + d), cx: f.cx, cy: f.cy };
    render();
  }

  // Bring one point into the middle of what is visible, closer in if the map
  // is zoomed out past street level.
  function focus(id) {
    const p = pts().find(x => x.id === id);
    if (!p) return;
    const f = current();
    const z = Math.max(f.z, 14);
    const { h } = size();
    view = { z, cx: lonToX(p.lon), cy: latToY(p.lat) + ((h * (opts.pad || 0)) / 2) / (TILE * 2 ** z) };
    render();
  }

  /* ── fingers ──────────────────────────────────────────────────────────────
     Every pointer is tracked, not just the first. One finger pans; two pinch.
     The first version tracked one: a second finger simply restarted the drag
     from wherever it landed, so a pinch jerked the map sideways and never
     zoomed. While a gesture is live the layer moves under a CSS transform and
     nothing is re-rendered — re-rendering per move re-requests every tile —
     and the view is worked out once, when the fingers come off. */
  if (canvas && !opts.still) {
    const fingers = new Map();               // pointerId → { x, y } in canvas px
    let drag = null;                         // { x, y, f } — one finger
    let pinch = null;                        // { f, m0, d0, s, m1 } — two
    const local = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const layer = () => canvas.querySelector('.pan');
    const two = () => [...fingers.values()].slice(0, 2);
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;

    // Where a one-finger drag has got to, as a view.
    const dragView = (p) => {
      const scale = TILE * 2 ** drag.f.z;
      return { z: drag.f.z, cx: drag.f.cx - (p.x - drag.x) / scale, cy: drag.f.cy - (p.y - drag.y) / scale };
    };
    const startDrag = (p) => { drag = { x: p.x, y: p.y, f: { ...current() } }; };
    const startPinch = () => {
      const [a, b] = two();
      // A pan already under way is kept: the pinch starts from where it got to.
      const f = drag && moved ? dragView(fingers.get([...fingers.keys()][0]) || drag) : { ...current() };
      if (drag && moved) { view = f; render(); }
      drag = null;
      const m0 = mid(a, b);
      pinch = { f, m0, d0: dist(a, b), s: 1, m1: m0 };
      moved = true;                            // two fingers are never a tap
    };
    const endPinch = () => {
      const p = pinch;
      pinch = null;
      view = zoomAround(p.f, Math.log2(p.s), p.m0, p.m1);
      render();
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (!pts().length) return;
      fingers.set(e.pointerId, local(e));
      // Not on a pin: captured, the click that ends a tap would land on the
      // canvas instead of the pin. A gesture that starts on a pin still works,
      // because its moves bubble up here anyway.
      if (!e.target.closest('[data-pin]')) {
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      }
      if (fingers.size === 1) { moved = false; startDrag(fingers.get(e.pointerId)); }
      else if (fingers.size === 2) startPinch();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!fingers.has(e.pointerId)) return;
      const p = local(e);
      fingers.set(e.pointerId, p);
      const el = layer();
      if (pinch) {
        const [a, b] = two();
        const m1 = mid(a, b);
        // Held inside the zoom range while the fingers are down, so letting go
        // never jumps back.
        const lo = 2 ** (MIN_Z - pinch.f.z), hi = 2 ** (MAX_Z - pinch.f.z);
        const s = Math.max(lo, Math.min(hi, dist(a, b) / pinch.d0));
        pinch.s = s;
        pinch.m1 = m1;
        if (el) {
          el.style.transformOrigin = '0 0';
          el.style.transform = `translate(${m1.x - pinch.m0.x * s}px,${m1.y - pinch.m0.y * s}px) scale(${s})`;
        }
        return;
      }
      if (!drag) return;
      const dx = p.x - drag.x, dy = p.y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      if (el) { el.style.transformOrigin = '0 0'; el.style.transform = `translate(${dx}px,${dy}px)`; }
    });

    const lift = (e) => {
      if (!fingers.has(e.pointerId)) return;
      const p = fingers.get(e.pointerId);
      if (pinch) {
        fingers.delete(e.pointerId);
        endPinch();
        // One finger still down carries on as a pan from here, rather than
        // the map freezing until both are lifted.
        if (fingers.size >= 1) startDrag([...fingers.values()][0]);
      } else {
        fingers.delete(e.pointerId);
        if (drag && moved) { view = dragView(p); render(); }
        drag = null;
      }
      // Next tick, so the click that follows this pointerup is still suppressed.
      if (!fingers.size) setTimeout(() => { moved = false; }, 0);
    };
    // A tap on the map itself — not a pin, not the end of a drag.
    canvas.addEventListener('click', (e) => {
      if (moved || e.target.closest('[data-pin]')) return;
      if (opts.onBlank) opts.onBlank();
    });
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
    // Safari's own pinch, which would zoom the page under the map.
    canvas.addEventListener('gesturestart', (e) => e.preventDefault());

    // A wheel, or a trackpad pinch (which arrives as a wheel with ctrlKey and
    // small deltas): continuous, toward the cursor, at most one redraw a frame.
    let wheelDz = 0, wheelAt = null, wheelFrame = 0;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!pts().length) return;
      const k = e.ctrlKey ? 0.012 : 0.004;
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;   // lines, pages
      wheelDz += Math.max(-1, Math.min(1, -e.deltaY * unit * k));
      wheelAt = local(e);
      if (wheelFrame) return;
      wheelFrame = requestAnimationFrame(() => {
        wheelFrame = 0;
        view = zoomAround(current(), wheelDz, wheelAt);
        wheelDz = 0;
        render();
      });
    }, { passive: false });
  }

  return {
    render,
    zoomBy,
    focus,
    refit() { view = { z: null, cx: 0, cy: 0 }; render(); },
    // The box changed height (the Places list settling). While the map frames
    // its points it simply re-frames; once somebody has moved it, the view is
    // shifted so what was at the TOP stays at the top — the tiles were laid out
    // from there, and that is what the eye was holding on to.
    resized() {
      const { h } = size();
      if (view.z !== null && drawnH && h !== drawnH) {
        view = { ...view, cy: view.cy + (h - drawnH) / 2 / (TILE * 2 ** view.z) };
      }
      render();
    },
    resetDrops() { dropped.clear(); },
  };
}
