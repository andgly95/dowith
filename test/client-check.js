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
    check(await visible('#scr-shelf'), 'and land on the shelf');
    check(/Linnea/.test(await evalJs(`document.getElementById('shelfList').innerText`)),
      'his one list is named after her');

    await evalJs(`document.querySelector('#shelfList [data-sp]').click()`);
    await sleep(1200);
    check(await visible('#scr-space'), 'tapping a list opens it');
    check(await evalJs(`document.getElementById('spaceTitle').innerText`) === 'Linnea',
      'and is titled from his side');

    // Write one of each visibility through the real composer.
    const write = async (title, vis) => {
      await evalJs(`document.querySelector('#visRow [data-v="${vis}"]').click()`);
      await sleep(150);
      await evalJs(`(() => { const i = document.getElementById('newItem');
        i.value = ${JSON.stringify(title)}; })()`);
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
    check(/Andrew/.test(await evalJs(`document.getElementById('shelfList').innerText`)),
      'the same list, mirrored to her side');
    await evalJs(`document.querySelector('#shelfList [data-sp]').click()`);
    await sleep(1200);
    check(await evalJs(`document.getElementById('spaceTitle').innerText`) === 'Andrew', 'titled Andrew');
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
    check(await evalJs(`document.querySelectorAll('#spaceTabs [data-tab]').length`) === 3,
      'the space has a to-do side, a record, and a map');
    check(await visible('#spaceTabs [data-tab="map"]'),
      'the map tab is always there — hiding it hid the feature from the person who had to find it');
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

    await evalJs(`document.querySelector('#spaceTabs [data-tab="done"]').click()`);
    await sleep(400);
    const record = await evalJs(`document.getElementById('itemList').innerText`);
    check(/ticked it off/.test(record), `whoever does the thing gets to say so:\n${record}`);
    check(/Linnea/.test(record), 'and it is her name on it');
    check(await evalJs(`document.querySelectorAll('#itemList .month').length`) >= 1,
      'grouped under the month it happened in');
    // Nothing to add to a list of things already done.
    check(await evalJs(`document.querySelector('.composer').hidden`) === true,
      'the composer has no job in the record');

    await evalJs(`document.querySelector('#spaceTabs [data-tab="open"]').click()`);
    await sleep(400);
    check(await evalJs(`document.querySelector('.composer').hidden`) === false,
      'and comes back on the to-do side');

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
    await evalJs(`document.querySelector('#spaceTabs [data-tab="open"]').click()`);
    await sleep(300);
    check(!(await visible('#groupList')), 'no tags, no groups — the list is just a list');

    const tagFirst = async (tags) => {
      await evalJs(`document.querySelector('#itemList .it [data-open]').click()`);
      await sleep(400);
      if (await evalJs(`document.getElementById('isName').disabled`)) {
        await evalJs(`document.getElementById('isCancel').click()`); await sleep(300); return false;
      }
      await evalJs(`document.getElementById('isTags').value = ${JSON.stringify(tags)}`);
      await evalJs(`document.getElementById('isSave').click()`);
      await sleep(1100);
      return true;
    };
    const tagged = await tagFirst('Films');
    if (tagged) {
      check(await visible('#groupList'), 'one group and something outside it is worth showing');
      const gs = await evalJs(`document.getElementById('groupList').innerText`);
      check(/Films/.test(gs), `the group is named after the tag:\n${gs}`);
      check(!/Everything else/.test(gs), 'untagged things are not a group');
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

      // Something written inside a group joins it.
      await evalJs(`(() => { const i = document.getElementById('newItem');
        i.value = 'Another film'; })()`);
      await evalJs(`document.getElementById('btnAdd').click()`);
      await sleep(1100);
      check(await evalJs(`document.querySelectorAll('#itemList .it').length`) === 2,
        'typing inside a group puts the thing in it');

      await evalJs(`document.getElementById('crumb').click()`);
      await sleep(400);
      check(await visible('#groupList'), 'and back out again');
    }

    // ── the map ─────────────────────────────────────────────────────────
    // The tab appears only once something has a place, and a pin is drawn from
    // coordinates the server resolved — never guessed.
    await evalJs(`document.querySelector('#spaceTabs [data-tab="open"]').click()`);
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
      check(/Adams Morgan/.test(await evalJs(`document.getElementById('itemList').innerText`)),
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

    // ── the map hides the list, by LAYOUT ───────────────────────────────
    // `.items{display:flex}` beats the UA [hidden] rule, so this regressed once
    // already and the property would have said it was fine.
    {
      await evalJs(`document.querySelector('#spaceTabs [data-tab="map"]').click()`);
      await sleep(1600);
      check(await visible('#mapCanvas'), 'the map should be on screen');
      check(!(await visible('#itemList')), 'and the list should not be above it');
      // Either pins, or a plain sentence saying why there aren't any. Not asserted
      // as "there is a pin", because that would make this test depend on
      // Nominatim being reachable, and a suite must not need the internet.
      const pins = await evalJs(`document.querySelectorAll('#mapCanvas .pin').length`);
      check(pins >= 1 || await visible('#mapCanvas .map-empty'),
        'the map shows pins, or says plainly why it cannot');
      check(await evalJs(`document.querySelector('.composer').hidden`) === true,
        'and nothing to type into');
      await evalJs(`document.querySelector('#spaceTabs [data-tab="open"]').click()`);
      await sleep(400);
      check(await visible('#itemList'), 'and the list comes back');
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
