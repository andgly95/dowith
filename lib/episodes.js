// Seasons and episodes of a show: which you have watched, what is next, and
// when you have seen it all. One record per SHOW, not per person — you watch it
// together, so it is the list's progress, like ticking off — and anyone who can
// see the show may tick an episode.
//
// The rules:
//
//   * TMDB says what the show is: its seasons (specials, season 0, left out),
//     how many episodes each has, which has aired, and whether more are coming.
//     A snapshot is kept on the item so the shelf can draw progress without
//     asking TMDB for every poster on every render; the show's own page asks
//     again and refreshes it.
//   * Only AIRED episodes count. An announced episode is shown and cannot be
//     ticked, and nobody has "not finished" a show because of one that is not
//     out yet.
//   * Ticking the last aired episode of a show that has ENDED finishes it: the
//     item is ticked off, by whoever ticked that episode, and the shelf plays its
//     finale. A show still running is "caught up" instead and stays on the
//     shelf, because a new season is the thing you would want it there for.
//   * The ordinary tick still finishes a show at any point, seen it all or not,
//     and un-ticking keeps every episode.
//   * Progress belongs to ONE show (`of`, its TMDB id). Pinning the item to a
//     different show lets it go.
//
// Stored as `item.episodes = { of, seen: { "1": [1, 2] }, season, show, by, at }`,
// beside `visit` and set only by its own route, so a PATCH can neither set nor
// lose it. Pure apart from `fetchShow`/`fetchSeason`.

const RETURNING = ['Returning Series', 'In Production', 'Planned', 'Pilot'];
const MAX_SEASONS = 80, MAX_EPS = 600;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// TMDB's /tv/{id} → what a show is, for counting.
function shapeShow(r, now = Date.now()) {
  if (!r || typeof r !== 'object') return null;
  const seasons = (Array.isArray(r.seasons) ? r.seasons : [])
    .map(x => ({ n: int(x && x.season_number, 1, MAX_SEASONS), eps: int(x && x.episode_count, 0, MAX_EPS),
      air: DATE.test(String(x && x.air_date)) ? x.air_date : null, name: str(x && x.name, 60) || null }))
    .filter(x => x.n !== null && x.eps)
    .sort((a, b) => a.n - b.n);
  const ep = (e) => (e && int(e.season_number, 1, MAX_SEASONS) && int(e.episode_number, 1, MAX_EPS)
    ? { s: e.season_number, e: e.episode_number, air: DATE.test(String(e.air_date)) ? e.air_date : null } : null);
  return {
    status: str(r.status, 40) || null,
    seasons,
    last: ep(r.last_episode_to_air),
    next: ep(r.next_episode_to_air),
    at: now,
  };
}

const returning = (show) => !!(show && (show.next || RETURNING.includes(show.status)));

// How many episodes of each season have aired: all of them before the last
// aired one's season, up to it in that season, none after.
function airedIn(show, n) {
  const sea = show && show.seasons.find(x => x.n === n);
  if (!sea) return 0;
  const last = show.last;
  if (!last) return show.status === 'Ended' || show.status === 'Canceled' ? sea.eps : 0;
  if (n < last.s) return sea.eps;
  if (n === last.s) return Math.min(sea.eps, last.e);
  return 0;
}

// The seen map, cleaned: whole numbers, inside a season the show has, inside
// its episode count, sorted, no repeats.
function cleanSeen(seen, show) {
  const out = {};
  if (!seen || typeof seen !== 'object' || !show) return out;
  for (const sea of show.seasons) {
    const list = Array.isArray(seen[sea.n]) ? seen[sea.n] : Array.isArray(seen[String(sea.n)]) ? seen[String(sea.n)] : [];
    const kept = [...new Set(list.filter(e => int(e, 1, sea.eps) !== null))].sort((a, b) => a - b);
    if (kept.length) out[sea.n] = kept;
  }
  return out;
}

