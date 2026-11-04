// HTTP surface. Everything is JSON except the shell.
//
// The rule that holds the whole app together: a route resolves the space and the
// item from the SESSION plus a membership check, never from an id the caller
// asserts about themselves. There is no route that takes a user id. Ported from
// the workout app along with the auth, for the same reason — it is the shape that
// makes "one handler forgot to check" impossible rather than unlikely.
const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('./../store');
const { state } = store;
const auth = require('./auth');
const cfaccess = require('./cfaccess');
const SP = require('./spaces');
const items = require('./items');
const modules = require('./modules');
const kinds = require('./kinds');
const watch = require('./watch');
const invites = require('./invites');
const square = require('./square');
const magic = require('./magic');
const push = require('./push');
const geo = require('./geo');
const groups = require('./groups');

const PUBLIC = path.join(__dirname, '..', 'public');
const STAMP = Date.now().toString(36);

/* ── identity ───────────────────────────────────────────────────────────── */

function userFrom(req) {
  const uid = auth.verify(auth.readCookie(req.headers.cookie));
  if (!uid) return null;
  return state.users[uid] || null;
}

function upsertUser(claims, invite) {
  let u = state.users[claims.id];
  if (!u) {
    // Linking a second sign-in door to one person by verified email, exactly as
    // the workout app does — safe only because both sources verify the address.
    const linked = Object.values(state.users).find(x => x.email === claims.email);
    if (linked) {
      state.users[claims.id] = linked;
      linked.alsoKnownAs = [...new Set([...(linked.alsoKnownAs || []), claims.id])];
      u = linked;
    }
  }
  if (!u) {
    // No invite, no account. Nothing is written for a stranger.
    if (!invite) return null;
    u = {
      id: claims.id,
      email: claims.email,
      name: claims.name,
      picture: claims.picture || null,
      via: claims.via,
      // Reserved for the Square bridge. Null until an identity claim exists to
      // fill it — see lib/square.js.
      square: null,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    state.users[claims.id] = u;
  } else {
    u.email = claims.email;
    u.name = u.name || claims.name;
    if (claims.picture) u.picture = claims.picture;
    u.lastSeen = Date.now();
  }
  store.save();
  return u;
}

const nameOf = (uid) => {
  const u = state.users[uid];
  return u ? (u.name || u.email) : 'Someone';
};

const personWire = (uid) => {
  const u = state.users[uid];
  return { id: uid, name: nameOf(uid), picture: u ? u.picture || null : null };
};

/* ── the wire ───────────────────────────────────────────────────────────── */

const spaceById = (id) => (state.spaces || []).find(s => s.id === id) || null;

// A space, as one person sees it. The title is computed per viewer — that is the
// whole conceit of the app and it costs one function.
function spaceWire(space, uid) {
  const mine = SP.visibleIn(state.items, space, uid, state.spaces);
  const open = mine.filter(i => !i.done);
  return {
    id: space.id,
    title: SP.titleFor(space, uid, nameOf),
    name: space.name || null,
    isPair: SP.isPair(space),
    members: SP.memberIds(space).map(personWire),
    counts: { open: open.length, done: mine.length - open.length },
    createdAt: space.createdAt,
  };
}

// Look a film or show up and write what came back onto the item, through the
// module gate like everything else. Returns whether anything landed.
//
// Only the BACKFILL calls this now. Adding a film opens the chooser instead, so
// nothing guesses while somebody is standing there who could just be asked —
// and a guess made in front of you is the one you are most likely to notice and
// least likely to be able to correct.
async function fillWatch(it, { fresh = false } = {}) {
  const kind = kinds.clean(it.kind);
  if (!kinds.MEDIA_KINDS.includes(kind) || !watch.configured()) return false;
  if (it.mod && it.mod.watch && !fresh) return false;
  const got = await watch.lookup(kind, it.title, { fresh });
  if (!got) return false;
  it.mod = modules.cleanMods({ ...it.mod, watch: got });
  return !!(it.mod && it.mod.watch);
}

function itemWire(it, uid) {
  // A place resolves to coordinates lazily and out of band, so the wire carries
  // whatever is known NOW and the map fills in as lookups land. An item whose
  // place hasn't resolved yet simply isn't on the map — which is honest, and much
  // better than a guessed pin.
  const place = it.mod && it.mod.place;
  const fix = place && place.lat === null ? geo.cached(place.name) : null;
  return {
    ...it,
    // Normalised on the way OUT rather than migrated in place: every item
    // written before kinds existed reads as a plain thing, no rewrite of the
    // store, and nothing downstream ever has to defend against `undefined`.
    kind: kinds.clean(it.kind),
    mod: fix && fix.lat !== null
      ? { ...it.mod, place: { ...place, lat: fix.lat, lon: fix.lon } }
      : it.mod,
    author: personWire(it.authorId),
    doneByName: it.doneBy ? nameOf(it.doneBy) : null,
    // Every item written before plans existed reads as unplanned, not undefined.
    when: it.when || null,
    plannedBy: it.plannedBy || null,
    plannedByName: it.plannedBy ? nameOf(it.plannedBy) : null,
    // Whether it arrived from one of the author's OTHER spaces — the client says
    // so, because "Andrew wants to do this with anyone" reads differently from
    // something written here.
    fromElsewhere: false,
    mine: it.authorId === uid,
    canEdit: SP.canEdit(it, uid),
  };
}

function wire(uid) {
  const u = state.users[uid];
  const mySpaces = SP.spacesOf(state.spaces, uid);
  return {
    me: u ? { id: uid, name: u.name, email: u.email, picture: u.picture || null, square: u.square || null } : null,
    spaces: mySpaces.map(s => spaceWire(s, uid)),
    modules: modules.manifest(),
    kinds: kinds.manifest(),
    // How many people you could make something public to — the number that makes
    // `public` mean something concrete rather than vague.
    circle: SP.circleOf(state.spaces, uid).size,
    push: { key: push.publicKey(), subscribed: push.devicesOf(u).length > 0 },
  };
}

module.exports = function mount(app) {
  app.use(express.json({ limit: '256kb' }));

  app.use(async (req, res, next) => {
    let u = userFrom(req);
    if (!u && cfaccess.configured()) {
      try {
        const claims = await cfaccess.identify(req);
        // Access proves who you are; it does not grant an account here. A first
        // arrival still needs an invite, same as everyone.
        if (claims) {
          u = state.users[claims.id]
            || Object.values(state.users).find(x => x.email === claims.email)
            || null;
          if (u) res.setHeader('Set-Cookie', auth.cookieHeader(auth.sign(u.id), { secure: req.secure }));
        }
      } catch (e) { console.error('cfaccess:', e.message); }
    }
    if (u) { req.user = u; u.lastSeen = Date.now(); }
    next();
  });

  const guard = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'sign in' });
    next();
  };
  // NOT /api/invite — looking one up has to work signed out, because the link is
  // what a stranger opens before they have an account. Creating one is
  // POST /api/space/:id/invite, which is guarded with everything else under
  // /api/space.
  for (const p of ['/api/state', '/api/space', '/api/spaces', '/api/item', '/api/square', '/api/push']) {
    app.use(p, guard);
  }

  // Resolve a space AND membership in one step, so no handler below ever sees a
  // space the caller is not in.
  function mySpace(req, res) {
    const s = spaceById(req.params.spaceId || req.params.id);
    if (!s || !SP.isMember(s, req.user.id)) { res.status(404).json({ error: 'not found' }); return null; }
    return s;
  }

  /* ── auth ─────────────────────────────────────────────────────────────── */

  app.post('/api/auth/google', async (req, res) => {
    const b = req.body || {};
    let claims;
    try {
      claims = await auth.verifyGoogleToken(b.credential);
    } catch (e) {
      console.error('auth: token rejected —', e.message);
      return res.status(401).json({ error: 'could not verify that sign-in' });
    }
    if (!claims) return res.status(401).json({ error: 'could not verify that sign-in' });
    const id = `google:${claims.id}`;

    const known = state.users[id] || Object.values(state.users).find(x => x.email === claims.email);
    let inv = null;
    if (!known) {
      const check = invites.check(state, b.invite);
      if (!check.ok) {
        return res.status(403).json({ error: check.why, needsInvite: true });
      }
      inv = check.invite;
    }

    const u = upsertUser({ ...claims, id, via: 'google' }, inv);
    if (!u) return res.status(403).json({ error: 'You need an invite to join.', needsInvite: true });
    if (inv) joinViaInvite(u, inv);

    res.setHeader('Set-Cookie', auth.cookieHeader(auth.sign(u.id), { secure: req.secure }));
    res.json({ ok: true });
  });

  // Redeeming puts you where the invite pointed: into its space, or into a fresh
  // pair with whoever sent it.
  function joinViaInvite(u, inv) {
    invites.redeem(state, inv.code, u.id);
    const target = inv.spaceId ? spaceById(inv.spaceId) : null;
    if (target) {
      if (!SP.isMember(target, u.id) && SP.memberIds(target).length < SP.MAX_MEMBERS) {
        target.memberIds.push(u.id);
      }
    } else if (inv.createdBy && inv.createdBy !== u.id) {
      state.spaces.push({
        id: store.nextId('sp'),
        name: null,
        memberIds: [inv.createdBy, u.id],
        createdBy: inv.createdBy,
        createdAt: Date.now(),
      });
    }
    store.save();
  }

  app.get('/api/auth/me', async (req, res) => {
    const u = req.user;
    res.json({
      status: u ? 'in' : 'anon',
      clientId: cfaccess.configured() ? null : auth.clientId(),
      via: cfaccess.configured() ? 'cloudflare' : 'google',
      me: u ? { name: u.name, email: u.email, picture: u.picture || null } : null,
    });
  });

  // Setup helper, same as the workout app's: the Access AUD tag is buried in the
  // Zero Trust dashboard and moves between releases, but Access puts it in every
  // assertion it signs — so the easiest place to read it is here. Public by
  // necessity (needed BEFORE anything is configured) and safe by construction:
  // every value echoed came out of a token the caller sent, and knowing an AUD tag
  // forges nothing because the signature is still checked.
  app.get('/api/auth/access-info', (req, res) => {
    const seen = cfaccess.peek(req);
    const cfg = require('./config');
    res.json({
      accessInFront: !!seen,
      seen,
      configured: { cfAccessTeam: !!cfg.get('cfAccessTeam', null), cfAccessAud: !!cfg.get('cfAccessAud', null) },
      hint: seen
        ? 'Copy `aud[0]` into cfAccessAud, and the middle of `iss` into cfAccessTeam.'
        : 'No Cloudflare Access assertion on this request — either Access is not in '
          + 'front of this hostname, or you reached the origin directly.',
    });
  });

  // Redeem a sign-in link. There is deliberately NO route that mints one — links
  // come from tools/link.js, which needs shell access to the box. So this can be
  // hit by anyone, and all they can do is present a token they would have to have
  // been given.
  app.get('/login/:token', (req, res) => {
    const used = magic.usedSet(state);
    const r = magic.verify(req.params.token, { used });
    const u = r.ok ? state.users[r.uid] : null;
    if (!r.ok || !u) {
      return res.status(400).type('html').send(page(
        r.ok ? 'That link is for an account that no longer exists.' : r.why));
    }
    magic.spend(state, r.nonce);
    u.lastSeen = Date.now();
    store.save();
    res.setHeader('Set-Cookie', auth.cookieHeader(auth.sign(u.id), { secure: req.secure }));
    res.redirect(302, '/');
  });

  /* ── redeeming a short code ───────────────────────────────────────────
     A GET must NOT spend the code, and that is a correctness rule rather than a
     nicety: every messaging app fetches a URL to build its preview card, so a
     link sent over iMessage or WhatsApp would be burned by the crawler before
     the person it was meant for ever tapped it. It also means whoever minted it
     can safely check the link works before sending — which is the first thing
     anybody does.

     So GET shows who it is for and spends nothing; the POST behind the button
     does the work. One-shot is preserved exactly; only the trigger moves. */

  app.get('/l/:code', (req, res) => {
    const check = magic.peekCode(state, req.params.code);
    const u = check.ok ? state.users[check.uid] : null;
    if (!check.ok || !u) {
      return res.status(400).type('html').send(page(
        check.ok ? 'That code is for an account that no longer exists.' : check.why));
    }
    res.type('html').send(confirmPage(req.params.code, u.name || 'you'));
  });

  app.post('/l/:code', (req, res) => {
    const r = magic.redeemCode(state, req.params.code);
    const u = r.ok ? state.users[r.uid] : null;
    if (!r.ok || !u) {
      return res.status(400).type('html').send(page(
        r.ok ? 'That code is for an account that no longer exists.' : r.why));
    }
    u.lastSeen = Date.now();
    store.save();
    res.setHeader('Set-Cookie', auth.cookieHeader(auth.sign(u.id), { secure: req.secure }));
    res.redirect(302, '/');
  });

  // A plain form, no JavaScript — this page has to work before the app has
  // loaded anything, and a crawler that follows the link finds only a button.
  const confirmPage = (code, name) => `<!doctype html><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>Do With</title>
    <body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#17131a;
      color:#f4eee9;font:16px/1.6 -apple-system,system-ui,sans-serif;text-align:center;padding:24px">
    <div style="max-width:20em">
      <p style="font:600 36px/1.1 Georgia,serif;margin:0 0 10px">Do&nbsp;With</p>
      <p style="color:#948a9c;margin:0 0 26px">Sign in as <b style="color:#f4eee9">${esc(name)}</b>?</p>
      <form method="POST" action="/l/${encodeURIComponent(code)}">
        <button type="submit" style="width:100%;padding:15px;border:0;border-radius:13px;
          background:#f2845c;color:#2a1206;font:600 16px/1 inherit;cursor:pointer">
          Yes, that's me</button>
      </form>
      <p style="color:#6b6274;font-size:13px;margin-top:22px">
        This link works once. Opening it does nothing until you tap.</p>
    </div>`;

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const page = (msg) => `<!doctype html><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Do With</title>
    <body style="margin:0;display:grid;place-items:center;height:100vh;background:#17131a;
      color:#f4eee9;font:16px/1.6 -apple-system,system-ui,sans-serif;text-align:center;padding:24px">
    <div><p style="font:600 34px/1.1 Georgia,serif;margin:0 0 14px">Do&nbsp;With</p>
    <p style="color:#948a9c;max-width:22em">${String(msg).replace(/[<>&]/g, '')}</p></div>`;

  app.post('/api/auth/signout', (_req, res) => {
    res.setHeader('Set-Cookie', auth.clearHeader());
    res.json({ status: 'anon' });
  });

  // What an invite is for, before you sign in — so the link says "Linnea invited
  // you" rather than dropping you on a bare Google button.
  app.get('/api/invite/:code', (req, res) => {
    const check = invites.check(state, req.params.code);
    if (!check.ok) return res.status(404).json({ ok: false, why: check.why });
    const inv = check.invite;
    const from = state.users[inv.createdBy];
    res.json({
      ok: true,
      from: from ? { name: from.name || from.email, picture: from.picture || null } : null,
      space: inv.spaceId && spaceById(inv.spaceId)
        ? { name: spaceById(inv.spaceId).name || null }
        : null,
      note: inv.note,
    });
  });

  /* ── state ────────────────────────────────────────────────────────────── */

  app.get('/api/state', (req, res) => res.json(wire(req.user.id)));

  /* ── spaces ───────────────────────────────────────────────────────────── */

  app.post('/api/space', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').slice(0, SP.NAME_MAX).trim();
    const s = {
      id: store.nextId('sp'),
      name: name || null,
      memberIds: [req.user.id],
      createdBy: req.user.id,
      createdAt: Date.now(),
    };
    state.spaces.push(s);
    store.save();
    res.json({ space: spaceWire(s, req.user.id), state: wire(req.user.id) });
  });

  app.patch('/api/space/:id', (req, res) => {
    const s = mySpace(req, res); if (!s) return;
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = String(b.name || '').slice(0, SP.NAME_MAX).trim();
      s.name = name || null;
    }
    store.save();
    res.json({ space: spaceWire(s, req.user.id), state: wire(req.user.id) });
  });

  // Leaving, not deleting. Someone else's list does not stop existing because you
  // stepped out of it, and the things you wrote there were written for them too.
  app.post('/api/space/:id/leave', (req, res) => {
    const s = mySpace(req, res); if (!s) return;
    s.memberIds = SP.memberIds(s).filter(m => m !== req.user.id);
    if (!s.memberIds.length) {
      state.spaces = state.spaces.filter(x => x.id !== s.id);
      state.items = state.items.filter(i => i.spaceId !== s.id);
    }
    store.save();
    res.json(wire(req.user.id));
  });

  app.get('/api/space/:id/items', (req, res) => {
    const s = mySpace(req, res); if (!s) return;
    const uid = req.user.id;
    const list = SP.visibleIn(state.items, s, uid, state.spaces)
      .map(it => ({ ...itemWire(it, uid), fromElsewhere: it.spaceId !== s.id }))
      .sort((a, b) => (a.done === b.done ? b.createdAt - a.createdAt : a.done ? 1 : -1));
    // Derived from what THIS person can see, so a tag living only on somebody's
    // private items makes a group on their screen and none at all on yours.
    const open = list.filter(i => !i.done);
    res.json({
      space: spaceWire(s, uid),
      items: list,
      // `groups` stays: it is the richer breakdown, open AND done per kind, and
      // the nav will want "4 to do · 3 done" sooner or later. `ungrouped` and
      // `grouped` have gone — they answered "is a group list worth showing",
      // and there is no group list to show or hide any more.
      groups: groups.groupsOf(open),
      // One per kind, empty ones included — the bottom nav is furniture and has
      // to be in the same place every time you look. Counted from the SAME
      // already-filtered list as the groups, so a kind living only on somebody's
      // private items raises a count on their screen and none at all on yours.
      tabs: kinds.tabs(open),
    });
  });

    // The shortlist, for a person to choose from. Read-only: it writes nothing,
  // decides nothing, and is the whole reason the app no longer has to guess
  // which of five films called "Obsession" you meant.
  app.get('/api/watch/search', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'sign in' });
    if (!watch.configured()) return res.json({ ok: false, why: 'no tmdb key', results: [] });
    const kind = kinds.clean(req.query.kind);
    if (!kinds.MEDIA_KINDS.includes(kind)) return res.json({ ok: true, results: [] });
    try {
      res.json({ ok: true, results: await watch.search(kind, String(req.query.q || '')) });
    } catch (e) {
      res.json({ ok: false, why: e.message, results: [] });
    }
  });

  // Pin an item to the thing you picked. Or `clear` to let go of it again —
  // getting it wrong has to be undoable, or choosing is a trap.
  app.post('/api/item/:id/watch', async (req, res) => {
    const it = myItem(req, res, 'edit'); if (!it) return;
    const body = req.body || {};
    if (body.clear) {
      if (it.mod && it.mod.watch) delete it.mod.watch;
      store.save();
      return res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
    }
    const kind = kinds.clean(it.kind);
    if (!kinds.MEDIA_KINDS.includes(kind)) return res.status(400).json({ error: 'not a film or show' });
    const got = await watch.detail(kind, body.tmdbId);
    if (!got) return res.status(404).json({ error: 'could not fetch that one' });
    // Through the gate like everything else — a chosen id is still TMDB's data.
    it.mod = modules.cleanMods({ ...it.mod, watch: got });
    store.save();
    res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
  });

  // Posters, years and streaming, for everything that still wants them.
  //
  // Backfills a whole list in one call. Already-resolved items are left alone,
  // so pressing it twice costs nothing, and a title TMDB has never heard of is
  // remembered as a miss rather than asked about forever.
  app.post('/api/space/:id/watch', async (req, res) => {
    const s = mySpace(req, res); if (!s) return;
    if (!watch.configured()) return res.json({ ok: false, why: 'no tmdb key', found: 0, asked: 0 });
    // Everything, not just what has never been tried. A backfill is a button
    // you press on purpose — it would be strange for it to skip exactly the
    // ones that failed, and where something streams genuinely changes.
    const mine = SP.visibleIn(state.items, s, req.user.id, state.spaces)
      .filter(it => kinds.MEDIA_KINDS.includes(kinds.clean(it.kind)));
    let found = 0;
    for (const it of mine.slice(0, 60)) {
      if (await fillWatch(it, { fresh: true })) found++;
    }
    if (found) store.save();
    res.json({ ok: true, asked: mine.length, found, state: wire(req.user.id) });
  });

