// Today's question, on the phone: the card at the top of a pair list, the sheet
// you answer it in (which becomes both answers the moment you do), the sheet
// that says which kinds come up, and the screen of every question so far.
//
// Everything is drawn from what the server sent and nothing is worked out here:
// their answer is simply ABSENT until you have answered (lib/questions.js), so
// the locked card's bars are a drawing, not blurred text, and there is nothing
// of theirs on the phone to find. A Spicy day is `justUs` on the list's route
// and is answered inside the rose — this module draws that too (`roomHtml`), but
// the rose fetches it and owns the sheet.
//
// No imports from space.js or rose.js: they call in here, and what this needs
// from them (repaint the list, put words in the composer, open the rose) comes
// through `initQuestion(hooks)`.
import { S } from './state.js';
import { $, esc, toast, openSheet, closeSheet, showScreen, initialOf } from './util.js';
import { get, post } from './api.js';
import { icon } from './icons.js';
import { haptic, burst, skeleton } from './motion.js';

const ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } })();
export const zoneQuery = () => (ZONE ? `?zone=${encodeURIComponent(ZONE)}` : '');

const KIND = {
  friends: { label: 'Friends', blurb: 'Easy ones. Food, memories, this or that.', icon: 'spark' },
  romance: { label: 'Romance', blurb: 'About the two of you, and how it feels.', icon: 'heart' },
  spicy: { label: 'Spicy', blurb: 'Intimate ones. They open in Just us, never on the list.', icon: 'rose' },
};
const REACTS = ['❤️', '😂', '🥹', '🔥'];

let Q = null;          // { sid, ...GET /api/space/:id/question }
let sheet = null;      // the answer sheet: { view, editing, justDone, sent }
let room = { editing: false, justDone: false, sent: false };
let hist = null;       // { days, next } — the screen of every question so far
let hooks = { repaint() {}, compose() {}, openRose() {} };

const partner = () => (Q && Q.partner) || 'them';
const lc = (s) => String(s || '').charAt(0).toLowerCase() + String(s || '').slice(1);
const kindLabel = (k) => (KIND[k] || {}).label || '';

