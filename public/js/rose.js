// The pleasure inventory sheet. Opened from the rose in a pair list's corner.
//
// Everything about who sees what is decided on the server (lib/pleasure.js);
// this draws what came back. The partner's "things to try" answers are never
// sent here at all, only the matches, so there is nothing to hide client-side.
import { S } from './state.js';
import { $, esc, toast, openSheet, closeSheet } from './util.js';
import { get, post } from './api.js';

let data = null;       // last answer from the server
let pane = 'body';     // 'body' | 'try'
let part = null;       // which body part is open
let busy = false;

const levelLabel = (id) => (data.levels.find(l => l.id === id) || {}).label || '';

function scale(attrs, cur) {
  return `<div class="rs-scale">${data.levels.map(l =>
    `<button type="button" class="lv-${l.id}${cur === l.id ? ' on' : ''}" ${attrs}
      data-level="${l.id}" aria-pressed="${cur === l.id}">${esc(l.label)}</button>`).join('')}</div>`;
}

function bodyHtml() {
  const mine = data.mine.body, theirs = data.theirs.body;
  const chips = data.parts.map(p => {
    const n = Object.keys(mine[p.id] || {}).length;
    const t = Object.keys(theirs[p.id] || {}).length;
    return `<button type="button" data-part="${p.id}" class="${p.id === part ? 'on' : ''}">
      ${esc(p.label)}${n ? '<i class="me"></i>' : ''}${t ? '<i class="them"></i>' : ''}</button>`;
  }).join('');
  let detail = `<p class="rs-note">Tap a part of the body, then say how you feel about each way of being touched there.
    ${esc(data.partner)} sees these answers, and you see theirs.</p>`;
  if (part) {
    const p = data.parts.find(x => x.id === part);
    detail = `<div class="month">${esc(p.label)}</div>` + data.acts.map(a => {
      const cur = (mine[part] || {})[a.id];
      const th = (theirs[part] || {})[a.id];
      return `<div class="rs-row"><div class="rs-q"><b>${esc(a.label)}</b>${
        th ? `<small>${esc(data.partner)}: <em class="lv-${th}">${esc(levelLabel(th))}</em></small>` : ''}</div>
        ${scale(`data-kind="body" data-act="${a.id}"`, cur)}</div>`;
    }).join('');
  }
  return `<div class="rs-parts">${chips}</div>
    <div class="rs-key"><span><i class="me"></i>you answered</span><span><i class="them"></i>${esc(data.partner)} answered</span></div>
    ${detail}`;
}

function tryHtml() {
  const label = (id) => (data.try.find(t => t.id === id) || {}).label || id;
  const matches = data.matches.length
    ? `<div class="month">You both want 🌹</div>${data.matches.map(m =>
      `<div class="rs-match"><b>${esc(label(m.id))}</b><small>you: ${esc(levelLabel(m.mine))} · ${
        esc(data.partner)}: ${esc(levelLabel(m.theirs))}</small></div>`).join('')}`
    : `<p class="rs-note">Anything you both say yes or maybe to shows up here.
       ${esc(data.partner)} never sees your no's, and only sees a yes once theirs matches it.</p>`;
  return matches + `<div class="month">Your answers</div>` + data.try.map(t =>
    `<div class="rs-row"><div class="rs-q"><b>${esc(t.label)}</b></div>
      ${scale(`data-kind="try" data-id="${t.id}"`, data.mine.try[t.id])}</div>`).join('');
}

function paint() {
  $('rsWho').textContent = `with ${data.partner} · only the two of you`;
  document.querySelectorAll('#roseSheet [data-rs]').forEach(b => {
    b.classList.toggle('on', b.dataset.rs === pane);
    b.setAttribute('aria-selected', b.dataset.rs === pane);
  });
  $('rsBody').innerHTML = pane === 'body' ? bodyHtml() : tryHtml();
}

async function answer(btn) {
  if (busy) return;
  const kind = btn.dataset.kind;
  const lv = btn.dataset.level;
  // Tapping the answer you already gave takes it back.
  const cur = kind === 'body'
    ? (data.mine.body[part] || {})[btn.dataset.act]
    : data.mine.try[btn.dataset.id];
  const level = cur === lv ? null : lv;
  const body = kind === 'body'
    ? { kind, part, act: btn.dataset.act, level }
    : { kind, id: btn.dataset.id, level };
  busy = true;
  try {
    data = await post(`/api/space/${S.spaceId}/pleasure`, body);
  } catch (_) { toast('Could not save that'); }
  busy = false;
  // Keep your place: re-rendering the try list would otherwise jump to the top.
  const sc = $('roseSheet').querySelector('.modal-in');
  const top = sc.scrollTop;
  paint();
  sc.scrollTop = top;
}

export async function openRose() {
  if (!S.space || !S.space.isPair) return;
  try {
    data = await get(`/api/space/${S.spaceId}/pleasure`);
  } catch (_) { return toast('Could not open that'); }
  pane = 'body';
  part = null;
  paint();
  openSheet('roseSheet');
  $('roseSheet').querySelector('.modal-in').scrollTop = 0;
}

export function initRose() {
  $('rsClose').addEventListener('click', () => closeSheet('roseSheet'));
  $('roseSheet').addEventListener('click', (e) => {
    if (e.target === $('roseSheet')) return closeSheet('roseSheet');
    const tabBtn = e.target.closest('[data-rs]');
    if (tabBtn) { pane = tabBtn.dataset.rs; paint(); $('roseSheet').querySelector('.modal-in').scrollTop = 0; return; }
    const partBtn = e.target.closest('[data-part]');
    if (partBtn) { part = part === partBtn.dataset.part ? null : partBtn.dataset.part; paint(); return; }
    const lvBtn = e.target.closest('[data-level]');
    if (lvBtn) answer(lvBtn);
  });
}
