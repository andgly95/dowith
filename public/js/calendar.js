// The calendar: what you did together, and what you mean to.
//
// A renderer over items, the same way the map is — nothing here owns data.
// Two sources put a thing on a day:
//   · `when.date`  — a plan. Set by anyone who can see the item (see setWhen in
//     lib/items.js), because picking a day is part of doing it together.
//   · `doneAt`     — the record. Every finished thing already knows when it was
//     ticked off, so the past fills itself in with no new data at all.
// A finished thing sits on the day it was DONE, not the day it was planned for:
// the calendar says what happened, and plans slip.
//
// Dates are LOCAL calendar days, never UTC. "Saturday" is the Saturday on the
// wall where you are standing; `toISOString().slice(0,10)` would put a 9pm plan
// on Sunday for anyone west of Greenwich.

import { esc } from './util.js';

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayKey = () => dayKey(new Date());
const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// "Sat 5 Dec", or "Today" / "Tomorrow" / "Yesterday" where that is what it is.
export function dayLabel(k) {
  const t = todayKey();
  const off = Math.round((fromKey(k) - fromKey(t)) / 864e5);
  if (off === 0) return 'Today';
  if (off === 1) return 'Tomorrow';
  if (off === -1) return 'Yesterday';
  return fromKey(k).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

// "8:30pm". Wall-clock, as typed.
export function timeLabel(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${pad(m)}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

// Every item that belongs on a day, keyed by that day.
export function byDay(items) {
  const out = new Map();
  const put = (k, e) => { if (!out.has(k)) out.set(k, []); out.get(k).push(e); };
  for (const it of items) {
    if (it.done && it.doneAt) put(dayKey(new Date(it.doneAt)), { it, done: true });
    else if (!it.done && it.when && it.when.date) put(it.when.date, { it, done: false });
  }
  // Within a day: timed plans in time order, then untimed, then what got done.
  for (const list of out.values()) {
    list.sort((a, b) => (a.done - b.done)
      || ((a.it.when && a.it.when.time) || '99').localeCompare((b.it.when && b.it.when.time) || '99'));
  }
  return out;
}

/* ── the view ────────────────────────────────────────────────────────────── */

// view = { month: Date (first of month), sel: 'YYYY-MM-DD' }
export function calendarHtml(items, view, iconFor) {
  const days = byDay(items);
  const y = view.month.getFullYear(), m = view.month.getMonth();
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - first.getDay());          // back to Sunday
  const today = todayKey();
  // Always six rows, so the grid never changes height between months and the
  // agenda under it does not jump when you page.
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const k = dayKey(d);
    const es = days.get(k) || [];
    const plans = es.filter(e => !e.done).length;
    const dones = es.length - plans;
    const dots = [
      ...Array(Math.min(plans, 3)).fill('<i class="p"></i>'),
      ...Array(Math.min(dones, 3 - Math.min(plans, 3))).fill('<i class="d"></i>'),
    ].join('');
    cells.push(`<button class="cd${d.getMonth() !== m ? ' out' : ''}${k === today ? ' today' : ''}${
      k === view.sel ? ' sel' : ''}${k < today ? ' past' : ''}" data-day="${k}"
      aria-label="${esc(dayLabel(k))}${es.length ? `, ${es.length} thing${es.length > 1 ? 's' : ''}` : ''}">
      <span>${d.getDate()}</span><b>${dots}</b></button>`);
  }

  const sel = days.get(view.sel) || [];
  const canPlan = view.sel >= today;
  const agenda = sel.length
    ? sel.map(({ it, done }) => `<button class="ag${done ? ' done' : ''}" data-open="${esc(it.id)}">
        <span class="gl">${iconFor(it.kind)}</span>
        <span class="t"><b>${esc(it.title)}</b><small>${
          done ? `done${it.doneByName ? ` · ${esc(it.doneByName)}` : ''}`
            : [timeLabel(it.when.time), it.plannedByName ? `planned by ${esc(it.plannedByName)}` : '']
              .filter(Boolean).join(' · ')}</small></span>
      </button>`).join('')
    : `<div class="ag-empty">${canPlan ? 'Nothing planned.' : 'Nothing that day.'}</div>`;

  // Under today, what is coming — the planning half of the view, so you can see
  // the next few weeks without paging through them.
  let soon = '';
  if (view.sel === today) {
    const ahead = [...days.entries()]
      .filter(([k]) => k > today)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([k, es]) => es.filter(e => !e.done).map(e => ({ k, it: e.it })))
      .slice(0, 8);
    if (ahead.length) {
      soon = `<div class="month">Coming up</div>${ahead.map(({ k, it }) =>
        `<button class="ag" data-open="${esc(it.id)}">
          <span class="gl">${iconFor(it.kind)}</span>
          <span class="t"><b>${esc(it.title)}</b><small>${esc(dayLabel(k))}${
            it.when.time ? ` · ${timeLabel(it.when.time)}` : ''}</small></span>
        </button>`).join('')}`;
    }
  }

  return `<div class="cal">
    <div class="cal-hd">
      <button class="icon-btn" data-cal="prev" aria-label="Previous month">‹</button>
      <b>${MONTHS[m]} <span>${y}</span></b>
      <button class="icon-btn" data-cal="next" aria-label="Next month">›</button>
    </div>
    <div class="cal-dow">${DOW.map(d => `<span>${d}</span>`).join('')}</div>
    <div class="cal-grid">${cells.join('')}</div>
    <div class="cal-day">
      <div class="month">${esc(dayLabel(view.sel))}</div>
      ${agenda}
      ${canPlan ? `<button class="plan-btn" data-cal="plan">+ Plan something for ${
        esc(dayLabel(view.sel).replace(/^Today$/, 'today').replace(/^Tomorrow$/, 'tomorrow'))}</button>` : ''}
      ${soon}
    </div>
  </div>`;
}