// "Wednesday, Nov 18" — from a calendar date, read as a calendar date. Never
// through new Date('YYYY-MM-DD'), which is midnight UTC and yesterday here.
function dayLabel(date, long = true) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  return t.toLocaleDateString('en-US', long ? { weekday: 'long', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
}
const timeLabel = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
function whenLabel(ms, date) {
  const today = Q && Q.today && Q.today.date;
  return date === today ? timeLabel(ms) : dayLabel(date, false);
}

/* ── loading ─────────────────────────────────────────────────────────────── */

export async function loadQuestion(sid) {
  const sp = ((S.wire && S.wire.spaces) || []).find(s => s.id === sid);
  if (!sp || !sp.isPair) { if (Q && Q.sid === sid) Q = null; return null; }
  try {
    const b = await get(`/api/space/${sid}/question${zoneQuery()}`);
    if (S.spaceId !== sid) return null;
    Q = { sid, ...b };
    return Q;
  } catch (_) { return null; }
}
const take = (b) => { Q = { sid: S.spaceId, ...b }; return Q; };
// After the rose: a Spicy day answered in there changes the card out here.
export async function refreshQuestion() { if (S.spaceId && await loadQuestion(S.spaceId)) hooks.repaint(); }

/* ── seen ────────────────────────────────────────────────────────────────────
   "Sam answered · See what they said" until you have looked: per device, the
   last day whose answers you saw. */
const seenKey = () => `dw-dq-seen:${S.spaceId}`;
function seenDay() { try { return localStorage.getItem(seenKey()) || ''; } catch (_) { return ''; } }
function markSeen(date) { try { localStorage.setItem(seenKey(), date); } catch (_) {} }
const addedKey = 'dw-dq-added';
function added() { try { return new Set(JSON.parse(localStorage.getItem(addedKey) || '[]')); } catch (_) { return new Set(); } }
function markAdded(k) { try { const s = added(); s.add(k); localStorage.setItem(addedKey, JSON.stringify([...s].slice(-200))); } catch (_) {} }

/* ── the card ────────────────────────────────────────────────────────────── */

function pill() {
  const n = (Q.streak && Q.streak.current) || 0;
  return `<button type="button" class="dq-flame" data-dq="history" aria-label="${n ? `${n} days in a row. ` : ''}Every question so far">${icon('flame', 16)}${n ? `<b>${n}</b>` : ''}</button>`;
}

export function questionCardHtml() {
  if (!Q || Q.sid !== S.spaceId) return '';
  const name = esc(partner());
  if (Q.paused) {
    return `<div class="dq-card dq-slim" id="dqCard"><span class="dq-ic">${icon('pause', 18)}</span>
      <span class="dq-st"><b>Today’s question</b><small>${Q.paused.mine ? 'Paused' : `Paused by ${name}`}</small></span>
      <button type="button" class="dq-link" data-dq="resume">Resume</button></div>`;
  }
  const t = Q.today;
  if (!t) return '';
  const spicy = !!t.justUs;
  const theirs = !!t.theirs.answered;
  const ic = icon(spicy ? 'rose' : 'ask', 18);
  if (!t.mine) {
    return `<div class="dq-card dq-full${spicy ? ' rose' : ''}" id="dqCard" data-state="a">
      <div class="dq-top"><span class="dq-lab">${ic}<b>Today’s question${spicy ? '' : `<span> · ${esc(kindLabel(t.kind))}</span>`}</b></span>${pill()}</div>
      ${spicy ? '<p class="dq-q dq-just">Today’s is one for just the two of you.</p>'
        : `<button type="button" class="dq-q" data-dq="answer">${esc(t.text)}</button>`}
      <div class="dq-foot"><span class="dq-face">${esc(initialOf(partner()))}${theirs ? `<i>${icon('tick', 10, 3.2)}</i>` : ''}</span>
        <span class="dq-who"><b>${theirs ? `${name} answered` : `${name} hasn’t answered yet`}</b>${theirs && !spicy ? '<small>Answer to see theirs</small>' : ''}</span>
        <button type="button" class="dq-go" data-dq="${spicy ? 'room' : 'answer'}">${spicy ? `${icon('lock', 16)}Open` : 'Answer'}</button></div>
    </div>`;
  }
  const unseen = t.final && seenDay() !== t.date;
  const line = !theirs ? `Waiting on ${name}` : unseen ? `${name} answered · See what they said` : 'You both answered';
  return `<div class="dq-card dq-slim${spicy ? ' rose' : ''}" id="dqCard" data-state="${theirs ? 'c' : 'b'}">
    <button type="button" class="dq-slim-go" data-dq="${spicy ? 'room' : 'answer'}"><span class="dq-ic">${ic}</span>
      <span class="dq-st"><b>Today’s question</b><small>${line}</small></span>${unseen ? '<i class="dq-dot" aria-hidden="true"></i>' : ''}</button>${pill()}</div>`;
}

// Taps on the card, and a long press for which questions come up.
export function bindQuestionCard(root) {
  const card = root.querySelector('#dqCard');
  if (!card) return;
  let timer = null, long = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  card.addEventListener('pointerdown', () => { long = false; cancel(); timer = setTimeout(() => { long = true; haptic('snap'); openQuestionSettings(); }, 550); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'pointermove']) card.addEventListener(ev, (e) => { if (ev !== 'pointermove' || Math.abs(e.movementY) > 4) cancel(); });
  card.addEventListener('contextmenu', (e) => e.preventDefault());
  card.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dq]');
    if (long) { long = false; return; }
    if (!b) return;
    const what = b.dataset.dq;
    if (what === 'answer') openAnswer();
    else if (what === 'history') openHistory();
    else if (what === 'room') hooks.openRose('question');
    else if (what === 'resume') saveSettings({ paused: false });
  });
}

/* ── the sheet: answering, then both answers ─────────────────────────────── */

export function openAnswer(view = null) {
  const v = view || (Q && Q.today);
  if (!v || v.justUs) return;
  sheet = { view: v, editing: !v.mine, justDone: false, sent: false };
  $('dqSub').textContent = `${dayLabel(v.date)} · ${kindLabel(v.kind)}`;
  paintSheet();
  openSheet('dqSheet');
  if (v.final) { markSeen(v.date); hooks.repaint(); }
  const box = $('dqText');
  if (box && !v.mine) setTimeout(() => box.focus({ preventScroll: true }), 320);
}

function paintSheet() {
  $('dqBody').innerHTML = bodyHtml(sheet.view, { ...sheet, room: false });
  afterPaint($('dqBody'), sheet);
}

