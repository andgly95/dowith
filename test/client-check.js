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
// A second pair, nothing to do with Andrew's, for a Spicy day: both chose only
// Spicy before any day was picked, so today's question is one.
const J = 'u-jo', K = 'u-kit';

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
    users: { [A]: person(A, 'Andrew'), [L]: person(L, 'Linnea'), [J]: person(J, 'Jo'), [K]: person(K, 'Kit') },
    spaces: [{ id: 'sp1', name: null, memberIds: [A, L], createdBy: A, createdAt: 1 },
      { id: 'sp9', name: null, memberIds: [J, K], createdBy: J, createdAt: 1 }],
    questions: { [[J, K].sort().join('|')]: { zone: 'Europe/London', decks: { [J]: ['spicy'], [K]: ['spicy'] }, remind: {}, paused: null,
      pauses: [], startedOn: '2026-01-01', days: {}, nudged: {} } },
    items: [], invites: [], seq: 100,
  }));
  // A stand-in for Photon (place suggestions) and Nominatim (the lookup the map
  // makes for names typed without a pick). The suite must never need the
  // internet, and the map is the one screen that would otherwise reach for it.
  const asked = [];
  const claudeAsked = [];
  const fake = require('http').createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    asked.push(new URL(req.url, 'http://x'));
    // A stand-in for Claude, for swap suggestions: the Messages API's shape,
    // and an answer that judges the alternatives it was given.
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const b = JSON.parse(raw);
        claudeAsked.push(b.messages[0].content);
        const fmt = JSON.stringify((b.output_config || {}).format || {});
        const reply = (says) => res.end(JSON.stringify({ id: 'msg_s', type: 'message', role: 'assistant', model: b.model, stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: JSON.stringify(says) }], usage: { input_tokens: 1, output_tokens: 1 } }));
        // What each thing asks of you, answered by number; and new ideas.
        if (fmt.includes('better_when_bad')) {
          return reply({ items: [...b.messages[0].content.matchAll(/^(\d+)\. \[([a-z]+)\]/gm)].map(([, n, kind]) => ({ n: Number(n),
            role: kind === 'film' || kind === 'show' ? 'watch' : kind === 'recipe' ? 'eat' : 'do', energy: kind === 'film' || kind === 'show' ? 1 : 3,
            minutes: 90, where: kind === 'place' ? 'out' : 'home', times: null, weather: 'any' })) });
        }
        if (fmt.includes('"ideas"')) {
          const eats = /They eat: /.test(b.messages[0].content);
          return reply({ ideas: [{ title: '🎬 The Apartment', kind: 'movie', role: 'watch', energy: 1, why: 'A warm one for a night in.', keeps: null },
            { title: '🍲 A big pot of chili', kind: 'recipe', role: 'eat', energy: 2, why: 'Easy, and it feeds tomorrow too.', keeps: eats ? 'naturally gluten-free' : null },
            { title: '🧩 A jigsaw and a record', kind: 'activity', role: 'do', energy: 1, why: 'Nothing to get up for.', keeps: null },
            ...(eats ? [{ title: '🍝 Fresh pasta night', kind: 'recipe', role: 'eat', energy: 3, why: 'Cosy.', keeps: null }] : [])] });
        }
        if (fmt.includes('weather_matters')) {
          const fit = { weather_matters: true, setting: 'outdoors', ideal_conditions: ['clear'], ideal_min_c: 15, ideal_max_c: 26,
            avoid_conditions: ['rain'], too_cold_below_c: 5, too_hot_above_c: null, best_time: null, best_seasons: null, why: 'Best on a dry day.' };
          return res.end(JSON.stringify({ id: 'msg_fit', type: 'message', role: 'assistant', model: b.model, stop_reason: 'end_turn', stop_sequence: null,
            content: [{ type: 'text', text: JSON.stringify(fit) }], usage: { input_tokens: 1, output_tokens: 1 } }));
        }
        const says = {
          verdict: /butter/i.test(JSON.stringify(b.messages)) ? 'Of the two, butter works best here.' : 'Butter would do it.',
          suggestions: [
            { name: 'Butter', amount: '2 tbsp butter', ratio: 1, uses: ['butter'], needs: ['butter'], why: 'Richer, and it browns the chicken well.', adjust: 'Keep the heat at medium so it does not burn.', fit: 'great' },
            { name: 'Bacon fat', amount: '2 tbsp bacon fat', ratio: 1, uses: [], needs: ['bacon fat'], why: 'Smoky.', adjust: '', fit: 'good' },
          ],
        };
        res.end(JSON.stringify({ id: 'msg_cc', type: 'message', role: 'assistant', model: b.model, stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: JSON.stringify(says) }], usage: { input_tokens: 1, output_tokens: 1 } }));
      });
      return;
    }
    if (req.url.startsWith('/search')) return res.end('[]');   // Nominatim: nowhere by that name
    // Transitous, for suggestions: a station search and an 18-minute ride.
    if (req.url.startsWith('/transit/api/v1/geocode')) {
      return res.end(JSON.stringify([{ type: 'STOP', name: 'Union Station', id: 'u', lat: 38.8977, lon: -77.0064, modes: ['SUBWAY'], areas: [{ name: 'DC', default: true }] }]));
    }
    if (req.url.startsWith('/transit/api/v5/plan')) {
      return res.end(JSON.stringify({ itineraries: [{ duration: 1080, legs: [{ mode: 'SUBWAY', routeShortName: 'R', routeColor: 'c80f2d' }] }] }));
    }
    // TMDB, for a show's seasons: one that has ended, three episodes and two.
    if (req.url.startsWith('/tmdb/tv/9001')) {
      const pth = new URL(req.url, 'http://x').pathname;
      if (pth.endsWith('/season/1') || pth.endsWith('/season/2')) {
        return res.end(JSON.stringify({ episodes: [1, 2, 3].map(e => ({ episode_number: e, name: `Chapter ${e}`, air_date: '2019-01-01' })) }));
      }
      return res.end(JSON.stringify({ id: 9001, name: 'The Long Goodbye', status: 'Ended',
        seasons: [{ season_number: 1, episode_count: 3 }, { season_number: 2, episode_count: 2 }],
        last_episode_to_air: { season_number: 2, episode_number: 2 }, next_episode_to_air: null }));
    }
    // Open-Meteo: a clear 20° afternoon, so the weather has something to show.
    if (req.url.startsWith('/v1/forecast')) {
      const day = new Date().toISOString().slice(0, 10);
      // Three days of it, so a plan that carries on into tomorrow has weather there too.
      const days = [0, 1, 2].map(n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10));
      const time = days.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
      return res.end(JSON.stringify({ timezone: 'UTC',
        current: { time: `${day}T12:00`, temperature_2m: 20, apparent_temperature: 20, weather_code: 0, is_day: 1, wind_speed_10m: 5 },
        hourly: { time, temperature_2m: time.map(() => 20), precipitation_probability: time.map(() => 0), weather_code: time.map(() => 0) },
        daily: { time: days, weather_code: days.map(() => 0), temperature_2m_max: days.map(() => 22), temperature_2m_min: days.map(() => 12),
          precipitation_probability_max: days.map(() => 0) } }));
    }
    // A recipe page, written for the suite, and its photo.
    if (req.url === '/r/recipe.html') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<html><head><meta property="og:site_name" content="Test Kitchen"><script type="application/ld+json">${JSON.stringify({
        '@type': 'Recipe', name: 'Lemon Chicken', recipeYield: '4 servings', prepTime: 'PT10M', cookTime: 'PT20M', image: '/r/photo.jpg',
        recipeIngredient: ['1 1/2 lb chicken thighs', '2 tbsp olive oil', '3 cloves garlic, minced', 'A handful of parsley'],
        recipeInstructions: ['Season the chicken thighs.', 'Sear the chicken in the olive oil for 1 minute.', 'Add the garlic, then the parsley, and serve.'],
      })}</script></head></html>`);
    }
    if (req.url === '/r/gravy.html') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<html><head><script type="application/ld+json">${JSON.stringify({
        '@type': 'Recipe', name: 'Gravy', recipeYield: '4 servings',
        recipeIngredient: ['2 cups stock', '2 tbsp gluten free all purpose flour or corn starch'],
        recipeInstructions: ['Whisk the thickener into cold stock, then simmer until thick.'],
      })}</script></head></html>`);
    }
    if (req.url === '/r/photo.jpg') {
      res.setHeader('content-type', 'image/jpeg');
      // A real (tiny) JPEG: the card falls back to its emoji when an image will
      // not decode, so a fake one would test the fallback, not the photo.
      return res.end(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCeiiivMPZP/9k=', 'base64'));
    }
    // Nominatim's lookup, for a place page's hours.
    if (req.url.startsWith('/lookup')) {
      return res.end(JSON.stringify([{ extratags: { opening_hours: 'Mo-Su 08:00-17:00', website: 'https://toki.example' },
        address: { house_number: '1234', road: 'H Street Northeast' } }]));
    }
    res.end(JSON.stringify({ type: 'FeatureCollection', features: [{
      type: 'Feature',
      properties: { osm_key: 'amenity', osm_value: 'restaurant', name: 'Toki Underground', osm_type: 'N', osm_id: 2193,
        housenumber: '1234', street: 'H Street Northeast', district: 'Atlas District', city: 'Washington', state: 'District of Columbia' },
      geometry: { type: 'Point', coordinates: [-76.9890327, 38.9004823] },
    }] }));
  }).listen(0, '127.0.0.1');
  await new Promise(r => fake.once('listening', r));
  const FAKE = `http://127.0.0.1:${fake.address().port}`;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    sessionSecret: SECRET, placesEndpoint: `${FAKE}/api/`, geoEndpoint: `${FAKE}/search`, geoLookupEndpoint: `${FAKE}/lookup`,
    // Andrew is an admin here, as he is on the real box: full edit on anything
    // he can see. Linnea is not, which is what the read-only checks rely on.
    admins: [A],
    anthropicKey: 'test-key', anthropicBaseUrl: FAKE,
    weatherEndpoint: `${FAKE}/v1/forecast`,
    transitEndpoint: `${FAKE}/transit`,
  }));

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // PREVIEW_ALLOW_PRIVATE: test-only, so the recipe reader may fetch the
    // stand-in page from localhost — the guard refuses it everywhere else.
    env: { ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, 'store.json'), CONFIG_FILE: path.join(dir, 'config.json'), PREVIEW_ALLOW_PRIVATE: '1' },
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
    fake.close();
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
        // Map tiles are blocked below (no internet in the suite), and a blocked
        // tile is the map's designed fallback — pins on a blank ground — not
        // a page error.
        const tile = /tile\.openstreetmap\.org/.test(msg.params.entry.url || '') || /ERR_BLOCKED_BY_CLIENT/.test(t);
        // A spent or unknown invite is a 404 by design, and the screen says so.
        const deadInvite = /\/api\/invite\/[^/]+$/.test(msg.params.entry.url || '') && /404/.test(t);
        if (!/service ?worker/i.test(t) && !tile && !deadInvite) errors.push(`CONSOLE: ${t}`);
      }
    });

    await S('Runtime.enable'); await S('Log.enable'); await S('Page.enable'); await S('Network.enable');
    await S('Network.setBlockedURLs', { urls: ['*tile.openstreetmap.org*'] });
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
    // On the way in, the list's shape rather than the word "Loading…".
    check(await evalJs(`(() => { document.querySelector('#shelfList [data-sp]').click();
      return !!document.querySelector('#itemList .skel .skel-row'); })()`), 'a list on its way in shows placeholder rows');
    // And the screen you left is drawn a moment longer, fading the way you came.
    check(await evalJs(`!!document.querySelector('#scr-shelf.leaving') && !!document.querySelector('#scr-space.active')`),
      'the switch is immediate, with the old screen leaving over it');
    await sleep(1000);
    check(await visible('#scr-space'), 'and tapping it goes back in');
    check(!(await evalJs(`document.querySelector('.screen.leaving')`)) && !(await visible('#scr-shelf')), 'and then it is gone');

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
    // Three since suggestions: views you switch INTO, never "To do" (the state
    // you are already in) and never the map. Asked by LAYOUT, like everything.
    check(await evalJs(`[...document.querySelectorAll('#spaceTabs button')]
      .filter(b => b.offsetWidth).map(b => b.dataset.tab).join()`)
      === 'sug,cal,done', 'the toggles are Suggestions, Calendar and Done together, and nothing else');
    check(await evalJs(`(() => { const c = document.querySelector('.ctl'); return c.scrollWidth <= c.clientWidth + 1; })()`),
      'and the three fit on the row');
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
    check(!(await evalJs(`!!document.querySelector('#spaceTabs [data-tab="map"]')`)),
      'no Map chip — the Places tab is the map');
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
    // And DRAWN. Elements in the DOM are not an animation: posters once got the
    // class and the sparks with no rule to draw them, and this check passed.
    check(await evalJs(`[...document.querySelectorAll('#itemList .it.celebrating .spark')].every(e => e.getAnimations().length)`),
      'and each spark actually animating');
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
    await sleep(400);
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
    const pill = await evalJs(`(() => {
      const p = document.querySelector('#kindNav .pill').getBoundingClientRect();
      const i = document.querySelector('#kindNav button.on .ic').getBoundingClientRect();
      return { off: Math.round(Math.abs(p.left - i.left) + Math.abs(p.width - i.width)),
        p: [Math.round(p.left), Math.round(p.width)], i: [Math.round(i.left), Math.round(i.width)],
        vw: innerWidth, sw: document.documentElement.scrollWidth }; })()`);
    check(pill.off <= 2, `the marker settles under the chosen tab: ${JSON.stringify(pill)}`);
    check(await evalJs(`getComputedStyle(document.getElementById('newItem'), '::placeholder').color`)
      !== await evalJs(`getComputedStyle(document.getElementById('newItem')).color`),
      'a placeholder is not drawn in the colour of typed text');
    // THEMES ARE TOKENS. Switching one must repaint what is actually drawn —
    // including the tints, which used to be copied rgba() values and would
    // have stayed coral under any theme.
    await evalJs(`document.documentElement.dataset.theme = 'forest'`);
    await sleep(600);
    const forest = await evalJs(`({
      bg: getComputedStyle(document.body).backgroundColor,
      pill: getComputedStyle(document.querySelector('#kindNav .pill')).backgroundColor,
    })`);
    check(forest.bg === 'rgb(17, 26, 21)', `forest paints the page: ${forest.bg}`);
    check(!/242, 132, 92/.test(forest.pill) && !/0\.949/.test(forest.pill),
      `and the tab marker is not left coral: ${forest.pill}`);
    // The DERIVED tokens (--sheet, --accent-tint…) are declared on [data-theme]
    // as well as :root, so a swatch carrying its own theme paints from its own
    // palette. Declared on :root alone, var(--bg) inside them resolves once, at
    // the root, and the swatch would wear the page's colours.
    const swatch = await evalJs(`(() => {
      const mk = (t) => { const d = document.createElement('div'); if (t) d.dataset.theme = t;
        d.style.background = 'var(--sheet)'; document.body.append(d);
        const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
      return { page: mk(null), dusk: mk('dusk'), forest: mk('forest') }; })()`);
    check(swatch.page === swatch.forest && swatch.dusk !== swatch.forest,
      `a derived token follows the theme it is declared under: ${JSON.stringify(swatch)}`);
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
    // A match before it opens, and one body answer of his alone — set up as
    // each of them, through the real route.
    const answerAs = (uid, body) => fetch(`${BASE}/api/space/sp1/pleasure`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${AUTH.COOKIE}=${encodeURIComponent(AUTH.sign(uid, SECRET))}` },
      body: JSON.stringify(body) });
    await answerAs(A, { kind: 'try', id: 'massage-oil', level: 'yes' });
    await answerAs(A, { kind: 'try', id: 'blindfold', level: 'love' });
    await answerAs(A, { kind: 'body', part: 'hips', act: 'kiss', level: 'yes' });
    await answerAs(L, { kind: 'try', id: 'massage-oil', level: 'love' });
    await evalJs(`document.getElementById('spaceRose').click()`);
    await sleep(600);
    check(await visible('#roseSheet'), 'and opens the inventory');
    // THE FRONT DOOR NAMES NOTHING: a phone gets glanced at, and this is what
    // is open when it does. With a match present, not one label of a thing to
    // try or a part of the body is on it.
    const named = await evalJs(`fetch('/api/space/sp1/pleasure').then(r => r.json()).then((d) => {
      const text = document.querySelector('#roseSheet .modal-in').textContent;
      const words = [...d.try, ...d.custom, ...d.parts].map(x => x.label);
      return { n: d.matches.length, hits: words.filter(w => new RegExp('\\\\b' + w.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + '\\\\b', 'i').test(text)) }; })`);
    check(named.n === 1 && named.hits.length === 0, `the front door names nothing: ${JSON.stringify(named)}`);
    check(/1 new/.test(await evalJs(`document.querySelector('#roseSheet .rs-matches').textContent`)), 'but says there is something new');
    // Body: the three views tell the truth about whose answer is whose.
    await evalJs(`document.querySelector('#roseSheet [data-rs="body"]').click()`);
    await sleep(300);
    const glows = async (v) => {
      await evalJs(`document.querySelector('#roseSheet [data-view="${v}"]').click()`);
      await sleep(150);
      return evalJs(`document.querySelector('#roseSheet .pt[data-part="hips"]').classList.contains('ans')`);
    };
    check(await glows('together') && !(await glows('mine')) && await glows('theirs'),
      'a part only he answered glows Together and in his view, and is hollow in Yours');
    await evalJs(`document.querySelector('#roseSheet [data-view="together"]').click()`);
    await sleep(150);
    await evalJs(`document.querySelector('#roseSheet [data-part="neck"]').click()`);
    await sleep(150);
    await evalJs(`document.querySelector('#roseSheet [data-act="kiss"][data-level="love"]').click()`);
    await sleep(500);
    check(await evalJs(`!!document.querySelector('#roseSheet [data-act="kiss"][data-level="love"].on')`),
      'an answer sticks after the round trip');
    check(await evalJs(`(() => { const r = document.querySelector('#roseSheet .pt[data-part="neck"]').getBoundingClientRect();
      return Math.min(r.width, r.height); })()`) >= 44, 'a point is a 44px target, not a 9px dot');
    if (process.env.SHOT_ROSE) {
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_ROSE, Buffer.from(data, 'base64'));
    }
    // Things to try: one card at a time, and Back brings the last one back.
    await evalJs(`document.querySelector('#roseSheet [data-rs="door"]').click()`);
    await sleep(150);
    await evalJs(`document.querySelector('#roseSheet [data-rs="try"]').click()`);
    await sleep(300);
    check(await visible('#rsCard'), 'things to try start one card at a time');
    const answeredBefore = Number((await evalJs(`document.querySelector('.rs-prog').textContent`)).match(/(\d+) of/)[1]);
    const firstCard = await evalJs(`document.getElementById('rsCard').dataset.id`);
    await evalJs(`document.querySelector('#roseSheet .rs-bubbles [data-level="love"]').click()`);
    await sleep(700);
    check(new RegExp(`${answeredBefore + 1} of`).test(await evalJs(`document.querySelector('.rs-prog').textContent`)), 'answering a card moves on');
    check(await evalJs(`document.getElementById('rsCard').dataset.id`) !== firstCard, 'to the next one');
    await evalJs(`document.querySelector('#roseSheet [data-back]').click()`);
    await sleep(300);
    check(await evalJs(`document.getElementById('rsCard').dataset.id`) === firstCard
      && await evalJs(`!!document.querySelector('#roseSheet .rs-bubbles [data-level="love"].on')`),
      'Back returns the last card, with its answer showing');
    await evalJs(`document.querySelector('#roseSheet .rs-bubbles [data-level="yes"]').click()`);
    await sleep(700);
    if (process.env.SHOT_ROSE3) {
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_ROSE3, Buffer.from(data, 'base64'));
    }
    await evalJs(`document.querySelector('#roseSheet [data-mode="list"]').click()`);
    await sleep(150);
    await evalJs(`document.querySelector('#roseSheet [data-id="blindfold"][data-level="yes"]').click()`);
    await sleep(600);
    check(await evalJs(`!!document.querySelector('#roseSheet [data-id="blindfold"][data-level="yes"].on')`), 'All answers changes an answer');
    if (process.env.SHOT_ROSE2) {
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_ROSE2, Buffer.from(data, 'base64'));
    }
    // You both want, grouped by how keen; a pick that is one of them.
    await evalJs(`document.querySelector('#roseSheet [data-rs="try"]').click()`);
    await sleep(150);
    await evalJs(`document.querySelector('#roseSheet [data-rs="door"]').click()`);
    await sleep(150);
    await evalJs(`document.querySelector('#roseSheet [data-go="both"]').click()`);
    await sleep(300);
    const both = await evalJs(`document.getElementById('rsBody').textContent`);
    check(/You both said yes · 2/.test(both), `both matches, grouped by how keen: ${both.slice(0, 160)}`);
    await evalJs(`document.querySelector('#roseSheet [data-pick]').click()`);
    await sleep(150);
    check(/A massage with oil|Blindfolds/i.test(await evalJs(`document.querySelector('#roseSheet .rs-pick b').textContent`)),
      'Pick one for us picks one of them');
    await evalJs(`document.getElementById('rsClose').click()`);
    await evalJs(`document.getElementById('spaceSettings').click()`);
    await sleep(100);
    check(await visible('#spaceSheet'), 'tapping the title opens the list settings');
    await evalJs(`document.getElementById('ssCancel').click()`);

    check(await evalJs(`document.querySelectorAll('#itemList .rcard').length`) >= 1,
      'classifying moved it to the Recipes tab, where recipes are cards');
    check(await visible('#itemList .ktiles'), 'under the Pantry and To buy tiles');
    // A recipe with a link and nothing read yet offers to read it — the link is
    // what the recipe comes from, not a bare "COOK ↗" any more.
    const offer = await evalJs(`(() => { const b = document.querySelector('#itemList .rcard [data-addrec]');
      return b ? { text: b.innerText.trim(), url: b.dataset.url } : null; })()`);
    check(offer && /read the recipe/i.test(offer.text), `the card offers to read it: ${JSON.stringify(offer)}`);
    check(offer.url === 'https://cooking.nytimes.com/recipes/1018069', 'from its own link');
    // Its page links back to the original, safely, and says it has no recipe yet.
    await evalJs(`document.querySelector('#itemList .rcard [data-open]').click()`);
    await sleep(500);
    check(await visible('#recipeSheet .modal-in') && !(await visible('#itemSheet .modal-in')),
      'a recipe opens its own page, not the generic form');
    const back = await evalJs(`(() => { const a = document.querySelector('#rpBody .site-chip');
      return a ? { href: a.getAttribute('href'), rel: a.getAttribute('rel') } : null; })()`);
    check(back && back.href === 'https://cooking.nytimes.com/recipes/1018069' && back.rel === 'noopener noreferrer',
      `the link back to the original is always on screen, opened safely: ${JSON.stringify(back)}`);
    check(await visible('#rpRead'), 'and there is a Read the recipe button where the ingredients will go');
    await evalJs(`document.getElementById('rpClose').click()`);
    await sleep(300);
    // The place typed while it was briefly a film survived the save — a card
    // does not show it, so ask the server.
    check(await evalJs(`fetch('/api/space/sp1/items').then(r => r.json()).then(b =>
      b.items.some(i => i.kind === 'recipe' && i.mod && i.mod.place && /our kitchen/i.test(i.mod.place.name)))`),
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

    // ── Places: a map with the list under it ────────────────────────────
    // The same items as every tab, drawn as places: their emojis are the pins,
    // To go / Been replaces Done together, and typing is also searching.
    const typeIn = (v) => evalJs(`(() => { const i = document.getElementById('newItem');
      i.value = ${JSON.stringify('')} + ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const rowOf = (re) => `[...document.querySelectorAll('#itemList .it')].find(r => ${re}.test(r.innerText))`;
    await evalJs(`document.querySelector('#kindNav [data-kind="place"]').click()`);
    await sleep(700);
    check(await visible('#placesTop') && await visible('#plCanvas'), 'the Places tab is a map');
    check(await visible('#plGo') && await visible('#plBeen'), 'with To go / Been over it');
    check(!(await visible('#tabDone')) && !(await visible('#spaceSettings')),
      'which replace the Done together chip and the big title on this tab');
    check(await visible('#itemList') && await visible('.composer') && await visible('#kindNav'),
      'and the list, the composer and the nav still under it');

    // Which one? After three characters, up to three real places, numbered,
    // the same numbers on the map. The emoji is not what gets searched for.
    await typeIn('🍜 Toki');
    await sleep(1000);
    const preds = await evalJs(`document.querySelectorAll('#itemList .pred').length`);
    check(preds >= 1 && preds <= 3, `typing a place offers up to three (${preds})`);
    check(await evalJs(`document.querySelectorAll('#plCanvas .npin').length`) === preds, 'with their numbers on the map');
    check(/restaurant/i.test(await evalJs(`document.querySelector('#itemList .pred').innerText`)), 'each saying what it is');
    const q = asked.filter(u => u.pathname === '/api/').pop();
    check(q && q.searchParams.get('q') === 'Toki', `and the search is the words, not the emoji: ${q && q.searchParams.get('q')}`);
    if (process.env.SHOT_PLACES) {
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_PLACES, Buffer.from(data, 'base64'));
    }
    await evalJs(`document.querySelector('#itemList .pred').click()`);
    // A new pin falls into place, once — caught as soon as it is drawn.
    let fell = null;
    for (let i = 0; i < 30 && fell === null; i++) {
      await sleep(50);
      fell = await evalJs(`(() => { const p = [...document.querySelectorAll('#plCanvas .epin')].find(e => e.innerText.includes('🍜'));
        return p ? p.classList.contains('drop') : null; })()`);
    }
    check(fell === true, `a new pin drops into place (${fell})`);
    await sleep(1300);
    check(/pinned to the map/i.test(await evalJs(`document.getElementById('itemList').innerText`)), 'one tap pins it, and says so');
    check(await evalJs(`!!${rowOf('/Toki Underground/')}`), 'the row says which place it is');
    check(await evalJs(`(${rowOf('/Toki/')}).querySelector('b').innerText`) === 'Toki', 'and the title is what was typed');
    check(await evalJs(`[...document.querySelectorAll('#plCanvas .epin')].some(p => p.innerText.includes('🍜'))`),
      'and its emoji is the pin');
    // Undo takes it back off and gives you your words back.
    await evalJs(`document.querySelector('#itemList [data-undo]').click()`);
    await sleep(1100);
    check(!(await evalJs(`!!${rowOf('/Toki/')}`)), 'Undo takes it back off the list');
    check(await evalJs(`document.getElementById('newItem').value`) === '🍜 Toki', 'and puts the words back in the box');
    await typeIn('🍜 Toki');
    await sleep(1000);
    await evalJs(`document.querySelector('#itemList .pred').click()`);
    await sleep(1300);
    // The + still adds it as words, with no pin: nothing is pinned unless
    // somebody chose the place.
    await typeIn('🌳 Botanic garden');
    await sleep(200);
    await evalJs(`document.getElementById('btnAdd').click()`);
    await sleep(1300);
    check(/not on the map yet/i.test(await evalJs(`(${rowOf('/Botanic garden/')}).innerText`)), 'the + adds it as words, unpinned');

    // ── one place, opened ───────────────────────────────────────────────
    await evalJs(`(${rowOf('/Toki/')}).querySelector('[data-open]').click()`);
    await sleep(1100);
    check(await visible('#placeSheet .modal-in') && !(await visible('#itemSheet .modal-in')),
      'a place opens its own page, not the generic form');
    check(/Toki Underground/.test(await evalJs(`document.getElementById('plWhere').innerText`)), 'saying which place it is');
    check(/destination=38\.9/.test(await evalJs(`document.getElementById('plDir').getAttribute('href')`)),
      'Directions go to the pin');
    check(await visible('#plInfo') && /today 8 AM–5 PM/i.test(await evalJs(`document.getElementById('plInfo').innerText`))
      && /(Open now · until 5 PM|Closed now · opens)/.test(await evalJs(`document.getElementById('plInfo').innerText`)),
      `its hours, read for today: ${await evalJs(`document.getElementById('plInfo').innerText`)}`);
    check(await evalJs(`document.getElementById('plWeb').getAttribute('href')`) === 'https://toki.example', 'and its website');
    const wx = await evalJs(`document.getElementById('plWx').innerText`);
    check(await visible('#plWx') && /68°|20°/.test(wx) && /Clear/.test(wx), `the weather there, now: ${wx}`);
    check(/Good weather for it right now/.test(wx) && /Best with clear skies/.test(wx), 'and whether it suits the place, by its profile');
    check(await visible('#plWxPill') && /°/.test(await evalJs(`document.getElementById('plWxPill').innerText`)), 'and over the Places map');
    await evalJs(`document.getElementById('plBook').click()`);
    await sleep(800);
    const visitOf = async (re) => evalJs(`fetch('/api/space/sp1/items').then(r => r.json())
      .then(b => (b.items.find(i => ${re}.test(i.title)) || {}).visit)`);
    check(((await visitOf('/Toki/')) || {}).book === true, 'Book ahead saves as you flip it');
    await evalJs(`document.getElementById('plWent').click()`);
    await sleep(120);
    check(await evalJs(`document.getElementById('plWent').classList.contains('going')
      && document.querySelectorAll('#plWent .fx-spark').length === 6`), 'We went here fills where you tapped and throws its sparks');
    await sleep(1200);
    check(await visible('#plBeenBox') && !(await visible('#plPlanBox')), 'We went here turns the plan into the record');
    // Its label is found by class: the burst drops a <span> of its own into the
    // button, and a bare querySelector('span') once wrote the label into that.
    check(await evalJs(`document.getElementById('plWent').innerText.trim()`) === 'Not been after all',
      `and the button offers the way back: ${await evalJs(`document.getElementById('plWent').innerText.trim()`)}`);
    await evalJs(`document.querySelector('#plAgain [data-again="soon"]').click()`);
    await sleep(900);
    check(((await visitOf('/Toki/')) || {}).again === 'soon', 'and "would you go back" is kept');
    await evalJs(`document.getElementById('plClose').click()`);
    await sleep(400);
    check(await evalJs(`document.querySelector('#plBeen .n').innerText`) === '1', 'Been counts it');
    await evalJs(`document.getElementById('plBeen').click()`);
    await sleep(500);
    check(/can’t wait to go back/i.test(await evalJs(`document.getElementById('itemList').innerText`)),
      'and the Been list says so');
    await evalJs(`document.getElementById('plGo').click()`);
    await sleep(500);

    // A place with no pin offers to find it — choosing, never matching in bulk.
    await evalJs(`(${rowOf('/Botanic garden/')}).querySelector('[data-open]').click()`);
    await sleep(700);
    check(await visible('#plFind'), 'a place with no pin offers to find it on the map');
    await evalJs(`document.getElementById('plFind').click()`);
    await sleep(1000);
    check(await evalJs(`document.querySelectorAll('#wsResults .pred').length`) >= 1, 'which searches for it');
    await evalJs(`document.querySelector('#wsResults .pred').click()`);
    await sleep(1300);
    check(!(await visible('#whereSheet .modal-in')) && !(await visible('#plFind')), 'and one tap pins it');
    await evalJs(`document.getElementById('plClose').click()`);
    await sleep(400);

    // ── one finger pans, two zoom ───────────────────────────────────────
    // Real touches through the protocol, which the browser turns into pointer
    // events exactly as a phone would. The first engine tracked one pointer: a
    // second finger restarted the drag from where it landed, so a pinch jerked
    // the map sideways and never zoomed. Measured on the pin, by where it is drawn.
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const pinAt = () => evalJs(`(() => { const p = [...document.querySelectorAll('#plCanvas .epin')]
      .find(p => /Botanic garden/.test(p.getAttribute('aria-label')));
      return { x: parseFloat(p.style.left), y: parseFloat(p.style.top) }; })()`);
    const box = await evalJs(`(() => { const r = document.getElementById('plCanvas').getBoundingClientRect();
      return { x: r.left, y: r.top }; })()`);
    const touch = (type, pts) => S('Input.dispatchTouchEvent', {
      type, touchPoints: pts.map((p, i) => ({ x: box.x + p.x, y: box.y + p.y, id: i })) });
    const p0 = await pinAt();
    const f0 = { x: p0.x - 50, y: p0.y + 40 };
    await touch('touchStart', [f0]);
    for (let k = 1; k <= 5; k++) await touch('touchMove', [{ x: f0.x + 6 * k, y: f0.y + 4 * k }]);
    await touch('touchEnd', []);
    await sleep(300);
    const p1 = await pinAt();
    check(Math.abs(p1.x - p0.x - 30) < 1.5 && Math.abs(p1.y - p0.y - 20) < 1.5,
      `one finger pans the map with it: ${JSON.stringify([p0, p1])}`);
    // Fingers 40px apart, spread to 64: ×1.6, around the point between them.
    const P = { x: p1.x - 60, y: p1.y + 50 };
    await touch('touchStart', [{ x: P.x - 20, y: P.y }, { x: P.x + 20, y: P.y }]);
    for (let k = 1; k <= 6; k++) {
      const spread = 20 + 2 * k;
      await touch('touchMove', [{ x: P.x - spread, y: P.y }, { x: P.x + spread, y: P.y }]);
    }
    await touch('touchEnd', []);
    await sleep(300);
    const p2 = await pinAt();
    const want = { x: P.x + 1.6 * (p1.x - P.x), y: P.y + 1.6 * (p1.y - P.y) };
    check(Math.hypot(p2.x - want.x, p2.y - want.y) < 2,
      `two fingers zoom in, around the point between them, and stay where they let go: ${JSON.stringify({ p1, p2, want })}`);
    // Taps, as real touches. The place just pinned is the one picked out; a tap
    // on the map itself puts it down, a tap on its pin picks it up again, and
    // none of that throws away the zoom you just made — the Places map used to
    // re-fit itself on every redraw.
    const tap = async (p) => { await touch('touchStart', [p]); await touch('touchEnd', []); await sleep(450); };
    const selRow = () => evalJs(`(() => { const r = document.querySelector('#itemList .it.sel'); return r ? r.innerText : ''; })()`);
    check(/Botanic garden/.test(await selRow()), 'the place just pinned is the one picked out');
    await tap(P);
    check(!(await selRow()), 'a tap on the map itself puts it down');
    const p3 = await pinAt();
    check(Math.hypot(p3.x - p2.x, p3.y - p2.y) < 1.5, `and keeps the zoom you made: ${JSON.stringify({ p2, p3 })}`);
    await tap({ x: p3.x, y: p3.y - 24 });                  // the bubble sits above its point
    check(/Botanic garden/.test(await selRow()), 'a tap on a pin picks out its row');
    const p4 = await pinAt();
    check(Math.hypot(p4.x - p2.x, p4.y - p2.y) < 1.5, `still without moving the map: ${JSON.stringify({ p2, p4 })}`);
    await tap({ x: p4.x, y: p4.y - 24 });
    check(await visible('#placeSheet .modal-in'), 'and a second tap opens its page');
    check(await evalJs(`document.querySelectorAll('#plCanvas .epin.drop').length`) === 0,
      'pins fall once, not on every redraw of a map that redraws on every pan');

    // ── pulling a sheet down ────────────────────────────────────────────
    // Every sheet has a grabber, and a grabber is a promise. Pulled a little it
    // springs back; pulled past a third of the way it closes, through its own X.
    // Real touches again, at a finger's pace.
    const at = (type, pts) => S('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
    const pull = async (from, dy, { steps = 8, gap = 30, end = true } = {}) => {
      await at('touchStart', [from]);
      for (let k = 1; k <= steps; k++) { await at('touchMove', [{ x: from.x, y: from.y + (dy * k) / steps }]); await sleep(gap); }
      if (end) await at('touchEnd', []);
    };
    const grip = await evalJs(`(() => { const r = document.getElementById('plTitle').getBoundingClientRect();
      return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }; })()`);
    await pull(grip, 70, { end: false });
    const mid = await evalJs(`document.querySelector('#placeSheet .modal-in').style.transform`);
    check(/translateY\((6\d|7\d)(\.\d+)?px\)/.test(mid), `the sheet follows the finger: ${mid}`);
    await at('touchEnd', []);
    await sleep(450);
    check(await visible('#placeSheet .modal-in') && !(await evalJs(`document.querySelector('#placeSheet .modal-in').style.transform`)),
      'a short pull springs back');
    const tall = await evalJs(`document.querySelector('#placeSheet .modal-in').offsetHeight`);
    await pull(grip, Math.round(tall * 0.45), { steps: 10, gap: 20 });
    check(await evalJs(`document.getElementById('placeSheet').hidden`), 'past a third of the way, it closes');
    await sleep(400);
    check(!(await visible('#placeSheet .modal-in')), 'and is gone once it has fallen');

    // ── the list over the map is a sheet too ────────────────────────────
    // Three heights: mostly map, half (where it opens), mostly list. Drag the
    // heading; let go and it settles on the nearest. The grabber is also a
    // button that steps between them, for anyone not dragging.
    await evalJs(`window.__buzz = []; navigator.vibrate = (p) => { window.__buzz.push(p); return true; }`);
    const topH = () => evalJs(`document.getElementById('placesTop').offsetHeight`);
    const halfH = await topH();
    const hd = await evalJs(`(() => { const r = document.querySelector('#itemList .pl-hd b').getBoundingClientRect();
      return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()`);
    await pull(hd, -320, { steps: 10, gap: 25 });
    await sleep(500);
    const listH = await topH();
    check(listH < 140, `dragged up, the list takes the screen and the map is a strip (${halfH} → ${listH})`);
    check((await evalJs(`window.__buzz`)).length >= 1, 'and it clicks under the thumb as it settles');
    check(await evalJs(`document.querySelector('#itemList [data-grab]').getAttribute('aria-label')`) === 'Show more of the map',
      'the grabber says what a tap on it does');
    await evalJs(`document.querySelector('#itemList [data-grab]').click()`);
    await sleep(500);
    check(Math.abs((await topH()) - halfH) <= 2, `a tap on the grabber steps back to half (${await topH()} vs ${halfH})`);
    const body = await evalJs(`(() => { const r = document.querySelector('#itemList .group').getBoundingClientRect();
      return { x: Math.round(r.left + 60), y: Math.round(r.top + 20) }; })()`);
    await pull(body, 260, { steps: 10, gap: 25 });
    await sleep(500);
    const mapH = await topH();
    check(mapH > halfH + 100, `pulled down from the top of the list, the map takes the screen (${halfH} → ${mapH})`);
    await evalJs(`document.querySelector('#itemList [data-grab]').click()`);
    await sleep(500);
    check(Math.abs((await topH()) - halfH) <= 2, 'and back to half');
    await S('Emulation.setTouchEmulationEnabled', { enabled: false });
    await sleep(100);



    // ── where is it, on anything else ───────────────────────────────────
    // Every other kind keeps the Where field in the ordinary sheet.
    await evalJs(`document.querySelector('#kindNav [data-kind="activity"]').click()`);
    await sleep(500);
    await typeIn('Ramen night');
    await evalJs(`document.getElementById('btnAdd').click()`);
    await sleep(1200);
    await evalJs(`(${rowOf('/Ramen night/')}).querySelector('[data-open]').click()`);
    await sleep(500);
    check(await visible('#itemSheet .modal-in'), 'anything else opens the ordinary sheet');
    await evalJs(`(() => { const i = document.getElementById('isPlace');
      i.value = 'toki u'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check(/pick a suggestion/i.test(await evalJs(`document.getElementById('isPlaceAt').innerText`)),
      'a typed name says it is just words until one is picked');
    await sleep(900);
    check(await evalJs(`document.querySelectorAll('#isPlaceSug .sug').length`) >= 1, 'typing offers places');
    if (process.env.SHOT_WHERE) {
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_WHERE, Buffer.from(data, 'base64'));
    }
    await evalJs(`document.querySelector('#isPlaceSug .sug').click()`);
    await sleep(150);
    check(await evalJs(`document.getElementById('isPlace').value`) === 'Toki Underground', 'tapping one fills the field');
    check(!(await visible('#isPlaceSug')), 'and puts the list away');
    check(/H Street/i.test(await evalJs(`document.getElementById('isPlaceAt').innerText`)), 'and says where it is pinned');
    await evalJs(`document.getElementById('isSave').click()`);
    await sleep(1200);

    // Not left lying around: the whose-idea checks below count this list's rows.
    await evalJs(`fetch('/api/space/sp1/items').then(r => r.json()).then(b => Promise.all(b.items
      .filter(i => /Ramen night/.test(i.title)).map(i => fetch('/api/item/' + i.id, { method: 'DELETE' }))))`);

    // ── a renamed theme ─────────────────────────────────────────────────
    // Olive became Forest. A phone that saved "olive" must come back in Forest
    // and remember it under the new name — not silently drop to Dusk, which is
    // what an unknown theme does. The share-in below reloads anyway, so this
    // reload costs nothing that follows it.
    await evalJs(`localStorage.setItem('dw-theme', 'olive')`);
    await S('Page.navigate', { url: `${BASE}/` });
    await sleep(2200);
    const renamed = await evalJs(`({ t: document.documentElement.dataset.theme,
      saved: localStorage.getItem('dw-theme'), bg: getComputedStyle(document.body).backgroundColor })`);
    check(renamed.t === 'forest' && renamed.saved === 'forest' && renamed.bg === 'rgb(17, 26, 21)',
      `a phone that saved Olive opens in Forest: ${JSON.stringify(renamed)}`);
    await evalJs(`localStorage.setItem('dw-theme', 'dusk'); document.documentElement.dataset.theme = 'dusk'`);

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
    // Split by whose idea it was: a heading per person, each over its own grid,
    // so the posters stay a grid rather than becoming a list with labels.
    check(await evalJs(`[...document.querySelectorAll('#itemList > .whose')]
      .every(h => h.nextElementSibling && h.nextElementSibling.classList.contains('grid'))`)
      && await evalJs(`document.querySelectorAll('#itemList > .whose').length`) >= 1,
      'the shelf says whose idea each film was, a heading over each grid');
    check(await evalJs(`document.querySelectorAll('#itemList > .grid > .card').length`) === cards,
      'and every card sits in a grid');
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
    // And a poster finishes the way a row does — measured as drawn: the ring
    // sage, the mark drawing on, the sparks moving, the art stepping back.
    const sageIs = await evalJs(`(() => { const p = document.createElement('i'); p.style.color = 'var(--accent2)';
      document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`);
    await evalJs(`document.querySelector('#itemList .card [data-tick]').click()`);
    await sleep(200);
    const poster = await evalJs(`(() => { const c = document.querySelector('#itemList .card.celebrating');
      if (!c) return null;
      const t = c.querySelector('.tick');
      const art = c.querySelector('.art img, .noart');
      return { ring: getComputedStyle(t).backgroundColor, ringMoves: t.getAnimations().length,
        mark: t.querySelector('path').getAnimations().length,
        sparks: [...c.querySelectorAll('.spark')].filter(e => e.getAnimations().length).length,
        art: getComputedStyle(art).filter }; })()`);
    check(poster && poster.ring === sageIs && poster.ringMoves && poster.mark && poster.sparks === 6 && /grayscale/.test(poster.art),
      `ticking off a film is a moment too, actually drawn: ${JSON.stringify(poster)} (sage ${sageIs})`);
    await sleep(500);
    check(await evalJs(`!!document.querySelector('#itemList .card.leaving')`), 'and the poster shrinks away');
    await sleep(900);
    // Done, its mark is shown: the shared rule hid it until drawn on, and only
    // rows ever put it back, so a seen film was a sage disc with nothing in it.
    await evalJs(`document.getElementById('tabDone').click()`);
    await sleep(400);
    check(await evalJs(`getComputedStyle(document.querySelector('#itemList .card.done .tick path')).strokeDashoffset`) === '0px',
      'a seen film shows its mark');
    await evalJs(`document.getElementById('tabDone').click()`);
    await sleep(400);
    check(!(await visible('#itemSheet .modal-in')),
      'ticking a card must not also open it');
    await evalJs(`document.querySelector('#kindNav [data-kind="activity"]').click()`);
    await sleep(400);

    // ── whose idea ──────────────────────────────────────────────────────
    // Each tab says whose idea each thing was — theirs first, yours last — and
    // whoever typed something can hand the credit to the person it came from.
    // Activities has one of each by now: his record shopping, her share.
    const sections = () => evalJs(`[...document.querySelectorAll('#itemList > .whose b')]
      .map(b => b.textContent)`);
    // Which heading each row sits under, by DOM order: a row belongs to the
    // nearest heading above it.
    // A section's rows sit in one card after its heading, so look inside it.
    const under = (title) => evalJs(`(() => {
      let h = null;
      for (const el of document.getElementById('itemList').children) {
        if (el.classList.contains('whose')) h = el.querySelector('b').textContent;
        else if ([el, ...el.querySelectorAll('.it')].some(r => r.matches('.it')
          && r.innerText.includes(${JSON.stringify(title)}))) return h;
      }
      return 'missing'; })()`);
    const heads = await sections();
    check(heads.join() === "Andrew's ideas,Your ideas", `his first, hers last — got ${heads}`);
    check(await under('Go record shopping') === "Andrew's ideas", 'his is under his name');
    check(await under('Khruangbin at the Anthem') === 'Your ideas', 'and her share under hers');
    // Sentence case, with the person's initial — the redesign dropped the
    // shouted uppercase labels everywhere.
    check(await evalJs(`getComputedStyle(document.querySelector('#itemList .whose')).textTransform`) === 'none'
      && await visible('#itemList .whose .av'), 'drawn as a heading with their initial, in sentence case');
    check(await evalJs(`document.querySelector('#itemList .whose .av').innerText`) === 'A', "his section carries his initial");

    // Not on his: the credit is the author's to give, and she did not write it.
    await evalJs(`[...document.querySelectorAll('#itemList .it')]
      .find(e => /Go record shopping/.test(e.innerText)).querySelector('[data-open]').click()`);
    await sleep(500);
    check(!(await visible('#isIdeaFld')), 'whose idea is not hers to change on his');
    await evalJs(`document.getElementById('isCancel').click()`);
    await sleep(300);

    // On her own: hers by default, and his for the asking.
    await evalJs(`[...document.querySelectorAll('#itemList .it')]
      .find(e => /Khruangbin at the Anthem/.test(e.innerText)).querySelector('[data-open]').click()`);
    await sleep(500);
    check(await visible('#isIdeaFld'), 'whose idea is offered on her own');
    check(await evalJs(`[...document.querySelectorAll('#isIdea button')].map(b => b.textContent).join()`)
      === "Mine,Andrew's", 'as herself first, then the person she keeps the list with');
    check(await evalJs(`document.querySelector('#isIdea button.on').textContent`) === 'Mine',
      'starting from hers');
    await evalJs(`[...document.querySelectorAll('#isIdea button')].find(b => /Andrew/.test(b.textContent)).click()`);
    await sleep(100);
    check(await evalJs(`document.querySelector('#isIdea button.on').textContent`) === "Andrew's",
      'the choice shows before it is saved');
    await evalJs(`document.getElementById('isSave').click()`);
    await sleep(1100);
    check(await under('Khruangbin at the Anthem') === "Andrew's ideas", 'saved, it moves under his name');
    check((await sections()).join() === "Andrew's ideas", `and a heading with nothing under it goes — got ${await sections()}`);
    await evalJs(`[...document.querySelectorAll('#itemList .it')]
      .find(e => /Khruangbin at the Anthem/.test(e.innerText)).querySelector('[data-open]').click()`);
    await sleep(500);
    const meta = await evalJs(`document.getElementById('isMeta').textContent`);
    check(/added by you/.test(meta) && /Andrew's idea/.test(meta), `the sheet says both halves: ${meta}`);
    await evalJs(`document.getElementById('isCancel').click()`);
    await sleep(300);

    // From his side it is his idea, and the row owns up to who typed it.
    await asUser(A);
    await evalJs(`document.querySelector('#kindNav [data-kind="activity"]').click()`);
    await sleep(500);
    check(await under('Khruangbin at the Anthem') === 'Your ideas', 'on his side it is under his ideas');
    check(await evalJs(`[...document.querySelectorAll('#itemList .it')]
      .find(e => /Khruangbin at the Anthem/.test(e.innerText)).querySelector('.who').textContent`) === 'via Linnea',
      'and says she was the one who wrote it down');

    // As an admin he has full edit on hers: the words, who it is for, and whose
    // idea it was — the last two were once the author's alone.
    await evalJs(`[...document.querySelectorAll('#itemList .it')]
      .find(e => /Khruangbin at the Anthem/.test(e.innerText)).querySelector('[data-open]').click()`);
    await sleep(500);
    check(await evalJs(`document.getElementById('isName').disabled`) === false, 'he can fix her wording');
    check(await visible('#isSave'), 'and save it');
    check(await visible('#isVis'), 'who it is for is offered on hers');
    check(await visible('#isIdeaFld'), 'and so is whose idea');
    await evalJs(`[...document.querySelectorAll('#isIdea button')].find(b => /Linnea/.test(b.textContent)).click()`);
    await evalJs(`document.getElementById('isSave').click()`);
    await sleep(1100);
    check(await under('Khruangbin at the Anthem') === "Linnea's ideas", 'handed back, it moves under her name');
    const order = (await sections()).join();
    check(order === "Linnea's ideas,Your ideas", `HER IDEAS ABOVE HIS — got ${order}`);

    // ── recipes: read, save, scale, cook, made it, the kitchen ─────────
    // The formatter first, imported into the page from the same module the
    // screens use.
    const amounts = await evalJs(`(async () => {
      const base = document.querySelector('script[type=module]').src.replace(/app\.js.*$/, '');
      const { amount } = await import(base + 'recipe.js');
      return [amount(1.5, 1, 'cup'), amount(0.75, 2, 'cup'), amount(1, 1 / 3, 'tbsp'), amount(12, 1.1, null),
        amount(237, 1, 'g'), amount(42, 1, 'ml'), amount(1.234, 1, 'kg'), amount(3, 0.1, 'clove'), amount(2, 1.5, 'tbsp', 3),
        amount(null, 2, 'cup'), amount(4, 2, 'clove')]; })()`);
    check(JSON.stringify(amounts) === JSON.stringify(['1½ cups', '1½ cups', '⅓ tbsp', '13', '240 g', '40 ml', '1.2 kg', '½ clove', '3–4½ tbsp', null, '8 cloves']),
      `amounts scale to what a cook would write: ${JSON.stringify(amounts)}`);

    await evalJs(`document.querySelector('#kindNav [data-kind="recipe"]').click()`);
    await sleep(600);
    await typeIn(`Tuesday chicken ${FAKE}/r/recipe.html`);
    await evalJs(`document.getElementById('btnAdd').click()`);
    await sleep(1800);
    check(/found the recipe/i.test(await evalJs(`document.getElementById('rdTitle').innerText`)), 'a pasted link is READ first, not added as words');
    check(/Lemon Chicken/.test(await evalJs(`document.getElementById('rdBody').innerText`)), 'the sheet says what it found');
    check(/saved under your title: Tuesday chicken/i.test(await evalJs(`document.getElementById('rdBody').innerText`)),
      'and that the title stays as typed');
    check(!(await evalJs(`fetch('/api/space/sp1/items').then(r => r.json()).then(b => b.items.some(i => i.title === 'Tuesday chicken'))`)),
      'nothing is saved until Save');
    await evalJs(`document.getElementById('rdSave').click()`);
    await sleep(1400);
    const card = await evalJs(`(() => { const c = [...document.querySelectorAll('#itemList .rcard')].find(x => /Tuesday chicken/.test(x.innerText));
      return c ? { photo: !!c.querySelector('.rtile img'), text: c.innerText } : null; })()`);
    check(card && card.photo && /30 min · serves 4/.test(card.text) && /Have \d of 4/.test(card.text),
      `the card: its photo, time, servings and what you have — ${JSON.stringify(card)}`);
    check(await evalJs(`[...document.querySelectorAll('#itemList .rcard img.fade')].every(i => i.classList.contains('in'))`),
      'its photo has faded in');

    await evalJs(`[...document.querySelectorAll('#itemList .rcard')].find(x => /Tuesday chicken/.test(x.innerText)).querySelector('[data-open]').click()`);
    await sleep(700);
    const firstLine = () => evalJs(`document.querySelector('#rpBody .ig .ig-t').innerText`);
    check(await firstLine() === '1½ lb chicken thighs', `amounts as written: ${await firstLine()}`);
    await evalJs(`document.getElementById('rpMore').click()`);
    await sleep(150);
    await evalJs(`document.getElementById('rpMore').click()`);
    await sleep(150);
    check(await evalJs(`document.querySelector('#rpBody .box.serves .sv').innerText`) === '6', 'servings go up');
    check(await firstLine() === '2¼ lb chicken thighs', `and the amounts with them: ${await firstLine()}`);
    const unread = await evalJs(`[...document.querySelectorAll('#rpBody .ig .ig-t')].map(e => e.innerText).find(t => /parsley/.test(t))`);
    check(unread === 'A handful of parsley', `a line it could not read is shown as published, unscaled: ${unread}`);
    // Tapping a ring writes the kitchen: need → Have.
    const ringOf = (re) => `[...document.querySelectorAll('#rpBody .ig')].find(e => ${re}.test(e.innerText)).querySelector('.ring')`;
    check(await evalJs(`${ringOf('/garlic/')}.getAttribute('aria-pressed')`) === 'false', 'garlic is not in his kitchen');
    await evalJs(`${ringOf('/garlic/')}.click()`);
    await sleep(1200);
    check(await evalJs(`${ringOf('/garlic/')}.getAttribute('aria-pressed')`) === 'true', 'and one tap puts it there');
    check(await evalJs(`fetch('/api/kitchen/' + encodeURIComponent('${A}')).then(r => r.json()).then(k => k.pantry.some(e => e.key === 'garlic' && e.state === 'have'))`),
      'in his pantry, on the server');

    // And a ring ticked takes it off the list to buy: the parsley he meant to
    // pick up is ticked here instead, and the list lets go of it.
    await evalJs(`fetch('/api/kitchen/' + encodeURIComponent('${A}') + '/buy', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: [{ name: 'parsley' }] }) })`);
    await evalJs(`${ringOf('/parsley/')}.click()`);
    await sleep(1200);
    check(await evalJs(`fetch('/api/kitchen/' + encodeURIComponent('${A}')).then(r => r.json()).then(k => !k.buy.some(b => /parsley/.test(b.name)))`),
      'ticking an ingredient takes it off the list to buy');

    // ── swapping an ingredient ──────────────────────────────────────────
    // Every line has a swap button. The sheet offers what the kitchen has to
    // tick, asks, shows a shortlist — and nothing changes until one is chosen.
    await evalJs(`fetch('/api/kitchen/' + encodeURIComponent('${A}') + '/pantry', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Butter', state: 'have' }) })`);
    await sleep(300);
    const swapOf = (re) => `[...document.querySelectorAll('#rpBody .ig')].find(e => ${re}.test(e.innerText)).querySelector('[data-swap]')`;
    await evalJs(`${swapOf('/olive oil/')}.click()`);
    await sleep(700);
    check(await visible('#swapSheet .modal-in') && /Instead of olive oil/.test(await evalJs(`document.getElementById('swTitle').innerText`)),
      'a line\'s swap button opens the swap sheet for it');
    check(await evalJs(`[...document.querySelectorAll('#swBody [data-pick]')].some(b => b.dataset.pick === 'Butter')`),
      'offering what is in the kitchen to tick');
    await evalJs(`[...document.querySelectorAll('#swBody [data-pick]')].find(b => b.dataset.pick === 'Butter').click()`);
    await sleep(150);
    check(/Will it work here/.test(await evalJs(`document.getElementById('swAsk').innerText`)), 'one ticked: will it work here?');
    await evalJs(`document.getElementById('swAsk').click()`);
    await sleep(1200);
    check(await evalJs(`document.querySelectorAll('#swBody .sw-card').length`) === 2, 'a shortlist comes back');
    check(/butter works best/i.test(await evalJs(`document.querySelector('#swBody .sw-verdict').innerText`)), 'with a verdict on what was ticked');
    check(/In this kitchen/.test(await evalJs(`document.querySelector('#swBody .sw-card').innerText`)), 'and which ones this kitchen can make');
    check(/3 tbsp Butter/.test(await evalJs(`document.querySelector('#swBody .sw-card .sw-amt').innerText`)),
      'its amount scaled to tonight, like the line it would replace');
    check(await evalJs(`fetch('/api/space/sp1/items').then(r => r.json()).then(b => !b.items.find(i => i.title === 'Tuesday chicken').swaps)`),
      'nothing is saved by asking');
    await evalJs(`document.querySelector('#swBody .sw-card [data-use]').click()`);
    await sleep(1300);
    check(!(await visible('#swapSheet .modal-in')), 'choosing one closes the sheet');
    const swapped = await evalJs(`(() => { const r = [...document.querySelectorAll('#rpBody .ig')].find(e => /Butter/.test(e.innerText));
      return r ? { text: r.innerText, on: r.querySelector('[data-swap]').classList.contains('on'), swapped: r.classList.contains('swapped') } : null; })()`);
    check(swapped && swapped.on && swapped.swapped && /tbsp Butter/.test(swapped.text) && /instead of 2 tbsp olive oil/.test(swapped.text),
      `and the line is what goes in now, scaled, with what it replaced: ${JSON.stringify(swapped)}`);
    // Your own, written in.
    await evalJs(`${swapOf('/handful of parsley/')}.click()`);
    await sleep(600);
    await evalJs(`document.getElementById('swOwnIn').value = 'Basil'`);
    await evalJs(`document.querySelector('#swOwn button').click()`);
    await sleep(1300);
    check(/Basil[\s\S]*instead of A handful of parsley/.test(await evalJs(`document.getElementById('rpBody').innerText`)),
      'a swap of your own, written in, reads the same way');

    // Cook mode: big type, its own ingredients scaled, a timer, no screen-lock claim it cannot keep.
    await evalJs(`Object.defineProperty(navigator, 'wakeLock', { value: undefined, configurable: true })`);
    check(await evalJs(`(() => { document.getElementById('rpCook').click();
      return !!document.querySelector('#scr-cook.active') && !!document.querySelector('#scr-space.leaving'); })()`),
      'cook mode is on screen at once, the list fading out under it');
    await sleep(600);
    check(await visible('#scr-cook') && !(await visible('#kindNav')), 'cook mode is the whole screen');
    check(!(await visible('#ckWake')), '"Screen stays on" is not claimed without a wake lock');
    check(await evalJs(`parseFloat(getComputedStyle(document.querySelector('.ck-text')).fontSize)`) >= 24, 'the step is readable from across a counter');
    await evalJs(`document.getElementById('ckNext').click()`);
    await sleep(300);
    check(/2¼ lb chicken thighs/.test(await evalJs(`document.querySelector('.ck-uses').innerText`)), "the step's own ingredients, scaled");
    check(/3 tbsp Butter/.test(await evalJs(`document.querySelector('.ck-uses').innerText`)), 'with the swap cooked as what it is, scaled');
    await evalJs(`document.querySelector('#ckBody [data-run]').click()`);
    await sleep(800);
    check(await evalJs(`fetch('/api/item/' + [...document.querySelectorAll('#itemList .rcard')].find(x => /Tuesday chicken/.test(x.innerText)).dataset.it + '/cooking').then(r => r.status)`) === 200,
      'cooking is posted');
    await evalJs(`document.getElementById('ckNext').click()`);
    await sleep(300);
    check(await evalJs(`document.querySelectorAll('#ckTray .tray').length`) === 1, "the running timer rides along in the tray");
    check(await evalJs(`document.getElementById('ckNext').classList.contains('finish')`), 'the last step finishes');
    await evalJs(`document.getElementById('ckNext').click()`);
    await sleep(650);
    check(await visible('#scr-made'), 'Made it');
    check(await evalJs(`document.querySelectorAll('#scr-made .md-ok .fx-spark').length`) === 8, 'arriving at Made it is a moment');
    await evalJs(`document.querySelector('#mdAgain [data-v="soon"]').click()`);
    await evalJs(`document.getElementById('mdTweaks').value = 'more lemon'`);
    check(await evalJs(`(() => { document.getElementById('mdDone').click();
      const b = document.getElementById('mdDone'); return b.classList.contains('saved') && /Saved/.test(b.innerText); })()`),
      'Done answers where you tapped it');
    await sleep(2000);
    check(!(await visible('#toast')) || !/Made it/.test(await evalJs(`document.getElementById('toast').innerText`)),
      'and no toast to explain it afterwards');
    const made = await evalJs(`fetch('/api/space/sp1/items').then(r => r.json()).then(b => b.items.find(i => i.title === 'Tuesday chicken'))`);
    check(made.done && made.cooked.length === 1 && made.cooked[0].again === 'soon' && made.cooked[0].tweaks === 'more lemon',
      `made it is recorded and ticks it off: ${JSON.stringify(made.cooked)}`);
    check(await visible('#scr-space'), 'and you are back in the list');

    // The kitchen, from its tile: the pantry by aisle, a state that cycles.
    await evalJs(`document.querySelector('[data-kitchen="pantry"]').click()`);
    await sleep(800);
    check(await visible('#scr-kitchen'), 'the Pantry tile opens the kitchen');
    check(/Produce/.test(await evalJs(`document.getElementById('kiBody').innerText`)), 'grouped by aisle');
    await evalJs(`[...document.querySelectorAll('#kiBody [data-cycle]')].find(b => b.dataset.cycle === 'garlic').click()`);
    await sleep(600);
    check(await evalJs(`[...document.querySelectorAll('#kiBody [data-cycle]')].find(b => b.dataset.cycle === 'garlic').innerText`) === 'Low', 'Have → Low');
    await evalJs(`document.querySelector('#kiTabs [data-t="buy"]').click()`);
    await sleep(300);
    check(/Running low[\s\S]*Garlic/i.test(await evalJs(`document.getElementById('kiBody').innerText`)), 'and Low is on the list to buy');
    await evalJs(`document.getElementById('kiBack').click()`);
    await sleep(500);
    check(await visible('#scr-space'), 'back to the list');

    // ── a line that offers a choice ─────────────────────────────────────
    // "2 tbsp gluten free all purpose flour or corn starch": the line asks
    // which, its options are on the table, one tap takes one — or ask which
    // works best here, and the one you would have to buy goes on the list.
    await evalJs(`document.querySelector('#kindNav [data-kind="recipe"]').click()`);
    await sleep(400);
    await evalJs(`(async () => {
      const r = await (await fetch('/api/recipe/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: '${FAKE}/r/gravy.html' }) })).json();
      await fetch('/api/space/sp1/item', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Sunday gravy', kind: 'recipe', mod: { link: { url: '${FAKE}/r/gravy.html' }, recipe: r.recipe } }) });
      document.dispatchEvent(new Event('visibilitychange')); })()`);
    await sleep(1200);
    await evalJs(`[...document.querySelectorAll('#itemList .rcard')].find(x => /Sunday gravy/.test(x.innerText)).querySelector('[data-open]').click()`);
    await sleep(800);
    const choiceBtn = `[...document.querySelectorAll('#rpBody .ig')].find(e => /corn starch/.test(e.innerText)).querySelector('[data-swap]')`;
    check(await evalJs(`${choiceBtn}.innerText.trim()`) === 'Which?', 'a line offering a choice asks which');
    await evalJs(`[...document.querySelectorAll('#rpBody .ig')].find(e => /corn starch/.test(e.innerText)).querySelector('.ring').click()`);
    await sleep(700);
    check(await visible('#swapSheet .modal-in') && await evalJs(`document.getElementById('swTitle').innerText`) === 'Which one?',
      'and so does its ring, rather than putting "flour or corn starch" in the pantry');
    check(await evalJs(`[...document.querySelectorAll('#swBody [data-take]')].map(b => b.dataset.take).join('|')`) === 'gluten free all purpose flour|corn starch',
      'its options, to take one straight away');
    check(await evalJs(`[...document.querySelectorAll('#swBody [data-pick].on')].length`) === 2
      && /Which of these 2 works best/.test(await evalJs(`document.getElementById('swAsk').innerText`)), 'and already ticked, to ask which');
    await evalJs(`document.querySelector('#swBody [data-take="corn starch"]').click()`);
    await sleep(1300);
    check(/2 tbsp corn starch[\s\S]*instead of 2 tbsp gluten free all purpose flour or corn starch/.test(await evalJs(`document.getElementById('rpBody').innerText`)),
      'one tap takes one, at the recipe\'s amount');
    // Back to the choice, and ask — with something from the shop added.
    await evalJs(`${choiceBtn}.click()`);
    await sleep(600);
    await evalJs(`document.getElementById('swOriginal').click()`);
    await sleep(1300);
    await evalJs(`${choiceBtn}.click()`);
    await sleep(600);
    await evalJs(`(() => { const i = document.getElementById('swExtra'); i.value = 'arrowroot'; i.form.requestSubmit(); })()`);
    await sleep(150);
    await evalJs(`document.getElementById('swAsk').click()`);
    await sleep(1300);
    const lastAsk = claudeAsked[claudeAsked.length - 1] || '';
    check(/offers a choice on this line: gluten free all purpose flour or corn starch/.test(lastAsk) && /would buy\): .*arrowroot/.test(lastAsk),
      'asking says the recipe offers the choice, with the option from the shop');
    check(/Use · add to list/.test(await evalJs(`[...document.querySelectorAll('#swBody .sw-card')][1].innerText`)),
      'one not in the kitchen offers to go on the list');
    await evalJs(`[...document.querySelectorAll('#swBody .sw-card')][1].querySelector('[data-use]').click()`);
    await sleep(1500);
    check(await evalJs(`fetch('/api/kitchen/' + encodeURIComponent('${A}')).then(r => r.json()).then(k => k.buy.some(b => b.name === 'bacon fat' && b.forTitle === 'Sunday gravy'))`),
      'and choosing it puts it on the list to buy, for this recipe');
    check(/Bacon fat|bacon fat/.test(await evalJs(`document.getElementById('rpBody').innerText`)), 'as well as on the line');
    check(await evalJs(`fetch('/api/kitchen/' + encodeURIComponent('${A}')).then(r => r.json()).then(k => !k.pantry.some(e => / or /.test(e.name)))`),
      'and nothing named "this or that" ever went into the pantry');

    // ── what it has to be ───────────────────────────────────────────────
    // "gluten free" in the options box is a RULE, not an option to weigh — and
    // tapping the button with it still in the box asks with it. It used to be
    // thrown away by the repaint, and the shortlist came back full of wheat.
    const reqs = await evalJs(`(async () => {
      const base = document.querySelector('script[type=module]').src.replace(/app\\.js.*$/, '');
      const { requirement } = await import(base + 'swap.js');
      return ['gluten free', 'GF', 'no dairy', 'must be vegan', 'Low sodium', 'gluten free flour', 'free range eggs', 'butter'].map(requirement); })()`);
    check(JSON.stringify(reqs) === JSON.stringify(['gluten-free', 'gluten-free', 'dairy-free', 'vegan', 'low-sodium', null, null, null]),
      `what it has to be is read in its usual spellings, and a thing to buy is still a thing: ${JSON.stringify(reqs)}`);
    await evalJs(`${choiceBtn}.click()`);
    await sleep(600);
    const nAsked = claudeAsked.length;
    await evalJs(`document.getElementById('swExtra').value = 'gluten free'`);
    await evalJs(`document.getElementById('swAsk').click()`);
    await sleep(1300);
    const ruled = claudeAsked[claudeAsked.length - 1] || '';
    check(claudeAsked.length === nAsked + 1 && /\nIt has to be: gluten-free\.\n/.test(ruled) && !/(: |, )gluten free(, |\n|$)/.test(ruled),
      `typed and not entered, it still goes — as a rule, not as an option: ${ruled.split('\n').slice(-3).join(' | ')}`);
    check(await evalJs(`(document.querySelector('#swBody [data-must="gluten-free"]') || {}).innerText`) === 'Gluten-free',
      'and the sheet shows it, apart from the options');
    await evalJs(`for (let b; (b = document.querySelector('#swBody [data-pick].on'));) b.click()`);
    await sleep(150);
    check(/Suggest a gluten-free swap/.test(await evalJs(`document.getElementById('swAsk').innerText`)), 'nothing ticked: it asks for a gluten-free swap');
    await evalJs(`document.getElementById('swClose').click()`);
    await sleep(500);
    await evalJs(`${choiceBtn}.click()`);
    await sleep(600);
    check(await evalJs(`!!document.querySelector('#swBody [data-must="gluten-free"]')`), 'kept on this phone for the next swap');
    await evalJs(`document.querySelector('#swBody [data-must="gluten-free"]').click()`);
    await sleep(150);
    check(await evalJs(`!document.querySelector('#swBody [data-must]') && localStorage.getItem('dw-swap-musts') === '[]'`), 'one tap takes it off');
    // Written into "Your own", it is the question, not a thing to cook with.
    await evalJs(`document.getElementById('swOwnIn').value = 'dairy free'`);
    await evalJs(`document.querySelector('#swOwn button').click()`);
    await sleep(1300);
    check(/\nIt has to be: dairy-free\.\n/.test(claudeAsked[claudeAsked.length - 1] || '') && await visible('#swapSheet .modal-in')
      && !/dairy free[\s\S]*instead of/.test(await evalJs(`document.getElementById('rpBody').innerText`)),
      '"dairy free" as your own asks for one rather than swapping the line for the words');
    await evalJs(`document.querySelector('#swBody [data-must="dairy-free"]').click()`);
    await evalJs(`document.getElementById('swClose').click()`);
    await sleep(500);
    await evalJs(`document.getElementById('rpClose').click()`);
    await sleep(400);

    // ── the redesign, by layout ─────────────────────────────────────────
    // The emoji in a tile, the words beside it, the ring on the right — and the
    // stored title never touched. Asked of the LAYOUT, like everything else.
    await evalJs(`document.querySelector('#kindNav [data-kind="activity"]').click()`);
    await sleep(500);
    await typeIn('🏃‍♀️Go for a run');
    await evalJs(`document.getElementById('btnAdd').click()`);
    await sleep(1200);
    const row = await evalJs(`(() => {
      const r = ${rowOf('/Go for a run/')};
      const b = r.querySelector('b').getBoundingClientRect();
      const t = r.querySelector('.tick').getBoundingClientRect();
      const hit = document.elementFromPoint(t.left + t.width / 2 + 20, t.top + t.height / 2);
      return { tile: r.querySelector('.etile').innerText.trim(), title: r.querySelector('b').innerText,
        right: t.left > b.right, ring: Math.round(t.width), hit: !!(hit && hit.closest('.tick')) }; })()`);
    check(row.tile === '🏃‍♀️', `the leading emoji sits in its tile: ${row.tile}`);
    check(row.title === 'Go for a run', `and the words beside it, typed without a space: ${row.title}`);
    check(row.right, 'the ring is on the right, the thumb side');
    check(row.ring === 26 && row.hit, `26px to look at, and still hit 20px out from its middle (${row.ring}, ${row.hit})`);
    await evalJs(`(${rowOf('/Go for a run/')}).querySelector('[data-open]').click()`);
    await sleep(500);
    check(await evalJs(`document.getElementById('isName').value`) === '🏃‍♀️Go for a run', 'the stored title is untouched');
    // Bottom sheets: anchored to the bottom, full width on a phone, an X you
    // can hit, and none of the stacked Cancel / Close / Not now.
    const sheet = await evalJs(`(() => { const r = document.querySelector('#itemSheet .modal-in').getBoundingClientRect();
      const x = document.getElementById('isCancel').getBoundingClientRect();
      return { bottom: Math.round(innerHeight - r.bottom), width: Math.round(innerWidth - r.width), x: Math.min(x.width, x.height) }; })()`);
    check(Math.abs(sheet.bottom) <= 1 && sheet.width <= 1, `a sheet rises from the bottom, edge to edge: ${JSON.stringify(sheet)}`);
    check(sheet.x >= 44, `with an X a thumb can hit (${sheet.x}px)`);
    check(await evalJs(`[...document.querySelectorAll('.modal button')].filter(b =>
      /^(cancel|close|not now)$/i.test(b.innerText.trim())).length`) === 0, 'and no stacked Cancel / Close / Not now buttons');
    check(await evalJs(`(() => { document.getElementById('itemSheet').click();
      const m = document.getElementById('itemSheet'); return m.hidden && m.classList.contains('leaving'); })()`),
      'a tap on the scrim closes it at once, and it is drawn a moment longer as it falls away');
    await sleep(400);
    check(!(await visible('#itemSheet .modal-in')), 'a tap on the scrim closes it');
    // Done together is its icon and its count; the words are for a screen reader.
    const doneChip = await evalJs(`({ label: document.getElementById('tabDone').getAttribute('aria-label'),
      text: document.getElementById('tabDone').innerText.trim() })`);
    check(/^Done together/.test(doneChip.label) && /^\d*$/.test(doneChip.text),
      `Done together is an icon and a count, labelled for a screen reader: ${JSON.stringify(doneChip)}`);
    check(/^\d+ to do$/.test(await evalJs(`document.getElementById('spaceCount').innerText`)), 'with how many on the left');
    await evalJs(`fetch('/api/space/sp1/items').then(r => r.json()).then(b => Promise.all(b.items
      .filter(i => /Go for a run/.test(i.title)).map(i => fetch('/api/item/' + i.id, { method: 'DELETE' }))))`);

    // ── coming back to the app ──────────────────────────────────────────
    // A list left open on the phone used to show nothing new until you left it
    // and came back: returning repainted only the shelf. Now the open list is
    // fetched again, and what arrived while you were away glows as it lands.
    const asLinnea = { cookie: `${AUTH.COOKIE}=${AUTH.sign(L, SECRET)}`, 'content-type': 'application/json' };
    const picnic = await (await fetch(`${BASE}/api/space/sp1/item`, { method: 'POST', headers: asLinnea,
      body: JSON.stringify({ title: 'Picnic by the river', visibility: 'shared', kind: 'activity' }) })).json();
    check(!(await evalJs(`!!${rowOf('/Picnic by the river/')}`)), 'something she adds is not on his open list yet');
    await evalJs(`document.dispatchEvent(new Event('visibilitychange'))`);
    await sleep(900);
    check(await evalJs(`!!${rowOf('/Picnic by the river/')}`), 'coming back to the app brings it in');
    check(await evalJs(`(${rowOf('/Picnic by the river/')}).classList.contains('arrived')`), 'and it glows as it lands');
    check(await evalJs(`document.querySelectorAll('#itemList .arrived').length`) === 1, 'it alone');
    await fetch(`${BASE}/api/item/${picnic.item.id}`, { method: 'DELETE', headers: asLinnea });

    // ── less motion, asked for ──────────────────────────────────────────
    // The state change and nothing else: a sheet that closes is simply gone,
    // and a screen that changes simply changes.
    await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await evalJs(`(${rowOf('/Go record shopping/')}).querySelector('[data-open]').click()`);
    await sleep(400);
    check(await evalJs(`(() => { document.getElementById('isCancel').click();
      return !document.getElementById('itemSheet').classList.contains('leaving'); })()`) && !(await visible('#itemSheet .modal-in')),
      'with reduced motion a sheet closes with no fall');
    check(await evalJs(`(() => { document.getElementById('spaceBack').click();
      return !document.querySelector('.screen.leaving') && !!document.querySelector('#scr-shelf.active'); })()`),
      'and a screen changes with no fade');
    await evalJs(`document.querySelector('#shelfList [data-sp]').click()`);
    await sleep(1000);
    await S('Emulation.setEmulatedMedia', { features: [] });

    // ── [hidden] still means hidden, by LAYOUT ─────────────────────────
    // The map is parked, so its flow cannot be driven from the UI — but the
    // property that block existed to guard is not about the map. `.items{
    // display:flex}` beats the UA `[hidden]` rule, which is how the list once
    // stayed on screen above the map while every `.hidden` check said it was
    // gone. Same trap that hid nothing in the item sheet a day later. Assert it
    // where it lives, on the panes themselves, so it is still guarded when the
    // map comes back.
    for (const sel of ['#itemList', '#visRow', '#kindNav', '#isIdeaFld', '#placesTop', '#plFind', '#plInfo', '#nudgeRow']) {
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

    // ── today's question ────────────────────────────────────────────────
    // A card at the top of the pair list. Linnea answers first; his sheet shows
    // hers locked — absent, not hidden — until he answers, and then at once,
    // with the streak moment drawing. Her answer becomes a thing to do, under
    // her ideas.
    const asApi = (uid, method, p, body) => fetch(`${BASE}${p}`, { method,
      headers: { 'content-type': 'application/json', cookie: `${AUTH.COOKIE}=${encodeURIComponent(AUTH.sign(uid, SECRET))}` },
      body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
    const reopen = async () => {
      await evalJs(`document.getElementById('spaceBack').click()`);
      await sleep(500);
      await evalJs(`document.querySelector('#shelfList [data-sp="sp1"]').click()`);
      await sleep(1200);
    };
    await evalJs(`document.querySelector('#kindNav [data-kind="activity"]').click()`);
    await sleep(400);
    if (await evalJs(`document.getElementById('tabDone').classList.contains('on')`)) { await evalJs(`document.getElementById('tabDone').click()`); await sleep(400); }
    check(await visible('#dqCard') && await evalJs(`document.getElementById('dqCard').dataset.state`) === 'a'
      && await evalJs(`document.getElementById('itemList').firstElementChild.id`) === 'dqCard', 'today\'s question sits at the top of the pair list');
    await evalJs(`document.querySelector('#kindNav [data-kind="movie"]').click()`);
    await sleep(400);
    check(!(await evalJs(`!!document.getElementById('dqCard')`)), 'on Activities only: not on the shelf of films');
    await evalJs(`document.querySelector('#kindNav [data-kind="activity"]').click()`);
    await sleep(400);
    check(await evalJs(`(() => { const b = document.querySelector('#dqCard .dq-go').getBoundingClientRect();
      const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!(e && e.closest('.dq-go')); })()`), 'and its Answer button takes the tap');
    const lq = await asApi(L, 'GET', '/api/space/sp1/question');
    const HERS = 'A pottery class, with truly terrible mugs';
    await asApi(L, 'POST', '/api/space/sp1/question/answer', { date: lq.today.date, text: HERS });
    await reopen();
    check(/Linnea answered/.test(await evalJs(`document.getElementById('dqCard').innerText`)), 'the card says she answered');
    await evalJs(`document.querySelector('#dqCard .dq-go').click()`);
    await sleep(600);
    check(await visible('#dqSheet .modal-in') && await visible('#dqBody .dq-bars'), 'answering, with hers locked');
    check(!(await evalJs(`document.getElementById('dqSheet').textContent`)).includes(HERS), 'and nothing of hers is on the page');
    await evalJs(`(() => { const t = document.getElementById('dqText'); t.value = 'Night swimming somewhere warm'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check(!(await evalJs(`document.getElementById('dqSend').disabled`)), 'the button wakes once there is something to send');
    await evalJs(`document.getElementById('dqSend').click()`);
    await sleep(350);
    const moment = await evalJs(`(() => { const d = document.querySelector('#dqBody .dq-disc');
      return { disc: !!d, sparks: d ? [...d.querySelectorAll('.fx-spark')].filter(s => s.getAnimations().length).length : 0 }; })()`);
    check(moment.disc && moment.sparks > 0, `the streak moment draws, caught mid-flight: ${JSON.stringify(moment)}`);
    check((await evalJs(`document.getElementById('dqBody').innerText`)).includes(HERS), 'and answering shows hers at once');
    await evalJs(`document.querySelector('#dqBody [data-dq-add="theirs"]').click()`);
    await sleep(700);
    check(!(await visible('#dqSheet .modal-in')) && await evalJs(`document.getElementById('newItem').value`) === HERS,
      'Add to Activities puts her answer in the composer');
    await evalJs(`document.getElementById('btnAdd').click()`);
    await sleep(1500);
    check(await evalJs(`fetch('/api/space/sp1/items').then(r => r.json()).then(b => b.items.some(i => i.title === ${JSON.stringify(HERS)} && i.ideaBy === '${L}'))`),
      'and it lands as her idea');
    check(await evalJs(`document.getElementById('dqCard').dataset.state`) === 'c' && /You both answered/.test(await evalJs(`document.getElementById('dqCard').innerText`)),
      'the card is a slim row once both are in');
    await evalJs(`document.querySelector('#dqCard .dq-slim-go').click()`);
    await sleep(600);
    check(await visible('#dqBody .dq-added'), 'and the sheet remembers it went on the list');
    await evalJs(`document.getElementById('dqClose').click()`);
    await sleep(400);
    await evalJs(`document.querySelector('#dqCard .dq-flame').click()`);
    await sleep(900);
    check(await visible('#scr-questions') && (await evalJs(`document.getElementById('dqHist').innerText`)).includes(HERS),
      'every question so far, with both answers');
    await evalJs(`document.getElementById('dqBack').click()`);
    await sleep(500);
    // Which questions: from the list's settings, your own switches.
    await evalJs(`document.getElementById('spaceSettings').click()`);
    await sleep(400);
    await evalJs(`document.getElementById('ssQuestion').click()`);
    await sleep(600);
    check(await visible('#dqSetSheet .modal-in') && await evalJs(`document.querySelector('#dqSetBody [data-deck="friends"]').checked`)
      && !(await evalJs(`document.querySelector('#dqSetBody [data-deck="spicy"]').checked`)), 'which questions: Friends on, the rest off');
    await evalJs(`document.querySelector('#dqSetBody [data-deck="romance"]').click()`);
    await sleep(700);
    check(/Waiting on Linnea/.test(await evalJs(`document.getElementById('dqSetBody').innerText`)), 'turning one on says it waits on her');
    check(!JSON.stringify(await asApi(L, 'GET', '/api/space/sp1/question')).includes('romance'), 'and she is never told');
    await evalJs(`document.getElementById('dqSetClose').click()`);
    await sleep(400);

    // A Spicy day: the list names nothing, and Open lands in the rose with it.
    const SPICY = require('../lib/questions').catalogue().filter(q => q.kind === 'spicy').map(q => q.text);
    await asApi(K, 'GET', '/api/space/sp9/question');
    const kr = await asApi(K, 'GET', '/api/space/sp9/pleasure');
    await asApi(K, 'POST', '/api/space/sp9/pleasure', { question: { date: kr.question.today.date, text: 'KIT SAID THIS' } });
    await asUser(J);
    check(await visible('#dqCard.rose') && /just the two of you/.test(await evalJs(`document.getElementById('dqCard').innerText`)),
      'on a Spicy day the card goes rose and names nothing');
    const listText = await evalJs(`document.getElementById('scr-space').innerText`);
    check(!SPICY.some(t => listText.includes(t)), 'no Spicy question anywhere on the list');
    await evalJs(`document.querySelector('#dqCard .dq-go').click()`);
    await sleep(900);
    check(await visible('#roseSheet .modal-in') && (await evalJs(`document.getElementById('rsBody').innerText`)).includes(kr.question.today.text),
      'Open lands in the rose, on the question');
    check(!(await evalJs(`document.getElementById('rsBody').innerText`)).includes('KIT SAID THIS'), 'with Kit\'s answer still locked');
    await evalJs(`(() => { const t = document.querySelector('#rsBody .dq-text'); t.value = 'Jo too'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evalJs(`document.querySelector('#rsBody .dq-send').click()`);
    await sleep(900);
    check((await evalJs(`document.getElementById('rsBody').innerText`)).includes('KIT SAID THIS'), 'and answering it there shows Kit\'s');

    // ── an invite, on a server with no Google and no Access ───────────────
    // The link is the sign-in: who sent it, a name, one tap, and you are in the
    // list. This server had shown "Sign-in is not configured" here.
    // ── a show's episodes, and the finale ──────────────────────────────
    // TMDB for this part only (the config is read live). Ticking the last
    // episode of a show that has ended finishes it, and the poster flies off
    // the shelf into Done together. Caught mid-flight, because an assertion
    // made after it lands would pass just as well with no finale at all.
    const cfgPath = path.join(dir, 'config.json');
    const cfg0 = fs.readFileSync(cfgPath, 'utf8');
    fs.writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(cfg0), tmdbKey: 'cc', tmdbEndpoint: `${FAKE}/tmdb` }));
    const showIt = (await asApi(A, 'POST', '/api/space/sp1/item',
      { title: 'The Long Goodbye', kind: 'show', mod: { watch: { tmdbId: 9001, mediaType: 'tv', title: 'The Long Goodbye' } } })).item;
    await asUser(A);
    await S('Page.navigate', { url: `${BASE}/?list=sp1` });
    await sleep(2200);
    // The list lands on its first tab once it has loaded; ask until Shows holds.
    for (let i = 0; i < 6 && !(await evalJs(`!!document.querySelector('#kindNav [data-kind="show"].on')`)); i++) {
      await evalJs(`(document.querySelector('#kindNav [data-kind="show"]') || { click() {} }).click()`);
      await sleep(600);
    }
    if (await evalJs(`document.getElementById('tabDone').classList.contains('on')`)) { await evalJs(`document.getElementById('tabDone').click()`); await sleep(400); }
    const showCard = `#itemList .card[data-it="${showIt.id}"]`;
    await evalJs(`document.querySelector('${showCard} [data-open]').click()`);
    await sleep(1400);
    check(await visible('#isEpsFld') && await evalJs(`document.querySelectorAll('#isEps .ep').length`) === 3, "a show's sheet has its episodes, season 1 first");
    check(await evalJs(`[...document.querySelectorAll('#isEps .ep .ep-t b')].map(b => b.innerText).join('|')`) === 'Chapter 1|Chapter 2|Chapter 3',
      'each episode by its title');
    const nextUp = await evalJs(`document.querySelector('#isEps .ep-next').innerText`);
    check(/S1 · E1/.test(nextUp) && /Chapter 1/.test(nextUp), `and what is next, by name: ${nextUp}`);
    await evalJs(`document.querySelector('#isEps [data-all]').click()`);
    await sleep(900);
    check(await evalJs(`document.getElementById('isEpsCount').innerText`) === '3 of 5', 'a whole season at once');
    check(await evalJs(`!!document.querySelector('${showCard} .prog')`) && /S2 E1 next/.test(await evalJs(`document.querySelector('${showCard} .cap').innerText`)),
      'and the poster behind the sheet shows how far, and what is next');
    await evalJs(`document.querySelector('#isEps [data-next]').click()`);
    await sleep(900);
    await evalJs(`document.querySelector('#isEps [data-next]').click()`);   // the last one
    await sleep(1700);
    check(!(await visible('#itemSheet .modal-in')), 'the last episode closes the sheet');
    check(await evalJs(`(() => { const c = document.querySelector('${showCard}.finale'); if (!c) return false;
      const st = c.querySelector('.fin-stamp'); return !!st && getComputedStyle(c.querySelector('.art')).transform !== 'none'
        && Number(getComputedStyle(st).opacity) > 0.3; })()`), 'and the finale plays on the poster: it lifts, and SEEN IT ALL lands');
    await sleep(2600);
    check(!(await evalJs(`!!document.querySelector('${showCard}')`)) && !(await evalJs(`!!document.querySelector('.card.flying')`)),
      'then it has flown off the shelf');
    check((await asApi(A, 'GET', '/api/space/sp1/items')).items.find(x => x.id === showIt.id).done, 'and the show is done together');
    fs.writeFileSync(cfgPath, cfg0);
    await evalJs(`document.querySelector('#kindNav [data-kind="activity"]').click()`);
    await sleep(400);

    // ── suggestions ─────────────────────────────────────────────────────
    // The button beside Calendar opens a view of its own: how much energy, for
    // when, and then a plan — each piece swappable — and the list in order.
    // A long title too: unwrapped it is wider than the screen, and nothing here
    // may size itself to that.
    await asApi(A, 'POST', '/api/space/sp1/item', { title: 'Walk the whole length of the canal towpath and stop for lunch somewhere along the way when it looks nice', kind: 'activity' });
    const flourRead = await asApi(A, 'POST', '/api/recipe/paste', { text: 'Ingredients\n2 cups flour\n2 tbsp soy sauce\n1 lb chicken\n\nMethod\nMix and bake for 20 minutes.' });
    const flourPie = (await asApi(A, 'POST', '/api/space/sp1/item', { title: 'Flour pie', kind: 'recipe', mod: { recipe: flourRead.recipe } })).item;
    await S('Page.navigate', { url: `${BASE}/?list=sp1` });
    await sleep(2200);
    await evalJs(`document.getElementById('tabSug').click()`);
    await sleep(1600);
    // What the plan is for is one row; the controls are a sheet behind it, so
    // the plan is what the screen opens on.
    check(await visible('.sg') && await visible('#sgSum') && !(await visible('#sgEnergy')), 'Suggestions opens its own view, with what it is planning for in one row');
    check(!(await visible('#kindNav')) && !(await visible('#newItem')), 'and the kind bar and the composer step aside');
    await evalJs(`document.getElementById('sgSum').click()`);
    await sleep(700);
    check(await visible('#sgTuneSheet .modal-in') && await visible('#sgEnergy'), 'the row opens the controls, with an energy slider');
    await evalJs(`(() => { const r = document.getElementById('sgEnergy'); r.value = '1';
      r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(1800);
    check(await evalJs(`document.getElementById('sgWord').innerText`) === 'Wiped out', 'the slider says what it means');
    check(/^Wiped out · Now/.test(await evalJs(`document.querySelector('#sgSum b').innerText`)), 'and the row behind the sheet already says it');
    if (process.env.SHOT_SUG) {
      await evalJs(`document.getElementById('spaceScroll').scrollTop = 0`);
      await sleep(300);
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_SUG.replace(/\.png$/, '-controls.png'), Buffer.from(data, 'base64'));
    }
    await evalJs(`document.getElementById('sgTuneClose').click()`);
    await sleep(500);
    check(!(await visible('#sgTuneSheet')) && await visible('#sgBody .sg-slot'), 'closing the controls leaves the plan');
    check(await evalJs(`document.querySelectorAll('#sgBody .sg-slot').length`) >= 1 && await evalJs(`document.querySelectorAll('#sgBody .sg-it[data-sit]').length`) >= 2,
      'and there is a plan, and the list in order');
    check(/Low effort|No going anywhere/.test(await evalJs(`document.getElementById('sgBody').innerText`)), 'each thing says why');
    // A piece of the plan says its reasons one to a line, each with a mark, and
    // every line is drawn (a rule that hid them would still leave the words in the DOM).
    const lines = await evalJs(`[...document.querySelectorAll('#sgBody .sg-slot .sg-pc .sg-rs li')].map(li => {
      const r = li.getBoundingClientRect(); return { h: Math.round(r.height), mark: !!li.querySelector('svg'), top: Math.round(r.top) }; })`);
    check(lines.length >= 1 && lines.every(x => x.h >= 14 && x.mark), `a piece's reasons are lines of their own: ${JSON.stringify(lines.slice(0, 4))}`);
    // Starting from the same place, the journey is said once; apart, each has a line.
    const legs = await evalJs(`(async () => {
      const base = document.querySelector('script[type=module]').src.replace(/app\\.js.*$/, '');
      const { transitHtml } = await import(base + 'suggest.js');
      const box = document.createElement('div');
      const leg = (mine, minutes) => ({ mine, name: 'Linnea', minutes, lines: [{ line: 'OR', color: 'ED8B00' }] });
      box.innerHTML = transitHtml([leg(true, 25), leg(false, 25)]);
      const same = box.innerText;
      box.innerHTML = transitHtml([leg(true, 25), leg(false, 40)]);
      return same + '|' + box.innerText; })()`);
    check(/^25 min each\s*OR\|/.test(legs) && /You 25 min/.test(legs) && /Linnea 40 min/.test(legs), `one journey for both when it is the same, one each when not: ${legs}`);
    // On a phone, by LAYOUT. On iOS Safari the first cut came out wider
    // than the screen, centred, with every card's edges off it. Chrome never
    // reproduced that (checked: this passes on the old rule too), so this
    // asserts the result and is not proof against that bug.
    const sgEdges = await evalJs(`(() => { const out = [...document.querySelectorAll('.sg, .sg-sum, .sg-slot, #sgPlanIt, .sg-list, .sg-day, .sg-days, .sg-rs')]
      .map(e => e.getBoundingClientRect()).filter(r => r.width);
      const sc = document.getElementById('spaceScroll');
      const sg = document.querySelector('.sg').getBoundingClientRect();
      const list = document.getElementById('itemList');
      const pad = parseFloat(getComputedStyle(list).paddingLeft) + parseFloat(getComputedStyle(list).paddingRight);
      return { left: Math.min(...out.map(r => Math.round(r.left))), right: Math.max(...out.map(r => Math.round(r.right))),
        vw: innerWidth, sideways: sc.scrollWidth - sc.clientWidth, sg: Math.round(sg.width), room: Math.round(list.clientWidth - pad) }; })()`);
    check(sgEdges.left >= 8 && sgEdges.right <= sgEdges.vw - 8 && sgEdges.sideways <= 0 && Math.abs(sgEdges.sg - sgEdges.room) <= 2,
      `everything sits inside the screen, exactly as wide as the list: ${JSON.stringify(sgEdges)}`);
    await evalJs(`document.querySelector('#sgBody [data-vote][data-v="1"]').click()`);
    await sleep(1500);
    check(await evalJs(`!!document.querySelector('#sgBody [data-vote][data-v="1"][aria-pressed="true"]')`), 'a thumb is kept');
    await evalJs(`document.querySelector('#sgBody [data-swap]').click()`);
    await sleep(700);
    check(await visible('#sgSwapSheet .modal-in') && /From your list/.test(await evalJs(`document.getElementById('sgSwapBody').innerText`)), 'Swap offers other things for that piece');
    await evalJs(`document.getElementById('sgSwapIdeas').click()`);
    await sleep(1500);
    // Whichever part of the day the first slot is, only an idea of that kind comes back.
    check(/The Apartment|pot of chili|jigsaw/.test(await evalJs(`document.getElementById('sgSwapBody').innerText`))
      && await evalJs(`document.querySelectorAll('#sgSwapBody [data-useidea]').length`) === 1, 'and something new of the same sort, when asked');
    await evalJs(`document.getElementById('sgSwapClose').click()`);
    await sleep(400);
    // Where you start from: a station you choose. It is a row in the controls,
    // and it opens a sheet of its own in their place.
    await evalJs(`document.getElementById('sgSum').click()`);
    await sleep(600);
    await evalJs(`document.getElementById('sgFrom').click()`);
    await sleep(700);
    check(await visible('#sgStationSheet .modal-in') && !(await visible('#sgTuneSheet')), 'Starting from opens the stations, one sheet at a time');
    await evalJs(`(() => { const i = document.querySelector('#sgStationBody [data-q]'); i.value = 'union';
      i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(1300);
    await evalJs(`document.querySelector('#sgStationBody [data-pick]').click()`);
    await sleep(1200);
    check(/Union Station/.test(await evalJs(`document.querySelector('#sgStationBody .crow').innerText`)), 'search, tap, and it is yours');
    await evalJs(`document.getElementById('sgStationClose').click()`);
    await sleep(2600);
    check(/Union Station/.test(await evalJs(`document.getElementById('sgSum').innerText`)) && await visible('#sgSum small'), 'and the screen says where you start from');
    await evalJs(`document.getElementById('sgSum').click()`);
    await sleep(600);
    check(/Union Station/.test(await evalJs(`document.getElementById('sgFrom').innerText`)) && await visible('#sgFrom'), 'as do the controls');
    await evalJs(`document.getElementById('sgThrough').click()`);
    await sleep(2000);
    await evalJs(`document.getElementById('sgTuneClose').click()`);
    await sleep(500);
    check(/Into the next day/.test(await evalJs(`document.querySelector('#sgSum small').innerText`)), 'carrying on is said in the row');
    // Two days are a tab each: both are drawn, and a tap shows the other.
    const dayTabs = await evalJs(`[...document.querySelectorAll('#sgBody .sg-days [data-day]')].map(x => x.innerText.replace(/\\s+/g, ' ').trim())`);
    check(dayTabs.length === 2 && /Tomorrow/.test(dayTabs[1]) && /°/.test(dayTabs.join('|')), `a plan can carry on into tomorrow, a tab a day with its weather: ${JSON.stringify(dayTabs)}`);
    const shown = () => evalJs(`[...document.querySelectorAll('#sgBody .sg-dayp')].map(p => p.getClientRects().length ? p.querySelectorAll('.sg-slot').length : 0)`);
    const day1 = await shown();
    if (process.env.SHOT_SUG) {
      await evalJs(`document.getElementById('spaceScroll').scrollTop = 0`);
      await sleep(300);
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_SUG.replace(/\.png$/, '-today.png'), Buffer.from(data, 'base64'));
    }
    await evalJs(`document.querySelectorAll('#sgBody .sg-days [data-day]')[1].click()`);
    await sleep(200);
    const day2 = await shown();
    check(day1[0] >= 1 && day1[1] === 0 && day2[0] === 0 && day2[1] >= 1, `one day on screen at a time: ${JSON.stringify([day1, day2])}`);
    if (process.env.SHOT_SUG) {
      await evalJs(`document.getElementById('spaceScroll').scrollTop = 0`);
      await sleep(300);
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_SUG.replace(/\.png$/, '-tomorrow.png'), Buffer.from(data, 'base64'));
    }
    // The rail's dot sits beside the card, inside the screen, never under it.
    const rail = await evalJs(`(() => { const sl = [...document.querySelectorAll('#sgBody .sg-dayp .sg-slot')].find(e => e.getClientRects().length);
      const c = sl.getBoundingClientRect(); const dot = getComputedStyle(sl, '::before');
      return { card: Math.round(c.left), dot: Math.round(c.left + parseFloat(dot.left)), w: parseFloat(dot.width) }; })()`);
    check(rail.dot >= 8 && rail.dot + rail.w <= rail.card, `each piece has its dot on the rail: ${JSON.stringify(rail)}`);
    await evalJs(`document.querySelectorAll('#sgBody .sg-days [data-day]')[0].click()`);
    await sleep(200);
    check(await evalJs(`[...document.querySelectorAll('#sgBody .sg-slot .sg-sh small')].some(x => /°/.test(x.innerText))`),
      'and each piece says the weather for its own hour');
    // What the list eats: a rule of the list, chosen from the server's table.
    check(/Anything/.test(await evalJs(`document.getElementById('sgEat').innerText`)), 'a list with no rule says it eats anything');
    await evalJs(`document.getElementById('sgSum').click()`);
    await sleep(600);
    await evalJs(`document.getElementById('sgEat').click()`);
    await sleep(700);
    check(await visible('#sgDietSheet .modal-in') && !(await visible('#sgTuneSheet')) && await evalJs(`document.querySelectorAll('#sgDietBody [data-diet]').length`) >= 8
      && await evalJs(`document.getElementById('sgStrict').disabled`) === true, 'What you eat opens the rules a list can keep, and "medical" waits for one');
    await evalJs(`document.querySelector('#sgDietBody [data-diet="gluten-free"]').click()`);
    await sleep(900);
    await evalJs(`document.getElementById('sgStrict').click()`);
    await sleep(900);
    check(/Gluten-free · strictly/.test(await evalJs(`document.getElementById('sgEat').innerText`))
      && /Gluten-free/.test(await evalJs(`document.getElementById('sgSum').innerText`)), 'and the screen says what the list keeps to');
    if (process.env.SHOT_DIET) {
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_DIET, Buffer.from(data, 'base64'));
    }
    const kept = (await asApi(A, 'GET', '/api/state')).spaces.find(x => x.id === 'sp1').diet;
    check(!!kept && kept.must.join() === 'gluten-free' && kept.strict === true, `saved on the list, for both of them: ${JSON.stringify(kept)}`);
    await evalJs(`document.getElementById('sgDietClose').click()`);
    await sleep(2400);
    await evalJs(`(() => { const m = document.getElementById('sgMore'); if (m) m.click(); })()`);
    await sleep(300);
    check(/Has flour, soy sauce · swap for gluten-free/.test(await evalJs(`document.getElementById('sgBody').innerText`)), 'a recipe with flour in it says so on its row');
    await evalJs(`document.getElementById('sgIdeas').click()`);
    await sleep(1600);
    const ideasText = await evalJs(`document.getElementById('sgBody').innerText`);
    check(/naturally gluten-free/.test(ideasText) && /Ask a place before you order/.test(ideasText) && !/Fresh pasta/.test(ideasText),
      'new ideas say how they keep to it, one that does not is not offered, and nobody is told a place was checked');
    if (process.env.SHOT_EAT) {
      for (const [name, sel] of [['a', '#sgEat'], ['b', '#sgBody .sg-list'], ['c', '#sgIdeas']]) {
        await evalJs(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' })`);
        await sleep(300);
        const { data } = await S('Page.captureScreenshot', { format: 'png' });
        require('fs').writeFileSync(process.env.SHOT_EAT.replace(/\.png$/, `-${name}.png`), Buffer.from(data, 'base64'));
      }
    }
    // And it is a rule on a recipe's swap sheet, with no × there: it is the list's.
    const ruleChip = await evalJs(`(async () => {
      const base = document.querySelector('script[type=module]').src.replace(/app\\.js.*$/, '');
      const { openSwap } = await import(base + 'swap.js');
      await openSwap(${JSON.stringify(flourPie.id)}, 0, null);
      await new Promise(r => setTimeout(r, 400));
      const chip = document.querySelector('#swBody .sw-musts .rule');
      return [chip ? chip.innerText : '', chip ? chip.tagName : '', document.getElementById('swAsk').innerText.trim()].join('|'); })()`);
    check(ruleChip === 'Gluten-free|B|Suggest a gluten-free swap', `a swap for that recipe has to be gluten-free too: ${ruleChip}`);
    await evalJs(`document.getElementById('swClose').click()`);
    await sleep(400);
    // What is on the calendar keeps its own hour. A film planned for 8:45 is the
    // evening's, at 8:45; a gallery planned for 5:30, when it shuts at five, is
    // said in its slot and something else is offered; and the button puts only
    // the REST on the calendar, so nothing already there is moved.
    const pad2 = (n) => String(n).padStart(2, '0');
    const d2 = new Date(Date.now() + 2 * 864e5);
    const planDay = `${d2.getFullYear()}-${pad2(d2.getMonth() + 1)}-${pad2(d2.getDate())}`;
    const lateShow = (await asApi(A, 'POST', '/api/space/sp1/item', { title: 'Late show', kind: 'movie' })).item;
    const supper = (await asApi(A, 'POST', '/api/space/sp1/item', { title: 'Print gallery', kind: 'place',
      mod: { place: { name: 'Print gallery', what: 'gallery', lat: 38.9, lon: -77.03, osm: 'N4242' } } })).item;
    await asApi(A, 'POST', `/api/item/${lateShow.id}/when`, { date: planDay, time: '20:45' });
    await asApi(A, 'POST', `/api/item/${supper.id}/when`, { date: planDay, time: '17:30' });
    await S('Page.navigate', { url: `${BASE}/?list=sp1` });
    await sleep(2200);
    await evalJs(`document.getElementById('tabSug').click()`);
    await sleep(1200);
    // The slider remembers "wiped out" from above; an ordinary evening has things to offer.
    await evalJs(`(() => { const r = document.getElementById('sgEnergy'); r.value = '3'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(600);
    await evalJs(`document.querySelector('.sg-when [data-when="pick"]').click()`);
    await sleep(300);
    await evalJs(`(() => { for (const [id, v] of [['sgDate', ${JSON.stringify(planDay)}], ['sgTime', '16:30']]) {
      const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
    await sleep(5200);
    const slotsSay = await evalJs(`[...document.querySelectorAll('#sgBody .sg-slot')].map(el => ({
      head: el.querySelector('.sg-sh b').innerText + ' ' + el.querySelector('.sg-sh small').innerText,
      bump: (el.querySelector('.sg-bump') || {}).innerText || '',
      row: (el.querySelector('.sg-it b') || {}).innerText || '' }))`);
    const eveSlot = slotsSay.find(x => /^Evening/.test(x.head));
    const dinSlot = slotsSay.find(x => /^Afternoon/.test(x.head));
    check(!!eveSlot && /^Evening at 8:45 PM/.test(eveSlot.head) && eveSlot.row === 'Late show', `a film on the calendar for 8:45 is the evening’s, at its own hour: ${JSON.stringify(eveSlot)}`);
    check(!!dinSlot && /Print gallery is on the calendar for then/.test(dinSlot.bump) && /Closed then/.test(dinSlot.bump) && !!dinSlot.row && dinSlot.row !== 'Print gallery',
      `what is on the calendar but shut then is said, and not offered: ${JSON.stringify(dinSlot)}`);
    check(/^Afternoon around 5:30 PM/.test((dinSlot || {}).head || ''), `and that part of the day is weighed for its hour: ${JSON.stringify(dinSlot)}`);
    const bumpColour = await evalJs(`(() => { const b = document.querySelector('#sgBody .sg-bump .t-bad'); const r = document.querySelector('#sgBody .sg-bump').getBoundingClientRect();
      return [b ? getComputedStyle(b).color : '', getComputedStyle(document.documentElement).getPropertyValue('--warn').trim(), Math.round(r.left), Math.round(r.right), innerWidth].join('|'); })()`);
    check(/^rgb/.test(bumpColour) && Number(bumpColour.split('|')[2]) >= 8 && Number(bumpColour.split('|')[3]) <= Number(bumpColour.split('|')[4]) - 8, `drawn in the slot, inside the screen: ${bumpColour}`);
    if (process.env.SHOT_PLAN) {
      await evalJs(`document.querySelector('#sgBody .sg-bump').scrollIntoView({ block: 'center' })`);
      await sleep(300);
      const { data } = await S('Page.captureScreenshot', { format: 'png' });
      require('fs').writeFileSync(process.env.SHOT_PLAN, Buffer.from(data, 'base64'));
    }
    const planBtn = await evalJs(`(document.getElementById('sgPlanIt') || {}).innerText || ''`);
    check(planBtn === 'Put the rest on the calendar', `the button is for what is not on the calendar yet: ${planBtn}`);
    const hadWhen = new Set((await asApi(A, 'GET', '/api/space/sp1/items')).items.filter(x => x.when).map(x => x.id));
    await evalJs(`document.getElementById('sgPlanIt').click()`);
    await sleep(2600);
    const afterPlan = (await asApi(A, 'GET', '/api/space/sp1/items')).items;
    const whenOf = (id) => { const w = (afterPlan.find(x => x.id === id) || {}).when; return w ? `${w.date} ${w.time}` : ''; };
    check(whenOf(lateShow.id) === `${planDay} 20:45` && whenOf(supper.id) === `${planDay} 17:30`, `and it moved neither: ${whenOf(lateShow.id)} · ${whenOf(supper.id)}`);
    check(afterPlan.some(x => x.when && x.when.date === planDay && !hadWhen.has(x.id)), 'while the rest of the plan went on');
    // Leave the calendar as it was found.
    for (const x of afterPlan.filter(x => x.when && !hadWhen.has(x.id))) await asApi(A, 'POST', `/api/item/${x.id}/when`, { clear: true });
    await asApi(A, 'DELETE', `/api/item/${lateShow.id}`);
    await asApi(A, 'DELETE', `/api/item/${supper.id}`);
    await evalJs(`document.getElementById('tabSug').click()`);
    await sleep(600);
    check(await visible('#kindNav') && !(await evalJs(`!!document.querySelector('.sg')`)), 'and the button puts the list back');

    // The Claude row: the address to paste into Claude, and a code for a browser
    // that is not signed in here.
    await evalJs(`document.getElementById('btnMe').click()`);
    await sleep(700);
    check(await visible('#claudeRow'), 'the account sheet has a Claude row');
    await evalJs(`document.getElementById('claudeRow').click()`);
    await sleep(800);
    check(await visible('#claudeSheet') && !(await visible('#meSheet')), 'which opens a sheet of its own');
    check(/\/mcp$/.test(await evalJs(`document.getElementById('clUrl').innerText`)), 'with the address to paste');
    await evalJs(`document.getElementById('clCode').click()`);
    await sleep(700);
    check(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(await evalJs(`(document.querySelector('#clCodeOut b') || {}).innerText || ''`)), 'and a code when asked');
    await evalJs(`document.getElementById('clClose').click()`);
    await sleep(400);

    const fresh = (await asApi(A, 'POST', '/api/space', { name: '' })).space;
    const inv = await asApi(A, 'POST', `/api/space/${fresh.id}/invite`, {});
    await S('Network.clearBrowserCookies');
    await S('Page.navigate', { url: `${BASE}/?invite=${inv.code}` });
    await sleep(2200);
    check(await visible('#joinForm') && await visible('#joinGo'), 'an invite shows a name and a Join button');
    const authText = await evalJs(`document.getElementById('scr-auth').innerText`);
    check(/Andrew wants to keep a list/.test(authText) && /What should Andrew call you/.test(authText), 'saying who sent it');
    check(!/not configured/.test(authText) && !(await visible('#authNote')), 'and no dead end');
    // Tapping Join with no name asks again and spends nothing.
    await evalJs(`document.getElementById('joinGo').click()`);
    await sleep(400);
    check(await visible('#joinForm'), 'no name, no join');
    await evalJs(`(() => { const i = document.getElementById('joinName'); i.value = 'Rowan';
      i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evalJs(`document.getElementById('joinGo').click()`);
    await sleep(2200);
    check(!(await visible('#scr-auth')) && await visible('#scr-space'), 'one tap and he is in the list');
    check(await evalJs(`document.getElementById('spaceTitle').innerText`) === 'Andrew', 'titled from his side');
    check(!/invite=/.test(await evalJs('location.search')), 'and the spent code is gone from the address');
    check((await asApi(A, 'GET', '/api/state')).spaces.some(s => s.id === fresh.id && s.title === 'Rowan'), 'Andrew sees it as his list with Rowan');
    // A used link says so, and where to go.
    await S('Network.clearBrowserCookies');
    await S('Page.navigate', { url: `${BASE}/?invite=${inv.code}` });
    await sleep(2000);
    check(!(await visible('#joinForm')) && /already been used\. Ask whoever sent it/.test(await evalJs(`document.getElementById('authNote').innerText`)),
      'a spent invite says so');

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
