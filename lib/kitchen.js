// Kitchens: one pantry and one shopping list per PERSON. PURE — no I/O, no
// store — like lib/spaces.js, and for the same reason: who may open someone's
// kitchen is a new audience, and an audience gets one tested rule.
//
// A kitchen is somebody's home. It is not on a list, it is not shared with a
// group, and it does not follow an item around. So the rule is narrow on
// purpose: yourself, and anyone you keep a PAIR list with. Starting narrow is
// cheap to widen later; widening by accident is a disclosure.

const SP = require('./spaces');

const STATES = ['have', 'low', 'out'];
const MAX_PANTRY = 400;
const MAX_BUY = 200;
const NAME_MAX = 80;

/* ── who may open a kitchen ─────────────────────────────────────────────── */

// THE rule. True for your own kitchen and for someone you share a pair space
// with; false for everybody else — including people you only share a GROUP
// list with, who know you from the ski trip, not from your fridge.
function canUse(viewerId, ownerId, spaces) {
  if (!viewerId || !ownerId) return false;
  if (viewerId === ownerId) return true;
  return (spaces || []).some(s => SP.isPair(s) && SP.isMember(s, viewerId) && SP.isMember(s, ownerId));
}

// Whose kitchens this person may open: their own first, then pair partners.
function kitchensFor(uid, spaces) {
  const out = [uid];
  for (const s of spaces || []) {
    if (!SP.isPair(s) || !SP.isMember(s, uid)) continue;
    for (const m of SP.memberIds(s)) if (m !== uid && !out.includes(m)) out.push(m);
  }
  return out;
}

/* ── what a thing IS, for matching ──────────────────────────────────────── */

// Words that say how it is cut or how big it is, not what it is. "2 large
// boneless chicken thighs, diced" and "chicken thighs" are the same thing in a
// fridge.
const PREP = new Set(('chopped minced diced sliced grated shredded crushed softened melted divided '
  + 'boneless skinless large medium small finely roughly thinly coarsely freshly peeled seeded '
  + 'trimmed halved quartered cubed packed heaping level room temperature cold-pressed').split(' '));
// How it comes, not what it is: "3 garlic cloves" is garlic, and a pantry that
// has garlic has it. (Not "fillet" or "breast" — those ARE the thing.)
const MEASURE = new Set('clove sprig stalk bunch can jar package packet piece slice stick wedge cube pinch dash handful'.split(' '));
const PHRASES = [/\bto taste\b/g, /\bto serve\b/g, /\bfor serving\b/g, /\bfor garnish\b/g, /\bas needed\b/g, /\bplus more\b.*$/g, /\bor more\b.*$/g];

