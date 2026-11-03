// THE gate. Everything entering the store passes through here, including
// anything a client made up and anything a future module contributes.
//
// A field this file doesn't know is silently dropped — which is the right
// behaviour and the usual trap: add a field HERE FIRST or a PATCH will appear to
// succeed and change nothing at all.
const spaces = require('./spaces');
const modules = require('./modules');
const kinds = require('./kinds');

const TITLE_MAX = 200;
const NOTES_MAX = 2000;
const TAG_MAX = 24;
const MAX_TAGS = 8;

const str = (v, max) => String(v == null ? '' : v).slice(0, max).trim();

// Deduped by FOLD but stored as typed. "Records" and "records" are one tag, so a
// filter can never show half of what it should — but the first spelling wins and
// is what gets displayed, so `AFI` does not come back as `Afi`.
//
// Same rule as the trips app's note groups, for the same reason: matching and
// display are different jobs, and folding for display throws away information the
// person deliberately typed.
function cleanTags(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const tag = str(t, TAG_MAX).replace(/\s+/g, ' ');
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// A new item. `authorId` and `spaceId` come from the CALLER, never from the body:
// the route resolves them from the session and the membership check, so there is
// no request shape that lets you write into somebody else's space or sign an item
// with their name.
function cleanItem(raw, { id, authorId, spaceId, now = Date.now() }) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const title = str(b.title, TITLE_MAX);
  if (!title) return null;
  return {
    id,
    spaceId,
    authorId,
    title,
    // WHAT IT IS — a film, a show, a place, a recipe, or just a thing. Separate
    // from tags on purpose: a tag is an opinion you typed, a kind is a fact
    // about the item that decides which fields are worth showing. See kinds.js.
    kind: kinds.clean(b.kind),
    notes: str(b.notes, NOTES_MAX) || null,
    // Default is `shared`, because the whole app is a list you keep WITH someone
    // and a default of private would quietly make it a diary.
    visibility: spaces.isVisibility(b.visibility) ? b.visibility : 'shared',
    tags: cleanTags(b.tags),
    mod: modules.cleanMods(b.mod),
    done: false,
    doneAt: null,
    doneBy: null,
    when: null,
    plannedBy: null,
    createdAt: now,
    updatedAt: now,
  };
}

// A patch. Only the fields a person is allowed to change, and never `authorId`,
// `spaceId`, `id` or `createdAt` — moving an item between spaces or reassigning
// its author are not edits, and quietly allowing them through a PATCH is how
// something ends up somewhere nobody meant it to be.
function applyPatch(item, raw, now = Date.now()) {
  const b = raw && typeof raw === 'object' ? raw : {};
  if (b.title !== undefined) {
    const title = str(b.title, TITLE_MAX);
    if (!title) return null;                 // a nameless item is not an item
    item.title = title;
  }
  // Changing the kind never confiscates a slice. Seeing a film at the AFI is a
  // film with a place on it, and an edit that silently deleted the address you
  // typed because you reclassified the row would be unforgivable.
  if (b.kind !== undefined) item.kind = kinds.clean(b.kind);
  if (b.notes !== undefined) item.notes = str(b.notes, NOTES_MAX) || null;
  if (b.visibility !== undefined && spaces.isVisibility(b.visibility)) item.visibility = b.visibility;
  if (b.tags !== undefined) item.tags = cleanTags(b.tags);
  if (b.mod !== undefined) item.mod = modules.cleanMods(b.mod);
  item.updatedAt = now;
  return item;
}

// Ticking it off is its own operation, not a patch, because WHO did it is part of
// the record — "Linnea ticked off record shopping" is the nice bit.
function setDone(item, done, uid, now = Date.now()) {
  item.done = !!done;
  item.doneAt = item.done ? now : null;
  item.doneBy = item.done ? uid : null;
  item.updatedAt = now;
  return item;
}

// WHEN you mean to do it. A CALENDAR DATE, not an instant: "Saturday" is the
// same Saturday for both of you, and storing a timestamp would make it a
// different day for anyone in another timezone — or for the server, which runs
// in UTC. So a date string, an optional wall-clock time, and no zone at all.
//
// Refused rather than repaired: 2026-02-30 is not "roughly March", and a plan
// silently moved to a day nobody chose is worse than no plan.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function cleanWhen(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const m = DATE_RE.exec(String(raw.date || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  const time = TIME_RE.test(String(raw.time || '')) ? String(raw.time) : null;
  return { date: m[0], time };
}

// Scheduling is its own operation, like ticking off, and for the same reason:
// it is a right of ANYONE WHO CAN SEE the item, not just its author. Picking a
// day is part of doing the thing together — "Linnea planned Baltimore for
// Saturday" — and who planned it is part of the record. A PATCH cannot set it.
// `null` clears it; anything the gate refuses returns null and changes nothing.
function setWhen(item, raw, uid, now = Date.now()) {
  if (raw === null) {
    item.when = null;
    item.plannedBy = null;
  } else {
    const w = cleanWhen(raw);
    if (!w) return null;
    item.when = w;
    item.plannedBy = uid;
  }
  item.updatedAt = now;
  return item;
}

module.exports = { TITLE_MAX, NOTES_MAX, TAG_MAX, MAX_TAGS, cleanItem, applyPatch, setDone, setWhen, cleanWhen, cleanTags };