// One day, as the sheet (or the room) shows it right now.
function bodyHtml(v, st) {
  if (v.final) return revealHtml(v, st);
  if (v.mine && !st.editing) return waitingHtml(v, st);
  return answerHtml(v, st);
}

function theirsLocked(v) {
  const name = esc(partner());
  return `<div class="box dq-lockd"><div class="dq-ahd"><span class="dq-face">${esc(initialOf(partner()))}</span><b>${name}’s answer</b>
      ${v.theirs.answered ? `<span class="dq-locked">${icon('lock', 14)}Locked</span>` : ''}</div>
    ${v.theirs.answered ? '<div class="dq-bars" aria-hidden="true"><i></i><i></i></div><p>You’ll see it the moment you answer.</p>'
      : `<p>${name} hasn’t answered yet.</p>`}</div>`;
}

function answerHtml(v, st) {
  const name = esc(partner());
  const draft = v.mine && typeof v.mine.text === 'string' ? v.mine.text : '';
  const input = v.type === 'pick'
    ? `<div class="dq-picks" role="group" aria-label="Your answer">${v.options.map((o, i) => `<button type="button" class="dq-opt${v.mine && v.mine.pick === i ? ' on' : ''}"
        data-dq-pick="${i}">${esc(o)}</button>`).join('')}</div>`
    : `<label class="dq-l" for="dqText">Your answer</label>
      <textarea id="dqText" class="dq-text" maxlength="1000" rows="4" placeholder="${st.room ? `Only ${name} will read this` : 'Say it the way you’d say it…'}">${esc(draft)}</textarea>`;
  return `<h2 class="dq-qtext">${esc(v.text)}</h2>
    ${input}
    ${theirsLocked(v)}
    ${v.type === 'pick' ? '' : `<button type="button" class="primary dq-send" id="dqSend"${draft ? '' : ' disabled'}>${v.theirs.answered ? `Answer and see ${name}’s` : 'Send'}</button>`}
    <p class="dq-note">${v.theirs.answered ? `${name}’s already in, so yours is final once you send it.` : `You can change it until ${name} answers.`}</p>
    ${st.room ? `<p class="rs-lock">${icon('lock', 15)}<span>Only the two of you can open this. The question never shows on the list, in a notification or in your history, and ${name}’s answer isn’t on your phone until you’ve answered.</span></p>` : ''}`;
}

const answerText = (v, a) => (v.type === 'pick' ? (v.options[a.pick] || '') : a.text || '');

function waitingHtml(v, st) {
  const name = esc(partner());
  return `${st.sent ? `<p class="dq-sent">Sent. You’ll see ${name}’s when they answer.</p>` : ''}
    <h2 class="dq-qtext">${esc(v.text)}</h2>
    <div class="box dq-ans"><div class="dq-ahd"><span class="dq-face me">${esc(initialOf(S.wire && S.wire.me && S.wire.me.name))}</span><b>You</b><time>${esc(whenLabel(v.mine.at, v.date))}</time></div>
      <p class="dq-said">${esc(answerText(v, v.mine))}</p></div>
    ${theirsLocked(v)}
    <button type="button" class="ghost" data-dq-edit>Change your answer</button>`;
}

function streakLine(n) {
  if (n >= 365 && n < 372) return 'A year of answers';
  if (n >= 100 && n < 107) return 'A hundred days of answers';
  if (n >= 30 && n < 37) return 'A month of answers';
  if (n >= 7 && n < 14) return 'A whole week of answers';
  return n === 1 ? 'The start of a streak' : `${n} days in a row`;
}