function singular(w) {
  if (w.length <= 3) return w;
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(tomato|potato|mango|hero)es$/.test(w)) return w.slice(0, -2);
  if (/ves$/.test(w) && !/(olives|chives|cloves|eaves)$/.test(w)) return `${w.slice(0, -3)}f`;
  if (/(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

const nameWords = (s) => s.replace(/-/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w && !PREP.has(w));

// "Chicken thighs" and "boneless chicken thighs" land on the same key.
function key(name) {
  let s = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  // Up to the first comma that ends the NAME: in "large boneless, skinless
  // chicken thighs" the commas are between describing words.
  const parts = s.split(',');
  let upto = 1;
  while (upto < parts.length && !nameWords(parts.slice(0, upto).join(' ')).length) upto++;
  s = parts.slice(0, upto).join(' ');
  for (const re of PHRASES) s = s.replace(re, ' ');
  s = s.replace(/-/g, ' ').replace(/[^a-z\s]/g, ' ');
  const ws = s.split(/\s+/).filter(w => w && !PREP.has(w)).map(singular);
  while (ws.length > 1 && MEASURE.has(ws[ws.length - 1])) ws.pop();
  return ws.join(' ').trim();
}

const words = (k) => k.split(' ').filter(Boolean);

// Every word of a SENTENCE, singular — for "which ingredients does this step
// mention". Not key(): a key is an ingredient's name and stops at the first
// comma, which in a step throws away everything after "heavy cream,".
function wordList(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/-/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).map(singular);
}
const wordsOf = (text) => new Set(wordList(text));
const head = (k) => { const w = words(k); return w[w.length - 1] || ''; };

// Every word of one in the other, and the same head noun: "olive oil" is in
// "extra-virgin olive oil", and "chicken broth" is never "chicken thighs".
function within(entryKey, ingKey) {
  if (!entryKey || !ingKey) return false;
  if (head(entryKey) !== head(ingKey)) return false;
  const have = new Set(words(ingKey));
  return words(entryKey).every(w => have.has(w));
}

// What a label PROMISES: "gluten free", "dairy free", "vegan". For somebody who
// cannot eat gluten, gluten-free puff pastry is not the puff pastry in the
// freezer — so an ingredient that promises something is covered only by an
// entry that promises it too. The other way round is fine: gluten-free flour
// is flour, and a kitchen that cooks gluten free has "flour" for any recipe.
const PROMISE = new Set(['vegan', 'gf']);
const isFree = (w, j) => j > 0 && w[j] === 'free';
function promises(k) {
  const w = words(k);
  return w.flatMap((x, j) => (isFree(w, j) ? [`${w[j - 1]} free`] : PROMISE.has(x) ? [x] : []));
}
const plainWords = (k) => { const w = words(k); return w.filter((x, j) => !(isFree(w, j) || isFree(w, j + 1) || PROMISE.has(x))); };

// A pantry entry covers an ingredient when they share a head noun, every word
// of the entry (bar what it promises) is in the ingredient, and it keeps every
// promise the ingredient makes.
function covers(entryKey, ingKey) {
  if (!entryKey || !ingKey) return false;
  if (head(entryKey) !== head(ingKey)) return false;
  const have = new Set(words(ingKey));
  if (!plainWords(entryKey).every(w => have.has(w))) return false;
  const kept = new Set(promises(entryKey));
  return promises(ingKey).every(p => kept.has(p));
}

// Always in a kitchen unless it says otherwise.
const WATER = new Set(['water', 'cold', 'warm', 'hot', 'ice', 'boiling', 'lukewarm', 'tap']);
const STAPLE = new Set(['salt', 'kosher', 'sea', 'table', 'fine', 'coarse', 'flaky', 'and', 'black', 'pepper', 'ground', 'freshly']);
function isWater(k) { const w = words(k); return w.includes('water') && w.every(x => WATER.has(x)); }
function isStaple(k) {
  const w = words(k);
  if (!w.length || !w.every(x => STAPLE.has(x))) return false;
  return w.includes('salt') || (w.includes('pepper') && (w.includes('black') || w.length === 1));
}

const entries = (pantry) => Object.entries(pantry || {}).map(([k, v]) => ({ key: k, ...v }));

// A line that offers a choice — "gluten free flour or cornstarch", "butter or
// margarine" — and its options, or [] when it offers none. "1 or 2 cloves" is
// a range, and "or more" / "to taste" are not choices. "chicken or vegetable
// broth" means two broths: when the last option ends in a common base noun, or
// an earlier one is a bare describing word ("fresh or frozen peas"), that bare
// word takes the rest of the last option ("red or white wine vinegar" → "red
// wine vinegar"). Only ever a label to choose from: the recipe's own words
// still go wherever a judgement is made.
const NOT_A_CHOICE = /^(?:(?:more|less|so)\b.*|two|three|four|as needed|to taste|until\b.*)$/i;
const SHARED_NOUN = new Set('broth stock oil vinegar sugar flour milk cheese wine beans rice onion onions juice cream'.split(' '));
const DESCRIBING = new Set('fresh frozen dried canned tinned raw cooked white brown red green yellow black light dark whole skim unsalted salted sweet smoked plain'.split(' '));
function alternatives(name) {
  const s = String(name || '');
  if (!/\bor\b/i.test(s)) return [];
  let parts = s.split(/\s*,\s*(?:(?:and\/)?or\s+)?|\s+(?:and\/)?or\s+/i).map(p => p.replace(/^[\s;]+|[\s;.]+$/g, '').trim())
    .filter(p => /[a-z]/i.test(p) && !NOT_A_CHOICE.test(p));
  if (parts.length < 2) return [];
  const last = parts[parts.length - 1].split(/\s+/);
  const rest = last.slice(1).join(' ');
  const noun = last[last.length - 1].toLowerCase();
  if (last.length > 1) {
    parts = parts.map((p, i) => (i < parts.length - 1 && !/\s/.test(p)
      && (SHARED_NOUN.has(noun) || DESCRIBING.has(p.toLowerCase())) ? `${p} ${rest}` : p));
  }
  return parts.slice(0, 4);
}

// One boolean per ingredient: does this kitchen have it? NO MATCH MEANS NEED —
// a false "you have it" costs a trip to the shop, a false "you need it" costs
// one tap. A line offering a choice is had when any of its options is.
function match(ingredients, pantry) {
  const es = entries(pantry);
  const has = (name) => {
    const k = key(name || '');
    if (!k) return false;
    if (isWater(k)) return true;
    // Out beats a staple: if the pantry says you are out of salt, you are —
    // and "salt and pepper to taste" needs salt too, though its last word is
    // pepper, so for a staple any Out entry it names counts.
    const named = new Set(words(k));
    if (es.some(e => e.state === 'out' && (covers(e.key, k) || (isStaple(k) && words(e.key).every(w => named.has(w)))))) return false;
    if (isStaple(k)) return true;
    return es.some(e => (e.state === 'have' || e.state === 'low') && covers(e.key, k));
  };
  return (ingredients || []).map((ing) => {
    const name = (ing && (ing.name || ing.text)) || '';
    const alts = alternatives(name);
    return alts.length ? alts.some(has) : has(name);
  });
}

/* ── aisles ─────────────────────────────────────────────────────────────── */

// A small table. A wrong aisle is cosmetic, so this is short and obvious
// rather than complete.
const AISLES = [
  ['Produce', 'garlic onion shallot lemon lime orange apple banana basil parsley cilantro mint thyme rosemary sage dill chive scallion leek tomato potato carrot celery spinach kale lettuce arugula cucumber zucchini squash pepper mushroom ginger avocado berry strawberry blueberry herb cabbage broccoli cauliflower corn pea bean asparagus eggplant'],
  ['Fridge and freezer', 'chicken beef pork lamb turkey bacon sausage fish salmon shrimp egg butter milk cream cheese parmesan mozzarella ricotta yogurt tofu ham prosciutto pancetta'],
  ['Spices', 'salt cumin paprika cinnamon nutmeg oregano flake powder chili turmeric coriander clove cardamom bay seasoning allspice cayenne'],
  ['Cupboard', 'broth stock flour rice oil vinegar sugar pasta noodle can wine honey mustard sauce lentil chickpea oat breadcrumb panko cornstarch yeast baking cocoa chocolate nut almond walnut tomato-paste'],
].map(([aisle, list]) => [aisle, new Set(list.split(' '))]);
const AISLE_ORDER = ['Produce', 'Fridge and freezer', 'Cupboard', 'Spices', 'Other'];

function aisleOf(name) {
  const k = key(name);
  const h = head(k);
  // Head noun first: "chicken broth" is broth (Cupboard), not chicken.
  for (const [aisle, set] of AISLES) if (set.has(h)) return aisle;
  for (const w of words(k)) for (const [aisle, set] of AISLES) if (set.has(w)) return aisle;
  return 'Other';
}

/* ── shaping ────────────────────────────────────────────────────────────── */

const empty = () => ({ pantry: {}, buy: [] });
const cleanName = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

// Low or Out, and not already on the list to buy.
function running(kitchen) {
  const k = kitchen || empty();
  const listed = new Set((k.buy || []).map(b => key(b.name)));
  return entries(k.pantry)
    .filter(e => (e.state === 'low' || e.state === 'out') && !listed.has(e.key))
    .map(e => ({ key: e.key, name: e.name, state: e.state, aisle: e.aisle }));
}

// Having something takes it off the list to buy. Marked Have anywhere — a
// ring ticked on a recipe, the pantry cycled, a row ticked in the shop — every
// row naming the same thing goes, however it was written down and whichever
// recipe it was for. "The same thing" is the matcher's own test, either way
// round: a ring on "A handful of parsley" clears a row that just says
// "parsley", and "olive oil" clears "extra-virgin olive oil" — but the head
// noun must agree, so "chicken" never clears "chicken broth", and "garlic"
// never clears "garlic powder". A promise holds here too: gluten-free puff
// pastry bought clears "puff pastry", and plain puff pastry never clears
// "gluten-free puff pastry".
function bought(buy, entryKey) {
  if (!entryKey) return buy || [];
  return (buy || []).filter((row) => {
    const k = key(row && row.name);
    return !(k && (k === entryKey || covers(entryKey, k) || within(k, entryKey)));
  });
}

module.exports = {
  STATES, MAX_PANTRY, MAX_BUY, NAME_MAX, AISLE_ORDER,
  canUse, kitchensFor, key, covers, match, alternatives, aisleOf, running, bought, empty, cleanName, isStaple, isWater, head, wordsOf, wordList,
};
