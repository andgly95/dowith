# Do With — CLAUDE.md

A to-do list where the **with** is the point. Not a task app with sharing bolted
on: the unit is a *list you keep with someone*, and it is titled from whichever
side you are standing on. Andrew sees "to do with Linnea"; Linnea sees "to do
with Andrew". Same list.

Things like *go record shopping*, *watch "Obsession"*, *go swing dancing* — not
chores. That shapes everything from the tick being a ring rather than a checkbox
to the default visibility being `shared`.

Port **3006**. Repo not yet published; not yet deployed (see Deployment).

## Stack

Same shape as `~/workout` and `~/trips`:

- **Runtime:** Node.js v22, no build step — `node server.js` is production
- **Server:** Express, thin `server.js` + CommonJS modules in `lib/`
- **Store:** single JSON file (`data/store.json`)
- **Frontend:** vanilla JS ES modules in `public/js/` + plain HTML/CSS
- **Auth:** Google Sign-In and/or Cloudflare Access — **ported wholesale from
  `~/workout`** (`lib/auth.js`, `lib/cfaccess.js`, `lib/config.js`). It is tested
  there and this is not the place to have a second opinion about sessions.
- **Tests:** `npm test` — 125 assertions + a headless-chromium check

## The model

```js
space = { id, name, memberIds: [...], createdBy, createdAt }
item  = { id, spaceId, authorId, title, notes, visibility, tags,
          mod: { place?, link? }, done, doneAt, doneBy, createdAt, updatedAt }
```

- **A space holds people.** Two, usually. A pair needs no name — from your side it
  IS the other person. Three or more gets a name of its own, because "to do with
  Sam, Alex, Jo and 3 others" is not a title. `titleFor(space, uid, nameOf)` is the
  whole conceit and it costs one function.
- **Items are flat with a `spaceId`**, not nested under spaces, because a `public`
  item has to be findable from OUTSIDE its own space and nesting would make that a
  scan of everything.

## Visibility — read this before touching anything

`lib/spaces.js` is PURE and is the most important file here. Every other rule is a
convenience; this one is the promise.

| | who sees it |
|---|---|
| `private` | the author. Nobody else, ever — not even the person the list is with |
| `shared` | everyone in that space |
| `public` | everyone who shares **any** space with the author |

- **`public` is not a feed.** It means "a standing wish, for anyone of mine who
  wants to pick it up" — so it surfaces in *every* space its author belongs to, and
  the client marks it as arriving from elsewhere. The audience is the union of your
  own spaces and nothing wider: your friend's friend is not in it, and there is no
  discovery, no directory, no strangers.
- **`canSee()` checks authorship first**, because being a member of an item's space
  is not sufficient — a private item written there is still nobody's business.
- **An unknown visibility is refused.** A typo, a future value, a hand-written
  request: none of it may widen an audience. Failing open here is the one class of
  bug this app cannot have, and there is a truth-table row for every way in.
- **Editing and completing are different rights.** The sentence stays the author's;
  ticking it off is anyone who can see it, because doing the thing is the point and
  "Linnea ticked off record shopping" is the nice bit.
- **A shared item stops being visible once its author leaves the space.** `shared`
  means "the two of us" and there is no longer a two of us.
- Routes answer **404, not 403**, for something you cannot see. "This exists but is
  not yours" is itself a disclosure.

## The item gate

`lib/items.js`. Everything entering the store passes through it, and a field it
doesn't know is dropped — so **add it there first** or a PATCH will appear to
succeed and change nothing.

- **`authorId` and `spaceId` come from the CALLER**, resolved from the session and
  a membership check, never from the request body. There is no request shape that
  signs an item with someone else's name or writes it into someone else's list.
- A PATCH cannot move an item between spaces, reassign its author, or set `done` —
  ticking off is its own operation because *who* did it is part of the record.
- The default is `shared`. A default of `private` would quietly make the app a
  diary.

## Modules — the seam

`lib/modules.js`. **This is not a plugin framework and resisting that is the
point.** A framework written before there are two real implementations is a guess
about what the second one needs, and it is always wrong in a way you find out at
the third. What exists instead is one narrow contract:

- A module owns `item.mod[<id>]` and supplies a `clean(raw)` returning its slice or
  null. That is the whole contract.
