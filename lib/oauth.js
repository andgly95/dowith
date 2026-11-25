// The connector's door: an OAuth 2.1 authorization server for exactly one
// resource (this app's /mcp) and, in practice, one kind of client (Claude). It
// exists so somebody can ask Claude "what's on our list?" and Claude can read
// it — as them, with the same screen they would see, and nothing more.
//
// What it promises, stated once:
//
//   1. A token is only ever SHOWN once. The store keeps a SHA-256 of it, so a
//      copy of store.json is not a copy of anybody's access.
//   2. Read only. One scope, `lists:read`; the connector has no tool that writes.
//   3. Nobody is connected without saying so on THIS domain: a signed-in browser
//      taps Allow, and one that isn't types a code their own phone made.
//   4. Codes and redirects are narrow. A client may register Claude's callback or
//      a loopback address (Claude Code) and nothing else, so an approval can
//      only ever travel back to Claude or to the machine that asked.
//   5. Revoking is immediate: Disconnect in the account sheet deletes the grant,
//      and the next call with its token is a 401.
//
// PURE apart from crypto and the in-memory maps below: the caller passes the
// store's state, the time and the secret, so the suite drives all of it with
// no server.
const crypto = require('crypto');
const { cleanName } = require('./invites');

const SCOPE = 'lists:read';
const ACCESS_TTL_MS = 60 * 60 * 1000;                 // an hour; Claude refreshes ahead of it
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;      // sixty days unused, then connect again
const CODE_TTL_MS = 60 * 1000;                        // an authorization code: one minute, once
const TXN_TTL_MS = 15 * 60 * 1000;                    // the Allow page, if left open
const PAIR_TTL_MS = 10 * 60 * 1000;                   // a code from the phone
const MAX_CLIENTS = 200;
const UNUSED_CLIENT_MS = 24 * 60 * 60 * 1000;         // Claude registers afresh on every new connection
const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
// No I, L, O, 0 or 1: it is read off one screen and typed into another.
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url');
const fresh = (prefix) => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const hmac = (payload, sec) => crypto.createHmac('sha256', sec).update(payload).digest('base64url');
const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

function box(state) {
  if (!state.oauth || typeof state.oauth !== 'object') state.oauth = {};
  if (!state.oauth.clients || typeof state.oauth.clients !== 'object') state.oauth.clients = {};
  if (!state.oauth.grants || typeof state.oauth.grants !== 'object') state.oauth.grants = {};
  return state.oauth;
}

/* ── metadata ───────────────────────────────────────────────────────────── */

// RFC 9728: what the resource is and who issues its tokens. `resource` is the
// MCP URL exactly — Claude compares it.
const resourceMetadata = (base) => ({
  resource: `${base}/mcp`,
  authorization_servers: [base],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'Do With',
});

