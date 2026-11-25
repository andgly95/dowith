// Suggestions: what on this list would be good for THEN. You say how much
// energy you have and when it is for; the server weighs everything (energy,
// the hour, the weather then, open or closed, how long it takes each of you to
// get there, your thumbs) and sends back a PLAN — one thing after another,
// each piece swappable — and the whole list in order. lib/suggest.js decides;
// this draws it, and never ranks anything itself.
import { S } from './state.js';
import { $, esc, toast, openSheet, closeSheet } from './util.js';
import { get, post } from './api.js';
import { haptic, skeleton, burst } from './motion.js';
import { wxOf, deg, hourWords } from './wx.js';
import { icon } from './icons.js';

const WORDS = ['', 'Wiped out', 'Low', 'Okay', 'Good', 'Full of it'];
const ROLE = { eat: 'a meal', drink: 'a drink', watch: 'something to watch', do: 'something to do' };
const KIND_PLURAL = () => Object.fromEntries(((S.wire && S.wire.kinds) || []).map(k => [k.id, k.plural]));

let hooks = { openItem() {}, refresh: async () => {}, tileHtml: () => '' };
const st = { energy: 3, when: 'now', date: '', time: '', through: false, keep: {}, data: null, more: false,
  ideas: null, ideasBusy: false, seq: 0, polls: 0, timer: null, space: null };
try {
  const saved = JSON.parse(localStorage.getItem('dw-sug') || '{}');
  if (saved.energy >= 1 && saved.energy <= 5) st.energy = saved.energy;
  if (typeof saved.through === 'boolean') st.through = saved.through;
} catch (_) { /* a fresh start is fine */ }
const remember = () => { try { localStorage.setItem('dw-sug', JSON.stringify({ energy: st.energy, through: st.through })); } catch (_) { /* private mode */ } };

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } };

