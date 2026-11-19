// Sign-in. Nobody gets an account without an invite, so the screen's job when a
// code is present is to say who invited you — landing on a bare Google button
// with no explanation is how a link from your girlfriend looks like phishing.
import { $, esc, showScreen } from './util.js';

let onIn = () => {};
let clientId = null;
let via = 'google';
let invite = null;

export function inviteCode() {
  return new URL(location.href).searchParams.get('invite');
}

export async function checkAuth() {
  invite = inviteCode();
  try {
    const b = await (await fetch('/api/auth/me', { cache: 'no-store' })).json();
    clientId = b.clientId || null;
    via = b.via || 'google';
    return b.status;
  } catch (_) { return 'anon'; }
}

export async function showAuth() {
  showScreen('scr-auth');
  const inv = invite ? await lookUp() : null;
  // The invite signs you in by itself (POST /api/invite/:code/join): a name and
  // one tap, whatever else is configured. Google, when there is a client id, is
  // offered under it for anybody who would rather.
  if (inv && inv.ok) {
    showJoin(inv);
    if (clientId && via !== 'cloudflare') loadGoogle();
    return;
  }
  if (inv) return note(`${inv.why} Ask whoever sent it for a new one.`);
  if (via === 'cloudflare') {
    return note('This app sits behind Cloudflare Access and your login was not recognised. Reload, or sign in again through Cloudflare.');
  }
  if (!clientId) return note('To join, open the invite link you were sent.');
  loadGoogle();
}

function loadGoogle() {
  if (window.google && window.google.accounts) return button();
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = button;
  s.onerror = () => note('Could not reach Google. Check your connection.');
  document.head.appendChild(s);
}

// Who sent this, before you commit to anything.
async function lookUp() {
  try {
    return await (await fetch(`/api/invite/${encodeURIComponent(invite)}`)).json();
  } catch (_) { return null; }
}

function showJoin(inv) {
  const who = inv.from ? inv.from.name : 'Someone';
  $('authLede').innerHTML = `<b>${esc(who)}</b> wants to keep a list of things to do with you.`;
  $('joinAsk').textContent = inv.from ? `What should ${who} call you?` : 'What should we call you?';
  const form = $('joinForm');
  form.hidden = false;
  form.onsubmit = (e) => { e.preventDefault(); join(); };
  // Not on a phone: the keyboard would cover the button it is asking you to read.
  if (matchMedia('(hover: hover)').matches) $('joinName').focus();
}

async function join() {
  const name = $('joinName').value.trim();
  if (!name) { $('joinName').focus(); return; }
  const btn = $('joinGo');
  if (btn.disabled) return;
  btn.disabled = true;
  $('authNote').hidden = true;
  try {
    const r = await fetch(`/api/invite/${encodeURIComponent(invite)}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const b = await r.json().catch(() => ({}));
    // Already signed in (another tab got there first): just go in.
    if (r.status === 409 && /signed in/.test(b.error || '')) return arrived();
    if (!r.ok) { btn.disabled = false; return note(b.error || 'That did not work.'); }
    arrived();
  } catch (_) { btn.disabled = false; note('Could not reach the server.'); }
}

function arrived() {
  // Drop the code from the URL — it is spent, and a reload must not look like a
  // second attempt to redeem it.
  history.replaceState(null, '', location.pathname);
  onIn();
}

function note(msg) { $('authNote').textContent = msg; $('authNote').hidden = false; }

function button() {
  try {
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (r) => submit(r.credential),
    });
    window.google.accounts.id.renderButton($('gbtn'), {
      theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 280,
    });
  } catch (_) { note('Could not start Google sign-in.'); }
}

async function submit(credential) {
  if (!credential) return;
  $('authNote').hidden = true;
  try {
    const r = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential, invite }),
    });
    const b = await r.json();
    if (!r.ok) return note(b.error || 'That did not work.');
    arrived();
  } catch (_) { note('Could not reach the server.'); }
}

export async function signOut() {
  try { await fetch('/api/auth/signout', { method: 'POST' }); } catch (_) {}
  if (via === 'cloudflare') { location.href = '/cdn-cgi/access/logout'; return; }
  location.reload();
}

export function initAuth(inHandler) { onIn = inHandler; }