function revealHtml(v, st) {
  const name = esc(partner());
  const s = (Q && Q.streak) || {};
  const n = st.room ? (st.streak || 0) : s.current || 0;
  const moment = st.justDone && n ? `<div class="dq-moment"><span class="dq-disc" id="dqDisc">${icon('flame', 30)}</span>
      <span><b>${streakLine(n)}</b><small>${n > 1 && s.since && !st.room ? `You’ve both answered every day since ${esc(dayLabel(s.since, false))}` : 'You both answered today'}</small></span></div>` : '';
  const done = added();
  const addBtn = (who, text) => {
    if (st.room) return '';
    const k = `${S.spaceId}:${v.date}:${who}`;
    return done.has(k) ? `<span class="dq-added">${icon('check', 16)}On your list</span>`
      : `<button type="button" class="dq-add" data-dq-add="${who}" data-text="${esc(text)}">${icon('plus', 15)}Add to Activities</button>`;
  };
  const theirs = answerText(v, v.theirs), mine = answerText(v, v.mine);
  const cards = v.matched ? `<p class="dq-match">${icon('check', 18)}You both said ${esc(lc(v.matched))}</p>`
    : `<div class="box dq-ans"><div class="dq-ahd"><span class="dq-face">${esc(initialOf(partner()))}</span><b>${name}</b><time>${esc(whenLabel(v.theirs.at, v.date))}</time></div>
        <p class="dq-said">${esc(theirs)}</p>
        ${addBtn('theirs', theirs)}
        <div class="dq-reacts" role="group" aria-label="React">${REACTS.map(e => `<button type="button" data-dq-react="${e}" class="${v.reacts && v.reacts.mine === e ? 'on' : ''}"
          aria-pressed="${!!(v.reacts && v.reacts.mine === e)}">${e}</button>`).join('')}</div></div>
      <div class="box dq-ans"><div class="dq-ahd"><span class="dq-face me">${esc(initialOf(S.wire && S.wire.me && S.wire.me.name))}</span><b>You</b><time>${esc(whenLabel(v.mine.at, v.date))}</time></div>
        <p class="dq-said">${esc(mine)}</p>
        ${addBtn('mine', mine)}
        <small class="dq-their-react">${v.reacts && v.reacts.theirs ? `${name} reacted ${v.reacts.theirs}` : `${name} can react once they’ve seen it`}</small></div>`;
  return `${moment}<h2 class="dq-qtext sm">${esc(v.text)}</h2>${cards}
    ${(v.replies || []).length ? `<div class="dq-replies">${v.replies.map(r => `<p class="${r.mine ? 'me' : ''}">${esc(r.text)}</p>`).join('')}</div>` : ''}
    <form class="dq-reply" data-dq-reply><input maxlength="500" autocomplete="off" placeholder="Say something about it…" aria-label="Say something about it">
      <button type="submit" aria-label="Send">${icon('send', 19)}</button></form>
    ${st.room ? '' : `<button type="button" class="dq-more" data-dq-more>${icon('book', 18)}Every question so far${icon('chev', 16)}</button>`}`;
}

// After a paint: the send button follows the box, and the streak moment lands.
function afterPaint(root, st) {
  const box = root.querySelector('.dq-text');
  const send = root.querySelector('.dq-send');
  if (box && send) box.addEventListener('input', () => { send.disabled = !box.value.trim(); box.classList.toggle('has', !!box.value.trim()); });
  if (box) box.classList.toggle('has', !!box.value.trim());
  if (st.justDone) {
    st.justDone = false;
    const disc = root.querySelector('.dq-disc');
    if (disc) { haptic('success'); requestAnimationFrame(() => burst(disc, { r: 30, n: 8, size: 5, ring: 1.8 })); }
  }
}

// What a tap in the sheet (or the room) asks for. Returns a body to send, or
// handles it here and returns null.
function action(e, v, st, repaint) {
  const t = e.target.closest('[data-dq-pick],[data-dq-edit],[data-dq-react],[data-dq-add],[data-dq-more],.dq-send');
  if (!t) return null;
  if (t.matches('.dq-send')) {
    const box = t.closest('#dqBody, .dq-room').querySelector('.dq-text');
    const text = box ? box.value.trim() : '';
    return text ? { date: v.date, text } : null;
  }
  if (t.dataset.dqPick !== undefined) return { date: v.date, pick: Number(t.dataset.dqPick) };
  if (t.hasAttribute('data-dq-edit')) { st.editing = true; st.sent = false; repaint(); return null; }
  if (t.dataset.dqReact) return { date: v.date, react: v.reacts && v.reacts.mine === t.dataset.dqReact ? null : t.dataset.dqReact };
  if (t.dataset.dqAdd) { addToActivities(v, t.dataset.dqAdd, t.dataset.text); return null; }
  if (t.hasAttribute('data-dq-more')) { closeSheet('dqSheet'); openHistory(); return null; }
  return null;
}

