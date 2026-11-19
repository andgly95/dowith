// The bridge to the-square.
//
// **Signing in from the Square is built: the pass.** The Square's ⊞ menu has a
// Do With tile, like its Sing and SideQuest tiles, and the tile is a link
// carrying a PASS the Square signed — "the Square vouches that this is Andrew"
// (the Square's lib/app-pass.js mints it; `verifyPass` below checks it). That is
// the proof step this file used to say was missing. The survey's finding still
// stands — a Square person has a slug and a name but **no email**, so nothing
// can match one to an account here automatically — and the pass is what makes
// a match unnecessary: the link is stored on the account (`user.square`), made
// once, explicitly, and every pass after that is checked against it.
//
//   { v:1, aud:'dowith', iss:<tenant>, sub:<person id>, name, owner, iat, exp, jti }
//   as `<base64url JSON>.<base64url HMAC-SHA256>` under a secret shared with
//   Do With ONLY (`squareSecret` here, `dowithSecret` there).
//
// What a pass may do, in order (`personFor`):
//   1. **An account already linked to that Square person** is signed in.
//   2. **Signed in here and not linked to anybody** — the claim. Asked, never
//      assumed (a page says who you are signed in as and offers to link them),
//      because a shared browser would otherwise hand one person's Square to
//      another's lists.
//   3. **Otherwise a new account**, linked. The Square is the owner's building and
//      its members are let in by him, which is the same vouching an invite is; an
//      account with no lists sees nothing (lib/spaces.js keys on shared lists).
// The `owner` claim is ignored: admin here is `admins` in config and nothing else.
// An existing account is linked from the shell (`tools/square-link.js`), the same
// credential as minting a sign-in link.
//
// **The hard constraint on reading the Square's store**: `data/store.json` over
// there holds `messages`, `dms` and `groupMessages` — everybody's private
// conversations. Any bridge reads `people` and `customGroups` and NOTHING else,
// and it reads them read-only. This is the same data the trips agent sandbox
// goes out of its way to `--tmpfs` away; a convenience feature must not be the
// thing that walks it out of the building. The pass needs none of it: a person's
// id and name arrive signed, and the store is never opened for them.
//
// The import below (people and groups, to start lists from) is still unbuilt and
// `importable()` still refuses.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Not hardcoded: a bridge that assumes a sibling directory breaks the moment
// either app moves, and this repo is meant to run somewhere other than one Pi.
const storePath = () => config.get('squareStorePath', null);

const configured = () => !!storePath();

function available() {
  const p = storePath();
  if (!p) return { ok: false, why: 'not configured' };
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return { ok: true, path: path.basename(p) };
  } catch (_) {
    return { ok: false, why: 'configured but unreadable' };
  }
}

// Read ONLY the two collections a bridge could ever legitimately want. Written as
// one function so there is a single place where the Square's file is opened, and
// so the narrowing is visible rather than being a discipline each caller has to
// remember.
function readPeople() {
  const p = storePath();
  if (!p) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
  const people = Array.isArray(raw.people) ? raw.people : [];
  const groups = Array.isArray(raw.customGroups) ? raw.customGroups : [];
  // Projected down to the fields a "who could I add?" list needs. Everything
  // else — including anything added to a person over there later — is left
  // behind rather than carried across by accident.
  return {
    people: people.map(x => ({
      id: String(x.id || ''),
      name: String(x.name || '').slice(0, 60),
      avatar: typeof x.avatar === 'string' ? x.avatar.slice(0, 300) : null,
    })).filter(x => x.id && x.name),
    groups: groups.map(g => ({
      id: String(g.id || ''),
      name: String(g.name || '').slice(0, 60),
      memberIds: Array.isArray(g.memberIds) ? g.memberIds.map(String) : [],
    })).filter(g => g.id && g.name),
  };
}

// The status a settings screen can show without promising anything.
function status() {
  const a = available();
  if (!a.ok) return { configured: configured(), available: false, why: a.why, people: 0, groups: 0 };
  const d = readPeople();
  return {
    configured: true,
    available: !!d,
    people: d ? d.people.length : 0,
    groups: d ? d.groups.length : 0,
    // Said out loud so the UI cannot imply otherwise.
    linkable: false,
    why: 'the identity claim is not built yet — see lib/square.js',
  };
}

