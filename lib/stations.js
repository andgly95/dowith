// Where somebody sets out from: their nearest station, or a few. Typed in by a
// person, never measured — this app does not know where anybody is, and this is
// not a way for it to find out. A station is as coarse as a neighbourhood, and
// it is what suggestions use to say how long it would take each of you to get
// somewhere (lib/suggest.js, lib/transit.js).
//
// WHO MAY SEE IT is the same narrow rule as a kitchen, for the same reason: it
// says something about where you live. Yourself, and anyone you share a PAIR
// list with — not the people you only know from a group list. They may set it
// for you too, as they may change your pantry, and `by` records whose hand it
// was. Every route that names a person answers 404 when this is false.
//
// PURE.
const kitchen = require('./kitchen');
const transit = require('./transit');

const MAX = 3;
const canSee = (viewer, owner, spaces) => kitchen.canUse(viewer, owner, spaces);

const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// Whatever was sent → up to three stations, each a name and a real point.
function clean(raw) {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!x || typeof x !== 'object') continue;
    const lat = Number(x.lat), lon = Number(x.lon);
    const name = str(x.name, 80);
    if (!name || !transit.onEarth(lat, lon)) continue;
    const key = `${name.toLowerCase()}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: str(x.id, 80) || null,
      name,
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      modes: (Array.isArray(x.modes) ? x.modes : []).filter(m => transit.MODES.includes(m)).slice(0, 6),
      area: str(x.area, 40) || null,
    });
    if (out.length === MAX) break;
  }
  return out;
}

const of = (state, uid) => (((state.stations || {})[uid] || {}).list) || [];

function set(state, owner, raw, by, now = Date.now()) {
  if (!state.stations || typeof state.stations !== 'object') state.stations = {};
  const list = clean(raw);
  if (list.length) state.stations[owner] = { list, by, at: now };
  else delete state.stations[owner];
  return list;
}

// The people in a list, as one of them may know them: a name for everybody, and
// stations only for those this viewer may see (null otherwise — not "none set",
// which would itself be saying something).
function peopleFor(state, memberIds, viewer, spaces, nameOf) {
  return memberIds.map((id) => {
    const may = canSee(viewer, id, spaces);
    return { id, name: nameOf(id), mine: id === viewer, stations: may ? of(state, id) : null, canSet: may };
  });
}

module.exports = { MAX, canSee, clean, of, set, peopleFor };
