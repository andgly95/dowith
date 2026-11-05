// The pleasure inventory — what each of you likes, between the two of you.
//
// PURE, like spaces.js, because the rule here is the same kind of promise:
//
//   · It belongs to a PAIR OF PEOPLE, not to a list. Answers are keyed by the two
//     user ids, sorted, so if one of you leaves and somebody new joins that list,
//     the newcomer is a different pair and sees nothing. A list is a container
//     that can change hands; this must not change hands with it.
//   · Only a pair. A group list has no inventory at all — this is not a thing
//     you answer in front of three people.
//   · BODY answers are shown to your partner in full: that half exists to say
//     "this, not that", and an answer the other person cannot see says nothing.
//   · TO TRY answers are shown only where you BOTH lean yes (yes, please / yes /
//     maybe). Their "no" never reveals your "yes", which is what lets either of
//     you suggest something without it costing anything.
//   · It never leaves this file's two routes: no push, no digest, no third-party
//     lookup, nothing in /api/state.
//
// The catalogue is the server's, so the client keeps no second copy of the
// words and an answer to an id that does not exist is refused.

const LEVELS = [
  { id: 'love', label: 'Yes, please' },
  { id: 'yes', label: 'Yes' },
  { id: 'maybe', label: 'Maybe' },
  { id: 'soft', label: 'Soft no' },
  { id: 'no', label: 'No' },
];
const LEVEL_IDS = new Set(LEVELS.map(l => l.id));
// "Leaning yes" — what counts towards a match.
const WANT = new Set(['love', 'yes', 'maybe']);

const PARTS = [
  { id: 'lips', label: 'Lips' },
  { id: 'ears', label: 'Ears' },
  { id: 'neck', label: 'Neck' },
  { id: 'hair', label: 'Hair & scalp' },
  { id: 'shoulders', label: 'Shoulders' },
  { id: 'back', label: 'Back' },
  { id: 'chest', label: 'Chest' },
  { id: 'nipples', label: 'Nipples' },
  { id: 'stomach', label: 'Stomach' },
  { id: 'hips', label: 'Hips' },
  { id: 'butt', label: 'Butt' },
  { id: 'genitals', label: 'Genitals' },
  { id: 'thighs', label: 'Inner thighs' },
  { id: 'hands', label: 'Hands' },
  { id: 'feet', label: 'Feet' },
];

const ACTS = [
  { id: 'touch', label: 'Touching' },
  { id: 'kiss', label: 'Kissing' },
  { id: 'lick', label: 'Licking' },
  { id: 'bite', label: 'Biting' },
  { id: 'massage', label: 'Massage' },
  { id: 'scratch', label: 'Scratching' },
];

// Ordered gentlest first, so the first thing anybody is asked is an easy one.
const GROUPS = [
  { id: 'gentle', label: 'Gentle' },
  { id: 'playful', label: 'Playful' },
  { id: 'adventurous', label: 'Adventurous' },
  { id: 'yours', label: 'Your own' },
];

const TRY = [
  { id: 'massage-oil', label: 'A massage with oil', group: 'gentle' },
  { id: 'shower', label: 'Showering together', group: 'gentle' },
  { id: 'morning', label: 'Morning sex', group: 'gentle' },
  { id: 'slow', label: 'Very slow, all evening', group: 'gentle' },
  { id: 'sexting', label: 'Sexting during the day', group: 'gentle' },
  { id: 'toy-shop', label: 'Shopping for toys together', group: 'gentle' },
  { id: 'erotica', label: 'Watching or reading erotica together', group: 'gentle' },
  { id: 'quickie', label: 'A quickie', group: 'playful' },
  { id: 'tease', label: 'Teasing — making you wait', group: 'playful' },
  { id: 'lingerie', label: 'Lingerie', group: 'playful' },
  { id: 'dirty-talk', label: 'Dirty talk', group: 'playful' },
  { id: 'blindfold', label: 'Blindfolds', group: 'playful' },
  { id: 'roleplay', label: 'Role play', group: 'playful' },
  { id: 'toys', label: 'Toys', group: 'playful' },
  { id: 'oral-give', label: 'Giving oral', group: 'playful' },
  { id: 'oral-get', label: 'Receiving oral', group: 'playful' },
  { id: 'mutual', label: 'Touching ourselves together', group: 'playful' },
  { id: 'mirror', label: 'In front of a mirror', group: 'playful' },
  { id: 'new-position', label: 'A position we have never tried', group: 'playful' },
  { id: 'new-place', label: 'Somewhere other than the bed', group: 'playful' },
  { id: 'tied', label: 'Being tied up', group: 'adventurous' },
  { id: 'tying', label: 'Tying you up', group: 'adventurous' },
  { id: 'temperature', label: 'Ice or warm wax', group: 'adventurous' },
  { id: 'spanking', label: 'Spanking', group: 'adventurous' },
  { id: 'hair-pull', label: 'Hair pulling', group: 'adventurous' },
  { id: 'photos', label: 'Taking photos for each other', group: 'adventurous' },
  { id: 'anal', label: 'Anal play', group: 'adventurous' },
];

