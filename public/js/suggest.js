// Suggestions: what on this list would be good for THEN. You say how much
// energy you have and when it is for; the server weighs everything (energy,
// the hour, the weather then, open or closed, how long it takes each of you to
// get there, your thumbs) and sends back a PLAN — one thing after another,
// each piece swappable — and the whole list in order. lib/suggest.js decides;
// this draws it, and never ranks anything itself.
//
// The screen (Nov 27): what the plan is FOR is one row at the top, and the
// controls behind it are a sheet, so the plan is the first thing on the screen.
// A plan that runs into the next day is a tab a day. Each piece is a card: its
// reasons one to a line, and how long it takes said once when it is the same
// for everybody.
import { S } from './state.js';
import { $, esc, toast, openSheet, closeSheet, leadEmoji } from './util.js';
import { get, post, applyWire } from './api.js';
import { haptic, skeleton, burst } from './motion.js';
import { wxOf, deg, hourWords } from './wx.js';
import { icon, iconFor } from './icons.js';

const WORDS = ['', 'Wiped out', 'Low', 'Okay', 'Good', 'Full of it'];
// The same five, as the summary row says them: "Low" alone is not a sentence.
const ENERGY = ['', 'Wiped out', 'Low energy', 'Okay energy', 'Good energy', 'Full of it'];
const ROLE = { eat: 'a meal', drink: 'a drink', watch: 'something to watch', do: 'something to do' };
const KIND_PLURAL = () => Object.fromEntries(((S.wire && S.wire.kinds) || []).map(k => [k.id, k.plural]));

let hooks = { openItem() {}, refresh: async () => {}, tileHtml: () => '' };
const st = { energy: 3, when: 'now', date: '', time: '', through: false, keep: {}, data: null, more: false, day: null,
  ideas: null, ideasBusy: false, seq: 0, polls: 0, timer: null, space: null };
try {
  const saved = JSON.parse(localStorage.getItem('dw-sug') || '{}');
  if (saved.energy >= 1 && saved.energy <= 5) st.energy = saved.energy;
  if (typeof saved.through === 'boolean') st.through = saved.through;
} catch (_) { /* a fresh start is fine */ }
const remember = () => { try { localStorage.setItem('dw-sug', JSON.stringify({ energy: st.energy, through: st.through })); } catch (_) { /* private mode */ } };

