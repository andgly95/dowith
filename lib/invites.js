// Invites. The only way anybody gets an account or joins a space.
//
// Signing in alone gets a stranger nothing: a brand-new Google account arriving
// without an invite is refused and no user record is written at all. That is a
// deliberate choice over an approval queue — this is an app for the people you
// actually do things with, and "send Linnea a link" is how that starts in real
// life. A queue would mean strangers accumulating in the store waiting to be told
// no, which is a worse thing to own.
const crypto = require('crypto');

const TTL_MS = 14 * 24 * 60 * 60 * 1000;   // a fortnight is plenty to send a link
const CODE_BYTES = 9;                      // 12 url-safe characters

// Unguessable, not merely unique. A short sequential code is a door you could
// walk down the street trying handles on.
const mint = () => crypto.randomBytes(CODE_BYTES).toString('base64url');

function create(state, { spaceId = null, createdBy, note = null, now = Date.now() }) {
  const inv = {
    code: mint(),
    spaceId,
    createdBy,
    note: note ? String(note).slice(0, 80) : null,
    createdAt: now,
    expiresAt: now + TTL_MS,
    usedBy: null,
    usedAt: null,
  };
  state.invites.push(inv);
  return inv;
}

// The invite, or a reason it is no good. One-shot and time-limited: a link
// forwarded around a group chat six months later must not still open a door.
function check(state, code, now = Date.now()) {
  const inv = (state.invites || []).find(i => i.code === String(code || ''));
  if (!inv) return { ok: false, why: 'That invite link is not valid.' };
  if (inv.usedBy) return { ok: false, why: 'That invite has already been used.' };
  if (inv.expiresAt < now) return { ok: false, why: 'That invite has expired.' };
  return { ok: true, invite: inv };
}

function redeem(state, code, uid, now = Date.now()) {
  const res = check(state, code, now);
  if (!res.ok) return res;
  res.invite.usedBy = uid;
  res.invite.usedAt = now;
  return res;
}

/* ── joining from the link itself ─────────────────────────────────────────
   The invite IS the credential. It is unguessable, one-shot and good for a
   fortnight, which is exactly what a sign-in link is (lib/magic.js) — so a
   person holding one can be signed in by it, with a name they type, and no
   identity provider in between. Without this, a server with neither Google nor
   Cloudflare Access configured showed the person Andrew had just sent a link to
   "Sign-in is not configured on this server yet", in a restaurant. */

const NAME_MAX = 40;

// What they typed, made safe to be somebody's name: no control or bidi
// characters (a name is shown in other people's titles and lock screens), one
// space between words, and a length counted in characters rather than UTF-16
// halves, so an emoji is never cut in two.
function cleanName(v) {
  const s = String(v == null ? '' : v).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, NAME_MAX).join('').trim();
}

// `link:<name>` — the same shape tools/link.js makes, so a person who joined by
// invite can be sent a sign-in link for a new phone by name. Never somebody
// else's: a name already taken gets a random tail, because the id is the account
// and a second Andrew must not become the first one (or his admin rights).
function idFor(users, name, rand = () => crypto.randomBytes(3).toString('hex')) {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'friend';
  let id = `link:${slug}`;
  while (users[id]) id = `link:${slug}-${rand()}`;
  return id;
}

module.exports = { TTL_MS, NAME_MAX, mint, create, check, redeem, cleanName, idFor };
