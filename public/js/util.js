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

// There was a fitViewport()/watchViewport() here that sized #app from
// `visualViewport.height`. It is gone, and the reason is worth keeping: on the
// phone this was built for, the visual viewport reports the SAFE area and
// agrees with `100dvh` — so measuring against it reproduced the bug it was
// meant to fix, and would now fight `inset:0` by shrinking the shell back.
//
// The trips app keeps its version because there the failure is the opposite:
// Safari-with-chrome, where dvh can be short of what you can see. Same symptom,
// different cause, opposite fix. Do not port it back without measuring first.

export function resetViewport() {
  window.scrollTo(0, 0);
  requestAnimationFrame(() => {
    window.scrollTo(0, 0);
    setTimeout(() => window.scrollTo(0, 0), 260);
  });
}

// A title's leading emoji, split off for the tile on a row — presentation only.
// The stored title is never touched: the edit field shows the whole string, and
// a title typed with no space after the emoji ("🏋️Work out") lines up like the
// rest. ZWJ sequences, skin tones and flags included. A title that is ONLY an
// emoji keeps itself as the words too, so a row is never blank.
//
// Also what a place search is sent without: Photon has never heard of "🍜".
const LEAD = /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|⃣|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍\p{Extended_Pictographic})*)\s*/u;
export function leadEmoji(title) {
  const t = String(title || '');
  const m = LEAD.exec(t);
  if (!m) return { emoji: '', rest: t };
  return { emoji: m[1], rest: t.slice(m[0].length) || t };
}

// Metres between two points, as the crow flies. Good to a few metres at city
// scale, which is all "3.6 mi" needs.
export function metres(a, b) {
  if (!a || !b) return null;
  const R = 6371e3, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Miles where people think in miles, kilometres everywhere else.
const MILES = /^en-(US|GB|LR|MM)$/i.test((typeof navigator !== 'undefined' && navigator.language) || '');
export function distLabel(m) {
  if (m === null || m === undefined || !Number.isFinite(m)) return '';
  if (MILES) {
    const mi = m / 1609.344;
    return mi < 0.1 ? 'here' : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  const km = m / 1000;
  return km < 0.1 ? 'here' : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

// "Oct 4", or "Oct 4, 2025" once it is not this year.
export function shortDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}