// What this list eats (lib/diet.js). The answer to the last question asked is
// the truth; before there is one, what the app already knows about the list.
const DIETS = () => (S.wire && S.wire.diets) || [];
function dietNow() {
  if (st.data && st.data.diet !== undefined) return st.data.diet || null;
  const sp = ((S.wire && S.wire.spaces) || []).find(s => s.id === S.spaceId);
  return (sp && sp.diet) || null;
}
const dietLabels = (d) => (d ? d.must.map(id => (DIETS().find(x => x.id === id) || { label: id }).label) : []);
const eatRow = () => {
  const d = dietNow();
  return `${iconFor('recipe', 18)}<span class="cb"><b>What you eat</b>
    <small>${d ? esc(`${dietLabels(d).join(' · ')}${d.strict ? ' · strictly' : ''}`) : 'Anything. Tap if there’s something you don’t.'}</small></span>`;
};

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
// How long it takes each of you. Starting from the same station, both lines
// read the same, so it is said once: "25 min each".
export function transitHtml(legs) {
  if (!legs || !legs.length) return '';
  const words = (l) => `${l.about ? 'about ' : ''}${Number(l.minutes)} min${l.walk ? ' walk' : ''}`;
  const chips = (l) => (l.lines || []).map(lineChip).join('');
  if (legs.length > 1 && legs.every(l => words(l) === words(legs[0]) && chips(l) === chips(legs[0]))) {
    const w = words(legs[0]);
    return `<div class="sg-tr"><span>${w.charAt(0).toUpperCase()}${w.slice(1)} each${chips(legs[0])}</span></div>`;
  }
  return `<div class="sg-tr">${legs.map(l => `<span>${esc(l.mine ? 'You' : l.name)} ${words(l)}${chips(l)}</span>`).join('<span class="dot">·</span>')}</div>`;
}
const UP = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v11"/><path d="M14.6 5.9 13.8 10h5.3a1.9 1.9 0 0 1 1.8 2.4l-2.1 7.2a1.9 1.9 0 0 1-1.8 1.4H4.9A1.9 1.9 0 0 1 3 19.1v-7.2A1.9 1.9 0 0 1 4.9 10h2.4a1.9 1.9 0 0 0 1.7-1L12 3a2.9 2.9 0 0 1 2.6 2.9z"/></svg>';
const DOWN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V3"/><path d="M9.4 18.1 10.2 14H4.9a1.9 1.9 0 0 1-1.8-2.4l2.1-7.2A1.9 1.9 0 0 1 7 3h12.1A1.9 1.9 0 0 1 21 4.9v7.2a1.9 1.9 0 0 1-1.9 1.9h-2.4a1.9 1.9 0 0 0-1.7 1L12 21a2.9 2.9 0 0 1-2.6-2.9z"/></svg>';
const thumbs = (v, attrs) => `<span class="sg-th"><button type="button" ${attrs} data-v="1" aria-pressed="${v > 0}" aria-label="More like this">${UP}</button>
  <button type="button" ${attrs} data-v="-1" aria-pressed="${v < 0}" aria-label="Not this">${DOWN}</button></span>`;

// One reason, as a span. A short one never breaks mid-phrase ("2:30 / PM"); one
// longer than a line could not help it, so it wraps like ordinary text instead
// of dropping to a line of its own and leaving a gap.
// The tone is `t-good`, `t-bad`, `t-note`, never the bare word: class names are
// global, and a plain `.note` elsewhere gave every note a 22px gap above it.
const say = (tone, text) => `<span class="t-${tone}${String(text).length > 30 ? ' long' : ''}">${esc(text)}</span>`;

// One thing, weighed: its tile, its words, why, how to get there, and thumbs.
function rowHtml(x, { slot = null, note = '' } = {}) {
  const it = itemOf(x.id);
  if (!it) return '';
  const kind = ((S.wire && S.wire.kinds) || []).find(k => k.id === it.kind);
  const why = [...x.reasons.map(r => say(r.tone, r.text)), ...(note ? [say('good', note)] : [])].join('<span class="dot">·</span>');
  return `<div class="sg-it" data-sit="${esc(x.id)}"${slot ? ` data-in="${esc(slot)}"` : ''}>
    ${hooks.tileHtml(it)}
    <div class="sg-bd" data-open><b>${esc(leadEmoji(it.title).rest)}</b>
      <div class="sg-why">${kind ? `<span class="k">${esc(kind.label)}</span>${why ? '<span class="dot">·</span>' : ''}` : ''}${why}</div>
      ${transitHtml(x.transit)}</div>
    ${thumbs(x.vote, 'data-vote')}
  </div>`;
}

