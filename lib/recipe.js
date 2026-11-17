// Reading a recipe: from a page's schema.org JSON-LD, or from text somebody
// pasted. PURE — no I/O, no store — so the suite can throw every shape a site
// publishes at it with no network.
//
// The rule that runs through all of it: NEVER GUESS AN AMOUNT. A line this
// cannot read keeps `q: null` and is shown exactly as published, never scaled.
// "1 (14-ounce) can coconut milk" scaled to "2 (28-ounce) cans" is a wrong
// recipe that looks like a right one.

const kitchen = require('./kitchen');

/* ── text ───────────────────────────────────────────────────────────────── */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½', frac14: '¼', frac34: '¾',
  deg: '°', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', eacute: 'é', egrave: 'è', frac13: '⅓', frac23: '⅔' };
function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&([a-z]+\d*);/gi, (m, n) => (NAMED[n.toLowerCase()] !== undefined ? NAMED[n.toLowerCase()] : m));
}
const safeChar = (n) => (Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '');

// Sites put HTML in every field. Tags go, entities are decoded, space collapses.
function clean(s, max = 1500) {
  return decode(decode(String(s == null ? '' : s)).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

/* ── quantities ─────────────────────────────────────────────────────────── */

const FRAC = { '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75, '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };
const FRACS = Object.keys(FRAC).join('');
// One number: "1 1/2", "1½", "½", "3/4", "2.5", "2".
const NUM = `(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*[${FRACS}]|\\d+(?:\\.\\d+)?)`;
const QTY = new RegExp(`^(${NUM})(?:\\s*(?:-|–|—|to)\\s*(${NUM}))?(?=[\\s(]|$|[a-zA-Z])`);

function num(s) {
  if (s == null) return null;
  const t = String(s).trim();
  let m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[3]) ? Number(m[1]) + Number(m[2]) / Number(m[3]) : null;
  m = /^(\d+)\/(\d+)$/.exec(t);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
  m = new RegExp(`^(\\d*)([${FRACS}])$`).exec(t);
  if (m) return (m[1] ? Number(m[1]) : 0) + FRAC[m[2]];
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Canonical units, and every way people write them. Matched on the word as
// written, so "T" is a tablespoon and "t" a teaspoon, the way cookbooks mean it.
const UNIT_ALIASES = {
  cup: ['cup', 'cups', 'c'],
  tbsp: ['tablespoon', 'tablespoons', 'tbsp', 'tbsps', 'tbs', 'tbl', 'tbls', 'T'],
  tsp: ['teaspoon', 'teaspoons', 'tsp', 'tsps', 't'],
  lb: ['pound', 'pounds', 'lb', 'lbs'],
  oz: ['ounce', 'ounces', 'oz'],
  g: ['gram', 'grams', 'g', 'gr'],
  kg: ['kilogram', 'kilograms', 'kg', 'kgs'],
  ml: ['milliliter', 'milliliters', 'millilitre', 'millilitres', 'ml'],
  l: ['liter', 'liters', 'litre', 'litres', 'l'],
  clove: ['clove', 'cloves'],
  can: ['can', 'cans', 'tin', 'tins'],
  pinch: ['pinch', 'pinches'],
  dash: ['dash', 'dashes'],
  qt: ['quart', 'quarts', 'qt'],
  pt: ['pint', 'pints', 'pt'],
  stick: ['stick', 'sticks'],
  slice: ['slice', 'slices'],
  bunch: ['bunch', 'bunches'],
  sprig: ['sprig', 'sprigs'],
  package: ['package', 'packages', 'pkg'],
  jar: ['jar', 'jars'],
  head: ['head', 'heads'],
};
const UNITS = Object.keys(UNIT_ALIASES);
const UNIT_OF = new Map();
for (const [u, list] of Object.entries(UNIT_ALIASES)) {
  for (const a of list) UNIT_OF.set(a.length === 1 && a !== 'c' && a !== 'g' && a !== 'l' ? a : a.toLowerCase(), u);
}
function unitOf(word) {
  const w = String(word || '').replace(/\.$/, '');
  if (!w) return null;
  if (w === 'T' || w === 't') return UNIT_OF.get(w);
  return UNIT_OF.get(w.toLowerCase()) || null;
}

// One ingredient line → { text, q, q2, unit, name, note }. Anything it cannot
// read keeps q: null; the page then shows the line as published.
function parseLine(raw) {
  const text = clean(raw, 300);
  const out = { text, q: null, q2: null, unit: null, name: '', note: null };
  if (!text) return out;
  const split = (s) => {
    // The note: after the first comma, or in brackets.
    let rest = s;
    let note = null;
    const br = /\(([^)]*)\)/.exec(rest);
    if (br) { note = br[1].trim() || null; rest = rest.replace(br[0], ' '); }
    // The first comma that ends the NAME. "large boneless, skinless chicken
    // breasts" is a list of words describing one thing, so a comma with only
    // describing words before it is part of the name.
    let c = rest.indexOf(',');
    while (c >= 0 && !kitchen.key(rest.slice(0, c).replace(/,/g, ' '))) c = rest.indexOf(',', c + 1);
    if (c >= 0) {
      const after = rest.slice(c + 1).trim();
      note = [after, note].filter(Boolean).join('; ') || null;
      rest = rest.slice(0, c);
    }
    const tidy = (x) => x.replace(/\s+([,;])/g, '$1').replace(/\s+/g, ' ').replace(/^[,;\s]+|[,;\s]+$/g, '').trim();
    note = note ? tidy(note) : null;
    return { name: tidy(rest).slice(0, 120), note: note ? note.slice(0, 120) : null };
  };
  const m = QTY.exec(text);
  if (!m) return { ...out, ...split(text) };
  let rest = text.slice(m[0].length).trim();
  // "1 (14-ounce) can": a size in brackets straight after the number is a
  // package, and scaling it would be guessing. Left alone.
  if (rest.startsWith('(')) return { ...out, ...split(text) };
  const q = num(m[1]);
  const q2 = m[2] ? num(m[2]) : null;
  if (q === null || q <= 0) return { ...out, ...split(text) };
  const firstWord = (/^([A-Za-z]+\.?)/.exec(rest) || [])[1];
  const unit = unitOf(firstWord);
  if (unit) rest = rest.slice(firstWord.length).trim();
  rest = rest.replace(/^of\s+/i, '');
  const { name, note } = split(rest);
  if (!name) return { ...out, ...split(text) };
  return { text, q, q2: q2 !== null && q2 > q ? q2 : null, unit, name, note };
}

/* ── times ──────────────────────────────────────────────────────────────── */

// ISO 8601 durations: "PT1H5M" → 65. Whole minutes, or null.
function minutes(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(String(v).trim());
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
  const total = (Number(m[1] || 0) * 1440) + (Number(m[2] || 0) * 60) + Number(m[3] || 0) + Number(m[4] || 0) / 60;
  const r = Math.round(total);
  return r >= 0 && r <= 2880 ? r : null;
}

// "Serves 4-6" → 4. A number, a string, or an array (the first with a number).
function yieldOf(v) {
  const one = (x) => {
    if (typeof x === 'number') return x;
    const m = /(\d+(?:\.\d+)?)/.exec(String(x == null ? '' : x));
    return m ? Number(m[1]) : null;
  };
  const list = Array.isArray(v) ? v : [v];
  for (const x of list) {
    const n = one(x);
    if (n && n >= 1 && n <= 100) {
      const unit = typeof x === 'string' && /(cookie|muffin|piece|slice|cup|loaf|loaves|bar|roll|ball|pancake)/i.exec(x);
      return { n: Math.round(n), unit: unit ? unit[1].toLowerCase() : 'servings' };
    }
  }
  return null;
}

const WORDNUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90 };
const VERBS = ['bake', 'boil', 'braise', 'broil', 'brown', 'chill', 'cook', 'cool', 'fry', 'grill', 'knead', 'marinate',
  'microwave', 'poach', 'proof', 'reduce', 'rest', 'rise', 'roast', 'saute', 'sauté', 'sear', 'simmer', 'soak',
  'steam', 'steep', 'stir', 'toast', 'whisk', 'blanch', 'caramelize', 'freeze', 'set', 'stand', 'char', 'heat', 'melt'];
