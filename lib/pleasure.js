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

const TRY = [
  { id: 'massage-oil', label: 'A massage with oil' },
  { id: 'shower', label: 'Showering together' },
  { id: 'morning', label: 'Morning sex' },
  { id: 'slow', label: 'Very slow, all evening' },
  { id: 'quickie', label: 'A quickie' },
  { id: 'tease', label: 'Teasing — making you wait' },
  { id: 'lingerie', label: 'Lingerie' },
  { id: 'dirty-talk', label: 'Dirty talk' },
  { id: 'sexting', label: 'Sexting during the day' },
  { id: 'blindfold', label: 'Blindfolds' },
  { id: 'tied', label: 'Being tied up' },
  { id: 'tying', label: 'Tying you up' },
  { id: 'temperature', label: 'Ice or warm wax' },
  { id: 'spanking', label: 'Spanking' },
  { id: 'hair-pull', label: 'Hair pulling' },
  { id: 'roleplay', label: 'Role play' },
  { id: 'toys', label: 'Toys' },
  { id: 'toy-shop', label: 'Shopping for toys together' },
  { id: 'oral-give', label: 'Giving oral' },
  { id: 'oral-get', label: 'Receiving oral' },
  { id: 'mutual', label: 'Touching ourselves together' },
  { id: 'mirror', label: 'In front of a mirror' },
  { id: 'new-position', label: 'A position we have never tried' },
  { id: 'new-place', label: 'Somewhere other than the bed' },
  { id: 'erotica', label: 'Watching or reading erotica together' },
  { id: 'photos', label: 'Taking photos for each other' },
  { id: 'anal', label: 'Anal play' },
];

const PART_IDS = new Set(PARTS.map(p => p.id));
const ACT_IDS = new Set(ACTS.map(a => a.id));
const TRY_IDS = new Set(TRY.map(t => t.id));

const pairKey = (a, b) => [String(a), String(b)].sort().join('|');

// One answer at a time, refused unless every id is in the catalogue. `level`
// null clears it — changing your mind has to be possible, including to "no
// answer".
function clean(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const level = raw.level === null ? null : LEVEL_IDS.has(raw.level) ? raw.level : undefined;
  if (level === undefined) return null;
  if (raw.kind === 'body' && PART_IDS.has(raw.part) && ACT_IDS.has(raw.act)) {
    return { kind: 'body', part: raw.part, act: raw.act, level };
  }
  if (raw.kind === 'try' && TRY_IDS.has(raw.id)) return { kind: 'try', id: raw.id, level };
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
function view(mine, theirs) {
  const m = mine || blank(), t = theirs || blank();
  const matches = TRY
    .filter(x => WANT.has(m.try[x.id]) && WANT.has(t.try[x.id]))
    .map(x => ({ id: x.id, mine: m.try[x.id], theirs: t.try[x.id] }));
  return {
    mine: { body: m.body, try: m.try },
    theirs: { body: t.body },
    matches,
  };
}

const catalogue = () => ({ levels: LEVELS, parts: PARTS, acts: ACTS, try: TRY });

module.exports = { LEVELS, PARTS, ACTS, TRY, WANT, pairKey, clean, apply, view, catalogue, blank };