// A piece of the plan: the same thing weighed, drawn as a card of its own. Its
// reasons are one to a line, each with a mark, because three of them run
// together with dots between was the part nobody could read at a glance.
const MARK = {
  good: icon('tick', 15, 2.2),
  bad: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M12 7.8v4.8M12 16v.1"/></svg>',
  note: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
};
// "Thanksgiving · hours may differ" is the scorer's note on every place with
// hours that day (lib/suggest.js). In a plan it is said once, over the day. If
// those words ever change this stops matching and the note is on each piece
// again, which is only how it was.
const MAY_DIFFER = / · hours may differ$/;
const holidayOf = (slots) => {
  for (const sl of slots) {
    const r = sl.pick && sl.pick.reasons.find(x => MAY_DIFFER.test(x.text));
    if (r) return r.text.replace(MAY_DIFFER, '');
  }
  return '';
};
function pieceHtml(x, slot, lifted) {
  const it = itemOf(x.id);
  if (!it) return '';
  const kind = ((S.wire && S.wire.kinds) || []).find(k => k.id === it.kind);
  const reasons = x.reasons.filter(r => !(lifted && MAY_DIFFER.test(r.text)));
  return `<div class="sg-it sg-pc" data-sit="${esc(x.id)}" data-in="${esc(slot)}">
    <div class="sg-top">${hooks.tileHtml(it)}
      <div class="sg-bd" data-open><b>${esc(leadEmoji(it.title).rest)}</b>${kind ? `<small class="k">${esc(kind.label)}</small>` : ''}</div>
      ${thumbs(x.vote, 'data-vote')}</div>
    ${reasons.length ? `<ul class="sg-rs">${reasons.map(r => `<li class="t-${esc(r.tone)}">${MARK[r.tone] || MARK.note}<span>${esc(r.text)}</span></li>`).join('')}</ul>` : ''}
    ${transitHtml(x.transit)}
  </div>`;
}

// The weather for one piece's own day and hour — tomorrow's slots say tomorrow's.
function slotWx(w) {
  if (!w) return '';
  const x = wxOf(w.code);
  return ` · <span class="sg-swx" title="${esc(x.label)}"><span aria-hidden="true">${x.icon}</span> ${deg(w.t)}${
    Number.isFinite(w.rain) && w.rain >= 30 ? ` · ${w.rain}% rain` : ''}</span>`;
}

// What is on the calendar for a part of the day but ruled out now (closed,
// rained off): said in its slot, above whatever is offered in its place. It is
// still first in Swap, for anyone going anyway.
function bumpHtml(sl) {
  const it = sl.bumped && itemOf(sl.bumped.id);
  if (!it) return '';
  const why = sl.bumped.reasons.filter(r => r.tone === 'bad').map(r => say('bad', r.text)).join('<span class="dot">·</span>');
  return `<p class="sg-why sg-bump" data-bumped="${esc(sl.bumped.id)}"><b>${esc(leadEmoji(it.title).rest)}</b> is on the calendar for then${
    why ? `<span class="dot">·</span>${why}` : ''}</p>`;
}

// The pieces "Put it on the calendar" would write: not the ones already there.
const toPlan = (d) => d.plan.filter(sl => sl.pick && !sl.planned);

// A day's weather on its tab: the range across that day's pieces, from the
// same numbers each piece shows for its own hour.
function dayWx(d, day) {
  const ws = d.plan.filter(sl => sl.date === day && sl.weather && Number.isFinite(sl.weather.t)).map(sl => sl.weather);
  if (!ws.length) return '';
  const lo = Math.min(...ws.map(w => w.t));
  const hi = Math.max(...ws.map(w => w.t));
  const x = wxOf(ws[0].code);
  return `<small><span aria-hidden="true">${x.icon}</span> ${esc(x.label)} · ${deg(lo) === deg(hi) ? deg(hi) : `${deg(lo).replace('°', '')}–${deg(hi)}`}</small>`;
}

function slotHtml(sl, lifted, lead) {
  return `<div class="sg-slot${lead ? ' lead' : ''}" data-slot="${esc(sl.key)}">
      <div class="sg-sh"><b>${esc(sl.label)}</b><small>${sl.planned ? 'at' : 'around'} ${esc(hourWords(sl.time))}${slotWx(sl.weather)}</small>
        <button type="button" class="sg-swap" data-swap="${esc(sl.key)}">${sl.pick ? 'Swap' : 'Get ideas'}</button></div>
      ${bumpHtml(sl)}
      ${sl.pick ? pieceHtml(sl.pick, sl.key, lifted) : `<p class="sg-none">Nothing ${sl.bumped ? 'else ' : ''}on your list for ${ROLE[sl.role]} then.</p>`}
    </div>`;
}