// When it is for, on the phone's own calendar and clock.
function whenAt() {
  const now = new Date();
  if (st.when === 'tonight') return { date: dayOf(now), time: clock(now) > '19:00' ? clock(now) : '19:00' };
  if (st.when === 'tomorrow') return { date: dayOf(new Date(now.getTime() + 864e5)), time: '11:00' };
  if (st.when === 'pick' && st.date) return { date: st.date, time: st.time || '12:00' };
  return { date: dayOf(now), time: clock(now) };
}
function dayWord(date) {
  const now = new Date();
  if (date === dayOf(now)) return 'Today';
  if (date === dayOf(new Date(now.getTime() + 864e5))) return 'Tomorrow';
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

/* ── loading ────────────────────────────────────────────────────────────── */

async function load({ quiet = false } = {}) {
  const sid = S.spaceId;
  const seq = ++st.seq;
  clearTimeout(st.timer);
  const at = whenAt();
  const keep = Object.entries(st.keep).map(([k, id]) => `${k}:${id}`).join(',');
  if (!quiet && !st.data && $('sgBody')) $('sgBody').innerHTML = skeleton();
  let b;
  try {
    b = await get(`/api/space/${sid}/suggest?energy=${st.energy}&at=${at.date}T${at.time}&tz=${encodeURIComponent(zone())}`
      + `&through=${st.through ? 1 : 0}${keep ? `&keep=${encodeURIComponent(keep)}` : ''}`);
  } catch (_) {
    if (seq === st.seq && $('sgBody') && !st.data) $('sgBody').innerHTML = '<p class="sg-none">Could not work that out just now.</p>';
    return;
  }
  if (seq !== st.seq || S.spaceId !== sid) return;
  st.data = b;
  paint();
  // Weather, hours and journeys arrive behind the first answer; so do Claude's
  // profiles of what each thing asks of you. Ask again while they are coming.
  if ((b.pending || b.profiling) && st.polls < 7) {
    st.polls++;
    st.timer = setTimeout(() => { if ($('sgBody')) load({ quiet: true }); }, b.pending ? 1800 : 6000);
  }
}
const reload = () => { st.polls = 0; return load({ quiet: true }); };

/* ── drawing ────────────────────────────────────────────────────────────── */

const itemOf = (id) => (S.items || []).find(x => x.id === id) || null;

function lineChip(l) {
  if (!l.line) return '';
  const hex = l.color || '';
  const lum = hex ? (parseInt(hex.slice(0, 2), 16) * 299 + parseInt(hex.slice(2, 4), 16) * 587 + parseInt(hex.slice(4, 6), 16) * 114) / 1000 : 0;
  return `<i class="ln" style="${hex ? `background:#${esc(hex)};color:${lum > 150 ? '#111' : '#fff'}` : ''}">${esc(l.line)}</i>`;
}
function transitHtml(legs) {
  if (!legs || !legs.length) return '';
  return `<div class="sg-tr">${legs.map(l => `<span>${esc(l.mine ? 'You' : l.name)} ${l.about ? 'about ' : ''}${l.minutes} min${
    l.walk ? ' walk' : ''}${(l.lines || []).map(lineChip).join('')}</span>`).join('<span class="dot">·</span>')}</div>`;
}
const UP = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11"/><path d="M14.6 5.9 13.8 10h5.3a1.9 1.9 0 0 1 1.8 2.4l-2.1 7.2a1.9 1.9 0 0 1-1.8 1.4H4.9A1.9 1.9 0 0 1 3 19.1v-7.2A1.9 1.9 0 0 1 4.9 10h2.4a1.9 1.9 0 0 0 1.7-1L12 3a2.9 2.9 0 0 1 2.6 2.9z"/></svg>';
const DOWN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V3"/><path d="M9.4 18.1 10.2 14H4.9a1.9 1.9 0 0 1-1.8-2.4l2.1-7.2A1.9 1.9 0 0 1 7 3h12.1A1.9 1.9 0 0 1 21 4.9v7.2a1.9 1.9 0 0 1-1.9 1.9h-2.4a1.9 1.9 0 0 0-1.7 1L12 21a2.9 2.9 0 0 1-2.6-2.9z"/></svg>';
const thumbs = (v, attrs) => `<span class="sg-th"><button type="button" ${attrs} data-v="1" aria-pressed="${v > 0}" aria-label="More like this">${UP}</button>
  <button type="button" ${attrs} data-v="-1" aria-pressed="${v < 0}" aria-label="Not this">${DOWN}</button></span>`;

// One thing, weighed: its tile, its words, why, how to get there, and thumbs.
function rowHtml(x, { slot = null } = {}) {
  const it = itemOf(x.id);
  if (!it) return '';
  const kind = ((S.wire && S.wire.kinds) || []).find(k => k.id === it.kind);
  const why = x.reasons.map(r => `<span class="${r.tone}">${esc(r.text)}</span>`).join('<span class="dot">·</span>');
  return `<div class="sg-it" data-sit="${esc(x.id)}"${slot ? ` data-in="${esc(slot)}"` : ''}>
    ${hooks.tileHtml(it)}
    <div class="sg-bd" data-open><b>${esc(it.title.replace(/^\p{Extended_Pictographic}\S*\s*/u, '') || it.title)}</b>
      <div class="sg-why">${kind ? `<span class="k">${esc(kind.label)}</span>${why ? '<span class="dot">·</span>' : ''}` : ''}${why}</div>
      ${transitHtml(x.transit)}</div>
    ${thumbs(x.vote, 'data-vote')}
  </div>`;
}

function planHtml(d) {
  if (!d.plan.length) return '';
  let day = null;
  const parts = [];
  for (const sl of d.plan) {
    if (sl.date !== day) {
      day = sl.date;
      const first = d.plan.filter(x => x.date === day)[0];
      parts.push(`<div class="sg-day">${esc(dayWord(day) === 'Today' && first.time >= '17:00' ? 'Tonight' : dayWord(day))}</div>`);
    }
    parts.push(`<div class="sg-slot" data-slot="${esc(sl.key)}">
      <div class="sg-sh"><b>${esc(sl.label)}</b><small>around ${esc(hourWords(sl.time))}</small>
        <button type="button" class="sg-swap" data-swap="${esc(sl.key)}">${sl.pick ? 'Swap' : 'Get ideas'}</button></div>
      ${sl.pick ? rowHtml(sl.pick, { slot: sl.key }) : `<p class="sg-none">Nothing on your list for ${ROLE[sl.role]} then.</p>`}
    </div>`);
  }
  return `<h3 class="sec">A plan <em>each piece can be swapped</em></h3><div class="sg-plan">${parts.join('')}</div>
    <button type="button" class="primary" id="sgPlanIt">Put it on the calendar</button>`;
}

function paint() {
  const d = st.data;
  const body = $('sgBody');
  if (!body || !d) return;
  const w = d.weather;
  const wx = w ? `<div class="sg-wx"><span aria-hidden="true">${wxOf(w.code).icon}</span> <b>${deg(w.t)}</b> ${esc(wxOf(w.code).label.toLowerCase())}${
    Number.isFinite(w.rain) && w.rain >= 30 ? ` · ${w.rain}% rain` : ''} <small>${esc(dayWord(d.at.date))} ${esc(hourWords(d.at.time))}</small></div>` : '';
  const inPlan = new Set(d.plan.map(sl => sl.pick && sl.pick.id).filter(Boolean));
  const rest = d.good.filter(x => !inPlan.has(x.id));
  const shown = st.more ? rest : rest.slice(0, 8);
  const good = rest.length ? `<h3 class="sec">Also good then <em>${rest.length}</em></h3><div class="group sg-list">${shown.map(x => rowHtml(x)).join('')}</div>
    ${rest.length > shown.length ? `<button type="button" class="ghost" id="sgMore">Show ${rest.length - shown.length} more</button>` : ''}` : '';
  const not = d.notThen.length ? `<details class="sg-not"><summary>Not then <em>${d.notThen.length}</em></summary>
    <div class="group sg-list">${d.notThen.map(x => rowHtml(x)).join('')}</div></details>` : '';
  const from = d.people.filter(p => p.stations !== null);
  const fromLine = from.map(p => `${p.mine ? 'You' : p.name}: ${p.stations.length ? p.stations.map(x => x.name).join(', ') : 'not set'}`).join(' · ');
  $('sgFrom').innerHTML = `${icon('pin', 18)}<span class="cb"><b>${d.needsStations ? 'Set where you each start from' : 'Starting from'}</b>
    <small>${esc(d.needsStations ? 'Your nearest station, for travel times' : fromLine)}</small></span>`;
  const learning = d.profiling ? '<p class="sg-learn">Getting to know your list. These sharpen in a minute.</p>' : '';
  body.innerHTML = `${wx}${learning}${planHtml(d)}${good}${not}${ideasHtml(d)}`;
  bind();
}

function ideasHtml(d) {
  if (!d.ideas) return '';
  const plural = KIND_PLURAL();
  const list = st.ideas;
  return `<h3 class="sec">New ideas <em>not on your list yet</em></h3>
    ${st.ideasBusy ? skeleton() : list && list.length ? `<div class="group sg-list">${list.map((x, i) => `<div class="sg-it idea" data-idea="${i}">
      <div class="sg-bd"><b>${esc(x.title)}</b><div class="sg-why"><span class="k">${esc(plural[x.kind] || x.kind)}</span><span class="dot">·</span><span>${esc(x.why)}</span></div>
        <button type="button" class="sg-add" data-add="${i}"${x.added ? ' disabled' : ''}>${x.added ? 'On your list' : `Add to ${esc(plural[x.kind] || 'the list')}`}</button></div>
      ${thumbs(x.vote || 0, `data-ivote="${i}"`)}</div>`).join('')}</div>` : ''}
    <button type="button" class="ghost" id="sgIdeas"${st.ideasBusy ? ' disabled' : ''}>${list ? 'Suggest different ones' : 'Suggest new ideas'}</button>`;
}

/* ── doing ──────────────────────────────────────────────────────────────── */

async function sendVote(body, v) {
  const at = whenAt();
  try { await post(`/api/space/${S.spaceId}/suggest/vote`, { ...body, v, at: `${at.date}T${at.time}` }); return true; } catch (_) { toast('Could not save that'); return false; }
}

async function addIdea(x) {
  const b = await post(`/api/space/${S.spaceId}/item`, { title: x.title, kind: x.kind, visibility: 'shared' });
  await hooks.refresh();
  return b.item;
}

async function askIdeas(role = null) {
  const at = whenAt();
  const b = await post(`/api/space/${S.spaceId}/suggest/ideas`, { energy: st.energy, at: `${at.date}T${at.time}`, tz: zone(), role });
  if (!b.ok) {
    toast(b.why === 'slow-down' ? 'That’s a lot of ideas. Try again in a bit.' : b.why === 'none' ? 'Nothing new came to mind. Try again.'
      : b.why === 'declined' ? 'It would not suggest for that.' : 'Could not get ideas just now.');
    return null;
  }
  return b.ideas;
}

function bind() {
  const body = $('sgBody');
  body.querySelectorAll('.sg-it[data-sit] [data-open]').forEach(el => el.addEventListener('click', () => hooks.openItem(el.closest('[data-sit]').dataset.sit)));
  body.querySelectorAll('[data-vote]').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const row = b.closest('[data-sit]');
    const id = row.dataset.sit;
    const was = b.getAttribute('aria-pressed') === 'true';
    const v = was ? 0 : Number(b.dataset.v);
    row.querySelectorAll('[data-vote]').forEach(x => x.setAttribute('aria-pressed', String(!was && x === b)));
    haptic('tick');
    if (v > 0) burst(b, { r: 12, n: 6, size: 3 });
    if (!(await sendVote({ item: id }, v))) return;
    // A thumb down on a piece of the plan makes room for something else.
    if (v < 0 && row.dataset.in) delete st.keep[row.dataset.in];
    reload();
  }));
  body.querySelectorAll('[data-swap]').forEach(b => b.addEventListener('click', () => openSwap(b.dataset.swap)));
  const more = $('sgMore');
  if (more) more.addEventListener('click', () => { st.more = true; paint(); });
  const planIt = $('sgPlanIt');
  if (planIt) planIt.addEventListener('click', putOnCalendar);
  const ask = $('sgIdeas');
  if (ask) ask.addEventListener('click', async () => {
    st.ideasBusy = true;
    paint();
    let list = null;
    try { list = await askIdeas(); } catch (_) { toast('Could not get ideas just now.'); }
    st.ideasBusy = false;
    if (list) st.ideas = list;
    paint();
  });
  body.querySelectorAll('[data-ivote]').forEach(b => b.addEventListener('click', async () => {
    const x = st.ideas[Number(b.dataset.ivote)];
    const v = x.vote === Number(b.dataset.v) ? 0 : Number(b.dataset.v);
    haptic('tick');
    if (await sendVote({ idea: x }, v)) { x.vote = v; paint(); }
  }));
  body.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', async () => {
    const x = st.ideas[Number(b.dataset.add)];
    b.disabled = true;
    try {
      await addIdea(x);
      x.added = true;
      haptic('success');
      toast(`Added to ${KIND_PLURAL()[x.kind] || 'your list'}`);
      reload();
    } catch (_) { b.disabled = false; toast('Could not add that'); }
  }));
}

