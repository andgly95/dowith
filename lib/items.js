// THE gate. Everything entering the store passes through here, including
// anything a client made up and anything a future module contributes.
//
// A field this file doesn't know is silently dropped — which is the right
// behaviour and the usual trap: add a field HERE FIRST or a PATCH will appear to
// succeed and change nothing at all.
const spaces = require('./spaces');
const modules = require('./modules');
const kinds = require('./kinds');
const swap = require('./swap');

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
    // Whose idea it was, when that is not the author. Set only through setIdea,
    // behind SP.canCredit — never from a body at creation.
    ideaBy: null,
    // Book ahead, would you go back, what it was like. Set only through
    // setVisit — see below.
    visit: null,
    createdAt: now,
    updatedAt: now,
  };
}

// A patch. Only the fields a person is allowed to change, and never `authorId`,
// `spaceId`, `id` or `createdAt` — moving an item between spaces or reassigning
// its author are not edits, and quietly allowing them through a PATCH is how
// something ends up somewhere nobody meant it to be.
//
// `by` is who made the change, from the session — never the body. It matters
// once an admin can correct somebody else's item: the row still says it is
// Linnea's, so the record has to say whose hand was last on the wording.
function applyPatch(item, raw, now = Date.now(), by = null) {
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
  if (by) item.editedBy = by;
  item.updatedAt = now;
  return item;
}

// Whose idea it was. The route checks the right (SP.canCredit); this only
// records it. Crediting yourself clears it, so "the author's own idea" has one
// representation rather than two.
function setIdea(item, to, now = Date.now()) {
  item.ideaBy = to && to !== item.authorId ? to : null;
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

// The visit: the half of a place that is about the two of you rather than the
// place. `book` ("book ahead") is planning, so — like `when` — anyone who can
// see the item may set it. `again` ("would you go back?") and `memory` ("what
// was it like?") are the record, so — like `done` — the same people may, and
// only once it IS done; the route checks that, this only checks the values.
//
// Beside `when` rather than inside mod.place, because a place with no pin is
// still a place you can book ahead for, and mod.place is replaced wholesale by
// every save of the sheet. A PATCH cannot reach it.
//
// Returns null and changes nothing when a value is not one this knows.
const AGAIN = ['soon', 'maybe', 'once'];
function setVisit(item, raw, now = Date.now()) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const v = { book: false, again: null, memory: null, ...(item.visit || {}) };
  if (b.book !== undefined) {
    if (typeof b.book !== 'boolean') return null;
    v.book = b.book;
  }
  if (b.again !== undefined) {
    if (b.again !== null && !AGAIN.includes(b.again)) return null;
    v.again = b.again;
  }
  if (b.memory !== undefined) {
    if (b.memory !== null && typeof b.memory !== 'string') return null;
    v.memory = str(b.memory, NOTES_MAX) || null;
  }
  item.visit = v.book || v.again || v.memory ? v : null;
  item.updatedAt = now;
  return item;
}

// A swap: what goes in instead of one of a recipe's ingredients. Its own
// operation, beside `visit` and for the same reasons — anyone who can see the
// recipe may set one (deciding what to cook with is doing it together), `by`
// says whose it was, and a PATCH can neither set nor lose it. Keyed by the
// ingredient's index, and carrying that line's text (`of`), so a recipe read
// again cannot leave a swap pinned to the wrong line (swap.live drops it).
// `null` takes it off. Returns null when there is no such ingredient, or no
// `use`.
function setSwap(item, i, raw, by, now = Date.now()) {
  const ings = item.mod && item.mod.recipe && item.mod.recipe.ingredients;
  const ing = Number.isInteger(i) && ings ? ings[i] : null;
  if (!ing) return null;
  const sw = { ...(item.swaps && typeof item.swaps === 'object' ? item.swaps : {}) };
  if (raw === null) delete sw[i];
  else {
    const s = swap.cleanSwap(raw, ing);
    if (!s) return null;
    sw[i] = { ...s, of: ing.text, by, at: now };
  }
  item.swaps = Object.keys(sw).length ? sw : null;
  item.updatedAt = now;
  return item;
}

// Made it: the record of each time a recipe was cooked. Its own operation,
// like ticking off, and the same right — anyone who can see it — because
// making it is doing the thing together. Newest last, twenty kept.
const MAX_COOKED = 20;
function addCooked(item, raw, uid, now = Date.now()) {
  const b = raw && typeof raw === 'object' ? raw : {};
  if (b.again !== undefined && b.again !== null && !AGAIN.includes(b.again)) return null;
  if (b.tweaks !== undefined && b.tweaks !== null && typeof b.tweaks !== 'string') return null;
  const entry = { at: now, by: uid, again: b.again || null, tweaks: str(b.tweaks, 500) || null };
  item.cooked = [...(Array.isArray(item.cooked) ? item.cooked : []), entry].slice(-MAX_COOKED);
  item.updatedAt = now;
  return item;
}

module.exports = { TITLE_MAX, NOTES_MAX, TAG_MAX, MAX_TAGS, MAX_COOKED, AGAIN, cleanItem, applyPatch, setDone, setWhen, setIdea, setVisit, setSwap, addCooked, cleanWhen, cleanTags };