const daysOf = (d) => [...new Set(d.plan.map(sl => sl.date))];

function planHtml(d) {
  if (!d.plan.length) return '';
  const days = daysOf(d);
  if (!days.includes(st.day)) st.day = days[0];
  const fresh = toPlan(d).length;
  const onCal = d.plan.filter(sl => sl.pick && sl.planned).length;
  const nameOf = (day) => (dayWord(day) === 'Today' && d.plan.find(x => x.date === day).time >= '17:00' ? 'Tonight' : dayWord(day));
  // One day is a heading over its pieces. Two are a tab each, so tomorrow is a
  // tap away and not a scroll; both are drawn, and a tap only shows the other.
  const tabs = days.length > 1 ? `<div class="segs sg-days">${days.map(day => `<button type="button" data-day="${esc(day)}"
      class="${day === st.day ? 'on' : ''}" aria-pressed="${day === st.day}"><b>${esc(nameOf(day))}</b>${dayWx(d, day)}</button>`).join('')}</div>` : '';
  const panels = days.map((day, di) => {
    const slots = d.plan.filter(sl => sl.date === day);
    const holiday = holidayOf(slots);
    return `<div class="sg-dayp" data-day="${esc(day)}"${days.length > 1 && day !== st.day ? ' hidden' : ''}>
      ${days.length > 1 ? '' : `<div class="sg-day">${esc(nameOf(day))}</div>`}
      ${holiday ? `<p class="sg-hol">${MARK.bad}<span>${esc(holiday)} · hours may differ, so check before you go</span></p>` : ''}
      ${slots.map((sl, i) => slotHtml(sl, !!holiday, di === 0 && i === 0)).join('')}</div>`;
  }).join('');
  // What is already on the calendar is left where it is: the button is for the rest.
  const put = fresh ? `<button type="button" class="primary" id="sgPlanIt">${onCal ? 'Put the rest on the calendar' : 'Put it on the calendar'}</button>`
    : onCal ? '<p class="sg-learn sg-oncal">All of this is on the calendar.</p>' : '';
  return `<h3 class="sec">A plan <em>each piece can be swapped</em></h3>${tabs}<div class="sg-plan">${panels}</div>${put}`;
}

function paint() {
  const d = st.data;
  const body = $('sgBody');
  if (!body || !d) return;
  const w = d.weather;
  // Two days have their weather on their tabs; one day says it here.
  const wx = w && daysOf(d).length < 2 ? `<div class="sg-wx"><span aria-hidden="true">${wxOf(w.code).icon}</span> <b>${deg(w.t)}</b> ${esc(wxOf(w.code).label.toLowerCase())}${
    Number.isFinite(w.rain) && w.rain >= 30 ? ` · ${w.rain}% rain` : ''} <small>${esc(dayWord(d.at.date))} ${esc(hourWords(d.at.time))}</small></div>` : '';
  const inPlan = new Set(d.plan.map(sl => sl.pick && sl.pick.id).filter(Boolean));
  const rest = d.good.filter(x => !inPlan.has(x.id));
  const shown = st.more ? rest : rest.slice(0, 8);
  const good = rest.length ? `<h3 class="sec">Also good then <em>${rest.length}</em></h3><div class="group sg-list">${shown.map(x => rowHtml(x)).join('')}</div>
    ${rest.length > shown.length ? `<button type="button" class="ghost" id="sgMore">Show ${rest.length - shown.length} more</button>` : ''}` : '';
  // Ruled out for now and in the plan for later is not a contradiction, but it
  // read as one: the garden under Not then was tomorrow morning's piece.
  const slotOf = new Map(d.plan.filter(sl => sl.pick).map(sl => [sl.pick.id, sl]));
  const inPlanNote = (sl) => { const day = dayWord(sl.date); return day === 'Tomorrow' ? 'In tomorrow’s plan' : `In the plan · ${day === 'Today' ? sl.label : day}`; };
  const not = d.notThen.length ? `<details class="sg-not"><summary>Not then <em>${d.notThen.length}</em></summary>
    <div class="group sg-list">${d.notThen.map(x => rowHtml(x, { note: slotOf.has(x.id) ? inPlanNote(slotOf.get(x.id)) : '' })).join('')}</div></details>` : '';
  const from = d.people.filter(p => p.stations !== null);
  const fromLine = from.map(p => `${p.mine ? 'You' : p.name}: ${p.stations.length ? p.stations.map(x => x.name).join(', ') : 'not set'}`).join(' · ');
  $('sgFrom').innerHTML = `${icon('pin', 18)}<span class="cb"><b>${d.needsStations ? 'Set where you each start from' : 'Starting from'}</b>
    <small>${esc(d.needsStations ? 'Your nearest station, for travel times' : fromLine)}</small></span>`;
  if ($('sgEat')) $('sgEat').innerHTML = eatRow();
  paintSum();
  const learning = d.profiling ? '<p class="sg-learn">Getting to know your list. These sharpen in a minute.</p>' : '';
  body.innerHTML = `${wx}${learning}${planHtml(d)}${good}${not}${ideasHtml(d)}`;
  bind();
}

