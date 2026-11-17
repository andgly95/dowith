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

  await t('an admin may correct what they can SEE — and nothing more', () => {
    const hers = item('shared', 'linnea');
    assert.strictEqual(SP.canEdit(hers, 'andrew', spaces), false, 'not without the flag');
    assert.strictEqual(SP.canEdit(hers, 'andrew', spaces, { admin: true }), true, 'a typo of hers he can fix');
    assert.strictEqual(SP.canEdit(item('private', 'linnea'), 'andrew', spaces, { admin: true }), false,
      'her private things are as invisible to an admin as to anyone');
    assert.strictEqual(SP.canEdit(hers, 'andrew', spaces, { admin: 'yes' }), false, 'only a real true');
    assert.strictEqual(SP.canEdit(hers, 'sam', spaces, { admin: true }), false,
      'a list you are not in is not yours to correct');
  });

  await t('PROPERTY: being able to edit as an admin implies being able to see it', () => {
    // Admin is a right to fix what is on your screen, never a key to anybody's
    // private things. Every visibility, every author, every person.
    const people = ['andrew', 'linnea', 'sam', 'mum', 'nobody'];
    for (const v of ['private', 'shared', 'public', 'Public', '', null, undefined]) {
      for (const author of people) {
        for (const sp of ['sp1', 'sp2', 'sp3', 'gone']) {
          for (const who of people) {
            const it = item(v, author, sp);
            const at = `${author}'s ${v} item in ${sp}`;
            if (SP.canEdit(it, who, spaces, { admin: true })) {
              assert.ok(SP.canSee(it, who, spaces), `${who} could edit ${at} without seeing it`);
            }
            if (SP.canSetVisibility(it, who, spaces, { admin: true })) {
              assert.ok(SP.canSee(it, who, spaces), `${who} could re-aim ${at} without seeing it`);
            }
            for (const to of people) {
              if (SP.canCredit(it, who, to, spaces, { admin: true })) {
                assert.ok(SP.canSee(it, who, spaces), `${who} could credit ${at} to ${to} without seeing it`);
              }
            }
          }
        }
      }
    }
  });

  await t('who an item is for is its author\'s call — and an admin\'s, on what they can see', () => {
    assert.strictEqual(SP.canSetVisibility(item('shared', 'linnea'), 'linnea', spaces), true);
    assert.strictEqual(SP.canSetVisibility(item('shared', 'linnea'), 'andrew', spaces), false, 'not without the flag');
    assert.strictEqual(SP.canSetVisibility(item('shared', 'linnea'), 'andrew', spaces, { admin: true }), true);
    assert.strictEqual(SP.canSetVisibility(item('private', 'linnea'), 'andrew', spaces, { admin: true }), false,
      'not on something he cannot see');
    assert.strictEqual(SP.canSetVisibility(item('shared', 'linnea'), 'andrew', spaces, { admin: 'yes' }), false);
    assert.strictEqual(SP.canSetVisibility(null, 'andrew', spaces), false);
  });

  await t('whose idea is the author\'s to give (or an admin\'s), to someone in that list', () => {
    const his = item('shared', 'andrew', 'sp1');
    assert.strictEqual(SP.canCredit(his, 'andrew', 'linnea', spaces), true, 'her idea, his typing');
    assert.strictEqual(SP.canCredit(his, 'andrew', 'andrew', spaces), true, 'and back to himself');
    assert.strictEqual(SP.canCredit(his, 'andrew', 'sam', spaces), false, 'not someone from another list');
    assert.strictEqual(SP.canCredit(his, 'andrew', 'nobody', spaces), false);
    assert.strictEqual(SP.canCredit(his, 'andrew', null, spaces), false);
    assert.strictEqual(SP.canCredit(his, 'linnea', 'linnea', spaces), false, 'she cannot claim it');
    assert.strictEqual(SP.canCredit(item('shared', 'linnea'), 'andrew', 'andrew', spaces), false,
      'nor he hers, without the flag');
    assert.strictEqual(SP.canCredit(item('shared', 'linnea'), 'andrew', 'andrew', spaces, { admin: true }), true,
      'with it, the same right as editing');
    assert.strictEqual(SP.canCredit(item('private', 'linnea'), 'andrew', 'andrew', spaces, { admin: true }), false,
      'but never on something he cannot see');
    assert.strictEqual(SP.canCredit(item('shared', 'linnea'), 'andrew', 'sam', spaces, { admin: true }), false,
      'and never to someone outside the list');
    assert.strictEqual(SP.canCredit(item('shared', 'andrew', 'sp3'), 'andrew', 'linnea', spaces), false,
      'not in a list he is not in');
    assert.strictEqual(SP.canCredit(item('shared', 'andrew', 'gone'), 'andrew', 'linnea', spaces), false);
  });

  await t('PROPERTY: credit changes nothing about who may see, change or tick off anything', () => {
    // A credit is a label. Every visibility, author, list, viewer and credited
    // person: every right reads the same with it as without it.
    const people = ['andrew', 'linnea', 'sam', 'mum', 'nobody'];
    for (const v of ['private', 'shared', 'public', 'nonsense']) {
      for (const author of people) {
        for (const sp of ['sp1', 'sp2', 'sp3', 'gone']) {
          for (const who of people) {
            for (const to of people) {
              const plain = item(v, author, sp);
              const credited = { ...plain, ideaBy: to };
              const at = `${author}'s ${v} item in ${sp}, credited to ${to}, as seen by ${who}`;
              assert.strictEqual(SP.canSee(credited, who, spaces), SP.canSee(plain, who, spaces), `see: ${at}`);
              assert.strictEqual(SP.canComplete(credited, who, spaces), SP.canComplete(plain, who, spaces), `tick: ${at}`);
              for (const admin of [false, true]) {
                assert.strictEqual(SP.canSetVisibility(credited, who, spaces, { admin }),
                  SP.canSetVisibility(plain, who, spaces, { admin }), `vis (admin ${admin}): ${at}`);
                assert.strictEqual(SP.canEdit(credited, who, spaces, { admin }), SP.canEdit(plain, who, spaces, { admin }),
                  `edit (admin ${admin}): ${at}`);
              }
            }
          }
        }
      }
    }
  });

  await t('a credit only ever names somebody the viewer already knows', () => {
    // Andrew's standing wish, written in his list with Linnea and credited to
    // her. Sam sees it — he shares a list with Andrew — but has never met her,
    // and who Andrew keeps lists with is Andrew's business.
    const wish = { ...item('public', 'andrew', 'sp1'), ideaBy: 'linnea' };
    assert.strictEqual(SP.canSee(wish, 'sam', spaces), true, 'premise: Sam sees the wish');
    assert.strictEqual(SP.ideaOf(wish, 'andrew', spaces), 'linnea');
    assert.strictEqual(SP.ideaOf(wish, 'linnea', spaces), 'linnea');
    assert.strictEqual(SP.ideaOf(wish, 'sam', spaces), 'andrew', 'to Sam it is simply Andrew\'s');
    assert.strictEqual(SP.ideaOf(item('shared'), 'linnea', spaces), 'andrew', 'uncredited is the author\'s');
    assert.strictEqual(SP.ideaOf({ ...item('shared'), ideaBy: 'andrew' }, 'linnea', spaces), 'andrew');
    // The same rule decides whether "edited by" may name an admin.
    assert.strictEqual(SP.nameable(spaces, 'mum', 'linnea'), true);
    assert.strictEqual(SP.nameable(spaces, 'mum', 'andrew'), false, 'Mum has never met Andrew');
    assert.strictEqual(SP.nameable(spaces, 'mum', 'mum'), true);
    assert.strictEqual(SP.nameable(spaces, 'mum', null), false);
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

  await t('a plan is a calendar date, and an impossible one is refused', () => {
    const W = ITEMS.cleanWhen;
    assert.deepStrictEqual(W({ date: '2026-12-05' }), { date: '2026-12-05', time: null });
    assert.deepStrictEqual(W({ date: '2028-02-29', time: '09:05' }), { date: '2028-02-29', time: '09:05' });
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-5', '1999-12-31', '2026-12-05T10:00Z', '', null]) {
      assert.strictEqual(W({ date: bad }), null, `refused ${bad}`);
    }
    assert.strictEqual(W({ date: '2026-12-05', time: '24:00' }).time, null, 'a bad time drops the time, not the day');
    assert.strictEqual(W('2026-12-05'), null);
    // New items start unplanned.
    assert.strictEqual(ITEMS.cleanItem({ title: 'x', when: { date: '2026-12-05' } },
      { id: 'i', authorId: 'a', spaceId: 's' }).when, null, 'and creating cannot smuggle a plan in');
  });

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
    assert.deepStrictEqual(it.tags, ['Records', 'dc'],
      'deduped by fold, but the first spelling is kept — AFI must not become Afi');
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

/* ── 2b. groups ──────────────────────────────────────────────────────────────
   A group is the set of items carrying a tag, computed on the way out. Nothing
   is stored, so there is nothing to drift — these rows are mostly about the
   things that CANNOT happen as a result. */

async function groupRules() {
  console.log('\ngroups');
  const G = require('../lib/groups');
  const K = require('../lib/kinds');
  const it = (title, kind, done = false) => ({ id: title, title, kind, done });

  await t('a group is just the items of one kind', () => {
    const items = [it('a', 'movie'), it('b', 'movie'), it('c', 'place')];
    assert.deepStrictEqual(G.groupsOf(items).map(g => [g.name, g.count]),
      [['Films', 2], ['Places', 1]]);
    // The row is keyed by the kind id and named by its plural — which is what
    // the rows already rendered, so the list looks exactly as it did.
    assert.deepStrictEqual(G.groupsOf(items).map(g => g.key), ['movie', 'place']);
  });

  await t('GROUPS ARE IN TABLE ORDER, not biggest-first', () => {
    // With a fixed vocabulary the order is a fact about the app rather than
    // about today's counts, and a list of groups that reshuffles under your
    // finger every time something is ticked off is worse than one that never
    // moves. This reverses what the tag version did, deliberately.
    const items = [
      it('a', 'recipe'), it('b', 'movie'), it('c', 'movie'), it('d', 'movie'),
      it('e', 'place'), it('f', 'place'),
    ];
    assert.deepStrictEqual(G.groupsOf(items).map(g => g.name),
      ['Films', 'Places', 'Recipes']);
    // Ticking the three films off does not move the row.
    for (const x of items) if (x.kind === 'movie') x.done = true;
    assert.deepStrictEqual(G.groupsOf(items).map(g => g.name),
      ['Films', 'Places', 'Recipes']);
    assert.strictEqual(G.groupsOf(items)[0].open, 0, 'though it reports none to do');
  });

  await t('an activity is not a group — it is the loose pile under them', () => {
    const items = [it('a', 'movie'), it('b', 'activity'), it('c', undefined), it('d', null)];
    assert.strictEqual(G.ungroupedCount(items), 3,
      'no kind, an explicit activity, and rubbish all land in the same pile');
    assert.deepStrictEqual(G.inGroup(items, null).map(x => x.title), ['b', 'c', 'd']);
    assert.deepStrictEqual(G.groupsOf(items).map(g => g.key), ['movie']);
  });

  await t('a group is looked up by its id, or by the name the row carries', () => {
    const items = [it('a', 'movie'), it('b', 'recipe')];
    assert.strictEqual(G.inGroup(items, 'movie').length, 1);
    assert.strictEqual(G.inGroup(items, 'Films').length, 1, 'the plural the row shows');
    assert.strictEqual(G.inGroup(items, 'film').length, 1, 'and the singular, folded');
    assert.strictEqual(G.inGroup(items, 'nonsense').length, 0, 'but not an invention');
  });

  await t('a group cannot outlive its members', () => {
    // The property folders get wrong: reclassify the last item and the group is
    // gone, with nothing to clean up and nothing left pointing at nothing.
    const items = [it('a', 'movie')];
    assert.strictEqual(G.groupsOf(items).length, 1);
    items[0].kind = 'activity';
    assert.strictEqual(G.groupsOf(items).length, 0);
  });

  await t('a group of everything is not worth showing', () => {
    const all = [it('a', 'movie'), it('b', 'movie')];
    assert.strictEqual(G.worthGrouping(all), false,
      'one group holding the whole list tells you nothing');
    assert.strictEqual(G.worthGrouping([...all, it('c', 'activity')]), true,
      'now it says something');
    assert.strictEqual(G.worthGrouping([it('a', 'movie'), it('b', 'recipe')]), true);
    assert.strictEqual(G.worthGrouping([it('a', 'activity'), it('b', undefined)]), false,
      'a list of plain activities has nothing to group');
    assert.strictEqual(G.worthGrouping([]), false);
  });

  await t('THE OLD TAGS BECOME KINDS — that is what the live data was', () => {
    // The tags actually in the live list were `Films` (5), `Shows` (2) and
    // `Recipes` (2): a fixed, non-overlapping vocabulary of what things ARE,
    // typed by hand. The migration honours exactly those and leaves anything
    // that was a real opinion alone.
    assert.strictEqual(K.fromTag('Films'), 'movie');
    assert.strictEqual(K.fromTag('films'), 'movie', 'folded');
    assert.strictEqual(K.fromTag('Shows'), 'show');
    assert.strictEqual(K.fromTag('Recipes'), 'recipe');
    assert.strictEqual(K.fromTag('Film'), 'movie', 'singular too');
    assert.strictEqual(K.fromTag('rainy day'), null, 'an opinion is not a kind');
    assert.strictEqual(K.fromTag('Thing'), null, 'and the default is not a tag');
    assert.strictEqual(K.fromTag(''), null);
    assert.strictEqual(K.fromTag(null), null);
    // Matched against the labels, so a kind added to the table is covered
    // without anybody remembering to update a second list.
    for (const k of K.KINDS) {
      if (k.id === K.DEFAULT) continue;
      assert.strictEqual(K.fromTag(k.plural), k.id, `${k.plural} should map to ${k.id}`);
    }
  });

  await t('THE MIGRATION IS WRITTEN OUT, not left in memory', () => {
    // Migrating on load and waiting for the next ordinary mutation to persist
    // it means the file on disk disagrees with the running process until
    // somebody happens to tick something off — and re-migrates on every restart
    // in the meantime. Caught on the live deploy, where the log said "migrated
    // 9" and the file still had every tag.
    const src = fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8');
    assert.ok(/if \(migrated\) flushSync\(\);/.test(src),
      'the migration must flush once, as soon as the atomic write exists');
  });

  await t('tags still pass the gate, so nothing stored is destroyed', () => {
    // The field is no longer surfaced and no longer makes groups, but a patch
    // that does not mention it leaves it alone — a tag that meant something
    // ("rainy day") is still there if it is ever wanted again.
    const x = ITEMS.cleanItem({ title: 'x', tags: ['rainy day'] },
      { id: 'i', authorId: 'a', spaceId: 's' });
    assert.deepStrictEqual(x.tags, ['rainy day']);
    ITEMS.applyPatch(x, { title: 'y' });
    assert.deepStrictEqual(x.tags, ['rainy day'], 'an unrelated edit does not eat it');
    const many = ITEMS.cleanItem({ title: 'x', tags: Array.from({ length: 40 }, (_, i) => `t${i}`) },
      { id: 'i', authorId: 'a', spaceId: 's' });
    assert.strictEqual(many.tags.length, ITEMS.MAX_TAGS, 'and it is still capped');
  });
}

/* ── 3. the module seam ──────────────────────────────────────────────────── */

/* ── posters, years and where it streams ────────────────────────────────── */

async function watchLookups() {
  console.log('\nTMDB — posters and streaming');
  const W = require('../lib/watch');

  const r = (title, pop, date, id = 1) => ({
    id, title, popularity: pop, release_date: date, poster_path: '/p.jpg',
  });

  await t('the matching key ignores case, punctuation and a typed year', () => {
    assert.strictEqual(W.fold('Obsession (1976)'), 'obsession');
    assert.strictEqual(W.fold("Director's Cut"), 'directors cut');
    assert.strictEqual(W.fold('  THE   BEAR '), 'the bear');
    assert.strictEqual(W.yearHint('Obsession (1976)'), 1976);
    assert.strictEqual(W.yearHint('Obsession'), null);
    assert.strictEqual(W.yearHint('Blade Runner 2049'), null, 'a year IN the title is not a hint');
  });

  await t('AN EXACT TITLE BEATS A POPULAR ONE', () => {
    // Searching "Obsession" returns forty things. Taking the first is how a
    // shelf ends up with the wrong poster on it, and a wrong poster is worse
    // than none because it looks exactly like a right one.
    const got = W.pickMatch([
      r('Obsessions', 99, '2019-01-01', 2),
      r('Obsession', 12, '1976-08-01', 3),
    ], 'Obsession');
    assert.strictEqual(got.id, 3, 'the exact title wins on any popularity');
  });

  await t('a year you typed beats everything', () => {
    const got = W.pickMatch([
      r('Obsession', 90, '2019-01-01', 2),
      r('Obsession', 5, '1976-08-01', 3),
    ], 'Obsession (1976)', 1976);
    assert.strictEqual(got.id, 3, 'it is the whole reason the year was typed');
    // And without the hint, popularity decides between two exact matches.
    const pop = W.pickMatch([
      r('Obsession', 90, '2019-01-01', 2),
      r('Obsession', 5, '1976-08-01', 3),
    ], 'Obsession');
    assert.strictEqual(pop.id, 2);
  });

  await t('SOMETHING MERELY SIMILAR IS REFUSED, not guessed at', () => {
    // "The Bear" must not resolve to "Bear Island" because it was top of the
    // pile. No confident match means no poster, which the card draws properly.
    assert.strictEqual(W.pickMatch([r('Bear Island', 80, '1979-01-01', 9)], 'The Bear'), null);
    assert.strictEqual(W.pickMatch([r('Succession', 99, '2018-01-01', 9)], 'Severance'), null);
    assert.strictEqual(W.pickMatch([], 'Anything'), null);
    assert.strictEqual(W.pickMatch(null, 'Anything'), null);
    assert.strictEqual(W.pickMatch([r('Obsession', 9, '1976-01-01')], ''), null);
    // A genuine prefix is close enough — people drop subtitles constantly.
    const sub = W.pickMatch([r('Dune: Part Two', 99, '2024-03-01', 7)], 'Dune');
    assert.strictEqual(sub.id, 7);
  });

  await t('a tv result is matched on `name`, not `title`', () => {
    const got = W.pickMatch([{ id: 4, name: 'The Rehearsal', popularity: 30, first_air_date: '2022-07-15' }],
      'The Rehearsal');
    assert.strictEqual(got.id, 4);
    assert.strictEqual(W.shape(got, 'tv').year, 2022);
    assert.strictEqual(W.shape(got, 'tv').title, 'The Rehearsal');
  });

  await t('what is stored is a PATH, never a URL', () => {
    // Sizes are a rendering decision. Baking one in means re-fetching
    // everything the day the card changes size.
    const got = W.shape(r('Obsession', 9, '1976-08-01', 3), 'movie');
    assert.strictEqual(got.poster, '/p.jpg');
    assert.strictEqual(got.tmdbId, 3);
    assert.strictEqual(got.mediaType, 'movie');
    assert.strictEqual(W.posterUrl('/p.jpg'), 'https://image.tmdb.org/t/p/w342/p.jpg');
    assert.strictEqual(W.posterUrl(null), null);
    assert.strictEqual(W.shape(null, 'movie'), null);
    assert.strictEqual(W.shape({}, 'movie'), null);
  });

  await t('ONLY WHAT A SUBSCRIPTION COVERS — rent and buy are a different question', () => {
    // A card that says "on Amazon" when it means "$3.99 on Amazon" is lying
    // quietly, and that is the kind of lie nobody catches until they are on
    // the sofa.
    const payload = { results: { US: {
      flatrate: [{ provider_name: 'Max', logo_path: '/m.png' }, { provider_name: 'Criterion Channel' }],
      rent: [{ provider_name: 'Amazon Video' }],
      buy: [{ provider_name: 'Apple TV' }],
    } } };
    const got = W.shapeProviders(payload, 'US');
    assert.deepStrictEqual(got.map(p => p.name), ['Max', 'Criterion Channel']);
    assert.strictEqual(got[0].logo, '/m.png');
    assert.strictEqual(got[1].logo, null);
  });

  await t('another region, or none at all, is simply empty', () => {
    const payload = { results: { GB: { flatrate: [{ provider_name: 'Now' }] } } };
    assert.deepStrictEqual(W.shapeProviders(payload, 'US'), []);
    assert.deepStrictEqual(W.shapeProviders(payload, 'GB').map(p => p.name), ['Now']);
    assert.deepStrictEqual(W.shapeProviders(null, 'US'), []);
    assert.deepStrictEqual(W.shapeProviders({}, 'US'), []);
  });

  await t('THE QUERY KEEPS WHAT A TITLE NEEDS AND DROPS WHAT IT DOES NOT', () => {
    // The matching key can afford to flatten everything; the query cannot.
    // "Dune: Part Two" needs its colon and "Se7en" its digit — but the live
    // list is full of titles like "🐴 Bojack Horseman", and sending that
    // verbatim to TMDB returns nothing at all. It was the one miss in seven.
    assert.strictEqual(W.searchQuery('🐴 Bojack Horseman'), 'Bojack Horseman');
    assert.strictEqual(W.searchQuery('💃 Go swing dancing!'), 'Go swing dancing');
    assert.strictEqual(W.searchQuery('Dune: Part Two'), 'Dune: Part Two');
    assert.strictEqual(W.searchQuery('Se7en'), 'Se7en');
    assert.strictEqual(W.searchQuery('Obsession (1976)'), 'Obsession');
    assert.strictEqual(W.searchQuery('🎭'), '', 'nothing left to search for');
    assert.strictEqual(W.searchQuery(null), '');
  });

  await t('ZERO IS THE BEST RANK, and `|| 999` buries it', () => {
    // TMDB's display_priority is 0 for the most relevant service. Reading it
    // with `Number(x) || 999` treats a legitimate 0 as missing — the same
    // falsy-zero trap as everywhere else — and it put Netflix fourth, behind
    // two live-TV resellers that happened to come back first.
    const pay = { results: { US: { flatrate: [
      { provider_name: 'fuboTV', display_priority: 30 },
      { provider_name: 'Netflix', display_priority: 0 },
      { provider_name: 'Hulu', display_priority: 5 },
    ] } } };
    assert.deepStrictEqual(W.shapeProviders(pay, 'US').map(p => p.name),
      ['Netflix', 'Hulu', 'fuboTV']);
    // No rank at all sorts last rather than first.
    const none = { results: { US: { flatrate: [
      { provider_name: 'Mystery' }, { provider_name: 'Max', display_priority: 1 },
    ] } } };
    assert.deepStrictEqual(W.shapeProviders(none, 'US').map(p => p.name), ['Max', 'Mystery']);
  });

  await t('a tier of something already listed is not another place to watch it', () => {
    // "Netflix" then "Netflix Standard with Ads" is one service twice, and on a
    // card with room for four that costs a real one.
    const pay = { results: { US: { flatrate: [
      { provider_name: 'Netflix', display_priority: 0 },
      { provider_name: 'Netflix Standard with Ads', display_priority: 12 },
      { provider_name: 'Paramount Plus', display_priority: 5 },
      { provider_name: 'Paramount Plus Premium', display_priority: 20 },
      { provider_name: 'Hulu', display_priority: 7 },
    ] } } };
    assert.deepStrictEqual(W.shapeProviders(pay, 'US').map(p => p.name),
      ['Netflix', 'Paramount Plus', 'Hulu']);

    // The other shape of the same problem, and the one the live data actually
    // produced: NEITHER is a prefix of the other, but both are the same thing.
    const tiers = { results: { US: { flatrate: [
      { provider_name: 'Amazon Prime Video', display_priority: 0 },
      { provider_name: 'Apple TV', display_priority: 1 },
      { provider_name: 'Paramount Plus Premium', display_priority: 2 },
      { provider_name: 'Paramount Plus Essential', display_priority: 3 },
    ] } } };
    assert.deepStrictEqual(W.shapeProviders(tiers, 'US').map(p => p.name),
      ['Amazon Prime Video', 'Apple TV', 'Paramount Plus Premium'],
      'two tiers of Paramount must not eat two of the four slots');

    // But two words is where it stops: these really are different things.
    const real = { results: { US: { flatrate: [
      { provider_name: 'Amazon Prime Video', display_priority: 0 },
      { provider_name: 'Amazon Video', display_priority: 1 },
    ] } } };
    assert.strictEqual(W.shapeProviders(real, 'US').length, 2);
  });

  await t('duplicates fold and the list is capped — a card is not a directory', () => {
    const many = { results: { US: { flatrate: [
      { provider_name: 'Max', display_priority: 1 }, { provider_name: 'max', display_priority: 2 },
      { provider_name: 'Hulu', display_priority: 3 }, { provider_name: 'Peacock', display_priority: 4 },
      { provider_name: 'Netflix', display_priority: 5 }, { provider_name: 'Paramount+', display_priority: 6 },
    ] } } };
    const got = W.shapeProviders(many, 'US');
    assert.strictEqual(got.length, 4);
    assert.deepStrictEqual(got.map(p => p.name), ['Max', 'Hulu', 'Peacock', 'Netflix']);
  });

  await t('A POSTER PATH IS THE ONLY THING THE GATE WILL TAKE', () => {
    // This ends up in an <img src>, and the app shows other people's items to
    // you. Anything that is not a plain TMDB path is dropped.
    const M = require('../lib/modules');
    const good = M.cleanMods({ watch: { tmdbId: 7, mediaType: 'movie', poster: '/abc_1-2.jpg' } });
    assert.strictEqual(good.watch.poster, '/abc_1-2.jpg');
    for (const bad of ['https://evil.example/x.jpg', '//evil/x.jpg', '/a/../b.jpg',
      'javascript:alert(1)', '/x.jpg" onerror="x', '']) {
      const out = M.cleanMods({ watch: { tmdbId: 7, mediaType: 'movie', poster: bad } });
      assert.strictEqual(out.watch.poster, null, `${JSON.stringify(bad)} must not survive`);
    }
    // Same rule for a provider logo.
    const prov = M.cleanMods({ watch: { tmdbId: 7, mediaType: 'movie',
      providers: [{ name: 'Max', logo: 'https://evil/x.png' }] } });
    assert.strictEqual(prov.watch.providers[0].logo, null);
    assert.strictEqual(prov.watch.providers[0].name, 'Max');
  });

  await t('the slice needs an id and a media type, or it is not a slice', () => {
    const M = require('../lib/modules');
    assert.deepStrictEqual(M.cleanMods({ watch: { mediaType: 'movie' } }), {});
    assert.deepStrictEqual(M.cleanMods({ watch: { tmdbId: 7 } }), {});
    assert.deepStrictEqual(M.cleanMods({ watch: { tmdbId: 7, mediaType: 'book' } }), {});
    assert.deepStrictEqual(M.cleanMods({ watch: 'nope' }), {});
  });

  await t('THE CHOOSER DECIDES NOTHING — it returns the shortlist', () => {
    // pickMatch exists for when nobody is in the room: a bulk backfill, a share
    // that arrived while you were asleep. When somebody IS in the room, asking
    // is strictly better — one tap, never wrong, and a poster is the fastest
    // way a person recognises a film. Searching "Obsession" really does return
    // five of them with the one you mean fourth.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'watch.js'), 'utf8');
    assert.ok(/async function search\(/.test(src));
    assert.ok(!/pickMatch\(/.test(src.split('async function search(')[1].split('}')[0]),
      'search must not pre-decide for you');
    // And the route that pins one is a write, so it goes through the gate.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes.js'), 'utf8');
    assert.ok(/modules\.cleanMods\(\{ \.\.\.it\.mod, watch: got \}\)/.test(routes),
      'a chosen id is still TMDB data and still passes the gate');
    assert.ok(/body\.clear/.test(routes),
      'and getting it wrong has to be undoable, or choosing is a trap');
  });

  await t('nothing guesses while somebody is standing there to be asked', () => {
    // Adding a film opens the chooser. The silent lookup that used to run on
    // every write is gone from the write paths — a guess made in front of you
    // is the one you are most likely to notice and least likely to correct.
    const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes.js'), 'utf8');
    assert.ok(!/fillWatchSoon/.test(routes), 'no silent fill on create or patch');
    assert.ok(/fillWatch\(it, \{ fresh: true \}\)/.test(routes),
      'only the backfill still matches without being asked');
  });

  await t('with no key configured nothing is asked and nothing breaks', async () => {
    // The suite must never need the internet, and the app must work without a
    // TMDB account — the shelf just draws its typographic cards.
    assert.strictEqual(W.configured(), false, 'the test config has no key');
    assert.strictEqual(await W.lookup('movie', 'Obsession'), null);
    assert.strictEqual(await W.lookup('activity', 'Go swing dancing'), null);
    assert.deepStrictEqual(await W.search('movie', 'Obsession'), []);
    assert.strictEqual(await W.detail('movie', 11607), null);
    // And nothing is asked for a kind that has no art, key or no key.
    assert.deepStrictEqual(await W.search('recipe', 'ragu'), []);
  });

  await t('only films and shows are ever looked up', () => {
    const K = require('../lib/kinds');
    assert.deepStrictEqual(K.MEDIA_KINDS, ['movie', 'show']);
    assert.strictEqual(W.MEDIA.movie, 'movie');
    assert.strictEqual(W.MEDIA.show, 'tv', "TMDB's word for it is tv");
    assert.strictEqual(W.MEDIA.recipe, undefined);
  });
}

/* ── kinds: what a thing IS ─────────────────────────────────────────────── */

async function kindRules() {
  console.log('\nkinds');
  const kinds = require('../lib/kinds');
  const items = require('../lib/items');

  const made = (raw) => items.cleanItem(raw, { id: 'i1', authorId: 'u1', spaceId: 's1' });

  await t('the kinds are the four that were asked for, plus a plain activity', () => {
    assert.deepStrictEqual(kinds.manifest().map(k => k.id),
      ['activity', 'movie', 'show', 'place', 'recipe']);
    // The default is FIRST, and the client reads it from that position rather
    // than writing the id down — which is what let it be renamed from `thing`
    // without a literal anywhere in the client to miss.
    assert.strictEqual(kinds.DEFAULT, kinds.manifest()[0].id);
    assert.strictEqual(kinds.DEFAULT, 'activity');
  });

  await t('every `thing` written before the rename reads as an activity', () => {
    // Normalised by `clean` on the way out and by the load-time migration on
    // disk, so nothing has to translate it twice.
    assert.strictEqual(kinds.clean('thing'), 'activity');
    assert.strictEqual(made({ title: 'x', kind: 'thing' }).kind, 'activity');
    const src = fs.readFileSync(path.join(__dirname, '..', 'store.js'), 'utf8');
    assert.ok(/it\.kind === 'thing'/.test(src), 'and the file on disk is moved too');
  });

  await t('an unrecognised kind becomes the default rather than losing the item', () => {
    // A kind is a convenience. Refusing the write because a client sent a word
    // this server has not heard of would be the tail wagging the dog.
    assert.strictEqual(made({ title: 'x', kind: 'spaceship' }).kind, 'activity');
    assert.strictEqual(made({ title: 'x', kind: '' }).kind, 'activity');
    assert.strictEqual(made({ title: 'x', kind: null }).kind, 'activity');
    assert.strictEqual(made({ title: 'x' }).kind, 'activity');
    assert.strictEqual(made({ title: 'x', kind: { id: 'movie' } }).kind, 'activity');
  });

  await t('A RECIPE KEEPS ITS LINK — the whole point of a recipe', () => {
    const it = made({
      title: 'The NYT ragù', kind: 'recipe',
      mod: { link: { url: 'https://cooking.nytimes.com/recipes/1018069' } },
    });
    assert.strictEqual(it.kind, 'recipe');
    assert.strictEqual(it.mod.link.url, 'https://cooking.nytimes.com/recipes/1018069');
    // And the kind says the link leads, which is what makes the field read
    // "Recipe link" rather than "Link" and the row's action worth tapping.
    assert.strictEqual(kinds.leadsWithLink('recipe'), true);
    assert.deepStrictEqual(kinds.modsFor('recipe'), ['link']);
    // And the action is named for what the link is FOR. Never the same word as
    // the badge beside it: the first version used the label for both and a show
    // rendered "SHOW" twice in a row, which reads as a bug even though both
    // were correct.
    for (const k of kinds.KINDS) {
      assert.ok(k.go, `${k.id} needs a word for its link`);
      assert.notStrictEqual(k.go.toLowerCase(), k.label.toLowerCase(),
        `${k.id} would render its own name twice`);
    }
  });

  await t('a javascript: URL is still refused on a recipe', () => {
    // The kind must not become a way around the module gate — this app shows
    // other people's items to you, and an href is a script injection with
    // extra steps.
    const it = made({
      title: 'Nasty', kind: 'recipe',
      mod: { link: { url: 'javascript:alert(1)' } },
    });
    assert.strictEqual(it.kind, 'recipe');
    assert.deepStrictEqual(it.mod, {}, 'the slice is dropped, the item survives');
  });

  await t('films and shows lead with a link; a place leads with a place', () => {
    assert.deepStrictEqual(kinds.modsFor('movie'), ['link']);
    assert.deepStrictEqual(kinds.modsFor('show'), ['link']);
    assert.deepStrictEqual(kinds.modsFor('place'), ['place']);
    assert.strictEqual(kinds.leadsWithLink('place'), false);
    // A plain thing offers BOTH and leads with neither. That is the point of it
    // being the default: before kinds existed every item could carry a place
    // and a link, and a default that took both away would make classifying
    // compulsory just to get back what you already had.
    assert.deepStrictEqual(kinds.modsFor('activity'), ['place', 'link']);
    assert.strictEqual(kinds.leadsWithLink('activity'), false);
  });

  await t('A KIND SUGGESTS AND NEVER CONFISCATES', () => {
    // Seeing a film at the AFI is a film with a place on it. Reclassifying a
    // row must never silently delete something that was typed — so nothing in
    // the kind rules drops a slice the module gate recognises.
    const it = made({
      title: 'Obsession at the AFI', kind: 'movie',
      mod: {
        link: { url: 'https://example.com/obsession' },
        place: { name: 'AFI Silver', address: '8633 Colesville Rd' },
      },
    });
    assert.strictEqual(it.mod.place.name, 'AFI Silver');
    assert.strictEqual(it.mod.link.url, 'https://example.com/obsession');

    // And changing the kind afterwards keeps both.
    items.applyPatch(it, { kind: 'place' });
    assert.strictEqual(it.kind, 'place');
    assert.strictEqual(it.mod.link.url, 'https://example.com/obsession',
      'the link survived being reclassified as a place');
    assert.strictEqual(it.mod.place.name, 'AFI Silver');
  });

  await t('a patch can change the kind, and garbage still lands on the default', () => {
    const it = made({ title: 'x' });
    items.applyPatch(it, { kind: 'show' });
    assert.strictEqual(it.kind, 'show');
    items.applyPatch(it, { kind: 'nonsense' });
    assert.strictEqual(it.kind, 'activity');
    // A patch that mentions no kind leaves it alone — the usual PATCH rule.
    items.applyPatch(it, { kind: 'recipe' });
    items.applyPatch(it, { title: 'y' });
    assert.strictEqual(it.kind, 'recipe');
  });

  await t('THE KIND MAKES THE GROUP; a tag is only kept', () => {
    // This replaced the tag vocabulary rather than sitting beside it, because
    // the tags in the live list WERE the vocabulary: Films, Shows, Recipes. So
    // a film still carrying "rainy day" is a film, and groups into Films — the
    // tag is stored, costs nothing, and no longer invents a group of its own.
    const it = made({ title: 'Obsession', kind: 'movie', tags: ['rainy day'] });
    assert.strictEqual(it.kind, 'movie');
    assert.deepStrictEqual(it.tags, ['rainy day'], 'nothing stored was destroyed');
    const groups = require('../lib/groups');
    assert.deepStrictEqual(groups.groupsOf([it]).map(g => g.name), ['Films']);
  });

  /* ── what the filter row is allowed to show ──────────────────────────── */

  const mixed = [
    { kind: 'movie' }, { kind: 'movie' }, { kind: 'recipe' }, {}, { kind: 'place' },
  ];

  await t('counts cover every kind, including the ones with nothing in them', () => {
    const n = kinds.counts(mixed);
    assert.strictEqual(n.get('movie'), 2);
    assert.strictEqual(n.get('recipe'), 1);
    assert.strictEqual(n.get('activity'), 1, 'an item with no kind counts as an activity');
    assert.strictEqual(n.get('show'), 0);
  });

  await t('only the kinds actually present get a filter chip', () => {
    // A filter for a kind you own none of is a dead control.
    assert.deepStrictEqual(kinds.present(mixed).map(k => k.id),
      ['activity', 'movie', 'place', 'recipe']);
    assert.deepStrictEqual(kinds.present(mixed).map(k => k.count), [1, 2, 1, 1]);
    // Table order, not count order: the row must not reshuffle under your
    // finger every time something is ticked off.
    assert.deepStrictEqual(kinds.present([{ kind: 'recipe' }, { kind: 'movie' }])
      .map(k => k.id), ['movie', 'recipe']);
  });

  await t('A LIST OF ONE KIND GETS NO FILTER ROW AT ALL', () => {
    // One kind is not a choice, and a row of chips that all say the same thing
    // is noise on a phone.
    assert.strictEqual(kinds.worthFiltering([{}, {}, {}]), false);
    assert.strictEqual(kinds.worthFiltering([{ kind: 'movie' }, { kind: 'movie' }]), false);
    assert.strictEqual(kinds.worthFiltering([]), false);
    assert.strictEqual(kinds.worthFiltering(mixed), true);
  });

  await t('filtering to a kind finds the plain things too', () => {
    assert.strictEqual(kinds.inKind(mixed, 'movie').length, 2);
    assert.strictEqual(kinds.inKind(mixed, 'activity').length, 1,
      'an item written before kinds existed is an activity and must be findable');
    assert.strictEqual(kinds.inKind(mixed, 'show').length, 0);
  });

  await t('nothing here throws on rubbish', () => {
    assert.deepStrictEqual(kinds.present(null), []);
    assert.strictEqual(kinds.worthFiltering(null), false);
    assert.deepStrictEqual(kinds.inKind(null, 'movie'), []);
    assert.strictEqual(kinds.counts([null, undefined]).get('activity'), 2);
    assert.deepStrictEqual(kinds.modsFor('nonsense'), ['place', 'link'],
      'falls back to the default, which offers everything');
  });
}

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

  await t('a short code avoids the characters people mistype', () => {
    // It gets read off one screen and typed into another. 0/O and 1/I/L are the
    // ones that go wrong.
    assert.ok(!/[01OIL]/.test(MAGIC.ALPHABET), MAGIC.ALPHABET);
    const st = { loginCodes: [] };
    const c = MAGIC.mintCode(st, 'u1').code;
    assert.strictEqual(c.length, MAGIC.CODE_LEN);
    assert.ok([...c].every(ch => MAGIC.ALPHABET.includes(ch)));
  });

  await t('LOOKING at a code does not spend it', () => {
    // Every messaging app fetches a URL to build a preview card. A code spent by
    // a crawler never reaches the person it was for — and the first thing anybody
    // does with a link is check that it works.
    const st = { loginCodes: [] };
    const c = MAGIC.mintCode(st, 'u1').code;
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(MAGIC.peekCode(st, c).ok, true, `peek ${i}`);
    }
    assert.strictEqual(MAGIC.redeemCode(st, c).ok, true, 'and it still redeems afterwards');
    assert.strictEqual(MAGIC.peekCode(st, c).ok, false, 'but not twice');
  });

  await t('a short code is single-use, case-insensitive, and short-lived', () => {
    const st = { loginCodes: [] };
    const c = MAGIC.mintCode(st, 'u1').code;
    // Typed in lowercase from a phone keyboard — still the same code.
    const first = MAGIC.redeemCode(st, `  ${c.toLowerCase()} `);
    assert.deepStrictEqual([first.ok, first.uid], [true, 'u1']);
    assert.strictEqual(MAGIC.redeemCode(st, c).ok, false, 'once only');

    const st2 = { loginCodes: [] };
    const c2 = MAGIC.mintCode(st2, 'u1', { now: 0 }).code;
    assert.strictEqual(MAGIC.redeemCode(st2, c2, { now: MAGIC.CODE_TTL_MS + 1 }).ok, false, 'expires');
  });

  await t('codes are unguessable enough, and the list does not grow forever', () => {
    const st = { loginCodes: [] };
    const seen = new Set();
    for (let i = 0; i < 300; i++) seen.add(MAGIC.mintCode(st, 'u1').code);
    assert.strictEqual(seen.size, 300, 'no collisions across 300 draws');
    // Minting prunes spent and expired ones rather than accumulating.
    for (const c of st.loginCodes) c.usedAt = 1;
    MAGIC.mintCode(st, 'u1');
    assert.strictEqual(st.loginCodes.length, 1, 'spent codes are swept on the next mint');
  });

  await t('an unknown, blank or nonsense code gets you nothing', () => {
    const st = { loginCodes: [] };
    for (const bad of ['', null, undefined, 'AAAAAAAA', '../../x', 12345]) {
      assert.strictEqual(MAGIC.redeemCode(st, bad).ok, false, String(bad));
    }
  });
}

/* ── 5c. nudges ──────────────────────────────────────────────────────────────
   The notification surface is a second, quieter copy of the visibility model —
   and a worse place to leak, because a lock screen reads itself out loud in a
   room. So the audience is DERIVED from canSee rather than reasoned about, and
   these rows are the proof. */

async function nudges() {
  console.log('\nnudges');
  // lib/push is the only module here that touches the store, so DATA_FILE is
  // pointed at scratch space BEFORE requiring it. CONFIG_FILE is already
  // suite-scoped at the top of this file and cannot be re-pointed now — lib/config
  // resolved its path at load, which is exactly why that line is at the top.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-push-'));
  process.env.DATA_FILE = path.join(dir, 'store.json');
  fs.writeFileSync(process.env.DATA_FILE,
    JSON.stringify({ users: {}, spaces: [], items: [], invites: [], seq: 1 }));

  const store = require('../store');
  const push = require('../lib/push');
  assert.ok(store.FILE.startsWith(os.tmpdir()), 'refusing to run against a real store');
  const st = store.state;

  // Andrew + Linnea, and Andrew + Sam. Linnea and Sam share nothing.
  const person = (id, name) => ({ id, name, email: `${name}@x.com`, push: [], createdAt: 1 });
  st.users = { A: person('A', 'Andrew'), L: person('L', 'Linnea'), S: person('S', 'Sam') };
  st.spaces = [
    { id: 'sp1', memberIds: ['A', 'L'], createdAt: 1 },
    { id: 'sp2', memberIds: ['A', 'S'], createdAt: 1 },
  ];
  const item = (vis) => ({
    id: `i-${vis}`, spaceId: 'sp1', authorId: 'A', title: `a ${vis} thing`,
    visibility: vis, done: false, createdAt: 1,
  });
  const names = (list) => list.map(u => u.id).sort();

  await t('a PRIVATE item is told to nobody at all', () => {
    assert.deepStrictEqual(push.audienceFor(item('private')), [],
      'a lock screen reads itself out loud in a room — this is the one that must never leak');
  });

  await t('a shared item is told to the others in that list, and no further', () => {
    assert.deepStrictEqual(names(push.audienceFor(item('shared'))), ['L'],
      'Sam is in another list and has no business knowing');
  });

  await t('a standing wish is told to everyone in your circle', () => {
    assert.deepStrictEqual(names(push.audienceFor(item('public'))), ['L', 'S']);
  });

  await t('the author is never told about their own thought', () => {
    for (const v of ['shared', 'public']) {
      assert.ok(!push.audienceFor(item(v)).some(u => u.id === 'A'), v);
    }
  });

  await t('the audience never exceeds who could see it on a screen', () => {
    // The property, checked directly rather than trusted: for every visibility
    // and every person, being in the audience implies being able to see it.
    const SPmod = require('../lib/spaces');
    for (const v of ['private', 'shared', 'public']) {
      const it = item(v);
      for (const u of push.audienceFor(it)) {
        assert.ok(SPmod.canSee(it, u.id, st.spaces),
          `${v}: ${u.id} would be notified about something they cannot see`);
      }
    }
  });

  await t('ticking off or planning tells everyone who can see it except whoever did it', () => {
    // Linnea acts on Andrew's shared item: Andrew hears, Linnea does not.
    assert.deepStrictEqual(names(push.audienceFor(item('shared'), 'L')), ['A'],
      'the author is told when somebody else acts on their item');
    assert.deepStrictEqual(names(push.audienceFor(item('public'), 'L')), ['A', 'S']);
    assert.deepStrictEqual(push.audienceFor(item('private'), 'A'), [],
      'a private thing ticked off by its author is still nobody else\'s business');
    const SPmod = require('../lib/spaces');
    for (const v of ['private', 'shared', 'public']) for (const actor of ['A', 'L', 'S']) {
      for (const u of push.audienceFor(item(v), actor)) {
        assert.ok(u.id !== actor && SPmod.canSee(item(v), u.id, st.spaces), `${v}/${actor}: ${u.id}`);
      }
    }
  });

  await t('a plan reads as the day somebody chose, whatever zone the server is in', () => {
    assert.strictEqual(push.whenLabel({ date: '2026-11-08', time: '19:00' }), 'Sun 8 Nov · 7pm');
    assert.strictEqual(push.whenLabel({ date: '2026-11-08', time: '09:30' }), 'Sun 8 Nov · 9:30am');
    assert.strictEqual(push.whenLabel({ date: '2026-11-08', time: null }), 'Sun 8 Nov');
  });

  await t('nothing is sent to somebody with no device subscribed', async () => {
    assert.strictEqual(await push.itemAdded(item('shared'), () => 'Andrew'), 0,
      'audience is not the same as reachable');
  });

  await t('a subscription is validated before it is stored', () => {
    assert.strictEqual(push.addSub(st.users.L, { endpoint: 'ftp://nope' }), null);
    assert.strictEqual(push.addSub(st.users.L, { endpoint: 'https://a/x' }), null, 'no keys');
    const ec = crypto.createECDH('prime256v1'); ec.generateKeys();
    assert.ok(push.addSub(st.users.L, {
      endpoint: 'https://127.0.0.1:1/dead',
      keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
    }));
    assert.strictEqual(push.devicesOf(st.users.L).length, 1);
    // Same device twice must not stack up duplicate notifications.
    push.addSub(st.users.L, {
      endpoint: 'https://127.0.0.1:1/dead',
      keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
    });
    assert.strictEqual(push.devicesOf(st.users.L).length, 1);
  });

  await t('a private item still reaches nobody once devices ARE subscribed', async () => {
    // The dangerous version of the earlier row: an audience of zero is easy to
    // get right by accident when nobody is reachable.
    assert.strictEqual(await push.itemAdded(item('private'), () => 'x'), 0);
  });

  await t('the weekly digest only fires on its day, at its hour, once', async () => {
    st.items = Array.from({ length: 4 }, (_, i) => ({
      id: `d${i}`, spaceId: 'sp1', authorId: 'A', title: `thing ${i}`,
      visibility: 'shared', done: false, createdAt: i,
    }));
    const at = (dow, h) => {
      const d = new Date(2026, 8, 6, h, 0, 0);       // 2026-09-06 is a Sunday
      d.setDate(d.getDate() + (dow - d.getDay()));
      return d;
    };
    assert.deepStrictEqual(await push.tick(at(3, 19)), [], 'not a Sunday');
    assert.deepStrictEqual(await push.tick(at(0, 9)), [], 'too early');
    // Sunday evening: it tries. The endpoint is dead, so nothing goes out — but
    // it must not then mark the week as done.
    await push.tick(at(0, 19));
    assert.strictEqual(st.users.L.digestOn, undefined,
      'a failed send must not burn the week');
    assert.strictEqual(st.users.L.digestTries.n, 1, 'but the attempt is counted');
  });

  await t('a thin list is not worth a notification, and does not burn retries', async () => {
    st.items = st.items.slice(0, 2);              // fewer than three open
    st.users.L.digestTries = undefined;
    await push.tick(new Date(2026, 8, 6, 19, 0, 0));
    assert.strictEqual(st.users.L.digestTries, undefined,
      '"nothing much to say" is not a failure');
  });

  await t('digest contents obey visibility too', () => {
    st.items = [
      { id: 'x1', spaceId: 'sp1', authorId: 'A', title: 'shared one', visibility: 'shared', done: false, createdAt: 1 },
      { id: 'x2', spaceId: 'sp1', authorId: 'A', title: 'PRIVATE ONE', visibility: 'private', done: false, createdAt: 2 },
      { id: 'x3', spaceId: 'sp1', authorId: 'A', title: 'done one', visibility: 'shared', done: true, createdAt: 3 },
    ];
    const open = push.openFor('L');
    assert.deepStrictEqual(open.map(i => i.title), ['shared one'],
      'not the private one, and not the finished one');
    assert.deepStrictEqual(push.openFor('A').map(i => i.title).sort(),
      ['PRIVATE ONE', 'shared one'], 'the author sees their own');
  });

  push.stop();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  delete process.env.DATA_FILE;
}

/* ── 5d. geocoding ───────────────────────────────────────────────────────── */

async function geocoding() {
  console.log('\ngeocoding');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-geo-'));
  process.env.DATA_FILE = path.join(dir, 'store.json');
  fs.writeFileSync(process.env.DATA_FILE,
    JSON.stringify({ users: {}, spaces: [], items: [], invites: [], places: {}, seq: 1 }));
  // store is a singleton and nudges() already loaded it against its own temp file,
  // so this section drives lib/geo with an injected fetch and its own cache object
  // rather than trying to re-point the store.
  const geo = require('../lib/geo');
  const ok = (lat, lon) => async () => ({ ok: true, json: async () => [{ lat: String(lat), lon: String(lon), display_name: 'Somewhere' }] });

  await t('a coordinate off the Earth is refused rather than stored', async () => {
    assert.strictEqual(geo.onEarth(38.9, -77), true);
    for (const [la, lo] of [[999, 0], [0, -400], [NaN, 0], [0, 0]]) {
      assert.strictEqual(geo.onEarth(la, lo), false, `${la},${lo}`);
    }
    // 0,0 is in the Gulf of Guinea and is almost always a parse failure.
    const r = await geo.lookup('gulf of guinea nonsense', { fetchImpl: ok(0, 0) });
    assert.strictEqual(r.lat, null, 'stored as "not a place", not as a pin in the sea');
  });

  await t('the same place is looked up once, whatever the casing', async () => {
    let calls = 0;
    const counted = async (...a) => { calls++; return ok(38.9217, -77.0425)(...a); };
    const a = await geo.lookup('Adams Morgan', { fetchImpl: counted });
    const b = await geo.lookup('  adams   morgan ', { fetchImpl: counted });
    assert.strictEqual(a.lat, 38.9217);
    assert.strictEqual(b.lat, 38.9217);
    assert.strictEqual(calls, 1, 'one request — Nominatim asks you to cache, and it is right to');
  });

  await t('a name that is not a place is remembered as such', async () => {
    const empty = async () => ({ ok: true, json: async () => [] });
    const r = await geo.lookup('asdfqwerzxcv not a place', { fetchImpl: empty });
    assert.strictEqual(r.lat, null);
    let calls = 0;
    await geo.lookup('asdfqwerzxcv not a place', { fetchImpl: async () => { calls++; return empty(); } });
    assert.strictEqual(calls, 0, 'or it would cost a request on every single render');
  });

  await t('a network failure is NOT remembered as "not a place"', async () => {
    const down = async () => { throw new Error('network down'); };
    assert.strictEqual(await geo.lookup('somewhere real', { fetchImpl: down }), null,
      'no pin yet, rather than a 500 on a page that is mostly about something else');
    // And it will try again, because a blip is not evidence.
    const r = await geo.lookup('somewhere real', { fetchImpl: ok(51.5, -0.12) });
    assert.strictEqual(r.lat, 51.5);
  });

  await t('too short to be a place is not asked about', async () => {
    let calls = 0;
    for (const q of ['', ' ', 'a']) {
      assert.strictEqual(await geo.lookup(q, { fetchImpl: async () => { calls++; return ok(1, 1)(); } }), null, JSON.stringify(q));
    }
    assert.strictEqual(calls, 0);
  });

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  delete process.env.DATA_FILE;
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
  // A stand-in for Photon, so the suite never needs the internet and can see
  // exactly what the server asked it.
  const photonHits = [];
  const photon = require('http').createServer((req, res) => {
    photonHits.push(new URL(req.url, 'http://x'));
    res.setHeader('content-type', 'application/json');
    // And for Nominatim's lookup, which the place page asks for hours.
    if (req.url.startsWith('/lookup')) {
      return res.end(JSON.stringify([{
        extratags: { opening_hours: 'Mo-Fr 08:00-17:00; Sa 10:00-14:00', website: 'https://toki.example' },
        address: { house_number: '1234', road: 'H Street Northeast', suburb: 'Atlas District' },
      }]));
    }
    res.end(JSON.stringify({ type: 'FeatureCollection', features: [TOKI] }));
  }).listen(0, '127.0.0.1');
  await new Promise(r => photon.once('listening', r));
  fs.writeFileSync(cfgFile, JSON.stringify({
    sessionSecret: SECRET,
    placesEndpoint: `http://127.0.0.1:${photon.address().port}/api/`,
    geoLookupEndpoint: `http://127.0.0.1:${photon.address().port}/lookup`,
  }), { mode: 0o600 });
  // Admin is read from config LIVE, so the suite can grant and revoke it
  // mid-run — which is also the property worth having: no restart either way.
  const setAdmins = (ids) => {
    const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    c.admins = ids;
    fs.writeFileSync(cfgFile, JSON.stringify(c), { mode: 0o600 });
  };

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
      ['POST', '/api/item/x/when'], ['GET', '/api/space/sp1/pleasure'], ['POST', '/api/space/sp1/pleasure'],
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
      ['POST', `/api/item/${priv.id}/when`, { date: '2026-12-05' }],
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

  await t('anyone who can see a thing can put it on a day — and who did is recorded', async () => {
    const it = (await api('GET', '/api/space/sp1/items', null, L)).body.items
      .find(i => i.title === 'See Khruangbin live');
    assert.strictEqual(it.canEdit, false, 'it is not hers to edit');
    assert.strictEqual(it.when, null, 'unplanned reads as null, not undefined');
    const r = await api('POST', `/api/item/${it.id}/when`, { date: '2026-12-05', time: '20:30' }, L);
    assert.strictEqual(r.status, 200, 'but it is hers to plan');
    assert.deepStrictEqual(r.body.item.when, { date: '2026-12-05', time: '20:30' });
    assert.strictEqual(r.body.item.plannedByName, 'Linnea');
    // A PATCH cannot set it — not even the author's own.
    await api('PATCH', `/api/item/${it.id}`, { when: { date: '2030-01-01' } }, A);
    const mine = (await api('GET', '/api/space/sp1/items', null, A)).body.items.find(i => i.id === it.id);
    assert.strictEqual(mine.when.date, '2026-12-05', 'a patch does not move a plan');
    // A day that does not exist is refused, and the plan stands.
    assert.strictEqual((await api('POST', `/api/item/${it.id}/when`, { date: '2026-02-30' }, A)).status, 400);
    // And it can be taken off the calendar again.
    const c = await api('POST', `/api/item/${it.id}/when`, { clear: true }, A);
    assert.strictEqual(c.body.item.when, null);
    assert.strictEqual(c.body.item.plannedBy, null);
  });

  await t('the rose: body answers are shared, things to try only where you BOTH lean yes', async () => {
    const P = '/api/space/sp1/pleasure';
    const body = (part, act, level, who) => api('POST', P, { kind: 'body', part, act, level }, who);
    const tryIt = (id, level, who) => api('POST', P, { kind: 'try', id, level }, who);
    assert.strictEqual((await body('neck', 'kiss', 'love', A)).status, 200);
    await tryIt('blindfold', 'yes', A);
    await tryIt('roleplay', 'love', A);
    await tryIt('roleplay', 'soft', L);      // her no must not reveal his yes
    await tryIt('blindfold', 'maybe', L);    // a maybe and a yes is a match
    await tryIt('spanking', 'love', L);      // his silence must not reveal her yes
    const hers = (await api('GET', P, null, L)).body;
    assert.strictEqual(hers.partner, 'Andrew');
    assert.deepStrictEqual(hers.theirs.body, { neck: { kiss: 'love' } }, 'his body answers are hers to see');
    assert.deepStrictEqual(hers.matches.map(m => m.id), ['blindfold']);
    assert.strictEqual(hers.theirs.try, undefined, 'his try answers are never sent, only matches');
    assert.ok(!JSON.stringify(hers).includes('"roleplay":"love"'), 'his yes does not leak through her no');
    const his = (await api('GET', P, null, A)).body;
    assert.ok(!JSON.stringify(his.theirs).includes('spanking') && !his.matches.some(m => m.id === 'spanking'));
    // Tapping the same answer again takes it back: null clears.
    await body('neck', 'kiss', null, A);
    assert.deepStrictEqual((await api('GET', P, null, L)).body.theirs.body, {});
    // Nothing outside the catalogue, and no level outside the scale.
    for (const bad of [{ kind: 'body', part: 'neck', act: 'stab', level: 'yes' },
      { kind: 'try', id: 'blindfold', level: 'obviously' }, { kind: 'try', id: '__proto__', level: 'yes' }, {}]) {
      assert.strictEqual((await api('POST', P, bad, A)).status, 400, JSON.stringify(bad));
    }
    // Your own question: she sees the question, not who asked or how he answered.
    const added = (await api('POST', P, { kind: 'custom-add', label: '  Dancing   in the kitchen ' }, A)).body;
    const q = added.custom.find(c => c.label === 'Dancing in the kitchen');
    assert.ok(q && q.byMe, 'tidied, and marked as his on his side');
    assert.strictEqual((await api('POST', P, { kind: 'custom-add', label: 'dancing in the kitchen' }, L)).status, 400,
      'asking the same thing twice is noise');
    await tryIt(q.id, 'love', A);
    const seen = (await api('GET', P, null, L)).body;
    assert.strictEqual(seen.custom.find(c => c.id === q.id).byMe, false);
    assert.ok(!seen.matches.some(m => m.id === q.id), 'no match until she answers too');
    await tryIt(q.id, 'yes', L);
    assert.ok((await api('GET', P, null, L)).body.matches.some(m => m.id === q.id), 'and then it is one');
    assert.strictEqual((await api('POST', P, { kind: 'custom-remove', id: q.id }, L)).status, 404,
      'only whoever asked can take it back');
    const gone = (await api('POST', P, { kind: 'custom-remove', id: q.id }, A)).body;
    assert.ok(!gone.custom.length && !gone.matches.some(m => m.id === q.id) && !(q.id in gone.mine.try),
      'and taking it back takes the answers with it');
    assert.strictEqual((await tryIt(q.id, 'yes', A)).status, 400, 'a removed question cannot be answered');
    // Not in the list: it does not exist. Not a pair: it does not exist either.
    assert.strictEqual((await api('GET', P, null, S)).status, 404);
    const solo = (await api('POST', '/api/space', { name: 'just me' }, A)).body.space.id;
    assert.strictEqual((await api('GET', `/api/space/${solo}/pleasure`, null, A)).status, 404);
    // A different pair sees a different book: Andrew and Sam start blank.
    const sam = (await api('GET', '/api/space/sp2/pleasure', null, S)).body;
    assert.deepStrictEqual([sam.theirs.body, sam.matches], [{}, []]);
    assert.strictEqual((await api('GET', '/api/state', null, L)).body.pleasure, undefined,
      'and none of it rides along on /api/state');
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
    await api('POST', '/api/space/sp2/pleasure', { kind: 'try', id: 'toys', level: 'yes' }, S);
    await api('POST', '/api/space/sp2/leave', {}, S);
    assert.strictEqual((await api('GET', '/api/space/sp2/items', null, S)).status, 404, 'Sam is out');
    await new Promise(r => setTimeout(r, 400));   // past the store's write debounce
    const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.ok(!Object.keys(disk.pleasure || {}).some(k => k.split('|').includes(S)),
      'leaving a pair takes the rose answers with it');
    const after = await api('GET', '/api/space/sp2/items', null, A);
    assert.strictEqual(after.status, 200, 'Andrew still has it');
    assert.strictEqual(after.body.items.length, before);
  });

  await t('groups on the wire are derived from what YOU can see', async () => {
    // The important one, and it survives the move from tags to kinds unchanged:
    // a kind living only on somebody's private items must make a group on their
    // screen and no group at all on anybody else's.
    await api('POST', '/api/space/sp1/item',
      { title: 'a secret recipe', visibility: 'private', kind: 'recipe' }, A);
    await api('POST', '/api/space/sp1/item',
      { title: 'a film for us', visibility: 'shared', kind: 'movie' }, A);

    const mine = (await api('GET', '/api/space/sp1/items', null, A)).body;
    const hers = (await api('GET', '/api/space/sp1/items', null, L)).body;
    assert.ok(mine.groups.some(g => g.key === 'recipe'), 'the author sees their own group');
    assert.ok(!hers.groups.some(g => g.key === 'recipe'),
      'and nobody else learns it exists — not even that the kind is in use');
    assert.ok(hers.groups.some(g => g.key === 'movie'), 'the shared one is shared');
    // And the same of the bottom nav's counts, which is what is actually drawn:
    // a private recipe must not raise the number on anybody else's Recipes tab.
    const count = (b, id) => b.tabs.find(t => t.id === id).count;
    assert.strictEqual(count(mine, 'recipe'), 1, 'his own tab counts it');
    assert.strictEqual(count(hers, 'recipe'), 0, 'and hers does not');
    assert.strictEqual(count(hers, 'movie'), 1, 'the shared one counts for both');
    // Every kind gets a tab, empty or not — furniture stays where you left it.
    assert.strictEqual(hers.tabs.length, require('../lib/kinds').KINDS.length);
  });

  await t('a tag arrives as typed and is capped at the gate', async () => {
    const { body } = await api('POST', '/api/space/sp1/item',
      { title: 'tagged', tags: ['AFI', 'afi', '  AFI ', 'Rainy Day'] }, A);
    assert.deepStrictEqual(body.item.tags, ['AFI', 'Rainy Day'],
      'deduped by fold, first spelling kept');
  });

  await t('geocoding is scoped to what you can see', async () => {
    // It cannot be used to resolve names by proxy, and cannot reveal that a
    // private item exists by counting how many names it asked about.
    assert.strictEqual((await api('POST', '/api/space/sp1/geocode', {}, S)).status, 404,
      'not your list, not your lookup');
    const { status, body } = await api('POST', '/api/space/sp1/geocode', {}, L);
    assert.strictEqual(status, 200);
    assert.ok(typeof body.asked === 'number' && body.asked <= 10, 'and it is batched');
  });

  await t('a place with no coordinates is simply absent from the map', async () => {
    const { body } = await api('POST', '/api/space/sp1/item',
      { title: 'ramen somewhere', mod: { place: { name: 'that ramen bar' } } }, A);
    const pl = body.item.mod.place;
    assert.strictEqual(pl.name, 'that ramen bar');
    assert.strictEqual(pl.lat, null,
      'a name is a fine place; a guessed pin is worse than no pin');
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

  await t('a short code signs you in over HTTP, once', async () => {
    // Minted server-side, as links are. There is no route that issues one.
    //
    // The server has to be STOPPED first. A live one holds the whole store in
    // memory and flushes it on SIGTERM, so minting into the file underneath it
    // and then restarting loses the write — which is exactly the footgun
    // tools/link.js now refuses to let you walk into.
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));

    const { spawnSync } = require('child_process');
    const probe = spawnSync(process.execPath, ['-e', `
      const store = require('${path.join(__dirname, '..', 'store')}');
      const magic = require('${path.join(__dirname, '..', 'lib', 'magic')}');
      store.state.users['probe'] = { id: 'probe', name: 'Probe', createdAt: 1 };
      process.stdout.write(magic.mintCode(store.state, 'probe').code);
      store.flushSync();
    `], { env: { ...process.env, DATA_FILE: dataFile, CONFIG_FILE: cfgFile } });
    const code = probe.stdout.toString().trim();
    assert.ok(/^[A-Z2-9]{8}$/.test(code), `bad code: ${code}`);

    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DATA_FILE: dataFile, CONFIG_FILE: cfgFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/api/auth/me`)).ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 150));
    }

    // A GET is what a link-preview crawler does. It must show the page and spend
    // nothing — do it several times to be sure.
    for (let i = 0; i < 3; i++) {
      const peek = await fetch(`${BASE}/l/${code}`);
      assert.strictEqual(peek.status, 200, 'a crawler gets a page');
      assert.ok(!(peek.headers.get('set-cookie') || '').includes(AUTH.COOKIE),
        'and no session — fetching a link must not sign anybody in');
      assert.ok(/Sign in as/.test(await peek.text()), 'it says who it is for');
    }

    // The button behind it is what actually redeems.
    const r = await fetch(`${BASE}/l/${code.toLowerCase()}`, { method: 'POST', redirect: 'manual' });
    assert.strictEqual(r.status, 302, 'typed in lowercase, still works');
    assert.ok((r.headers.get('set-cookie') || '').includes(AUTH.COOKIE));
    const again = await fetch(`${BASE}/l/${code}`, { method: 'POST', redirect: 'manual' });
    assert.strictEqual(again.status, 400, 'and only once');
    const dead = await fetch(`${BASE}/l/${code}`);
    assert.ok(/already been used/.test(await dead.text()), 'and says so plainly afterwards');
  });

  await t('there is NO route that mints a link — that is what keeps it safe', async () => {
    // Possession of shell access is the credential. If any of these ever answer,
    // anyone could ask for a link to anybody's account.
    for (const [m, p] of [['POST', '/api/auth/link'], ['GET', '/api/auth/link'],
      ['POST', `/api/auth/link/${A}`], ['GET', `/login`],
      ['POST', '/api/auth/code'], ['GET', '/api/auth/code'], ['POST', `/l`]]) {
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

  await t('/share serves the app so a share survives sign-in', async () => {
    // The share lives in the URL, which is what makes it survive the round trip
    // through an identity provider instead of being dropped on the floor.
    const r = await fetch(`${BASE}/share?title=Khruangbin&url=https%3A%2F%2Fex.com%2Fx`, { redirect: 'manual' });
    assert.strictEqual(r.status, 200, 'signed out or in, it serves the shell');
    const html = await r.text();
    assert.ok(/\/js-[a-z0-9]+\/app\.js/.test(html), 'and it is the stamped shell, not a bare page');
  });

  await t('the manifest declares a share target', async () => {
    const m = await (await fetch(`${BASE}/manifest.json`)).json();
    assert.strictEqual(m.share_target.action, '/share');
    assert.strictEqual(m.share_target.method, 'GET',
      'GET so the same URL works from a Shortcut or a bookmarklet — iOS has no share target at all');
  });

  await t('the shell is cache-busted and the stamped js path resolves', async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    assert.ok(/style\.css\?v=[a-z0-9]+/.test(html));
    const m = html.match(/\/js-[a-z0-9]+\//)[0];
    assert.strictEqual((await fetch(BASE + m + 'app.js')).status, 200);
  });

  await t('THE SHELL ENDS WHERE iOS DRAWS, and drops dead padding when that is short', () => {
    // MEASURED with the account-sheet readout, iPhone 16 Pro Max, standalone,
    // iOS 26: screen 956 · window 894 · lvh 956 · insets 62/34. Sizing #app to
    // 100lvh made it 0→956 and the nav was CLIPPED at 894 — the web view is
    // only drawn that far. So: inset:0, and when the viewport is short of the
    // screen the bottom inset is dead space (the edge is 62pt from the indicator).
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(/#app\{position:fixed;inset:0;overflow:hidden\}/.test(css), 'the shell is the drawn viewport');
    assert.ok(!/height:100lvh/.test(css), 'and never the large viewport — that is drawn past and clipped');
    assert.ok(/\.short-vp\{--safe-b:0px\}/.test(css), 'a short viewport drops the bottom inset');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.ok(/<script>[^<]*short-vp/.test(head), 'decided by an inline script in <head>, before paint');
    assert.ok(/--safe-b:env\(safe-area-inset-bottom,0px\)/.test(css), 'otherwise the inset is honoured, unclamped');
    assert.ok(/--safe-t:env\(safe-area-inset-top,0px\)/.test(css), 'top inset unclamped');
    assert.ok(/padding:calc\(var\(--safe-t\)/.test(css), 'the masthead clears the notch');
    assert.ok(/\.kindnav\{[^}]*calc\(var\(--safe-b\) \+ \d+px\)/.test(css), 'the nav clears the indicator');
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

  await t('an admin can correct somebody else\'s item — the words, never the audience', async () => {
    const hers = (await api('POST', '/api/space/sp1/item', { title: 'Go swing dancng' }, L)).body.item;
    const secret = (await api('POST', '/api/space/sp1/item', { title: 'a secret', visibility: 'private' }, L)).body.item;
    assert.strictEqual((await api('PATCH', `/api/item/${hers.id}`, { title: 'Go swing dancing' }, A)).status, 403,
      'not without the config');
    setAdmins([A]);
    try {
      const seen = (await api('GET', '/api/space/sp1/items', null, A)).body.items.find(i => i.id === hers.id);
      assert.strictEqual(seen.canEdit, true, 'the wire says so');
      assert.strictEqual(seen.canSetVisibility, true, 'full edit: who it is for too');
      assert.strictEqual(seen.canCredit, true, 'and whose idea it was');
      const r = await api('PATCH', `/api/item/${hers.id}`, { title: 'Go swing dancing', visibility: 'public' }, A);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.item.title, 'Go swing dancing');
      assert.strictEqual(r.body.item.visibility, 'public', 'who it is for is his to fix as well');
      await api('PATCH', `/api/item/${hers.id}`, { visibility: 'shared' }, A);
      assert.strictEqual(r.body.item.author.name, 'Linnea', 'and it is still her sentence');
      const asHer = (await api('GET', '/api/space/sp1/items', null, L)).body.items.find(i => i.id === hers.id);
      assert.strictEqual(asHer.editedByName, 'Andrew', 'she can see whose hand was last on it');
      // Her private thing does not exist, admin or not — same 404 as anyone.
      for (const [m, p, b] of [
        ['PATCH', `/api/item/${secret.id}`, { title: 'x' }],
        ['DELETE', `/api/item/${secret.id}`, null],
        ['POST', `/api/item/${secret.id}/watch`, { clear: true }],
      ]) assert.strictEqual((await api(m, p, b, A)).status, 404, `${m} ${p}`);
      assert.ok(!(await api('GET', '/api/space/sp1/items', null, A)).body.items.some(i => i.id === secret.id),
        'and it is not on his screen');
      // A list he is not in is a list he cannot correct. Sam starts one of his
      // own; to the admin, everything in it is a 404 like any stranger's.
      const samsList = (await api('POST', '/api/space', { name: 'Sam alone' }, S)).body.space;
      const sams = (await api('POST', `/api/space/${samsList.id}/item`, { title: 'Sam\'s thing' }, S)).body.item;
      assert.strictEqual((await api('PATCH', `/api/item/${sams.id}`, { title: 'x' }, A)).status, 404);
      assert.strictEqual((await api('DELETE', `/api/item/${sams.id}`, null, A)).status, 404);
      // Being an admin does not make anybody else one.
      const his = (await api('POST', '/api/space/sp1/item', { title: 'his' }, A)).body.item;
      assert.strictEqual((await api('PATCH', `/api/item/${his.id}`, { title: 'no' }, L)).status, 403);
      // A duplicate can go.
      assert.strictEqual((await api('DELETE', `/api/item/${hers.id}`, null, A)).status, 200);
      const after = (await api('GET', '/api/space/sp1/items', null, L)).body.items;
      assert.ok(!after.some(i => i.id === hers.id));
    } finally { setAdmins([]); }
    const again = (await api('POST', '/api/space/sp1/item', { title: 'hers again' }, L)).body.item;
    assert.strictEqual((await api('PATCH', `/api/item/${again.id}`, { title: 'x' }, A)).status, 403,
      'and taking it away needs no restart');
  });

  await t('whose idea: his to hand to her, an admin\'s to fix, never hers to claim on his', async () => {
    const his = (await api('POST', '/api/space/sp1/item', { title: 'Watch Obsession', kind: 'movie' }, A)).body.item;
    assert.strictEqual(his.ideaBy, A, 'his own idea until he says otherwise');
    assert.strictEqual(his.ideaMine, true);
    const smuggled = (await api('POST', '/api/space/sp1/item', { title: 'x', ideaBy: L }, A)).body.item;
    assert.strictEqual(smuggled.ideaBy, A, 'creating cannot set it — only the sheet, through the check');

    const r = await api('PATCH', `/api/item/${his.id}`, { ideaBy: L }, A);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.item.ideaBy, L);
    assert.strictEqual(r.body.item.ideaByName, 'Linnea');
    assert.strictEqual(r.body.item.ideaMine, false);
    assert.strictEqual(r.body.item.author.name, 'Andrew', 'still his sentence');
    const asHer = (await api('GET', '/api/space/sp1/items', null, L)).body.items.find(i => i.id === his.id);
    assert.strictEqual(asHer.ideaMine, true, 'on her side it is under her ideas');
    assert.strictEqual(asHer.canEdit, false, 'and credit is not a key to his wording');
    assert.strictEqual((await api('PATCH', `/api/item/${his.id}`, { ideaBy: L }, L)).status, 403);

    const notes = await api('PATCH', `/api/item/${his.id}`, { notes: 'the 1976 one' }, A);
    assert.strictEqual(notes.body.item.ideaBy, L, 'saving a note leaves the credit alone');

    // Somebody outside the list is refused, and nothing else in that patch lands.
    for (const who of [S, 'u-nobody']) {
      const bad = await api('PATCH', `/api/item/${his.id}`, { title: 'Renamed', ideaBy: who }, A);
      assert.strictEqual(bad.status, 400, `crediting ${who}`);
    }
    const still = (await api('GET', '/api/space/sp1/items', null, A)).body.items.find(i => i.id === his.id);
    assert.strictEqual(still.title, 'Watch Obsession', 'a refused credit changed nothing');
    assert.strictEqual(still.ideaBy, L);

    // Back to himself, by id or by null, is one state, not two.
    assert.strictEqual((await api('PATCH', `/api/item/${his.id}`, { ideaBy: A }, A)).body.item.ideaBy, A);
    await api('PATCH', `/api/item/${his.id}`, { ideaBy: L }, A);
    assert.strictEqual((await api('PATCH', `/api/item/${his.id}`, { ideaBy: null }, A)).body.item.ideaMine, true);

    // Hers, and really his idea: without admin it is not his to touch, with it
    // it is — the same right as fixing her words.
    const hers = (await api('POST', '/api/space/sp1/item', { title: 'Swing dancng' }, L)).body.item;
    assert.strictEqual((await api('PATCH', `/api/item/${hers.id}`, { ideaBy: A }, A)).status, 403, 'not without admin');
    setAdmins([A]);
    try {
      const fix = await api('PATCH', `/api/item/${hers.id}`, { title: 'Swing dancing', ideaBy: A }, A);
      assert.strictEqual(fix.status, 200);
      assert.strictEqual(fix.body.item.title, 'Swing dancing');
      assert.strictEqual(fix.body.item.ideaBy, A, 'his idea now');
      assert.strictEqual(fix.body.item.ideaMine, true);
      assert.strictEqual(fix.body.item.author.name, 'Linnea', 'still the sentence she wrote');
      const toHer = (await api('GET', '/api/space/sp1/items', null, L)).body.items.find(i => i.id === hers.id);
      assert.strictEqual(toHer.ideaByName, 'Andrew', 'and she sees it as his');
      assert.strictEqual((await api('PATCH', `/api/item/${hers.id}`, { ideaBy: S }, A)).status, 400,
        'still only someone in the list');
      // Exactly what the sheet sends for a film with a poster: the credit moves,
      // the poster stays. The report that started this was a film losing it.
      const w = { tmdbId: 88, mediaType: 'movie', title: 'Paper Moon', year: 1973, poster: '/pm.jpg', providers: [] };
      const film = (await api('POST', '/api/space/sp1/item', { title: 'Paper Moon', kind: 'movie', mod: { watch: w } }, L)).body.item;
      const sheet = await api('PATCH', `/api/item/${film.id}`,
        { title: 'Paper Moon', kind: 'movie', notes: '', visibility: 'shared', ideaBy: A, mod: {} }, A);
      assert.strictEqual(sheet.status, 200);
      assert.strictEqual(sheet.body.item.ideaBy, A);
      assert.strictEqual(sheet.body.item.kind, 'movie', 'still a film');
      assert.strictEqual(sheet.body.item.mod.watch && sheet.body.item.mod.watch.poster, '/pm.jpg', 'with its poster');
    } finally { setAdmins([]); }

    // Crediting her with a private thing does not show it to her.
    const priv = (await api('POST', '/api/space/sp1/item', { title: 'a surprise', visibility: 'private' }, A)).body.item;
    assert.strictEqual((await api('PATCH', `/api/item/${priv.id}`, { ideaBy: L }, A)).status, 200);
    assert.ok(!(await api('GET', '/api/space/sp1/items', null, L)).body.items.some(i => i.id === priv.id),
      'credit is a label, not an audience');
    assert.strictEqual((await api('POST', `/api/item/${priv.id}/done`, {}, L)).status, 404);
  });

  await t('editing a film in the sheet does not cost it its poster', async () => {
    const w = { tmdbId: 11, mediaType: 'movie', title: 'Past Lives', year: 2023, poster: '/abc.jpg', providers: [] };
    const made = (await api('POST', '/api/space/sp1/item', { title: 'Past Lives', kind: 'movie', mod: { watch: w } }, A)).body.item;
    assert.ok(made.mod.watch, 'seeded');
    // Exactly what the sheet sends: the slices a person types, and no poster.
    const r = await api('PATCH', `/api/item/${made.id}`, { title: 'Past Lives', kind: 'movie', notes: 'with Linnea', mod: {} }, A);
    assert.strictEqual(r.body.item.mod.watch && r.body.item.mod.watch.poster, '/abc.jpg',
      'a note is not a reason to lose the poster');
    const forged = await api('PATCH', `/api/item/${made.id}`,
      { title: 'Past Lives', kind: 'movie', mod: { watch: { ...w, poster: '/forged.jpg' } } }, A);
    assert.strictEqual(forged.body.item.mod.watch.poster, '/abc.jpg', 'and a patch cannot set one — /watch does that');
    const renamed = await api('PATCH', `/api/item/${made.id}`, { title: 'Past Lives (2023)', mod: {} }, A);
    assert.strictEqual(renamed.body.item.mod.watch, undefined, 'a rename still lets go of it');
  });

  await t('place suggestions need a session, and come back with pins', async () => {
    assert.strictEqual((await api('GET', '/api/place/suggest?q=toki', null, null)).status, 401);
    const r = await api('GET', '/api/place/suggest?q=toki%20u&lat=38.9&lon=-77.03', null, A);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.results[0].name, 'Toki Underground');
    assert.strictEqual(r.body.results[0].lat, 38.900482);
    const hit = photonHits[photonHits.length - 1];
    assert.strictEqual(hit.searchParams.get('q'), 'toki u');
    assert.strictEqual(hit.searchParams.get('lat'), '38.9', 'biased toward the list');
    const junk = await api('GET', '/api/place/suggest?q=toki%20v&lat=abc&lon=', null, A);
    assert.strictEqual(junk.status, 200, 'a junk bias is no bias, not an error');
    assert.strictEqual(photonHits[photonHits.length - 1].searchParams.get('lat'), null);
  });

  await t('a picked place keeps its pin through a save; a pin in the sea is refused', async () => {
    const made = (await api('POST', '/api/space/sp1/item', { title: 'Toki', kind: 'place' }, A)).body.item;
    const place = { name: 'Toki Underground', address: '1234 H Street Northeast, Washington', lat: 38.900482, lon: -76.989033 };
    const r = await api('PATCH', `/api/item/${made.id}`, { title: 'Toki', mod: { place } }, A);
    assert.deepStrictEqual(r.body.item.mod.place, { ...place, area: null, what: null, osm: null });
    const bad = await api('PATCH', `/api/item/${made.id}`, { title: 'Toki', mod: { place: { name: 'Nowhere', lat: 123, lon: 5 } } }, A);
    assert.strictEqual(bad.body.item.mod.place.lat, null, 'half a coordinate pair is nothing at all');
    assert.strictEqual(bad.body.item.mod.place.lon, null);
  });

  await t('a film stored with two tiers of one service shows it once', async () => {
    const w = { tmdbId: 489, mediaType: 'movie', title: 'A film with tiers', year: 2001, poster: null,
      providers: [{ name: 'Amazon Prime Video', logo: null }, { name: 'Apple TV', logo: null },
        { name: 'Paramount Plus Premium', logo: null }, { name: 'Paramount Plus Essential', logo: null }] };
    const made = (await api('POST', '/api/space/sp1/item', { title: 'A film with tiers', kind: 'movie', mod: { watch: w } }, A)).body.item;
    assert.deepStrictEqual(made.mod.watch.providers.map(p => p.name),
      ['Amazon Prime Video', 'Apple TV', 'Paramount Plus Premium'], 'folded on the way out, the store untouched');
  });

  await t('a place carries which OSM object it is, and only with a pin', async () => {
    const place = { name: 'Toki Underground', lat: 38.900482, lon: -76.989033, area: 'Atlas District', what: 'restaurant', osm: 'N2193' };
    const made = (await api('POST', '/api/space/sp1/item', { title: '🍜 Toki', kind: 'place', mod: { place } }, A)).body.item;
    assert.deepStrictEqual(made.mod.place, { ...place, address: null }, 'creating can pin it in one go');
    const words = (await api('POST', '/api/space/sp1/item',
      { title: 'Somewhere', kind: 'place', mod: { place: { name: 'Somewhere', area: 'X', what: 'y', osm: 'N1' } } }, A)).body.item;
    assert.deepStrictEqual([words.mod.place.area, words.mod.place.what, words.mod.place.osm], [null, null, null],
      "OSM's facts about a place come with OSM's pin, not on their own");
    const bad = (await api('PATCH', `/api/item/${made.id}`,
      { title: '🍜 Toki', mod: { place: { ...place, osm: 'N1; DROP' } } }, A)).body.item;
    assert.strictEqual(bad.mod.place.osm, null, 'an id that is not an OSM id never reaches a lookup URL');
  });

  await t("a place's details are fetched live, read into a week, and 404 to anyone who cannot see it", async () => {
    const place = { name: 'Toki Underground', lat: 38.900482, lon: -76.989033, osm: 'W77' };
    const mine = (await api('POST', '/api/space/sp1/item', { title: 'Toki', kind: 'place', visibility: 'private', mod: { place } }, A)).body.item;
    const r = await api('GET', `/api/item/${mine.id}/place`, null, A);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.details.website, 'https://toki.example');
    assert.strictEqual(r.body.details.address, '1234 H Street Northeast, Atlas District');
    assert.deepStrictEqual(r.body.details.week[5], [['10:00', '14:00']], 'Saturday');
    assert.deepStrictEqual(r.body.details.week[6], [], 'and Sunday, which no rule mentions, is closed');
    const asked = photonHits.filter(u => u.pathname === '/lookup');
    assert.strictEqual(asked[asked.length - 1].searchParams.get('osm_ids'), 'W77');
    assert.strictEqual((await api('GET', `/api/item/${mine.id}/place`, null, L)).status, 404,
      'a private place is the same 404 to her as anything else');
    const unpinned = (await api('POST', '/api/space/sp1/item', { title: 'Botanic garden', kind: 'place' }, A)).body.item;
    assert.deepStrictEqual((await api('GET', `/api/item/${unpinned.id}/place`, null, A)).body, { ok: true, details: null });
  });

  await t('the visit: book ahead is planning, the rest waits until you have been', async () => {
    const it = (await api('POST', '/api/space/sp1/item', { title: 'Blues Alley', kind: 'place', visit: { book: true } }, A)).body.item;
    assert.strictEqual(it.visit, null, 'creating cannot smuggle one in');
    const booked = await api('POST', `/api/item/${it.id}/visit`, { book: true }, L);
    assert.strictEqual(booked.status, 200, 'she can mark his place book-ahead — it is planning');
    assert.strictEqual(booked.body.item.visit.book, true);
    assert.strictEqual((await api('POST', `/api/item/${it.id}/visit`, { again: 'soon' }, L)).status, 409,
      '"would you go back" before going is a guess');
    assert.strictEqual((await api('POST', `/api/item/${it.id}/visit`, { book: 'yes' }, L)).status, 400);
    await api('POST', `/api/item/${it.id}/done`, { done: true }, L);
    const been = await api('POST', `/api/item/${it.id}/visit`, { again: 'soon', memory: '  the trio was great ' }, L);
    assert.deepStrictEqual(been.body.item.visit, { book: true, again: 'soon', memory: 'the trio was great' });
    assert.strictEqual((await api('POST', `/api/item/${it.id}/visit`, { again: 'forever' }, A)).status, 400);
    const patched = await api('PATCH', `/api/item/${it.id}`, { title: 'Blues Alley', visit: null, mod: {} }, A);
    assert.deepStrictEqual(patched.body.item.visit, been.body.item.visit, 'a PATCH can neither set it nor lose it');
    const cleared = await api('POST', `/api/item/${it.id}/visit`, { book: false, again: null, memory: null }, A);
    assert.strictEqual(cleared.body.item.visit, null, 'nothing left is one state, not three falses');
    const secret = (await api('POST', '/api/space/sp1/item', { title: 'Mine alone', kind: 'place', visibility: 'private' }, A)).body.item;
    assert.strictEqual((await api('POST', `/api/item/${secret.id}/visit`, { book: true }, L)).status, 404);
  });

  await t("the shelf of lists counts what is waiting per kind, from the viewer's side", async () => {
    const recipes = async (uid) => ((await api('GET', '/api/state', null, uid)).body.spaces
      .find(x => x.id === 'sp1').counts.byKind.recipe || 0);
    const [his, hers] = [await recipes(A), await recipes(L)];
    const made = await api('POST', '/api/space/sp1/item', { title: 'Secret ragu', kind: 'recipe', visibility: 'private' }, L);
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(await recipes(L), hers + 1, 'her private recipe raises her number');
    assert.strictEqual(await recipes(A), his, 'and not his');
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
  photon.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/* ── place suggestions ───────────────────────────────────────────────────── */

const photonFeature = (props, coords) =>
  ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: coords } });
const TOKI = photonFeature({
  osm_key: 'amenity', osm_value: 'restaurant', name: 'Toki Underground', housenumber: '1234',
  street: 'H Street Northeast', city: 'Washington', state: 'District of Columbia', country: 'United States',
}, [-76.9890327, 38.9004823]);

async function placeSuggestions() {
  console.log('\nplace suggestions');
  const P = require('../lib/places');

  await t('a Photon feature becomes a name, an address line and a pin', () => {
    assert.deepStrictEqual(P.shapeOne(TOKI), {
      name: 'Toki Underground',
      address: '1234 H Street Northeast, Washington, District of Columbia',
      lat: 38.900482, lon: -76.989033, what: 'restaurant', area: 'Washington', osm: null,
    });
  });

  await t('and which OSM object it is, and the neighbourhood rather than the city', () => {
    const blues = P.shapeOne(photonFeature({ osm_type: 'N', osm_id: 368154, osm_key: 'amenity', osm_value: 'bar',
      name: 'Blues Alley', district: 'Georgetown', city: 'Washington' }, [-77.06, 38.904]));
    assert.strictEqual(blues.osm, 'N368154');
    assert.strictEqual(blues.area, 'Georgetown');
    for (const [type, id] of [['X', 1], ['N', 0], ['W', '12a'], ['R', -4]]) {
      assert.strictEqual(P.shapeOne(photonFeature({ osm_type: type, osm_id: id, name: 'A' }, [-77, 38.9])).osm, null, `${type}${id}`);
    }
  });

  await t('opening hours: the common shapes become a week, anything else becomes nothing', () => {
    const H = require('../lib/hours');
    const w = H.parse('Mo-Fr 08:00-17:00; Sa 10:00-14:00');
    assert.deepStrictEqual(w[0], [['08:00', '17:00']]);
    assert.deepStrictEqual(w[6], [], 'a day no rule mentions is closed');
    assert.deepStrictEqual(H.parse('24/7')[3], [['00:00', '24:00']]);
    assert.deepStrictEqual(H.parse('Tu-Su 11:00-14:30,17:00-22:00; Mo off')[0], []);
    assert.deepStrictEqual(H.parse('Fr-Mo 18:00-02:00')[0], [['18:00', '02:00']], 'Fr-Mo wraps the weekend');
    assert.deepStrictEqual(H.parse('Mo-Su 09:00-17:00; PH off')[2], [['09:00', '17:00']], 'holidays skipped, not guessed');
    for (const x of ['sunrise-sunset', 'by appointment', 'Mo-Fr', '', null, 'Mo 25:00-26:00']) {
      assert.strictEqual(H.parse(x), null, String(x));
    }
  });

  await t("a place's details keep only safe links and say nothing they were not told", () => {
    const G = require('../lib/geo');
    const d = G.shapeDetails({ extratags: { website: 'javascript:alert(1)', 'contact:phone': '+1 202 555 0100' },
      address: { road: 'M Street', city: 'Washington' } });
    assert.strictEqual(d.website, null, 'this ends up in an href on somebody else\'s phone');
    assert.strictEqual(d.phone, '+1 202 555 0100');
    assert.strictEqual(d.address, 'M Street, Washington');
    assert.deepStrictEqual(G.shapeDetails(null), { hours: null, website: null, phone: null, address: null });
  });

  await t('the visit gate takes only what it knows, and nothing left is null', () => {
    const I = require('../lib/items');
    const it = { done: false, visit: null };
    assert.ok(I.setVisit(it, { book: true }));
    assert.deepStrictEqual(it.visit, { book: true, again: null, memory: null });
    assert.strictEqual(I.setVisit(it, { again: 'always' }), null);
    assert.strictEqual(I.setVisit(it, { book: 1 }), null, 'a switch is a boolean, not a truthy thing');
    assert.strictEqual(I.setVisit(it, { memory: { x: 1 } }), null);
    assert.ok(I.setVisit(it, { book: false }));
    assert.strictEqual(it.visit, null);
  });

  await t('a pin that is not on Earth is refused — the Gulf of Guinea included', () => {
    for (const c of [[0, 0], [200, 10], [10, 95], ['x', 1], []]) {
      assert.strictEqual(P.shapeOne(photonFeature({ name: 'Somewhere' }, c)), null, JSON.stringify(c));
    }
    assert.strictEqual(P.shapeOne({ properties: { name: 'No geometry' } }), null);
    assert.strictEqual(P.shapeOne(photonFeature({}, [-77, 38.9])), null, 'and a place needs a name');
  });

  await t('one place appears once, and a street says nothing about what it is', () => {
    const footway = photonFeature({ osm_key: 'highway', osm_value: 'footway', name: 'Toki Passage', city: 'Tokyo', country: 'Japan' }, [139.77, 35.68]);
    const got = P.shape({ features: [TOKI, TOKI, footway] });
    assert.deepStrictEqual(got.map(s => s.name), ['Toki Underground', 'Toki Passage']);
    assert.strictEqual(got[1].what, null, '"footway" is not how anybody describes a place');
    assert.strictEqual(got[1].address, 'Tokyo, Japan', 'no street, so the country earns its place');
    assert.deepStrictEqual(P.shape(null), []);
    assert.deepStrictEqual(P.shape({ features: 'nope' }), []);
  });

  await t('a city is not described as itself', () => {
    const dc = P.shapeOne(photonFeature({ name: 'Washington', city: 'Washington', state: 'District of Columbia', country: 'United States' }, [-77.03, 38.9]));
    assert.strictEqual(dc.address, 'District of Columbia, United States');
  });

  await t('suggest never throws, and a failure is not remembered', async () => {
    let calls = 0;
    const boom = async () => { calls++; throw new Error('offline'); };
    assert.deepStrictEqual(await P.suggest('anywhere at all', null, { fetchImpl: boom }), { ok: false, results: [] });
    await P.suggest('anywhere at all', null, { fetchImpl: boom });
    assert.strictEqual(calls, 2, 'a blip is not "there is nowhere by that name"');
  });

  await t('a short query costs nothing, a repeat is cached, and the bias goes with it', async () => {
    const urls = [];
    const ok = async (u) => { urls.push(new URL(u)); return { ok: true, json: async () => ({ features: [TOKI] }) }; };
    assert.deepStrictEqual((await P.suggest('t', null, { fetchImpl: ok })).results, []);
    assert.strictEqual(urls.length, 0, 'one letter is not a search');
    const first = await P.suggest('toki u', { lat: 38.9, lon: -77.03 }, { fetchImpl: ok });
    assert.strictEqual(first.results[0].name, 'Toki Underground');
    await P.suggest('Toki U', { lat: 38.901, lon: -77.031 }, { fetchImpl: ok });
    assert.strictEqual(urls.length, 1, 'same words, same neighbourhood: one request');
    assert.strictEqual(urls[0].searchParams.get('lat'), '38.9');
    assert.strictEqual(urls[0].searchParams.get('lon'), '-77.03');
    await P.suggest('toki u', { lat: 0, lon: 0 }, { fetchImpl: ok });
    assert.strictEqual(urls[1].searchParams.get('lat'), null, '0,0 is a parse failure, not a bias');
  });
}

/* ── run ─────────────────────────────────────────────────────────────────── */

(async () => {
  await visibility();
  await gate();
  await groupRules();
  await kindRules();
  await watchLookups();
  await moduleSeam();
  await inviteRules();
  await squareBridge();
  await magicLinks();
  await nudges();
  await geocoding();
  await placeSuggestions();
  await server();

  console.log(`\n${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log(`  · ${f}`);
  process.exit(fails.length ? 1 : 0);
})();
