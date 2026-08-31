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

module.exports = { TTL_MS, mint, create, check, redeem };