const VERB_RE = new RegExp(`\\b(${VERBS.join('|')})(?:s|es|d|ed|ing)?\\b`, 'gi');
const DUR = new RegExp(`(?:^|[^\\w])((?:\\d+\\s+\\d+\\/\\d+|\\d+(?:\\.\\d+)?|\\d*[${FRACS}]|${Object.keys(WORDNUM).join('|')}))`
  + `(?:\\s*(?:-|–|to|or)\\s*(\\d+(?:\\.\\d+)?))?\\s*(?:more\\s+)?(seconds?|secs?|minutes?|mins?|hours?|hrs?)\\b`, 'gi');

// Durations in a step → [{ secs, label }]. A range takes its LOW end: it is
// easier to add time than to undo it. Anything over six hours is not a timer
// you watch, and "overnight" has no number to find. Labelled with the cooking
// verb nearest BEFORE the duration, else "Step N".
function timersIn(text, stepNo = 1) {
  const t = clean(text, 1500);
  const out = [];
  let m;
  DUR.lastIndex = 0;
  while ((m = DUR.exec(t)) && out.length < 4) {
    const raw = m[1].toLowerCase();
    const n = WORDNUM[raw] !== undefined ? WORDNUM[raw] : num(raw);
    if (n === null || !Number.isFinite(n) || n <= 0) continue;
    const u = m[3].toLowerCase();
    const per = /^s/.test(u) ? 1 : /^m/.test(u) ? 60 : 3600;
    const secs = Math.round(n * per);
    if (secs < 5 || secs > 21600) continue;
    if (out.some(x => x.secs === secs)) continue;
    const before = t.slice(0, m.index + 1);
    let label = null;
    let v;
    VERB_RE.lastIndex = 0;
    while ((v = VERB_RE.exec(before))) label = v[1];
    label = label ? label[0].toUpperCase() + label.slice(1).toLowerCase().replace('saute', 'sauté') : `Step ${stepNo}`;
    out.push({ secs, label: label.slice(0, 24) });
  }
  return out;
}

