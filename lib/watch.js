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

const API = 'https://api.themoviedb.org/3';
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
// trailing symbol. The live list is full of titles like "🐴 Bojack Horseman",
// and sending that verbatim returns nothing at all.
const searchQuery = (title) => String(title == null ? '' : title)
  .replace(/\(\s*(19|20)\d{2}\s*\)\s*$/, '')
  .replace(/^[^\p{L}\p{N}]+/u, '')
  .replace(/[^\p{L}\p{N}]+$/u, '')
  .trim();

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
    // Tiers of something already listed are not another place to watch it.
    // Two shapes of the same problem, both seen in the live data:
    //   "Netflix" + "Netflix Standard with Ads"   — one is a prefix of the other
    //   "Paramount Plus Premium" + "… Essential"  — neither is, but both are it
    // So: a prefix match, or the same first two words. Two words is enough to
    // separate "Amazon Prime Video" from "Amazon Video", which really are
    // different things, while folding every tier of one service into one slot.
    const lower = name.toLowerCase();
    const dup = out.some(o => {
      const seen = o.name.toLowerCase();
      return seen === lower
        || lower.startsWith(`${seen} `) || seen.startsWith(`${lower} `)
        || brand(seen) === brand(lower);
    });
    if (dup) continue;
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
  const u = new URL(API + path);
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

module.exports = {
  lookup, cached, pickMatch, shape, shapeProviders, posterUrl, logoUrl,
  fold, yearHint, searchQuery, configured, region, MEDIA, IMG,
};
