// Drives headless chromium over the DevTools protocol against a throwaway server:
// signs in as one person, writes the three visibilities, and then checks the same
// list AS SOMEBODY ELSE — because the one thing a browser test can prove that an
// API test cannot is that a private thing never reaches the screen.
// Skips (exit 0) when chromium isn't installed.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let CHROME = null;
for (const bin of ['chromium', 'chromium-browser', 'google-chrome']) {
  try { execFileSync('which', [bin], { stdio: 'pipe' }); CHROME = bin; break; } catch (_) {}
}
if (!CHROME) { console.log('client-check: no chromium found, skipping'); process.exit(0); }

const PORT = 3909;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Same approach as the API suite: pre-write the secret, sign cookies with the
// very code the server verifies with. No test-only door in the server.
const AUTH = require('../lib/auth');
const SECRET = 'dowith-client-check-secret-0123456';
const A = 'u-andrew', L = 'u-linnea';

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onopen = () => resolve({
      send: (method, params = {}, sessionId) => new Promise((res, rej) => {
        const msgId = ++id;
        pending.set(msgId, { res, rej });
        ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
      }),
      on: (fn) => listeners.push(fn),
      close: () => ws.close(),
    });
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) listeners.forEach(fn => fn(msg));
    };
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-cc-'));
  const person = (id, name) => ({ id, email: `${name.toLowerCase()}@x.com`, name, createdAt: 1, lastSeen: 1 });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({
    users: { [A]: person(A, 'Andrew'), [L]: person(L, 'Linnea') },
    spaces: [{ id: 'sp1', name: null, memberIds: [A, L], createdBy: A, createdAt: 1 }],
    items: [], invites: [], seq: 100,
  }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sessionSecret: SECRET }));

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'store.json'), CONFIG_FILE: path.join(dir, 'config.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let slog = '';
  server.stdout.on('data', d => { slog += d; });
  server.stderr.on('data', d => { slog += d; });
  for (let i = 0; i < 60 && server.exitCode === null; i++) {
    try { if ((await fetch(`${BASE}/api/auth/me`)).ok) break; } catch (_) {}
    await sleep(150);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-prof-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9325', '--no-sandbox',
    '--disable-gpu', '--window-size=430,900', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });

  const errors = [];
  let cdp = null, fail = null;
  const cleanup = () => {
    try { cdp && cdp.close(); } catch (_) {}
    chrome.kill('SIGKILL');
    server.kill('SIGTERM');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    let wsUrl = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !wsUrl) {
      try { wsUrl = (await (await fetch('http://127.0.0.1:9325/json/version')).json()).webSocketDebuggerUrl; }
      catch (_) { await sleep(200); }
    }
    if (!wsUrl) throw new Error('chromium devtools never came up');

    cdp = await connectCdp(wsUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p = {}) => cdp.send(m, p, sessionId);

    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push(`EXCEPTION: ${d.exception?.description || d.text}`);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        const t = msg.params.entry.text || '';
        if (!/service ?worker/i.test(t)) errors.push(`CONSOLE: ${t}`);
      }
    });

    await S('Runtime.enable'); await S('Log.enable'); await S('Page.enable'); await S('Network.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });

    const evalJs = async (expr) => {
      const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`${expr} -> ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    };
    const check = (cond, msg) => { if (!cond) throw new Error(msg); };
    // Ask the LAYOUT, not a property: an author `display` rule can defeat [hidden]
    // and leave something on screen that a test believes is gone.
    const visible = (sel) => evalJs(
      `(() => { const e = document.querySelector('${sel}');
        return !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length)); })()`);
    const asUser = async (uid) => {
      await S('Network.clearBrowserCookies');
      await S('Network.setCookie', { name: AUTH.COOKIE, value: AUTH.sign(uid, SECRET), domain: '127.0.0.1', path: '/', httpOnly: true });
      await S('Page.navigate', { url: `${BASE}/` });
      await sleep(2200);
    };

    // ── signed out ──────────────────────────────────────────────────────
    await S('Page.navigate', { url: `${BASE}/` });
    await sleep(2200);
    check(await visible('#scr-auth'), 'no session must land on the sign-in screen');
    check(!(await visible('#shelfList')), 'the shelf must not render behind the gate');

    // ── Andrew ──────────────────────────────────────────────────────────
    await asUser(A);
    check(!(await visible('#scr-auth')), 'a session should get past the gate');
    // LAND IN THE LIST, not on the shelf of lists. Almost everybody has one and
    // will for a long time, so the shelf was a screen you tapped through on the
    // way to the only place you were ever going.
    check(await visible('#scr-space'), 'and land straight in the first list');
    check(!(await visible('#scr-shelf')), 'without stopping at the shelf');
    check(await evalJs(`document.getElementById('spaceTitle').innerText`) === 'Linnea',
      'titled from his side');

    // The shelf is still a tap away, which is the right way round — the common
    // case is free and the rare one costs a tap.
    await evalJs(`document.getElementById('spaceBack').click()`);
    await sleep(600);
    check(await visible('#scr-shelf'), 'the back arrow still reaches the shelf');
    check(/Linnea/.test(await evalJs(`document.getElementById('shelfList').innerText`)),
      'his one list is named after her');
    await evalJs(`document.querySelector('#shelfList [data-sp]').click()`);
    await sleep(1000);
    check(await visible('#scr-space'), 'and tapping it goes back in');

    // Write one of each visibility through the real composer.
    // Type FIRST, then say who it is for: the visibility row is a question about
    // the thing being written, so it is not on screen until there is one.
    const write = async (title, vis) => {
      await evalJs(`(() => { const i = document.getElementById('newItem');
        i.value = ${JSON.stringify(title)};
        i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(150);
      await evalJs(`document.querySelector('#visRow [data-v="${vis}"]').click()`);
      await sleep(120);
      await evalJs(`document.getElementById('btnAdd').click()`);
      await sleep(900);
    };
    await write('Go record shopping', 'shared');
    await write('Watch Obsession', 'private');
    await write('See Khruangbin live', 'public');

    check(await evalJs(`document.querySelectorAll('#itemList .it').length`) === 3, 'three items landed');
    const his = await evalJs(`document.getElementById('itemList').innerText`);
    check(/JUST YOU/i.test(his), 'the private one is marked as his alone');
    check(/ANYONE/i.test(his), 'and the public one as a standing wish');

    // ── Linnea, same list ───────────────────────────────────────────────
    // The assertion the whole app rests on.
    await asUser(L);
    // She lands in the same list, titled from her side — which is the mirroring
    // property and the whole conceit of the app, now visible without a tap.
    check(await visible('#scr-space'), 'she lands in it too');
    check(await evalJs(`document.getElementById('spaceTitle').innerText`) === 'Andrew',
      'the same list, mirrored to her side');
    const hers = await evalJs(`document.getElementById('itemList').innerText`);
    check(/record shopping/.test(hers), 'she sees the shared one');
    check(/Khruangbin/.test(hers), 'and the standing wish');
    check(!/Obsession/.test(hers),
      `a private item reached her screen — this is the bug the app cannot have:\n${hers}`);
    check(await evalJs(`document.querySelectorAll('#itemList .it').length`) === 2, 'two, not three');

    // ── the record ──────────────────────────────────────────────────────
    // She ticks his shared one off. It leaves the to-do list and turns up in the
    // record with her name on it — a list you finish is empty, and this is what
    // makes finishing worth something.
    // ONE CONTROL, not three. "To do" was a tab for the state you were already
    // in, and the map is parked until it has something worth showing — its
    // renderer is untouched, only the way in is gone.
    check(await evalJs(`document.querySelectorAll('#spaceTabs button').length`) === 1,
      'the list has one toggle, not a tab bar');
    check(await visible('#tabDone'), 'and it is the record');
    check(!(await visible('#spaceTabs [data-tab="map"]')), 'the map is parked for now');
    check(await evalJs(`document.getElementById('tabDone').getAttribute('aria-pressed')`) === 'false',
      'starting on what there is still to do');
    const beforeOpen = await evalJs(`document.querySelectorAll('#itemList .it').length`);
    await evalJs(`document.querySelector('#itemList .it [data-tick]').click()`);
    // Finishing something plays a ~700ms moment before the row leaves. Catch it
    // mid-flight: the row must still be there, marked, with the flourish on it —
    // a re-render that landed first would have destroyed the element.
    await sleep(160);
    check(await evalJs(`!!document.querySelector('#itemList .it.celebrating')`),
      'completing something should be an occasion, not a silent reflow');
    check(await evalJs(`document.querySelectorAll('#itemList .it.celebrating .spark').length`) === 6,
      'with the flourish actually in the DOM');
    await sleep(1100);
    check(await evalJs(`document.querySelectorAll('#itemList .it').length`) === beforeOpen - 1,
      'it leaves the to-do list rather than sitting there struck through');

    await evalJs(`document.getElementById('tabDone').click()`);
    await sleep(400);
    check(await evalJs(`document.getElementById('tabDone').getAttribute('aria-pressed')`) === 'true',
      'the toggle says which side you are on');
    const record = await evalJs(`document.getElementById('itemList').innerText`);
    check(/ticked it off/.test(record), `whoever does the thing gets to say so:\n${record}`);
    check(/Linnea/.test(record), 'and it is her name on it');
    check(await evalJs(`document.querySelectorAll('#itemList .month').length`) >= 1,
      'grouped under the month it happened in');
    // Nothing to add to a list of things already done.
    check(await evalJs(`document.querySelector('.composer').hidden`) === true,
      'the composer has no job in the record');

    await evalJs(`document.getElementById('tabDone').click()`);
    await sleep(400);
    check(await evalJs(`document.querySelector('.composer').hidden`) === false,
      'and comes back on the to-do side');
    // The visibility row is a question about the thing being written, so it is
    // not on screen until there is one.
    check(!(await visible('#visRow')), 'who it is for waits until you are writing');
    await evalJs(`(() => { const i = document.getElementById('newItem');
      i.value = 'x'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(150);
    check(await visible('#visRow'), 'and appears on the first keystroke');
    await evalJs(`(() => { const i = document.getElementById('newItem');
      i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(150);
    check(!(await visible('#visRow')), 'and goes again when the box is empty');

    // ...but she cannot rewrite his sentence.
    await evalJs(`document.querySelector('#itemList .it [data-open]').click()`);
    await sleep(500);
    check(await visible('#itemSheet .modal-in'), 'she can open it');
    check(await evalJs(`document.getElementById('isName').disabled`) === true,
      'somebody else’s wording is theirs');
    check(!(await visible('#isSave')), 'and there is nothing to save');
    await evalJs(`document.getElementById('isCancel').click()`);
    await sleep(300);
    check(!(await visible('#itemSheet .modal-in')), 'the sheet closes');
    check(await evalJs(`window.scrollY`) === 0, 'and the viewport goes back to the top');

    // ── groups ──────────────────────────────────────────────────────────
    // Tag two things and the to-do side becomes a set of groups you tap into.
    // A group is derived from the tags, so there is nothing to file into and
    // nothing that can outlive its members.
    await evalJs(`(() => { const b = document.getElementById('tabDone');
      if (b.getAttribute('aria-pressed') === 'true') b.click(); })()`);
    await sleep(300);
    check(!(await visible('#groupList')), 'no tags, no groups — the list is just a list');

    // A group is the set of items of one KIND, so classifying something is what
    // puts it in one — the tag field it replaced is gone.
    const classifyFirst = async (kind) => {
      await evalJs(`document.querySelector('#itemList .it [data-open]').click()`);
      await sleep(400);
      if (await evalJs(`document.getElementById('isName').disabled`)) {
        await evalJs(`document.getElementById('isCancel').click()`); await sleep(300); return false;
      }
      await evalJs(`document.querySelector('#isKind [data-k="${kind}"]').click()`);
      await evalJs(`document.getElementById('isSave').click()`);
      await sleep(1100);
      return true;
    };
    const tagged = await classifyFirst('movie');
    if (tagged) {
      check(await visible('#groupList'), 'one group and something outside it is worth showing');
      const gs = await evalJs(`document.getElementById('groupList').innerText`);
      check(/Films/.test(gs), `the group is named after the kind:\n${gs}`);
      check(!/Everything else/.test(gs), 'plain things are not a group');
      // They are listed right underneath instead — the ordinary case must not be
      // behind an extra tap.
      check(await visible('#itemList'), 'the loose items are on screen with the groups');
      check(await evalJs(`document.querySelectorAll('#itemList .it').length`) >= 1,
        'and there are some');

      // Tap into it.
      await evalJs(`document.querySelector('#groupList [data-g]').click()`);
      await sleep(400);
      check(!(await visible('#groupList')), 'tapping a group goes into it');
      check(await visible('#crumb'), 'with a way back');
      check(await evalJs(`document.querySelectorAll('#itemList .it').length`) === 1,
        'showing only what is in it');

      // Something written inside a group joins it — the same promise as before,
      // through the kind rather than through a tag.
      await evalJs(`(() => { const i = document.getElementById('newItem');
        i.value = 'Another film'; })()`);
      await evalJs(`document.getElementById('btnAdd').click()`);
      await sleep(1100);
      check(await evalJs(`document.querySelectorAll('#itemList .it').length`) === 2,
        'typing inside a group puts the thing in it');
      check(/FILM/i.test(await evalJs(`document.getElementById('itemList').innerText`)),
        'and it really is one, not merely filed as one');

      await evalJs(`document.getElementById('crumb').click()`);
      await sleep(400);
      check(await visible('#groupList'), 'and back out again');
    }

    // ── kinds ───────────────────────────────────────────────────────────
    // A film, a show, a place and a recipe are four different shapes of plan.
    // The kind lives where the free-text tag field used to be, and the group
    // rows it drives look exactly as they did.
    await evalJs(`(() => { const b = document.getElementById('tabDone');
      if (b.getAttribute('aria-pressed') === 'true') b.click(); })()`);
    await sleep(300);
    if (await visible('#crumb')) { await evalJs(`document.getElementById('crumb').click()`); await sleep(400); }

    // The UI stays as it was: no filter strip, no picker in the composer.
    check(await evalJs(`!document.getElementById('kindFilter')`),
      'the filter strip is gone');
    check(await evalJs(`!document.getElementById('kindRow')`),
      'and the composer is a box and a button, as it was');
    check(await evalJs(`!document.getElementById('isTags')`),
      'the free-text tag field is gone — the kind replaced it');

    // Classify something a recipe through the sheet, where the tags used to be.
    if (await visible('#groupList')) {
      await evalJs(`document.querySelector('#groupList [data-g]').click()`); await sleep(400);
      await evalJs(`document.getElementById('crumb').click()`); await sleep(400);
    }
    // Write one, outside any group, so it starts as a plain thing — and so it
    // belongs to this viewer, because somebody else's classification is theirs
    // and the picker is hidden on a read-only item.
    await evalJs(`document.getElementById('newItem').value = 'Make the ragu'`);
    await evalJs(`document.getElementById('btnAdd').click()`);
    await sleep(1200);
    const loose = await evalJs(`(() => {
      const r = [...document.querySelectorAll('#itemList .it')]
        .find(e => /Make the ragu/.test(e.innerText));
      if (!r) return false; r.querySelector('[data-open]').click(); return true; })()`);
    check(loose, 'the new thing should be on the list to classify');
    await sleep(500);
    check(!(await evalJs(`document.getElementById('isName').disabled`)),
      'and it is this viewer’s own to edit');
    check(await visible('#isKind'), 'the sheet offers the kind');
    check(await evalJs(`document.querySelectorAll('#isKind [data-k]').length`) === 5,
      'all five of them');
    check(await evalJs(`document.querySelector('#isKind [data-k="activity"]').classList.contains('on')`),
      'starting on a plain activity');

    await evalJs(`document.querySelector('#isKind [data-k="recipe"]').click()`);
    await sleep(200);
    // THE LINK IS THE POINT OF A RECIPE, so it leads and is named.
    check(await visible('#isLinkFld'), 'a recipe leads with its link');
    check(/recipe link/i.test(await evalJs(`document.getElementById('isLinkLabel').innerText`)),
      '"Recipe link" says what to paste; "Link" makes you guess');
    check(!(await visible('#isPlaceFld')), 'and does not ask where it is');
    await evalJs(`document.getElementById('isLink').value = 'https://cooking.nytimes.com/recipes/1018069'`);

    // A KIND SUGGESTS; IT NEVER CONFISCATES. A field holding something stays on
    // screen whatever the kind says — reclassifying must not hide, and then
    // silently drop on save, an address somebody typed.
    await evalJs(`document.getElementById('isPlace').value = 'Our kitchen'`);
    await evalJs(`document.querySelector('#isKind [data-k="movie"]').click()`);
    await sleep(200);
    check(await visible('#isPlaceFld'),
      'a field with something in it must not fold away under a kind change');
    await evalJs(`document.querySelector('#isKind [data-k="recipe"]').click()`);
    await sleep(150);
    await evalJs(`document.getElementById('isSave').click()`);
    await sleep(1200);

    // It is a recipe now, so it is in the Recipes group — the same rows as
    // before, named by the kind.
    const groupNames = await evalJs(`document.getElementById('groupList').innerText`);
    check(/Recipes/.test(groupNames), `classifying makes a group:\n${groupNames}`);
    await evalJs(`[...document.querySelectorAll('#groupList [data-g]')]
      .find(b => /Recipes/.test(b.innerText)).click()`);
    await sleep(500);
    check(/recipes/i.test(await evalJs(`document.getElementById('crumbName').innerText`)),
      'the crumb names it');

    const recipeLink = await evalJs(`(() => {
      const a = document.querySelector('#itemList .it a.go');
      return a ? { text: a.innerText.trim(), href: a.getAttribute('href'),
                   rel: a.getAttribute('rel') } : null; })()`);
    check(recipeLink, 'the recipe row carries its link as an action');
    // Named for what the link is FOR, and never the same word as the badge
    // beside it — a row that said "RECIPE" twice read as a bug.
    check(/cook/i.test(recipeLink.text), `named, not "link": ${recipeLink.text}`);
    check(recipeLink.href === 'https://cooking.nytimes.com/recipes/1018069', 'pointing at the recipe');
    check(recipeLink.rel === 'noopener noreferrer', 'and opened safely');
    // The place typed while it was briefly a film survived the save.
    check(/our kitchen/i.test(await evalJs(`document.getElementById('itemList').innerText`)),
      'and nothing typed was quietly discarded');

    await evalJs(`document.getElementById('crumb').click()`);
    await sleep(400);

    // ── the map ─────────────────────────────────────────────────────────
    // The tab appears only once something has a place, and a pin is drawn from
    // coordinates the server resolved — never guessed.
    await evalJs(`(() => { const b = document.getElementById('tabDone');
      if (b.getAttribute('aria-pressed') === 'true') b.click(); })()`);
    await sleep(300);
    // Groups may be on screen now; drill into one so there is an item to open.
    if (await visible('#groupList')) {
      await evalJs(`document.querySelector('#groupList [data-g]').click()`);
      await sleep(400);
    }
    await evalJs(`document.querySelector('#itemList .it [data-open]').click()`);
    await sleep(400);
    const editable = await evalJs(`!document.getElementById('isName').disabled`);
    if (editable) {
      await evalJs(`document.getElementById('isPlace').value = 'Adams Morgan, Washington DC'`);
      await evalJs(`document.getElementById('isSave').click()`);
      await sleep(1200);
    } else {
      await evalJs(`document.getElementById('isCancel').click()`);
      await sleep(300);
    }
    if (editable) {
      // Case-insensitive: the chip is `text-transform:uppercase` and innerText
      // reflects that, so a case-sensitive match here tests the stylesheet
      // rather than the data. This assertion had never actually run — the item
      // it opened used to be somebody else's, so `editable` was false and the
      // whole branch was skipped.
      check(/adams morgan/i.test(await evalJs(`document.getElementById('itemList').innerText`)),
        'and the place shows on the item');
    }

    // ── share in ────────────────────────────────────────────────────────
    // Arriving from a share sheet: the sheet opens pre-filled, you pick a list,
    // and it lands. One tap on the list, one on Add.
    await S('Page.navigate', {
      url: `${BASE}/share?title=${encodeURIComponent('Khruangbin at the Anthem')}&url=${encodeURIComponent('https://example.com/gig')}`,
    });
    await sleep(2400);
    check(await visible('#shareSheet .modal-in'), 'a share should open the add sheet');
    check(await evalJs(`document.getElementById('shTitle').value`) === 'Khruangbin at the Anthem',
      'pre-filled from the share');
    check(await evalJs(`document.querySelectorAll('#shWhere [data-w]').length`) >= 1,
      'and offers the lists to put it in');
    check(await evalJs(`!!document.querySelector('#shWhere [data-w].on')`),
      'with one already chosen, so Add is one tap away');
    await evalJs(`document.getElementById('shSave').click()`);
    await sleep(1200);
    check(!(await visible('#shareSheet .modal-in')), 'the sheet closes');
    // The share is taken out of the URL so a reload cannot add it twice.
    check(await evalJs(`location.search`) === '' && await evalJs(`location.pathname`) === '/',
      'and the URL is cleaned so a reload does not re-add it');
    const after = await evalJs(`document.getElementById('itemList').innerText`);
    check(/Khruangbin at the Anthem/.test(after), `the shared thing landed:\n${after}`);

    // ── [hidden] still means hidden, by LAYOUT ─────────────────────────
    // The map is parked, so its flow cannot be driven from the UI — but the
    // property that block existed to guard is not about the map. `.items{
    // display:flex}` beats the UA `[hidden]` rule, which is how the list once
    // stayed on screen above the map while every `.hidden` check said it was
    // gone. Same trap that hid nothing in the item sheet a day later. Assert it
    // where it lives, on the panes themselves, so it is still guarded when the
    // map comes back.
    for (const sel of ['#itemList', '#groupList', '#mapWrap', '#visRow']) {
      const got = await evalJs(`(() => {
        const e = document.querySelector('${sel}');
        if (!e) return 'missing';
        const was = e.hidden;
        e.hidden = true;
        const h = e.getBoundingClientRect().height + e.getClientRects().length;
        e.hidden = was;
        return h; })()`);
      check(got === 0, `${sel} ignores [hidden] — an author display rule is beating it (${got})`);
    }

    if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
    console.log('client-check: ok — gate, mirroring, share-in, the record, and a private thing staying private');
  } catch (e) {
    fail = e;
    console.error('client-check FAILED:', e.message);
    if (errors.length) console.error(errors.join('\n'));
    if (slog) console.error(`--- server log ---\n${slog.slice(-1200)}`);
  } finally {
    cleanup();
  }
  process.exit(fail ? 1 : 0);
})();
