// Posters, years and where a thing is streaming. TMDB.
//
// "Watch Obsession" is a row of text. The poster is the thing that makes a list
// of films feel like a shelf of films, and "on Max" is the difference between a
// list you browse and a list you act on.
//
// ── The shape, copied from geo.js on purpose ──────────────────────────────
//
// Same constraints, same answers: a store-backed cache so a title is looked up
// once, a single queue so requests are serialised, and a REMEMBERED FAILURE so
// a title TMDB has never heard of is not asked about again on every render.
// The one thing that differs is what counts as a wrong answer.
//
// ── TMDB proposes; pickMatch disposes ─────────────────────────────────────
//
// Searching "Obsession" returns a 1976 De Palma, a 2019 thriller, a telenovela
// and forty other things. Taking the first result is how a list of films ends
// up with the wrong poster on it — and a wrong poster is worse than none,
// because it looks exactly like a right one and nobody checks.
//
// So the match is decided by pure, tested code: an exact title wins, popularity
// breaks ties, and anything that is merely *similar* has to clear a bar before
// it is stored at all. No confident match means no poster, which is a state the
// card already draws properly.
// The store is required LAZILY, not at import.
//
// Everything above the cache in this file is pure, and the suite wants to test
// it without a store existing at all — binding `../store` at import time loads
// whatever DATA_FILE said when the first `require` happened, which in a test
// run is the real one. The guard in test.js caught exactly that.
const config = require('./config');
const store = () => require('./../store');

// `tmdbEndpoint` exists so the suites can point it at a stand-in, as with Photon.
const API = () => String(config.get('tmdbEndpoint', 'https://api.themoviedb.org/3')).replace(/\/+$/, '');
// TMDB serves art off a separate CDN. The size is chosen at render time, so what
// is stored is the path and nothing else — `/abc123.jpg`.
const IMG = 'https://image.tmdb.org/t/p';
const MIN_GAP_MS = 120;              // TMDB is generous; this is politeness, not policy
const NEG_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // a title it has never heard of
const TTL_MS = 30 * 24 * 60 * 60 * 1000;       // where something streams DOES change
const MAX_CACHE = 2000;

// `movie` and `show` are our words; TMDB's are `movie` and `tv`.
const MEDIA = { movie: 'movie', show: 'tv' };

const configured = () => !!config.get('tmdbKey');
const region = () => String(config.get('tmdbRegion', 'US')).toUpperCase().slice(0, 2);

/* ── pure ────────────────────────────────────────────────────────────────── */

