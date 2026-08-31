// The shelf of lists. Each row is a person (or a group) and how much you have
// waiting with them — the count is the point, because a list of names tells you
// nothing about where to go next.
import { S } from './state.js';
import { $, esc, toast, showScreen, initialOf } from './util.js';
import { post, applyWire } from './api.js';

let onOpen = () => {};
let onAccount = () => {};

export function renderShelf() {
  const w = S.wire;
  if (!w) return;
  const spaces = w.spaces || [];

  $('shelfSub').textContent = spaces.length
    ? `${spaces.length} ${spaces.length === 1 ? 'list' : 'lists'}`
    : 'Nothing on the shelf yet';
  $('meInitial').textContent = initialOf(w.me && w.me.name);

  $('shelfList').innerHTML = spaces.length
    ? spaces.map(sp => {
        const others = sp.members.filter(m => m.id !== w.me.id);
        const faces = (others.length ? others : sp.members).slice(0, 3)
          .map(m => `<i>${esc(initialOf(m.name))}</i>`).join('');
        const sub = sp.isPair
          ? (sp.counts.done ? `${sp.counts.done} done together` : 'just the two of you')
          : `${others.length + 1} people`;
        return `<button class="sp-card" data-sp="${esc(sp.id)}">
          <div class="sp-faces">${faces}</div>
          <div class="sp-bd"><b>${esc(sp.title)}</b><small>${esc(sub)}</small></div>
          <div class="sp-count ${sp.counts.open ? '' : 'none'}">${sp.counts.open || '·'}</div>
        </button>`;
      }).join('')
    : `<div class="empty">Nobody here yet.<br>Start a list and send someone the link.</div>`;

  $('shelfList').querySelectorAll('[data-sp]').forEach(b =>
    b.addEventListener('click', () => onOpen(b.dataset.sp)));
}

async function newSpace() {
  const name = prompt('Name this list? Leave blank for a one-to-one.') ;
  if (name === null) return;
  try {
    const b = await post('/api/space', { name: name.trim() });
    applyWire(b.state);
    renderShelf();
    onOpen(b.space.id);
    toast('Now invite someone to it');
  } catch (_) { toast('Could not start that list'); }
}

export function initShelf(openHandler, accountHandler) {
  onOpen = openHandler;
  onAccount = accountHandler;
  $('btnNewSpace').addEventListener('click', newSpace);
  $('btnMe').addEventListener('click', () => onAccount());
}
