// Mint sign-in links. Server-side only, on purpose — there is no HTTP route that
// issues one, so possessing shell access to the box is the credential.
//
//   node tools/link.js "Andrew" "Linnea"
//
// Creates whoever is missing, puts them in a list together, and prints a link
// each. Re-running is safe: people are matched by name and nothing is duplicated.
// IMPORTANT: run this with the service STOPPED. The server holds the whole store
// in memory and writes it out on the next mutation, so a tool that edits the file
// underneath a live process gets silently clobbered — and worse, the users it just
// created are invisible to the running server, so the links 404. Found the hard
// way; the guard below makes it impossible to repeat.
const { execSync } = require('child_process');
const store = require('../store');
const magic = require('../lib/magic');
const { state } = store;

try {
  if (execSync('systemctl is-active dowith 2>/dev/null || true').toString().trim() === 'active'
      && !process.env.ALLOW_LIVE) {
    console.error('dowith is running — stop it first, or this write will be lost:\n'
      + '  sudo systemctl stop dowith && node tools/link.js ... && sudo systemctl start dowith');
    process.exit(1);
  }
} catch (_) { /* not a systemd box; carry on */ }

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

// A short code as well as the signed link. The signed one is unforgeable and
// stateless, which is why it is 200 characters — fine to click, useless to type
// at a phone. The short one is stored, so it can be eight characters, and it
// buys that back with a thirty-minute life and a single use.
const out = ids.map((id, i) => ({
  name: names[i],
  code: magic.mintCode(state, id).code,
  link: `${BASE}/login/${magic.mint(id)}`,
}));

store.flushSync();

const qrcode = require('qrcode');

(async () => {
  for (const o of out) {
    const short = `${BASE}/l/${o.code}`;
    console.log(`\n──────── ${o.name} ────────\n`);
    console.log(`  type it:  ${short}`);
    console.log(`  or scan:\n`);
    console.log(await qrcode.toString(short, { type: 'terminal', small: true, errorCorrectionLevel: 'L' }));
    console.log(`  long link (click from a desktop, lasts a week):\n    ${o.link}`);
  }
  console.log('\nCodes are good for 30 minutes and work once — but OPENING one does');
  console.log('nothing until the button is tapped, so it is safe to check the link');
  console.log('yourself, and safe to send through anything that makes preview cards.');
})();
