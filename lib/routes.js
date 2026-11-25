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
const pleasure = require('./pleasure');
const questions = require('./questions');
const places = require('./places');
const hours = require('./hours');
const recipe = require('./recipe');
const kitchen = require('./kitchen');
const swap = require('./swap');
const fetchpage = require('./fetchpage');
const img = require('./img');
const timers = require('./timers');
const config = require('./config');
const oauth = require('./oauth');
const weather = require('./weather');
const placefit = require('./placefit');
const connector = require('./connector');

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

// Who may correct other people's items. From deployment config and nowhere
// else — there is no route that grants it, so shell access to the box is the
// credential, the same as minting a sign-in link. Read live, so adding or
// removing somebody needs no restart.
//
// What it buys is narrow on purpose: see SP.canEdit. Editing what you can
// already see; never seeing more.
const isAdmin = (uid) => {
  const list = config.get('admins', []);
  return Array.isArray(list) && !!uid && list.includes(uid);
};

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
  // What is waiting, per kind, for the card on the shelf of lists. From the
  // same already-filtered list, so a private recipe raises the number on its
  // author's card and nobody else's.
  const byKind = {};
  for (const i of open) { const k = kinds.clean(i.kind); byKind[k] = (byKind[k] || 0) + 1; }
  return {
    id: space.id,
    title: SP.titleFor(space, uid, nameOf),
    name: space.name || null,
    isPair: SP.isPair(space),
    members: SP.memberIds(space).map(personWire),
    counts: { open: open.length, done: mine.length - open.length, byKind },
    // Today's question, for the shelf: the streak and whether yours is waiting.
    // A number and a flag — no text, no kind, so never a Spicy question.
    question: SP.isPair(space) ? questionSummary(space, uid) : null,
    createdAt: space.createdAt,
  };
}

