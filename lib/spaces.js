// Who can see what. PURE — no I/O, no store access — and the most important file
// here, because every other rule in the app is a convenience and this one is the
// promise: a private thing stays private.
//
// The shape of the app in one paragraph. A SPACE holds people. Usually two — you
// and Linnea — and then it needs no name, because from your side it is "Linnea"
// and from hers it is "Andrew". The same list, labelled by whoever you aren't.
// With three or more it gets a name of its own ("Ski trip crew"), because
// "to do with Sam, Alex, Jo and 3 others" is not a title.
//
// An ITEM lives in the space it was written in and carries a visibility:
//
//   private   only the person who wrote it
//   shared    everyone in that space
//   public    everyone who shares ANY space with the author
//
// `public` is the interesting one and it is deliberately not a feed. It means "a
// standing wish, for anyone of mine who wants to pick it up" — I want to see this
// band, and whoever sees it first can say let's go. So a public item surfaces in
// every space its author belongs to, not just its home. No strangers, ever: the
// audience is the union of your spaces and nothing wider.

const VISIBILITIES = ['private', 'shared', 'public'];
const NAME_MAX = 60;
const MAX_MEMBERS = 25;

const isVisibility = (v) => VISIBILITIES.includes(v);

/* ── membership ─────────────────────────────────────────────────────────── */

const memberIds = (space) => (space && Array.isArray(space.memberIds)) ? space.memberIds : [];
const isMember = (space, uid) => memberIds(space).includes(uid);

// Every space this person belongs to.
const spacesOf = (spaces, uid) => (spaces || []).filter(s => isMember(s, uid));

// Everyone who shares at least one space with this person — their audience for a
// public item, and the whole of it. Excludes themselves.
function circleOf(spaces, uid) {
  const out = new Set();
  for (const s of spacesOf(spaces, uid)) for (const m of memberIds(s)) if (m !== uid) out.add(m);
  return out;
}

// Do these two share a space? The membership test that `public` rests on.
const share = (spaces, a, b) => (spaces || []).some(s => isMember(s, a) && isMember(s, b));

/* ── visibility ─────────────────────────────────────────────────────────── */

// THE rule. Everything that renders an item, over the wire or otherwise, asks
// this and nothing else.
//
// Note what is NOT here: being a member of an item's space is not sufficient on
// its own, because a private item written in that space is still nobody's
// business. Authorship is checked first for exactly that reason.
function canSee(item, uid, spaces) {
  if (!item || !uid) return false;
  if (item.authorId === uid) return true;                 // your own, always
  const space = (spaces || []).find(s => s.id === item.spaceId);

  switch (item.visibility) {
    case 'private':
      return false;                                        // author only, full stop
    case 'shared':
      return !!space && isMember(space, uid) && isMember(space, item.authorId);
    case 'public':
      // Anyone who shares any space with the author. The item's own space is
      // irrelevant — that is what makes it a standing wish rather than a post.
      return share(spaces, item.authorId, uid);
    default:
      // An unknown visibility is treated as the most restrictive thing it could
      // be. A typo must never widen an audience.
      return false;
  }
}

// Can this person change or delete it? Narrower than seeing it, and deliberately
// not "anyone in the space": a shared list is a shared list, but the sentence is
// still yours. Ticking something OFF is separate — see canComplete.
const canEdit = (item, uid) => !!item && item.authorId === uid;

// Anyone who can see a shared or public item can tick it done, because doing the
// thing is the point and whoever got there first should be able to say so. A
// private item is only ever the author's to complete.
const canComplete = (item, uid, spaces) =>
  canSee(item, uid, spaces) && (item.visibility !== 'private' || item.authorId === uid);

/* ── what a space is called ─────────────────────────────────────────────────
   From your side, never in the abstract. A pair is named after the other person;
   a group carries its own name and falls back to listing people. */

function titleFor(space, uid, nameOf) {
  const who = memberIds(space).filter(m => m !== uid);
  const name = (id) => (nameOf ? nameOf(id) : id) || 'Someone';
  if (space && space.name) return space.name;
  if (!who.length) return 'Just you';
  if (who.length === 1) return name(who[0]);
  if (who.length === 2) return `${name(who[0])} and ${name(who[1])}`;
  return `${name(who[0])}, ${name(who[1])} and ${who.length - 2} more`;
}

// A pair needs no name and should not be asked for one; a group should.
const isPair = (space) => memberIds(space).length === 2;

/* ── the items one person sees in one space ─────────────────────────────────
   A space shows what was written there AND the standing wishes of everyone in
   it — which is how a public item you wrote with Linnea reaches Sam. */

function visibleIn(items, space, uid, spaces) {
  if (!space || !isMember(space, uid)) return [];
  const members = new Set(memberIds(space));
  return (items || []).filter((it) => {
    if (!canSee(it, uid, spaces)) return false;
    if (it.spaceId === space.id) return true;
    // From elsewhere: only a public wish, and only from someone in this room.
    return it.visibility === 'public' && members.has(it.authorId);
  });
}

module.exports = {
  VISIBILITIES, NAME_MAX, MAX_MEMBERS,
  isVisibility, memberIds, isMember, spacesOf, circleOf, share,
  canSee, canEdit, canComplete, titleFor, isPair, visibleIn,
};
