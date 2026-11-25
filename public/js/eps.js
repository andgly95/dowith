// A show's episodes, in its sheet: what is next (one tap, "Watched it"), each
// season as a row of numbered circles to tick, and a whole season at once. The
// server counts and decides (lib/episodes.js); this draws what it says.
//
// Ticking the last episode of a show that has ended finishes it — the server
// ticks it off and says `finished`, and the sheet hands over to the shelf's
// finale (space.js). A show still running says "All caught up" and stays.
import { $, esc } from './util.js';
import { get, post } from './api.js';
import { haptic, burst } from './motion.js';

let cur = null;   // { id, show, seen, progress, season, names: { [n]: [...] }, hooks }

const pad = (n) => String(n);
const epName = (s, e) => {
  const list = cur && cur.names[s];
  const x = list && list.find(y => y.e === e);
  return x && x.name ? x.name : '';
};
const shortDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export async function paintEpisodes(it, hooks) {
  const fld = $('isEpsFld');
  const w = it.mod && it.mod.watch;
  cur = null;
  fld.hidden = !(it.kind === 'show' && w && w.mediaType === 'tv');
  if (fld.hidden) return;
  $('isEpsCount').textContent = '';
  $('isEps').innerHTML = '<div class="ep-load"><i></i><i></i><i></i></div>';
  let b = null;
  try { b = await get(`/api/item/${it.id}/show`); } catch (_) { /* said below */ }
  if (!$('itemSheet') || $('itemSheet').hidden) return;
  if (!b || !b.ok) {
    $('isEps').innerHTML = `<p class="ep-none">${b && b.why === 'not-a-show'
      ? 'Pick which show it is, above, and its seasons appear here.'
      : 'Can’t reach TMDB for the seasons right now.'}</p>`;
    return;
  }
  const p = b.progress;
  const started = (p.next && p.next.s) || (p.seasons.filter(x => x.aired).pop() || p.seasons[0]).n;
  cur = { id: it.id, show: b.show, seen: b.seen, progress: p, season: started, names: {}, hooks };
  draw();
  loadNames(cur.season);
}

async function loadNames(n) {
  if (!cur || cur.names[n]) return;
  const id = cur.id;
  try {
    const b = await get(`/api/item/${id}/show/season/${n}`);
    if (!cur || cur.id !== id) return;
    cur.names[n] = b.episodes || [];
    draw();
  } catch (_) { /* numbers without names are still numbers */ }
}

function draw() {
  const p = cur.progress;
  $('isEpsCount').textContent = p.total ? `${p.seen} of ${p.total}` : '';
  let top;
  if (p.finished) {
    top = `<div class="ep-next done"><span class="ep-nt"><small>Seen it all</small><b>${p.total} episodes</b></span></div>`;
  } else if (p.caughtUp) {
    top = `<div class="ep-next done"><span class="ep-nt"><small>All caught up</small><b>${p.coming
      ? `S${pad(p.coming.s)} · E${pad(p.coming.e)}${p.coming.air ? ` on ${esc(shortDay(p.coming.air))}` : ''}`
      : 'More on the way'}</b></span></div>`;
  } else if (p.next) {
    const name = epName(p.next.s, p.next.e);
    top = `<div class="ep-next"><span class="ep-nt"><small>Next up</small><b>S${pad(p.next.s)} · E${pad(p.next.e)}</b>${name ? `<em>${esc(name)}</em>` : ''}</span>
      <button type="button" class="ep-go" data-next><span class="ring"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12.4l4.3 4.3L18.6 7.6"/></svg></span>Watched it</button></div>`;
  } else {
    top = '<p class="ep-none">Nothing has aired yet.</p>';
  }
  const seasons = p.seasons.map(x => `<button type="button" class="ep-sea${x.n === cur.season ? ' on' : ''}${x.aired && x.seen === x.aired ? ' full' : ''}"
      data-sea="${x.n}" aria-pressed="${x.n === cur.season}">S${x.n}<small>${x.aired ? `${x.seen}/${x.aired}` : 'soon'}</small></button>`).join('');
  const sea = p.seasons.find(x => x.n === cur.season) || p.seasons[0];
  const seen = new Set(cur.seen[sea.n] || []);
  const grid = Array.from({ length: sea.eps }, (_, i) => {
    const e = i + 1;
    const out = e <= sea.aired;
    const name = epName(sea.n, e);
    const on = seen.has(e);
    return `<button type="button" class="ep${on ? ' seen' : ''}${out ? '' : ' soon'}" data-e="${e}" ${out ? '' : 'disabled'}
      aria-pressed="${on}" aria-label="Episode ${e}${name ? `, ${esc(name)}` : ''}${out ? (on ? ', watched' : '') : ', not out yet'}"
      title="${esc(name || `Episode ${e}`)}">${e}</button>`;
  }).join('');
  const whole = sea.aired && sea.seen === sea.aired;
  $('isEps').innerHTML = `${top}<div class="ep-seasons">${seasons}</div><div class="ep-grid">${grid}</div>
    ${sea.aired ? `<button type="button" class="ep-all" data-all>${whole ? `Unmark season ${sea.n}` : `Mark season ${sea.n} watched`}</button>` : ''}`;
  bind();
}