// Which ingredients a step mentions. First, any whose HEAD noun the step says:
// "olive oil" when it says oil. Then a bare base word — "sear the chicken" —
// counts for the one ingredient made of it that is not something derived from
// it: chicken thighs, not chicken broth. A mention that IS the derived thing
// ("pour in the chicken broth") is that thing's, and nobody else's.
const DERIVED = new Set(['broth', 'stock', 'oil', 'sauce', 'paste', 'powder', 'flake', 'seasoning', 'bouillon', 'juice',
  'zest', 'fat', 'extract', 'vinegar', 'milk', 'water']);
const NOT_FOOD = new Set(['fresh', 'dried', 'ground', 'red', 'green', 'white', 'black', 'yellow', 'extra', 'virgin', 'sweet',
  'hot', 'cold', 'unsalted', 'salted', 'low', 'sodium', 'light', 'dark', 'whole', 'plain', 'kosher', 'sea', 'all', 'purpose',
  'heavy', 'baby', 'and', 'or', 'of', 'the', 'a', 'cup', 'tbsp', 'tsp']);
function usesIn(stepText, ingredients) {
  const said = kitchen.wordList(stepText);
  const keys = (ingredients || []).map(ing => kitchen.key((ing && (ing.name || ing.text)) || '').split(' ').filter(Boolean));
  const heads = keys.map(k => k[k.length - 1] || '');
  const used = new Set();
  // A word followed by the head of another ingredient that contains it is
  // that ingredient's: "red pepper flakes" is not the pepper in "salt and
  // pepper", and "chicken broth" is not the chicken.
  const owned = (w, at) => {
    const next = said[at + 1];
    return !!next && keys.some((k, i) => heads[i] === next && k.slice(0, -1).includes(w));
  };
  keys.forEach((k, i) => {
    if (heads[i] && said.some((w, at) => w === heads[i] && !owned(w, at))) used.add(i);
  });
  said.forEach((w, at) => {
    if (NOT_FOOD.has(w) || heads.includes(w) || owned(w, at)) return;
    const could = keys.map((k, i) => i).filter(i => keys[i].slice(0, -1).includes(w) && !DERIVED.has(heads[i]));
    if (could.length === 1) used.add(could[0]);
  });
  return [...used].sort((a, b) => a - b).slice(0, 20);
}