// How an idea keeps to what the list eats, in its own words — and, once, that
// nobody has checked: it is what is generally known about a dish or a place.
const keepsHtml = (x) => (x.keeps ? `<span class="dot">·</span>${say('good', x.keeps)}` : '');
const askNote = (list) => (dietNow() && list && list.some(x => x.keeps)
  ? `<p class="sg-learn sg-asknote">Kept to ${esc(dietLabels(dietNow()).join(', ').toLowerCase())} as far as it can tell. Ask a place before you order.</p>` : '');

function ideasHtml(d) {
  if (!d.ideas) return '';
  const plural = KIND_PLURAL();
  const list = st.ideas;
  return `<h3 class="sec">New ideas <em>not on your list yet</em></h3>
    ${st.ideasBusy ? skeleton() : list && list.length ? `${askNote(list)}<div class="group sg-list">${list.map((x, i) => `<div class="sg-it idea" data-idea="${i}">
      <div class="sg-bd"><b>${esc(x.title)}</b><div class="sg-why"><span class="k">${esc(plural[x.kind] || x.kind)}</span><span class="dot">·</span>${say('why', x.why)}${keepsHtml(x)}</div>
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
  // The other day is already drawn: a tap shows it, and nothing is asked again.
  body.querySelectorAll('.sg-days [data-day]').forEach(b => b.addEventListener('click', () => {
    st.day = b.dataset.day;
    haptic('tick');
    body.querySelectorAll('.sg-days [data-day]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    body.querySelectorAll('.sg-dayp').forEach(p => { p.hidden = p.dataset.day !== st.day; });
  }));
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
  const picks = toPlan(d);
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
  const ideas = swapping.busy ? skeleton() : swapping.ideas ? `${askNote(swapping.ideas)}<div class="group sg-list">${swapping.ideas.map((x, i) => `<div class="sg-it idea">
      <div class="sg-bd"><b>${esc(x.title)}</b><div class="sg-why"><span class="k">${esc(plural[x.kind] || x.kind)}</span><span class="dot">·</span>${say('why', x.why)}${keepsHtml(x)}</div>
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

/* ── what this list eats ────────────────────────────────────────────────── */

// A rule of the list: chips to choose from the server's table, and whether it
// is medical. Saved on every tap, one after another so they land in order.
let eat = null;   // { must: Set, strict }
let saving = Promise.resolve();
function openDiet() {
  const d = dietNow();
  eat = { must: new Set(d ? d.must : []), strict: !!(d && d.strict) };
  paintDiet();
  openSheet('sgDietSheet');
}
function paintDiet() {
  $('sgDietBody').innerHTML = `<div class="chips sg-diets" role="group" aria-label="What you eat">${DIETS().map(x => `<button type="button"
      data-diet="${esc(x.id)}" class="${eat.must.has(x.id) ? 'on' : ''}" aria-pressed="${eat.must.has(x.id)}">${esc(x.label)}</button>`).join('')}</div>
    <label class="crow sg-strict"><span class="cb"><b>It’s medical</b><small>Celiac or an allergy, not a preference. Be strict about it.</small></span>
      <input type="checkbox" class="switch" id="sgStrict"${eat.strict ? ' checked' : ''}${eat.must.size ? '' : ' disabled'}></label>
    <p class="cl-note sg-asknote">Nothing here checks a kitchen for you. What it knows about a place comes from OpenStreetMap and from what is generally known, so ask before you order.</p>`;
  $('sgDietBody').querySelectorAll('[data-diet]').forEach(b => b.addEventListener('click', () => {
    if (eat.must.has(b.dataset.diet)) eat.must.delete(b.dataset.diet); else eat.must.add(b.dataset.diet);
    if (!eat.must.size) eat.strict = false;
    haptic('tick');
    paintDiet();
    saveDiet();
  }));
  $('sgStrict').addEventListener('change', (e) => { eat.strict = e.target.checked; haptic('tick'); saveDiet(); });
}
function saveDiet() {
  const sid = S.spaceId;
  const body = { must: [...eat.must], strict: eat.strict };
  saving = saving.then(async () => {
    try {
      const b = await post(`/api/space/${sid}/diet`, body);
      applyWire(b.state);
      if (S.spaceId !== sid) return;
      if (st.data) st.data.diet = b.diet;
      // Ideas asked for under the old rule are not ideas for the new one.
      st.ideas = null;
      if ($('sgEat')) $('sgEat').innerHTML = eatRow();
      reload();
    } catch (_) { toast('Could not save that'); }
  });
  return saving;
}

/* ── the screen ─────────────────────────────────────────────────────────── */

const SLIDERS = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4.5 8h8M16.5 8h3M4.5 16h3M11.5 16h8"/><circle cx="14.5" cy="8" r="2"/><circle cx="9.5" cy="16" r="2"/></svg>';

// Short enough for one line beside the energy: a picked day is "Sun, Nov 29, 4:30 PM".
function whenWords() {
  if (st.when === 'tonight') return 'Tonight';
  if (st.when === 'tomorrow') return 'Tomorrow';
  if (st.when !== 'pick' || !st.date) return 'Now';
  const day = dayWord(st.date);
  const short = day === 'Today' || day === 'Tomorrow' ? day
    : new Date(`${st.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `${short}, ${hourWords(st.time || '12:00')}`;
}
// Where you start from, in as few words as say it: one station when it is the
// same for everybody the wire names, and who is where when it is not.
function fromWords(d) {
  if (!d) return '';
  if (d.needsStations) return 'Set where you each start from';
  const from = d.people.filter(p => p.stations !== null);
  const names = from.map(p => p.stations.map(x => x.name).join(', '));
  if (names.length && names[0] && names.every(n => n === names[0])) return `From ${names[0]}`;
  return from.map((p, i) => `${p.mine ? 'You' : p.name}: ${names[i] || 'not set'}`).join(' · ');
}
// What the plan is for, in one row. Tapping it opens the controls.
function paintSum() {
  const el = $('sgSum');
  if (!el) return;
  const second = [st.through ? 'Into the next day' : '', fromWords(st.data), dietLabels(dietNow()).join(' · ')].filter(Boolean).join(' · ');
  el.innerHTML = `<i>${SLIDERS}</i><span class="cb"><b>${esc(ENERGY[st.energy])} · ${esc(whenWords())}</b>${
    second ? `<small>${esc(second)}</small>` : ''}</span>${icon('chev', 18)}`;
}

// The controls, in their sheet. Built ONCE, when the app starts, and kept: a
// slider must not be redrawn under a thumb. Every change lands at once and the
// plan behind the sheet follows it; there is nothing to save.
function buildTune() {
  const box = $('sgTuneBody');
  const chips = [['now', 'Now'], ['tonight', 'Tonight'], ['tomorrow', 'Tomorrow'], ['pick', 'Pick a time']];
  box.innerHTML = `<div class="box sg-ctl">
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
      <button type="button" class="crow sg-from" id="sgEat"></button>
    </div>`;
  $('sgEnergy').addEventListener('input', (e) => {
    st.energy = Number(e.target.value);
    $('sgWord').textContent = WORDS[st.energy];
    haptic('tick');
    remember();
    paintSum();
    clearTimeout(st.slide);
    st.slide = setTimeout(reload, 250);
  });
  box.querySelectorAll('[data-when]').forEach(b => b.addEventListener('click', () => {
    st.when = b.dataset.when;
    box.querySelectorAll('[data-when]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    $('sgPick').hidden = st.when !== 'pick';
    if (st.when === 'pick' && !st.date) { st.date = dayOf(new Date()); st.time = '19:00'; $('sgDate').value = st.date; $('sgTime').value = st.time; }
    st.keep = {};
    haptic('tick');
    paintSum();
    reload();
  }));
  for (const [id, key] of [['sgDate', 'date'], ['sgTime', 'time']]) $(id).addEventListener('change', (e) => { st[key] = e.target.value; st.keep = {}; paintSum(); reload(); });
  $('sgThrough').addEventListener('change', (e) => { st.through = e.target.checked; remember(); haptic('tick'); paintSum(); reload(); });
  // One sheet at a time, as the account sheet does for its Claude row: these
  // close the controls and open their own, and closing that shows the plan.
  $('sgFrom').addEventListener('click', () => { closeSheet('sgTuneSheet'); openStations(); });
  $('sgFrom').innerHTML = `${icon('pin', 18)}<span class="cb"><b>Starting from</b><small>…</small></span>`;
  $('sgEat').addEventListener('click', () => { closeSheet('sgTuneSheet'); openDiet(); });
  $('sgEat').innerHTML = eatRow();
}
function openTune() {
  // What a list eats is the list's; this one may not be the one last shown.
  $('sgEat').innerHTML = eatRow();
  openSheet('sgTuneSheet');
}

// Called by space.js's render() whenever the Suggestions view is up. The row
// that says what the plan is for is built once, and only the answer under it
// repaints.
export function renderSuggest(list) {
  if (st.space !== S.spaceId) { st.space = S.spaceId; st.data = null; st.keep = {}; st.ideas = null; st.more = false; st.day = null; }
  if (list.querySelector('.sg')) { paintSum(); if (st.data) paint(); return; }
  list.innerHTML = `<div class="sg">
    <button type="button" class="box crow sg-sum" id="sgSum" aria-haspopup="dialog"></button>
    <div id="sgBody"></div></div>`;
  $('sgSum').addEventListener('click', openTune);
  paintSum();
  if (st.data) paint();
  st.polls = 0;
  load({ quiet: !!st.data });
}

export function leaveSuggest() { clearTimeout(st.timer); st.seq++; }

export function initSuggest(h) {
  hooks = { ...hooks, ...h };
  buildTune();
  $('sgTuneClose').addEventListener('click', () => closeSheet('sgTuneSheet'));
  $('sgSwapClose').addEventListener('click', () => { swapping = null; closeSheet('sgSwapSheet'); });
  $('sgStationClose').addEventListener('click', () => { stn = null; closeSheet('sgStationSheet'); reload(); });
  $('sgDietClose').addEventListener('click', () => { eat = null; closeSheet('sgDietSheet'); });
}