async function putOnCalendar() {
  const d = st.data;
  const picks = d.plan.filter(sl => sl.pick);
  if (!picks.length) return;
  const btn = $('sgPlanIt');
  btn.disabled = true;
  let done = 0;
  for (const sl of picks) {
    try { await post(`/api/item/${sl.pick.id}/when`, { date: sl.date, time: sl.time }); done++; } catch (_) { /* counted below */ }
  }
  haptic('success');
  toast(done === picks.length ? `${done === 1 ? 'It is' : `All ${done} are`} on the calendar` : `${done} of ${picks.length} went on the calendar`);
  await hooks.refresh();
  reload();
}

/* ── swapping one piece ─────────────────────────────────────────────────── */

let swapping = null;   // { key, ideas, busy }
function openSwap(key) {
  swapping = { key, ideas: null, busy: false };
  paintSwap();
  openSheet('sgSwapSheet');
}
function paintSwap() {
  const sl = st.data && st.data.plan.find(x => x.key === swapping.key);
  if (!sl) return closeSheet('sgSwapSheet');
  $('sgSwapTitle').textContent = `${sl.label} · ${dayWord(sl.date)}`;
  $('sgSwapSub').textContent = `around ${hourWords(sl.time)}`;
  const plural = KIND_PLURAL();
  const alts = sl.alts.length ? `<div class="group sg-list">${sl.alts.map(x => rowHtml(x).replace('data-open', 'data-use')).join('')}</div>`
    : `<p class="sg-none">Nothing else on your list for ${ROLE[sl.role]} then.</p>`;
  const ideas = swapping.busy ? skeleton() : swapping.ideas ? `<div class="group sg-list">${swapping.ideas.map((x, i) => `<div class="sg-it idea">
      <div class="sg-bd"><b>${esc(x.title)}</b><div class="sg-why"><span class="k">${esc(plural[x.kind] || x.kind)}</span><span class="dot">·</span><span>${esc(x.why)}</span></div>
        <button type="button" class="sg-add" data-useidea="${i}">Add it and use this</button></div></div>`).join('')}</div>` : '';
  $('sgSwapBody').innerHTML = `<h3 class="sec">From your list</h3>${alts}
    ${st.data.ideas ? `<h3 class="sec">Something new</h3>${ideas}<button type="button" class="ghost" id="sgSwapIdeas"${swapping.busy ? ' disabled' : ''}>
      ${swapping.ideas ? 'Suggest different ones' : `Suggest ${ROLE[sl.role]}`}</button>` : ''}`;
  const box = $('sgSwapBody');
  box.querySelectorAll('.sg-th').forEach(x => x.remove());   // choosing here; thumbs live on the main screen
  box.querySelectorAll('[data-use]').forEach(el => el.addEventListener('click', () => {
    st.keep[swapping.key] = el.closest('[data-sit]').dataset.sit;
    haptic('tick');
    closeSheet('sgSwapSheet');
    reload();
  }));
  const ask = $('sgSwapIdeas');
  if (ask) ask.addEventListener('click', async () => {
    swapping.busy = true;
    paintSwap();
    let list = null;
    try { list = await askIdeas(sl.role === 'do' ? 'do' : sl.role); } catch (_) { toast('Could not get ideas just now.'); }
    if (!swapping) return;
    swapping.busy = false;
    if (list) swapping.ideas = list;
    paintSwap();
  });
  box.querySelectorAll('[data-useidea]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const made = await addIdea(swapping.ideas[Number(b.dataset.useidea)]);
      st.keep[swapping.key] = made.id;
      haptic('success');
      closeSheet('sgSwapSheet');
      reload();
    } catch (_) { b.disabled = false; toast('Could not add that'); }
  }));
}