/* ── steps ──────────────────────────────────────────────────────────────── */

function splitHtmlish(s) {
  const str = String(s || '');
  if (/<(li|p|br)\b/i.test(str)) {
    return str.split(/<\/?(?:li|p|ol|ul)[^>]*>|<br\s*\/?>/i).map(x => clean(x)).filter(Boolean);
  }
  return decode(str).split(/\r?\n+/).map(x => clean(x)).filter(Boolean);
}

// recipeInstructions comes as a string, an array of strings, HowToSteps, or
// HowToSections of HowToSteps. All of them become a flat list of step texts.
function instructionsOf(v, depth = 0) {
  if (v == null || depth > 4) return [];
  if (typeof v === 'string') return splitHtmlish(v);
  if (Array.isArray(v)) return v.flatMap(x => instructionsOf(x, depth + 1));
  if (typeof v === 'object') {
    if (v.itemListElement) return instructionsOf(v.itemListElement, depth + 1);
    const t = v.text || v.name;
    return t ? splitHtmlish(t) : [];
  }
  return [];
}

/* ── JSON-LD ─────────────────────────────────────────────────────────────── */

const isRecipe = (n) => n && typeof n === 'object'
  && (n['@type'] === 'Recipe' || (Array.isArray(n['@type']) && n['@type'].includes('Recipe')));

function findRecipe(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const x of node) { const r = findRecipe(x, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof node !== 'object') return null;
  if (isRecipe(node)) return node;
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement']) {
    const r = findRecipe(node[k], depth + 1);
    if (r) return r;
  }
  return null;
}

function meta(html, prop) {
  const tag = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i').exec(html);
  if (!tag) return null;
  const c = /content=["']([^"']*)["']/i.exec(tag[0]);
  return c && c[1].trim() ? clean(c[1], 300) : null;
}