function questionSummary(space, uid) {
  const other = SP.memberIds(space).find(m => m !== uid);
  const rec = (state.questions || {})[pleasure.pairKey(uid, other)];
  return rec ? questions.summary(rec, uid, other, questions.dateIn(rec.zone, Date.now())) : null;
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

// The module bag as a screen should get it: a lazily-resolved pin filled in,
// and streaming tiers folded into their service even on a film looked up
// before that rule existed (watch.dedupeServices).
function wireMod(it, place, fix) {
  let mod = it.mod;
  if (fix && fix.lat !== null) mod = { ...mod, place: { ...place, lat: fix.lat, lon: fix.lon } };
  const w = mod && mod.watch;
  if (w && Array.isArray(w.providers)) {
    const providers = watch.dedupeServices(w.providers);
    if (providers.length !== w.providers.length) mod = { ...mod, watch: { ...w, providers } };
  }
  return mod;
}

function choicesOf(it) {
  const ings = it.mod && it.mod.recipe && it.mod.recipe.ingredients;
  if (!ings) return null;
  const out = {};
  ings.forEach((g, i) => { const a = kitchen.alternatives(g.name || g.text); if (a.length) out[i] = a; });
  return Object.keys(out).length ? out : null;
}

function swapsWire(it, uid) {
  const sw = swap.live(it);
  if (!sw) return null;
  return Object.fromEntries(Object.entries(sw).map(([k, s]) => {
    const by = s.by && SP.nameable(state.spaces, uid, s.by) ? s.by : null;
    return [k, { ...s, by, byName: by ? nameOf(by) : null }];
  }));
}

// `admin` is passed in by the list route, which wires dozens of items at once
// and has no reason to read the config file once per item.
function itemWire(it, uid, admin = isAdmin(uid)) {
  // A place resolves to coordinates lazily and out of band, so the wire carries
  // whatever is known NOW and the map fills in as lookups land. An item whose
  // place hasn't resolved yet simply isn't on the map — which is honest, and much
  // better than a guessed pin.
  const place = it.mod && it.mod.place;
  const fix = place && place.lat === null ? geo.cached(place.name) : null;
  // Whose idea it was, as far as this viewer may know — see SP.ideaOf. The
  // shelf is split by it, so it is always a person, never null.
  const idea = SP.ideaOf(it, uid, state.spaces);
  const editor = it.editedBy && SP.nameable(state.spaces, uid, it.editedBy) ? it.editedBy : null;
  return {
    ...it,
    // Normalised on the way OUT rather than migrated in place: every item
    // written before kinds existed reads as a plain thing, no rewrite of the
    // store, and nothing downstream ever has to defend against `undefined`.
    kind: kinds.clean(it.kind),
    mod: wireMod(it, place, fix),
    author: personWire(it.authorId),
    doneByName: it.doneBy ? nameOf(it.doneBy) : null,
    // Every item written before plans existed reads as unplanned, not undefined.
    when: it.when || null,
    plannedBy: it.plannedBy || null,
    visit: it.visit || null,
    // What is going in instead of which ingredients, still pointing at the
    // line they were made for (swap.live). Whose hand: only a name this viewer
    // already knows, the editedBy rule.
    swaps: swapsWire(it, uid),
    // The lines that offer a choice ("gluten free flour or cornstarch"), and
    // their options, so the page can ask which one (kitchen.alternatives).
    choices: choicesOf(it),
    plannedByName: it.plannedBy ? nameOf(it.plannedBy) : null,
    // Whether it arrived from one of the author's OTHER spaces — the client says
    // so, because "Andrew wants to do this with anyone" reads differently from
    // something written here.
    fromElsewhere: false,
    mine: it.authorId === uid,
    // The server's answers, so the sheet never works a right out for itself.
    canEdit: SP.canEdit(it, uid, state.spaces, { admin }),
    canSetVisibility: SP.canSetVisibility(it, uid, state.spaces, { admin }),
    canCredit: SP.canCredit(it, uid, it.authorId, state.spaces, { admin }),
    // Somebody other than the author changed the words. Said out loud, because
    // the row still carries the author's name and it would otherwise be quietly
    // putting words in their mouth.
    // Only a name this viewer already knows: an admin's correction to a public
    // wish must not introduce them to somebody from one of its author's other
    // lists. `...it` above carries the raw ids, so both are overridden here.
    editedBy: editor,
    editedByName: editor && editor !== it.authorId ? nameOf(editor) : null,
    ideaBy: idea,
    ideaByName: nameOf(idea),
    ideaMine: idea === uid,
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
    // Whose kitchens you may open: yours first, then pair partners'. See
    // lib/kitchen.js — a group list does not open anybody's fridge.
    kitchens: kitchen.kitchensFor(uid, state.spaces).map(id => ({ id, name: nameOf(id) })),
    // Whether a recipe page may offer to suggest a swap: only with a key.
    swap: { suggest: swap.available() },
    push: { key: push.publicKey(), subscribed: push.devicesOf(u).length > 0 },
  };
}

// What the Claude connector sees: exactly what this person's own screens would
// — the same spaceWire/itemWire over SP.visibleIn — and nothing from the rose,
// today's question or anybody's kitchen (lib/connector.js says why).
function connectorView(uid) {
  // A day is a calendar date in the person's own zone; the first pair record
  // that knows one says it.
  const rec = Object.entries(state.questions || {}).find(([k, r]) => k.split('|').includes(uid) && r && r.zone);
  const zone = (rec && rec[1].zone) || 'UTC';
  const ks = kinds.manifest();
  return {
    uid,
    me: nameOf(uid),
    zone,
    today: questions.dateIn(zone, Date.now()),
    kinds: ks,
    kindOf: (id) => ks.find(k => k.id === id) || ks[0],
    lists: SP.spacesOf(state.spaces, uid).map((s) => {
      const w = spaceWire(s, uid);
      return {
        // "Linnea" on the phone sits under the words "To do with"; here it has to say them.
        id: w.id, title: w.name || (w.title === 'Just you' ? w.title : `To do with ${w.title}`), name: w.name, members: w.members, counts: w.counts,
        items: SP.visibleIn(state.items, s, uid, state.spaces)
          .map(it => ({ ...itemWire(it, uid, false), fromElsewhere: it.spaceId !== s.id })),
      };
    }),
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
  for (const p of ['/api/state', '/api/space', '/api/spaces', '/api/item', '/api/square', '/api/push', '/api/place',
    '/api/recipe', '/api/kitchen', '/api/timer', '/api/img', '/api/connect']) {
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

  /* ── from the Square ───────────────────────────────────────────────────
     The ⊞ Do With tile in the Square links here with a pass it signed (see
     lib/square.js for what a pass is and who it signs in). The GET checks it and,
     when there is nothing to ask, spends it and signs in; when this browser is
     signed in as somebody not yet linked, it asks first, and the POST behind the
     answer spends it. The pass leaves the address bar with the redirect, and no
     referrer carries it anywhere. 404 when no secret is configured, so the door
     does not exist rather than being shut. */

  const fromSquare = (req, res, claims, how) => {
    let u;
    if (how === 'linked') u = square.personFor(state.users, claims, null).user;
    else if (how === 'claim' && req.user && !req.user.square) {
      u = req.user;
      u.square = square.linkOf(claims);
    } else {
      const name = invites.cleanName(claims.name) || claims.sub;
      const id = invites.idFor(state.users, name);
      u = { id, email: null, name, picture: null, via: 'square',
        square: square.linkOf(claims), createdAt: Date.now(), lastSeen: Date.now() };
      state.users[id] = u;
    }
    square.spendPass(state, claims);
    u.lastSeen = Date.now();
    store.save();
    res.setHeader('Set-Cookie', auth.cookieHeader(auth.sign(u.id), { secure: req.secure }));
    res.redirect(303, '/');
  };

  const noTrail = (res) => res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });

  app.get('/sso', (req, res) => {
    if (!square.linked()) return res.status(404).type('html').send(page('Not found.'));
    noTrail(res);
    const r = square.verifyPass(String(req.query.t || ''), { used: square.spentPasses(state) });
    if (!r.ok) return res.status(400).type('html').send(page(r.why));
    const who = square.personFor(state.users, r.claims, req.user || null);
    if (who.how !== 'claim') return fromSquare(req, res, r.claims, who.how);
    res.type('html').send(claimPage(String(req.query.t), who.user.name || 'someone', invites.cleanName(r.claims.name) || r.claims.sub));
  });

  app.post('/sso', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    if (!square.linked()) return res.status(404).type('html').send(page('Not found.'));
    noTrail(res);
    const b = req.body || {};
    const r = square.verifyPass(String(b.t || ''), { used: square.spentPasses(state) });
    if (!r.ok) return res.status(400).type('html').send(page(r.why));
    const who = square.personFor(state.users, r.claims, req.user || null);
    // "No, I'm someone else" is a new account, and this browser's session moves to it.
    fromSquare(req, res, r.claims, who.how === 'claim' && b.fresh ? 'new' : who.how);
  });

  // The one question a pass ever asks. Plain HTML, no JavaScript, like the code page.
  const claimPage = (t, here, there) => `<!doctype html><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>Do With</title>
    <body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#17131a;
      color:#f4eee9;font:16px/1.6 -apple-system,system-ui,sans-serif;text-align:center;padding:24px">
    <div style="max-width:20em">
      <p style="font:600 36px/1.1 Georgia,serif;margin:0 0 10px">Do&nbsp;With</p>
      <p style="color:#948a9c;margin:0 0 26px">This phone is signed in to Do With as
        <b style="color:#f4eee9">${esc(here)}</b>. Is that you, <b style="color:#f4eee9">${esc(there)}</b>
        from the Square?</p>
      <form method="POST" action="/sso">
        <input type="hidden" name="t" value="${esc(t)}">
        <button type="submit" style="width:100%;padding:15px;border:0;border-radius:13px;
          background:#f2845c;color:#2a1206;font:600 16px/1 inherit;cursor:pointer">
          Yes, that's me</button>
        <button type="submit" name="fresh" value="1" style="width:100%;padding:15px;margin-top:10px;border:0;
          background:none;color:#948a9c;font:500 15px/1 inherit;cursor:pointer">
          No, I'm someone else</button>
      </form>
      <p style="color:#6b6274;font-size:13px;margin-top:22px">
        Yes links the two, so the Square opens your lists from now on.</p>
    </div>`;

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

  // Joining from the invite, signed in by it — see lib/invites.js. A POST behind
  // a button, never the GET: messaging apps fetch every link to draw a preview,
  // and an invite spent by the crawler never reaches the person it was for.
  // Someone already signed in is refused rather than joined, so opening your own
  // link to check it cannot spend it.
  app.post('/api/invite/:code/join', (req, res) => {
    if (req.user) return res.status(409).json({ error: 'You are already signed in.' });
    const check = invites.check(state, req.params.code);
    if (!check.ok) return res.status(404).json({ error: check.why });
    const name = invites.cleanName((req.body || {}).name);
    if (!name) return res.status(400).json({ error: 'What should we call you?' });
    const inv = check.invite;
    const target = inv.spaceId ? spaceById(inv.spaceId) : null;
    // Checked before anybody is made, or a full list leaves an account with nowhere to be.
    if (target && SP.memberIds(target).length >= SP.MAX_MEMBERS) {
      return res.status(409).json({ error: 'That list is full.' });
    }
    const id = invites.idFor(state.users, name);
    const u = {
      id, email: null, name, picture: null, via: 'invite',
      square: null, createdAt: Date.now(), lastSeen: Date.now(),
    };
    state.users[id] = u;
    joinViaInvite(u, inv);
    res.setHeader('Set-Cookie', auth.cookieHeader(auth.sign(u.id), { secure: req.secure }));
    res.json({ ok: true });
  });

  /* ── state ────────────────────────────────────────────────────────────── */

  app.get('/api/state', (req, res) => res.json(wire(req.user.id)));

  /* ── the Claude connector ──────────────────────────────────────────────
     An MCP server at /mcp and the OAuth 2.1 server in front of it (lib/oauth.js,
     lib/connector.js). Add https://<this host>/mcp in Claude as a custom
     connector; Claude registers itself, sends you here to Allow, and from then
     on reads your lists as you — read only, and never the rose. */

  // The address Claude was given. `publicUrl` in config pins it; otherwise the
  // request says (behind the tunnel, `trust proxy` makes that https).
  const baseOf = (req) => String(config.get('publicUrl') || `${req.protocol}://${req.get('host')}`)
    .replace(/\/+$/, '').toLowerCase();
  const resourceOf = (req) => `${baseOf(req)}/mcp`;
  const sealed = (res) => res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  const form = express.urlencoded({ extended: false, limit: '16kb' });

  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
    (req, res) => res.json(oauth.resourceMetadata(baseOf(req))));
  app.get('/.well-known/oauth-authorization-server', (req, res) => res.json(oauth.serverMetadata(baseOf(req))));

  // Open by design — Claude registers before anybody has said who they are —
  // so it is capped per address as well as in total (oauth.prune).
  const registered = new Map();
  app.post('/oauth/register', (req, res) => {
    sealed(res);
    const now = Date.now();
    const recent = (registered.get(req.ip) || []).filter(t => now - t < 3600e3);
    if (recent.length >= 30) return res.status(429).json({ error: 'temporarily_unavailable', error_description: 'Slow down.' });
    registered.set(req.ip, [...recent, now]);
    const r = oauth.register(state, req.body, { now, extra: config.get('connectorRedirects', []) });
    if (r.error) return res.status(400).json(r);
    store.save();
    res.status(201).json(r.client);
  });

  // Back to the client with an error, as OAuth says, once the redirect is known good.
  const backWith = (res, redirect, q) => {
    const u = new URL(redirect);
    for (const [k, v] of Object.entries(q)) if (v !== null && v !== undefined) u.searchParams.set(k, v);
    res.redirect(302, u.href);
  };

  const allowPage = (req, { client, txn, who, why }) => `<!doctype html><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>Connect ${esc(client.name)} to Do With</title>
    <body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#17131a;
      color:#f4eee9;font:16px/1.6 -apple-system,system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box">
    <div style="max-width:22em;width:100%">
      <p style="font:600 36px/1.1 Georgia,serif;margin:0 0 10px">Do&nbsp;With</p>
      <p style="color:#948a9c;margin:0 0 6px"><b style="color:#f4eee9">${esc(client.name)}</b> would like to read your lists
        ${who ? `as <b style="color:#f4eee9">${esc(who)}</b>` : ''}.</p>
      <p style="color:#948a9c;margin:0 0 22px;font-size:14px">It sees what you see in the app — your lists, and
        whose idea things were — and changes nothing. Never the rose, today’s question or a kitchen.</p>
      ${why ? `<p style="background:#3a2026;color:#f6b7a3;border-radius:10px;padding:10px 12px;font-size:14px">${esc(why)}</p>` : ''}
      <form method="POST" action="/oauth/authorize">
        <input type="hidden" name="txn" value="${esc(txn)}">
        ${who ? '' : `<label style="display:block;text-align:left;color:#948a9c;font-size:14px;margin:0 0 6px">
          This browser isn’t signed in to Do With. In the app, open your account → Claude → Get a code, and type it here.</label>
          <input name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH"
            style="width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:1px solid #3b3341;background:#221c26;
            color:#f4eee9;font:600 20px/1 ui-monospace,monospace;letter-spacing:2px;text-align:center;margin-bottom:12px">`}
        <button type="submit" name="allow" value="1" style="width:100%;padding:15px;border:0;border-radius:13px;
          background:#f2845c;color:#2a1206;font:600 16px/1 inherit;cursor:pointer">Allow</button>
        <button type="submit" name="deny" value="1" style="width:100%;padding:15px;margin-top:10px;border:0;
          background:none;color:#948a9c;font:500 15px/1 inherit;cursor:pointer">Cancel</button>
      </form>
      <p style="color:#6b6274;font-size:13px;margin-top:22px">You can disconnect it any time from your account in Do With.</p>
    </div>`;

  // `same-origin`, NOT `no-referrer`: under no-referrer a browser sends
  // `Origin: null` with the Allow form's POST, and the Origin check below then
  // refuses the very tap it exists to protect (Nov 25, the first real connect).
  // same-origin still keeps this URL from any other site.
  const noFraming = (res) => res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' });

  app.get('/oauth/authorize', (req, res) => {
    noFraming(res);
    const r = oauth.checkAuthorize(state, req.query, resourceOf(req));
    if (r.fatal) return res.status(400).type('html').send(page(r.fatal));
    if (r.error) return backWith(res, r.redirect, { error: r.error, error_description: r.error_description, state: r.state, iss: baseOf(req) });
    const txn = oauth.sealTxn(r.params, auth.secret());
    res.type('html').send(allowPage(req, { client: r.client, txn, who: req.user ? (req.user.name || req.user.email) : null }));
  });

  app.post('/oauth/authorize', form, (req, res) => {
    noFraming(res);
    // A form on this page posts with this page's Origin. Anything else is a
    // different site trying to press Allow for you.
    const origin = req.get('origin');
    if (origin && origin.toLowerCase() !== baseOf(req)) return res.status(403).type('html').send(page('That didn’t come from this page.'));
    const b = req.body || {};
    const params = oauth.openTxn(b.txn, auth.secret());
    if (!params) return res.status(400).type('html').send(page('That page has expired. Start again from Claude.'));
    const client = oauth.clientOf(state, params.client_id);
    if (!client || !client.redirectUris.includes(params.redirect_uri)) return res.status(400).type('html').send(page('That connection no longer exists. Start again from Claude.'));
    const iss = baseOf(req);
    if (b.deny) return backWith(res, params.redirect_uri, { error: 'access_denied', state: params.state, iss });
    let uid = null;
    if (b.code && String(b.code).trim()) {
      if (oauth.pairBlocked(req.ip)) {
        return res.status(429).type('html').send(allowPage(req, { client, txn: b.txn, who: null, why: 'Too many tries. Wait a few minutes and get a new code.' }));
      }
      uid = oauth.takePair(b.code);
      if (!uid || !state.users[uid]) {
        oauth.pairMissed(req.ip);
        return res.status(400).type('html').send(allowPage(req, { client, txn: b.txn, who: null,
          why: 'That code didn’t work. Codes last ten minutes and work once — get a new one in the app.' }));
      }
    } else if (req.user) {
      uid = req.user.id;
    } else {
      return res.status(400).type('html').send(allowPage(req, { client, txn: b.txn, who: null, why: 'Type the code from the app first.' }));
    }
    const code = oauth.issueCode(uid, params);
    backWith(res, params.redirect_uri, { code, state: params.state, iss });
  });

  app.post('/oauth/token', form, (req, res) => {
    sealed(res);
    const r = oauth.exchange(state, req.body, { resource: resourceOf(req), userExists: (u) => !!state.users[u] });
    if (r.error) return res.status(400).json(r);
    store.save();
    res.json(r.tokens);
  });

  app.post('/oauth/revoke', form, (req, res) => {
    sealed(res);
    if (oauth.revokeToken(state, (req.body || {}).token, (req.body || {}).client_id)) store.save();
    res.status(200).end();
  });

  // The MCP endpoint. Bearer only: a browser's session cookie is not a way in,
  // or any page you visit could ask Claude's questions as you.
  const MCP_ORIGINS = ['https://claude.ai', 'https://claude.com'];
  const mcpAuth = (req, res) => {
    sealed(res);
    const origin = req.get('origin');
    // DNS rebinding: a browser page somewhere else may not talk to this.
    if (origin && !MCP_ORIGINS.includes(origin.toLowerCase()) && origin.toLowerCase() !== baseOf(req)) {
      res.status(403).json({ error: 'forbidden origin' });
      return null;
    }
    const g = oauth.bearer(state, req.get('authorization'));
    if (!g || !state.users[g.uid]) {
      res.status(401).set('WWW-Authenticate', `Bearer resource_metadata="${baseOf(req)}/.well-known/oauth-protected-resource/mcp", scope="${oauth.SCOPE}"`)
        .json({ error: 'invalid_token' });
      return null;
    }
    return g;
  };
  app.post('/mcp', (req, res) => {
    const g = mcpAuth(req, res); if (!g) return;
    const pv = req.get('mcp-protocol-version');
    if (pv && !connector.VERSIONS.includes(pv)) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Unsupported MCP-Protocol-Version: ${pv.slice(0, 40)}` } });
    const body = req.body;
    const list = Array.isArray(body) ? body : [body];
    if (!list.length || list.length > 20) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    let view = null;
    const look = () => (view || (view = connectorView(g.uid)));
    const replies = list.map(m => connector.handle(m, look)).filter(Boolean);
    if (!replies.length) return res.status(202).end();
    res.json(Array.isArray(body) ? replies : replies[0]);
  });
  // No stream to offer and no session to end.
  app.get('/mcp', (req, res) => { if (mcpAuth(req, res)) res.status(405).set('Allow', 'POST').end(); });
  app.delete('/mcp', (req, res) => { if (mcpAuth(req, res)) res.status(405).set('Allow', 'POST').end(); });

  // The account sheet: who is connected, a code for a browser that isn't
  // signed in, and Disconnect.
  app.get('/api/connect', (req, res) => {
    res.json({ url: resourceOf(req), connections: oauth.grantsOf(state, req.user.id) });
  });
  app.post('/api/connect/code', (req, res) => res.json(oauth.mintPair(req.user.id)));
  app.delete('/api/connect/:id', (req, res) => {
    if (!oauth.revoke(state, req.params.id, req.user.id)) return res.status(404).json({ error: 'not found' });
    store.save();
    res.json({ ok: true, connections: oauth.grantsOf(state, req.user.id) });
  });

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
    // Leaving a pair takes the inventory with it: those answers were given to
    // one person in particular, and that arrangement has just ended.
    // Today's question goes the same way, for the same reason.
    if (SP.isPair(s)) {
      delete state.pleasure[pleasure.pairKey(...SP.memberIds(s))];
      delete state.questions[pleasure.pairKey(...SP.memberIds(s))];
    }
    s.memberIds = SP.memberIds(s).filter(m => m !== req.user.id);
    if (!s.memberIds.length) {
      state.spaces = state.spaces.filter(x => x.id !== s.id);
      state.items = state.items.filter(i => i.spaceId !== s.id);
    }
    store.save();
    res.json(wire(req.user.id));
  });

  // The pleasure inventory. A PAIR only — a group list answers 404, the same as
  // a list you are not in, because "this exists here" is not for a group.
  function myPair(req, res) {
    const s = mySpace(req, res); if (!s) return null;
    if (!SP.isPair(s)) { res.status(404).json({ error: 'not found' }); return null; }
    const other = SP.memberIds(s).find(m => m !== req.user.id);
    const key = pleasure.pairKey(req.user.id, other);
    return { key, other };
  }
  const pleasureWire = ({ key, other }, uid) => {
    const book = state.pleasure[key] || {};
    return {
      ...pleasure.catalogue(), partner: nameOf(other),
      ...pleasure.view(book[uid], book[other], book[pleasure.CUSTOM], uid),
    };
  };

  app.get('/api/space/:id/pleasure', (req, res) => {
    const p = myPair(req, res); if (!p) return;
    res.json(roomWire(p, req));
  });

  // The rose, with today's question in it when today is a Spicy one: the ONLY
  // route a Spicy question, its answers, reactions and replies travel on.
  function roomWire(p, req) {
    const q = qRecord(p, req.user.id, req.query && req.query.zone);
    return { ...pleasureWire(p, req.user.id), question: questions.roomView(q.rec, req.user.id, p.other, q.today) };
  }

  app.post('/api/space/:id/pleasure', (req, res) => {
    const p = myPair(req, res); if (!p) return;
    const b = req.body || {};
    // Answering a Spicy question — and reacting, replying — happens here and
    // nowhere else; the list's routes refuse a Spicy day.
    if (b.question && typeof b.question === 'object') {
      const r = questionWrite(p, req, b.question, 'spicy');
      if (r.error) return res.status(r.error).json({ error: 'not that' });
      return res.json(roomWire(p, req));
    }
    const book = state.pleasure[p.key] || (state.pleasure[p.key] = {});
    if (b.kind === 'custom-add') {
      if (!pleasure.addCustom(book, req.user.id, b.label)) return res.status(400).json({ error: 'could not add that' });
    } else if (b.kind === 'custom-remove') {
      if (!pleasure.removeCustom(book, req.user.id, b.id)) return res.status(404).json({ error: 'not found' });
    } else {
      const c = pleasure.clean(b, pleasure.customIds(book));
      if (!c) return res.status(400).json({ error: 'not an answer' });
      book[req.user.id] = pleasure.apply(book[req.user.id], c);
    }
    store.save();
    res.json(pleasureWire(p, req.user.id));
  });

  /* ── today's question (lib/questions.js) ─────────────────────────────── */

  // The pair's record, made on first sight — Friends is on by default — with
  // the zone of whoever first asked, and today's question picked if there is
  // one to pick. Saves only when something changed.
  function qRecord(p, uid, zone) {
    const all = state.questions || (state.questions = {});
    let changed = false;
    let rec = all[p.key];
    if (!rec) {
      const z = questions.validZone(zone) ? zone : 'UTC';
      rec = all[p.key] = questions.blank(z, questions.dateIn(z, Date.now()));
      changed = true;
    } else if (rec.zone === 'UTC' && zone !== 'UTC' && questions.validZone(zone)) {
      rec.zone = zone;   // made where nobody said (the rose, a reminder); the first phone that does sets it
      changed = true;
    }
    const today = questions.dateIn(rec.zone, Date.now());
    const had = !!rec.days[today];
    questions.ensureDay(rec, today, p.key, uid, p.other);
    if (changed || (!had && rec.days[today])) store.save();
    return { rec, today };
  }

  // Answer, react or reply, on a day of the right sort: `spicy` writes only a
  // Spicy day (from the rose), `list` only any other. The wrong route is a 404.
  function questionWrite(p, req, b, where) {
    const uid = req.user.id;
    const { rec } = qRecord(p, uid, null);
    const d = rec.days[String(b.date)];
    if (!d || (where === 'spicy') !== (d.kind === 'spicy')) return { error: 404 };
    const now = Date.now();
    let r;
    if (b.react !== undefined) r = questions.react(rec, b.date, uid, p.other, b.react);
    else if (b.reply !== undefined) r = questions.reply(rec, b.date, uid, p.other, b.reply, now);
    else r = questions.answer(rec, b.date, uid, p.other, b, now);
    if (r.error) return r;
    store.save();
    if (r.first) answeredNudge(p, req, rec, b.date).catch(e => console.error('push:', e.message));
    return r;
  }

  // Told when the other one answers — their name and nothing of the question.
  // Once a day, after the response, never awaited.
  async function answeredNudge(p, req, rec, date) {
    const other = state.users[p.other];
    const d = rec.days[date];
    if (!other || !d || !questions.once(rec, p.other, 'answered', date)) return;
    store.save();
    const msg = questions.nudge(d.answers[p.other] ? 'answered-after' : 'answered-first', { name: nameOf(req.user.id) });
    await push.sendTo(other, { ...msg, tag: `dq-${req.params.id}`, url: `/?list=${encodeURIComponent(req.params.id)}`, spaceId: req.params.id });
  }

  const questionWire = (p, req) => {
    const { rec, today } = qRecord(p, req.user.id, req.query && req.query.zone);
    const v = questions.listView(rec, req.user.id, p.other, today);
    return { ...v, partner: nameOf(p.other), paused: v.paused && { ...v.paused, byName: v.paused.mine ? null : nameOf(p.other) } };
  };

  app.get('/api/space/:id/question', (req, res) => {
    const p = myPair(req, res); if (!p) return;
    res.json(questionWire(p, req));
  });

  for (const what of ['answer', 'react', 'reply']) {
    app.post(`/api/space/:id/question/${what}`, (req, res) => {
      const p = myPair(req, res); if (!p) return;
      const b = req.body || {};
      const body = what === 'react' ? { date: b.date, react: b.emoji === undefined ? undefined : b.emoji }
        : what === 'reply' ? { date: b.date, reply: b.text === undefined ? '' : b.text }
          : { date: b.date, text: b.text, pick: b.pick };
      if (what === 'react' && body.react === undefined) return res.status(400).json({ error: 'which?' });
      const r = questionWrite(p, req, body, 'list');
      if (r.error) return res.status(r.error).json({ error: 'not that' });
      res.json(questionWire(p, req));
    });
  }

  app.post('/api/space/:id/question/settings', (req, res) => {
    const p = myPair(req, res); if (!p) return;
    const { rec, today } = qRecord(p, req.user.id, null);
    const r = questions.settings(rec, req.user.id, req.body, today, Date.now());
    if (r.error) return res.status(r.error).json({ error: 'not a setting' });
    store.save();
    res.json(questionWire(p, req));
  });

  // Every question so far — never a Spicy day; those keep to the rose.
  app.get('/api/space/:id/question/history', (req, res) => {
    const p = myPair(req, res); if (!p) return;
    const { rec } = qRecord(p, req.user.id, null);
    const before = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.before || '')) ? String(req.query.before) : null;
    res.json({ ...questions.history(rec, req.user.id, p.other, { before }), partner: nameOf(p.other) });
  });

  // The reminders, once a minute, in each pair's own zone. No question text.
  if (!process.env.NO_PUSH) {
    setInterval(() => {
      let due;
      try { due = questions.remindersDue(state, pleasure.pairKey, Date.now()); } catch (e) { return console.error('questions:', e.message); }
      if (!due.length) return;
      store.save();
      for (const r of due) {
        const u = state.users[r.uid];
        if (u) push.sendTo(u, r.payload).catch(e => console.error('push:', e.message));
      }
    }, 60 * 1000).unref();
  }

  app.get('/api/space/:id/items', (req, res) => {
    const s = mySpace(req, res); if (!s) return;
    const uid = req.user.id;
    const admin = isAdmin(uid);
    // For each recipe, which ingredients each kitchen has — yours, and in a pair
    // list your partner's. Matched HERE, in one tested place (kitchen.match),
    // and the client renders what it is sent, the same rule as canSee.
    const cooks = [uid, ...(SP.isPair(s) ? SP.memberIds(s).filter(m => m !== uid) : [])]
      .filter(k => kitchen.canUse(uid, k, state.spaces));
    const pantries = cooks.map(k => [k, ((state.kitchens || {})[k] || {}).pantry || {}]);
    const readyOf = (it) => {
      const ings = it.mod && it.mod.recipe && it.mod.recipe.ingredients;
      if (!ings || !ings.length) return null;
      // A swapped line counts as what it now is (swap.ready).
      const sw = swap.live(it);
      return Object.fromEntries(pantries.map(([k, p]) => [k, swap.ready(ings, sw, p)]));
    };
    const list = SP.visibleIn(state.items, s, uid, state.spaces)
      .map(it => ({ ...itemWire(it, uid, admin), fromElsewhere: it.spaceId !== s.id, ready: readyOf(it) }))
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
    // A recipe read before it was saved: who read it is the session, not the body.
    if (it.mod && it.mod.recipe) Object.assign(it.mod.recipe, { readBy: req.user.id, readAt: Date.now() });
    state.items.push(it);
    store.save();
    res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
    // After the response, and never awaited: a slow push service must not make
    // adding something feel slow. The audience comes from lib/spaces.js, so a
    // private item reaches nobody — see lib/push.js.
    push.itemAdded(it, listTitle).catch(e => console.error('push:', e.message));
    // A place gets its weather profile from Claude, in the background (lib/placefit.js).
    placefit.ensure(it, { save: () => store.save() });
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
    if (need === 'edit' && !SP.canEdit(it, uid, state.spaces, { admin: isAdmin(uid) })) {
      res.status(403).json({ error: 'not yours to change' }); return null;
    }
    if (need === 'complete' && !SP.canComplete(it, uid, state.spaces)) {
      res.status(403).json({ error: 'not yours to tick off' }); return null;
    }
    return it;
  }

  app.patch('/api/item/:id', (req, res) => {
    const it = myItem(req, res, 'edit'); if (!it) return;
    const wasKind = it.kind;
    const wasTitle = it.title;
    const body = { ...(req.body || {}) };
    const admin = isAdmin(req.user.id);
    // Belt and braces: myItem has already required the edit right, which today
    // implies this one. Dropped rather than refused if that ever drifts.
    if (!SP.canSetVisibility(it, req.user.id, state.spaces, { admin })) delete body.visibility;
    // Whose idea it was: to someone in this list. Checked BEFORE anything is
    // applied, so naming someone outside the list changes nothing at all.
    let credit;
    if (Object.prototype.hasOwnProperty.call(body, 'ideaBy')) {
      const to = body.ideaBy == null || body.ideaBy === '' ? it.authorId : String(body.ideaBy);
      if (!SP.canCredit(it, req.user.id, to, state.spaces, { admin })) {
        return res.status(400).json({ error: 'not someone in this list' });
      }
      credit = to;
      delete body.ideaBy;
    }
    const wasWatch = it.mod && it.mod.watch;
    const wasRecipe = it.mod && it.mod.recipe;
    if (!items.applyPatch(it, body, Date.now(), req.user.id)) return res.status(400).json({ error: 'needs a title' });
    if (credit !== undefined) items.setIdea(it, credit);
    // The poster is not this route's to set or to lose. The sheet sends the
    // slices a person types — place, link — and `mod` is replaced wholesale, so
    // without this, fixing a typo in a film's notes silently took its poster
    // with it. It is set and cleared by /watch alone.
    if (it.mod) delete it.mod.watch;
    // Classified as something else, or renamed — either way what was looked up
    // before is about something else now, so it stays gone.
    if (wasWatch && it.kind === wasKind && it.title === wasTitle) {
      it.mod = { ...(it.mod || {}), watch: wasWatch };
    }
    // Likewise the recipe: read from a page, never typed, so the sheet never
    // sends it and a save must never lose it. It is set by /recipe alone, and
    // kept through a rename or a change of kind — a kind never confiscates.
    if (it.mod) delete it.mod.recipe;
    if (wasRecipe) it.mod = { ...(it.mod || {}), recipe: wasRecipe };
    store.save();
    res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
    // A different place is a different profile; `of` says when it is stale.
    placefit.ensure(it, { save: () => store.save() });
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

  // The visit: book ahead, would you go back, what it was like. The same right
  // as ticking off — anyone who can see it — because planning a place and
  // remembering it are both things you do together. The record half waits until
  // you have actually been: "would you go back" before going is a guess.
  app.post('/api/item/:id/visit', (req, res) => {
    const it = myItem(req, res, 'complete'); if (!it) return;
    const b = req.body || {};
    const remembering = (b.again !== undefined && b.again !== null)
      || (typeof b.memory === 'string' && b.memory.trim());
    if (remembering && !it.done) return res.status(409).json({ error: 'only once you have been' });
    if (!items.setVisit(it, b)) return res.status(400).json({ error: 'not something this knows' });
    store.save();
    res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
  });

  // A place's details, live, for its page: hours, website, a short address.
  // Through myItem like everything else, so it is a 404 for anything you cannot
  // see — the OSM id would otherwise say where somebody's private item is.
  // Hours are read into a week here (lib/hours.js); which day is TODAY is the
  // phone's call, because the server runs in UTC.
  app.get('/api/item/:id/place', async (req, res) => {
    const it = myItem(req, res); if (!it) return;
    const pl = it.mod && it.mod.place;
    if (!pl || !pl.osm) return res.json({ ok: true, details: null });
    const d = await geo.placeDetails(pl.osm);
    if (!d) return res.json({ ok: false, details: null });
    res.json({ ok: true, details: { ...d, week: hours.parse(d.hours) } });
  });

  // Weather at a place you can see (lib/weather.js): now, the next few hours,
  // and the day it is planned for. Its pin, rounded to ~1 km, goes to
  // Open-Meteo; the phone's own position never does.
  const pinOfPlace = (pl) => {
    if (!pl) return null;
    if (Number.isFinite(pl.lat) && Number.isFinite(pl.lon)) return pl;
    const fix = pl.name ? geo.cached(pl.name) : null;
    return fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lon) ? fix : null;
  };
  app.get('/api/item/:id/weather', async (req, res) => {
    const it = myItem(req, res); if (!it) return;
    const pin = pinOfPlace(it.mod && it.mod.place);
    if (!pin) return res.json({ ok: true, weather: null });
    placefit.ensure(it, { save: () => store.save() });
    const fc = await weather.forecast(pin.lat, pin.lon);
    const w = weather.summary(fc, { plan: it.done ? null : it.when });
    // How the weather suits THIS place, by its profile: now, and at the plan
    // (its hour when it has one, else the day's high).
    const fit = it.weatherFit && !placefit.stale(it) ? it.weatherFit : null;
    const p = w && w.plan;
    res.json({ ok: !!fc, weather: w, fit, judge: w ? {
      now: placefit.judge(fit, w.now),
      plan: p ? placefit.judge(fit, p.hour ? { code: p.hour.code, t: p.hour.t } : { code: p.code, t: p.hi }) : null,
    } : null });
  });
  // And for the Places tab: the middle of the pins you can see on this list.
  app.get('/api/space/:id/weather', async (req, res) => {
    const s = mySpace(req, res); if (!s) return;
    const seen = SP.visibleIn(state.items, s, req.user.id, state.spaces);
    // Opening the Places tab is when the list's places without a profile get one.
    for (const it of seen.filter(x => placefit.keyOf(x) && placefit.stale(x)).slice(0, 25)) placefit.ensure(it, { save: () => store.save() });
    const mid = weather.middle(seen.map(it => pinOfPlace(it.mod && it.mod.place)));
    if (!mid) return res.json({ ok: true, weather: null });
    const fc = await weather.forecast(mid.lat, mid.lon);
    res.json({ ok: !!fc, weather: weather.summary(fc) });
  });

  /* ── recipes ─────────────────────────────────────────────────────────── */

  // Reading a page costs this server a fetch on somebody's say-so, so it is
  // signed-in only and rate-limited per person, in memory.
  const perHour = (n) => {
    const seen = new Map();
    return (uid, now = Date.now()) => {
      const recent = (seen.get(uid) || []).filter(t => now - t < 3600e3);
      if (recent.length >= n) { seen.set(uid, recent); return false; }
      recent.push(now);
      seen.set(uid, recent);
      return true;
    };
  };
  const READS_PER_HOUR = 30;
  const readAllowed = perHour(READS_PER_HOUR);
  const pantryOf = (uid) => (((state.kitchens || {})[uid]) || {}).pantry || {};
  // Through the gate like any slice; who read it is the session.
  const gateRecipe = (r, uid) => modules.byId.get('recipe').clean({ ...(r || {}), readAt: Date.now(), readBy: uid });

  // Fetch a page, read its recipe, keep its photo. SAVES NOTHING: the read is
  // shown to the person who asked, and they decide — choosing, not guessing.
  app.post('/api/recipe/read', async (req, res) => {
    const uid = req.user.id;
    const url = String((req.body || {}).url || '').trim().slice(0, 2000);
    if (!url) return res.json({ ok: false, why: 'refused' });
    if (!readAllowed(uid)) return res.json({ ok: false, why: 'slow-down' });
    let page;
    try {
      page = await fetchpage.fetchPage(url, { kind: 'html', maxBytes: 3 * 1024 * 1024 });
    } catch (e) {
      return res.json({ ok: false, why: e.why === 'wrong-type' ? 'no-recipe' : (e.why || 'unreachable') });
    }
    let host = null;
    try { host = new URL(page.url).hostname.replace(/^www\./, ''); } catch (_) {}
    const got = recipe.fromHtml(page.buf.toString('utf8'), page.url);
    if (!got) return res.json({ ok: false, why: 'no-recipe', site: host });
    let image = null;
    if (got.imageUrl) {
      try { image = img.save((await fetchpage.fetchPage(got.imageUrl, { kind: 'image', maxBytes: img.MAX_BYTES })).buf); } catch (_) { /* a recipe with no photo is still a recipe */ }
    }
    const r = gateRecipe({ ...got.recipe, image }, uid);
    if (!r) return res.json({ ok: false, why: 'no-recipe', site: host });
    res.json({ ok: true, recipe: r, url: page.url, ready: kitchen.match(r.ingredients, pantryOf(uid)) });
  });

  // The paste reader, for a page that will not give its recipe up. Saves nothing.
  app.post('/api/recipe/paste', (req, res) => {
    const read = recipe.fromText(String((req.body || {}).text || ''));
    const r = read && gateRecipe(read, req.user.id);
    if (!r) return res.json({ ok: false, why: 'no-recipe' });
    res.json({ ok: true, recipe: r, ready: kitchen.match(r.ingredients, pantryOf(req.user.id)) });
  });

  // Attach a recipe that was read to an existing item, or let go of it. The
  // `complete` right: it is derived from the link the author chose, like the
  // poster and the pin backfills, so anyone who can see the item may.
  app.post('/api/item/:id/recipe', (req, res) => {
    const it = myItem(req, res, 'complete'); if (!it) return;
    const b = req.body || {};
    if (b.clear) {
      if (it.mod) delete it.mod.recipe;
    } else {
      const r = gateRecipe(b.recipe, req.user.id);
      if (!r) return res.status(400).json({ error: 'not a recipe' });
      it.mod = { ...(it.mod || {}), recipe: r };
    }
    // A new reading may reorder or reword the lines its swaps were made for.
    it.swaps = null;
    it.updatedAt = Date.now();
    store.save();
    res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
  });

  // Made it: the record, and the tick. Anyone who can see it, like ticking off.
  // The "ticked off" nudge fires only on the first transition, as it always has.
  app.post('/api/item/:id/cooked', (req, res) => {
    const it = myItem(req, res, 'complete'); if (!it) return;
    const was = !!it.done;
    if (!items.addCooked(it, req.body || {}, req.user.id)) return res.status(400).json({ error: 'not something this knows' });
    if (!it.done) items.setDone(it, true, req.user.id);
    store.save();
    res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
    if (!was) push.itemDone(it, req.user.id, listTitle).catch(e => console.error('push:', e.message));
  });

  /* ── swaps ───────────────────────────────────────────────────────────── */

  // Suggest what to use instead of one ingredient (lib/swap.js). SAVES
  // NOTHING: the shortlist goes to the person who asked, and a swap exists
  // only once they choose one. Seeing the recipe is enough, as it is for
  // reading one. What goes to Anthropic: the recipe, that ingredient, the
  // names in the kitchen being cooked from — yours, or a partner's you may
  // open (kitchen.canUse), never anybody else's — the alternatives ticked,
  // and what it has to be. Each one costs money, so it is rate-limited per person.
  const SUGGESTS_PER_HOUR = 20;
  const suggestAllowed = perHour(SUGGESTS_PER_HOUR);
  app.post('/api/item/:id/swap/suggest', async (req, res) => {
    const it = myItem(req, res); if (!it) return;
    const uid = req.user.id;
    const b = req.body || {};
    const r = it.mod && it.mod.recipe;
    const i = Number(b.i);
    if (!r || !Number.isInteger(i) || !r.ingredients[i]) return res.status(400).json({ error: 'no such ingredient' });
    if (!swap.available()) return res.json({ ok: false, why: 'off' });
    const owner = b.kitchen && kitchen.canUse(uid, String(b.kitchen), state.spaces) ? String(b.kitchen) : uid;
    const pantry = pantryOf(owner);
    const have = Object.values(pantry).filter(e => e && e.state !== 'out').slice(0, 150)
      .map(e => ({ name: kitchen.cleanName(e.name), low: e.state === 'low' }));
    const picks = [...new Set((Array.isArray(b.picks) ? b.picks : []).map(p => kitchen.cleanName(p)).filter(Boolean))].slice(0, 12);
    // What it has to be ("gluten-free"): a rule for every suggestion, not an
    // option to weigh. Words for the prompt and nothing else, so only bounded.
    const musts = [...new Set((Array.isArray(b.musts) ? b.musts : []).filter(m => typeof m === 'string')
      .map(m => kitchen.cleanName(m).toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 4);
    if (!suggestAllowed(uid)) return res.json({ ok: false, why: 'slow-down' });
    const choice = kitchen.alternatives(r.ingredients[i].name || r.ingredients[i].text);
    res.json(await swap.suggest({ recipe: r, title: it.title, i, have, picks, pantry, choice, musts }));
  });

  // Use something instead of one ingredient, or `{ i, clear: true }` to go
  // back to the original. Anyone who can see the recipe, like planning it.
  app.post('/api/item/:id/swap', (req, res) => {
    const it = myItem(req, res, 'complete'); if (!it) return;
    const b = req.body || {};
    if (!items.setSwap(it, Number(b.i), b.clear ? null : b, req.user.id)) return res.status(400).json({ error: 'not something this knows' });
    store.save();
    res.json({ item: itemWire(it, req.user.id), state: wire(req.user.id) });
  });

  // A cooking timer, registered so a locked phone still gets told. The length
  // comes from the client; the END is the server's clock, and `now` goes back
  // so the client can correct for its own.
  app.post('/api/item/:id/timer', (req, res) => {
    const it = myItem(req, res, 'complete'); if (!it) return;
    const b = req.body || {};
    const r = timers.add(state, { id: store.nextId('tm'), uid: req.user.id, itemId: it.id, secs: b.secs, label: b.label, step: Number(b.step) });
    if (r.error) return res.status(400).json({ error: r.error });
    store.save();
    res.json({ id: r.timer.id, endsAt: r.timer.endsAt, now: Date.now() });
  });
  app.delete('/api/timer/:id', (req, res) => {
    if (!timers.remove(state, req.params.id, req.user.id)) return res.status(404).json({ error: 'not found' });
    store.save();
    res.json({ ok: true });
  });

  // "Linnea's on step 4". In memory only — where somebody is in a recipe is
  // worth twenty minutes, not a line in the store — and never pushed.
  const cooking = new Map();
  const COOKING_TTL = 20 * 60 * 1000;
  const othersCooking = (itemId, uid) => {
    const m = cooking.get(itemId);
    if (!m) return [];
    const now = Date.now();
    return [...m.entries()]
      .filter(([who, v]) => who !== uid && now - v.at < COOKING_TTL && SP.nameable(state.spaces, uid, who))
      .map(([who, v]) => ({ id: who, name: nameOf(who), step: v.step }));
  };
  app.post('/api/item/:id/cooking', (req, res) => {
    const it = myItem(req, res); if (!it) return;
    const step = Number((req.body || {}).step);
    if (!Number.isInteger(step) || step < 0 || step >= 40) return res.status(400).json({ error: 'which step?' });
    if (!cooking.has(it.id)) cooking.set(it.id, new Map());
    cooking.get(it.id).set(req.user.id, { step, at: Date.now() });
    res.json({ others: othersCooking(it.id, req.user.id) });
  });
  app.get('/api/item/:id/cooking', (req, res) => {
    const it = myItem(req, res); if (!it) return;
    res.json({ others: othersCooking(it.id, req.user.id) });
  });

  /* ── kitchens ────────────────────────────────────────────────────────── */

  // These routes name a PERSON — the kitchen's owner — which nothing else here
  // does. Identity still comes from the session alone; the id only says whose
  // kitchen, and kitchen.canUse decides, with a 404 for anything it refuses.
  function myKitchen(req, res) {
    const owner = String(req.params.uid || '');
    if (!state.users[owner] || !kitchen.canUse(req.user.id, owner, state.spaces)) {
      res.status(404).json({ error: 'not found' });
      return null;
    }
    if (!state.kitchens || typeof state.kitchens !== 'object') state.kitchens = {};
    return owner;
  }
  const kitchenOf = (owner) => {
    if (!state.kitchens[owner]) state.kitchens[owner] = kitchen.empty();
    return state.kitchens[owner];
  };
  const kitchenWire = (owner, uid) => {
    const k = state.kitchens[owner] || kitchen.empty();
    return {
      owner: personWire(owner),
      pantry: Object.entries(k.pantry || {}).map(([key, e]) => ({ key, ...e }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      // A row "for" a recipe names it only if the viewer can see that recipe.
      buy: (k.buy || []).map((b) => {
        const item = b.for && state.items.find(i => i.id === b.for);
        const seen = item && SP.canSee(item, uid, state.spaces);
        return { ...b, for: seen ? b.for : null, forTitle: seen ? item.title : null };
      }),
      running: kitchen.running(k),
    };
  };

  app.get('/api/kitchen/:uid', (req, res) => {
    const owner = myKitchen(req, res); if (!owner) return;
    res.json(kitchenWire(owner, req.user.id));
  });

  // Set one thing's state — have, low, out — or `null` to take it off.
  // Changes nobody is told about: a kitchen notifies nobody.
  app.post('/api/kitchen/:uid/pantry', (req, res) => {
    const owner = myKitchen(req, res); if (!owner) return;
    const b = req.body || {};
    const name = kitchen.cleanName(b.name);
    const k = kitchen.key(name);
    if (!k) return res.status(400).json({ error: 'needs a name' });
    const kit = kitchenOf(owner);
    if (b.state === null) {
      delete kit.pantry[k];
    } else {
      if (!kitchen.STATES.includes(b.state)) return res.status(400).json({ error: 'have, low or out' });
      const was = kit.pantry[k];
      if (!was && Object.keys(kit.pantry).length >= kitchen.MAX_PANTRY) return res.status(400).json({ error: 'the pantry is full' });
      kit.pantry[k] = {
        name: was ? was.name : name,               // as first typed
        state: b.state,
        aisle: was ? was.aisle : kitchen.aisleOf(name),
        by: req.user.id,                           // you can change your partner's
        at: Date.now(),
      };
      // Having it takes it off the list to buy (kitchen.bought).
      if (b.state === 'have') kit.buy = kitchen.bought(kit.buy, k);
    }
    store.save();
    res.json(kitchenWire(owner, req.user.id));
  });

  // The list to buy: add rows, tick one off (it goes into the pantry as Have),
  // tick off a Running low entry by key, or take a row away.
  app.post('/api/kitchen/:uid/buy', (req, res) => {
    const owner = myKitchen(req, res); if (!owner) return;
    const b = req.body || {};
    const kit = kitchenOf(owner);
    const uid = req.user.id;
    const have = (name, now) => {
      const k = kitchen.key(name);
      if (!k) return;
      const was = kit.pantry[k];
      // "Flour or cornstarch" ticked in the shop says you bought one of them,
      // not which: nothing goes into the pantry under the whole phrase. The
      // recipe line asks which, the next time it is looked at.
      if (kitchen.alternatives(name).length) { kit.buy = kitchen.bought(kit.buy, k); return; }
      kit.pantry[k] = { name: was ? was.name : kitchen.cleanName(name), state: 'have', aisle: was ? was.aisle : kitchen.aisleOf(name), by: uid, at: now };
      // Bought for one recipe is bought for all of them.
      kit.buy = kitchen.bought(kit.buy, k);
    };
    if (Array.isArray(b.add)) {
      for (const raw of b.add.slice(0, 60)) {
        const name = kitchen.cleanName(raw && raw.name);
        const k = kitchen.key(name);
        if (!k || kit.buy.length >= kitchen.MAX_BUY) continue;
        // `for` must be an item the caller can see, or it is dropped.
        const item = raw.for && state.items.find(i => i.id === String(raw.for));
        const forId = item && SP.canSee(item, uid, state.spaces) ? item.id : null;
        if (kit.buy.some(x => kitchen.key(x.name) === k && x.for === forId)) continue;
        kit.buy.push({ id: store.nextId('b'), name, amount: String((raw && raw.amount) || '').trim().slice(0, 40) || null, for: forId, by: uid, at: Date.now() });
      }
    } else if (b.got) {
      const row = kit.buy.find(x => x.id === String(b.got));
      if (!row) return res.status(404).json({ error: 'not on the list' });
      kit.buy = kit.buy.filter(x => x !== row);
      have(row.name, Date.now());
    } else if (b.gotKey) {
      const e = kit.pantry[String(b.gotKey)];
      if (!e) return res.status(404).json({ error: 'not in the pantry' });
      have(e.name, Date.now());
    } else if (b.remove) {
      kit.buy = kit.buy.filter(x => x.id !== String(b.remove));
    } else {
      return res.status(400).json({ error: 'add, got, gotKey or remove' });
    }
    store.save();
    res.json(kitchenWire(owner, uid));
  });

  /* ── images ──────────────────────────────────────────────────────────── */

  // A recipe's photo, kept here (lib/img.js). Behind the sign-in guard;
  // content-addressed, so it never changes and can be cached for good.
  app.get('/api/img/:name', (req, res) => {
    const f = img.pathOf(req.params.name);
    if (!f || !fs.existsSync(f)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(f);
  });
  // Daily, anything no item references and older than a day goes.
  const sweepImages = () => {
    const used = new Set(state.items.map(i => i.mod && i.mod.recipe && i.mod.recipe.image).filter(Boolean));
    const gone = img.sweep(used);
    if (gone) console.log(`img: swept ${gone}`);
  };
  setTimeout(sweepImages, 60 * 1000).unref();
  setInterval(sweepImages, 24 * 60 * 60 * 1000).unref();

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

  /* ── where is it ──────────────────────────────────────────────────────── */

  // Suggestions for the Where field, as you type. Proxied rather than called from
  // the browser so the provider sees this server and not each phone, and so the
  // choice of provider lives in one file — see lib/places.js. Writes nothing:
  // what you pick goes back through the item gate like any other place.
  app.get('/api/place/suggest', async (req, res) => {
    const near = { lat: Number(req.query.lat), lon: Number(req.query.lon) };
    res.json(await places.suggest(String(req.query.q || ''), near));
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