async function sheetSend(body) {
  const v = sheet.view;
  const sid = S.spaceId;
  const kind = body.react !== undefined ? 'react' : body.reply !== undefined ? 'reply' : 'answer';
  const wire = kind === 'react' ? { date: body.date, emoji: body.react } : kind === 'reply' ? { date: body.date, text: body.reply } : body;
  try {
    const b = await post(`/api/space/${sid}/question/${kind}`, wire);
    if (S.spaceId !== sid || !sheet) return;
    take(b);
    const now = b.today && b.today.date === v.date ? b.today : await dayFromHistory(v.date);
    if (!now) return;
    const finished = kind === 'answer' && now.final && !v.final;
    sheet.view = now;
    sheet.editing = false;
    sheet.sent = kind === 'answer' && !now.final;
    // The moment, only when YOUR answer completed today: a catch-up mends nothing.
    sheet.justDone = finished && b.today && b.today.date === v.date;
    if (kind === 'answer') haptic(now.final ? 'success' : 'tick'); else haptic('tick');
    if (now.final) markSeen(now.date);
    paintSheet();
    hooks.repaint();
    if (finished) $('dqSheet').querySelector('.modal-in').scrollTop = 0;
  } catch (e) {
    toast(e.status === 409 ? `${partner()} already answered, so yours is final` : 'Could not send that');
  }
}

async function dayFromHistory(date) {
  try {
    const h = await get(`/api/space/${S.spaceId}/question/history?before=${encodeURIComponent(addDay(date))}`);
    return (h.days || []).find(d => d.date === date) || null;
  } catch (_) { return null; }
}
function addDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

/* ── Add to Activities ───────────────────────────────────────────────────────
   An answer becomes a thing to do: the composer, on the Activities tab, with
   the answer in it and selected so it can be trimmed. Theirs is credited to
   them once it is added (the author may credit — see "Whose idea"). */
function addToActivities(v, who, text) {
  closeSheet('dqSheet');
  const theirsId = ((S.space && S.space.members) || []).map(m => m.id).find(id => id !== (S.wire.me && S.wire.me.id));
  hooks.compose(text, who === 'theirs' ? theirsId : null, () => { markAdded(`${S.spaceId}:${v.date}:${who}`); });
}

/* ── which questions ─────────────────────────────────────────────────────── */

export function openQuestionSettings() {
  if (!Q || Q.sid !== S.spaceId) return;
  $('dqSetSub').textContent = `On this list, with ${partner()}`;
  paintSettings();
  openSheet('dqSetSheet');
}

function paintSettings() {
  const name = esc(partner());
  const subscribed = !!(S.wire && S.wire.push && S.wire.push.subscribed);
  $('dqSetBody').innerHTML = `<h3 class="sec">Kinds of question</h3>
    <div class="box rows dq-kinds">${Object.keys(KIND).map((k) => {
      const on = Q.decks.includes(k), both = Q.inPlay.includes(k);
      return `<label class="crow dq-kind ${k}"><i class="dq-ki">${icon(KIND[k].icon, 20)}</i>
        <span class="cb"><b>${KIND[k].label}</b><small>${esc(KIND[k].blurb)}</small>
          ${on ? `<small class="dq-state${both ? ' both' : ''}">${both ? 'You’re both in.' : `Waiting on ${name}. They won’t be told you turned it on.`}</small>` : ''}</span>
        <input type="checkbox" class="switch${k === 'spicy' ? ' rose' : ''}" data-deck="${k}"${on ? ' checked' : ''} aria-label="${KIND[k].label}"></label>`;
    }).join('')}</div>
    <p class="sw-hint">You each choose for yourselves. A kind comes up once you’ve both turned it on.</p>
    <div class="box dq-from"><small>Questions come from</small><b>${Q.inPlay.length ? Q.inPlay.map(kindLabel).join(' · ') : 'Nothing yet. Turn one on.'}</b></div>
    <h3 class="sec">Reminder</h3>
    <div class="box rows"><label class="crow"><i>${icon('bell', 20)}</i><span class="cb"><b>Nudge me at</b><small>Only if I haven’t answered yet</small></span>
      <input type="time" id="dqRemind" class="dq-time" value="${esc(Q.remind || '')}" aria-label="Nudge me at"></label></div>
    ${Q.remind ? `<button type="button" class="dq-link" id="dqRemindOff">Turn the reminder off</button>` : ''}
    ${Q.remind && !subscribed ? '<p class="sw-hint">Nudges are off on this phone. Turn them on in your account to get this one.</p>' : ''}
    <button type="button" class="ghost dq-pause" id="dqPause">${icon(Q.paused ? 'play' : 'pause', 18)}${Q.paused ? 'Resume questions' : 'Pause questions on this list'}</button>`;
  $('dqSetBody').querySelectorAll('[data-deck]').forEach(sw => sw.addEventListener('change', () => {
    haptic('tick');
    saveSettings({ decks: [...$('dqSetBody').querySelectorAll('[data-deck]:checked')].map(x => x.dataset.deck) });
  }));
  $('dqRemind').addEventListener('change', () => saveSettings({ remind: $('dqRemind').value || null }));
  const off = $('dqRemindOff');
  if (off) off.addEventListener('click', () => saveSettings({ remind: null }));
  $('dqPause').addEventListener('click', () => saveSettings({ paused: !Q.paused }));
}

