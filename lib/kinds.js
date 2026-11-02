// What a thing IS. PURE — no I/O, no store access.
//
// A list of "things to do with someone" is not homogeneous. "Watch Obsession",
// "Go to that ramen bar", "Make the ragù from the NYT" and "Go swing dancing"
// are four different shapes of plan, and flattening them into one row with a
// title was fine at ten items and stops being fine at a hundred: you cannot see
// what you have, and a recipe without its link is a reminder that you once saw
// a recipe.
//
// ── Why a kind and not another tag ────────────────────────────────────────
//
// `groups.js` is emphatic that a group is a tag and nothing more, and that is
// still right — "rainy day" and "cheap" are opinions, they overlap, and they
// belong to whoever typed them. A KIND is not an opinion. A film has a year and
// somewhere to watch it; a place has a location and belongs on the map; a
// recipe has a link you will actually open while standing in a kitchen. Those
// are facts about the thing, they are mutually exclusive, and they decide which
// fields are worth showing. A tag cannot do that job and should not be asked to.
//
// So the two live side by side and do different work: a film can be tagged
// "rainy day", and the tag makes a group while the kind makes it a film.
//
// ── A kind suggests; it never confiscates ─────────────────────────────────
//
// `mods` is what the editor OFFERS for a kind, not what the item is permitted
// to carry. Seeing a film at the AFI is a film with a place on it, and changing
// a thing's kind must never silently delete something you typed. Nothing in
// here drops a module slice — the gate keeps every slice that `modules.js`
// recognises, whatever kind the item claims to be.
const KINDS = [
  // `thing` is first and is the default, so the app a person already had keeps
  // working exactly as it did and nobody is made to classify anything.
  //
  // It offers BOTH optional fields, which is the whole reason it is the
  // default rather than the emptiest kind: before kinds existed every item
  // could carry a place and a link, and a default that quietly took both away
  // would make classifying compulsory to get back what you already had. It
  // leads with neither — an unclassified thing has no obvious point.
  { id: 'thing', label: 'Thing', plural: 'Things', mods: ['place', 'link'], go: 'Link' },
  { id: 'movie', label: 'Film', plural: 'Films', mods: ['link'], go: 'Watch' },
  { id: 'show', label: 'Show', plural: 'Shows', mods: ['link'], go: 'Watch' },
  // The one that was already half-built: `place` has been a module since the
  // seam existed, and the map tab is a renderer over items carrying one.
  { id: 'place', label: 'Place', plural: 'Places', mods: ['place'], go: 'Link' },
  // The link is the whole point of a recipe. You do not cook from a title.
  { id: 'recipe', label: 'Recipe', plural: 'Recipes', mods: ['link'], go: 'Cook' },
];

// `go` is what the LINK is for, and it is deliberately never the same word as
// the badge beside it. The first version used the label for both, so a show
// rendered "SHOW" twice in a row — once as what it is and once as a button —
// which reads as a bug even though both were correct.

const DEFAULT = 'thing';
const byId = new Map(KINDS.map(k => [k.id, k]));

const isKind = (v) => byId.has(v);

// Anything unrecognised becomes a plain thing rather than being refused. A kind
// is a convenience; losing an item because a client sent a word this server has
// not heard of would be the tail wagging the dog.
const clean = (v) => (isKind(v) ? v : DEFAULT);

// Which module slices this kind puts in front of you. Order matters — it is the
// order the editor shows them in, and for a recipe the link comes first.
const modsFor = (id) => (byId.get(id) || byId.get(DEFAULT)).mods;

// Does this kind lead with a link? Used to label the field "Recipe link" rather
// than "Link", and to render the row's action as something worth tapping.
const leadsWithLink = (id) => modsFor(id)[0] === 'link';

// How many of each, over whatever list the viewer can actually see. Used to
// decide whether a filter is worth showing at all: a list of twelve plain
// things should not grow a row of chips that all say the same thing.
function counts(items) {
  const out = new Map(KINDS.map(k => [k.id, 0]));
  for (const it of items || []) {
    const k = clean(it && it.kind);
    out.set(k, out.get(k) + 1);
  }
  return out;
}

// The kinds actually present, in table order, with their counts. Empty kinds
// are left out — a filter for a kind you own none of is a dead control.
function present(items) {
  const n = counts(items);
  return KINDS.filter(k => n.get(k.id) > 0)
    .map(k => ({ id: k.id, label: k.label, plural: k.plural, count: n.get(k.id) }));
}

// Is a filter row worth the space? Only once the list is genuinely mixed. One
// kind is not a choice, and a control offering no choice is noise.
const worthFiltering = (items) => present(items).length > 1;

const inKind = (items, id) => (items || []).filter(it => clean(it && it.kind) === id);

// What the client is told exists. Ids and labels only; the rules stay here.
const manifest = () => KINDS.map(k =>
  ({ id: k.id, label: k.label, plural: k.plural, mods: k.mods, go: k.go }));

module.exports = {
  KINDS, DEFAULT, isKind, clean, modsFor, leadsWithLink,
  counts, present, worthFiltering, inKind, manifest,
};
