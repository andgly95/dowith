// Characterization suite. Layer 1 exercises the pure rules directly; layer 2
// boots a real server against a throwaway store and drives the API.
//
// The visibility section is the one that matters. Everything else here is a
// feature; that is the promise — a private thing stays private — and it is the
// only part of this app that cannot be fixed after somebody notices.
const assert = require('assert');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Before anything requires lib/config, which resolves its path once at load. A
// test suite must not write into the thing it is testing.
process.env.CONFIG_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'dw-suite-')), 'config.json');

const SP = require('../lib/spaces');
const ITEMS = require('../lib/items');
const MODULES = require('../lib/modules');
const INVITES = require('../lib/invites');
const SQUARE = require('../lib/square');
const MAGIC = require('../lib/magic');

let pass = 0;
const fails = [];
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ok   ${name}`); })
    .catch((e) => { fails.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); });
}

/* ── 1. who can see what ─────────────────────────────────────────────────── */

async function visibility() {
  console.log('\nvisibility');

  // Andrew + Linnea, and Andrew + Sam. Linnea and Sam share nothing.
  const spaces = [
    { id: 'sp1', memberIds: ['andrew', 'linnea'] },
    { id: 'sp2', memberIds: ['andrew', 'sam'] },
    { id: 'sp3', memberIds: ['linnea', 'mum'] },
  ];
  const item = (vis, author = 'andrew', spaceId = 'sp1') =>
    ({ id: 'i', spaceId, authorId: author, visibility: vis });

  await t('private is the author and nobody else, ever', () => {
    const it = item('private');
    assert.strictEqual(SP.canSee(it, 'andrew', spaces), true);
    assert.strictEqual(SP.canSee(it, 'linnea', spaces), false, 'not even the person it is about');
    assert.strictEqual(SP.canSee(it, 'sam', spaces), false);
    assert.strictEqual(SP.canSee(it, 'mum', spaces), false);
  });

  await t('shared is exactly the people in that list', () => {
    const it = item('shared');
    assert.strictEqual(SP.canSee(it, 'andrew', spaces), true);
    assert.strictEqual(SP.canSee(it, 'linnea', spaces), true);
    assert.strictEqual(SP.canSee(it, 'sam', spaces), false, 'a different list is a different room');
  });

  await t('public reaches everyone you share any list with — and stops there', () => {
    const it = item('public');
    assert.strictEqual(SP.canSee(it, 'linnea', spaces), true);
    assert.strictEqual(SP.canSee(it, 'sam', spaces), true, 'even though it was written with Linnea');
    assert.strictEqual(SP.canSee(it, 'mum', spaces), false,
      'mum knows Linnea, not Andrew — public is your circle, not the transitive one');
  });

  await t('a public wish surfaces in the author\'s OTHER lists', () => {
    const all = [item('private'), item('shared'), item('public')];
    const inSam = SP.visibleIn(all, spaces[1], 'sam', spaces).map(i => i.visibility);
    assert.deepStrictEqual(inSam, ['public'],
      'Sam sees the standing wish written with Linnea, and nothing else of hers');
  });

  await t('a shared item does not leak once its author has left the list', () => {
    // Andrew wrote it with Linnea, then left. Linnea is still a member.
    const gone = [{ id: 'sp1', memberIds: ['linnea'] }];
    assert.strictEqual(SP.canSee(item('shared'), 'linnea', gone), false,
      'shared means "the two of us", and there is no longer a two of us');
  });

  await t('an unknown visibility is treated as the most restrictive thing', () => {
    // A typo, a future value, a hand-written request — none of it may widen an
    // audience. Failing open here is the whole class of bug this app cannot have.
    for (const v of ['Public', 'PUBLIC', 'everyone', '', null, undefined, 'shared ']) {
      assert.strictEqual(SP.canSee(item(v), 'linnea', spaces), false, `visibility ${JSON.stringify(v)}`);
    }
  });

  await t('an item in a space that no longer exists is visible to nobody but its author', () => {
    const it = item('shared', 'andrew', 'deleted-space');
    assert.strictEqual(SP.canSee(it, 'linnea', spaces), false);
    assert.strictEqual(SP.canSee(it, 'andrew', spaces), true);
  });

  await t('editing is the author\'s alone; ticking off is anyone who can see it', () => {
    const shared = item('shared');
    assert.strictEqual(SP.canEdit(shared, 'linnea'), false, 'the sentence stays yours');
    assert.strictEqual(SP.canComplete(shared, 'linnea', spaces), true, 'but doing it is the point');
    const priv = item('private');
    assert.strictEqual(SP.canComplete(priv, 'linnea', spaces), false, 'nothing about a private one');
    assert.strictEqual(SP.canComplete(priv, 'andrew', spaces), true);
  });

  await t('your circle is the union of your lists, minus you', () => {
    assert.deepStrictEqual([...SP.circleOf(spaces, 'andrew')].sort(), ['linnea', 'sam']);
    assert.deepStrictEqual([...SP.circleOf(spaces, 'linnea')].sort(), ['andrew', 'mum']);
    assert.deepStrictEqual([...SP.circleOf(spaces, 'nobody')], []);
  });

  await t('a list is named from the side you are standing on', () => {
    const name = (id) => ({ andrew: 'Andrew', linnea: 'Linnea', sam: 'Sam', mum: 'Mum' }[id]);
    assert.strictEqual(SP.titleFor(spaces[0], 'andrew', name), 'Linnea');
    assert.strictEqual(SP.titleFor(spaces[0], 'linnea', name), 'Andrew', 'the same list, mirrored');
    // A group carries its own name; without one it lists who is in it.
    const crew = { id: 'g', name: 'Ski trip crew', memberIds: ['andrew', 'sam', 'linnea'] };
    assert.strictEqual(SP.titleFor(crew, 'andrew', name), 'Ski trip crew');
    assert.strictEqual(SP.titleFor({ ...crew, name: null }, 'andrew', name), 'Sam and Linnea');
    assert.strictEqual(
      SP.titleFor({ id: 'g', memberIds: ['a', 'b', 'c', 'd', 'e'] }, 'a', (x) => x.toUpperCase()),
      'B, C and 2 more');
    assert.strictEqual(SP.titleFor({ id: 'x', memberIds: ['andrew'] }, 'andrew', name), 'Just you');
  });

  await t('visibleIn refuses a list you are not in, whatever the items say', () => {
    const all = [item('public'), item('shared')];
    assert.deepStrictEqual(SP.visibleIn(all, spaces[0], 'sam', spaces), [],
      'membership is checked before anything else is considered');
  });
}

/* ── 2. the gate ─────────────────────────────────────────────────────────── */

async function gate() {
  console.log('\nthe item gate');

  const ctx = { id: 'i1', authorId: 'andrew', spaceId: 'sp1', now: 1000 };

  await t('an item needs a title and nothing else', () => {
    assert.strictEqual(ITEMS.cleanItem({ title: '   ' }, ctx), null);
    assert.strictEqual(ITEMS.cleanItem({}, ctx), null);
    const it = ITEMS.cleanItem({ title: 'Go record shopping' }, ctx);
    assert.strictEqual(it.title, 'Go record shopping');
    assert.strictEqual(it.done, false);
  });

  await t('the default is shared, because this is a list you keep WITH someone', () => {
    assert.strictEqual(ITEMS.cleanItem({ title: 'x' }, ctx).visibility, 'shared');
    // A default of private would quietly make the app a diary.
    assert.strictEqual(ITEMS.cleanItem({ title: 'x', visibility: 'nonsense' }, ctx).visibility, 'shared');
    assert.strictEqual(ITEMS.cleanItem({ title: 'x', visibility: 'private' }, ctx).visibility, 'private');
  });

  await t('author and space come from the CALLER, never from the body', () => {
    const it = ITEMS.cleanItem(
      { title: 'x', authorId: 'somebody-else', spaceId: 'their-space', id: 'chosen', done: true }, ctx);
    assert.strictEqual(it.authorId, 'andrew', 'you cannot sign an item with another name');
    assert.strictEqual(it.spaceId, 'sp1', 'or write it into another list');
    assert.strictEqual(it.id, 'i1');
    assert.strictEqual(it.done, false, 'or arrive pre-completed');
  });

  await t('a patch cannot move an item or reassign it', () => {
    const it = ITEMS.cleanItem({ title: 'x' }, ctx);
    ITEMS.applyPatch(it, { authorId: 'mallory', spaceId: 'elsewhere', id: 'other', createdAt: 0, done: true });
    assert.strictEqual(it.authorId, 'andrew');
    assert.strictEqual(it.spaceId, 'sp1');
    assert.strictEqual(it.id, 'i1');
    assert.strictEqual(it.createdAt, 1000);
    assert.strictEqual(it.done, false, 'done is its own operation — who ticked it is part of the record');
  });

  await t('a patch that would leave it nameless is refused whole', () => {
    const it = ITEMS.cleanItem({ title: 'Keep me' }, ctx);
    assert.strictEqual(ITEMS.applyPatch(it, { title: '  ' }), null);
    assert.strictEqual(it.title, 'Keep me', 'and changes nothing');
  });

  await t('tags are folded and capped so a filter cannot show half of what it should', () => {
    const it = ITEMS.cleanItem({ title: 'x', tags: ['Records', 'records', ' RECORDS ', 'dc', ''] }, ctx);
    assert.deepStrictEqual(it.tags, ['records', 'dc']);
    assert.strictEqual(ITEMS.cleanItem({ title: 'x', tags: Array(50).fill(0).map((_, i) => `t${i}`) }, ctx)
      .tags.length, ITEMS.MAX_TAGS);
  });

  await t('ticking off records WHO, and untickng clears it', () => {
    const it = ITEMS.cleanItem({ title: 'x' }, ctx);
    ITEMS.setDone(it, true, 'linnea', 5000);
    assert.deepStrictEqual([it.done, it.doneBy, it.doneAt], [true, 'linnea', 5000]);
    ITEMS.setDone(it, false, 'linnea', 6000);
    assert.deepStrictEqual([it.done, it.doneBy, it.doneAt], [false, null, null]);
  });
}

/* ── 3. the module seam ──────────────────────────────────────────────────── */

async function moduleSeam() {
  console.log('\nmodules');

  await t('a module the server has never heard of is dropped, not stored', () => {
    const mod = MODULES.cleanMods({ place: { name: 'Som Records' }, wormhole: { x: 1 }, __proto__: { y: 2 } });
    assert.deepStrictEqual(Object.keys(mod), ['place'],
      'a client from the future cannot write fields this server has no rules for');
  });

  await t('place: a name is enough, half a coordinate pair is not', () => {
    const m = (raw) => MODULES.cleanMods({ place: raw }).place;
    assert.strictEqual(m({ name: 'that ramen bar' }).lat, null, 'a name on its own is a fine place');
    assert.strictEqual(m({ name: 'x', lat: 38.9 }).lat, null, 'half a pair is nothing at all');
    assert.strictEqual(m({ name: 'x', lat: 38.9, lon: -77 }).lat, 38.9);
    assert.strictEqual(m({ lat: 38.9, lon: -77 }), undefined, 'coordinates with no name are not a place');
  });

  await t('place: a coordinate off the Earth is refused on the way IN', () => {
    // Far easier than finding a pin in the sea months later.
    const m = (raw) => MODULES.cleanMods({ place: raw }).place;
    assert.strictEqual(m({ name: 'x', lat: 999, lon: 0 }).lat, null);
    assert.strictEqual(m({ name: 'x', lat: 0, lon: -400 }).lat, null);
    assert.strictEqual(m({ name: 'x', lat: 'north', lon: 'west' }).lat, null);
  });

  await t('link: http(s) only — this app renders other people\'s items to you', () => {
    const m = (url) => MODULES.cleanMods({ link: { url } }).link;
    assert.ok(m('https://example.com/x'));
    assert.ok(m('http://example.com'));
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'ftp://x', 'not a url', '']) {
      assert.strictEqual(m(bad), undefined, `accepted ${JSON.stringify(bad)}`);
    }
  });

  await t('a module cannot touch visibility — that lives in one place', () => {
    const it = ITEMS.cleanItem(
      { title: 'x', visibility: 'private', mod: { place: { name: 'p', visibility: 'public' } } },
      { id: 'i', authorId: 'a', spaceId: 's' });
    assert.strictEqual(it.visibility, 'private');
    assert.strictEqual(it.mod.place.visibility, undefined,
      'a map module that could widen an audience is how a private thing ends up on a screen');
  });
}

/* ── 4. invites ──────────────────────────────────────────────────────────── */

async function inviteRules() {
  console.log('\ninvites');
  const mk = () => ({ invites: [] });

  await t('a code is unguessable, not merely unique', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(INVITES.mint());
    assert.strictEqual(seen.size, 200);
    assert.ok(INVITES.mint().length >= 12, 'long enough not to be walked');
  });

  await t('an invite works exactly once', () => {
    const st = mk();
    const inv = INVITES.create(st, { spaceId: 'sp1', createdBy: 'andrew' });
    assert.strictEqual(INVITES.redeem(st, inv.code, 'linnea').ok, true);
    const second = INVITES.redeem(st, inv.code, 'mallory');
    assert.strictEqual(second.ok, false);
    assert.ok(/already been used/.test(second.why));
  });

  await t('an invite expires, so a link in an old group chat is a dead door', () => {
    const st = mk();
    const inv = INVITES.create(st, { spaceId: 'sp1', createdBy: 'andrew', now: 0 });
    assert.strictEqual(INVITES.check(st, inv.code, INVITES.TTL_MS - 1).ok, true);
    assert.strictEqual(INVITES.check(st, inv.code, INVITES.TTL_MS + 1).ok, false);
  });

  await t('a code nobody minted is not an invite', () => {
    const st = mk();
    for (const c of ['', null, undefined, 'aaaaaaaaaaaa', '../../etc/passwd']) {
      assert.strictEqual(INVITES.check(st, c).ok, false, String(c));
    }
  });
}

/* ── 5. the Square bridge ────────────────────────────────────────────────── */

async function squareBridge() {
  console.log('\nthe square bridge');

  await t('it is plumbing, and says so rather than pretending', () => {
    const st = SQUARE.status();
    assert.strictEqual(st.configured, false, 'nothing is wired up by default');
    const imp = SQUARE.importable();
    assert.strictEqual(imp.ok, false);
    assert.strictEqual(imp.reason, 'not-implemented');
    assert.ok(/proof/.test(imp.why), 'and says WHY, so a UI can quote it');
  });

  await t('it reads people and groups, and NOTHING else', () => {
    // The Square's store holds everyone's DMs. A convenience feature must not be
    // the thing that walks them out of the building.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-sq-'));
    const f = path.join(dir, 'square.json');
    fs.writeFileSync(f, JSON.stringify({
      people: [{ id: 'andrew', name: 'Andrew', color: 'red', bio: 'secret bio' }],
      customGroups: [{ id: 'g1', name: 'Square Devs', memberIds: ['andrew'] }],
      messages: [{ text: 'PRIVATE MESSAGE' }],
      dms: { andrew: [{ text: 'PRIVATE DM' }] },
      groupMessages: { g1: [{ text: 'PRIVATE GROUP MESSAGE' }] },
    }));
    const cfg = require('../lib/config');
    cfg.set({ squareStorePath: f });
    const d = SQUARE.readPeople();
    const dumped = JSON.stringify(d);
    assert.ok(!/PRIVATE/.test(dumped), 'no message content may cross the bridge');
    assert.ok(!/secret bio/.test(dumped), 'nor anything else that was not asked for');
    assert.deepStrictEqual(d.people, [{ id: 'andrew', name: 'Andrew', avatar: null }]);
    assert.deepStrictEqual(d.groups, [{ id: 'g1', name: 'Square Devs', memberIds: ['andrew'] }]);
    assert.strictEqual(SQUARE.status().linkable, false, 'still not linkable');
    cfg.set({ squareStorePath: undefined });
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

/* ── 5b. sign-in links ───────────────────────────────────────────────────── */

async function magicLinks() {
  console.log('\nsign-in links');
  const SEC = 'link-test-secret-0123456789abcdef';
  const opts = { sec: SEC };

  await t('a minted link verifies, and carries the person it was minted for', () => {
    const r = MAGIC.verify(MAGIC.mint('u1', opts), opts);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.uid, 'u1');
  });

  await t('a link signed with another secret is not a link', () => {
    const other = MAGIC.mint('u1', { sec: 'a-completely-different-secret-00' });
    assert.strictEqual(MAGIC.verify(other, opts).ok, false);
  });

  await t('a tampered payload does not verify', () => {
    const tok = MAGIC.mint('u1', opts);
    const [payload, sig] = tok.split('.');
    const evil = Buffer.from(JSON.stringify({ p: 'link', u: 'someone-else', e: Date.now() + 1e6, n: 'x' }))
      .toString('base64url');
    assert.strictEqual(MAGIC.verify(`${evil}.${sig}`, opts).ok, false);
    assert.ok(payload.length > 10);
  });

  await t('a session cookie cannot be presented as a sign-in link', () => {
    // Both are <payload>.<sig> over the same secret. The purpose label lives
    // INSIDE the signed payload, so it cannot be edited to cross over.
    const cookie = AUTH.sign('u1', SEC);
    assert.strictEqual(MAGIC.verify(cookie, opts).ok, false, 'cookie must not open a link');
    assert.strictEqual(AUTH.verify(MAGIC.mint('u1', opts), SEC), null, 'nor the reverse');
  });

  await t('a link expires', () => {
    const tok = MAGIC.mint('u1', { ...opts, now: 0 });
    assert.strictEqual(MAGIC.verify(tok, { ...opts, now: MAGIC.TTL_MS - 1 }).ok, true);
    const late = MAGIC.verify(tok, { ...opts, now: MAGIC.TTL_MS + 1 });
    assert.strictEqual(late.ok, false);
    assert.ok(/expired/.test(late.why));
  });

  await t('a link works once — a forwarded one is a dead door', () => {
    const st = { usedLinks: [] };
    const tok = MAGIC.mint('u1', opts);
    const first = MAGIC.verify(tok, { ...opts, used: MAGIC.usedSet(st) });
    assert.strictEqual(first.ok, true);
    MAGIC.spend(st, first.nonce);
    const second = MAGIC.verify(tok, { ...opts, used: MAGIC.usedSet(st) });
    assert.strictEqual(second.ok, false);
    assert.ok(/already been used/.test(second.why));
  });

  await t('two links minted for the same person are different tokens', () => {
    assert.notStrictEqual(MAGIC.mint('u1', opts), MAGIC.mint('u1', opts),
      'each carries its own nonce, so spending one does not spend the other');
  });

  await t('the spent-nonce list is bounded', () => {
    const st = { usedLinks: [] };
    for (let i = 0; i < MAGIC.MAX_USED + 50; i++) MAGIC.spend(st, `n${i}`);
    assert.strictEqual(st.usedLinks.length, MAGIC.MAX_USED, 'an unbounded list is a slow leak');
    assert.ok(st.usedLinks.includes(`n${MAGIC.MAX_USED + 49}`), 'and it keeps the newest');
  });

  await t('junk is refused without throwing', () => {
    for (const bad of ['', 'x', 'a.b.c', null, undefined, 'not.atoken', { }]) {
      assert.strictEqual(MAGIC.verify(bad, opts).ok, false, String(bad));
    }
  });
}

/* ── 6. the API ──────────────────────────────────────────────────────────── */

const PORT = 3907;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = require('../lib/auth');
const SECRET = 'dowith-test-secret-0123456789abcd';
const A = 'u-andrew', L = 'u-linnea', S = 'u-sam';
const cookieFor = (uid) => `${AUTH.COOKIE}=${encodeURIComponent(AUTH.sign(uid, SECRET))}`;

// Sessions are signed with exactly the code the server verifies with — no
// test-only door in production, because that is how a door ships.
function api(method, p, body, as = A) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (as) headers.cookie = cookieFor(as);
  return fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function server() {
  console.log('\nserver / api');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-api-'));
  const dataFile = path.join(dir, 'store.json');
  const cfgFile = path.join(dir, 'config.json');
  const person = (id, name) => ({ id, email: `${name.toLowerCase()}@x.com`, name, createdAt: 1, lastSeen: 1 });
  fs.writeFileSync(dataFile, JSON.stringify({
    users: { [A]: person(A, 'Andrew'), [L]: person(L, 'Linnea'), [S]: person(S, 'Sam') },
    spaces: [
      { id: 'sp1', name: null, memberIds: [A, L], createdBy: A, createdAt: 1 },
      { id: 'sp2', name: null, memberIds: [A, S], createdBy: A, createdAt: 1 },
    ],
    items: [], invites: [], seq: 100,
  }));
  fs.writeFileSync(cfgFile, JSON.stringify({ sessionSecret: SECRET }), { mode: 0o600 });

  let child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile, CONFIG_FILE: cfgFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60 && child.exitCode === null; i++) {
    try { if ((await fetch(`${BASE}/api/auth/me`)).ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }

  await t('signed out, the whole data surface is 401', async () => {
    for (const [m, p] of [
      ['GET', '/api/state'], ['POST', '/api/space'], ['GET', '/api/space/sp1/items'],
      ['POST', '/api/space/sp1/item'], ['POST', '/api/space/sp1/invite'],
      ['PATCH', '/api/item/x'], ['POST', '/api/item/x/done'], ['DELETE', '/api/item/x'],
      ['GET', '/api/square/status'],
    ]) {
      const { status } = await api(m, p, m === 'GET' ? null : {}, null);
      assert.strictEqual(status, 401, `${m} ${p}`);
    }
  });

  await t('a forged or tampered cookie is not a session', async () => {
    const real = AUTH.sign(A, SECRET);
    for (const tok of [
      'nonsense',
      real.slice(0, -1) + (real.slice(-1) === 'a' ? 'b' : 'a'),
      AUTH.sign(A, 'a-completely-different-secret-000'),
    ]) {
      const r = await fetch(`${BASE}/api/state`, { headers: { cookie: `${AUTH.COOKIE}=${tok}` } });
      assert.strictEqual(r.status, 401, `accepted ${tok.slice(0, 20)}`);
    }
  });

  await t('the same list is titled from each side', async () => {
    const mine = (await api('GET', '/api/state', null, A)).body;
    const hers = (await api('GET', '/api/state', null, L)).body;
    assert.strictEqual(mine.spaces.find(s => s.id === 'sp1').title, 'Linnea');
    assert.strictEqual(hers.spaces.find(s => s.id === 'sp1').title, 'Andrew');
    assert.strictEqual(hers.spaces.length, 1, 'and she sees only the lists she is in');
  });

  await t('items land, and the three visibilities behave over the wire', async () => {
    for (const [title, visibility] of [
      ['Go record shopping', 'shared'],
      ['Watch "Obsession"', 'private'],
      ['See Khruangbin live', 'public'],
    ]) await api('POST', '/api/space/sp1/item', { title, visibility }, A);

    const mine = (await api('GET', '/api/space/sp1/items', null, A)).body.items;
    const hers = (await api('GET', '/api/space/sp1/items', null, L)).body.items;
    assert.strictEqual(mine.length, 3);
    assert.deepStrictEqual(hers.map(i => i.title).sort(),
      ['Go record shopping', 'See Khruangbin live'], 'the private one is not hers to see');

    // And the standing wish reaches Sam, in a different list entirely.
    const sams = (await api('GET', '/api/space/sp2/items', null, S)).body.items;
    assert.deepStrictEqual(sams.map(i => i.title), ['See Khruangbin live']);
    assert.strictEqual(sams[0].fromElsewhere, true, 'and is marked as arriving from elsewhere');
  });

  await t('a private item is a 404 to everyone else, not a 403', async () => {
    const priv = (await api('GET', '/api/space/sp1/items', null, A)).body.items
      .find(i => i.visibility === 'private');
    // "This exists but is not yours" is itself a disclosure.
    for (const [m, p, b] of [
      ['PATCH', `/api/item/${priv.id}`, { title: 'pwned' }],
      ['DELETE', `/api/item/${priv.id}`, null],
      ['POST', `/api/item/${priv.id}/done`, { done: true }],
    ]) {
      assert.strictEqual((await api(m, p, b, L)).status, 404, `${m} ${p}`);
    }
    const after = (await api('GET', '/api/space/sp1/items', null, A)).body.items
      .find(i => i.id === priv.id);
    assert.strictEqual(after.title, 'Watch "Obsession"', 'and it is untouched');
  });

  await t('you cannot rewrite somebody else\'s sentence, but you can tick it off', async () => {
    const shared = (await api('GET', '/api/space/sp1/items', null, L)).body.items
      .find(i => i.title === 'Go record shopping');
    assert.strictEqual(shared.canEdit, false, 'and the wire says so');
    assert.strictEqual((await api('PATCH', `/api/item/${shared.id}`, { title: 'no' }, L)).status, 403);

    const done = await api('POST', `/api/item/${shared.id}/done`, { done: true }, L);
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.body.item.doneByName, 'Linnea', 'whoever got there first gets the credit');
  });

  await t('a list you are not in does not exist as far as you are concerned', async () => {
    assert.strictEqual((await api('GET', '/api/space/sp1/items', null, S)).status, 404);
    assert.strictEqual((await api('POST', '/api/space/sp1/item', { title: 'x' }, S)).status, 404);
    assert.strictEqual((await api('POST', '/api/space/sp1/invite', {}, S)).status, 404,
      'and you certainly cannot invite people into it');
    assert.strictEqual((await api('PATCH', '/api/space/sp1', { name: 'mine now' }, S)).status, 404);
  });

  await t('an item written into a space is signed and filed by the SERVER', async () => {
    const r = await api('POST', '/api/space/sp1/item',
      { title: 'Sneaky', authorId: L, spaceId: 'sp2' }, A);
    assert.strictEqual(r.body.item.authorId, A);
    assert.strictEqual(r.body.item.spaceId, 'sp1');
  });

  await t('an invite is one-shot, and only a member can make one', async () => {
    const { body } = await api('POST', '/api/space/sp1/invite', {}, A);
    assert.ok(body.code && body.code.length >= 12);
    const look = await api('GET', `/api/invite/${body.code}`, null, null);
    assert.strictEqual(look.status, 200, 'readable signed out — the link has to explain itself');
    assert.strictEqual(look.body.from.name, 'Andrew');
    assert.strictEqual((await api('GET', '/api/invite/not-a-real-code', null, null)).status, 404);
    // What it discloses to someone holding a valid code: who sent it, and nothing
    // about what is in the list.
    assert.deepStrictEqual(Object.keys(look.body).sort(), ['from', 'note', 'ok', 'space']);
    assert.strictEqual(JSON.stringify(look.body).includes('record shopping'), false);
  });

  await t('leaving takes you out without deleting what the others kept', async () => {
    const before = (await api('GET', '/api/space/sp2/items', null, A)).body.items.length;
    await api('POST', '/api/space/sp2/leave', {}, S);
    assert.strictEqual((await api('GET', '/api/space/sp2/items', null, S)).status, 404, 'Sam is out');
    const after = await api('GET', '/api/space/sp2/items', null, A);
    assert.strictEqual(after.status, 200, 'Andrew still has it');
    assert.strictEqual(after.body.items.length, before);
  });

  await t('the Square bridge refuses over HTTP too, and says why', async () => {
    const st = await api('GET', '/api/square/status', null, A);
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.body.configured, false);
    const imp = await api('POST', '/api/square/import', {}, A);
    assert.strictEqual(imp.status, 501, 'not built is not the same as broken');
    assert.strictEqual(imp.body.reason, 'not-implemented');
  });

  await t('a sign-in link lets exactly one person in, exactly once', async () => {
    const MAGIC2 = require('../lib/magic');
    const tok = MAGIC2.mint(L, { sec: SECRET });
    const r = await fetch(`${BASE}/login/${tok}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 302, 'a good link signs you in and sends you to the app');
    const setCookie = r.headers.get('set-cookie') || '';
    assert.ok(new RegExp(`${AUTH.COOKIE}=`).test(setCookie));
    assert.ok(/HttpOnly/.test(setCookie), 'and the session it mints is a normal one');

    // The very same link again is spent.
    const again = await fetch(`${BASE}/login/${tok}`, { redirect: 'manual' });
    assert.strictEqual(again.status, 400, 'a forwarded link is a dead door');

    // The cookie it handed out really is Linnea's, and only hers.
    const uid = AUTH.verify(decodeURIComponent(setCookie.split('=')[1].split(';')[0]), SECRET);
    assert.strictEqual(uid, L);
  });

  await t('there is NO route that mints a link — that is what keeps it safe', async () => {
    // Possession of shell access is the credential. If any of these ever answer,
    // anyone could ask for a link to anybody's account.
    for (const [m, p] of [['POST', '/api/auth/link'], ['GET', '/api/auth/link'],
      ['POST', `/api/auth/link/${A}`], ['GET', `/login`]]) {
      const { status } = await api(m, p, m === 'GET' ? null : {}, A);
      assert.ok(status === 404 || status === 400, `${m} ${p} answered ${status}`);
    }
  });

  await t('a link for somebody who does not exist gets you nothing', async () => {
    const tok = require('../lib/magic').mint('nobody-at-all', { sec: SECRET });
    const r = await fetch(`${BASE}/login/${tok}`, { redirect: 'manual' });
    assert.strictEqual(r.status, 400);
    assert.ok(!(r.headers.get('set-cookie') || '').includes(AUTH.COOKIE), 'and no session');
  });

  await t('the setup helper reads a tag back without believing the token', async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const fake = `${b64({ alg: 'RS256', kid: 'k' })}.${b64({
      iss: 'https://someteam.cloudflareaccess.com', aud: ['the-aud-tag'],
      email: 'x@y.z', exp: Math.floor(Date.now() / 1000) + 60 })}.notasignature`;
    const r = await fetch(`${BASE}/api/auth/access-info`, { headers: { 'cf-access-jwt-assertion': fake } });
    assert.deepStrictEqual((await r.json()).seen.aud, ['the-aud-tag']);
    // Decoding is not authenticating.
    const gate = await fetch(`${BASE}/api/state`, { headers: { 'cf-access-jwt-assertion': fake } });
    assert.strictEqual(gate.status, 401, 'reading a token is not believing it');
  });

  await t('the shell is cache-busted and the stamped js path resolves', async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    assert.ok(/style\.css\?v=[a-z0-9]+/.test(html));
    const m = html.match(/\/js-[a-z0-9]+\//)[0];
    assert.strictEqual((await fetch(BASE + m + 'app.js')).status, 200);
  });

  await t('every client module parses and its imports resolve', async () => {
    const seen = new Set();
    const walk = async (p) => {
      if (seen.has(p)) return;
      seen.add(p);
      const r = await fetch(BASE + p);
      assert.strictEqual(r.status, 200, `${p} -> ${r.status}`);
      const src = await r.text();
      for (const m of src.matchAll(/from\s+'(\.\/[^']+)'/g)) {
        await walk(`/js/${m[1].replace(/^\.\//, '')}`);
      }
    };
    await walk('/js/app.js');
    assert.ok(seen.size >= 6, `expected the module graph, saw ${seen.size}`);
  });

  await t('data survives a restart', async () => {
    const before = (await api('GET', '/api/state', null, A)).body;
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile, CONFIG_FILE: cfgFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/api/auth/me`)).ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 150));
    }
    const after = (await api('GET', '/api/state', null, A)).body;
    assert.deepStrictEqual(after.spaces.map(s => s.id), before.spaces.map(s => s.id));
  });

  child.kill('SIGTERM');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async () => {
  await visibility();
  await gate();
  await moduleSeam();
  await inviteRules();
  await squareBridge();
  await magicLinks();
  await server();

  console.log(`\n${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log(`  · ${f}`);
  process.exit(fails.length ? 1 : 0);
})();