/* ── where you each start from ──────────────────────────────────────────── */

let stn = null;   // { people: [{ id, name, mine, stations }], results: { [uid]: [...] } }
async function openStations() {
  const people = ((st.data && st.data.people) || []).filter(p => p.canSet);
  stn = { people: people.map(p => ({ ...p, stations: (p.stations || []).slice() })), results: {} };
  paintStations();
  openSheet('sgStationSheet');
}
const modeWords = (modes) => {
  const m = modes || [];
  return m.includes('SUBWAY') || m.includes('METRO') ? 'Metro' : m.includes('TRAM') ? 'Tram' : m.some(x => /RAIL/.test(x)) ? 'Rail' : m.includes('BUS') ? 'Bus' : '';
};
function paintStations() {
  $('sgStationBody').innerHTML = stn.people.map(p => `<div class="sg-who" data-who="${esc(p.id)}">
    <h3 class="sec">${esc(p.mine ? 'You' : p.name)} <em>${p.stations.length ? `${p.stations.length} of 3` : 'not set'}</em></h3>
    ${p.stations.length ? `<div class="box rows">${p.stations.map((x, i) => `<div class="crow"><i>${icon('pin', 20)}</i>
      <span class="cb"><b>${esc(x.name)}</b><small>${esc([modeWords(x.modes), x.area].filter(Boolean).join(' · '))}</small></span>
      <span class="val"><button type="button" class="sg-rm" data-rm="${i}" aria-label="Remove ${esc(x.name)}">Remove</button></span></div>`).join('')}</div>` : ''}
    ${p.stations.length < 3 ? `<label class="fld"><span>Add a station</span>
      <input type="search" data-q maxlength="80" placeholder="Search by name" autocomplete="off" autocapitalize="words"></label>
      <div class="sugs" data-res>${(stn.results[p.id] || []).map((x, i) => `<button type="button" class="sug" data-pick="${i}">
        <b>${esc(x.name)}</b><small>${esc([modeWords(x.modes), x.area].filter(Boolean).join(' · '))}</small></button>`).join('')}</div>` : ''}
  </div>`).join('') || '<p class="sg-none">Nobody here to set a station for.</p>';
  $('sgStationBody').querySelectorAll('[data-who]').forEach((box) => {
    const p = stn.people.find(x => x.id === box.dataset.who);
    const save = async () => {
      try {
        const r = await post(`/api/people/${encodeURIComponent(p.id)}/stations`, { stations: p.stations });
        p.stations = r.stations;
      } catch (_) { toast('Could not save that'); }
      paintStations();
    };
    box.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { p.stations.splice(Number(b.dataset.rm), 1); haptic('tick'); save(); }));
    const q = box.querySelector('[data-q]');
    let timer = null;
    if (q) q.addEventListener('input', () => {
      clearTimeout(timer);
      const text = q.value.trim();
      timer = setTimeout(async () => {
        if (text.length < 2) return;
        let r;
        try { r = await get(`/api/transit/stops?q=${encodeURIComponent(text)}&space=${encodeURIComponent(S.spaceId)}`); } catch (_) { return; }
        if (!stn || q.value.trim() !== text) return;
        stn.results[p.id] = r.results || [];
        const res = box.querySelector('[data-res]');
        res.innerHTML = stn.results[p.id].length ? stn.results[p.id].map((x, i) => `<button type="button" class="sug" data-pick="${i}">
          <b>${esc(x.name)}</b><small>${esc([modeWords(x.modes), x.area].filter(Boolean).join(' · '))}</small></button>`).join('')
          : `<p class="sg-none">${r.ok ? 'No station by that name.' : 'Can’t search stations right now.'}</p>`;
        bindPicks();
      }, 300);
    });
    const bindPicks = () => box.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
      p.stations.push(stn.results[p.id][Number(b.dataset.pick)]);
      stn.results[p.id] = [];
      haptic('tick');
      save();
    }));
    bindPicks();
  });
}

