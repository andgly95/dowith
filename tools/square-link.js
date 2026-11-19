// Link an account here to a person in the Square, so the Square's ⊞ Do With tile
// signs them straight into their own lists. Server-side only, like tools/link.js:
// shell access to the box is the credential, and this is the explicit claim the
// Square bridge needs (lib/square.js) — made by the person who runs both.
//
//   node tools/square-link.js link:andrew andrew      # <account here> <Square person id>
//   node tools/square-link.js --unlink link:andrew
//
// Somebody who taps the tile with no link yet is asked or given a new account
// instead; this is for people who were here first.
//
// IMPORTANT: run it with the server STOPPED. The server holds the whole store in
// memory and writes it on the next change, so an edit made underneath a live
// process is silently lost. The guard below checks the port, because this app is
// not always run under systemd.
const net = require('net');
const store = require('../store');
const square = require('../lib/square');
const { state } = store;

const PORT = Number(process.env.PORT) || 3006;

function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

(async () => {
  if (await listening(PORT) && !process.env.ALLOW_LIVE) {
    console.error(`Something is listening on ${PORT} — stop the server first, or this write will be lost.`);
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const unlink = args[0] === '--unlink';
  const [uid, sub] = unlink ? args.slice(1) : args;
  const u = uid && state.users[uid];
  if (!u) {
    console.error('usage: node tools/square-link.js <account id here> <Square person id>\n'
      + '       node tools/square-link.js --unlink <account id here>\n'
      + `accounts: ${Object.keys(state.users).join(', ')}`);
    process.exit(1);
  }
  if (unlink) {
    u.square = null;
    store.flushSync();
    console.log(`  ${uid} is no longer linked to the Square`);
    return;
  }
  if (!sub || !/^[A-Za-z0-9_-]{1,64}$/.test(sub)) {
    console.error('a Square person id looks like `andrew`');
    process.exit(1);
  }
  const claims = { iss: square.tenant(), sub };
  // One account per Square person: the tile has to know whose lists to open.
  const other = Object.values(state.users).find(x => x !== u && square.isLinkedTo(x, claims));
  if (other) {
    console.error(`${other.id} is already linked to ${sub} — unlink it first.`);
    process.exit(1);
  }
  u.square = square.linkOf(claims);
  store.flushSync();
  console.log(`  ${uid} ↔ ${claims.iss}/${sub}`);
})();