async function saveSettings(b) {
  const sid = S.spaceId;
  try {
    const r = await post(`/api/space/${sid}/question/settings`, b);
    if (S.spaceId !== sid) return;
    take(r);
    if (!$('dqSetSheet').hidden) paintSettings();
    hooks.repaint();
  } catch (_) { toast('Could not save that'); if (!$('dqSetSheet').hidden) paintSettings(); }
}

/* ── every question so far ───────────────────────────────────────────────── */

export async function openHistory() {
  const sid = S.spaceId;
  showScreen('scr-questions');
  $('dqHist').innerHTML = skeleton(3);
  hist = { days: [], next: null };
  try {
    const b = await get(`/api/space/${sid}/question/history`);
    if (S.spaceId !== sid) return;
    hist = { days: b.days || [], next: b.next };
  } catch (_) { toast('Could not load those'); }
  paintHistory();
}

async function earlier() {
  if (!hist || !hist.next) return;
  try {
    const b = await get(`/api/space/${S.spaceId}/question/history?before=${encodeURIComponent(hist.next)}`);
    hist = { days: [...hist.days, ...(b.days || [])], next: b.next };
    paintHistory();
  } catch (_) { toast('Could not load those'); }
}

function paintHistory() {
  const s = (Q && Q.streak) || { current: 0, longest: 0, together: 0 };
  const name = esc(partner());
  const months = [];
  for (const d of hist.days) {
    const m = d.date.slice(0, 7);
    if (!months.length || months[months.length - 1].m !== m) months.push({ m, days: [] });
    months[months.length - 1].days.push(d);
  }
  const monthName = (m) => new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const day = (d) => {
    const head = `<small>${esc(dayLabel(d.date, false))} · ${esc(kindLabel(d.kind))}</small><p class="dq-hq">${esc(d.text)}</p>`;
    if (d.matched) return `<div class="dq-hday">${head}<p class="dq-match">${icon('check', 16)}You both said ${esc(lc(d.matched))}</p></div>`;
    if (d.mine && d.theirs.answered) {
      return `<div class="dq-hday">${head}<p class="dq-hrow"><b>${name}</b>${esc(answerText(d, d.theirs))}</p><p class="dq-hrow"><b>You</b>${esc(answerText(d, d.mine))}</p></div>`;
    }
    if (d.mine) return `<div class="dq-hday">${head}<p class="dq-hrow"><b>You</b>${esc(answerText(d, d.mine))}</p><p class="dq-dim">Only you answered. ${name} can still catch up.</p></div>`;
    return `<div class="dq-hday">${head}<button type="button" class="dq-catch" data-dq-day="${esc(d.date)}">Answer to see ${name}’s${icon('chev', 16)}</button></div>`;
  };
  $('dqHist').innerHTML = `<div class="dq-tiles">
      <div class="dq-tile"><span>${icon('flame', 18)}</span><b>${s.current}</b><small>days in a row</small></div>
      <div class="dq-tile"><b>${s.longest}</b><small>longest streak</small></div>
      <div class="dq-tile"><b>${s.together}</b><small>answered together</small></div></div>
    ${months.length ? months.map(m => `<h3 class="sec">${esc(monthName(m.m))}</h3><div class="box dq-month">${m.days.map(day).join('')}</div>`).join('')
      : '<div class="empty">Nothing yet. Today’s is the first.</div>'}
    ${hist.next ? '<button type="button" class="ghost" id="dqEarlier">Earlier</button>' : ''}
    ${Q && Q.inPlay && Q.inPlay.includes('spicy') ? '<p class="dq-footnote">Just us questions aren’t here. They keep to the rose.</p>' : ''}`;
  const more = $('dqEarlier');
  if (more) more.addEventListener('click', earlier);
  $('dqHist').querySelectorAll('[data-dq-day]').forEach(b => b.addEventListener('click', () => {
    const d = hist.days.find(x => x.date === b.dataset.dqDay);
    if (d) openAnswer(d);
  }));
}

