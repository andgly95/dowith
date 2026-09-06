// Groups within a list. PURE — no I/O, no store access.
//
// A group is NOT a container. It is the set of items carrying a tag, computed on
// the way out. That is the whole design and everything good about it follows:
//
//   · nothing to keep in sync, because there is nothing stored to drift
//   · a group cannot orphan itself, sit empty, or outlive its members
//   · an item can be in two groups honestly — "dinner and a film" is both
//   · deleting a group is untagging, so it can never eat the items inside it
//   · adding something stays one tap; there is no "where does this go?" at write
//     time, which is the tax folders charge and the reason lists go stale
//
// The same conclusion the trips app reached about note groups, for the same
// reason, and it is worth restating because folders are the obvious build and
// they are the wrong one.
//
// THE VIEWER MATTERS. Groups are derived from the items a particular person can
// see, so a tag that exists only on your private items makes a group on your
// screen and no group at all on theirs. That is not a quirk to work around — it
// is the correct behaviour, and it falls out for free as long as callers pass in
// an already-filtered list. See `visibleIn` in lib/spaces.js.

const UNGROUPED = 'Everything else';

// Two tags are the same tag if they fold the same. Matching is case- and
// space-insensitive; display keeps whatever was typed first.
const fold = (t) => String(t == null ? '' : t).trim().toLowerCase().replace(/\s+/g, ' ');

// Title for a group. The FIRST spelling seen wins and is used everywhere after,
// so `AFI` never becomes `Afi` and `films` never forks from `Films`.
function groupsOf(items) {
  const byKey = new Map();
  for (const it of items || []) {
    for (const tag of (it && it.tags) || []) {
      const key = fold(tag);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, { key, name: String(tag).trim(), items: [] });
      byKey.get(key).items.push(it);
    }
  }
  return [...byKey.values()]
    .map(g => ({
      key: g.key,
      name: g.name,
      count: g.items.length,
      open: g.items.filter(i => !i.done).length,
    }))
    // Biggest first, then alphabetically — a stable order that puts the group you
    // are most likely to want at the top without anybody maintaining one.
    .sort((a, b) => (b.open - a.open) || (b.count - a.count) || a.name.localeCompare(b.name));
}

// Items carrying a tag. `null` means the ones carrying none — which is a real
// bucket people use, not a leftover: plenty of things never want filing.
function inGroup(items, key) {
  if (key === null || key === undefined) {
    return (items || []).filter(it => !((it && it.tags) || []).some(t => fold(t)));
  }
  const want = fold(key);
  return (items || []).filter(it => ((it && it.tags) || []).some(t => fold(t) === want));
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