// Where you are: counts, what is next, and whether that is everything.
//
// THE SEASON YOU CHOSE IS WHERE YOU ARE (`rec.season`). Next is the first
// unwatched episode from that season ON — so somebody starting at season 3
// is told S3 E1 next, not S1 E1, and stays in season 3 until it is done, when
// next moves on to season 4. Seasons before it are simply not asked about.
// With no season chosen, you are wherever the first unwatched episode is.
function progress(rec, show) {
  if (!show || !show.seasons.length) return null;
  const seen = cleanSeen(rec && rec.seen, show);
  let total = 0, got = 0;
  const firstIn = {};
  const seasons = show.seasons.map((sea) => {
    const aired = airedIn(show, sea.n);
    const mine = (seen[sea.n] || []).filter(e => e <= aired);
    total += aired;
    got += mine.length;
    for (let e = 1; e <= aired; e++) if (!mine.includes(e)) { firstIn[sea.n] = e; break; }
    return { n: sea.n, eps: sea.eps, aired, seen: mine.length };
  });
  const chosen = rec && show.seasons.some(x => x.n === rec.season) ? rec.season : null;
  const ahead = seasons.filter(x => firstIn[x.n] && (chosen === null || x.n >= chosen))[0] || null;
  const next = ahead ? { s: ahead.n, e: firstIn[ahead.n] } : null;
  const all = total > 0 && got === total;
  const lastAired = seasons.filter(x => x.aired).pop();
  return {
    seen: got, total, next, seasons,
    // The season on screen: the one chosen, else where next is, else the last one out.
    season: chosen !== null ? chosen : next ? next.s : (lastAired || seasons[0]).n,
    all,
    finished: all && !returning(show),
    caughtUp: all && returning(show),
    // Seasons were skipped, and everything from the chosen one on is watched:
    // the end of the show for these two, though not every episode of it.
    reachedEnd: !all && !next && got > 0,
    coming: show.next ? { s: show.next.s, e: show.next.e, air: show.next.air } : null,
  };
}

// Choose the season you are in. Null when it is not a season of this show.
const pickSeason = (show, n) => (show && show.seasons.some(x => x.n === n) ? n : null);

// One episode, or every aired episode of a season (`e` left out), seen or not.
function mark(rec, show, { s, e = null, seen = true }) {
  const out = cleanSeen(rec && rec.seen, show);
  const aired = airedIn(show, s);
  if (!aired) return null;
  const set = new Set(out[s] || []);
  const which = e === null ? Array.from({ length: aired }, (_, i) => i + 1) : [e];
  if (e !== null && (int(e, 1, aired) === null)) return null;   // not out yet, or not an episode
  for (const x of which) { if (seen) set.add(x); else set.delete(x); }
  const list = [...set].sort((a, b) => a - b);
  if (list.length) out[s] = list; else delete out[s];
  return out;
}

/* ── TMDB ───────────────────────────────────────────────────────────────── */

// In memory: a show's shape for six hours, a season's episode names for a day.
const shows = new Map();
const seasonsCache = new Map();
const SHOW_TTL = 6 * 3600e3, SEASON_TTL = 24 * 3600e3;

async function fetchShow(tmdbId, { get, now = Date.now() } = {}) {
  const id = Number(tmdbId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const hit = shows.get(id);
  if (hit && now - hit.at < SHOW_TTL) return hit.value;
  try {
    const value = shapeShow(await get(`/tv/${id}`, {}), now);
    if (!value || !value.seasons.length) return null;
    shows.set(id, { value, at: now });
    if (shows.size > 300) shows.delete(shows.keys().next().value);
    return value;
  } catch (e) {
    console.error('episodes:', e.message);
    return null;
  }
}

async function fetchSeason(tmdbId, n, { get, now = Date.now() } = {}) {
  const id = Number(tmdbId), s = Number(n);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(s) || s < 1 || s > MAX_SEASONS) return null;
  const k = `${id}:${s}`;
  const hit = seasonsCache.get(k);
  if (hit && now - hit.at < SEASON_TTL) return hit.value;
  try {
    const r = await get(`/tv/${id}/season/${s}`, {});
    const value = (Array.isArray(r && r.episodes) ? r.episodes : [])
      .map(x => ({ e: int(x && x.episode_number, 1, MAX_EPS), name: str(x && x.name, 120) || null,
        air: DATE.test(String(x && x.air_date)) ? x.air_date : null, runtime: int(x && x.runtime, 1, 600) }))
      .filter(x => x.e !== null)
      .sort((a, b) => a.e - b.e);
    seasonsCache.set(k, { value, at: now });
    if (seasonsCache.size > 600) seasonsCache.delete(seasonsCache.keys().next().value);
    return value;
  } catch (e) {
    console.error('episodes:', e.message);
    return null;
  }
}

module.exports = { RETURNING, shapeShow, returning, airedIn, cleanSeen, progress, pickSeason, mark, fetchShow, fetchSeason };
