// What a list eats: gluten-free, vegetarian, no pork. Suggestions lean away
// from what breaks it, new ideas have to keep to it, and a recipe's swaps are
// asked for with it. PURE — no I/O, no store.
//
// A RULE OF THE LIST, not a fact about a person. It is set on a list by anyone
// on it, everyone on that list sees it, and it names nobody: "this list eats
// gluten-free", never who that is for or why. That is deliberate. A diet kept per
// person would be a new audience — it says something about somebody's health —
// and would need the kitchen's narrow rule. Kept on the list it goes exactly as
// far as the list's own name does.
//
// THE HONEST LIMIT, and it shapes every word this file produces: nothing here
// can know that a restaurant is safe. So it never says so. It says three kinds
// of thing, and each names where it came from:
//   * what a recipe's own lines contain ("Has flour, soy sauce") — read from
//     the ingredients with `scan`, a caution list and not a guarantee: a line
//     it does not flag has not been checked, and the screen never says it has
//   * what a thing is built around ("Built around wheat") — Claude's coarse
//     profile of it (item.fit.built, lib/itemfit.js), only ever a caution
//   * what OpenStreetMap's mappers recorded about a place ("Gluten-free
//     options, says OpenStreetMap") — the one source of anything positive, and
//     quoted as theirs
// `strict` is for celiac and allergies: cautions weigh more, and ideas are
// asked for with cross-contact in mind.

// What food can be built around, as far as a diet cares. The vocabulary Claude
// profiles a thing in, and the one the ingredient scan answers in.
const BUILT = ['gluten', 'dairy', 'egg', 'meat', 'pork', 'fish', 'shellfish', 'nuts', 'alcohol'];
const WORD = { gluten: 'wheat', dairy: 'dairy', egg: 'eggs', meat: 'meat', pork: 'pork', fish: 'fish', shellfish: 'shellfish', nuts: 'nuts', alcohol: 'alcohol' };

// The rules a list can keep. The id is how it reads in a sentence ("swap for
// gluten-free"); `osm` is the tag OpenStreetMap records it under, where it has one.
const RULES = [
  { id: 'gluten-free', label: 'Gluten-free', avoids: ['gluten'], osm: 'diet:gluten_free' },
  { id: 'dairy-free', label: 'Dairy-free', avoids: ['dairy'], osm: null },
  { id: 'vegetarian', label: 'Vegetarian', avoids: ['meat', 'pork', 'fish', 'shellfish'], osm: 'diet:vegetarian' },
  { id: 'vegan', label: 'Vegan', avoids: ['meat', 'pork', 'fish', 'shellfish', 'dairy', 'egg'], osm: 'diet:vegan' },
  { id: 'pescatarian', label: 'Pescatarian', avoids: ['meat', 'pork'], osm: 'diet:pescetarian' },
  { id: 'nut-free', label: 'Nut-free', avoids: ['nuts'], osm: null },
  { id: 'egg-free', label: 'Egg-free', avoids: ['egg'], osm: null },
  { id: 'shellfish-free', label: 'No shellfish', avoids: ['shellfish'], osm: null },
  { id: 'pork-free', label: 'No pork', avoids: ['pork'], osm: null },
  { id: 'alcohol-free', label: 'No alcohol', avoids: ['alcohol'], osm: null },
];
const BY_ID = Object.fromEntries(RULES.map(r => [r.id, r]));
const MAX = 6;
const SAID = ['only', 'yes', 'limited', 'no'];

/* ── the rule on a list ─────────────────────────────────────────────────── */

