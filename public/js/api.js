// Every call returns fresh state where it can, so there is one copy of the truth
// and no screen has to guess what changed.
import { S } from './state.js';

async function call(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  // The session went away. Reload rather than limping on with a wire that no
  // longer belongs to anybody — app.js will land on the sign-in screen.
  if (r.status === 401) { location.reload(); throw new Error('401'); }
  const b = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error((b && b.error) || r.status), { body: b, status: r.status });
  return b;
}

export const get = (p) => call('GET', p);
export const post = (p, b) => call('POST', p, b || {});
export const patch = (p, b) => call('PATCH', p, b || {});
export const del = (p) => call('DELETE', p);

export function applyWire(w) { if (w) S.wire = w; }

// A VAPID key arrives base64url; PushManager wants raw bytes.
function b64(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

// Hand this device to the server so a nudge can reach it with the app closed.
// Must be called from a gesture — iOS ignores the permission prompt otherwise.
export async function subscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, why: 'This browser cannot do notifications.' };
  }
  const key = S.wire && S.wire.push && S.wire.push.key;
  if (!key) return { ok: false, why: 'Not set up on the server yet.' };
  if (Notification.permission === 'denied') {
    return { ok: false, why: 'Blocked — turn notifications on for Do With in Settings.' };
  }
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') {
    return { ok: false, why: 'Allow notifications to get nudges.' };
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
    applyWire(await post('/api/push/subscribe', { subscription: sub.toJSON() }));
    return { ok: true };
  } catch (_) { return { ok: false, why: 'Could not subscribe this device.' }; }
}

export async function unsubscribePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await post('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    applyWire(await get('/api/state'));
  } catch (_) {}
}

export async function loadState() {
  applyWire(await get('/api/state'));
  return S.wire;
}
