// Groups within a list. PURE — no I/O, no store access.
//
// A group is NOT a container. It is the set of items of one KIND, computed on
// the way out. That is the whole design and everything good about it follows:
//
//   · nothing to keep in sync, because there is nothing stored to drift
//   · a group cannot orphan itself, sit empty, or outlive its members
//   · deleting a group is impossible; there is nothing there to delete
//   · adding something stays one tap; there is no "where does this go?" at write
//     time, which is the tax folders charge and the reason lists go stale
//
// ── Why kinds and not free-text tags ──────────────────────────────────────
//
// This used to group by `item.tags`, and the argument for that was real: tags
// overlap, they cost nothing to invent, and an item can honestly be in two of
// them. What settled it was the data. The tags actually in the live list were
// `Films` (5), `Shows` (2) and `Recipes` (2) — a fixed, non-overlapping
// vocabulary of what things ARE, typed by hand, three times, with nothing else
// in it. People were already using tags as kinds and paying for the privilege
// in typos and re-typing.
//
// So the vocabulary moved into `lib/kinds.js`, where it is a real enum with
// fields attached: a recipe has the link you cook from, a place has a location
// and belongs on the map. A tag could never carry that. The price is that a
// thing is one kind rather than several, which is the correct trade for a
// vocabulary this small and this factual — and extending it is one line.
//
// THE VIEWER MATTERS, unchanged. Groups are derived from the items a particular
// person can see, so a kind that exists only on your private items makes a
// group on your screen and no group at all on theirs. It falls out for free as
// long as callers pass an already-filtered list. See `visibleIn` in spaces.js.
const kinds = require('./kinds');

const UNGROUPED = 'Everything else';

// Kept because callers and tests still ask two names to match. Kind keys are
// already canonical, so this is now only a courtesy to whatever passes a label.
const fold = (t) => String(t == null ? '' : t).trim().toLowerCase().replace(/\s+/g, ' ');

// A plain `thing` is the absence of a kind, not a group of its own — it is the
// loose pile the UI lists underneath, the same place untagged items used to go.
const keyOf = (it) => {
  const k = kinds.clean(it && it.kind);
  return k === kinds.DEFAULT ? null : k;
};

// One group per kind present. `key` is the kind id and `name` its plural, which
// is what the rows already render — so the list looks exactly as it did.
//
// Table order, NOT biggest-first. With a fixed vocabulary the order is a fact
// about the app rather than about today's counts, and a row of groups that
// reshuffles under your finger every time something is ticked off is worse than
// one that never moves.
function groupsOf(items) {
  const byKey = new Map();
  for (const it of items || []) {
    const key = keyOf(it);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(it);
  }
  return kinds.KINDS
    .filter(k => byKey.has(k.id))
    .map(k => ({
      key: k.id,
      name: k.plural,
      count: byKey.get(k.id).length,
      open: byKey.get(k.id).filter(i => !i.done).length,
    }));
}

// Items of one kind. `null` means the loose ones — a real bucket people use,
// not a leftover: plenty of things are just things.
//
// Accepts the kind id or its label, because the client hands back whatever the
// row was named with and that should not be a thing anybody has to think about.
function inGroup(items, key) {
  if (key === null || key === undefined) {
    return (items || []).filter(it => keyOf(it) === null);
  }
  const want = kinds.isKind(key) ? key : kinds.fromTag(key);
  if (!want) return [];
  return (items || []).filter(it => keyOf(it) === want);
}

const ungroupedCount = (items) => inGroup(items, null).length;

// Is grouping worth showing at all? One group over a list of forty is noise, and
// a "group" holding every single item tells you nothing.
//
// The threshold is deliberately low — two groups, or one that does not swallow
// everything — because the alternative is hiding a feature until some arbitrary
// size, which is how nobody discovers it.
function worthGrouping(items) {
  const gs = groupsOf(items);
  if (!gs.length) return false;
  if (gs.length > 1) return true;
  return ungroupedCount(items) > 0;
}

module.exports = { UNGROUPED, fold, groupsOf, inGroup, ungroupedCount, worthGrouping };