function bind() {
  const box = $('isEps');
  const nx = box.querySelector('[data-next]');
  if (nx) nx.addEventListener('click', () => send({ s: cur.progress.next.s, e: cur.progress.next.e, seen: true }, nx));
  box.querySelectorAll('[data-sea]').forEach(b => b.addEventListener('click', () => {
    cur.season = Number(b.dataset.sea);
    haptic('tick');
    draw();
    loadNames(cur.season);
  }));
  box.querySelectorAll('[data-e]:not([disabled])').forEach(b => b.addEventListener('click', () => {
    const e = Number(b.dataset.e);
    send({ s: cur.season, e, seen: !(cur.seen[cur.season] || []).includes(e) }, b);
  }));
  const all = box.querySelector('[data-all]');
  if (all) all.addEventListener('click', () => {
    const sea = cur.progress.seasons.find(x => x.n === cur.season);
    send({ s: cur.season, seen: !(sea.aired && sea.seen === sea.aired) }, all);
  });
}

let busy = false;
async function send(body, el) {
  if (!cur || busy) return;
  busy = true;
  const id = cur.id;
  // The tap answers at once; the count follows the server.
  if (el && el.classList.contains('ep')) el.classList.toggle('seen', body.seen);
  if (el && el.matches('[data-next]')) el.classList.add('going');
  haptic(body.seen ? 'tick' : 'snap');
  let b;
  try {
    b = await post(`/api/item/${id}/episodes`, body);
  } catch (_) {
    busy = false;
    if (cur && cur.id === id) draw();
    return cur && cur.hooks.toast('Could not save that');
  }
  busy = false;
  if (!cur || cur.id !== id) return;
  cur.seen = b.seen;
  cur.progress = b.progress;
  if (b.finished) {
    // The last one. The sheet says so, then hands over to the shelf.
    draw();
    const top = $('isEps').querySelector('.ep-next');
    if (top) burst(top, { r: 26, n: 10, size: 5, ring: 1.8 });
    haptic('success');
    setTimeout(() => cur && cur.id === id && cur.hooks.finished(id, b), 650);
    return;
  }
  if (b.caughtUp) {
    draw();
    const top = $('isEps').querySelector('.ep-next');
    if (top) burst(top, { r: 26, n: 8, size: 4, ring: 1.8 });
    haptic('success');
  } else {
    // Moving on to the next season's episodes when this one is done.
    const p = b.progress;
    if (body.e !== undefined && p.next && p.next.s !== cur.season && body.seen) { cur.season = p.next.s; loadNames(cur.season); }
    draw();
  }
  cur.hooks.changed(b);
}

export const closeEpisodes = () => { cur = null; };