/* ── the room's half (a Spicy day, inside the rose) ──────────────────────────
   The rose fetches `question` with everything else it shows and owns the sheet;
   this draws it and says what a tap means. `send` posts through the rose. */
export function roomDoorLine(q, name) {
  const t = q && q.today;
  if (!t) return `${(q && q.history.length) || 0} so far`;
  if (!t.mine) return t.theirs.answered ? `${name} answered` : 'Waiting for you';
  return t.final ? 'You both answered' : `Waiting on ${name}`;
}

export function roomHtml(q) {
  const name = esc(partner());
  const t = q && q.today;
  const past = (q && q.history) || [];
  const today = t ? `<div class="dq dq-room"><p class="rs-sec g1">Today’s question · Spicy</p>${bodyHtml(t, { ...room, room: true, streak: q.streak })}</div>`
    : `<p class="rs-note">${q && q.on ? 'Today’s question isn’t one of these. They come up on their own days.' : 'Spicy questions are off for now.'}</p>`;
  const list = past.length ? `<p class="rs-sec">So far</p>${past.map(d => `<div class="rs-card dq-hday"><small>${esc(dayLabel(d.date, false))}</small>
      <p class="dq-hq">${esc(d.text)}</p>${d.mine && d.theirs.answered ? `<p class="dq-hrow"><b>${name}</b>${esc(answerText(d, d.theirs))}</p><p class="dq-hrow"><b>You</b>${esc(answerText(d, d.mine))}</p>`
        : d.mine ? `<p class="dq-hrow"><b>You</b>${esc(answerText(d, d.mine))}</p>` : `<p class="dq-dim">${name} answered. Answer it to see theirs.</p>`}</div>`).join('')}` : '';
  return today + list;
}

// The rose calls this after painting the room's question. `send(body)` posts
// `{ question: body }` to the rose's route and repaints; it resolves to the new
// question view, or null.
export function bindRoom(root, q, send, repaint) {
  const t = q && q.today;
  const el = root.querySelector('.dq-room');   // drawn fresh each paint, so one listener each
  if (!t || !el) return;
  afterPaint(el, room);
  el.addEventListener('click', async (e) => {
    const body = action(e, t, room, repaint);
    if (!body) return;
    e.stopPropagation();
    const wasFinal = t.final;
    const now = await send(body);
    if (!now || !now.today) return;
    room.editing = false;
    room.sent = body.text !== undefined || body.pick !== undefined ? !now.today.final : false;
    room.justDone = !wasFinal && now.today.final;
    repaint();
  });
  el.addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-dq-reply]');
    if (!f) return;
    e.preventDefault();
    const text = f.querySelector('input').value.trim();
    if (text && await send({ date: t.date, reply: text })) repaint();
  });
}
export function resetRoom() { room = { editing: false, justDone: false, sent: false }; }

/* ── wiring ──────────────────────────────────────────────────────────────── */

export function initQuestion(h) {
  hooks = { ...hooks, ...h };
  $('dqClose').addEventListener('click', () => { closeSheet('dqSheet'); sheet = null; });
  $('dqSetClose').addEventListener('click', () => closeSheet('dqSetSheet'));
  $('dqBack').addEventListener('click', () => { showScreen('scr-space'); hooks.repaint(); });
  $('dqBody').addEventListener('click', (e) => {
    if (!sheet) return;
    const body = action(e, sheet.view, sheet, paintSheet);
    if (body) sheetSend(body);
  });
  $('dqBody').addEventListener('submit', (e) => {
    const f = e.target.closest('[data-dq-reply]');
    if (!f || !sheet) return;
    e.preventDefault();
    const text = f.querySelector('input').value.trim();
    if (text) sheetSend({ date: sheet.view.date, reply: text });
  });
}