- Unknown module ids are dropped, so a client from the future cannot write fields
  this server has no rules for.
- **A module cannot touch visibility.** That lives in `lib/spaces.js` and nowhere
  else. A map module that could quietly widen an audience is exactly how a private
  thing ends up on somebody's screen.

Two ship today, and two is the smallest number that shows the contract
generalises: `place` (name, optional range-checked coordinates — refused on the way
IN, because a bad pin is far easier to reject than to find later) and `link`
(http/https only; a `javascript:` URL rendered into an href is script injection,
and this app shows other people's items to you).

**A map view is a renderer over items carrying `place`** — the seam is already
there. Same for anything else: add a module, add a renderer.

## Invites

`lib/invites.js`. **Signing in alone gets a stranger nothing** — a brand-new Google
account with no invite is refused and no user record is written. Deliberately
chosen over an approval queue: this is an app for people you actually do things
with, "send Linnea a link" is how that starts in real life, and a queue would mean
strangers accumulating in the store waiting to be told no.

Codes are unguessable (not merely unique), one-shot, and expire in a fortnight.
`GET /api/invite/:code` is the one data route that works **signed out** — the link
has to say who sent it, or a message from your girlfriend looks like phishing. It
discloses the inviter's name and nothing about what is in the list.

## The Square bridge — plumbing only

`lib/square.js`. Nothing is imported and `importable()` refuses on purpose. It
exists so the shape is decided while the reasons are fresh.

- **The Square has no email on a person** — just a slug (`andrew`), a name, a
  colour, an avatar. So there is nothing to join on, and anything that tried to
  match automatically would be guessing whose data it was moving. The link must be
  an explicit **claim**, and a claim needs proof.
- Sketch for when it is built: a one-time code shown in the Square to a signed-in
  person, pasted here, verified back against it. No shared secret, no
  email-matching, no trusting a typed slug.
- **Hard constraint:** the Square's store holds `messages`, `dms` and
  `groupMessages` — everybody's private conversations. A bridge reads `people` and
  `customGroups` and NOTHING else, read-only, projected down to id/name/avatar.
  This is the same data the trips agent sandbox `--tmpfs`es away; a convenience
  feature must not be the thing that walks it out of the building. There is a test
  that dumps the projection and asserts no message content survives.
- `squareStorePath` in config, not hardcoded — a bridge that assumes a sibling
  directory breaks the moment either app moves.

## Kinds — what a thing IS (`lib/kinds.js`)

A list of things to do with someone is not homogeneous. *Watch Obsession*, *go to
that ramen bar*, *make the ragù from the NYT* and *go swing dancing* are four
different shapes of plan, and a recipe without its link is a reminder that you once
saw a recipe. Five kinds: **activity** (default) · **movie** · **show** · **place** · **recipe**.
It was `thing` first: "go swing dancing" is an activity, and calling it a thing made
the kind everything starts as sound like the *absence* of a kind. Renamed in the table,
normalised by `clean()` on the way out and moved on disk by the load-time migration —
and the client never had a literal to miss, because **the default is whichever kind is
first** and `defaultKind()` reads it off the wire.

**Why a kind and not another tag.** `groups.js` is right that a group is a tag and
nothing more — "rainy day" and "cheap" are opinions, they overlap, and they belong to
whoever typed them. A kind is not an opinion: it is mutually exclusive, it is a fact
about the thing, and it decides **which fields are worth showing**. A tag cannot do
that job. The two live side by side: a film tagged "rainy day" is a film *and* in that
group, and there is a test saying so.

- **A KIND SUGGESTS; IT NEVER CONFISCATES.** `mods` is what the editor *offers*, not
  what the item may carry. Seeing a film at the AFI is a film with a place on it, so
  changing the kind drops nothing — and in the editor a field that already **holds
  something stays on screen** whatever the kind says, or reclassifying a row would
  hide and then silently discard an address somebody typed.
- **`thing` offers both fields and leads with neither.** That is the whole reason it
  is the default rather than the emptiest kind: before kinds existed every item could
  carry a place and a link, and a default that took both away would make classifying
  compulsory just to get back what you already had. The first cut had
  `mods: []` and was a quiet downgrade.
- **An unrecognised kind becomes a thing**, never a refused write. A kind is a
  convenience; losing an item because a client sent a word this server hasn't heard of
  would be the tail wagging the dog.
- **Normalised on the way OUT** (`itemWire`), so every item written before kinds
  existed reads as a plain thing with no migration and nothing downstream defending
  against `undefined`.
- **`go` is what the LINK is for, and never the same word as the badge.** The first
  version used the label for both and a show rendered `SHOW` twice in a row — correct
  twice over and reading as a bug. Now: `RECIPE · COOK ↗`, `SHOW · WATCH ↗`. A test
  asserts no kind can ever render its own name twice.
- **There is no filter strip and no picker in the composer.** Both were built and both
  were removed on sight: the group rows already *are* the filter, so a second one above
  them was a third way to narrow the same list. The composer is a box and a button, as
  it always was — writing inside a group makes something of that kind, which is the
  same promise tags used to make through a different field.
- **The kind lives where the free-text tag field used to be**, in the item sheet, under
  "What kind". That is the literal replacement, not an addition beside it.
- **The kind rides on top of the module seam rather than beside it.** No new storage,
  no kind-specific columns: `recipe` is `['link']`, `place` is `['place']`, and a
  `javascript:` URL is refused on a recipe exactly as it is anywhere else.

## The one screen

**The app lands IN your first list, not on the shelf of lists.** Almost everybody has
one and will for a long time, so the shelf was a screen you tapped through on the way
to the only place you were ever going. The back arrow still reaches it — the common
case is free and the rare one costs a tap, rather than the other way about.

Above the list there is **one small toggle, `Done together`**, at the right-hand end
— not a tab bar. It first shipped with the size and weight of the three-up row it had
stopped being part of, which put a bold card-backed button where the primary action
goes; it is not the primary action, the list under it is.

- **"To do" was a tab for the state you were already in.** The count that mattered was
  never on it either; the list underneath is the count.
- **The map is parked** until it has something worth showing. Its renderer, its
  geocoding and every path into it are untouched — only the way in is gone, which is
  one line in `render()` and one control in the markup. The `[hidden]`-by-layout
  assertion that guarded it was kept and pointed at the panes directly, because that
  trap (`display:flex` beating the UA `[hidden]` rule) is not about the map and has now
  bitten this app twice.

**The composer shows who a new thing is for only once you start typing.** Visibility is
a question about the thing being written, so it has no business being on screen before
there is one — and the list gets two rows of height back for the whole time you are not
typing. It appears on the first keystroke and goes again when the box is empty.

## The bottom nav — one tab per kind

**The tabs are the groups.** The group rows this replaced were the same five sets, two
taps and a breadcrumb away instead of one tap and always in the same place. So the rows,
the crumb and the drill-in state are gone, and `lib/kinds.js` is the navigation.

- **Built from the table on the server** (`kinds.tabs`), so adding a kind is still one
  line and still arrives everywhere at once — tab, badge, picker option, editor fields
  and the old-tag mapping.
- **EMPTY TABS STAY.** `present()` leaves empty kinds out, which is right for a filter —
  a chip for a kind you own none of is a dead control. A nav is the opposite case: it is
  furniture, it has to be where you left it, and an empty tab is how you make your first
  recipe. `tabs()` is `present()`'s sibling that keeps them.
- **Counts come from the already-filtered list**, so a private recipe raises the number
  on the author's Recipes tab and nobody else's. Asserted end to end, the same property
  the group list had.
- **Two orthogonal axes:** which kind you are looking at (the nav) and whether you want
  what is still to do or what you have already done (the toggle, top right).
- **The composer follows the tab** — it asks for "a recipe" under Recipes, and writes
  one. Typing into a tab and watching the thing vanish out of it would be baffling; the
  same promise writing inside a group used to make.
- **The kind badge on a row is gone.** It earned its place when one list held everything
  mixed; now every row on screen is already the kind the tab says, so it had become a
  label repeating the page title once per row. The link action still carries the
  identity where it helps — `COOK ↗`, `WATCH ↗`.
- `lib/groups.js` still computes the richer per-kind breakdown (open *and* done) and
  still ships as `groups` — the nav will want "4 to do · 3 done" sooner or later.
  `ungrouped` and `grouped` have gone: they answered "is a group list worth showing",
  and there is no group list to show.

**`.kindnav{display:flex}` beat the UA `[hidden]` rule** the moment it was written — the
assertion added one change earlier caught it immediately, which is the third time that
trap has fired in this app.

### How it is drawn

The first cut was stacked text and a loose numeral and it read as a debug control. Three
things fixed it, and they are the three things a nav is made of:

- **One icon set, drawn to one spec** — 24-unit box, 1.6 stroke, round caps and joins,
  no fills. That consistency *is* the job at 23px: five icons from five drawing
  conventions read as five mistakes. The film strip's sprockets are the one deliberate
  exception, **filled** rather than stroked, because a third and fourth hairline inside
  an 18px box turns to mush — the stroked version read as a book with two pages. Icons
  live in the client keyed by kind id: the server owns the vocabulary, the client owns
  how it looks, and a kind added without one falls back to a plain mark rather than a
  hole.
- **The active marker sits behind the ICON, not the tab.** A pill the width of the tab
  makes five of them look like five buttons; a pill the width of the icon makes one of
  them look chosen.
- **The count is a numeral, not a badge.** Filled pills on all five tabs turned a calm
  bar into a notification centre — a badge means "something needs clearing", and four
  films waiting is not an alert, it is just how many there are. It is anchored to the
  glyph rather than the pill around it; pinned to the pill it floated eleven pixels off
  the icon's shoulder and looked like a number belonging to nothing.

**The `Done together` count is the count of what it would show you.** It was the whole
list's while the list underneath was one kind's, so "Done together 15" on the Recipes
tab produced two.

## The shelf — posters, years and where it streams (`lib/watch.js`)

Films and shows are drawn as a **grid of posters**, not a list of titles. A shelf of
covers is how anybody actually picks what to watch, and the art carries things a title
cannot: whether you have seen it, what sort of thing it is, whether you are in the mood
for it tonight. `art: true` on the kind says which kinds are shelves, so the client
keeps no second list of film-ish kinds.

**TMDB**, with a key in `config.local.json` (`tmdbKey`, and `tmdbRegion` for streaming,
default `US`). Shaped exactly like `geo.js` and for the same reasons: a store-backed
cache so a title is looked up once, a single queue so requests are serialised, and a
**remembered miss** so a title TMDB has never heard of is not asked about on every
render. A network failure is *not* remembered — a blip is not "no such film".

### Choosing, not guessing

**Adding a film or a show asks which one**, with a poster and a year for each
candidate. Searching "Obsession" really does return a 2026, a 2015, a 2019 and the
1976 De Palma you meant — *fourth*. A poster is the fastest way a person recognises a
film, recognising is something people do instantly and matchers do badly, and asking
costs one tap. The same chooser is how you change it later, from **Which one** in the
item sheet, and `Remove the poster` lets go of it — getting it wrong has to be undoable
or choosing is a trap.

So **nothing guesses while somebody is standing there who could be asked**. The silent
lookup on every write is gone; `pickMatch` now runs only where nobody is in the room —
the bulk backfill. A guess made in front of you is the one you are most likely to
notice and least likely to be able to correct.

`GET /api/watch/search` returns the shortlist and decides nothing.
`POST /api/item/:id/watch` pins one by id (or `{clear:true}`), fetching the detail and
the providers server-side — a chosen id is still TMDB's data and still goes through the
module gate.

**TMDB proposes; `pickMatch` disposes** — where it still runs: Searching "Obsession" returns a 1976 De Palma,
a 2019 thriller, a telenovela and forty other things, and taking the first result is how
a shelf ends up with the wrong poster on it. **A wrong poster is worse than none**: it
looks exactly like a right one and nobody checks. So, in pure tested code — an exact
title beats a popular one, a year you typed (`Obsession (1976)`) beats everything, and
something merely *similar* is refused outright. "The Bear" must not resolve to "Bear
Island". No confident match means no poster, which the card already draws properly.

- **A path is stored, never a URL.** Sizes are a rendering decision; baking one in means
  re-fetching everything the day the card changes size. The gate takes
  `/^\/[A-Za-z0-9._-]+$/` and nothing else — this ends up in an `<img src>` and the app
  shows other people's items to you.
- **The search query is not the matching key.** The key can flatten everything; the
  query cannot — "Dune: Part Two" needs its colon and "Se7en" its digit. So only
  decoration comes off: a trailing year, and leading or trailing symbols. The live list
  is full of titles like `🐴 Bojack Horseman`, and sending that verbatim returns
  nothing — it was the one miss in the first seven.
- **Providers are sorted by TMDB's `display_priority`, where ZERO is best.** Reading it
  with `Number(x) || 999` treats a legitimate 0 as missing and buries the most relevant
  service; it put Netflix fourth behind two live-TV resellers. Same falsy-zero trap as
  everywhere else. A tier of something already listed is then dropped — "Netflix" plus
  "Netflix Standard with Ads" is one service twice, and on a card with room for four
  that costs a real one.
- **Only `flatrate` providers.** Rent and buy are a different question, and a card that
  says "on Amazon" when it means "$3.99 on Amazon" is lying quietly — the kind of lie
  nobody catches until they are on the sofa. Capped at four; a card is not a directory.
- **A card without art is not a hole.** It is the title set in the display face on a
  tinted ground — a legitimate way for a card to look, which it has to be: before TMDB
  answers, when TMDB has never heard of the thing, and forever if there is no key.
  **A poster that 404s falls back to it too**, rather than sitting there as a broken-image
  glyph.
- **Looked up after the response, never awaited** — on create, and again on a patch that
  changed the title or the kind, since what was looked up before is about something else
  now. `POST /api/space/:id/watch` backfills a whole list.
- **Class names are global.** The chooser's rows came out stacked vertically because
  `.pick` already existed for the share sheet's list picker, so mine silently inherited
  half of somebody else's component — `flex-direction:column` — with nothing anywhere
  saying so. They are `.cand` now.
- **The store is required lazily** in `watch.js`. Everything above the cache is pure and
  the suite tests it with no store at all; binding `../store` at import loads whatever
  `DATA_FILE` said when the first `require` ran, which in a test is the real one. The
  guard in `test.js` caught exactly that.
- Titles are sent to TMDB, which is a third-party call carrying user content — the same
  trade the app already makes with Nominatim for place names. Worth knowing; private
  items are no exception, because the lookup is about the title, not the audience.

## Finishing something

The one moment in the app worth marking, and it used to be a silent reflow — the
row vanished on the next render and a toast explained what had happened, which is
the wrong way round. The feedback should BE the thing, not a caption. The toast is
gone; the animation replaced it.

About 700ms in four beats: the ring springs and fills, the mark draws itself, a
ripple and six sparks go out, then the row collapses from its measured height and
the list closes up.

- **The row is animated IN PLACE and only then re-rendered.** A re-render destroys
  the element, so anything scheduled after it has nothing left to animate. This is
  the whole reason `toggle()` is shaped the way it is.
- **The POST goes out at beat one**, in parallel — the network is never what you
  are waiting for. If it fails, the animation is allowed to finish rather than
  being yanked, and then the row comes back and says why.
- **Only completing.** Un-ticking is a state change, not an occasion.
- **The mark is a stroked SVG path**, not a `✓` glyph: a path can be drawn on and
  a character cannot.
- **The strike FADES IN via `text-decoration-color`.** A sweeping pseudo-element
  was prettier and was wrong — on a title that wraps to two lines it renders as a
  stub in the gap between them, because one absolutely-positioned bar cannot
  follow text whose shape it does not know. The browser already knows where every
  line is. In a shared list the titles are whatever somebody typed, so correct at
  four lines beats pretty at one.
- **`prefers-reduced-motion` gets the state change and nothing else** — not a
  shortened version of the same thing.
- `client-check.js` catches it mid-flight at 160ms, because an assertion made
  after it finishes would pass just as well with no animation at all.

## Getting things in — the load-bearing feature

A shared list dies because adding to it was three taps too many, not because
nobody cared. So there is one route, `GET /share?title=&text=&url=`, and every way
in points at it:

- `share_target` in the manifest, for Android and desktop Chrome.
- **iOS Safari has no Web Share Target API at all**, so on a phone the real path
  is an iOS Shortcut hitting the same URL. Recipe: *Share Sheet → Get URLs →
  Open URL* with `https://…/share?url=` + the input.
- A bookmarklet, or just a link somebody sends you.

GET rather than POST for exactly that reason: no multipart handling, and the same
URL works from all four. `app.js` reads the query after auth resolves, so a share
**survives the sign-in round trip** instead of being dropped — it lives in the URL,
which is the only place that survives a redirect through an identity provider.

`share.js` guesses everything it can, because you are standing in a shop: the list
you used last, `shared` visibility (a thing you bothered to share is rarely a
secret), and the URL dug out of `text` as well as `url`, since Android puts it in
either. One tap on the list, one on Add. The share is then stripped from the URL so
a reload can't add it twice.

## The record

Done items leave the to-do list and appear under **Done together**, newest first,
grouped by the month they happened in, with who ticked each one off.

A to-do list you finish is empty; a record of what you did with someone is not.
That is the whole argument for the feature, and it cost almost nothing —
`done`, `doneAt` and `doneBy` were already on every item, so this is presentation.

- The composer is hidden in the record and on the map. You don't add things you've
  already done, and you don't type into a map.
- The month is a heading, not a container — same reasoning as the group headings in
  trips.
- **`.items[hidden]{display:none}` is load-bearing.** An author `display` beats the
  UA `[hidden]` rule, so switching to the map left the entire list sitting above
  it. Asserted by LAYOUT in `client-check.js`, because the property said it was fine.

## Nudges

`lib/push.js`. The transport half is lifted from the workout app — lazily-minted
VAPID keys, subscriptions in the store, 404/410 pruning, bounded retries — because
that is solved and tested.

**What is different, and what matters: who is allowed to be told.** In the workout
app a notification was about your own training, so there was no audience question.
Here every nudge is about somebody else's item, which makes the notification
surface a second, quieter copy of the visibility model — and a worse place to leak,
because a lock screen reads itself out loud in a room.

- **`audienceFor()` derives from `SP.canSee`** rather than reasoning about it. A
  nudge must never reach further than a screen would, and asking the same function
  is the only way to guarantee that. There is a test asserting the property
  directly: for every visibility and every person, being in the audience implies
  being able to see it.
- A **private item notifies nobody**, and there is a second test for that with
  devices actually subscribed — an audience of zero is easy to get right by
  accident when nobody is reachable.
- The author is never told about their own thought.
- `itemAdded` fires **after the response and is never awaited** — a slow push
  service must not make adding something feel slow.
- The weekly digest goes out Sunday evening, needs at least three open things to be
  worth sending, and a failed send doesn't burn the week. "Not much on the list" is
  not a failure and doesn't count against the retry budget.

## The map

`public/js/map.js` — a second view over items carrying `place`. No mapping library:
tiles are plain `<img>` at an integer zoom in Web Mercator, the same approach trips
uses. Eighty lines, no dependency to break, and it degrades to pins-on-a-blank-
ground if the tiles don't load, which still answers "is there anything near us".

- Pan and zoom are hand-rolled pointer handling. During a drag the layer moves
  under a CSS transform and only re-renders on release — re-rendering per
  `pointermove` re-requests every tile. `moved` suppresses the click after a drag
  and **clears on the next tick**, or one pan disables every pin until you drag again.
- `view.z === null` means auto-fit; the first gesture pins it.
- The map tab only appears once something has a place. A permanently empty tab is
  worse than no tab.

### Geocoding

`lib/geo.js` uses **Nominatim, not a model**. This is geocoding — a solved problem
with a right answer — and asking a language model where something is gets you a
plausible coordinate rather than a correct one, which on a map is worse than
nothing because a wrong pin looks exactly like a right one.

Their usage policy shapes the file: one request a second, a real User-Agent, cache
hard. So lookups are serialised behind a single queue, the cache is checked again
*inside* the queue (several items with the same place become one request), and:

- **Coordinates are range-checked before they are stored** — including `0,0`, which
  is in the Gulf of Guinea and is almost always a parse failure. A bad pin sits in
  the sea forever; refusing it on the way in is far cheaper than finding it later.
- **A name that isn't a place is remembered as such**, or it would cost a request
  on every render.
- **A network failure is NOT remembered.** A blip is not evidence that somewhere
  doesn't exist, and caching that would be wrong for a week.
- `POST /api/space/:id/geocode` is scoped to items *you can see*, so it can't be
  used to geocode by proxy, and the count it returns can't reveal that a private
  item exists.
- The cache is shared across everybody and lives in `state.places` — a place's
  coordinates are not anybody's private business.

## HTTP routes

| Route | Purpose |
|---|---|
| `POST /api/auth/google` | ID token + optional invite → session. **Public.** |
| `GET /api/auth/me` · `POST /api/auth/signout` | status; sign out |
| `GET /api/invite/:code` | who invited you — **works signed out** |
| `GET /api/state` | you, your spaces with per-viewer titles, module manifest |
| `POST /api/space` · `PATCH /api/space/:id` · `POST /api/space/:id/leave` | lists |
| `GET /api/space/:id/items` · `POST /api/space/:spaceId/item` | the list itself |
| `POST /api/space/:id/invite` | mint an invite into this list |
| `PATCH`·`DELETE /api/item/:id` · `POST /api/item/:id/done` | one thing |
| `GET /api/square/status` · `POST /api/square/import` | the bridge (501) |
| `GET /share` | share target / Shortcut / bookmarklet — serves the shell |
| `POST /api/space/:id/geocode` | resolve place names you can see, batched |
| `POST /api/push/subscribe` · `/unsubscribe` · `/test` | nudges |

`mySpace()` and `myItem()` resolve from the session plus a membership/visibility
check in one step, so no handler below them ever sees something the caller is not
entitled to. There is no route that takes a user id.

## Conventions

- **`lib/spaces.js` is pure and is the source of truth for who sees what.** Don't
  mirror `canSee` into the client; the client renders what the server sent.
- **`esc()` for anything interpolated into innerHTML** — this app shows other
  people's words to you.
- **Assert visibility by layout in tests** (`offsetWidth`/`getClientRects`), never
  `.hidden` — an author `display` rule beats the UA `[hidden]` rule.
- **No build step.** `style.css` gets `?v=STAMP`; the JS tree is served under
  `/js-<STAMP>/`, anchored on `src="` and global (a bare `.replace('/js/', …)`
  takes the first match anywhere in the file, and a comment mentioning a path was
  once enough to eat the stamp). **Restart to bust caches.**
- **The suite points `CONFIG_FILE` at scratch space before requiring lib/config**,
  which resolves its path once at load. A test suite must not write into the thing
  it is testing.

## Deployment

Not deployed yet. To bring it up:

1. `sudo cp dowith.service /etc/systemd/system/` (see below), `systemctl enable --now dowith`
2. Add to `~/.cloudflared/config.yml`: `- hostname: dowith.guess-ai.app` →
   `service: http://localhost:3006`, then `cloudflared tunnel route dns hot-seat
   dowith.guess-ai.app` and restart `cloudflared`
3. Put **either** `googleClientId` **or** `cfAccessTeam` + `cfAccessAud` in
   `config.local.json` (gitignored, 0600). With neither, nobody can sign in.
4. The first person still needs an invite, and there is nobody to send one — so
   bootstrap once from the Pi:
   `node -e "const s=require('./store');s.state.invites.push({code:'bootstrap',spaceId:null,createdBy:null,createdAt:Date.now(),expiresAt:Date.now()+9e8,usedBy:null});s.flushSync()"`
   then open `/?invite=bootstrap`.

## Open threads

- **AI, quietly.** The obvious first use is paste-to-item — drop
  "Khruangbin at the Anthem, March 4" in and have it come back as a title, a place
  and a date. It should never be labelled as such; it is just the box being clever.
  The `/share` sheet is where it belongs.
- **Offline.** Notes-style outbox as in trips: queue writes in `localStorage`,
  replay on reconnect. Items get server ids the moment they exist, so an optimistic
  one needs a reconciliation story — same reason trips scoped its outbox to notes.
- **Wish matching.** Two people in your circle with the same standing wish and
  neither knows. The data is already there — `public` items across your spaces —
  and it's the best idea on the roadmap.
- **The Square link.** Plumbing is in and refuses; it needs the one-time-code proof
  step described above.
- **Auto-tagging.** The groups seam is ready; trips' discovery mode is the
  reference for making them emerge and then hold still.
