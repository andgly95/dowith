// Something arriving from outside the app: a share-sheet target, an iOS Shortcut,
// a bookmarklet, or a link somebody sent.
//
// The whole point is that this is FAST. You are standing in a shop or halfway
// through an Instagram reel; the interaction budget is one tap on the right list
// and one on Add. So the sheet pre-fills everything it can and guesses the rest:
// the list you used last, and `shared`, because a thing you bothered to share is
// almost never a secret.
import { S } from './state.js';
import { $, esc, toast, openSheet, closeSheet } from './util.js';
import { post, applyWire } from './api.js';

const LAST = 'dw:lastList';
let pending = null;      // { title, text, url }
let where = null;        // chosen space id
let vis = 'shared';
let onDone = () => {};

// What the platform handed us. A share is usually title + url, sometimes just
// text with a URL buried in it, and occasionally only text.
export function incoming() {
  const q = new URL(location.href).searchParams;
  const title = (q.get('title') || '').trim();
  const text = (q.get('text') || '').trim();
  const url = (q.get('url') || '').trim();
  if (!title && !text && !url) return null;
  return { title, text, url };
}

// Android hands the URL inside `text` about as often as in `url`, so dig it out
// rather than trusting the field names.
function split(inc) {
  const found = inc.url || (inc.text.match(/https?:\/\/\S+/) || [])[0] || '';
  let name = inc.title || inc.text.replace(found, '').trim();
  // A bare URL as the title is worse than nothing — the host at least says what
  // the thing is while you decide.
  if (!name && found) {
    try { name = `Something from ${new URL(found).hostname.replace(/^www\./, '')}`; } catch (_) { name = found; }
  }
  return { name: name.slice(0, 200), url: found };
}

export function hasPending() { return !!pending; }

export function openShare(inc) {
  pending = inc;
  const { name, url } = split(inc);
  const spaces = (S.wire && S.wire.spaces) || [];
  if (!spaces.length) return toast('Start a list first, then share into it');

  const last = localStorage.getItem(LAST);
  where = spaces.some(x => x.id === last) ? last : spaces[0].id;
  vis = 'shared';

  $('shShared').textContent = url ? url.slice(0, 60) : 'shared with Do With';
  $('shTitle').value = name;
  paintWhere();
  paintVis();
  openSheet('shareSheet');
}

function paintWhere() {
  const spaces = (S.wire && S.wire.spaces) || [];
  $('shWhere').innerHTML = spaces.map(sp => `<button data-w="${esc(sp.id)}" class="${sp.id === where ? 'on' : ''}">
    ${esc(sp.title)}<small>${sp.counts.open} open</small></button>`).join('');
  $('shWhere').querySelectorAll('[data-w]').forEach(b =>
    b.addEventListener('click', () => { where = b.dataset.w; paintWhere(); }));
}

const VIS = [
  { id: 'private', label: 'Just me', hint: 'only you' },
  { id: 'shared', label: 'Us', hint: 'this list' },
  { id: 'public', label: 'Anyone', hint: 'all your people' },
];

function paintVis() {
  $('shVis').innerHTML = VIS.map(v => `<button data-v="${v.id}" class="${v.id === vis ? 'on' : ''}">
    <b>${esc(v.label)}</b>${esc(v.hint)}</button>`).join('');
  $('shVis').querySelectorAll('[data-v]').forEach(b =>
    b.addEventListener('click', () => { vis = b.dataset.v; paintVis(); }));
}

async function save() {
  const title = $('shTitle').value.trim();
  if (!title) return toast('Give it a name');
  const { url } = split(pending || { title: '', text: '', url: '' });
  try {
    const b = await post(`/api/space/${where}/item`, {
      title, visibility: vis,
      mod: url ? { link: { url } } : {},
    });
    applyWire(b.state);
    localStorage.setItem(LAST, where);
    clear();
    closeSheet('shareSheet');
    toast('Added');
    onDone(where);
  } catch (_) { toast('Could not add that'); }
}

// Take the share out of the URL once it is dealt with, so a reload or a
// back-button does not offer to add the same thing twice.
function clear() {
  pending = null;
  if (/[?&](title|text|url)=/.test(location.search) || location.pathname === '/share') {
    history.replaceState(null, '', '/');
  }
}

export function initShare(doneHandler) {
  onDone = doneHandler || (() => {});
  $('shSave').addEventListener('click', save);
  $('shCancel').addEventListener('click', () => { clear(); closeSheet('shareSheet'); });
  $('shareSheet').addEventListener('click', (e) => {
    if (e.target === $('shareSheet')) { clear(); closeSheet('shareSheet'); }
  });
}