const PART_IDS = new Set(PARTS.map(p => p.id));
const ACT_IDS = new Set(ACTS.map(a => a.id));
const TRY_IDS = new Set(TRY.map(t => t.id));

const pairKey = (a, b) => [String(a), String(b)].sort().join('|');

// Things either of you added yourselves live in the pair's book under this key.
// A user id never starts with '#', so it cannot collide with a person's sheet.
const CUSTOM = '#custom';
const CUSTOM_MAX = 40;
const LABEL_MAX = 80;

// One answer at a time, refused unless every id is in the catalogue. `level`
// null clears it — changing your mind has to be possible, including to "no
// answer".
function clean(raw, customIds = new Set()) {
  if (!raw || typeof raw !== 'object') return null;
  const level = raw.level === null ? null : LEVEL_IDS.has(raw.level) ? raw.level : undefined;
  if (level === undefined) return null;
  if (raw.kind === 'body' && PART_IDS.has(raw.part) && ACT_IDS.has(raw.act)) {
    return { kind: 'body', part: raw.part, act: raw.act, level };
  }
  if (raw.kind === 'try' && typeof raw.id === 'string' && (TRY_IDS.has(raw.id) || customIds.has(raw.id))) {
    return { kind: 'try', id: raw.id, level };
  }
  return null;
}

const blank = () => ({ body: {}, try: {}, updatedAt: null });

// Write one cleaned answer into one person's sheet.
function apply(sheet, c, now = Date.now()) {
  const s = sheet || blank();
  if (c.kind === 'body') {
    const part = { ...(s.body[c.part] || {}) };
    if (c.level) part[c.act] = c.level; else delete part[c.act];
    if (Object.keys(part).length) s.body[c.part] = part; else delete s.body[c.part];
  } else if (c.level) s.try[c.id] = c.level;
  else delete s.try[c.id];
  s.updatedAt = now;
  return s;
}

// What one of you is allowed to see. THE gate for this feature — the routes
// send this and nothing else, and the partner's `try` answers never appear in
// it except as matches.
//
// Your own items: the QUESTION is shared — your partner has to see it to answer
// it — but who asked is only told to the asker (`byMe`), and the answers follow
// exactly the same matches-only rule as everything else on the list.
function view(mine, theirs, custom = [], uid = null) {
  const m = mine || blank(), t = theirs || blank();
  const own = (custom || []).map(c => ({ id: c.id, label: c.label, group: 'yours', byMe: c.by === uid }));
  const matches = [...TRY, ...own]
    .filter(x => WANT.has(m.try[x.id]) && WANT.has(t.try[x.id]))
    .map(x => ({ id: x.id, mine: m.try[x.id], theirs: t.try[x.id] }));
  return {
    mine: { body: m.body, try: m.try },
    theirs: { body: t.body },
    custom: own,
    matches,
  };
}

const customIds = (book) => new Set(((book && book[CUSTOM]) || []).map(c => c.id));

// Add a question of your own to the pair's list. Null if it is empty, too many,
// or already there (in the catalogue or among yours) — asking twice is noise.
function addCustom(book, uid, raw, now = Date.now()) {
  const label = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
  if (!label) return null;
  const list = book[CUSTOM] || (book[CUSTOM] = []);
  if (list.length >= CUSTOM_MAX) return null;
  const key = label.toLowerCase();
  if ([...TRY, ...list].some(x => x.label.toLowerCase() === key)) return null;
  const c = { id: `c-${require('crypto').randomBytes(5).toString('hex')}`, label, by: uid, at: now };
  list.push(c);
  return c;
}

// Only whoever asked can take a question back, and it takes both answers with it.
function removeCustom(book, uid, id) {
  const list = book[CUSTOM] || [];
  const i = list.findIndex(c => c.id === id && c.by === uid);
  if (i < 0) return false;
  list.splice(i, 1);
  for (const [k, sheet] of Object.entries(book)) {
    if (k !== CUSTOM && sheet && sheet.try) delete sheet.try[id];
  }
  return true;
}

const catalogue = () => ({ levels: LEVELS, parts: PARTS, acts: ACTS, try: TRY, groups: GROUPS });

module.exports = {
  LEVELS, PARTS, ACTS, TRY, GROUPS, WANT, CUSTOM, pairKey, clean, apply, view, catalogue, blank,
  customIds, addCustom, removeCustom,
};
