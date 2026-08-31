// The bridge to the-square. PLUMBING ONLY — nothing here imports anybody yet,
// and `importable()` refuses on purpose. This exists so the shape is decided
// while the reasons are fresh, not so it can be switched on today.
//
// What the survey found, and what it means:
//
// The Square identifies people by a slug — `andrew`, `linnea` — with a name, a
// colour, an avatar and a bio. **There is no email on a Square person.** So there
// is no field to join on: nothing can match a Square person to a Google account
// automatically, and anything that tried would be guessing at whose data it was
// moving. The link therefore has to be an explicit CLAIM — "this Square person is
// me" — and a claim needs proof, which is the piece deliberately left undone.
//
// Sketch of how that proof should work when it is built: the Square already knows
// who is who, so the cheap and correct version is a round trip through it rather
// than anything invented here — a one-time code shown in the Square to a signed-in
// person, pasted here, and verified back against it. No shared secret, no
// email-matching, no trusting a slug somebody typed.
//
// **The hard constraint on reading the Square's store**: `data/store.json` over
// there holds `messages`, `dms` and `groupMessages` — everybody's private
// conversations. Any bridge reads `people` and `customGroups` and NOTHING else,
// and it reads them read-only. This is the same data the trips agent sandbox
// goes out of its way to `--tmpfs` away; a convenience feature must not be the
// thing that walks it out of the building.
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

module.exports = { configured, available, readPeople, status, importable, storePath };
