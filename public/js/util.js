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

export function resetViewport() {
  window.scrollTo(0, 0);
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    setTimeout(() => window.scrollTo(0, 0), 260);
  });
}
