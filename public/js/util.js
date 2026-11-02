export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function showScreen(id) {
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('active', el.id === id);
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export const initialOf = (name) => String(name || '?').trim().charAt(0).toUpperCase() || '?';

// "3 days ago" is friendlier than a date for a list you add to constantly.
export function ago(ts) {
  if (!ts) return '';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  const m = Math.floor(d / 30);
  return m === 1 ? 'a month ago' : `${m} months ago`;
}

// Closing a sheet has to put the viewport back: #app is fixed to the LAYOUT
// viewport, so iOS scrolling the document to reveal a focused field leaves the
// header above the fold with dead space where you tap.
export function closeSheet(id) {
  $(id).hidden = true;
  const el = document.activeElement;
  if (el && el !== document.body && typeof el.blur === 'function') el.blur();
  resetViewport();
}
export function openSheet(id) { $(id).hidden = false; }

// Make #app exactly as tall as what you can actually see.
//
// `height:100dvh` is right in every browser worth measuring, and is what this
// falls back to. But on iOS in standalone it can come up SHORT of the visual
// viewport — which leaves the bottom bar floating with a strip of dead page
// under it, looking like the app thinks the screen is smaller than it is. On a
// 956pt phone it was sixty-odd points short. `visualViewport.height` is the one
// measurement that is true by definition, so when it disagrees, it wins.
//
// Deliberately NOT applied while a field has focus: the keyboard shrinks the
// visual viewport by several hundred points, and squashing the whole app above
// it is far worse than leaving it alone for a moment.
//
// The trips app learned this the same way and the fix is the same; it is the
// one piece of iOS arithmetic worth copying verbatim rather than rediscovering.
export function fitViewport() {
  const vv = window.visualViewport;
  const app = $('app');
  if (!vv || !app) return;
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
  const want = Math.round(vv.height);
  // A point or two of disagreement is rounding, not a bug — don't fight it.
  if (Math.abs(app.getBoundingClientRect().height - want) < 2) {
    app.style.removeProperty('height');
    return;
  }
  app.style.height = `${want}px`;
}

export function watchViewport() {
  if (!window.visualViewport) return;
  const run = () => requestAnimationFrame(fitViewport);
  window.visualViewport.addEventListener('resize', run);
  window.addEventListener('orientationchange', () => setTimeout(run, 250));
  // Rotating or dismissing the keyboard settles a beat after the event.
  window.addEventListener('focusout', () => setTimeout(run, 120));
  run();
}

export function resetViewport() {
  window.scrollTo(0, 0);
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    setTimeout(() => window.scrollTo(0, 0), 260);
  });
}