/* ── invites ──────────────────────────────────────────────────────────── */

  app.post('/api/space/:id/invite', (req, res) => {
    const s = mySpace(req, res); if (!s) return;
    const inv = invites.create(state, {
      spaceId: s.id, createdBy: req.user.id, note: (req.body || {}).note,
    });
    store.save();
    res.json({ code: inv.code, expiresAt: inv.expiresAt });
  });

  /* ── items ────────────────────────────────────────────────────────────── */

  app.post('/api/space/:spaceId/item', (req, res) => {
    const s = mySpace(req, res); if (!s) return;
    const it = items.cleanItem(req.body || {}, {
      id: store.nextId('it'),
      // From the session and the membership check. Never from the body.
      authorId: req.user.id,
      spaceId: s.id,
    });
    if (!it) return res.status(400).json({ error: 'needs a title' });
    state.items.push(it);
    store.save();
    res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
    // After the response, and never awaited: a slow push service must not make
    // adding something feel slow. The audience comes from lib/spaces.js, so a
    // private item reaches nobody — see lib/push.js.
    push.itemAdded(it, listTitle).catch(e => console.error('push:', e.message));
  });

  // The list as the person being told sees it — "to do with Andrew".
  function listTitle(spaceId, forUid) {
    const sp = spaceById(spaceId);
    return sp ? SP.titleFor(sp, forUid, nameOf) : null;
  }

  // One resolver for every single-item route: it must EXIST, you must be able to
  // SEE it, and for a write you must be allowed to make that particular change.
  function myItem(req, res, need = 'see') {
    const it = (state.items || []).find(x => x.id === req.params.id);
    const uid = req.user.id;
    // A 404 rather than a 403 when you cannot see it: "this exists but is not
    // yours" is itself a disclosure, and here it would leak that a private item
    // exists at all.
    if (!it || !SP.canSee(it, uid, state.spaces)) { res.status(404).json({ error: 'not found' }); return null; }
    if (need === 'edit' && !SP.canEdit(it, uid)) { res.status(403).json({ error: 'not yours to change' }); return null; }
    if (need === 'complete' && !SP.canComplete(it, uid, state.spaces)) {
      res.status(403).json({ error: 'not yours to tick off' }); return null;
    }
    return it;
  }

  app.patch('/api/item/:id', (req, res) => {
    const it = myItem(req, res, 'edit'); if (!it) return;
    const wasKind = it.kind;
    const wasTitle = it.title;
    if (!items.applyPatch(it, req.body || {})) return res.status(400).json({ error: 'needs a title' });
    // Classified as a film, or renamed — either way what was looked up before
    // is about something else now.
    if (it.kind !== wasKind || it.title !== wasTitle) {
      if (it.mod && it.mod.watch) delete it.mod.watch;
    }
    store.save();
    res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
  });

  app.post('/api/item/:id/done', (req, res) => {
    const it = myItem(req, res, 'complete'); if (!it) return;
    const was = !!it.done;
    items.setDone(it, (req.body || {}).done !== false, req.user.id);
    store.save();
    res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
    // Only finishing is news. Un-ticking is a correction, not an occasion.
    if (!was && it.done) push.itemDone(it, req.user.id, listTitle).catch(e => console.error('push:', e.message));
  });

  // Put it on a day, or take it off one. The same right as ticking off — anyone
  // who can see it — because planning is part of doing it together.
  app.post('/api/item/:id/when', (req, res) => {
    const it = myItem(req, res, 'complete'); if (!it) return;
    const b = req.body || {};
    const before = it.when && it.when.date;
    if (!items.setWhen(it, b.clear ? null : b, req.user.id)) {
      return res.status(400).json({ error: 'needs a real date, YYYY-MM-DD' });
    }
    store.save();
    res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
    // Only when the DAY changes: nudging the time back and forth is fiddling,
    // and taking it off the calendar is not something to wake anybody for.
    if (it.when && it.when.date !== before) {
      push.itemPlanned(it, req.user.id, listTitle).catch(e => console.error('push:', e.message));
    }
  });

  app.delete('/api/item/:id', (req, res) => {
    const it = myItem(req, res, 'edit'); if (!it) return;
    state.items = state.items.filter(x => x.id !== it.id);
    store.save();
    res.json(wire(req.user.id));
  });

  // Resolve the place names in a list that don't have coordinates yet. Scoped to
  // items you can actually see, so this cannot be used to geocode by proxy or to
  // discover that a private item exists.
  app.post('/api/space/:id/geocode', async (req, res) => {
    const sp = mySpace(req, res); if (!sp) return;
    const names = [...new Set(
      SP.visibleIn(state.items, sp, req.user.id, state.spaces)
        .map(i => i.mod && i.mod.place)
        .filter(pl => pl && pl.lat === null)
        .map(pl => pl.name),
    )].slice(0, 10);          // a screenful at a time; the queue is one a second
    let found = 0;
    for (const n of names) {
      const hit = await geo.lookup(n);
      if (hit && hit.lat !== null) found++;
    }
    res.json({ asked: names.length, found, space: spaceWire(sp, req.user.id) });
  });

  /* ── nudges ───────────────────────────────────────────────────────────── */

  app.post('/api/push/subscribe', (req, res) => {
    if (!push.addSub(req.user, (req.body || {}).subscription)) {
      return res.status(400).json({ error: 'bad subscription' });
    }
    res.json(wire(req.user.id));
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    push.removeSub(req.user, (req.body || {}).endpoint);
    res.json(wire(req.user.id));
  });

  // Prove the chain without waiting for somebody else to add something. There is
  // no other way to find out that it does not work.
  app.post('/api/push/test', async (req, res) => {
    const sent = await push.sendTo(req.user, {
      title: 'Do With', body: 'Nudges are working', detail: 'This is a test',
    });
    res.json({ sent });
  });

  /* ── the Square bridge ────────────────────────────────────────────────────
     Plumbing only. `status` is honest about what is not built; `import` refuses
     in a way a UI can quote directly. See lib/square.js. */

  app.get('/api/square/status', (_req, res) => res.json(square.status()));

  app.post('/api/square/import', (_req, res) => {
    const r = square.importable();
    res.status(501).json(r);
  });

  /* ── shell ────────────────────────────────────────────────────────────── */

  /* ── share in ─────────────────────────────────────────────────────────
     The one load-bearing feature: a list dies because adding to it was three
     taps too many, not because nobody cared.

     GET, not POST, and deliberately: a GET target needs no multipart handling,
     and — more importantly — the same URL is then reachable from an iOS Shortcut,
     a bookmarklet, or a link somebody sends you. **iOS Safari has no Web Share
     Target API at all**, so the manifest entry only serves Android and desktop
     Chrome; on a phone the Shortcut is the real path, and it hits this. One route,
     every way in.

     The shell is served as-is; app.js reads the query and opens the sheet. That
     way a signed-out arrival still lands on sign-in with the share preserved in
     the URL, rather than being dropped on the floor. */
  app.get('/share', (_req, res) => res.type('html').send(shell()));

  function shell() {
    let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    return html
      .replace('href="style.css"', `href="style.css?v=${STAMP}"`)
      .replace(/src="\/js\//g, `src="/js-${STAMP}/`);
  }

  app.get('/', (_req, res) => res.type('html').send(shell()));

  app.use((req, _res, next) => {
    const m = req.url.match(/^\/js-[a-z0-9]+\//);
    if (m) req.url = `/js/${req.url.slice(m[0].length)}`;
    next();
  });

  app.use(express.static(PUBLIC, { maxAge: '1h' }));
};

module.exports.wire = wire;
