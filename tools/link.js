// Mint sign-in links. Server-side only, on purpose — there is no HTTP route that
// issues one, so possessing shell access to the box is the credential.
//
//   node tools/link.js "Andrew" "Linnea"
//
// Creates whoever is missing, puts them in a list together, and prints a link
// each. Re-running is safe: people are matched by name and nothing is duplicated.
const store = require('../store');
const magic = require('../lib/magic');
const { state } = store;

const BASE = process.env.BASE_URL || 'https://dowith.guess-ai.app';
const names = process.argv.slice(2);
if (names.length < 1) {
  console.error('usage: node tools/link.js "Name" ["Other name" ...]');
  process.exit(1);
}

const slug = (n) => `link:${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const ids = names.map((name) => {
  const id = slug(name);
  if (!state.users[id]) {
    state.users[id] = {
      id, email: null, name, picture: null, via: 'link',
      square: null, createdAt: Date.now(), lastSeen: Date.now(),
    };
    console.log(`  created ${name}`);
  }
  return id;
});

// One list holding everybody named, if they aren't already sharing one.
if (ids.length > 1) {
  const already = state.spaces.find(s =>
    s.memberIds.length === ids.length && ids.every(i => s.memberIds.includes(i)));
  if (!already) {
    state.spaces.push({
      id: store.nextId('sp'),
      name: ids.length > 2 ? names.join(', ') : null,
      memberIds: ids,
      createdBy: ids[0],
      createdAt: Date.now(),
    });
    console.log(`  made a list for ${names.join(' + ')}`);
  }
}

store.flushSync();

console.log('\nOne each — good for a week, and each one works once:\n');
for (let i = 0; i < ids.length; i++) {
  console.log(`  ${names[i]}:\n    ${BASE}/login/${magic.mint(ids[i])}\n`);
}
