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
      // Which OpenStreetMap object it is — "N123", "W45", "R6" — when it was
      // picked rather than typed. The one stable handle on a place: the details
      // a place page shows (hours, website) are fetched fresh by it and never
      // stored. Strictly shaped, because it ends up in a lookup URL.
      const osm = /^[NWR][1-9]\d{0,18}$/.test(String(raw.osm || '')) ? String(raw.osm) : null;
      const pinned = lat !== null && lon !== null;
      return {
        name,
        lat: pinned ? lat : null,
        lon: pinned ? lon : null,
        address: str(raw.address, 200) || null,
        // A neighbourhood and what sort of place it is ("Georgetown", "jazz
        // club"), for the line under a row. OSM's, so only alongside a pin.
        area: pinned ? str(raw.area, 60) || null : null,
        what: pinned ? str(raw.what, 40) || null : null,
        osm: pinned ? osm : null,
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

/* ── recipe ─────────────────────────────────────────────────────────────────
   What a recipe IS, read from its page (schema.org JSON-LD) or from text
   somebody pasted — lib/recipe.js does the reading, and this gate is what
   stands between a stranger's web page and the store. Every string is capped,
   every number range-checked, the image is a name in data/img/ and nothing
   else, and a unit is one of a fixed table or nothing.

   Nobody TYPES this slice, so the recipe kind's `mods` stays ['link']: `mods`
   is what the sheet offers. The gate keeps it whatever the kind, so moving a
   recipe to another tab drops nothing — a kind suggests, it never confiscates. */
MODULES.push({
  id: 'recipe',
  label: 'Recipe',
  clean(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const UNITS = require('./recipe').UNITS;
    const int = (v, lo, hi) => { const n = num(v, lo, hi); return n === null ? null : Math.round(n); };
    const ings = (Array.isArray(raw.ingredients) ? raw.ingredients : []).slice(0, 60).map((x) => {
      const o = x && typeof x === 'object' ? x : {};
      const text = str(o.text, 300);
      if (!text) return null;
      const q = num(o.q, 0.001, 100000);
      const q2 = q === null ? null : num(o.q2, 0.001, 100000);
      return {
        text,
        q,
        q2: q2 !== null && q2 > q ? q2 : null,
        unit: UNITS.includes(o.unit) ? o.unit : null,
        name: str(o.name, 120),
        note: str(o.note, 120) || null,
      };
    }).filter(Boolean);
    const steps = (Array.isArray(raw.steps) ? raw.steps : []).slice(0, 40).map((x) => {
      const o = x && typeof x === 'object' ? x : {};
      const text = str(o.text, 1500);
      if (!text) return null;
      return {
        text,
        timers: (Array.isArray(o.timers) ? o.timers : []).slice(0, 4).map(t => ({
          secs: int(t && t.secs, 5, 21600),
          label: str(t && t.label, 24) || 'Timer',
        })).filter(t => t.secs !== null),
        uses: [...new Set((Array.isArray(o.uses) ? o.uses : [])
          .map(i => int(i, 0, ings.length - 1)).filter(i => i !== null))].slice(0, 20),
      };
    }).filter(Boolean);
    if (!ings.length && !steps.length) return null;
    const y = raw.yield && typeof raw.yield === 'object' ? raw.yield : null;
    const yn = y ? int(y.n, 1, 100) : null;
    return {
      name: str(raw.name, 200) || null,
      site: str(raw.site, 60) || null,
      // A name in data/img/ and nothing else: this ends up in an <img src>.
      image: /^[a-f0-9]{24}\.(jpg|png|webp)$/.test(String(raw.image || '')) ? String(raw.image) : null,
      yield: yn ? { n: yn, unit: str(y.unit, 20) || 'servings' } : null,
      prep: int(raw.prep, 0, 2880),
      cook: int(raw.cook, 0, 2880),
      total: int(raw.total, 0, 2880),
      ingredients: ings,
      steps,
      from: raw.from === 'paste' ? 'paste' : 'page',
      readAt: num(raw.readAt, 0, 1e15),
      readBy: str(raw.readBy, 80) || null,
    };
  },
});

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
