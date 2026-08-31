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

export async function loadState() {
  applyWire(await get('/api/state'));
  return S.wire;
}