// Matching key. Case, spacing and punctuation are noise; a trailing year is a
// disambiguator people type and TMDB does not want in the query.
const fold = (t) => String(t == null ? '' : t)
  .toLowerCase()
  .replace(/\(\s*(19|20)\d{2}\s*\)\s*$/, '')     // "Obsession (1976)"
  .replace(/[’'`]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// A year the person typed, which is a strong hint and worth honouring.
function yearHint(title) {
  const m = String(title || '').match(/\(\s*((?:19|20)\d{2})\s*\)\s*$/);
  return m ? Number(m[1]) : null;
}

// What to actually ask TMDB. The matching key can afford to flatten everything;
// the QUERY cannot — "Dune: Part Two" needs its colon and "Se7en" its digit.
// So only the decoration comes off: a trailing year, and any leading or
// trailing symbol. A list is full of titles like "🦆 Ducktales",
// and sending that verbatim returns nothing at all.
const searchQuery = (title) => String(title == null ? '' : title)
  .replace(/\(\s*(19|20)\d{2}\s*\)\s*$/, '')
  .replace(/^[^\p{L}\p{N}]+/u, '')
  .replace(/[^\p{L}\p{N}]+$/u, '')
  .trim();

// The title, once a person has said which one it is: the SAME words, tidied.
// "parks and" pinned to Parks and Recreation becomes "Parks and Recreation";
// "Sopranos" becomes "The Sopranos"; "halt and catch fire" gets its capitals. A leading emoji
// stays, and a year typed to say which one ("Obsession (1976)") goes — the
// card shows the year now.
//
// And in its own alphabet, when that is what was typed: "Ei sosedi", pinned to
// a show whose own title is «Эй, соседи!», was typed the way it SOUNDS because
// the keyboard was Latin. It becomes the original, Cyrillic and all — not the
// English name TMDB files it under, which is nobody's word for it here.
//
// Only when it is the same words: the same once folded, a beginning of the
// real title, or the real title without its article. Anything else is
// somebody's own name for it and is left exactly as typed.
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', ё: 'e', є: 'e', ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'i', й: 'i', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ў: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const translit = (s) => String(s == null ? '' : s).toLowerCase().replace(/[\u0400-\u04ff]/g, c => (CYR[c] !== undefined ? CYR[c] : c));
// People spell the same sounds a dozen ways (y/j/i, kh/h, ya/ia). Compared as a
// skeleton, so "Cheburashka", "Čeburaška"-ish and "Tcheburashka" need not agree
// letter for letter — it is only ever asked of the one show already chosen.
const skeleton = (s) => fold(translit(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, ''))
  .replace(/shch|sch/g, 'sh').replace(/kh/g, 'h').replace(/zh/g, 'z').replace(/ts|tz/g, 'c')
  .replace(/yo|jo|io/g, 'e').replace(/y([aueo])/g, '$1').replace(/i([aueo])/g, '$1').replace(/j([aueo])/g, '$1').replace(/[yj]/g, 'i')
  .replace(/(.)\1+/g, '$1');
// Letters and digits of ANY alphabet, lower-cased: "эй соседи" is «Эй, соседи!».
const ufold = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Folded with accents off first, so "Amelie" is "Amélie".
const plain = (x) => fold(String(x == null ? '' : x).normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));
const sameWords = (a, b) => !!a && !!b && (a === b || b.startsWith(`${a} `) || ['the', 'a', 'an'].some(art => b === `${art} ${a}`));

// The same title in another grammatical case, or a shorter way of saying it:
// "Slon gektor" for «Приключения слона Гектора» — slon/slona, gektor/gektora.
// Every typed word has to begin a word of the original, and there has to be
// enough of it (six letters) that it is not an accident.
function stems(a, b) {
  const A = a.split(' ').filter(Boolean), B = b.split(' ').filter(Boolean);
  return A.join('').length >= 6 && A.every(w => w.length >= 3 && B.some(x => x.startsWith(w)));
}

function tidyTitle(typed, official, original = null) {
  const t = String(typed == null ? '' : typed);
  const clean = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
  const o = clean(official), own = clean(original);
  const bare = searchQuery(t);
  const mark = ((/^[^\p{L}\p{N}]+/u.exec(t) || [''])[0]).trim();
  const out = (title) => `${mark ? `${mark} ` : ''}${title}`.slice(0, 200);
  if (o && sameWords(plain(bare), plain(o))) return out(o);
  // Its own title in another alphabet: typed in that alphabet, or by ear in Latin.
  if (own && own !== o && /[^\u0000-\u024f]/.test(own)) {
    if (sameWords(ufold(bare), ufold(own)) || sameWords(skeleton(bare), skeleton(own)) || stems(skeleton(bare), skeleton(own))) return out(own);
  }
  return t;
}

const key = (kind, title) => `${kind}:${fold(title)}`;
const yearOf = (r) => Number(String(r.release_date || r.first_air_date || '').slice(0, 4)) || null;
const titleOf = (r) => r.title || r.name || '';

// Which result, if any, is actually the thing you meant.
//
// Returns null rather than a guess. The bar is deliberately high: a list of
// films with one wrong poster on it is worse than a list with one missing,
// because the wrong one looks right and nobody goes back to check.
function pickMatch(results, wanted, hint = null) {
  const want = fold(wanted);
  if (!want) return null;
  const list = (results || []).filter(r => r && titleOf(r));

  const exact = list.filter(r => fold(titleOf(r)) === want);
  const pool = exact.length ? exact : list;
  if (!pool.length) return null;

  const scored = pool.map(r => ({
    r,
    // A year the person typed beats everything — it is the whole reason they
    // typed it. Then popularity, which is TMDB's own answer to "which of these
    // forty things called Obsession did they mean".
    score: (hint && yearOf(r) === hint ? 1000 : 0) + (Number(r.popularity) || 0),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0].r;
  // Nothing matched the title exactly. Accept the top result only if it is a
  // genuine prefix or containment, not merely in the same neighbourhood —
  // "The Bear" must not resolve to "Bear Island".
  if (!exact.length) {
    const got = fold(titleOf(best));
    const close = got.startsWith(want) || want.startsWith(got);
    if (!close) return null;
  }
  return best;
}

// What gets stored. The path, not a URL: sizes are a rendering decision and
// baking one in means re-fetching everything the day the card changes size.
function shape(r, mediaType) {
  if (!r || !r.id) return null;
  return {
    tmdbId: Number(r.id),
    mediaType,
    title: String(titleOf(r)).slice(0, 200),
    year: yearOf(r),
    poster: r.poster_path ? String(r.poster_path).slice(0, 120) : null,
  };
}

// Where you can actually watch it, flattened to names.
//
// `flatrate` is "included with a subscription you may already have", which is
// the only one that answers "can we watch this tonight". Rent and buy are a
// different question and are deliberately left out rather than mixed in — a
// list that says "on Amazon" when it means "$3.99 on Amazon" is lying quietly.
// TMDB's relevance rank, where ZERO is the best one. `Number(x) || 999` reads a
// legitimate 0 as missing and buries the most relevant service — the same
// falsy-zero trap as everywhere else, and it put Netflix fourth behind two
// live-TV resellers.
// The first two words of a service name, which is as much as is needed to tell
// one brand from another: "Paramount Plus" from "Apple TV", but not "Paramount
// Plus Premium" from "Paramount Plus Essential".
const brand = (n) => String(n).split(/\s+/).slice(0, 2).join(' ');

// Tiers of something already listed are not another place to watch it.
// Two shapes of the same problem, both seen in the live data:
//   "Netflix" + "Netflix Standard with Ads"   — one is a prefix of the other
//   "Paramount Plus Premium" + "… Essential"  — neither is, but both are it
// So: a prefix match, or the same first two words. Two words is enough to
// separate "Amazon Prime Video" from "Amazon Video", which really are
// different things, while folding every tier of one service into one slot.
function sameService(a, b) {
  const x = String(a).toLowerCase(), y = String(b).toLowerCase();
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `) || brand(x) === brand(y);
}

// The same rule over a list already stored. Applied on the way OUT, because
// a film looked up before the tier rule existed still has both tiers on disk —
// one film showed Paramount Plus twice — and rewriting the store for
// a presentation rule is the wrong way round.
function dedupeServices(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || !p.name || out.some(o => sameService(o.name, p.name))) continue;
    out.push(p);
  }
  return out;
}

const pri = (p) => {
  const n = Number(p && p.display_priority);
  return Number.isFinite(n) ? n : 999;
};

function shapeProviders(payload, reg) {
  const here = payload && payload.results && payload.results[reg];
  const flat = ((here && here.flatrate) || [])
    .slice()
    // TMDB's own relevance order. Without it the four that fit the card were
    // whatever came back first, which for Django Unchained meant three live-TV
    // resellers and no actual streaming service.
    .sort((a, b) => pri(a) - pri(b));

  const out = [];
  for (const p of flat) {
    const name = String((p && p.provider_name) || '').trim();
    if (!name) continue;
    if (out.some(o => sameService(o.name, name))) continue;   // a tier, not a service
    out.push({ name: name.slice(0, 40), logo: p.logo_path ? String(p.logo_path).slice(0, 120) : null });
    if (out.length >= 4) break;   // a card has room for a few, not for fifteen
  }
  return out;
}

const posterUrl = (path, size = 'w342') => (path ? `${IMG}/${size}${path}` : null);
const logoUrl = (path, size = 'w92') => (path ? `${IMG}/${size}${path}` : null);

/* ── cache ───────────────────────────────────────────────────────────────── */

const cache = () => {
  const { state } = store();
  if (!state.titles || typeof state.titles !== 'object') state.titles = {};
  return state.titles;
};

function remember(k, value) {
  const c = cache();
  c[k] = { ...value, at: Date.now() };
  const keys = Object.keys(c);
  if (keys.length > MAX_CACHE) {
    keys.sort((a, b) => (c[a].at || 0) - (c[b].at || 0));
    for (const old of keys.slice(0, keys.length - MAX_CACHE)) delete c[old];
  }
  store().save();
  return c[k];
}

// A hit, or null. A remembered miss counts as a hit for a week — the point of
// recording it is not to ask again.
function cached(kind, title) {
  const hit = cache()[key(kind, title)];
  if (!hit) return null;
  const age = Date.now() - (hit.at || 0);
  if (hit.miss) return age < NEG_TTL_MS ? hit : null;
  return age < TTL_MS ? hit : null;
}

/* ── the call ────────────────────────────────────────────────────────────── */

let queue = Promise.resolve();
let lastAt = 0;

const get = async (path, params) => {
  const u = new URL(API() + path);
  u.searchParams.set('api_key', config.get('tmdbKey'));
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`tmdb ${res.status}`);
  return res.json();
};

// Look a title up, once. Everything else in this file exists to make this safe
// to call on every write without thinking about it.
// `fresh` ignores what is cached — both a remembered miss and a stale hit.
// Pressing a backfill means "try again"; it would be a strange button that
// deliberately skipped everything it had already failed at.
async function lookup(kind, title, { fresh = false } = {}) {
  const media = MEDIA[kind];
  if (!media || !configured()) return null;
  const k = key(kind, title);
  const hit = fresh ? null : cached(kind, title);
  if (hit) return hit.miss ? null : hit;

  queue = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAt = Date.now();
    try {
      const q = searchQuery(title);
      if (!q) return remember(k, { miss: true });
      const found = await get(`/search/${media}`, { query: q, include_adult: 'false' });
      const best = pickMatch(found && found.results, q, yearHint(title));
      if (!best) return remember(k, { miss: true });

      const base = shape(best, media);
      let providers = [];
      try {
        providers = shapeProviders(await get(`/${media}/${base.tmdbId}/watch/providers`), region());
      } catch (_) {
        // Where it streams is a bonus. Losing it must not lose the poster.
      }
      return remember(k, { ...base, providers });
    } catch (e) {
      console.error('tmdb lookup failed:', e.message);
      return null;      // NOT remembered — a network blip is not "no such film"
    }
  }).catch(() => null);

  const out = await queue;
  return out && !out.miss ? out : null;
}

/* ── choosing, rather than guessing ──────────────────────────────────────── */

// The candidates, for a person to pick from.
//
// `pickMatch` exists to answer "which one" with nobody in the room — a bulk
// backfill, a share that arrived while you were asleep. When somebody IS in the
// room, asking is strictly better: it is one tap, it is never wrong, and a
// poster is the fastest possible way to recognise a film. So this returns the
// shortlist and decides nothing.
//
// Ordered by TMDB's own relevance, which is what their search already sorts by,
// and capped: a chooser is a question with a few answers, not a catalogue.
async function search(kind, q, limit = 8) {
  const media = MEDIA[kind];
  const query = searchQuery(q);
  if (!media || !query || !configured()) return [];
  const found = await get(`/search/${media}`, { query, include_adult: 'false' });
  return ((found && found.results) || [])
    .map(r => shape(r, media))
    .filter(Boolean)
    .slice(0, limit);
}

// Everything about one chosen id, including where it streams. Used when a
// person has picked, so there is no matching left to do — only fetching.
async function detail(kind, tmdbId) {
  const media = MEDIA[kind];
  const id = Number(tmdbId);
  if (!media || !Number.isFinite(id) || id <= 0 || !configured()) return null;
  const r = await get(`/${media}/${id}`, {});
  const base = shape(r, media);
  if (!base) return null;
  let providers = [];
  try {
    providers = shapeProviders(await get(`/${media}/${id}/watch/providers`), region());
  } catch (_) {
    // Where it streams is a bonus. Losing it must not lose the poster.
  }
  // Its title in its own language, for tidyTitle — not stored: the gate keeps
  // what a card needs, and this is only wanted at the moment of choosing.
  const original = String(r.original_name || r.original_title || '').slice(0, 200) || null;
  return { ...base, providers, original };
}

module.exports = {
  search, detail, get,
  lookup, cached, pickMatch, shape, shapeProviders, sameService, dedupeServices, posterUrl, logoUrl,
  fold, yearHint, searchQuery, tidyTitle, translit, skeleton, configured, region, MEDIA, IMG,
};
