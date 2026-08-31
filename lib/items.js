// THE gate. Everything entering the store passes through here, including
// anything a client made up and anything a future module contributes.
//
// A field this file doesn't know is silently dropped — which is the right
// behaviour and the usual trap: add a field HERE FIRST or a PATCH will appear to
// succeed and change nothing at all.
const spaces = require('./spaces');
const modules = require('./modules');

const TITLE_MAX = 200;
const NOTES_MAX = 2000;
const TAG_MAX = 24;
const MAX_TAGS = 8;

const str = (v, max) => String(v == null ? '' : v).slice(0, max).trim();

// Tags are lowercased and deduped so "Records" and "records" are one thing —
// otherwise a filter silently shows half of what it should.
function cleanTags(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const tag = str(t, TAG_MAX).toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
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
    notes: str(b.notes, NOTES_MAX) || null,
    // Default is `shared`, because the whole app is a list you keep WITH someone
    // and a default of private would quietly make it a diary.
    visibility: spaces.isVisibility(b.visibility) ? b.visibility : 'shared',
    tags: cleanTags(b.tags),
    mod: modules.cleanMods(b.mod),
    done: false,
    doneAt: null,
    doneBy: null,
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

module.exports = { TITLE_MAX, NOTES_MAX, TAG_MAX, MAX_TAGS, cleanItem, applyPatch, setDone, cleanTags };
