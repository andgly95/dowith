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
    // Two since the calendar: views you switch INTO, never "To do" (the state
    // you are already in) and never the map.
    check(await evalJs(`[...document.querySelectorAll('#spaceTabs button')].map(b => b.dataset.tab).join()`)
      === 'cal,done', 'the toggles are Calendar and Done together, and nothing else');
    check(await visible('#tabDone'), 'and it is the record');
    // Small, and over on the right. It inherited the size and weight of the
    // three-up row it is no longer part of, which put a bold card-backed button
    // where the primary action goes — and it is not the primary action, the
    // list below it is.
    const seg = await evalJs(`(() => {
      const b = document.getElementById('tabDone');
      const row = document.getElementById('spaceTabs');
      const br = b.getBoundingClientRect(), rr = row.getBoundingClientRect();
      return { w: Math.round(br.width), rowW: Math.round(rr.width),
               rightGap: Math.round(rr.right - br.right),
               leftGap: Math.round(br.left - rr.left) }; })()`);
    check(seg.w < seg.rowW * 0.45, `the toggle is ${seg.w} of ${seg.rowW}px — too big`);
    check(seg.rightGap < seg.leftGap, 'and it should sit at the right-hand end');
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

    // ── the bottom nav ──────────────────────────────────────────────────
    // One tab per kind, and the tabs ARE the groups: the rows they replaced
    // were the same five sets, two taps and a breadcrumb away instead of one
    // tap and always in the same place.
    await evalJs(`(() => { const b = document.getElementById('tabDone');
      if (b.getAttribute('aria-pressed') === 'true') b.click(); })()`);
    await sleep(300);

    const nav = await evalJs(`[...document.querySelectorAll('#kindNav [data-kind]')]
      .map(b => b.dataset.kind)`);
    check(nav.length === 5, `one tab per kind, got ${nav.length}`);
    check(nav[0] === 'activity', 'the default kind leads');
    check(await visible('#kindNav'), 'and the bar is on screen');
    // EMPTY TABS STAY. Furniture has to be where you left it, and an empty tab
    // is how you make your first recipe.
    check(nav.includes('recipe') && nav.includes('place'),
      `kinds with nothing in them keep their tab: ${nav}`);
    check(await evalJs(`document.querySelector('#kindNav [data-kind="activity"]')
      .classList.contains('on')`), 'and you start on Activities');
    // Every tab carries an icon, from one set drawn to one spec. A kind added
    // without one falls back to a plain mark rather than to a hole.
    check(await evalJs(`[...document.querySelectorAll('#kindNav [data-kind]')]
      .every(b => b.querySelector('svg'))`), 'every tab has an icon');
    check(await evalJs(`[...document.querySelectorAll('#kindNav svg')]
      .every(s => s.getAttribute('stroke-width') === '1.6')`),
      'drawn to one spec — five icons from five conventions read as five mistakes');

    // THE APP IS EXACTLY AS TALL AS WHAT YOU CAN SEE.
    // `100dvh` is right everywhere worth measuring and comes up SHORT on iOS in
    // standalone — on a 956pt phone it was sixty-odd points short, which left
    // the bottom nav floating with a strip of dead page under it. Pin the
    // property rather than the symptom.
    const fit = await evalJs(`(() => {
      const app = document.getElementById('app');
      const nav = document.getElementById('kindNav');
      return {
        appH: Math.round(app.getBoundingClientRect().height),
        vh: Math.round((window.visualViewport && window.visualViewport.height) || window.innerHeight),
        under: nav ? Math.round(window.innerHeight - nav.getBoundingClientRect().bottom) : null,
      }; })()`);
    check(Math.abs(fit.appH - fit.vh) <= 2,
      `#app (${fit.appH}px) should be the visible height (${fit.vh}px)`);
    check(fit.under !== null && Math.abs(fit.under) <= 2,
      `the nav should sit flush at the bottom, found ${fit.under}px under it`);

    // THE ROOT IS NEVER TRANSPARENT, and nothing fixed near an edge carries a
    // colour for Safari to sample.
    //
    // Safari 26+ tints the status bar and the bottom chin by reading the page:
    // a transparent `html` makes it fall back to its own black, which showed as
    // a hundred points of dead space under the tab bar; a fixed element near
    // the top with a background becomes the tint, which blurred the masthead.
    // Both are checkable here even though the tinting itself is not.
    const edges = await evalJs(`(() => {
      const bg = (el) => getComputedStyle(el).backgroundColor;
      // No regex: a backslash inside the template literal that carries this to
      // the page is eaten before the page sees it, so the escaped parens of
      // /rgba\(0, 0, 0, 0\)/ become a capture group and match nothing.
      const clear = (c) => c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
      return {
        html: bg(document.documentElement),
        body: bg(document.body),
        screen: bg(document.getElementById('scr-space')),
        htmlClear: clear(bg(document.documentElement)),
        screenClear: clear(bg(document.getElementById('scr-space'))),
      }; })()`);
    check(!edges.htmlClear, `html must not be transparent, got ${edges.html}`);
    check(edges.html === edges.body, 'and must match the body, or a seam shows at the chin');
    check(edges.screenClear,
      `the fixed layer must carry no colour to sample, got ${edges.screen}`);

    // The count is part of the LABEL, not a thing floating beside the icon.
    // Unanchored it read as belonging to neither tab.
    check(await evalJs(`[...document.querySelectorAll('#kindNav .n')]
      .every(n => n.closest('b'))`),
      'the count sits on the label line, beside the word it counts');
    // And IN FRONT of it, so the eye reads "4 Films" rather than having to get
    // to the end of the word before the number means anything.
    check(await evalJs(`[...document.querySelectorAll('#kindNav button')]
      .filter(b => b.querySelector('.n'))
      .every(b => /^\\s*\\d/.test(b.querySelector('b').textContent))`),
      'the number leads the label');

    // THE DONE COUNT IS THE COUNT OF WHAT IT WOULD SHOW YOU. It was the whole
    // list's while the list underneath was one kind's, so "Done together 15" on
    // the Recipes tab produced two.
    const doneSays = async () => Number(
      (await evalJs(`(() => { const n = document.querySelector('#tabDone .n');
        return n ? n.innerText : '0'; })()`)) || 0);
    await evalJs(`document.getElementById('tabDone').click()`);
    await sleep(500);
    const shownDone = await evalJs(`document.querySelectorAll('#itemList .it').length`);
    check(await doneSays() === shownDone,
      `the toggle promised ${await doneSays()} and showed ${shownDone}`);
    await evalJs(`document.getElementById('tabDone').click()`);
    await sleep(400);

    // Classifying something moves it between tabs, which is the whole model.
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
    const before = await evalJs(`document.querySelectorAll('#itemList .it').length`);
    const moved = await classifyFirst('movie');
    if (moved) {
      check(await evalJs(`document.querySelectorAll('#itemList .it').length`) === before - 1,
        'it left Activities');
      const filmCount = await evalJs(`(() => {
        const b = document.querySelector('#kindNav [data-kind="movie"] i');
        return b ? Number(b.innerText) : 0; })()`);
      check(filmCount >= 1, 'and the Films tab counted it');

      await evalJs(`document.querySelector('#kindNav [data-kind="movie"]').click()`);
      await sleep(500);
      check(await evalJs(`document.querySelector('#kindNav [data-kind="movie"]')
        .classList.contains('on')`), 'tapping a tab selects it');
      check(await evalJs(`document.querySelectorAll('#itemList .it').length`) === 1,
        'and shows only that kind');
      // The composer asks for what you are looking at, and writes it.
      check(/film/i.test(await evalJs(`document.getElementById('newItem').placeholder`)),
        'the composer asks for a film');
      await evalJs(`(() => { const i = document.getElementById('newItem');
        i.value = 'Another film'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await evalJs(`document.getElementById('btnAdd').click()`);
      await sleep(1200);
      check(await evalJs(`document.querySelectorAll('#itemList .it').length`) === 2,
        'writing in a tab puts the thing in it');
      // Really that kind, not merely shown there — so it survives a reload.
      await S('Page.reload');
      await sleep(2400);
      await evalJs(`document.querySelector('#kindNav [data-kind="movie"]').click()`);
      await sleep(600);
      check(/Another film/.test(await evalJs(`document.getElementById('itemList').innerText`)),
        'and it is still there after a reload, so it really is a film');
      await evalJs(`document.querySelector('#kindNav [data-kind="activity"]').click()`);
      await sleep(400);
    }

    // ── kinds ───────────────────────────────────────────────────────────
    // A film, a show, a place and a recipe are four different shapes of plan.
    // The kind lives where the free-text tag field used to be, and the group
    // rows it drives look exactly as they did.
    await evalJs(`(() => { const b = document.getElementById('tabDone');
      if (b.getAttribute('aria-pressed') === 'true') b.click(); })()`);
    await sleep(300);
    await evalJs(`document.querySelector('#kindNav [data-kind="activity"]').click()`);
    await sleep(400);

    // The UI stays as it was: no filter strip, no picker in the composer.
    check(await evalJs(`!document.getElementById('kindFilter')`),
      'the filter strip is gone');
    check(await evalJs(`!document.getElementById('kindRow')`),
      'and the composer is a box and a button, as it was');
    check(await evalJs(`!document.getElementById('isTags')`),
      'the free-text tag field is gone — the kind replaced it');

    // Classify something a recipe through the sheet, where the tags used to be.
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
    // It is a recipe now, so it is under the Recipes tab.
    await evalJs(`document.querySelector('#kindNav [data-kind="recipe"]').click()`);
    await sleep(500);
    // The marker is one element that travels, so it has to END UP under the
    // icon it travelled to — measured by layout, after the motion settles.
    const pillOff = await evalJs(`(() => {
      const p = document.querySelector('#kindNav .pill').getBoundingClientRect();
      const i = document.querySelector('#kindNav button.on .ic').getBoundingClientRect();
      return Math.round(Math.abs(p.left - i.left) + Math.abs(p.width - i.width)); })()`);
    check(pillOff <= 2, `the marker settles under the chosen tab (off by ${pillOff}px)`);
    check(await evalJs(`getComputedStyle(document.getElementById('newItem'), '::placeholder').color`)
      !== await evalJs(`getComputedStyle(document.getElementById('newItem')).color`),
      'a placeholder is not drawn in the colour of typed text');
    // THEMES ARE TOKENS. Switching one must repaint what is actually drawn —
    // including the tints, which used to be copied rgba() values and would
    // have stayed coral under any theme.
    await evalJs(`document.documentElement.dataset.theme = 'olive'`);
    await sleep(600);
    const olive = await evalJs(`({
      bg: getComputedStyle(document.body).backgroundColor,
      pill: getComputedStyle(document.querySelector('#kindNav .pill')).backgroundColor,
    })`);
    check(olive.bg === 'rgb(31, 26, 18)', `olive paints the page: ${olive.bg}`);
    check(!/242, 132, 92/.test(olive.pill) && !/0\.949/.test(olive.pill),
      `and the tab marker is not left coral: ${olive.pill}`);
    if (process.env.SHOT) {
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT, Buffer.from(data, 'base64'));
    }
    await evalJs(`document.documentElement.dataset.theme = 'dusk'`);

    // ── the calendar ────────────────────────────────────────────────────
    // A view across every kind: the kind bar and the composer go (by LAYOUT —
    // the [hidden] trap has bitten this app three times), the month is six
    // rows whatever the month, and it opens on today.
    await evalJs(`document.getElementById('tabCal').click()`);
    await sleep(400);
    check(await evalJs(`document.querySelectorAll('.cal-grid .cd').length`) === 42, 'six rows of days, always');
    check(!(await visible('#kindNav')), 'the kind bar is gone while the calendar is open');
    check(!(await visible('#newItem')), 'and so is the composer');
    check(await evalJs(`(() => { const d = new Date(), p = n => String(n).padStart(2, '0');
      return document.querySelector('.cd.sel').dataset.day === d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })()`),
      'it opens on today');
    // Plan something for today through the sheet, as a person would.
    await evalJs(`document.querySelector('[data-cal="plan"]').click()`);
    await sleep(200);
    const planned = await evalJs(`(() => { const b = document.querySelector('#psList [data-plan]');
      const t = b && b.querySelector('b').textContent; document.getElementById('psTime').value = '19:30'; b && b.click(); return t; })()`);
    check(!!planned, 'the plan sheet offers things with no day yet');
    await sleep(900);
    check(await evalJs(`!!document.querySelector('.cd.sel b i.p')`), 'today gets a dot');
    check((await evalJs(`document.querySelector('.cal-day').innerText`)).includes(planned),
      `and the agenda lists what was planned (${planned})`);
    check(/7:30pm/.test(await evalJs(`document.querySelector('.cal-day').innerText`)), 'at the time chosen');
    if (process.env.SHOT_CAL) {
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_CAL, Buffer.from(data, 'base64'));
    }
    // Paging moves the month and keeps the grid whole.
    const m0 = await evalJs(`document.querySelector('.cal-hd b').textContent`);
    await evalJs(`document.querySelector('[data-cal="next"]').click()`);
    await sleep(200);
    check(await evalJs(`document.querySelector('.cal-hd b').textContent`) !== m0, 'next month pages');
    await evalJs(`document.getElementById('tabCal').click()`);
    await sleep(300);
    check(await visible('#kindNav'), 'and closing it brings the kind bar back');
    // The rose: in a pair list it sits in the corner, and the title opens settings.
    check(await visible('#spaceRose'), 'the rose is in the corner of a pair list');
    await evalJs(`document.getElementById('spaceRose').click()`);
    await sleep(500);
    check(await visible('#roseSheet'), 'and opens the inventory');
    await evalJs(`document.querySelector('#roseSheet [data-part="neck"]').click()`);
    await sleep(100);
    await evalJs(`document.querySelector('#roseSheet [data-act="kiss"][data-level="love"]').click()`);
    await sleep(500);
    check(await evalJs(`!!document.querySelector('#roseSheet [data-act="kiss"][data-level="love"].on')`),
      'an answer sticks after the round trip');
    if (process.env.SHOT_ROSE) {
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_ROSE, Buffer.from(data, 'base64'));
    }
    await evalJs(`document.querySelector('#roseSheet [data-rs="try"]').click()`);
    await sleep(100);
    await evalJs(`document.querySelector('#roseSheet [data-id="blindfold"][data-level="yes"]').click()`);
    await sleep(500);
    if (process.env.SHOT_ROSE2) {
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_ROSE2, Buffer.from(data, 'base64'));
    }
    await evalJs(`document.getElementById('rsClose').click()`);
    await evalJs(`document.getElementById('spaceSettings').click()`);
    await sleep(100);
    check(await visible('#spaceSheet'), 'tapping the title opens the list settings');
    await evalJs(`document.getElementById('ssCancel').click()`);

    check(await evalJs(`document.querySelectorAll('#itemList .it').length`) >= 1,
      'classifying moved it to the Recipes tab');

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

    await evalJs(`document.querySelector('#kindNav [data-kind="activity"]').click()`);
    await sleep(400);

    // ── the map ─────────────────────────────────────────────────────────
    // The tab appears only once something has a place, and a pin is drawn from
    // coordinates the server resolved — never guessed.
    await evalJs(`(() => { const b = document.getElementById('tabDone');
      if (b.getAttribute('aria-pressed') === 'true') b.click(); })()`);
    await sleep(300);
    // Groups may be on screen now; drill into one so there is an item to open.
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

    // ── the shelf ───────────────────────────────────────────────────────
    // Films and shows are a grid of posters, and a card without art is not a
    // hole where a poster should be — it is the title set in the display face.
    await evalJs(`document.querySelector('#kindNav [data-kind="movie"]').click()`);
    await sleep(600);
    check(await evalJs(`document.querySelector('#itemList').classList.contains('shelf')`),
      'films are a shelf, not a list');
    // Write one here rather than depending on what earlier sections left
    // behind — the composer makes the kind of the tab you are in.
    await evalJs(`(() => { const i = document.getElementById('newItem');
      i.value = 'Past Lives'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evalJs(`document.getElementById('btnAdd').click()`);
    await sleep(1300);
    const cards = await evalJs(`document.querySelectorAll('#itemList .card').length`);
    check(cards >= 1, 'with cards in it');
    // There is no TMDB key here and the suite must never need the internet, so
    // every card is the typographic kind — which is exactly the state that has
    // to look right, both before TMDB answers and forever without a key.
    check(await evalJs(`document.querySelectorAll('#itemList .card .noart').length`) === cards,
      'and with no key every one of them draws its title instead');
    check(await evalJs(`(() => {
      const a = document.querySelector('#itemList .card .art');
      const r = a.getBoundingClientRect();
      return Math.abs((r.height / r.width) - 1.5) < 0.08; })()`),
      'poster-shaped, 2:3');
    // ADDING A FILM ASKS WHICH ONE. Five things are called "Obsession" and the
    // one you mean is fourth, so the app asks rather than deciding. There is no
    // TMDB key here, so what has to be right is that it asks, says plainly that
    // it cannot search, and lets you walk away with the item still added.
    check(await visible('#pickSheet .modal-in'), 'adding a film asks which one');
    check(/which film/i.test(await evalJs(`document.getElementById('pkTitle').innerText`)),
      'and says what it is asking about');
    check(/no tmdb key/i.test(await evalJs(`document.getElementById('pkResults').innerText`)),
      'with no key it says so rather than spinning');
    await evalJs(`document.getElementById('pkCancel').click()`);
    await sleep(400);
    check(!(await visible('#pickSheet .modal-in')), 'and you can walk away');
    check(/Past Lives/.test(await evalJs(`document.getElementById('itemList').innerText`)),
      'with the film still added — the chooser is about art, not about the item');

    // The same chooser is how you CHANGE it later, from the item sheet.
    await evalJs(`[...document.querySelectorAll('#itemList .card')]
      .find(e => /Past Lives/.test(e.innerText)).querySelector('.cap').click()`);
    await sleep(500);
    check(await visible('#isWatchFld'), 'a film offers which one it is');
    check(/not matched/i.test(await evalJs(`document.getElementById('isWatch').innerText`)),
      'and says when it is not pinned to anything');
    await evalJs(`document.getElementById('isWatch').click()`);
    await sleep(500);
    check(await visible('#pickSheet .modal-in'), 'which opens the same chooser');
    check(/change which one/i.test(await evalJs(`document.getElementById('pkTitle').innerText`)),
      'framed as changing rather than choosing');
    await evalJs(`document.getElementById('pkCancel').click()`);
    await sleep(400);

    // The tick sits INSIDE the poster, which is also a way to open the item.
    // Without stopping the click there, marking something seen would open it.
    await evalJs(`document.querySelector('#itemList .card [data-tick]').click()`);
    await sleep(1400);
    check(!(await visible('#itemSheet .modal-in')),
      'ticking a card must not also open it');
    await evalJs(`document.querySelector('#kindNav [data-kind="activity"]').click()`);
    await sleep(400);

    // ── [hidden] still means hidden, by LAYOUT ─────────────────────────
    // The map is parked, so its flow cannot be driven from the UI — but the
    // property that block existed to guard is not about the map. `.items{
    // display:flex}` beats the UA `[hidden]` rule, which is how the list once
    // stayed on screen above the map while every `.hidden` check said it was
    // gone. Same trap that hid nothing in the item sheet a day later. Assert it
    // where it lives, on the panes themselves, so it is still guarded when the
    // map comes back.
    for (const sel of ['#itemList', '#mapWrap', '#visRow', '#kindNav']) {
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