// The seam itself. Deliberately refuses.
//
// It returns rather than throws, and says why in words a route can pass straight
// through, because "not built" and "broken" must not look the same from outside.
function importable() {
  return {
    ok: false,
    reason: 'not-implemented',
    why: 'Linking a Square identity needs a proof step that does not exist yet. '
       + 'Nothing is imported until it does.',
  };
}

/* ── the pass ────────────────────────────────────────────────────────────── */

const AUD = 'dowith';
const MAX_LIFE_S = 10 * 60;   // the Square mints five minutes; anything longer is not its pass
const SKEW_S = 60;
const MAX_SPENT = 500;

// Read live, like admins: setting the secret needs no restart, and removing it
// turns the door off at once.
const passSecret = () => String(config.get('squareSecret', '') || '');
const tenant = () => String(config.get('squareTenant', 'ava') || 'ava');
const linked = () => !!passSecret();

const BAD = 'That link from the Square is not valid. Open Do With from the Square again.';

// { ok, claims } or { ok:false, why }. Never throws: a mangled pass is just not
// a pass, and a caller that had to try/catch would eventually forget.
function verifyPass(token, { secret = passSecret(), iss = tenant(), now = Date.now(), used = new Set() } = {}) {
  if (!secret) return { ok: false, why: 'Do With is not linked to the Square on this server.' };
  const bad = { ok: false, why: BAD };
  if (typeof token !== 'string' || token.length > 2048) return bad;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return bad;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return bad;
  let c;
  try { c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { return bad; }
  const t = Math.floor(now / 1000);
  // A pass for Sing does not open Do With, and another building's does not open this one.
  if (!c || c.v !== 1 || c.aud !== AUD || c.iss !== iss) return bad;
  if (typeof c.sub !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(c.sub)) return bad;
  if (typeof c.jti !== 'string' || c.jti.length < 16 || c.jti.length > 64) return bad;
  if (!Number.isFinite(c.iat) || !Number.isFinite(c.exp) || c.iat > t + SKEW_S || c.exp - c.iat > MAX_LIFE_S) return bad;
  if (c.exp < t) return { ok: false, why: 'That link from the Square has expired. Open Do With from the Square again.' };
  if (used.has(c.jti)) return { ok: false, why: 'That link from the Square has already been used. Open Do With from the Square again.' };
  return { ok: true, claims: { iss: c.iss, sub: c.sub, name: typeof c.name === 'string' ? c.name : '', jti: c.jti, exp: c.exp } };
}

// Single use: the nonce is kept until the pass would have expired anyway, and
// no longer — after that the expiry check refuses it on its own.
function spendPass(state, claims, now = Date.now()) {
  const t = Math.floor(now / 1000);
  const kept = (Array.isArray(state.squarePasses) ? state.squarePasses : []).filter(p => p && p.exp >= t - SKEW_S);
  kept.push({ jti: claims.jti, exp: claims.exp });
  state.squarePasses = kept.slice(-MAX_SPENT);
}
const spentPasses = (state) => new Set((Array.isArray(state.squarePasses) ? state.squarePasses : []).map(p => p && p.jti));

const isLinkedTo = (u, claims) => !!(u && u.square && u.square.tenant === claims.iss && u.square.id === claims.sub);

// Who a pass is for. PURE: { how: 'linked', user } | { how: 'claim', user } | { how: 'new' }.
// `current` is whoever this browser is signed in as, if anybody.
function personFor(users, claims, current) {
  const already = Object.values(users || {}).find(u => isLinkedTo(u, claims));
  if (already) return { how: 'linked', user: already };
  if (current && !current.square) return { how: 'claim', user: current };
  return { how: 'new' };
}

const linkOf = (claims, now = Date.now()) => ({ tenant: claims.iss, id: claims.sub, at: now });

module.exports = {
  configured, available, readPeople, status, importable, storePath,
  AUD, linked, tenant, verifyPass, spendPass, spentPasses, personFor, isLinkedTo, linkOf,
};