// RFC 8414. No `client_id_metadata_document_supported`: Claude then registers
// itself (RFC 7591) as a public client, PKCE and no secret.
const serverMetadata = (base) => ({
  issuer: base,
  authorization_endpoint: `${base}/oauth/authorize`,
  token_endpoint: `${base}/oauth/token`,
  registration_endpoint: `${base}/oauth/register`,
  revocation_endpoint: `${base}/oauth/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [SCOPE],
  authorization_response_iss_parameter_supported: true,
});

/* ── clients ────────────────────────────────────────────────────────────── */

// Claude's callback, or loopback on any port for Claude Code (RFC 8252). An
// https redirect anywhere else is refused: an approval that could be sent to
// any site is a phishing kit with this domain's name on it.
function redirectAllowed(uri, extra = []) {
  if (typeof uri !== 'string' || !uri || uri.length > 500) return false;
  if (CLAUDE_CALLBACKS.includes(uri) || (Array.isArray(extra) && extra.includes(uri))) return true;
  let u;
  try { u = new URL(uri); } catch (_) { return false; }
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    && !u.username && !u.password && !u.hash;
}

function prune(state, now) {
  const o = box(state);
  for (const [id, g] of Object.entries(o.grants)) {
    if (!g || !g.refresh || g.refresh.exp < now || !o.clients[g.clientId]) delete o.grants[id];
  }
  const used = new Set(Object.values(o.grants).map(g => g.clientId));
  const idle = Object.values(o.clients).filter(c => !used.has(c.id)).sort((a, b) => a.createdAt - b.createdAt);
  for (const c of idle) if (c.createdAt < now - UNUSED_CLIENT_MS) delete o.clients[c.id];
  // Registration is open by design (Claude needs no key to start), so it is
  // also capped: past the limit, the oldest clients nobody has approved go.
  const left = idle.filter(c => o.clients[c.id]);
  while (Object.keys(o.clients).length >= MAX_CLIENTS && left.length) delete o.clients[left.shift().id];
}

// RFC 7591. Returns { client } (the response body) or { error, error_description }.
function register(state, body, { now = Date.now(), extra = [] } = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > 5 || !uris.every(u => redirectAllowed(u, extra))) {
    return { error: 'invalid_redirect_uri', error_description: "Do With sends an approval back to Claude's own callback, or to a loopback address, and nowhere else." };
  }
  const grants = Array.isArray(b.grant_types) ? b.grant_types : ['authorization_code'];
  if (!grants.every(g => g === 'authorization_code' || g === 'refresh_token')) {
    return { error: 'invalid_client_metadata', error_description: 'Only authorization_code and refresh_token.' };
  }
  prune(state, now);
  const o = box(state);
  if (Object.keys(o.clients).length >= MAX_CLIENTS) return { error: 'temporarily_unavailable', error_description: 'Too many connections waiting. Try again later.' };
  const id = `dwc_${crypto.randomBytes(12).toString('base64url')}`;
  const name = cleanName(b.client_name) || 'An app';
  o.clients[id] = { id, name, redirectUris: uris.slice(), createdAt: now };
  return {
    client: {
      client_id: id,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: uris.slice(),
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Whatever was asked for, this is a public client: a secret handed to a
      // registration anybody can make proves nothing. PKCE does that job.
      token_endpoint_auth_method: 'none',
    },
  };
}

const clientOf = (state, id) => box(state).clients[str(id, 100)] || null;

/* ── the authorization request ──────────────────────────────────────────── */

// Returns { ok, client, params } or, for what cannot be sent back to the client
// (no such client, a redirect it never registered), { fatal } — shown on the
// page, never redirected, or this is an open redirector. Anything else is
// { error, redirect, state } and goes back to the client as OAuth says.
function checkAuthorize(state, q, resource) {
  q = q || {};
  const client = clientOf(state, q.client_id);
  if (!client) return { fatal: 'This connection isn’t registered with Do With. Start again from Claude.' };
  let redirect = str(q.redirect_uri, 500);
  if (!redirect && client.redirectUris.length === 1) redirect = client.redirectUris[0];
  if (!client.redirectUris.includes(redirect)) return { fatal: 'That return address isn’t the one this connection registered.' };
  const st = q.state === undefined ? null : str(q.state, 1000);
  const fail = (error, desc) => ({ error, error_description: desc, redirect, state: st });
  if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only code.');
  if (q.code_challenge_method !== 'S256' || !PKCE.test(str(q.code_challenge, 200))) return fail('invalid_request', 'PKCE with S256 is required.');
  if (q.resource !== undefined && str(q.resource, 500) !== resource) return fail('invalid_target', 'Do With issues tokens for its own /mcp only.');
  return { ok: true, client, params: { client_id: client.id, redirect_uri: redirect, code_challenge: q.code_challenge, state: st, resource } };
}

// The Allow page carries the request through a form, signed so the POST cannot
// approve something other than what the page showed. A purpose label inside the
// signed part keeps it from ever passing for a session or a sign-in link.
function sealTxn(params, sec, now = Date.now()) {
  const payload = b64({ k: 'oauth-txn', x: now + TXN_TTL_MS, p: params });
  return `${payload}.${hmac(payload, sec)}`;
}
function openTxn(t, sec, now = Date.now()) {
  if (typeof t !== 'string' || t.length > 6000) return null;
  const dot = t.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = t.slice(0, dot);
  const sig = Buffer.from(t.slice(dot + 1));
  const want = Buffer.from(hmac(payload, sec));
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  let d;
  try { d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!d || d.k !== 'oauth-txn' || typeof d.x !== 'number' || d.x < now || !d.p) return null;
  return d.p;
}

/* ── codes ──────────────────────────────────────────────────────────────── */

// Authorization codes live a minute and only in memory: a restart in that
// minute costs one tap on Connect, and nothing on disk is ever a live code.
const codes = new Map();
function issueCode(uid, params, now = Date.now()) {
  for (const [k, c] of codes) if (c.exp < now) codes.delete(k);
  const code = fresh('dwa');
  codes.set(hash(code), { uid, ...params, exp: now + CODE_TTL_MS });
  return code;
}

// A code from the phone, for a browser that is not signed in here. In memory,
// ten minutes, once, one at a time per person.
const pairs = new Map();
const normPair = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function mintPair(uid, now = Date.now()) {
  for (const [k, p] of pairs) if (p.uid === uid || p.exp < now) pairs.delete(k);
  let raw = '';
  const bytes = crypto.randomBytes(8);
  for (const b of bytes) raw += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
  pairs.set(hash(raw), { uid, exp: now + PAIR_TTL_MS });
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: now + PAIR_TTL_MS };
}
function takePair(code, now = Date.now()) {
  const k = hash(normPair(code));
  const p = pairs.get(k);
  if (!p) return null;
  pairs.delete(k);
  return p.exp >= now ? p.uid : null;
}

// Guessing at codes: ten wrong per address and a hundred wrong in all per
// quarter hour, after which every attempt waits. 31^8 codes alive for ten
// minutes is not guessable at that rate; the limit is what makes that true.
const misses = new Map();
const MISS_WINDOW_MS = 15 * 60 * 1000;
function pairBlocked(ip, now = Date.now()) {
  for (const [k, m] of misses) if (m.at < now - MISS_WINDOW_MS) misses.delete(k);
  const all = [...misses.values()].reduce((n, m) => n + m.n, 0);
  return all >= 100 || ((misses.get(ip) || {}).n || 0) >= 10;
}
function pairMissed(ip, now = Date.now()) {
  const m = misses.get(ip);
  if (m && m.at >= now - MISS_WINDOW_MS) m.n++;
  else misses.set(ip, { n: 1, at: now });
}

/* ── tokens ─────────────────────────────────────────────────────────────── */

function tokensFor(g, now) {
  const access = fresh('dwt');
  const refresh = fresh('dwr');
  g.access = { hash: hash(access), exp: now + ACCESS_TTL_MS };
  g.refresh = { hash: hash(refresh), exp: now + REFRESH_TTL_MS };
  g.lastUsed = now;
  return { access_token: access, token_type: 'Bearer', expires_in: Math.round(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: g.scope };
}

const oops = (error, error_description) => ({ error, error_description });

// The token endpoint. Returns { tokens } or { error, error_description }.
function exchange(state, form, { now = Date.now(), resource, userExists = () => true } = {}) {
  const f = form || {};
  const o = box(state);
  if (f.resource !== undefined && str(f.resource, 500) !== resource) return oops('invalid_target', 'Do With issues tokens for its own /mcp only.');
  if (f.grant_type === 'authorization_code') {
    const k = hash(str(f.code, 200));
    const c = codes.get(k);
    codes.delete(k);   // once, even when the rest of this request is wrong
    if (!c || c.exp < now) return oops('invalid_grant', 'That code has expired or was already used.');
    if (str(f.client_id, 100) !== c.client_id) return oops('invalid_grant', 'That code was issued to a different client.');
    if (str(f.redirect_uri, 500) !== c.redirect_uri) return oops('invalid_grant', 'redirect_uri does not match.');
    const v = str(f.code_verifier, 200);
    if (!PKCE.test(v) || hash(v) !== c.code_challenge) return oops('invalid_grant', 'PKCE verification failed.');
    const client = o.clients[c.client_id];
    if (!client || !userExists(c.uid)) return oops('invalid_grant', 'That connection no longer exists.');
    prune(state, now);
    const id = `g_${crypto.randomBytes(9).toString('base64url')}`;
    const g = { id, uid: c.uid, clientId: client.id, clientName: client.name, scope: SCOPE, createdAt: now };
    o.grants[id] = g;
    return { tokens: tokensFor(g, now) };
  }
  if (f.grant_type === 'refresh_token') {
    const h = hash(str(f.refresh_token, 200));
    const g = Object.values(o.grants).find(x => x.refresh && x.refresh.hash === h);
    if (!g || g.refresh.exp < now || g.clientId !== str(f.client_id, 100) || !userExists(g.uid)) {
      return oops('invalid_grant', 'Connect again from Claude.');
    }
    // Rotated: the old refresh token stops working in the same breath as the
    // new one is handed over, which is what Claude expects.
    return { tokens: tokensFor(g, now) };
  }
  return oops('unsupported_grant_type', 'authorization_code or refresh_token.');
}

// `Authorization: Bearer …` → the grant, or null. Never from a query string.
function bearer(state, header, now = Date.now()) {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{10,200})\s*$/i.exec(String(header || ''));
  if (!m) return null;
  const h = hash(m[1]);
  const g = Object.values(box(state).grants).find(x => x.access && x.access.hash === h);
  if (!g || g.access.exp < now) return null;
  g.lastUsed = now;   // in memory; written with whatever is saved next
  return g;
}

// RFC 7009: either token ends the whole grant. Unknown tokens are not an error.
function revokeToken(state, token, clientId) {
  const h = hash(str(token, 200));
  const o = box(state);
  const g = Object.values(o.grants).find(x => (x.access && x.access.hash === h) || (x.refresh && x.refresh.hash === h));
  if (g && (!clientId || g.clientId === clientId)) { delete o.grants[g.id]; return true; }
  return false;
}

/* ── what the account sheet shows ───────────────────────────────────────── */

const grantsOf = (state, uid) => Object.values(box(state).grants)
  .filter(g => g.uid === uid)
  .sort((a, b) => b.createdAt - a.createdAt)
  .map(g => ({ id: g.id, name: g.clientName, createdAt: g.createdAt, lastUsed: g.lastUsed || g.createdAt }));

function revoke(state, id, uid) {
  const o = box(state);
  const g = o.grants[str(id, 100)];
  if (!g || g.uid !== uid) return false;
  delete o.grants[g.id];
  return true;
}

module.exports = {
  SCOPE, ACCESS_TTL_MS, REFRESH_TTL_MS, CODE_TTL_MS, PAIR_TTL_MS, CLAUDE_CALLBACKS,
  hash, resourceMetadata, serverMetadata, redirectAllowed, register, clientOf, checkAuthorize,
  sealTxn, openTxn, issueCode, mintPair, takePair, pairBlocked, pairMissed,
  exchange, bearer, revokeToken, grantsOf, revoke, prune,
};
