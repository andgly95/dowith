// Sign-in links.
//
// Not a bypass, and the distinction matters. A link is signed with the same
// secret as a session cookie, expires, and is one-shot — so it is exactly as
// strong as the session it produces, and no stronger. What makes it safe is
// where it can be minted: **only from the server side**, by someone with shell
// access to the box. There is no HTTP route that issues one, so nobody can ask
// for a link to somebody else's account.
//
// This is also the honest long-term shape for this app. The whole product is
// "send Linnea a link"; an identity provider supplies a verified name and email,
// which is worth having, but the authorisation was always the link.
const crypto = require('crypto');
const config = require('./config');

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A session cookie and a link token are both `<payload>.<sig>` over the same
// secret. Without a purpose label, one could be presented as the other — a
// long-lived cookie replayed as a fresh link, or vice versa. The label is inside
// the signed payload, so it cannot be edited.
const PURPOSE = 'link';
const MAX_USED = 500;

const secret = () => {
  let s = config.get('sessionSecret');
  if (!s) {
    s = crypto.randomBytes(32).toString('base64url');
    config.set({ sessionSecret: s });
  }
  return s;
};

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const hmac = (payload, sec) => crypto.createHmac('sha256', sec).update(payload).digest('base64url');

function mint(uid, { now = Date.now(), sec = secret() } = {}) {
  const payload = b64({ p: PURPOSE, u: uid, e: now + TTL_MS, n: crypto.randomBytes(9).toString('base64url') });
  return `${payload}.${hmac(payload, sec)}`;
}

// Returns { ok, uid } or { ok: false, why }. Never throws — a mangled link is
// just not a link, and a caller that had to try/catch would eventually forget.
function verify(token, { now = Date.now(), sec = secret(), used = new Set() } = {}) {
  if (typeof token !== 'string' || token.length > 1024) return { ok: false, why: 'That link is not valid.' };
  const dot = token.lastIndexOf('.');
  if (dot < 1) return { ok: false, why: 'That link is not valid.' };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = hmac(payload, sec);
  if (sig.length !== want.length) return { ok: false, why: 'That link is not valid.' };
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
    return { ok: false, why: 'That link is not valid.' };
  }
  let d;
  try { d = unb64(payload); } catch (_) { return { ok: false, why: 'That link is not valid.' }; }
  if (!d || d.p !== PURPOSE || typeof d.u !== 'string' || typeof d.e !== 'number' || typeof d.n !== 'string') {
    return { ok: false, why: 'That link is not valid.' };
  }
  if (d.e < now) return { ok: false, why: 'That link has expired.' };
  if (used.has(d.n)) return { ok: false, why: 'That link has already been used.' };
  return { ok: true, uid: d.u, nonce: d.n };
}

// Remember the nonce so the link cannot be replayed. Bounded, oldest-first — an
// unbounded list of spent tokens is a slow leak, and a nonce older than the TTL
// cannot be replayed anyway because the expiry check has already refused it.
function spend(state, nonce) {
  if (!Array.isArray(state.usedLinks)) state.usedLinks = [];
  state.usedLinks.push(nonce);
  if (state.usedLinks.length > MAX_USED) state.usedLinks = state.usedLinks.slice(-MAX_USED);
}

const usedSet = (state) => new Set(Array.isArray(state.usedLinks) ? state.usedLinks : []);

module.exports = { TTL_MS, PURPOSE, MAX_USED, mint, verify, spend, usedSet };