/* ── the screen ─────────────────────────────────────────────────────────── */

// Called by space.js's render() whenever the Suggestions view is up. The
// controls are built once and kept — a slider must not be redrawn under a thumb
// — and only the answer below them repaints.
export function renderSuggest(list) {
  if (st.space !== S.spaceId) { st.space = S.spaceId; st.data = null; st.keep = {}; st.ideas = null; st.more = false; }
  if (list.querySelector('.sg')) { if (st.data) paint(); return; }
  const chips = [['now', 'Now'], ['tonight', 'Tonight'], ['tomorrow', 'Tomorrow'], ['pick', 'Pick a time']];
  list.innerHTML = `<div class="sg">
    <div class="box sg-ctl">
      <div class="sg-row"><b>How much energy do you have?</b><span id="sgWord">${WORDS[st.energy]}</span></div>
      <input type="range" id="sgEnergy" class="sg-slider" min="1" max="5" step="1" value="${st.energy}" aria-label="Energy, from 1, wiped out, to 5, full of it">
      <div class="sg-ends"><span>Wiped out</span><span>Full of it</span></div>
      <div class="sg-row"><b>For when?</b></div>
      <div class="chips sg-when">${chips.map(([k, l]) => `<button type="button" data-when="${k}" class="${st.when === k ? 'on' : ''}" aria-pressed="${st.when === k}">${l}</button>`).join('')}</div>
      <div class="when-row sg-pick" id="sgPick" ${st.when === 'pick' ? '' : 'hidden'}>
        <label class="ifield"><input id="sgDate" type="date" aria-label="Day" value="${esc(st.date)}"></label>
        <label class="ifield"><input id="sgTime" type="time" aria-label="Time" value="${esc(st.time)}"></label></div>
      <label class="crow sg-thru"><span class="cb"><b>Carry on into the next day</b><small>A morning, an afternoon and dinner</small></span>
        <input type="checkbox" class="switch" id="sgThrough"${st.through ? ' checked' : ''}></label>
      <button type="button" class="crow sg-from" id="sgFrom"></button>
    </div>
    <div id="sgBody"></div></div>`;
  $('sgEnergy').addEventListener('input', (e) => {
    st.energy = Number(e.target.value);
    $('sgWord').textContent = WORDS[st.energy];
    haptic('tick');
    remember();
    clearTimeout(st.slide);
    st.slide = setTimeout(reload, 250);
  });
  list.querySelectorAll('[data-when]').forEach(b => b.addEventListener('click', () => {
    st.when = b.dataset.when;
    list.querySelectorAll('[data-when]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    $('sgPick').hidden = st.when !== 'pick';
    if (st.when === 'pick' && !st.date) { st.date = dayOf(new Date()); st.time = '19:00'; $('sgDate').value = st.date; $('sgTime').value = st.time; }
    st.keep = {};
    haptic('tick');
    reload();
  }));
  for (const [id, key] of [['sgDate', 'date'], ['sgTime', 'time']]) $(id).addEventListener('change', (e) => { st[key] = e.target.value; st.keep = {}; reload(); });
  $('sgThrough').addEventListener('change', (e) => { st.through = e.target.checked; remember(); haptic('tick'); reload(); });
  $('sgFrom').addEventListener('click', openStations);
  $('sgFrom').innerHTML = `${icon('pin', 18)}<span class="cb"><b>Starting from</b><small>…</small></span>`;
  if (st.data) paint();
  st.polls = 0;
  load({ quiet: !!st.data });
}

export function leaveSuggest() { clearTimeout(st.timer); st.seq++; }

export function initSuggest(h) {
  hooks = { ...hooks, ...h };
  $('sgSwapClose').addEventListener('click', () => { swapping = null; closeSheet('sgSwapSheet'); });
  $('sgStationClose').addEventListener('click', () => { stn = null; closeSheet('sgStationSheet'); reload(); });
}
