// The shelf of lists. Each card is a person (or a group) and what is waiting
// with them — the count is the point, because a list of names tells you nothing
// about where to go next. Under a hairline, the same count by kind.
import { S } from './state.js';
import { $, esc, toast, showScreen, initialOf } from './util.js';
import { post, applyWire } from './api.js';
import { iconFor, icon } from './icons.js';

let onOpen = () => {};
let onAccount = () => {};

export function renderShelf() {
  const w = S.wire;
  if (!w) return;
  const spaces = w.spaces || [];
  $('meInitial').textContent = initialOf(w.me && w.me.name);
  const kinds = w.kinds || [];

  $('shelfList').innerHTML = spaces.length
    ? spaces.map(sp => {
        const others = sp.members.filter(m => m.id !== w.me.id);
        const faces = (others.length ? others : sp.members).slice(0, 3)
          .map(m => `<span class="avatar">${esc(initialOf(m.name))}</span>`).join('');
        const c = sp.counts || {};
        const by = c.byKind || {};
        // Today's question: the streak beside the counts, and a dot while
        // yours is waiting. A number and a flag — never the question.
        const q = sp.question;
        const line = `<em>${c.open || 0}</em> to do${c.done ? ` · <em class="d">${c.done}</em> done together` : ''}${
          sp.isPair ? '' : ` · ${others.length + 1} people`}${q && q.streak ? ` · <span class="sp-flame" aria-label="${q.streak} days in a row">${icon('flame', 14)}${q.streak}</span>` : ''}`;
        return `<button class="sp-card" data-sp="${esc(sp.id)}">
          <span class="sp-top">
            <span class="sp-faces">${faces}${q && q.waiting ? '<i class="sp-dq" aria-label="Today’s question is waiting"></i>' : ''}</span>
            <span class="sp-bd"><b>${esc(sp.title)}</b><small>${line}</small></span>
            ${icon('chev', 20)}
          </span>
          ${kinds.length ? `<span class="sp-kinds">${kinds.map(k => `<span class="${by[k.id] ? '' : 'none'}"
            aria-label="${esc(`${by[k.id] || 0} ${k.plural.toLowerCase()}`)}">${iconFor(k.id, 19)}${by[k.id] || 0}</span>`).join('')}</span>` : ''}
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
