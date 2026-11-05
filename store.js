// JSON-file-backed store — debounced atomic writes, sync flush on SIGTERM. The
// same machinery as the workout and trips apps; only the schema differs.
const fs = require('fs');
const path = require('path');

const FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');

function defaultState() {
  return {
    // Google `sub` (or `cf:<sub>`) -> the person. Same identity model as the
    // workout app, ported wholesale because it is tested and this is not the
    // place to have a second opinion about sessions.
    users: {},
    // A space holds people. Two, usually — see lib/spaces.js for why that is the
    // shape and why groups still fit inside it.
    spaces: [],
    // Flat, with a spaceId. Flat because a `public` item has to be findable from
    // OUTSIDE its own space, and nesting would make that a scan of everything.
    items: [],
    // One-shot codes. The only way anybody gets an account or joins a space.
    invites: [],
    // Geocode cache, shared across everybody — a place's coordinates are not
    // anybody's private business, and looking one up twice is rude to OSM.
    places: {},
    // The pleasure inventory, keyed by PAIR of people (sorted ids joined by
    // '|'), never by list — see lib/pleasure.js. Served by two routes only.
    pleasure: {},
    seq: 1,
  };
}

let state;
// Set by the load-time migration below, written out once the atomic flush is
// defined. Migrating in memory and waiting for the next ordinary mutation to
// persist it means the file on disk disagrees with the running process until
// somebody happens to tick something off — and re-migrates on every restart in
// the meantime.
let migrated = 0;
try {
  state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  // Backfill any container added since this store was written. On LOAD only —
  // a container created anywhere else would be missing from every store written
  // since the last restart, which is a bug the trips app shipped once.
  for (const [k, v] of Object.entries(defaultState())) if (state[k] === undefined) state[k] = v;
  // A tag that was standing in for a kind becomes the kind.
  //
  // The tags in this list were literally `Films`, `Shows` and `Recipes` —
  // people were already using tags as kinds, which is most of the argument for
  // making kinds real. The tag is dropped once it has been honoured, because
  // leaving it behind means a row carrying a label nothing renders.
  //
  // On LOAD only, and idempotent: it touches nothing that already has a kind,
  // and a tag that maps to nothing (`rainy day`) is left exactly where it is.
  {
    const kinds = require('./lib/kinds');
    let moved = 0;
    for (const it of state.items || []) {
      // `thing` was the default before it was renamed to `activity`. Normalised
      // here as well as in `kinds.clean`, so the file on disk says what the app
      // says rather than relying on every reader to translate.
      if (it.kind === 'thing') { it.kind = kinds.DEFAULT; moved++; }
      if (it.kind && it.kind !== kinds.DEFAULT) continue;
      const tags = Array.isArray(it.tags) ? it.tags : [];
      const hit = tags.map(t => kinds.fromTag(t)).find(Boolean);
      if (!hit) continue;
      it.kind = hit;
      it.tags = tags.filter(t => !kinds.fromTag(t));
      moved++;
    }
    // stderr, not stdout: `tools/link.js` prints a sign-in code on stdout and
    // something reads it from there. A diagnostic that lands in the middle of
    // real output is a bug waiting for whoever parses it next.
    if (moved) console.error(`migrated ${moved} tagged item${moved === 1 ? '' : 's'} to kinds`);
    migrated = moved;
  }
} catch (e) {
  if (e.code !== 'ENOENT') {
    const backup = `${FILE}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(FILE, backup); } catch (_) {}
    console.error(`store load failed (${e.message}) — saved bad file to ${backup}, starting fresh`);
  }
  state = defaultState();
}

let writeTimer = null;
function save() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const tmp = `${FILE}.tmp`;
    fs.writeFile(tmp, JSON.stringify(state), (err) => {
      if (err) return console.error('store write failed:', err.message);
      fs.rename(tmp, FILE, (err2) => {
        if (err2) console.error('store rename failed:', err2.message);
      });
    });
  }, 250);
}

// A debounced write that has cleared its timer but not yet hit disk is exactly
// what a SIGTERM lands in the middle of, and `systemctl restart` sends SIGTERM.
// This always writes rather than only when a timer is pending.
function flushSync() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const tmp = `${FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('store flush failed:', err.message);
  }
}
// Persist the migration now rather than on the next ordinary write.
if (migrated) flushSync();

process.on('SIGTERM', () => { flushSync(); process.exit(0); });
process.on('SIGINT', () => { flushSync(); process.exit(0); });

const nextId = (prefix) => `${prefix}${state.seq++}`;

try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch (_) {}

module.exports = { state, save, nextId, flushSync, defaultState, FILE };