// The image to keep: from an `image` that is a string, an ImageObject, or an
// array of either — the one closest to 4:3 when sizes are given, else the first.
function imageOf(v, base) {
  const list = (Array.isArray(v) ? v : [v]).map((x) => {
    if (typeof x === 'string') return { url: x };
    if (x && typeof x === 'object') return { url: x.url || x.contentUrl, w: Number(x.width) || 0, h: Number(x.height) || 0 };
    return null;
  }).filter(x => x && x.url);
  if (!list.length) return null;
  const sized = list.filter(x => x.w && x.h);
  const pick = sized.length
    ? sized.sort((a, b) => Math.abs(a.w / a.h - 4 / 3) - Math.abs(b.w / b.h - 4 / 3))[0]
    : list[0];
  try {
    const u = new URL(decode(pick.url), base);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch (_) { return null; }
}

// Shape whatever was read into the gate's form: ingredients parsed, steps with
// their timers and the ingredients they use.
function shape({ name, site, yieldRaw, prep, cook, total, ingredients, steps, from }) {
  const ings = (ingredients || []).map(x => parseLine(x)).filter(x => x.text).slice(0, 60);
  const st = (steps || []).map(x => clean(x, 1500)).filter(Boolean).slice(0, 40)
    .map((text, i) => ({ text, timers: timersIn(text, i + 1), uses: usesIn(text, ings) }));
  const p = minutes(prep), c = minutes(cook);
  let t = minutes(total);
  if (t === null && (p !== null || c !== null)) t = (p || 0) + (c || 0);
  return {
    name: name ? clean(name, 200) : null,
    site: site ? clean(site, 60) : null,
    image: null,
    yield: yieldOf(yieldRaw),
    prep: p, cook: c, total: t,
    ingredients: ings,
    steps: st,
    from,
  };
}

const SCRIPT = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// Every JSON-LD block on the page, parsed in a try (a broken one is skipped,
// not fatal), walked for the first Recipe. Returns { recipe, imageUrl } or null.
function fromHtml(html, pageUrl) {
  const h = String(html || '');
  let node = null;
  let m;
  SCRIPT.lastIndex = 0;
  while (!node && (m = SCRIPT.exec(h))) {
    let json;
    try { json = JSON.parse(m[1].trim()); } catch (_) { continue; }
    node = findRecipe(json);
  }
  if (!node) return null;
  let host = null;
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch (_) {}
  const pub = node.publisher && (typeof node.publisher === 'string' ? node.publisher : node.publisher.name);
  const recipe = shape({
    name: node.name || node.headline,
    site: meta(h, 'og:site_name') || (typeof pub === 'string' ? pub : null) || host,
    yieldRaw: node.recipeYield,
    prep: node.prepTime, cook: node.cookTime, total: node.totalTime,
    ingredients: Array.isArray(node.recipeIngredient) ? node.recipeIngredient
      : Array.isArray(node.ingredients) ? node.ingredients : [],
    steps: instructionsOf(node.recipeInstructions),
    from: 'page',
  });
  if (!recipe.ingredients.length && !recipe.steps.length) return null;
  const imageUrl = imageOf(node.image, pageUrl) || imageOf(meta(h, 'og:image'), pageUrl);
  return { recipe, imageUrl };
}

/* ── pasted text ────────────────────────────────────────────────────────── */

const ING_HEAD = /^(ingredients?|you(?:'|’)ll need|what you need)\s*:?$/i;
const STEP_HEAD = /^(steps?|instructions?|directions?|method|preparation|how to make it)\s*:?$/i;
const BULLET = /^\s*(?:[-*•·▪◦]|\d+[.)]|step\s+\d+[:.)]?)\s*/i;

// The paste reader. Headings when there are headings; without them, lines led
// by a quantity or a bullet are ingredients, and numbered or long lines steps.
function fromText(text) {
  const lines = String(text || '').slice(0, 30000).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let ings = [], steps = [], mode = null, sawHead = false;
  for (const line of lines) {
    if (ING_HEAD.test(line)) { mode = 'ing'; sawHead = true; continue; }
    if (STEP_HEAD.test(line)) { mode = 'step'; sawHead = true; continue; }
    const bare = line.replace(BULLET, '').trim();
    if (!bare) continue;
    if (sawHead) {
      if (mode === 'ing') ings.push(bare);
      else if (mode === 'step') steps.push(bare);
      continue;
    }
    const numbered = /^\s*(?:\d+[.)]|step\s+\d+)/i.test(line);
    const ledByQty = QTY.test(bare) || /^\s*[-*•·▪◦]/.test(line);
    if (numbered || bare.length > 90) steps.push(bare);
    else if (ledByQty) ings.push(bare);
  }
  const recipe = shape({ ingredients: ings, steps, from: 'paste' });
  return recipe.ingredients.length || recipe.steps.length ? recipe : null;
}

module.exports = {
  UNITS, decode, clean, num, parseLine, unitOf, minutes, yieldOf, timersIn, usesIn,
  instructionsOf, findRecipe, imageOf, shape, fromHtml, fromText,
};
