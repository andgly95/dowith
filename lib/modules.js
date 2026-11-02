// The seam features hang off.
//
// This is NOT a plugin framework, and resisting that is the point. A framework
// written before there are two real implementations of anything is a guess about
// what the second one will need, and it is always wrong in a way you only find
// out when you write the third. What this is instead: one narrow, boring
// contract that a feature can add itself to without touching the item gate, the
// wire, or any route.
//
// A module owns a namespaced slice of an item — `item.mod[<id>]` — and the only
// thing it must supply is a `clean(raw)` that returns its slice or null. That
// keeps the app's central discipline intact: everything entering the store passes
// through a gate, a field the gate doesn't know is dropped, so ADD IT HERE FIRST.
// Nothing in `mod` is ever trusted, rendered raw, or persisted unvalidated.
//
// What a module deliberately CANNOT do: change who can see an item. Visibility is
// lib/spaces.js and nowhere else. A map module that could quietly widen an
// audience is how a private thing ends up on someone's screen.

const str = (v, max) => String(v == null ? '' : v).slice(0, max).trim();

function num(v, lo, hi) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return null;
  return n;
}

const MODULES = [
  /* ── place ────────────────────────────────────────────────────────────────
     The first module, and it exists to prove the seam is real rather than
     theoretical: a map view is just a renderer over items that happen to carry
     one of these. Coordinates are range-checked before they are stored, the same
     lesson the trips app learned the hard way — a hallucinated or fat-fingered
     one puts a pin in the sea forever, and it is far easier to refuse it on the
     way in than to find it later. */
  {
    id: 'place',
    label: 'Place',
    clean(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const name = str(raw.name, 120);
      const lat = num(raw.lat, -90, 90);
      const lon = num(raw.lon, -180, 180);
      // A name on its own is a perfectly good place ("that ramen bar in Adams
      // Morgan"). Coordinates without one are not, and half a coordinate pair is
      // nothing at all.
      if (!name) return null;
      return {
        name,
        lat: lat !== null && lon !== null ? lat : null,
        lon: lat !== null && lon !== null ? lon : null,
        address: str(raw.address, 200) || null,
      };
    },
  },

  /* ── link ─────────────────────────────────────────────────────────────────
     A URL and what it turned out to be. Second module on purpose: two is the
     smallest number that shows whether the contract generalises, and this one
     wants different fields and a different renderer from `place`. */
  {
    id: 'link',
    label: 'Link',
    clean(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const url = str(raw.url, 500);
      // http(s) only. A `javascript:` or `data:` URL rendered into an href is a
      // script-injection with extra steps, and this app shows other people's
      // items to you.
      if (!/^https?:\/\/[^\s]+$/i.test(url)) return null;
      return { url, title: str(raw.title, 160) || null, site: str(raw.site, 80) || null };
    },
  },
  /* ── watch ────────────────────────────────────────────────────────────────
     What a film or a show IS, according to TMDB: the poster, the year, and
     where it is streaming. Third module, and the first one nothing types by
     hand — `lib/watch.js` fills it in and this gate is what stands between
     TMDB's answer and the store.

     The poster is a PATH, never a URL. Sizes are a rendering decision, and
     baking one in means re-fetching everything the day the card changes size. */
  {
    id: 'watch',
    label: 'Watch',
    clean(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const id = num(raw.tmdbId, 1, 1e12);
      const media = raw.mediaType === 'tv' || raw.mediaType === 'movie' ? raw.mediaType : null;
      if (!id || !media) return null;
      // A TMDB path, and nothing that is not one. This ends up in an <img src>,
      // and the app shows other people's items to you.
      const path = (v) => (/^\/[A-Za-z0-9._-]{1,110}$/.test(String(v || '')) ? String(v) : null);
      return {
        tmdbId: id,
        mediaType: media,
        title: str(raw.title, 200) || null,
        year: num(raw.year, 1870, 2200),
        poster: path(raw.poster),
        providers: (Array.isArray(raw.providers) ? raw.providers : [])
          .slice(0, 4)
          .map(p => ({ name: str(p && p.name, 40), logo: path(p && p.logo) }))
          .filter(p => p.name),
      };
    },
  },
];

const byId = new Map(MODULES.map(m => [m.id, m]));

// Clean the whole `mod` bag. Unknown ids are dropped rather than passed through,
// so a client from the future cannot write fields this server has no rules for.
function cleanMods(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [id, slice] of Object.entries(raw)) {
    const m = byId.get(id);
    if (!m) continue;
    const cleaned = m.clean(slice);
    if (cleaned) out[id] = cleaned;
  }
  return out;
}

// What the client is told exists. Ids and labels only — the rules stay here.
const manifest = () => MODULES.map(m => ({ id: m.id, label: m.label }));

module.exports = { MODULES, byId, cleanMods, manifest };