// What somebody sent → { ok: true, diet } (diet null for "anything") or
// { ok: false }. An id this server does not know is REFUSED, not dropped: a
// rule you asked for and did not get is worse than an error.
function clean(raw) {
  if (raw === null || raw === undefined) return { ok: true, diet: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const asked = raw.must === undefined || raw.must === null ? [] : raw.must;
  if (!Array.isArray(asked) || asked.length > 20 || asked.some(id => typeof id !== 'string' || !BY_ID[id])) return { ok: false };
  const must = RULES.map(r => r.id).filter(id => asked.includes(id)).slice(0, MAX);
  if (!must.length) return { ok: true, diet: null };
  return { ok: true, diet: { must, strict: raw.strict === true } };
}

// The rule a list keeps, checked again on the way out: a store edited by hand
// must not make a rule this server has no table for.
function of(space) {
  const d = space && space.diet;
  if (!d || typeof d !== 'object') return null;
  const must = RULES.map(r => r.id).filter(id => Array.isArray(d.must) && d.must.includes(id));
  return must.length ? { must, strict: d.strict === true } : null;
}

function set(space, raw, by, now = Date.now()) {
  const got = clean(raw);
  if (!got.ok) return got;
  if (got.diet) space.diet = { ...got.diet, by, at: now }; else delete space.diet;
  return { ok: true, diet: of(space) };
}

const manifest = () => RULES.map(({ id, label }) => ({ id, label }));
const words = (diet) => (diet ? diet.must.slice() : []);
const labels = (diet) => (diet ? diet.must.map(id => BY_ID[id].label) : []);
const join = (xs, last) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${last} ${xs[xs.length - 1]}`);

// How it is said to Claude, for ideas and swaps: the words, and whether it is
// medical. Nobody's name, and no condition named beyond that.
function promptLine(diet) {
  if (!diet) return null;
  return `${diet.must.join(', ')}${diet.strict
    ? ' — STRICTLY. It is medical (celiac disease or an allergy), not a preference, so traces and shared fryers, boards and toasters matter'
    : ''}`;
}

/* ── what a line of food contains ───────────────────────────────────────────
   One table a category: the words that mean it is there, the phrases that
   only look like it (almond flour is not flour, peanut butter is not butter),
   and what a label has to say for the line to be let off ("gluten-free pasta").
   It is a caution list. It errs toward saying something is there. */

const rx = (alts, flags = 'i') => new RegExp(`\\b(?:${alts})\\b`, flags);
const food = (has, safe, says) => ({ has: rx(has), safe: safe ? rx(safe, 'gi') : null, says: says ? rx(says) : null });
const PLANT = 'vegan|vegetarian|veggie|plant[- ]based';
const FOOD = {
  gluten: food(
    'puff pastry|shortcrust pastry|bread flour|bread ?crumbs?|flour tortillas?|flour|panko|breading|bread|baguettes?|brioche|ciabatta|sourdough|pitas?|naan|buns?|croutons?|bagels?|croissants?|pretzels?'
    + '|pasta|spaghetti|penne|linguine|fettuccine|tagliatelle|rigatoni|macaroni|lasagn[ae]|orzo|gnocchi|noodles?|udon|ramen|couscous|bulgur|barley|rye|farro|spelt|semolina|seitan|wheat'
    + '|soy sauce|teriyaki|hoisin|oyster sauce|ponzu|gochujang|tempura|breaded|battered|pastry|pastries|phyllo|filo|pie crust|pizzeria|pizzas?|dough|wrappers?|dumplings?|gyoza|crackers?'
    + '|tortillas?|pancakes?|waffles?|bakery|patisserie|brewery|brewpub|taproom|beer|lager|stout|malt',
    '(?:almond|rice|coconut|chickpea|corn|tapioca|oat|potato|cassava|buckwheat|sorghum|millet|teff|quinoa|gram|masa|nut) flour|cornflour|(?:rice|glass|kelp|zucchini|courgette|shirataki) noodles?'
    + '|rice paper(?: wrappers?)?|rice (?:crackers?|cakes?)|corn tortillas?|tortilla chips|buckwheat|(?:ginger|root) beer',
    'gluten[- ]?free|gf'),
  dairy: food(
    'buttermilk|buttercream|butter|ghee|milk|ice cream|sour cream|cream cheese|cream|half[- ]and[- ]half|cheese|parmesan|parmigiano|pecorino|mozzarella|ricotta|cheddar|feta|mascarpone|gruy.re|brie|gouda|halloumi|paneer'
    + '|yogh?urt|cr.me fra.che|whey|custard|gelato|creamery',
    '(?:coconut|almond|oat|soy|rice|cashew|nut|plant|hemp|pea) (?:milk|cream|butter|yogh?urt|cheese)|(?:peanut|almond|cashew|nut|cocoa|shea|apple|seed|sunflower|pumpkin) butter'
    + '|cream of tartar|cream of coconut|creamed coconut|butter ?beans?|butter lettuce',
    `dairy[- ]?free|non[- ]?dairy|vegan|plant[- ]based`),
  egg: food('egg yolks?|egg whites?|eggs?|yolks?|mayonnaise|mayo|meringue|aioli', null, 'egg[- ]?free|vegan|plant[- ]based'),
  meat: food(
    'chicken|beef|lamb|turkey|veal|duck|goose|venison|steakhouse|steaks?|mince|meatballs?|meat|brisket|oxtail|short ribs?|sausages?|hot dogs?|gelatine?|bone broth|burgers?|barbecue|bbq|smokehouse',
    '(?:coconut|crab|nut) meat|duck sauce|beef(?:steak)? tomato(?:es)?|(?:tuna|salmon|cauliflower|tofu|swordfish|halloumi|mushroom|aubergine|eggplant|celeriac|cabbage) steaks?',
    `${PLANT}|meatless|meat[- ]free|mock`),
  pork: food(
    'pulled pork|pork|bacon|ham|prosciutto|pancetta|guanciale|lardons?|lard|chorizo|salami|pepperoni|nduja|carnitas',
    '(?:turkey|beef|coconut|mushroom|tempeh|duck|chicken|lamb) (?:bacon|ham|chorizo|pepperoni|salami)',
    `${PLANT}|pork[- ]?free`),
  fish: food('fish sauce|fish|salmon|tuna|cod|anchov(?:y|ies)|sardines?|trout|halibut|tilapia|mackerel|haddock|sea ?bass|snapper|swordfish|bonito|dashi|caviar|sushi|sashimi|worcestershire', null, PLANT),
  shellfish: food(
    'shrimps?|prawns?|crab|lobster|crawfish|crayfish|clams?|mussels?|oysters?|scallops?|shellfish|langoustines?|squid|calamari|octopus',
    '(?:king )?oyster mushrooms?|king oyster|oysters?(?=.*\\bmushrooms?\\b)|(?<=\\bmushrooms?\\b.*)oysters?|crab ?apples?',
    `${PLANT}|shellfish[- ]?free`),
  nuts: food('pine nuts?|nuts?|almonds?|walnuts?|pecans?|cashews?|pistachios?|hazelnuts?|peanuts?|macadamias?|nutella|marzipan|pralines?|frangipane|pesto', 'water chestnuts?', 'nut[- ]?free'),
  alcohol: food(
    'wine|beer|lager|stout|ale|vodka|rum|whiske?y|bourbon|brandy|cognac|sake|mirin|sherry|liqueur|tequila|mezcal|gin|vermouth|champagne|prosecco|marsala|amaretto|kahlua|cocktails?|brewery|brewpub|taproom|winery|distillery',
    '(?:rice wine|wine|sherry|champagne|cider|malt|beer) vinegar|ginger (?:ale|beer)|root beer|(?:shrimp|prawn|fruit) cocktails?|(?:rum|vanilla|almond) extract',
    'non[- ]?alcoholic|alcohol[- ]?free|zero[- ]proof|virgin|mocktails?'),
};

// What one line names of the given categories: [{ cat, word }]. `also` is more
// words about the same thing (an idea's note on how it keeps to the rule): a
// promise made there counts for the line.
function scan(text, cats, also = '') {
  const line = String(text == null ? '' : text).toLowerCase().replace(/\s+/g, ' ');
  const said = `${line} ${String(also == null ? '' : also).toLowerCase()}`;
  const out = [];
  for (const cat of cats || []) {
    const f = FOOD[cat];
    if (!f || (f.says && f.says.test(said))) continue;
    const m = f.has.exec(f.safe ? line.replace(f.safe, ' ') : line);
    if (m) out.push({ cat, word: m[0] });
  }
  return out;
}

// Does this text name something the list does not eat, with nothing in it (or
// in `also`) promising otherwise? For the gate on new ideas.
function names(diet, text, also = '') {
  if (!diet) return false;
  return diet.must.some(id => scan(text, BY_ID[id].avoids, also).length > 0);
}

/* ── one thing, against the rule ────────────────────────────────────────── */

// What OpenStreetMap's tags say, by rule: { 'gluten-free': 'yes' } or null.
function fromTags(tags) {
  if (!tags || typeof tags !== 'object') return null;
  const out = {};
  for (const r of RULES) {
    const v = r.osm ? String(tags[r.osm] || '').trim().toLowerCase() : '';
    if (SAID.includes(v)) out[r.id] = v;
  }
  return Object.keys(out).length ? out : null;
}

// facts: { kind, built: [cat…] | null, lines: [text…] | null, osm: {…} | null }
//   lines — a recipe's ingredients as they will be cooked (swaps applied), when it has been read
//   built — what Claude's profile says it is built around, when there are no lines
//           (for a recipe that is `swap`, a nudge: it is yours to make another way)
//   osm   — what OpenStreetMap says about the place
// → { level, text } or null when there is nothing to say. Levels, worst first:
//   no · hard · swap · limited · yes · only. With several rules the worst wins.
const LEVELS = ['no', 'hard', 'swap', 'limited', 'yes', 'only'];
function judge(diet, facts = {}) {
  if (!diet || !Array.isArray(diet.must) || !diet.must.length) return null;
  const found = [];
  for (const id of diet.must) {
    const r = BY_ID[id];
    if (!r) continue;
    const said = facts.osm && SAID.includes(facts.osm[id]) ? facts.osm[id] : null;
    if (said) { found.push({ level: said, id }); continue; }
    if (Array.isArray(facts.lines)) {
      const hit = [...new Set(facts.lines.flatMap(l => scan(l, r.avoids).map(h => h.word)))];
      if (hit.length) found.push({ level: 'swap', id, words: hit });
      continue;
    }
    // No lines to go by: what it is built around. A recipe is the list's own
    // to make another way, so that is a nudge; somebody else's kitchen is not.
    const cats = (Array.isArray(facts.built) ? facts.built : []).filter(c => r.avoids.includes(c));
    if (cats.length) found.push({ level: facts.kind === 'recipe' ? 'swap' : 'hard', id, cats });
  }
  if (!found.length) return null;
  const level = LEVELS.find(l => found.some(f => f.level === l));
  const same = found.filter(f => f.level === level);
  const ids = same.map(f => f.id);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let text;
  if (level === 'no') text = `No ${join(ids, 'or')} options, says OpenStreetMap`;
  else if (level === 'hard') {
    const things = [...new Set(same.flatMap(f => f.cats).map(c => WORD[c]))].slice(0, 3);
    text = `Built around ${join(things, 'and')} · ${facts.kind === 'place' ? `ask what’s ${join(ids, 'or')}` : `not ${join(ids, 'or')} as it comes`}`;
  } else if (level === 'swap') {
    const all = [...new Set(same.flatMap(f => f.words || []))];
    const things = [...new Set(same.flatMap(f => f.cats || []).map(c => WORD[c]))].slice(0, 3);
    text = all.length
      ? `Has ${all.slice(0, 2).join(', ')}${all.length > 2 ? ` and ${all.length - 2} more` : ''} · swap for ${join(ids, 'and')}`
      : `Built around ${join(things, 'and')} · needs a ${join(ids, 'and')} version`;
  } else if (level === 'limited') text = `A few ${join(ids, 'and')} options, says OpenStreetMap`;
  else if (level === 'yes') text = `${cap(join(ids, 'and'))} options, says OpenStreetMap`;
  else text = `All ${join(ids, 'and')}, says OpenStreetMap`;
  return { level, text };
}

module.exports = { BUILT, WORD, RULES, MAX, SAID, LEVELS, clean, of, set, manifest, words, labels, promptLine, scan, names, fromTags, judge };
