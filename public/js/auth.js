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
  showLede();
  if (via === 'cloudflare') {
    return note('This app sits behind Cloudflare Access and your login was not recognised. Reload, or sign in again through Cloudflare.');
  }
  if (!clientId) return note('Sign-in is not configured on this server yet.');
  if (window.google && window.google.accounts) return button();
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = button;
  s.onerror = () => note('Could not reach Google. Check your connection.');
  document.head.appendChild(s);
}

// Who sent this, before you commit to anything.
async function showLede() {
  if (!invite) return;
  try {
    const b = await (await fetch(`/api/invite/${encodeURIComponent(invite)}`)).json();
    if (!b.ok) return note(b.why);
    const who = b.from ? b.from.name : 'Someone';
    $('authLede').innerHTML =
      `<b>${esc(who)}</b> wants to keep a list of things to do with you.<br>Sign in and it's yours too.`;
  } catch (_) {}
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
    // Drop the code from the URL — it is spent, and a reload must not look like
    // a second attempt to redeem it.
    history.replaceState(null, '', location.pathname);
    onIn();
  } catch (_) { note('Could not reach the server.'); }
}

export async function signOut() {
  try { await fetch('/api/auth/signout', { method: 'POST' }); } catch (_) {}
  if (via === 'cloudflare') { location.href = '/cdn-cgi/access/logout'; return; }
  location.reload();
}

export function initAuth(inHandler) { onIn = inHandler; }
