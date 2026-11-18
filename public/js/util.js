export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const calm = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// How deep a screen is, so moving between them has a direction: further in
// arrives from the right, back out arrives from the left. A screen not listed
// counts as the list.
const DEPTH = { 'scr-auth': 0, 'scr-shelf': 0, 'scr-space': 1, 'scr-kitchen': 2, 'scr-questions': 2, 'scr-cook': 2, 'scr-made': 3 };
const depth = (el) => (el && el.id in DEPTH ? DEPTH[el.id] : 1);

// The switch itself is synchronous — `.active` moves before this returns, so
// the DOM is final the instant a tap lands, as everywhere else. The motion is
// laid over it: the screen you left stays drawn (`.leaving`, no pointer events)
// just long enough to fade out the way you came, and the new one slides in a
// beat behind it. Two short fades rather than a slide-over, because a screen
// here carries no background of its own (Safari 26 samples one near the top
// edge for the status-bar tint) and a fade needs none.
export function showScreen(id) {
  const from = document.querySelector('.screen.active');
  for (const el of document.querySelectorAll('.screen')) {
    if (el.classList.contains('leaving')) settle(el);
    el.classList.toggle('active', el.id === id);
  }
  const to = $(id);
  if (!from || !to || from === to || calm() || !to.animate) return;
  const dir = depth(to) >= depth(from) ? 1 : -1;
  from.classList.add('leaving');
  from._leave = from.animate([
    { opacity: 1, transform: 'none' },
    { opacity: 0, transform: `translateX(${-dir * 24}px)` },
  ], { duration: 120, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
  from._leave.onfinish = () => settle(from);
  from._leaveT = setTimeout(() => settle(from), 220);
  to.animate([
    { opacity: 0, transform: `translateX(${dir * 28}px)` },
    { opacity: 1, transform: 'none' },
  ], { duration: 300, delay: 60, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
}
function settle(el) {
  clearTimeout(el._leaveT);
  el.classList.remove('leaving');
  if (el._leave) { el._leave.cancel(); el._leave = null; }
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
//
// `hidden` is set at once — every check in the app, and in the suite, reads a
// closed sheet as closed the moment this returns. What you SEE is `.leaving`:
// the sheet drawn for a fifth of a second more, untouchable, sliding down from
// wherever it was (a drag leaves it part-way, and it carries on from there)
// while the scrim clears. Rising and not falling read as the sheet blinking out.
export function closeSheet(id) {
  const m = $(id);
  const was = !m.hidden;
  m.hidden = true;
  const el = document.activeElement;
  if (el && el !== document.body && typeof el.blur === 'function') el.blur();
  resetViewport();
  // Already closed: a tap on the scrim can arrive by two routes (a sheet's own
  // handler and the shared one through its X), and the second must not cut
  // the first one's exit short.
  if (!was || calm()) return;
  clearTimeout(m._leaveT);
  m.classList.add('leaving');
  m._leaveT = setTimeout(() => unleave(m), 240);
}
export function openSheet(id) {
  const m = $(id);
  clearTimeout(m._leaveT);
  unleave(m);
  m.hidden = false;
}
function unleave(m) {
  m.classList.remove('leaving');
  const panel = m.querySelector('.modal-in');
  if (panel) panel.style.transform = '';
}

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
