// The things that make it feel like it is in your hand: a sheet you can pull
// down, a buzz under your thumb when something lands, a burst when something
// worth marking happens, posters that arrive rather than pop.
//
// Every one of these is decoration over a screen that is already correct.
// Nothing here is awaited by anything that changes state, and reduced motion
// gets the state change with none of it (haptics excepted — they are not
// motion, and the phone's own setting governs them).
import { calm } from './util.js';

/* ── haptics ──────────────────────────────────────────────────────────────
   Android has navigator.vibrate. iOS has never had it — but Safari 18 gives a
   system tick when an <input switch> toggles, and a label click toggles one.
   That is a workaround Apple could close, so it is only ever an extra: nothing
   is said by a buzz alone. Must run inside the tap's own handler on iOS. */
const PATTERN = { tick: 8, snap: 12, success: [14, 70, 22] };
const IOS = typeof navigator !== 'undefined'
  && (/iP(hone|ad|od)/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

function iosTick() {
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  label.appendChild(input);
  document.head.appendChild(label);
  label.click();
  label.remove();
}

export function haptic(kind = 'tick') {
  try {
    // Chrome refuses (and logs) a buzz before the page has ever been tapped.
    const ua = navigator.userActivation;
    if (ua && !ua.hasBeenActive) return;
    if (typeof navigator.vibrate === 'function' && !IOS) { navigator.vibrate(PATTERN[kind] || 10); return; }
    if (!IOS) return;
    iosTick();
    if (kind === 'success') setTimeout(iosTick, 110);
  } catch (_) { /* a buzz is never worth an error */ }
}

/* ── a burst ──────────────────────────────────────────────────────────────
   The ring-and-sparks from ticking something off, for the other moments worth
   marking (Made it, We went here). `r` is the radius the sparks start from, so
   one recipe serves a 26px ring and an 88px badge; `ring` is how far the ripple
   grows (×2.6 suits a small ring, and on a big badge runs off the screen).
   The host needs a position. */
export function burst(el, { r = 13, n = 6, size = 4, ring = 2.6 } = {}) {
  if (!el || calm()) return;
  const fx = document.createElement('span');
  fx.className = 'fx';
  fx.setAttribute('aria-hidden', 'true');
  fx.style.setProperty('--r', `${r}px`);
  fx.style.setProperty('--s', `${size}px`);
  fx.style.setProperty('--rs', String(ring));
  fx.innerHTML = `<i class="fx-ripple"></i>${Array.from({ length: n }, (_, i) =>
    `<i class="fx-spark" style="--a:${Math.round((i * 360) / n)}deg"></i>`).join('')}`;
  el.appendChild(fx);
  setTimeout(() => fx.remove(), 900);
}

/* ── pulling a sheet down ─────────────────────────────────────────────────
   Every sheet carries a grabber, and a grabber is a promise: pull it and the
   sheet follows your finger. Let go past a third of the way (or with a flick)
   and it closes THROUGH ITS OWN X, like a tap on the scrim, so whatever closing
   that sheet does still happens. Short of that it springs back.

   Touch events, not pointer events, because the page must keep scrolling: the
   decision is made on the FIRST move — down, with nothing above to scroll back
   to — and from then on this owns the gesture and the browser does not scroll.
   A later preventDefault is too late on a phone that has started scrolling.
   Things with gestures of their own are left alone: fields, the rose's deck,
   a map that pans. */
const OWN = 'input, textarea, select, [contenteditable], .rs-card, [data-nodrag]';

function scrolledAbove(t, stop) {
  for (let el = t; el && el !== stop.parentElement; el = el.parentElement) {
    if (el.scrollTop > 0) return true;
  }
  return false;
}

export function sheetDrag(modal, close) {
  const panel = modal.querySelector('.modal-in');
  if (!panel) return;
  let g = null;   // { y0, x0, dy, t, v, live }
  panel.addEventListener('touchstart', (e) => {
    g = null;
    if (e.touches.length !== 1) return;
    const t = e.target;
    if (t.closest(OWN) || (t.closest('.map-canvas') && !t.closest('.map-canvas').closest('.pl-snip'))) return;
    const p = e.touches[0];
    g = { y0: p.clientY, x0: p.clientX, dy: 0, t: e.timeStamp, v: 0, live: false, decided: false, target: t };
  }, { passive: true });

  panel.addEventListener('touchmove', (e) => {
    if (!g) return;
    const p = e.touches[0];
    const dy = p.clientY - g.y0, dx = p.clientX - g.x0;
    if (!g.decided) {
      if (!dy && !dx) return;
      g.decided = true;
      if (!(dy > 0 && dy >= Math.abs(dx)) || scrolledAbove(g.target, panel) || !e.cancelable) { g = null; return; }
      // Measured from where the finger went DOWN, not from this first move:
      // Chrome holds back moves inside its touch slop, and starting from here
      // left the sheet a slop's width behind the finger for the whole drag.
      g.live = true;
      panel.style.transition = 'none';
    }
    e.preventDefault();
    const now = Math.max(0, p.clientY - g.y0);
    const dt = Math.max(1, e.timeStamp - g.t);
    g.v = 0.8 * ((now - g.dy) / dt) + 0.2 * g.v;   // px/ms, smoothed
    g.dy = now;
    g.t = e.timeStamp;
    panel.style.transform = `translateY(${now}px)`;
    const past = now > panel.offsetHeight / 3;
    if (past !== !!g.past) { g.past = past; if (past) haptic('snap'); }
  }, { passive: false });

  const end = () => {
    if (!g || !g.live) { g = null; return; }
    const { dy, v } = g;
    g = null;
    if (dy > panel.offsetHeight / 3 || (v > 0.55 && dy > 24)) { close(); return; }
    const from = panel.style.transform;
    panel.style.transform = '';
    panel.style.transition = '';
    if (!calm() && panel.animate && dy > 0) {
      panel.animate([{ transform: from }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,1.2,.4,1)' });
    }
  };
  panel.addEventListener('touchend', end);
  panel.addEventListener('touchcancel', end);
}

/* ── pictures that arrive ─────────────────────────────────────────────────
   A poster or a recipe photo fades in when it loads instead of popping in a
   row at a time. Only the FIRST time this page has seen that picture: the list
   re-renders on every tick, and re-fading a shelf of posters each time would be
   a flicker, not a flourish. */
const seenImg = new Set();
export function fadeIn(root) {
  if (!root) return;
  root.querySelectorAll('img.fade').forEach((img) => {
    const src = img.getAttribute('src');
    if (calm() || seenImg.has(src) || (img.complete && img.naturalWidth)) {
      seenImg.add(src);
      img.classList.add('in', 'now');
      return;
    }
    img.addEventListener('load', () => { seenImg.add(src); img.classList.add('in'); }, { once: true });
  });
}

/* ── placeholder rows ─────────────────────────────────────────────────────
   What a list looks like before it has arrived: its shape, breathing, rather
   than the word "Loading…". */
export function skeleton(rows = 4) {
  return `<div class="skel" aria-label="Loading" role="status">${'<div class="group">'
    + Array.from({ length: rows }, (_, i) => `<div class="skel-row"><i class="skel-tile"></i><span><i style="width:${[62, 48, 70, 40, 56][i % 5]}%"></i><i></i></span><i class="skel-ring"></i></div>`).join('')
    + '</div>'}</div>`;
}
