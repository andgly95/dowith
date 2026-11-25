// The Claude row in the account sheet, and its sheet: the address to paste into
// Claude, a code for a browser that is not signed in here, and who is connected
// with a Disconnect each. The server decides all of it (lib/oauth.js); this
// only shows it.
import { $, esc, toast, openSheet, closeSheet, shortDate } from './util.js';
import { get, post, del } from './api.js';
import { haptic } from './motion.js';

let codeTimer = null;

export async function paintClaudeRow() {
  try {
    const c = await get('/api/connect');
    $('claudeState').textContent = c.connections.length ? 'connected' : 'not connected';
    return c;
  } catch (_) { $('claudeState').textContent = '—'; return null; }
}

function paintConns(list) {
  const box = $('clConns');
  $('clConnHd').hidden = box.hidden = !list.length;
  box.innerHTML = list.map(c => `<div class="crow cl-conn"><span class="cb"><b>${esc(c.name)}</b>
    <small>since ${esc(shortDate(c.createdAt))} · last used ${esc(shortDate(c.lastUsed))}</small></span>
    <span class="val"><button type="button" data-drop="${esc(c.id)}">Disconnect</button></span></div>`).join('');
  box.querySelectorAll('[data-drop]').forEach(b => b.addEventListener('click', async () => {
    haptic('tick');
    try {
      const r = await del(`/api/connect/${encodeURIComponent(b.dataset.drop)}`);
      paintConns(r.connections);
      paintClaudeRow();
      toast('Disconnected');
    } catch (_) { toast('Could not disconnect that'); }
  }));
}

export async function openClaude() {
  const c = await paintClaudeRow();
  if (!c) return toast('Could not load that');
  $('clUrl').textContent = c.url;
  $('clCodeOut').hidden = true;
  paintConns(c.connections);
  openSheet('claudeSheet');
}

function showCode(r) {
  clearInterval(codeTimer);
  const out = $('clCodeOut');
  const tick = () => {
    const left = Math.max(0, Math.round((r.expiresAt - Date.now()) / 60000));
    if (r.expiresAt <= Date.now()) { out.innerHTML = '<small>That code has expired. Get another.</small>'; clearInterval(codeTimer); return; }
    out.innerHTML = `<b>${esc(r.code)}</b><small>Type it on the Allow page · works once · ${left < 1 ? 'under a minute' : `${left} min`} left</small>`;
  };
  out.hidden = false;
  tick();
  codeTimer = setInterval(tick, 15000);
}

export function initClaude() {
  $('claudeRow').addEventListener('click', () => { closeSheet('meSheet'); openClaude(); });
  $('clClose').addEventListener('click', () => { clearInterval(codeTimer); closeSheet('claudeSheet'); });
  $('clCopy').addEventListener('click', async () => {
    haptic('tick');
    try { await navigator.clipboard.writeText($('clUrl').textContent); toast('Copied'); } catch (_) { toast('Press and hold the address to copy it'); }
  });
  $('clCode').addEventListener('click', async () => {
    haptic('tick');
    try { showCode(await post('/api/connect/code')); } catch (_) { toast('Could not make a code'); }
  });
}
