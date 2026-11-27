# Do With — CLAUDE.md

A to-do list where the **with** is the point. Not a task app with sharing bolted
on: the unit is a *list you keep with someone*, and it is titled from whichever
side you are standing on. Andrew sees "to do with Linnea"; Linnea sees "to do
with Andrew". Same list.

Things like *go record shopping*, *watch "Obsession"*, *go swing dancing* — not
chores. That shapes everything from the tick being a ring rather than a checkbox
to the default visibility being `shared`.

Port **3006**. Public at [github.com/andgly95/dowith](https://github.com/andgly95/dowith) (remote `github`); not yet deployed (see Deployment).

## Stack

Same shape as `~/workout` and `~/trips`:

- **Runtime:** Node.js v22, no build step — `node server.js` is production
- **Server:** Express, thin `server.js` + CommonJS modules in `lib/`
- **Store:** single JSON file (`data/store.json`), and recipe photos in `data/img/` (see *Recipes*)
- **Frontend:** vanilla JS ES modules in `public/js/` + plain HTML/CSS
- **Auth:** Google Sign-In and/or Cloudflare Access — **ported wholesale from
  `~/workout`** (`lib/auth.js`, `lib/cfaccess.js`, `lib/config.js`). It is tested
  there and this is not the place to have a second opinion about sessions.
- **Tests:** `npm test` — 234 tests + a headless-chromium check

## The model

```js
space = { id, name, memberIds: [...], createdBy, createdAt, diet? }   // diet: see What a list eats
item  = { id, spaceId, authorId, title, notes, visibility, tags,
          mod: { place?, link?, watch? }, done, doneAt, doneBy,
          when?, plannedBy?, visit?, cooked?, editedBy?, ideaBy?, createdAt, updatedAt }
mod.place = { name, lat, lon, address, area?, what?, osm? }   // area/what/osm only with a pin
visit     = { book, again: 'soon'|'maybe'|'once'|null, memory } // see Places
mod.recipe = { name, site, image, yield, prep, cook, total, ingredients[], steps[], from, readAt, readBy }
cooked    = [{ at, by, again, tweaks }]                          // see Recipes
swaps     = { [ingredientIndex]: { use, amount, ratio, needs[], note, why, suggested, of, by, at } } // see Swaps
state.kitchens[uid] = { pantry: { [key]: { name, state, aisle, by, at } }, buy: [...] }
state.questions[pairKey] = { zone, decks: {[uid]: kinds}, remind: {[uid]: 'HH:MM'}, paused, pauses, startedOn,
                             days: { 'YYYY-MM-DD': { qid, kind, answers: {[uid]: {text|pick, at}}, reacts, replies } } } // see Today's question
state.timers = [{ id, uid, itemId, step, label, endsAt }]
fit        = { role, energy, minutes, where, times, weather, built, of, by, model, at }   // see Suggestions
episodes   = { of, seen: { [season]: [ep…] }, season, show, by, at }               // see A show's seasons
state.stations[uid] = { list: [{ id, name, lat, lon, modes, area }], by, at }       // a station each person chose
state.taste[spaceId][uid] = { votes: { [itemId]: { v, at } }, ideas: [...], w: { [feature]: -1..1 } }
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
  "Linnea ticked off record shopping" is the nice bit. The one exception to editing
  is an **admin** (below) — and it is never an exception to *seeing*.
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
  ticking off is its own operation because *who* did it is part of the record. It
  can carry `ideaBy`, but only from the author and only through `SP.canCredit`
  (see *Whose idea*).
- **A PATCH neither sets nor loses `mod.watch`.** `mod` is replaced wholesale and the
  sheet sends only the slices a person types, so saving a note on a film used to
  take its poster with it. The route now carries the poster across (and still drops
  it on a rename or a change of kind); only `/watch` sets or clears it.
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

## Admins — correcting things, not reading them

`admins` in `config.local.json` is a list of user ids (`["link:andrew"]`). **There is
no route that grants it** — shell access to the box is the credential, the same as
minting a sign-in link — and it is read live, so adding or removing someone needs no
restart (the suite revokes it mid-run to prove that).

What it buys: **an admin has the author's full edit on anything they can already
SEE** — the words, the kind, the poster, the place, whose idea it was, who it is for,
and deleting it. A typo in Linnea's title, a film filed as a show, the wrong
"Obsession", a duplicate, her idea that was really his.

- **`SP.canEdit(item, uid, spaces, { admin })` calls `canSee` inside it.** Admin is a
  right to fix what is on your screen, never a key to anybody's private things. A
  private item of hers is the same 404 to an admin as to a stranger, and a test
  asserts *admin-can-edit ⇒ can-see* for every visibility, author, list and person.
  The rose is untouched — `pleasure.view()` knows nothing about admins.
- **Who it is for and whose idea it was were the author's alone at first**, and
  became an admin's too when he asked for full edit (`SP.canSetVisibility`,
  `SP.canCredit`, both `{ admin }` and both behind `canSee`). An admin can narrow or
  widen what is on his own screen; he still cannot reach past it. Making her item
  `private` makes it vanish from his screen too — that is the rule working.
- **The sheet asks the server**: the wire carries `canEdit`, `canSetVisibility` and
  `canCredit`, and the client shows a control only when its flag is true. None of
  them is worked out client-side.
- **`editedBy` records whose hand was last on the wording**, from the session, via
  `applyPatch(item, raw, now, by)`. The row still says it is Linnea's, so the sheet
  says *"edited by Andrew"* — otherwise an admin quietly puts words in her mouth.
- Only `=== true` counts; `{ admin: 'yes' }` is not an admin.

## Whose idea — credit, not ownership

Every kind tab's to-do list is **split by whose idea each thing was**: a heading
per person (`LINNEA'S IDEAS 2`, `YOUR IDEAS 6`), theirs first and yours last, over a
grid of posters on a shelf or plain rows elsewhere. "One of yours tonight, one of
mine next time" needs to be able to see which are which. A single heading is still
drawn when everything is one person's — "all four recipes are Linnea's" is exactly
the kind of thing this is for. A one-person list has no headings.

`item.ideaBy` is who it came from **when that is not the author** — Andrew holding
the phone while Linnea says "we should watch Obsession". The sheet's **Whose idea**
control (`Mine` / `Linnea's`) hands it over.

- **A label, not a right.** `authorId` is still who WROTE it, and every rule in
  `lib/spaces.js` keys on that; nothing reads `ideaBy` except `canCredit` and
  `ideaOf`. Crediting her does not let her edit it, and a private thing credited to
  her is still invisible to her. A property test runs every visibility, author,
  list, viewer and credited person and asserts each right reads the same with the
  credit as without it.
- **The author's to give, or an admin's** (`SP.canCredit`), and only ever to someone
  in the item's own list — a name outside it is refused and nothing in that PATCH
  lands. Creating cannot set it.
- **Crediting yourself clears it**, so "the author's own idea" is one state.
- **"Yours" is decided against who is signed in** (`S.wire.me.id`), not only the
  server's `ideaMine`, so her section stays above yours whatever the wire carries.
  It was first ordered by count, and on a wire without the flag that put his six
  films above her two.
- **A name on screen is one the viewer already knows** (`SP.nameable`). A public
  wish reaches everyone who shares a list with its author, so a credit to — or an
  admin's "edited by" from — one of the author's OTHER lists would introduce a
  stranger. Those fall back to the author and to nothing. The wire overrides the raw
  `ideaBy`/`editedBy` ids that `...it` would otherwise carry.
- Under a heading that says it was your idea, a row somebody else typed says
  **`via Linnea`**; the sheet says both halves ("added by you · Linnea's idea").
- `enter()` flattens each grid into its cards, so the stagger still runs over
  posters and not over whole sections.

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

**The invite signs you in by itself.** Those three properties are exactly a sign-in
link's (`lib/magic.js`), so the screen asks *What should Andrew call you?* and one tap
on **Join** (`POST /api/invite/:code/join {name}`) makes the account, puts it in the
list and sets the session. No identity provider is needed: the first invite sent
(Nov 18) landed on "Sign-in is not configured on this server yet", because there was
neither Google nor Access, in a restaurant. Google is still offered under the form when
it is configured.

- **The POST spends it, never the GET**, so a preview crawler cannot burn it; and a
  caller who is **already signed in is refused (409) without spending it**, so opening
  your own link to check it is safe.
- **The id is `link:<name>`**, the shape `tools/link.js` finds by name, so a person who
  joined this way can be sent a sign-in link for a new phone. **A name already taken
  gets a random tail** — the id is the account, and a second "Andrew" must never become
  the first one, or inherit his admin rights. Names are cleaned (`invites.cleanName`):
  no control, zero-width or bidi characters, 40 characters counted as characters.
- A full list is refused before anybody is made. A spent link says so and to ask for a
  new one.

## The Square — a tile in its ⊞ menu (`lib/square.js`)

**Do With is a linked app in the Square**, like Sing and SideQuest: the ⊞ menu there
has a **Do With** tile (two ticked rows, *to do, together*), and tapping it opens
Do With signed in as you. The tile is a link carrying a **pass** the Square signs
(its `lib/app-pass.js`); `GET /sso?t=` here checks it. Built Nov 18 at Andrew's ask,
"just like the Sing app".

- **The Square has no email on a person** — just a slug (`andrew`), a name, a
  colour, an avatar. So there is nothing to join on, and anything that matched
  automatically would be guessing whose lists it was opening. **The pass is the
  proof that was missing**: `{ v:1, aud:'dowith', iss:<building>, sub:<person id>,
  name, owner, iat, exp, jti }`, HMAC-SHA256 under a secret shared with Do With ONLY
  (`squareSecret` here, `dowithSecret` there), five minutes, single-use (`jti` kept
  in `state.squarePasses` until it would have expired anyway). A Sing pass does not
  open Do With, nor another building's this one (`squareTenant`, default `ava`).
- **Who it signs in** (`personFor`, pure): the account already linked to that Square
  person (`user.square = { tenant, id, at }`); else, if this browser is signed in as
  somebody not linked, it **asks** — *"This phone is signed in to Do With as Linnea.
  Is that you, Linnea from the Square?"* — because a shared browser would otherwise
  hand one person's Square to another's lists; else **a new account**, linked. The
  Square's members are let in by its owner, the same vouching an invite is, and an
  account with no lists sees nothing. Asking spends nothing; the POST behind the
  answer does.
- **Existing accounts are linked from the shell**: `node tools/square-link.js
  link:andrew andrew` (server stopped — it checks the port). On Nov 18 the accounts
  whose people were already in the Square were linked this way. One account per Square
  person.
- **The `owner` claim is ignored.** Admin here is `admins` in config and nothing else.
- **The secret is read live**: set it and the door exists; remove it and `/sso` is a
  404 at once. No secret, no door — and on the Square's side, no tile.
- The pass leaves the address bar with a 303 to `/`, under `Referrer-Policy:
  no-referrer` and `no-store`.
- The tile points at `https://dowith.guess-ai.app` (`DOWITH_URL` there), the address
  people already use, so it is the same cookie jar. `dowith.the-square.app` is in the
  tunnel config but does not resolve.

**Importing people and groups is still plumbing only**, and `importable()` still
refuses. The pass needs none of it — an id and a name arrive signed and the Square's
store is never opened for them.

- **Hard constraint:** the Square's store holds `messages`, `dms` and
  `groupMessages` — everybody's private conversations. A bridge reads `people` and
  `customGroups` and NOTHING else, read-only, projected down to id/name/avatar.
  This is the same data the trips agent sandbox `--tmpfs`es away; a convenience
  feature must not be the thing that walks it out of the building. There is a test
  that dumps the projection and asserts no message content survives.
- `squareStorePath` in config, not hardcoded — a bridge that assumes a sibling
  directory breaks the moment either app moves.

## Suggestions (`lib/suggest.js`, `itemfit.js`, `stations.js`, `transit.js`, `ideas.js`, `public/js/suggest.js`)

A sparkle button beside Calendar opens a view of its own (Andrew's ask, Nov 25–26). You
say **how much energy you have** on a slider and **when it is for** (Now, Tonight,
Tomorrow, or a day and time). It answers with:

- **A plan**: one thing after another (dinner, then something to watch), each piece
  with a **Swap**. *Carry on into the next day* adds a morning, an afternoon and a
  dinner, for the evening that turns into a sleepover.
- **Also good then**: the rest of the list, in order, each saying why.
- **Not then**: what is ruled out (closed at that hour, rained off), with the reason.
  Nothing is hidden silently.
- **New ideas**, on request: things not on the list yet.

Every row has a thumb up and a thumb down. **Put it on the calendar** gives each piece
of the plan its day and hour (`/when`).

### The screen: the plan first (Nov 27, `public/js/suggest.js`)

Redrawn at Andrew's ask, from six screenshots: the controls filled the first screen and
the plan started below the fold. **Client only.** The wire, the scorer and every route
are as they were.

- **What the plan is for is one row** (`#sgSum`): *Low energy · Now*, and under it
  *Into the next day · From Ballston-MU · Gluten-free*. It opens **Tune the plan**
  (`#sgTuneSheet`), which holds the slider, For when, Carry on, Starting from and What
  you eat. The sheet is **built once, when the app starts** (`buildTune`), for the old
  reason: a slider must not be redrawn under a thumb. Every change lands at once and the
  plan behind the sheet follows; there is nothing to save.
- **One sheet at a time.** Starting from and What you eat close the controls and open
  their own sheet, as the account sheet does for its Claude row.
- **Two days are a tab each** (`.sg-days`), with that day's weather on the tab (the
  range across its pieces). **Both days are drawn and a tap only shows the other**
  (`hidden` on `.sg-dayp`), so nothing is asked again and the suite can still read
  every slot. One day keeps its heading and the weather line above it.
- **A piece of the plan is a card** (`pieceHtml`), on a rail with a dot a piece. Its
  reasons are **one to a line, each with a mark** (tick, !, dot for good, bad, note).
  The rows under *Also good then* keep their one dotted line (`rowHtml`): a list wants
  the density, a plan of three wants to be read.
- **A journey is said once when it is the same for everybody** (`transitHtml`):
  *25 min each*, with the lines once. Different journeys are still one each.
- **A holiday is said once over the day** (`.sg-hol`), not on every place. It is lifted
  from the scorer's own note by its words (`MAY_DIFFER`), so if those words change the
  note is simply on each piece again. *Also good then* and *Not then* still say it per
  row. **No fixture covers this yet.**
- **Not then says when a thing IS in the plan**: *In tomorrow's plan*. The garden rained
  off today and planned for tomorrow morning read as a contradiction.
- **Thumbs and Swap are where they were.** A mockup traded the thumb down for a "why
  not" in Swap; a thumb down already means "not tonight" (it fades), so nothing changed.

### The scorer is pure, and every weight says why

`suggest.score(item, ctx)` weighs one thing for one moment. The routes gather the facts
and the client draws what it is sent, the `kitchen.match` rule again. The weights are one
table (`W`), and each one that moves a thing has words the screen shows:

- **Energy.** An exact match is best. Each level a thing asks beyond what you have costs
  a lot (*Takes more than you've got*); each level to spare costs a little.
- **The part of the day** (*More of a morning or afternoon thing*), and a long thing
  late at night.
- **The weather at that hour.** A place with a weather profile is judged by it
  (`placefit.judge`): *Weather's against it · rain* rules it out. Everything else goes by
  its `weather` field: *Nice out for it*, *Wet then* (ruled out), *55% chance of rain*,
  *Good for a wet one*.
- **Open or closed then** (`hours.openAt`): *Closed then · opens 9 PM* rules it out.
- **The journey**, for whoever has furthest to come: *Close by*, *A trek · 70 min for
  Linnea*. When you are tired, a long trip costs more.
- **On the calendar, at its own hour.** *Planned for then · 6:30 PM* only within 90
  minutes of the hour asked about; at another hour of that day it is a note, *Planned
  for 6:30 PM*. A day with no hour is *Planned for that day*.
- A show you are **in the middle of** (*Keep going · S2 E3*), a recipe you **have
  everything for**.
- **What the list eats** (*Has flour · swap for gluten-free*), below.
- **Thumbs**, below.

`rank` then spreads the top of the list across kinds, so it is not eight films in a row.

**A reason against a thing is a flag, not only a number** (Nov 26). Andrew, with two
screenshots: "recommendations that were clearly weather inappropriate or more of an
evening thing for lunch". Both were the weights working as written: a garden's −18 for
rain lost to +30 for being on the calendar, and on a short list the best of a bad lot
still wins. So `score` returns two flags beside the number:

- **`hidden`: ruled out for then.** Closed; a place whose own profile says this weather
  spoils it, **whatever part of it is under a roof** (only wholly outdoor places were
  ruled out at first, and a garden with a glasshouse stayed in); anything that needs good
  weather in an hour that is wet. These go to *Not then*, with the reason.
- **`wrong`: it has a reason against it**, the kind the screen draws in coral: the wrong
  part of the day, more than you have in you, a trek, built around what the list does not
  eat, a coin-toss chance of rain. Set in one place (`say`), so a new coral reason cannot
  forget to. Such a reason is always among the three shown.
- **In the list, what is flagged comes after everything that is not**, whatever the
  numbers. **A plan never picks either by itself** (below).
- **A wet hour is rain** (`placefit.judge`, `WET_PCT` 70). A profile says *rain*; the
  hour's code said *dense drizzle*, at 100%, and the garden was "not quite the weather".
  At 70% or more, a place that avoids rain is spoiled (*rain likely*), on a place's page
  too. `suggest.wet` is the same line for things with no profile; 50–69% is said and not
  ruled out.

### A plan is slots, each weighed for its own hour

`slotsFor(start, { through })` gives the parts of the day still ahead, each with a role:
*Dinner@19:00, Evening@21:00*, and with `through` *Morning@11:00, Afternoon@14:30,
Dinner@18:30* the next day. They are a template, not a schedule, so the screen says
"around 7 PM". `plan()` fills each slot with the best thing of that role **for that
slot's hour** (its weather, its opening hours, its journey), never the same thing twice,
and keeps up to six runners-up for Swap.

- **Never the best of a bad lot.** A slot takes the best thing that is neither `hidden`
  nor `wrong`. With nothing clean it is empty and says so (*Nothing on your list for a
  meal then* · **Get ideas**), and what there is waits in Swap, flagged, for a person to
  choose. An evening recipe is not lunch because it was the only recipe.
- **What is on the calendar keeps its own hour** (`holds`). A thing planned for an hour
  belongs to the part of that day nearest it, of its own role, within three hours. It is
  offered **nowhere else**: not at lunch, and not the night before. That slot **takes the
  plan's hour as its own** (*Dinner · at 6:30 PM*), so the weather, the hours and the
  runners-up are all for 6:30. The first cut gave the bonus to any hour of the day, so the
  first slot it reached took it, and *Put it on the calendar* would then have moved it
  there.
  - The wire says `planned`. **The button writes only the rest** (*Put the rest on the
    calendar*; *All of this is on the calendar* when there is nothing to add).
  - **Ruled out now** (closed, rained off), it is `bumped`: said in its slot (*… is on the
    calendar for then · Weather's against it · rain*), with the best clean thing offered
    under it, and still first in Swap for anyone going anyway. A reason that is only
    `wrong` does not bump it: they chose that hour.
  - Planned for a day with no hour, it may go in any part of that day and no other.
    Planned for before the plan starts, or for an hour no part of the day covers, it is in
    no slot.
- **A piece you chose stays put** (`keep=s1:<id>`), and the rest is fitted round it.
- **Over two days, one dinner out and one cooked** (`W.otherDinner`).
- **The next day assumes you are rested**: its energy is at least "okay".
- A thumb down on a piece makes room for the next one.
- Swap offers the runners-up **From your list** and **Something new**: ideas of that
  role only, added to the list and used in one tap.

### What a thing asks of you (`item.fit`, by Opus 5.5)

Every item gets a profile: its **role** (eat, drink, watch, do), **energy** 1–5,
minutes, home or out, the parts of the day it suits, what weather does to it
(`needs_good`, `better_when_bad`, `any`), and, for food and drink, what it is **built
around** (wheat, dairy, meat… see *What a list eats*). This is the "same manner" Andrew asked for,
for films and shows as well as places.

- **Batched, twenty a call**, in the background, when Suggestions opens. Only what the
  person asking can see is sent: a private film of hers waits for a request of her own.
  **Title, kind and public facts go** (a film's year, what OSM calls a place, a recipe's
  time). **Notes never do.**
- **Until it arrives, `fitOf` answers from the kind** (`rough`): a film is low energy,
  at home, in the evening. So it works on day one, with no key at all.
- `of` is the kind and title it was made for. Reword it and it is made again. A PATCH can
  neither set nor lose it. A gate (`cleanFit`, `cleanBatch`) stands between Claude and the
  store.

### What a list eats (`lib/diet.js`)

Added Nov 26, so that a list which keeps to a way of eating is not offered what breaks
it. The Suggestions controls have a **What you eat** row. Its sheet has ten rules
(gluten-free, dairy-free, vegetarian, vegan, pescatarian, nut-free, egg-free, no
shellfish, no pork, no alcohol) and a switch, **It's medical**, for celiac and allergies.

- **A rule of the LIST, not a fact about a person.** `space.diet = { must, strict, by,
  at }`. Anyone on the list sets it, everyone on it sees it, and it names nobody: "this
  list eats gluten-free", never who. A diet kept per person would be a new audience (it
  says something about somebody's health) and would need the kitchen's narrow rule. On the
  list it goes exactly as far as the list's name does. `by` records whose hand.
- **An id this server does not know is refused whole** (400), not dropped. A rule you
  asked for and did not get is worse than an error. `diet.of()` checks again on the way
  out, so a store edited by hand cannot make a rule there is no table for.
- **Nothing here can know a restaurant is safe, so nothing says so.** Three kinds of
  thing are said, and each names where it came from:
  - **A recipe's own lines** (`scan`): *Has flour, soy sauce · swap for gluten-free*.
    Judged **as it will be cooked**: a swapped line is what went in instead, so
    gluten-free pastry clears the pastry. It is a caution list that errs toward flagging,
    and it knows almond flour is not flour, tamari is not soy sauce and peanut butter is
    not butter. A line it does not flag has not been checked, and the screen never says
    it has.
  - **What a thing is built around** (`item.fit.built`, below): *Built around wheat · ask
    what's gluten-free*. Claude's coarse profile, used when there are no lines. Only ever
    a caution.
  - **What OpenStreetMap's mappers recorded** (`diet:gluten_free=yes|only|limited|no`,
    read by `geo.shapeDetails`): *Gluten-free options, says OpenStreetMap*. The one source
    of anything positive, quoted as theirs, and it outranks a guess from a name.
- **Nothing is hidden for it.** A caution lowers a thing and says why (`W.diet`, ×1.5
  when strict); *Not then* stays about the hour. The reason is always on the row, however
  little it weighs (`keep`), so it cannot lose its place to *Close by*.
- **`built` is asked the same of every list.** What a list eats is never sent with the
  profile: the profile says "wheat, pork", and the rule is applied here. Adding it bumped
  the profile key; an earlier profile is still used for the same words (`usable`) while
  its replacement is made, so a list does not fall back to guesses for a minute.
- **New ideas** are asked for with the rule (*They eat: gluten-free — STRICTLY. It is
  medical…*). Every idea to eat or drink must say **how** it keeps to it (`keeps`:
  "naturally gluten-free", "dedicated gluten-free kitchen"). The gate drops one that does
  not say, and one whose own title names what they do not eat with nothing promising
  otherwise (a ramen bar, a brewery tour). A film called *Bread and Roses* is a film.
  The screen shows `keeps` and, once, *Ask a place before you order*.
- **Recipe swaps keep to it too.** The server adds the recipe's own list's rule to *It
  has to be*, whatever the phone sent, and says when it is medical. Only for somebody on
  that list: a public recipe seen from another list does not carry the rule out with it.
  The swap sheet shows it as a chip with no ×, because it is changed where it was set.
- **The connector says it** (`list_lists`: *What this list eats: gluten-free — strictly*).
  It is on its members' screens, and anything asked to pick dinner from the list ought to
  know it.
- **What goes to Anthropic:** the rule's words and whether it is medical, with ideas and
  swaps. Nobody's name, and no condition beyond "celiac or an allergy".

### Stations — a new audience, so one narrow rule (`lib/stations.js`)

**Each person's location is a station they choose, never where the phone is.** That was
Andrew's answer to the location check in the backlog: "Let me set each person's location
as like a nearest subway station(s)". Up to three each.

- **Who may see or set one is the kitchen's rule**, for the kitchen's reason, because it
  says something about where you live: **yourself and anyone you share a PAIR list
  with**. A group co-member gets 404, a stranger gets 404, and the suite has the truth
  table. A partner may set yours (`by` records whose hand).
- In a group list, somebody whose station you may not see is `null`: not "none set",
  which would itself be saying something.
- The picker searches Transitous (`/api/transit/stops`), rail before bus stops.

### Journeys (`lib/transit.js`)

**Transitous** (transitous.org): a free, keyless, community-run planner over public
timetables. Checked on Nov 25: it knows the Metro's lines and colours.

- **What is sent:** a station's coordinates, a place's coordinates and a time.
- **One journey per person, per pinned place, per day of the plan**, cached six hours by
  the half hour it leaves in, four at a time. A failure is not remembered.
- **Under about 900 m is a walk** and is not asked about ("about 6 min walk").
- No zone from the phone means no instant, so no journeys.
- `transitEndpoint` in config points it at a stand-in for the suites.

### Nothing waits for other people's servers

Weather, opening hours and journeys are all somebody else's. `GET /suggest` uses what is
cached, starts the rest, and says `pending`. The client asks again (up to seven times)
and the answer sharpens in place. `profiling` says Claude is still describing the list.

### Thumbs (`state.taste[spaceId][uid]`)

- **A thumb on a thing fades** (half-life three weeks): "not tonight" is not "never".
- **It teaches leanings** (`featuresOf`): toward a kind, toward staying in, toward low
  effort, toward films in the evening. One thumb moves each by a step, bounded at ±1.
  Changing your mind moves them by the difference, and taking it back leaves nothing.
- **Yours alone on the wire.** The response carries your own thumb and nobody else's.
  It still counts toward what the list suggests for everyone on it, because the
  question is "what should we do". Leaving a list takes your thumbs with you.

### New ideas (`lib/ideas.js`)

Asked of Opus 5.5 only when somebody taps, 12 an hour per person. **It is told more than
a swap is**, so it is said plainly: when it is for, the energy, the weather then, the
**names** of the stations people start from (never coordinates), the titles on the list,
and what was thumbed up or down. Never anybody's name, notes, or a private thing the
asker cannot see.

- The gate drops an idea already on the list (emoji-insensitive), one passed on, a
  repeat, a kind that is not one, and anything that is not the role asked for.
- The prompt says to name a real place only when confident, and otherwise to describe
  the kind of place. A place idea is added as words, and gets a pin when a person picks
  it on the map.
- Not labelled as AI: the section is *New ideas*.

### Suggest nearby, on a place's page (Nov 27, `public/js/pl.js`)

Andrew's ask: "a suggest nearby button on location detail page". A pinned place's page
has **Suggest nearby** under its hours. It answers in the page, not in a sheet over a
sheet, with the two halves Swap has:

- **On your list, close by**: the other places still to go within 2 km of this pin,
  closest first, at most five, each *0.2 mi · about 4 min walk* (as the crow flies, so
  "about"). Arithmetic over pins the phone already has: no request, and it works with no
  key. A tap opens that place's page.
- **Something new**: asked of Opus 5.5 when the button is tapped, never before
  (`ideas.suggest`, with `near`). Same route, same hourly limit, same gate, same *Add to
  Places*. It is asked for **the day and hour the place is planned for** when that is
  still to come, and otherwise for now on the phone's clock, with the energy the
  Suggestions slider was last left at.
  - **What goes to Anthropic on top of an ordinary ask: the place's name, what
    OpenStreetMap calls it, and its area.** That is what its weather profile already
    sends. **Never its pin.**
  - **`near` is an item id, and the server looks it up among what the asker can see**
    (`SP.visibleIn`). One they cannot see is a 404; one with no place is a 400. Both are
    refused **before** one of the hour's asks is spent, and before Claude is called.
  - **Only somewhere to go or something to do comes back** (`NEAR_KINDS`): the gate drops
    films, shows, recipes and the place itself, whatever the model says.
- **With no key and nothing close on the list, there is no button.** With no key and
  something close, the button shows those and steps aside.
- A place with no pin has nothing to be near: no button until it is on the map.

## The Claude connector (`lib/connector.js`, `lib/oauth.js`, `public/js/connect.js`)

**Claude can read your lists.** Do With is an MCP server at `/mcp`. Add
`https://dowith.guess-ai.app/mcp` in Claude (Settings → Connectors → Add custom
connector), tap Connect, then Allow, and Claude can answer "what's on our list?", "what's
planned this week?" or "which films are on Netflix?". Built Nov 25 at Andrew's ask: "know what's
on my list at all times". The account sheet's **Claude** row has the address, a code, and
Disconnect.

- **It shows what you would see, and nothing else.** The routes build its view with the
  same `spaceWire`/`itemWire` over `SP.visibleIn` that the screens use (`connectorView`),
  so a private item of hers is as absent from his Claude as from his phone. The suite
  checks that from both sides. **The rose, today's question and kitchens are never
  read**: each has its own rules about who may know what, and "Claude asked" is not one
  of them.
- **Read only.** One scope (`lists:read`) and three tools: `list_lists`,
  `get_list_items` (by list, kind, to do/done, words) and `coming_up`. Each is
  `readOnlyHint`. Results are plain text, cut at 100k characters (claude.ai takes about 150k).
- **It is a third party, knowingly.** Connecting sends what you see, including Linnea's
  shared items in your lists, to Claude. That is your choice to make about your screen,
  like TMDB and Nominatim seeing titles and places. It is not on by default for anybody.
- **The protocol:** Streamable HTTP with plain JSON, stateless. A notification gets 202;
  GET and DELETE get 405. Versions are 2025-11-25 back to 2024-11-05, answering with the
  one asked for. An `Origin` that is not Claude's or this site's gets 403, and a session
  cookie is not a way in: bearer only.

**The door is OAuth 2.1, hand-rolled** like the rest (`lib/oauth.js`, pure):

- **Discovery** works the way Claude does it. A 401 carries `WWW-Authenticate: Bearer
  resource_metadata=…`. Then come `/.well-known/oauth-protected-resource[/mcp]` (whose
  `resource` is the `/mcp` URL exactly) and `/.well-known/oauth-authorization-server`
  (S256, `none`, a `registration_endpoint`).
- **Claude registers itself (RFC 7591) as a public client.** PKCE is the proof, and no
  secret is ever issued. A client may register only Claude's callback
  (`https://claude.ai/api/mcp/auth_callback`) or a loopback address on any port (Claude
  Code). An approval that could go to any site would be a phishing kit with this domain's
  name on it. Registration is open, so it is capped: 30 an hour per address, 200 in all,
  and idle clients go after a day. `connectorRedirects` in config adds an exact callback
  if another client ever needs one.
- **Allow** (`/oauth/authorize`):
  - A signed-in browser says as whom, and taps Allow. One that is not signed in asks for
    a **code from the phone**: account → Claude → Get a code, eight characters with no
    I/L/O/0/1, in memory, ten minutes, once. Ten wrong guesses per address, or a hundred
    in all, per quarter hour blocks the rest. On a desktop browser nobody has signed into,
    that code is the only way in.
  - The form carries the request **signed** (`sealTxn`, with a purpose label), so the
    POST approves exactly what the page showed.
  - A POST from another `Origin` is refused, and the page cannot be framed. The page is
    `Referrer-Policy: same-origin`, **never `no-referrer`**. Under no-referrer a browser
    sends `Origin: null` with the form, and the first real connect (Nov 25) was refused
    with "That didn't come from this page". The suite's fetches set Origin by hand, so
    only the header test catches it.
  - An unknown client, or a redirect it never registered, is shown and never followed.
- **Tokens** are opaque. **The store keeps only their SHA-256** (`state.oauth.grants`), so
  a copy of store.json is not anybody's access.
  - An access token lasts an hour. Claude refreshes ahead of that.
  - A refresh token lasts sixty days and **rotates**: the old pair dies in the same
    breath the new one is handed over.
  - An authorization code lasts a minute, lives only in memory, and is spent by any
    attempt, a failed one included.
  - Disconnect deletes the grant, and the next call is a 401.
- **The address** is `publicUrl` in config if set. Otherwise it comes from the request,
  which behind the tunnel is https because `trust proxy` is on.
- **Claude's calls come from Anthropic's cloud** (`160.79.104.0/21`, IPv4 only), so the
  host has to be public. It is, through the tunnel.

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

### Safari 26+ reads your CSS to decide what to paint at the edges

Liquid Glass tints the status bar and the bottom chin by **sampling the page**, and
`theme-color` is ignored for it. Two rules fall out, and this app broke both on a real
phone before anybody knew they existed:

- **The root must never be transparent.** `viewport-fit=cover` extends the page behind
  the chin, and when `html` has no background Safari fills that strip with its own
  fallback — black in dark mode. It read as ~100pt of dead space under the tab bar. The
  colour was on `body` and on `.screen`; the one element Safari falls back to was the
  one with nothing on it. `html` now carries it too, plus `color-scheme: dark`, which
  is what tells the system which way to fall back before it has sampled anything.
- **A fixed element near an edge gets sampled**, and its `background-color` or
  `backdrop-filter` becomes the tint. `.screen` is absolute inside a fixed `#app`,
  carried the page colour, and sat within 4px of the top — so the masthead came out
  under a blurred band. The fixed layer now carries nothing; `.composer` and `.kindnav`
  lost theirs too, which cost nothing because they are flex *siblings* of the scroller
  and nothing ever passed under them.

A first pass at the dead space blamed `100dvh` under-reporting and measured the visual
viewport instead. **That was the wrong diagnosis** — both report the same height here,
because the page really is that tall and Safari draws its own bar beneath it. The
measurement was kept (it is correct, and it fixes a real iOS case in the trips app)
but it is not what this was.

Sources, since Apple documented none of it:
[Safari 26 Liquid Glass on the web](https://1ar.io/updates/safari-26-liquid-glass-web/) ·
[theme-color and fixed elements](https://benfrain.com/ios26-safari-theme-color-tab-tinting-with-fixed-position-elements/)

**iOS 26 draws a home-screen app SHORT of the screen, and nothing can paint below
that.** The readout settled it, on an iPhone 16 Pro Max in standalone:

| screen | window | html | `#app` (inset:0) | vh | lvh | svh | dvh | insets t/b |
|---|---|---|---|---|---|---|---|---|
| 956 | 894 | 894 | 0→894 | 956 | 956 | 894 | 894 | 62 / 34 |

The web view is drawn 0→894 and the bottom 62pt belong to the system. Sizing `#app`
to `100lvh` was tried: the readout said 0→956 and the tab bar came out **clipped
through its icons at 894**, sheet backdrop included. So the short viewport is the
real paintable area, not a number being misreported.

What can be done: `#app` stays `inset:0`, and when the viewport stops short of the
screen, the `short-vp` class on `<html>` sets `--safe-b:0px`. That edge is 62pt from
the home indicator, so the 34pt of padding was just more dead space. An inline
`<script>` in `<head>` sets the class before first paint, orientation-aware, because
iOS never swaps `screen.width`/`height`. The band under the bar that remains is the
system's.

The wrong theories, kept so nobody re-tries them: *"`100dvh` under-reports"*;
*"the root is transparent"* (true and worth fixing, but not this); *"`inset:0` fills
the screen"*; *"the bottom inset comes back at ~97pt, clamp it to 34"* (it was an
honest 34 and the clamp changed nothing); and *"size it to `100lvh`"* (it got clipped).
The first four were inferred from photographs. **Measure before changing the layout** — and the readout below exists
so you can.

There *was* a readout in the account sheet (screen, viewport, insets) and a "Show taps"
overlay; both were removed at the user's request once the layout settled. If a layout
bug comes back, put a temporary one back and **measure** — `git log -S paintMetrics`.


**The app lands IN your first list, not on the shelf of lists.** Almost everybody has
one and will for a long time, so the shelf was a screen you tapped through on the way
to the only place you were ever going. The back arrow still reaches it — the common
case is free and the rare one costs a tap, rather than the other way about.

### The redesign (Nov 17) — what makes it read as current

From the design handoff on the `design/redesign` branch (`design/redesign/HANDOFF.md`,
mockups in `screens/`). Five rules did most of it, and they hold everywhere:

1. **Serif for display only** — the list's name, "Do With", sheet titles, a place's
   title, a poster-less card. Rows, labels, chips and buttons are `--sans`; a row title
   is 16.5px/500. A whole list set in 17px serif was most of what read as 2015.
2. **Rows sit in rounded cards** (`.group`, `--r-card`) with hairlines inset to start
   after the emoji tile. A section's rows are one card; a month's in the record too.
3. **Sentence-case labels.** No more uppercase-and-tracking: field labels, months and
   section headings are 13.5–15px/600.
4. **Bottom sheets, not centred modals.** Every `.modal` rises from the bottom with a
   grabber and a 44px **X** in its header; the stacked `Cancel` / `Close` / `Not now`
   ghosts are gone. The X keeps the old button's id (`isCancel`, `meCancel`…) so every
   close handler survived, and **a tap on any sheet's scrim clicks its X** (app.js), so
   whatever closing that sheet does — forget a share, repaint the rose's dot — happens
   whichever way you leave. **Pulling a sheet down by its grabber closes it the same
   way**, and a sheet falls away when it closes rather than blinking out (see *Motion
   and touch*).
5. **44px minimum hit targets** (`--tap`). The tick is 26px to look at and 48px to hit:
   its `::after` is the hit area, and a pseudo-element is part of the button.

**The header** is back on the left, the rose on the right, and under them, left-aligned,
"To do with" and the name in the serif at 34px — still the button into the list's
settings. **The control row** under it: the count on the left in the tab's own verb
(`5 to do`, `8 to watch`, `6 to go`, `4 to make`), and the chips on the right.

**A row** is `[emoji tile] [title / one line of meta] [ring]`. The tile holds the
title's **leading emoji** — `leadEmoji()` in util.js, ZWJ sequences, skin tones and
flags included — or the kind's icon when there is none. **Presentation only**: the
stored title is never touched, the edit field shows the whole string, and a title typed
with no space (`🏃‍♀️Go for a run`) lines up like the rest. The ring is on the
**right**, the thumb side; every celebration rule is relative to `.tick`, so the
animation moved with it. The meta is one 13px line of words separated by dots, not a
row of pills.

**The `[hidden]` trap is settled globally**: `[hidden]{display:none !important}`. It
had fired three times (`.kindnav`, `.items`, the sheet's fields). The suite still
asserts by layout, because a more specific rule can always win. **One rule wins on
purpose**: `.modal.leaving[hidden]` keeps a closing sheet drawn for 0.22 s while it
falls (see *Motion and touch*). It applies only while `.leaving` is on, which a timer
takes off.

**Class names are global — again.** The account's grouped rows were first called
`.card` and every poster on the shelf grew a box behind it. They are `.box`.

Above the list there is **one small toggle, `Done together`** — not a tab bar — and it
is now **its sage check icon and its count only**, with the words as its
`aria-label` (`"Done together, 9"`). On a narrow phone the words were what wrapped.

- **"To do" was a tab for the state you were already in.** The count that mattered was
  never on it either; the list underneath is the count.
- **There is no Map chip.** There was one — a cross-kind Map view at the left end
  of the chips, once something had a place — and it went when the Places tab became
  the map (Nov 17): a second, lesser map of the same places was one way too many in.

**The composer shows who a new thing is for only once you start typing.** Visibility is
a question about the thing being written, so it has no business being on screen before
there is one — and the list gets two rows of height back for the whole time you are not
typing. It appears on the first keystroke and goes again when the box is empty. It is
three equal segments that say what they mean — `Just me · only you`, `Us · you and
Linnea` (in a pair it names them; in a group, "this list"), `Anyone · all your people`.
The composer is one 52px pill with the **+ inside it**, tinted while empty and filled
once there is something to add.

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
- **The count is part of the LABEL.** Three goes at this. A filled pill on all five
  tabs turned a calm bar into a notification centre — a badge means "something needs
  clearing", and four films waiting is not an alert, it is just how many there are.
  Dropping the fill fixed that but left a numeral hanging beside each icon with nothing
  to attach it to: on the active tab the pill anchored it, on the other four it floated
  between tabs and read as belonging to neither. Beside the word it counts it needs no
  anchor at all — `Films 4`, one step dimmer.

**Switching tabs moves.** The marker is ONE element (`.pill`) that travels to the
new icon, stretching toward where it is going and settling with a small overshoot.
The icon gives a spring, and the list's rows arrive from the side you moved toward,
staggered (the Done toggle makes them rise instead, because that is a change of
state, not a step sideways). It is **entrance-only and the render stays
synchronous**, so the DOM is final the instant a tap lands — the suite clicks a tab
and asserts at once, and motion must never be a gate in front of a correct screen.
`renderNav()` rewrites the bar on every render, so `pillX` is what carries the
marker from where it was. Reduced motion gets none of it.

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

**Choosing which one tidies the title** (`watch.tidyTitle`, Nov 26). A shelf could say
*Parks and*, *Sopranos* and *Halt and catch fire* under the right posters, because a row
kept whatever was typed. Now `POST /watch` rewrites the title when it is **the same words**:
the same once folded, a beginning of the real title, or the real title without its
article, accents aside (*Amelie* is *Amélie*). A leading emoji stays, and a year typed to
say which one goes.

- **In its own alphabet** (Andrew: "casing to be fixed and Cyrillic as well"). Say *Ei
  sosedi* was typed by ear on a Latin keyboard for a show whose own title is *Эй,
  соседи!* and which TMDB files as *Hey, Neighbours!*. `detail()` returns TMDB's
  `original_name`, and a title that is that one transliterated (compared as a loose
  `skeleton`: y/j/i, kh/h, yo/e) or lower-cased in its own alphabet becomes **the
  original**, not the English name nobody here calls it. The original is used at the
  moment of choosing and is not stored. A shorter or differently-cased form counts too
  (`stems`): *Slon gektor* becomes *Приключения слона Гектора*, when that is TMDB's title.
  (The examples here and in the suite are invented, not anybody's shelf.)
- **A name of your own is left alone**: *Our Sunday thing* is not a typo for anything.
- When the hand is not the author's (an admin), `editedBy` says so. The bulk backfill
  never renames: nobody chose.
- The escapes in these regexes (`\u0400-\u04ff`) must stay escapes. Twice this session a
  tool turned them into literal invisible characters in the source.

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
  decoration comes off: a trailing year, and leading or trailing symbols. A list
  is full of titles like `🦆 Ducktales`, and sending that verbatim returns
  nothing — it was the one miss in the first seven.
- **Providers are sorted by TMDB's `display_priority`, where ZERO is best.** Reading it
  with `Number(x) || 999` treats a legitimate 0 as missing and buries the most relevant
  service; it put Netflix fourth behind two live-TV resellers. Same falsy-zero trap as
  everywhere else. A tier of something already listed is then dropped — "Netflix" plus
  "Netflix Standard with Ads" is one service twice, and on a card with room for four
  that costs a real one.
- **A logo tile carries a hairline ring.** The handoff saw a "gap" in one film's
  row and asked for a missing-image fallback — which already existed. It was
  never a missing image: Apple TV's logo is a black tile, and on a dark card a black
  tile with no edge is a hole. **Measure the thing before fixing the theory.**
- **Tiers are folded on the way OUT too** (`watch.dedupeServices` in `itemWire`). A
  film looked up before the tier rule still had "Paramount Plus Premium" *and*
  "Essential" on disk; the store is not rewritten for a presentation rule.
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

## A show's seasons and episodes (`lib/episodes.js`, `public/js/eps.js`)

Added Nov 25 at Andrew's ask. A show pinned to TMDB has an **Episodes** section in its
sheet:
- a **Next up** card: *S2 · E3 · "its name"* with **Watched it**
- a chip per season, with *3/10*
- the season as a row per episode: its number in a ring to tick, and **its title**
  (Andrew asked for the titles: a title is how anybody remembers where they got to)
- *Mark season 2 watched*

The shelf shows how far you are: a hairline along the bottom of the poster, beside the
tick, and *S2 E3 next* under the title.

- **One record per show, not per person.** You watch it together, so the progress is
  the list's, like ticking off. Anyone who can see the show may tick an episode (the
  `complete` right).
- **Only aired episodes count.** Specials (season 0) are left out. An announced episode
  is drawn dashed and cannot be ticked. TMDB's `last_episode_to_air` says where airing
  has got to.
- **The last episode of a show that has ENDED finishes it.** The server ticks the item
  off, as whoever ticked that episode, and the usual "finished" nudge goes out. A show
  still running (`Returning Series`, or a next episode scheduled) is *All caught up*
  instead, and stays on the shelf, because a new season is what you would keep it there
  for.
- **The season you chose is where you are** (`rec.season`, Andrew's ask: "in case you
  wanna skip whole seasons"). Tapping a season chip keeps that choice on the server, for
  both of you, and ticks nothing. *Next up* is the first unwatched episode from that
  season ON, so starting at season 3 says *S3 E1*, and the shelf's *next* agrees. The
  selection stays put after you watch an episode. It only moves when *Watched it* was
  an episode of the following season.
  - **Skipped seasons, then the last episode:** not every episode is seen, so the show
    does not finish itself. The card says *You've reached the end* with **Finish the
    show**, which ticks it off and plays the same finale.
- **The ordinary tick still finishes a show at any point**, seen it all or not.
  Un-ticking an episode of a finished show does not un-finish it.
- **The finale** (`finale()` in space.js). The sheet closes. The poster lifts and glows,
  a shine runs across it, **SEEN IT ALL** lands like a rubber stamp, and fourteen sparks
  go out. Then it flies into the Done together toggle, the shelf closes up behind it, and
  the count springs.
  - **A fixed copy flies, not the card.** The shelf scrolls in its own box, which clipped
    the real card at its top edge. Nothing replays on the copy (`.flying`).
  - Reduced motion gets the state. The browser check catches it mid-flight, and then
    checks that the poster has gone and the show is done.
- **Stored** as `item.episodes = { of, seen, show, by, at }`, beside `visit` and set only
  by `POST /api/item/:id/episodes`, so a PATCH can neither set nor lose it.
  - `show` is a snapshot of TMDB's seasons, so the shelf can draw progress without
    asking TMDB per poster. The sheet's `GET /show` refreshes it, cached six hours in
    memory, with episode names a day.
  - `of` is the TMDB id. Pin the item to another show and its episodes go.
  - The wire carries `progress` only, never the whole record.
- `tmdbEndpoint` in config points TMDB at a stand-in, for the suites.

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
  after it finishes would pass just as well with no animation at all. **It asserts
  what is DRAWN** — running animations, the ring's computed colour — not what is in
  the DOM: for a while posters and recipe cards got the class and the sparks with no
  rule to draw them (every selector was `.it.celebrating`), so a film ticked off sat
  still for 0.7 s and vanished, and a DOM-only check passed.
- **Posters and recipe cards** get the same beats shaped for a tile: the ring fills
  and draws its mark, the sparks go out, the art steps back the way a seen poster does,
  and the tile shrinks away. A grid cell has no height to collapse, so instead the
  tiles that stay **glide from where they were** (`closeUp`, first-last-invert-play).
  The tile rules sit after the shelf's own, which they have to beat on ties.
- **A tile's mark is shown once done.** The shared `.tick svg path` hides the mark
  until it is drawn on, and only rows ever put it back — a seen film was a sage disc
  with nothing in it, and an unseen one lost its faint hint.
- **The Done together count gives a small spring** once the list has closed up
  (`doneLanded()`), so the row that left has somewhere it went to. Made it does the same.
- **Made it and We went here get the same moment** (below): they are this app's other
  two ways of finishing something, and both used to end in a toast or a plain redraw.

## Motion and touch (`public/js/motion.js`, `util.js`)

Added Nov 18 as one pass. **Every piece is decoration over a screen that is already
correct.** State changes are synchronous and final before any animation runs, nothing
that changes state awaits an animation, and reduced motion gets the state with none of
the motion. Haptics are the exception: they are not motion, and the phone's own setting
governs them.

- **Sheets fall away when they close.** `closeSheet` sets `hidden` at once, so the app
  and the suite read a closed sheet as closed the moment it returns. What you see is
  `.leaving`: the sheet stays drawn for 0.22 s, takes no taps, and slides down from
  wherever it was while the scrim clears. A timer takes the class off. A sheet can be
  closed by two routes in one tap (its own scrim handler and the shared one through its
  X); **the second call returns early**, or it would cut the first one's exit short.
  The scrim also fades in now.
- **Pull a sheet down to close it** (`sheetDrag`). Below a third of the way it springs
  back; past a third, or with a flick, it closes **through its own X**, like a tap on
  the scrim. It uses **touch events, not pointer events**, so the page can keep
  scrolling. **The first move decides**: down, with nothing above it to scroll back to,
  and the drag is the sheet's. After that it calls `preventDefault`; a later one is too
  late on a phone that has already started scrolling. The sheet follows from where the
  finger went DOWN: Chrome holds back moves inside its touch slop, and measuring from
  the first move left the sheet that far behind the finger. Fields, the rose's deck and
  any map that pans are left to their own gestures.
- **Moving between screens** (`showScreen`) is still a synchronous switch of `.active`.
  The screen you left keeps `.leaving` for about 0.12 s, fading out the way you came,
  while the new one fades in from the other side. Going deeper (list → kitchen, cook,
  Made it) comes from the right; going back comes from the left (`DEPTH` in util.js).
  It is **two short fades, not a slide-over**, because a `.screen` carries no
  background of its own (see the Safari 26 note) and a fade does not need one.
- **Coming back to the app refreshes the open list.** It used to repaint only the
  shelf (`if (S.spaceId) return`), so a list left open on the phone showed none of
  Linnea's additions until you left it and came back. Now `refresh({ arrived: true })`
  runs, and **what is new since the last draw glows as it lands** (`.arrived`, an
  overlay on the row, poster or card). Something new on another tab springs that tab's
  count instead. The refresh is skipped while a row is mid-celebration, since a repaint
  would destroy it.
- **Made it is a moment.** Reaching it from the last step springs the badge, draws its
  mark and bursts eight sparks, and the rest of the page rises in behind it. **Done
  answers where you tapped**: it turns sage and says Saved, then the screen goes back
  to the list and the Done together count springs. The `Made it · Nov 17` toast is gone.
- **We went here is a moment.** The button fills sage and its ring bursts. The page
  then turns into the record: the **Been together** card blooms in, its chips arrive
  one by one, and the sheet glides up to it, because "would you go back?" is the next
  thing to say. In both cases the POST goes out at once.
- **A burst** (`burst(el, { r, n, size })`) is the tick-off's ripple and sparks, sized
  by `--r`, so one recipe serves a 26px ring, a 20px icon and an 88px badge.
- **Haptics** (`haptic('tick' | 'snap' | 'success')`): ticking off, We went here, Made
  it, the rose's deck (and a click as a card starts to lean), a match, Pick one, a
  Places detent, a pulled sheet crossing its threshold, ingredient rings and pantry
  taps. Android uses `navigator.vibrate`. **iOS has no vibrate at all**, but Safari 18
  plays a system tick when an `<input type="checkbox" switch>` toggles, and a label
  click toggles one. That is a workaround Apple could close, so a buzz never carries
  meaning alone. It must run inside the tap's own handler on iOS. It is skipped until
  the page has ever been tapped (`navigator.userActivation`), because Chrome refuses
  and logs an error before then. The suite stubs `vibrate` after real touches and
  checks that a detent buzzes.
- **Pins drop into place once** (`createMap(…, { drop: true })`). A pin falls the
  first time that map draws it and is simply there on every redraw after; a map
  redraws on every pan, and pins that kept falling would look like a slot machine.
  Redraws come in pairs (a render, then a focus), so **a redraw during the fall
  carries it on with a negative `animation-delay`** instead of cutting it off. Without
  that the first fall was never seen. The place page's snippet calls `resetDrops()`
  each time it opens, so its one pin drops every time. The animation is on the CSS
  `translate` property, because `transform` already positions the pin.
- **Pictures fade in the first time they load** (`img.fade`, `fadeIn(root)`): posters,
  recipe cards, the recipe page's photo. A picture already seen (or `complete` when
  drawn) is just there. The list re-renders on every tick, and re-fading a shelf of
  posters each time would be a flicker.
- **Placeholder rows** (`skeleton()`) replace "Loading…" while a list or a kitchen is
  on its way in.
- **Cook-mode timers breathe in their last ten seconds** (`.soon`), so a glance across
  the kitchen says "nearly" before the number does. They **ring for four seconds** when
  they finish (`.ringing`, three pulses), and starting one gives a tick.

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

## The calendar — what you did, and what you mean to

`public/js/calendar.js`, a renderer over items like the map. Reached from a
**Calendar** toggle beside `Done together`; while it is open the kind bar and the
composer go, because it spans every kind.

- **The past needs no new data.** Every finished thing already has `doneAt`, so it
  sits on the day it was ticked off — sage dot. Not the day it was *planned* for:
  the calendar says what happened, and plans slip.
- **A plan is `item.when = { date: 'YYYY-MM-DD', time: 'HH:MM' | null }`** — coral
  dot. A **calendar date, not an instant**: "Saturday" is the same Saturday for both
  of you, and a timestamp would be a different day for anyone in another timezone,
  or for the server, which runs in UTC. Client-side dates are LOCAL (`dayKey`),
  never `toISOString()`. `cleanWhen` refuses impossible days (2026-02-30) rather
  than repairing them; a plan moved to a day nobody chose is worse than none.
- **Scheduling is its own operation, like ticking off** — `setWhen`, its own route,
  the `complete` right: anyone who can see the item can put it on a day, and
  `plannedBy` records who. A PATCH cannot set it and creating cannot smuggle one in.
  Chosen deliberately: picking a day is part of doing the thing together, and
  "Linnea planned Baltimore for Saturday" is the same nice bit as ticking off.
- **The When field in the item sheet saves on change**, not on Save — somebody who
  did not write the item has no Save button and is still allowed to plan it.
- **Plan something for a day** (today onward) picks from open items with no day
  yet, across every kind. Under today, **Coming up** lists the next planned things,
  so the next few weeks are visible without paging.
- The grid is **always six rows**, so the agenda under it never jumps between months.
- **Planning nudges** the people who can see it ("Linnea planned something ·
  Baltimore · Sat 8 Nov · 7pm"), only when the DAY changes — moving the time is
  fiddling, and clearing a plan wakes nobody. Not yet: the weekly digest
  mentioning what is coming up.

## Just us — the pleasure inventory (`lib/pleasure.js`, `public/js/rose.js`)

A **line-drawn rose** in the corner of a **pair** list (where the ⋯ was — the list
settings open from tapping the title, which carries a small ⌄ to say so). Deliberately
not the 🌹 emoji: phones get glanced at, and this should be findable, not conspicuous.

Reworked on Nov 17 from the handoff on the `design/just-us` branch (PR #3). **Client
only**: every screen is drawn from what `GET /api/space/:id/pleasure` already returned;
`lib/pleasure.js`, its routes and its rules did not change, and must not for a redraw.

- **It opens on a FRONT DOOR, every time, that names nothing.** The count of what you
  both want ("2 new" when there is something unseen), and doors to Body, Things to try
  and Ask your own — counts, never a label. A phone gets glanced at, and this is the
  screen that is open when it does. It used to open straight onto new matches, which put
  what they were on screen the moment it opened. The suite sets up a real match and
  asserts the open sheet's text contains no try label and no part name.
- **Body** is points on a soft figure (real buttons, 44px, laid over the SVG), glowing
  with how much you like it there, with **Together / Yours / theirs** views and Front /
  Back. Theirs is not a new disclosure: body answers were always shared in full. A part
  both of you said yes to carries a rose ring in Together. Tap a point and each act is a
  **row of five tiles**, cool → warm, yours filled, theirs marked with their initial on
  the top edge of its tile — five tiles read as a scale where five dots read as a form.
- **Things to try** is a deck, one card at a time, with five bubbles that grow and warm
  toward Yes, please. Swipe right yes, left no, up maybe, as before. **Back** reopens the
  last card answered in this sitting, answer showing, and answering again replaces it;
  **Not now** skips. The end screen is rose, not coral.
- **All answers** is every try answer by group, to change — named in words beside the
  tiles, since nothing here is told by colour alone — and your own questions with *Take
  back*. It shows no partner answers, because none are sent.
- **You both want** groups the matches by the cooler of the two answers (both "yes,
  please" / both yes / one of you maybe, saying which). It is the ONLY screen that marks
  matches seen. **Pick one for us** chooses at random on the device — never the same
  twice running, never stored or sent. **Ask your own** lives here.
- **One colour ramp**, `--rose-cool` (No) to `--rose` (Yes, please), mixed in oklab; both
  are tokens per theme. `--accent` appears nowhere inside the room.
- **A new match is a moment**: the rose draws itself over the sheet, naming it — fine,
  the person looking is the one who just answered. An unseen match puts a dot on the
  corner rose — on screen only, never a push. "Seen" is per device in `localStorage`.
- Tapping your answer again clears it (on a tile; on the deck, answering moves on).

The privacy rules are the feature, and they live in `pleasure.view()`, pure and tested:

- **Keyed by the PAIR OF PEOPLE** (sorted ids), never by list. A list can change hands;
  if one of you leaves and somebody new joins, they are a different pair and see nothing.
  Leaving a pair list also deletes that pair's answers.
- **Pairs only.** A group list answers 404 and shows no rose.
- **Body answers are shown to your partner in full** — that half exists to say "this,
  not that".
- **Things to try are shown only as MATCHES** — both of you at Maybe or warmer. The
  partner's try answers are never sent to the client except on a match (where both
  levels come, so the matches can say how keen), so a "no" can never reveal a "yes",
  and suggesting something costs nothing.
- Two routes and nowhere else: no push, no digest, nothing on `/api/state`, no third
  party. The catalogue is server-side and an id outside it is refused.

## Today's question (`lib/questions.js`, `public/js/question.js`)

One question a day, the same for both of you, on a **pair** list: **you answer it to see
theirs.** Every day you both answer adds to a streak, and an answer can become a thing to
do. Built from the handoff on `design/daily-question` (PR #4); like the earlier handoffs,
the mockups stay on that branch and never come into master.

- **Their answer is not sent until you have answered.** Not blurred, not hidden in the
  DOM: absent. `dayView` gives `{ answered: true|false }` and nothing else of theirs, so
  the locked card's two bars are a drawing. A truth table dumps every combination to
  JSON and searches it for their text.
- **Once both have answered, neither can change theirs** (409) — or the second could
  read the first and the first rewrite theirs to match. Before that yours replaces, and
  keeps the time you FIRST answered, because that is the day the streak counts.
- **Your kinds are yours.** Friends, Romance, Spicy: each of you turns them on for
  yourself, and a kind comes up once you both have. The wire carries your own list and
  the intersection, **never theirs** — "I wanted romance questions and you didn't" is not
  a message this app delivers, for any of the three. Asserted for every combination by
  searching the JSON for a kind only they turned on. Friends is on by default, so a pair
  list has a card from the day this shipped.
- **Spicy keeps to the rose.** Its text, answers, reactions and replies travel only on
  `/api/space/:id/pleasure` (`roomView`); on the list's route a Spicy day is `justUs: true`
  and two answered flags, and the list's answer route refuses one (404). Never on
  `/api/state`, never in the history, never in a push. The card goes rose and says
  *Today's is one for just the two of you*; **Open** lands in the rose on the question, and
  the rose's front door gains a fourth door that names nothing (*Waiting for you*,
  *You both answered*). The day still counts toward the streak — a number says nothing.
- **A day is a calendar date in the pair's zone**, never an instant, like `item.when`. The
  zone is the first phone's that says (`?zone=` from `Intl`), and a record made where
  nobody said (the rose, a reminder) is corrected by the first phone that does. The day's
  question is **picked once and stored**, so changing the kinds changes tomorrow.
- **Which question:** the kinds in play take turns by the day's index since the pair
  started; within a kind, the next not yet asked in an order shuffled once per pair (so
  two pairs don't march through the same list); used up, it starts again.
- **The streak** is worked out, never stored: a day counts when both answered ON it, in
  the pair's zone. Today not done yet never breaks it; a missed day does once it is over
  (decided without Andrew — a weekly free day or an earned freeze would be a change to
  `streak()` alone). A catch-up shows in the history and unlocks theirs but does not mend
  it. Paused days (`pauses`, closed ranges; resuming today starts counting today) neither
  count nor break.
- **Add to Activities** puts the answer in the composer on the Activities tab, selected to
  trim; an answer of theirs is credited to them once added (`ideaBy`, which the author
  may set). `✓ On your list` is remembered per device. Never in the rose.
- **Nudges carry no question text, on any day** (`questions.nudge`, the one place they are
  worded; a test holds every one against every question): *Sam answered today's question
  · Answer to see theirs*, *Sam answered · See what they said*, and the reminder. At most
  one of each per person per day (`nudged`). The reminder is checked once a minute in each
  pair's zone, picks the day if nobody has opened the app, and is **8 PM unless you change
  it** (Andrew's call). Never set is the default; turned off is stored as `null` and stays
  off (`remindOf`).
- **Pairs only, keyed by the pair of people** (`pleasure.pairKey`), and deleted when
  either leaves the pair, in the same line as the rose's answers. Every route is 404 on a
  group list.
- **The card is on the Activities tab only** (the default kind), at the top above whose
  idea everything was — not on Films, Shows, Places or Recipes, where it was in the way
  of the shelf (Andrew's call), and not in Done together.
- `/api/state` carries `question: { streak, waiting }` per pair space for the shelf — a
  number and a flag. The card loads with the list (`loadQuestion`, beside the items).

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
- The author is never told about their own thought. More generally,
  `audienceFor(item, actorId)` leaves out **whoever acted** — the author for
  "added", the doer for **ticked off** and **planned** — so the author IS told
  when somebody else finishes or plans their item. Un-ticking tells nobody.
- `itemAdded` fires **after the response and is never awaited** — a slow push
  service must not make adding something feel slow.
- The weekly digest goes out Sunday evening, needs at least three open things to be
  worth sending, and a failed send doesn't burn the week. "Not much on the list" is
  not a failure and doesn't count against the retry budget.

## Recipes and the kitchen (`lib/recipe.js`, `lib/kitchen.js`, `public/js/recipe*.js`, `cook.js`, `kitchen.js`)

Built from the handoff on the `design/recipes` branch (PR #2). The recipe kind has
`cook: true` on the manifest, like `art`, so the client keeps no list of its own.

### Who may open a kitchen — read this first

**A kitchen is a new audience**, so it gets one pure rule and a truth table, like
`canSee`: `kitchen.canUse(viewer, owner, spaces)` is true for **yourself and anyone you
share a PAIR list with**, and false for everybody else — **including people you only
share a group list with**. A kitchen is somebody's home; the ski-trip crew does not get
to read your fridge. Starting narrow is cheap to widen; widening by accident is a
disclosure. Every kitchen route answers **404** when it is false (the suite checks each
route for a group-only co-member and a stranger), and **leaving the pair list closes the
kitchen** — the suite has Sam leave his pair with Andrew and then get the 404.

- **These are the only routes that name a person** (`/api/kitchen/:uid`). Identity is
  still the session alone; the id only says WHOSE kitchen, and `canUse` decides.
- One pantry and one list to buy **per person** (Andrew confirmed: separate pantries).
  You can change your partner's — `by` records whose hand it was. Kitchens notify nobody.
- A buy row "for" a recipe names it only to someone who can see that recipe; his
  private recipe's title is not shown in her view of his list.
- The wire carries `kitchens: [{id,name}]` (yours first, then pair partners) and, on
  each recipe in the list, `ready: { [uid]: [bool…] }` for your kitchen and your pair
  partner's. **The matcher runs on the server** (`kitchen.match`), in one tested place;
  the client renders what it is sent — the `canSee` rule again.

### Reading a recipe — choosing, not guessing

- **Paste a link, and it is READ, not added**: the composer under Recipes (and the
  share sheet, for the iOS Shortcut) sends a URL to `POST /api/recipe/read`, which
  **saves nothing**. A sheet shows what came with it — a ring, not a check, for anything
  "not on this page" — and what you are short, and nothing is saved until Save. **The
  title stays exactly as typed**; a bare link takes the recipe's own name.
- `lib/recipe.js` is pure: every `application/ld+json` block (a broken one is skipped,
  not fatal), walked for the first `Recipe` through arrays, `@graph` and `mainEntity`;
  instructions as strings, HTML, `HowToStep`s or `HowToSection`s; ISO durations; yields
  like "Serves 4-6". Tags stripped, entities decoded — sites put HTML everywhere.
- **NEVER GUESS AN AMOUNT.** `parseLine` reads mixed numbers, Unicode fractions, ranges
  and a fixed unit table; anything else keeps `q: null` and is shown exactly as
  published, never scaled. "1 (14-ounce) can" is left alone — scaling it is guessing.
  A comma with only describing words before it is part of the name: "3 large boneless,
  skinless chicken breasts" was "large boneless" until the real NYT page showed it.
- **Timers** come from the step text: ranges take the low end (easier to add time than
  undo it), over six hours is not a timer, labelled by the cooking verb before them.
- **Which ingredients a step uses**: its head noun in the step; a bare "chicken" is the
  one chicken ingredient that is not derived (thighs, not broth); and a word followed by
  another ingredient's head is that one's ("red pepper flakes" is not the pepper in "salt
  and pepper"). Matched against the whole sentence — the pantry key stops at a comma,
  which in a step threw away everything after "heavy cream,".
- **No Recipe in the JSON-LD? Read the page's own layout** (`fromLayout`). A farm's
  Shopify blog post (Nov 21) had only an `Article` in its JSON-LD and the recipe in plain
  HTML: an *Ingredients* heading over a list, *Direction* over another, and the times and
  servings in a sidebar. So the list items under a heading (or a paragraph that is only
  the label) saying Ingredients / Directions / Method… are read; times and servings come
  from blocks that open with a label ("Prep Time: 5 Minutes"; a bare "Cook 15 minutes."
  is a step); the title is `og:title` without " | Site". It is deliberately narrow:
  **both halves or nothing** (a product page lists ingredients too), prose is never read,
  and loose text ends a run. It scans rather than backtracks, so 3 MB of unclosed
  comments or tags cannot make it crawl. The Found sheet still shows it before saving.
- **Pages that will not share** are a `no-recipe`, never an error: paste the text (the
  same Found sheet checks it before saving), or just keep the link. Checked against a
  real NYT Cooking recipe page on Nov 17: it does publish its JSON-LD.

### The fetch guard (`lib/fetchpage.js`) — the one place a typed URL is fetched

http(s) only, no credentials; **4 redirects, each re-checked**; 8 s; a size cap
enforced while streaming (3 MB pages, 2 MB images); the content type checked. **The
address is refused at connect time** — the socket's own `lookup` rejects loopback, RFC
1918, link-local and the metadata address, CGNAT, ULA, multicast and the IPv4-mapped and
NAT64 forms of all of them, so DNS rebinding has no gap; IP literals are checked before
the request. 30 reads an hour per person, in memory. `PREVIEW_ALLOW_PRIVATE=1` is for
the suites only, which serve fixtures from localhost.

### Photos (`lib/img.js`, `data/img/`)

Downloaded once, never hotlinked (that hands every viewer's IP to the site and breaks
when it moves): image/* only, the type **sniffed from the bytes** (JPEG, PNG, WebP),
content-addressed `<24 hex>.<ext>`, served by `GET /api/img/:name` behind the sign-in
guard, immutable. A daily sweep deletes what no item references and is a day old.
`data/` is gitignored, as ever.

### The page, cook mode, Made it, the kitchen

- **The recipe page replaces the generic sheet** for the kind (as the place page does);
  its *Edit details* opens the generic sheet by name (`openItem(id, { generic: true })`).
  The link back to the original is always on screen. **A PATCH neither sets nor loses
  `mod.recipe`** — the sheet never sends it, and it survives a rename or a change of kind;
  `POST /api/item/:id/recipe` sets or clears it (the `complete` right: it is derived
  from the author's link, like the poster and pin backfills).
- **Servings are per DEVICE** (`dw-serves:<id>`): tonight, not the recipe. `amount()`
  rounds as a cook would write it (⅛ … ¾ for cups and spoons, nearest 5 g, half a clove),
  and the browser check imports it into the page and asserts it. **Times never scale.**
- **Ingredient rings write that kitchen's pantry** (need → Have, have → Out); *Add N to
  the list* puts what is missing on its list to buy.
- **Cook mode** is a screen, one step at a time at 25px, that step's ingredients scaled,
  timers one tap away. **Timers are registered with the server** (`POST /api/item/:id/
  timer`; the server keeps the clock and sends its `now` back) and a 10 s tick pushes due
  ones **to whoever started them, and nobody else**, with a link back into cook mode on
  that step (`/?list=&cook=&step=`, which the app now follows — it ignored `?list=`
  before). Seen on screen, the server timer is cancelled so it does not say it twice.
- **"Screen stays on" is shown only while a wake lock is actually held.** Before iOS
  18.4 a home-screen app could not hold one, and the line is simply absent.
- The per-second countdown is **not** in a live region; start, pause and done are.
- **"Linnea's on step 4"**: posted on each step, polled every 15 s while open, kept 20
  minutes **in memory**, never pushed.
- **Made it** (`POST /api/item/:id/cooked`, ≤20 kept) records would-you-again and tweaks
  and ticks it off; "Ran out" chips set those pantry entries Out. In Done together it
  reads "Made Nov 17 · Can't wait"; un-ticking keeps the history. Arriving at Made it,
  and tapping Done, are both moments (see *Motion and touch*); there is no toast.
- **The kitchen** is a pushed screen: pantry by aisle (a small table; a wrong aisle is
  cosmetic) with Have → Low → Out; To buy grouped by recipe plus *Running low*. A ticked
  row is struck through and becomes Have **when you leave the screen** (or the app).
- **Have takes it off the list to buy** (`kitchen.bought`), wherever it is marked: a ring
  ticked on a recipe, the pantry cycled, a row ticked in the shop (which clears the same
  thing listed for other recipes too). "The same thing" is the matcher's test either way
  round, head noun agreeing: a ring on "A handful of parsley" clears a row saying
  "parsley", "garlic" clears "garlic cloves", and "chicken" never clears "chicken broth"
  nor "garlic" "garlic powder". Low is not Have; it stays listed.
- **A promise on a label holds** (`covers`): an ingredient that says *gluten-free*, *dairy-free*,
  *vegan* (any "X free") is had only from an entry that says it too — for somebody who cannot
  eat gluten, gluten-free puff pastry is not the puff pastry in the freezer. The other way
  round is fine: gluten-free flour is flour. Bought, the gluten-free one clears a "puff pastry"
  row; plain puff pastry never clears the gluten-free row.

### Swaps — what goes in instead (`lib/swap.js`, `public/js/swap.js`)

Every ingredient line on a recipe's page has a swap button. The sheet offers **your own**
(type what you are using) and, with a key, **a suggestion**: tick or add the options you
are weighing — **things you have OR things you would buy** — and it says which works best
*in this recipe*, so you know which one to get; tick none and it looks through the whole
kitchen, then things worth buying. A suggestion that is not in the kitchen is chosen with
**Use · add to list**, which also puts what it needs on the list to buy, for this recipe.

The first cut said "Something else you **have**", and the only options it offered came
from the pantry — so a "gluten free flour or cornstarch" to weigh was typed into the
pantry, where it sat as one Out thing on the list to buy. Options to buy are first-class
now, and the pantry is not where a question goes.

**A line that offers a choice** ("2 tbsp gluten free all purpose flour or corn starch",
`kitchen.alternatives`) is shown with **Which?** instead of the swap icon, and the wire
carries its options (`choices`). The sheet opens as *Which one?*: each option to **take
in one tap** (a swap to it, at the recipe's amount), and the same options already ticked
to ask which works best — the prompt says the recipe offers the choice. Until one is
chosen, the line is had when **either** option is (the matcher), its **ring asks which**
rather than writing the whole phrase into the pantry, and a "this or that" row ticked in
the shop comes off the list without becoming a pantry entry — you bought one of them,
not which. "1 or 2 cloves" is a range, "or more" is not a choice, and "chicken or
vegetable broth" is two broths.

**What it has to be.** "gluten free" typed into the options box is not an option — nobody
buys *a* gluten free — it is a **rule** every suggestion must keep. The sheet reads it in its
usual spellings (`requirement()` in `public/js/swap.js`: "GF", "gluten-free", "no dairy",
"must be vegan", "low sodium") and shows it apart, in sage, under **Has to be**; anything
else stays an option, so "gluten free flour" is still a thing you could buy. It goes as
`musts` and the prompt says *It has to be: gluten-free*, with a system rule to name the kind
to buy where the usual one does not keep it ("gluten-free puff pastry"). Kept per device
(`dw-swap-musts`), because a kitchen that cooks gluten free does so every night; one tap
takes it off. Typed into **Your own**, it asks rather than swapping the line for the words.

The first cut threw it away: **text typed into the box and not entered was lost** when the
button was tapped, because asking repaints the sheet. On a phone the button IS the next tap,
so asking now takes whatever is in the box first. The real API was then asked for a
gluten-free swap for a Wellington's puff pastry and answered with gluten-free puff pastry to
buy, a gluten-free rough puff and a shortcrust — where the same ask without the rule had
offered flour, phyllo and pie crust. That run is also why `amount` is asked for under 60
characters and `needs` as two or three words (a 52-character need ending in "xanthan gum"
has "gum" for a head noun and never matches the pantry), and why a long line is clipped to a
whole word and never inside a bracket it opened (`clip`).

- **Choosing, not guessing.** `POST /api/item/:id/swap/suggest` returns a shortlist and
  **saves nothing**; a swap exists only once somebody taps *Use this* or writes their own
  (`POST /api/item/:id/swap`, `{ i, clear: true }` to go back to the original).
- **A swap belongs to the recipe**, beside `visit` and for the same reasons: anyone who
  can see the recipe may set one (deciding what to cook with is doing it together), `by`
  says whose, and a PATCH can neither set nor lose it. It is keyed by the line's index
  **and its text** (`of`): a swap whose line has been reworded is dropped on the way out
  (`swap.live`), and reading the recipe again clears them all, since its lines may move.
- **A swapped line is what it now is, everywhere**: the page shows it with "instead of …"
  under it, cook mode cooks it, the kitchen check reads its `needs` (`swap.ready`), its
  ring writes those, and *Add to the list* lists them.
- **Never guess an amount, again.** `ratio` (the swap's amount relative to the original,
  in the original's unit) is the only thing that scales. A line typed with its own amount
  ("½ cup oat milk") or a suggestion's measured line with no ratio is shown as written,
  and says which servings it was written for. A bare name for a measured ingredient means
  the same amount (ratio 1), which is what anyone means by "use oat milk instead".
- **The model:** `claude-opus-5-5` through the official SDK, adaptive thinking at
  `medium` effort, **structured outputs** (a fixed JSON schema), and **refusal fallbacks**
  (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) so a classifier
  false positive becomes a retry on another model rather than a failure. One request per
  tap, nothing streamed: it is a short judgement, and the sheet shows placeholder rows
  while it thinks.
- **What comes back goes through a gate** (`cleanSuggestions`), like any input: at most
  three, every string bounded, a ratio outside (0, 4] dropped, "uses" only names that are
  in the kitchen, and **"In this kitchen" is worked out here** with the same matcher as
  the recipe — not taken on the model's word. The recipe came from a web page, so the
  system prompt says its text is data, not instructions; the worst a hostile page can do
  is a bad suggestion, which nobody has to choose.
- **The key is `anthropicKey` in `config.local.json`, read live, and nothing else.** The
  SDK would happily use an `ANTHROPIC_API_KEY` from whatever shell started the server; a
  feature that quietly bills a key nobody gave it is not one to ship. No key: the wire
  says `swap.suggest: false`, the sheet offers only your own, and the route answers
  `why: 'off'` without calling anything. `anthropicBaseUrl` lets the suites point the SDK
  at a stand-in; **no test calls Anthropic**.
- **What is sent:** the recipe, the one line, the names of what the kitchen being cooked
  from has (Have or Low, never Out), the alternatives ticked, and what it has to be. A kitchen the caller may
  not open (`kitchen.canUse`) is never sent; their own goes instead. 20 asks an hour per
  person, in memory, because each one costs money. It is the same kind of trade as TMDB
  and Nominatim, with recipe text as well as names.
- **Checked against the real API on Nov 18** with a made-up pancake recipe: 10–15 s an ask
  at `medium`, and it judged as hoped (buttermilk's acid is what the soda needs, so yogurt
  or soured milk over plain milk). That run is why the prompt asks for `needs` in the
  kitchen's OWN names ("Lemons", not "lemon juice"): the matcher would not count lemons
  as lemon juice, and a swap made from what you have said *not in this kitchen*. And
  for `name` in lower case, since it reads after an amount ("2 cups plain milk").
- **Not labelled as AI** (see *Open threads*): the button says *Suggest a swap*. The SDK
  sends the key as a bearer token (1.10), which the suite accepts in either form.
- **And a fourth.** A suggestion's reasons carried their tone as a bare class, and the
  global `.note` (warn colour, 22px above) gave every note a gap and the wrong colour.
  They are `t-good`, `t-bad`, `t-note`.
- **Class names are global, a third time.** The kitchen's state button was `.pill` — the
  nav's travelling marker — and gave it a 64px minimum width; the browser check caught
  the marker settling 10px wide. It is `.kstate`. Recipe cards are `.rcard`, not `.card`.

## Places — a map with the list under it (`public/js/pl.js`)

The Places tab is not a list with a map toggle: **the map fills the top half and the
list is a sheet over the bottom of it**, and **their emojis are the pins** (the leading
emoji, in a bubble ringed coral for to-go and sage for been). It is the same items as
every tab — `place` is just the kind whose only field is a place, detected from the
manifest — drawn the way people think about places: where, how far, been or not.

- **To go / Been** float over the map and replace `Done together` on this tab (they
  set the same `tab` the chip does). The set you are not looking at stays on the map
  as dots, so switching never empties it. Rows carry whose idea it was as an initial
  on the tile's corner — no sections here, sorted **closest first** when the phone has
  said where it is, newest first when not; Been is most recent first and reads
  "Went Oct 4 · Can't wait to go back".
- **The list is a sheet you can pull**, between three heights: mostly **map** (the
  list's heading and a row), **half** (where it opens) and mostly **list** (the map a
  strip under the floating buttons). Drag the heading anywhere. Drag the list down from
  its top to see more map, or up while it is not yet full height to see more list; at
  half, a swipe up grows the sheet before it scrolls, as a map app does. On release it
  settles on the nearest height, or the one a flick was heading for. **The grabber is
  a button** that steps between list and half, for anyone not dragging. Once it has
  settled, the map is redrawn for its new size with `resized()`, which keeps what was
  at the top where it was, so the map does not jump. The height is kept for the
  visit, never stored.
- **Tap a pin** and its row is highlighted and scrolled to; **tap it again** (or tap a
  row) and its page opens; **tap the map itself** and the selection goes. Pinch to zoom. The header, title and control row give way to back, the
  segmented control and the rose, floating over the map in `--glass`. **No backdrop
  blur yet** — they sit where Safari 26 samples the status-bar tint, and that has to be
  measured on a phone before it is risked.
- **Which one?** Typing three characters in the Places composer swaps the list for up
  to three **numbered** suggestions with distances, the same numbers on the map. **One
  tap creates it pinned**, title exactly as typed; **the + still adds it as words** with
  no pin. Then a "Pinned to the map" card with **Undo** (deletes it, puts your words
  back). Choosing, not guessing: nothing gets a pin unless somebody tapped its place.
  The leading emoji is not sent — Photon has never heard of "🍜".
- **A place's page replaces the generic sheet** for the place kind, from anywhere (a
  row, a pin, the calendar): a map snippet, the title as typed, the
  place's own name, "Bar · Georgetown · 1.3 mi", four actions — **Directions** (a Google
  Maps URL to the pin's coordinates, keyless), **Plan it** (Go again once been),
  **Website**, **Share** — then hours, address and website, **Your plan** (When, saving
  on change; **Book ahead**), whose idea, **Why go** (the notes), who sees it, **We went
  here** (it is `done`), and Change the place / Move to another tab / Delete.
- **Once been**, the plan becomes a sage **Been together** card (the day, who ticked it
  off) with **Would you go back?** (Can't wait / Maybe someday / Once was enough), and
  Why go gives way to **What was it like?** We went here becomes a quiet "Not been
  after all".
- **A place with no pin** — every place on the live list on Nov 17 — shows **Find it on
  the map** in the snippet's place, opening a Which one? search with the title as the
  query. Never matched in bulk: a wrong pin is worse than a wrong poster.

**Why OpenStreetMap and not Google, which the handoff specified.** Google needs a
billing account and keys, and the handoff's own rule was that with no key the Places
tab is the ordinary list — which would have shipped none of it. Google's terms also
forbid its place data on a non-Google map and cap caching its coordinates at 30 days.
So it is built on what was already here: OSM tiles, Photon as you type, and Nominatim
by OSM id for a place's hours (`GET /api/item/:id/place`). Swapping in Google later is
`lib/places.js` plus a Maps JS map in `pl.js`; the screens would not change.

**The visit** (`item.visit`, `POST /api/item/:id/visit`, `items.setVisit`) is the half
of a place that is about the two of you: `book` is planning, so — like `when` — anyone
who can see the item may set it; `again` and `memory` are the record, so the same
people may, **and only once it is done** (409 before). It lives **beside `when`, not in
`mod.place`** as the handoff drew it, because a place with no pin still needs it and
`mod` is replaced wholesale by every save. A PATCH can neither set nor lose it. Nothing
left is `null`, not three falses.

**Weather** (`lib/weather.js`, `public/js/wx.js`). Added Nov 25 at Andrew's ask: "live weather
indicators on the places page".

- **Where it shows:**
  - A place's page has a weather box under its actions: the weather there now, a
    high and low, rain coming in the next twelve hours ("Rain likely around 5 PM"), and,
    for a planned place, the forecast for **its day, at its hour** when it has one.
  - The Places tab has a pill over the map, for the median of the list's pins.
- **Open-Meteo**: no key, CC BY, and credited under the box. The server asks, never the
  phone, with the place's pin rounded to ~1 km. **The phone's own position is never sent**,
  so the tab's pill uses the pins, not where you are. It is asked only for a place the
  person can see (`myItem`), and the tab only from pins the person can see.
- **Cached in memory for fifteen minutes** per ~1 km square. As in geo.js, a failure is
  not remembered.
- **Times are the place's own local times, as text** (`timezone=auto`), so "now" and "the
  plan's hour" compare with no zone arithmetic, and a plan is a calendar date, as
  everywhere else.
- **Celsius on the wire.** Fahrenheit is decided on the phone, by its region (`wx.js`).
  The pill's cache key includes the number of pins, so pinning the first place shows the
  weather at once.

**What suits a place: its weather profile** (`lib/placefit.js`). Each place has a
`weatherFit`, filled in by **Claude Opus 5.5** in the background. It says whether the
weather matters at all and, **only where it does**, gives:
- the ideal conditions and temperature range
- the conditions and temperatures that spoil it
- the best time of day, and the best seasons

A cellar bar is `matters: false` and nothing else. A terrace has a range and avoids rain.
Asked at Andrew's ask, Nov 25, as groundwork for suggestions.

- **Automatic.** It is made when a place is added or changed, when its page opens, and,
  for a whole list's places, when the Places tab opens (up to 25 at a time).
  - Calls run one at a time, never awaited by anybody waiting. A place that failed is
    left alone for an hour.
  - `of` records which place a profile was made for (the OSM id, else the name and area).
    Change the place and it is stale and made again. A profile that arrives after the
    place has changed is dropped.
- **Only what applies.** Every field in the schema is nullable, and the prompt says null
  means "doesn't apply". The gate (`cleanFit`) does the rest:
  - It drops unknown conditions, repeats, and any condition that is both ideal and
    avoided.
  - It refuses temperatures outside −40–50 °C and ranges that run backwards.
  - "All four seasons" is not a season.
  - Nothing is kept when the weather doesn't matter.
- **Judged against the forecast** (`judge`, pure). For now and for the plan it says *Good
  weather for it*, *Not quite ideal · a bit cold* or *Not ideal · rain*. An hour at 70% or
  more is rain to a place that avoids it, whatever the hour's code says (see
  *Suggestions*). A place where
  the weather doesn't matter gets no verdict. The profile reads as one line: *Best with
  clear skies, 59°–75° · spoiled by rain, below 41°.*
- **Stored beside `visit`**, set only here, so a PATCH can neither set nor lose it. It
  shares swaps' key, client and refusal fallbacks (`swap.client()`), at `low` effort with
  a fixed schema. **The place's name, what OSM says it is, its area and the title go to
  Anthropic**, the same trade as titles to TMDB. The connector passes on its one-line
  `why`.

**Open or closed, and holidays** (`hours.stateAt`, `lib/holidays.js`). Added Nov 25 at
Andrew's ask: a place should say when it is closed, by its hours or a holiday.

- **Where it shows:**
  - A place's page says *Open now · until 5 PM*, *Closed now · opens tomorrow 8 AM* or
    *Closed today · Thanksgiving*, with today's hours under it.
  - **The day it is planned for** says *Closed on your plan*, *Closed at that time*
    (with that day's hours) or *Open for your plan*.
  - On the Places tab, a row says *Closed now*, *Closed today* or *Closes 5 PM* (within
    the hour), in the meta line as words, and a closed place's pin dims.
- **Seasons and the sun** (`hours.rulesOf`, `rangesOn`, `sunTimes`). Two places on the
  live list showed their raw hours and no state: a park open `sunrise-sunset`, and a
  holiday market open `Nov 12-Dec 23: Mo-Fr 12:00-20:00; Sa-Su 11:00-20:00`.
  - Sunrise, sunset, dawn and dusk are worked out (NOAA, within a couple of minutes) at
    the place's pin, in the phone's zone (`?tz=`). With no pin or no zone they are not
    guessed.
  - A season at the start of the FIRST rule carries to later rules that name none. That
    is deliberate: the strict reading opens the market every weekend of the year.
  - A seasonal place looks up to a year ahead for when it opens ("opens Nov 12").
  - `parse` still gives up on both, because a week cannot say them. `openAt` is what the
    routes call.
- **"Now" is the phone's** (`?at=YYYY-MM-DDTHH:MM`, its own clock). The server runs in
  UTC and never decides what time it is: `/api/space/:id/hours` without `at` is a 400.
  The logic lives in one tested place on the server, like `kitchen.match`.
- **Holidays are worked out, never fetched.** US for now (`holidayRegion`).
  - On a `PH` day, a place's own rule (`PH off`, `PH 10:00-14:00`, read by `hours.phOf`)
    is the truth.
  - On a **major** holiday with no rule written (Thanksgiving, Christmas, New Year's,
    the Fourth, Easter), it says *hours may differ* and keeps the usual hours. A
    confident "closed" there would be a guess that looks like a fact.
  - Hours that run past midnight count the next morning.
- **The Places tab asks for every place at once, but only what is cached answers.** The
  rest go through geo.js's one-a-second queue, and `pending` says to ask again, up to six
  times. **The rows and pins are updated in place, never redrawn**: redrawing the list as
  each place's hours arrived swallowed a tap on a row, and the browser check caught it.

**Opening hours** are read by `lib/hours.js` — pure, small, and it gives up rather than
guess: the common shapes (`Mo-Fr 08:00-17:00; Sa 10:00-14:00`, `24/7`, `off`, `Fr-Mo`
wrapping, `PH` skipped) become a Monday-first week, a day no rule mentions is closed
(that is what the format means), and anything else is `null` so the page shows the raw
string. **Which day is today is the phone's call** — the server's Saturday is UTC's.

**Privacy, the same trade as TMDB and Nominatim.** While you type on the Places tab,
the words go to Photon, biased toward the phone's position if it said, else the middle
of the list's pins. The position is asked once, used for distance and that bias, and
**never stored** — not on the phone, not in the store; the in-memory suggestion cache
keys on it rounded to ~1km. A place page asks Nominatim about an OSM id, through
`myItem`, so a private item's place is a 404 to anyone else.

## The map

`public/js/map.js` — one engine, `createMap(canvas, opts)`, drawing two maps: the
**Places tab** and the **snippet** at the top of a place's page. The caller says what
goes on it (`points()`, with `fit:false` for things drawn but not framed, like the other
set's dots and the phone's position). No mapping library:
tiles are plain `<img>` at an integer zoom in Web Mercator, the same approach trips
uses. Eighty lines, no dependency to break, and it degrades to pins-on-a-blank-
ground if the tiles don't load, which still answers "is there anything near us".

- Pan and zoom are hand-rolled pointer handling. During a gesture the layer moves
  under a CSS transform and only re-renders when the fingers come off — re-rendering
  per `pointermove` re-requests every tile. `moved` suppresses the click after a drag
  and **clears on the next tick**, or one pan disables every pin until you drag again.
- **Every pointer is tracked, not just the first: one finger pans, two pinch.** The
  first engine tracked one, so a second finger restarted the drag from where it landed
  and a pinch slid the map sideways without zooming. A pinch zooms around the point
  between your fingers; lifting one finger carries on as a pan. Trackpad pinches (wheel
  + ctrlKey) and wheels zoom toward the cursor, one redraw a frame. The suite pinches
  with real touches through the protocol and measures where the pin is drawn — and
  that check fails on the old engine, which is how it is known to test anything.
- **Zoom is continuous.** Tiles only exist at whole levels, so they are drawn at the
  nearest one and scaled by the remainder (×0.71–×1.41). Snapping to a whole level
  when the fingers lift reads on a phone as the map flinching away from you.
- **Re-framed only when what it shows changes** (the other tab, a pin added or gone,
  suggestions arriving). The Places map first re-fitted on every redraw, so tapping
  a pin after zooming threw the zoom away. A tap on the map itself puts the selected
  pin down.
- **A tap is not a pan.** Release used to re-render on every pointerup — which
  destroyed the pin before its click could land — and pointer capture sent that click
  to the canvas anyway. Now a release only re-renders after real movement, and a press
  that starts on a pin is not captured.
- `view.z === null` means auto-fit; the first gesture pins it.
- **A tile that fails to load is removed**, not left as a broken-image glyph with a
  seam round it — the blank ground *is* the fallback. The suite blocks
  `tile.openstreetmap.org` (it must never need the internet), which is how this was
  noticed.

### Where — choosing a place, not guessing one (`lib/places.js`)

The Where field **suggests real places as you type**, and the one you tap is stored
**with its coordinates and address**, so it lands exactly where you meant. The same
argument as the film chooser: "Toki" is a ramen bar on H Street to you and a city in
Japan to a geocoder, a wrong pin looks exactly like a right one, and recognising the
right row costs one tap.

- **Photon, not Nominatim.** Nominatim's usage policy forbids autocomplete outright.
  Photon (komoot) is built for type-ahead on the same OSM data, so pins agree with the
  tiles, and it needs no key — a feature that needs a billing account first is one
  nobody turns on. Public instance, fair use: results are cached **in memory**, not in
  the store (every prefix anybody typed is not worth a JSON file forever).
- **Proxied** (`GET /api/place/suggest`) so Photon sees this box, not each phone, and so
  the provider is one file. If OSM is ever too thin, swapping in Google Places is
  `suggest()` and nothing else.
- **Biased to the median of the list's existing pins**, with `location_bias_scale=0.1`
  and `zoom=12` — Photon's default bias put a ramen place in Ryazan first for a
  query made from DC. A specific name still wins from anywhere. Median, not mean,
  so one holiday pin does not drag the bias into the ocean. `0,0` is no bias.
- **Under Places, an empty Where starts from the title** — the title IS the place.
  Detected from the manifest (a kind whose only mod is `place`), not a hard-coded id.
- **Editing the text after picking unpicks it.** The coordinates belong to the place
  you tapped, not to your edit; the line under the field says which you have
  ("Just words for now — pick a suggestion…"). A bare name still works and is kept
  as words. It used to be looked up lazily when the Map view opened; with that view
  gone nothing calls `POST /api/space/:id/geocode` from the client any more. The route
  and its tests stay — scoped, harmless, and the obvious thing to call if a map of
  every kind ever comes back.
- **Not hidden on blur.** On a phone the input blurs before the tap on a suggestion
  lands, so hiding on blur makes every suggestion untappable.
- Coordinates are range-checked here AND by the module gate; a pin in the sea is
  refused twice. `placesEndpoint` and `geoEndpoint` in config exist so the suite can
  point both at a local stand-in.

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
- **A place's details** (`geo.placeDetails(osm)`) go through the same one-a-second
  queue: Nominatim `/lookup` by OSM id with `extratags`, held **in memory** for six
  hours, never in the store — they are somebody else's live facts about a business.
  Links are http(s) only. `geoLookupEndpoint` lets the suite point it at a stand-in.

## HTTP routes

| Route | Purpose |
|---|---|
| `POST /api/auth/google` | ID token + optional invite → session. **Public.** |
| `GET /api/auth/me` · `POST /api/auth/signout` | status; sign out |
| `GET /api/invite/:code` | who invited you — **works signed out** |
| `POST /api/invite/:code/join {name}` | join by the invite and be signed in by it — signed out only (409 otherwise) |
| `GET /api/state` | you, your spaces with per-viewer titles and counts (`byKind` too), module manifest |
| `POST /api/space` · `PATCH /api/space/:id` · `POST /api/space/:id/leave` | lists |
| `GET /api/space/:id/items` · `POST /api/space/:spaceId/item` | the list itself |
| `POST /api/space/:id/invite` | mint an invite into this list |
| `PATCH`·`DELETE /api/item/:id` · `POST /api/item/:id/done` | one thing |
| `POST /api/item/:id/when` | put it on a day `{date, time?}` or `{clear:true}` — anyone who can see it |
| `POST /api/item/:id/visit` | `{book?, again?, memory?}` — anyone who can see it; `again`/`memory` only once done (409) |
| `GET /api/item/:id/weather` · `GET /api/space/:id/weather` | the weather at a place (now, rain soon, its plan) with how it suits the place's profile; the middle of a list's pins for the Places tab — only what you can see |
| `GET /api/space/:id/suggest?energy=&at=&tz=&through=&keep=` | what would be good for then: a plan of slots (pick and runners-up, `planned` when the calendar already has it, `bumped` when the calendar's own is ruled out), the list in order, what is ruled out, `pending` |
| `POST /api/space/:id/suggest/vote {item\|idea, v, at}` · `POST /api/space/:id/suggest/ideas {energy, at, tz, role?, near?}` | a thumb (yours alone on the wire); new ideas from Claude, gated, 12 an hour; `near` is a place you can see (404 if not, 400 if it is not a place) and keeps the ideas to what is close to it |
| `POST /api/space/:id/diet {must: [...], strict}` | what the list eats, set by anyone on it; `{must: []}` is anything; an unknown rule is a 400 |
| `GET`·`POST /api/people/:uid/stations` · `GET /api/transit/stops?q=&space=` | where somebody starts from — yourself or a pair partner, else 404; the station search |
| `GET /api/item/:id/show` · `GET /api/item/:id/show/season/:n` · `POST /api/item/:id/episodes {s, e?, seen}` | a show's seasons, episode names, and ticking one (or a whole season) — anyone who can see it; the last of an ended show ticks it off |
| `GET /api/space/:id/hours?at=` | open or closed now for every place on the list, at the phone's time; `pending` says to ask again |
| `GET /api/item/:id/place?at=` | a place's hours, website, address — live from OSM by its id — and open or closed now and on its plan; 404 if you can't see it |
| `GET`·`POST /api/space/:id/pleasure` | the rose — pairs only; partner's try answers appear only as matches; `question` is today's Spicy one, answered here with `{ question: {date, text\|pick\|react\|reply} }` |
| `POST /mcp` | the Claude connector — MCP over Streamable HTTP, bearer token only, read only |
| `GET /.well-known/oauth-protected-resource[/mcp]` · `/.well-known/oauth-authorization-server` | connector discovery |
| `POST /oauth/register` · `GET`·`POST /oauth/authorize` · `POST /oauth/token` · `POST /oauth/revoke` | the connector's OAuth 2.1 (PKCE, public clients, Claude's callback or loopback only) |
| `GET /api/connect` · `POST /api/connect/code` · `DELETE /api/connect/:id` | the account sheet's Claude row: the address, a code for a signed-out browser, Disconnect |
| `GET /sso?t=` · `POST /sso` | from the Square's ⊞ tile: a signed pass signs you in (or asks first); 404 without `squareSecret` |
| `GET /api/square/status` · `POST /api/square/import` | the import bridge (501) |
| `GET /share` | share target / Shortcut / bookmarklet — serves the shell |
| `POST /api/space/:id/geocode` | resolve place names you can see, batched — not called by the client since the Map view went |
| `GET /api/place/suggest?q=&lat=&lon=` | places as you type (Photon, proxied, cached); writes nothing |
| `POST /api/recipe/read {url}` · `/paste {text}` | read a recipe; **saves nothing** — `{ok, recipe, ready}` or `{ok:false, why}` |
| `POST /api/item/:id/recipe` | attach a read recipe `{recipe}` or `{clear:true}` — anyone who can see it |
| `POST /api/item/:id/cooked` | made it `{again?, tweaks?}`, and ticks it off |
| `POST /api/item/:id/timer` · `DELETE /api/timer/:id` | a cooking timer the server will push when due; only yours to stop |
| `GET`·`POST /api/item/:id/cooking` | where the others are in the recipe — memory only |
| `POST /api/item/:id/swap/suggest {i, kitchen?, picks?, musts?}` | what to use instead of one line — asks Claude, **saves nothing**; `{ok, verdict, suggestions}` or `{ok:false, why}` |
| `POST /api/item/:id/swap {i, use, amount?, ratio?, needs?, note?}` · `{i, clear}` | use something instead — anyone who can see it |
| `GET /api/space/:id/question?zone=` | today's question from your side, the streak, your kinds and reminder — pairs only |
| `POST /api/space/:id/question/answer {date, text\|pick}` · `/react {date, emoji\|null}` · `/reply {date, text}` | not a Spicy day (404); react and reply only once both answered (409); answer final once both have |
| `POST /api/space/:id/question/settings {decks?, remind?, zone?, paused?}` | your own kinds and reminder; the pause is both of yours |
| `GET /api/space/:id/question/history?before=` | every question so far, newest first — **never a Spicy day** |
| `GET /api/kitchen/:uid` · `POST …/pantry` · `POST …/buy` | a kitchen — yours or a pair partner's, else 404 |
| `GET /api/img/:name` | a recipe photo, signed in, immutable |
| `POST /api/push/subscribe` · `/unsubscribe` · `/test` | nudges |

`mySpace()` and `myItem()` resolve from the session plus a membership/visibility
check in one step, so no handler below them ever sees something the caller is not
entitled to. Only the kitchen routes name a person, and only as WHOSE kitchen —
identity is still the session, and `kitchen.canUse` decides (see *Recipes*).

## Conventions

- **`lib/spaces.js` is pure and is the source of truth for who sees what.** Don't
  mirror `canSee` into the client; the client renders what the server sent.
- **Every colour is a token.** Themes (`dusk`, `forest`) are one `[data-theme]` block
  of tokens each in `style.css`, plus a name in `THEMES` in `app.js`. Tints go through
  `color-mix(… var(--accent) 16%, transparent)`, never a copied `rgba()`, or they stay
  coral under every other theme. Scoped by attribute rather than only `:root`, so a
  picker swatch carries `data-theme` itself and paints from the same values. Per
  device (`localStorage`), applied by an inline `<head>` script before first paint.
  - **Derived tokens** (`--sheet`, `--accent-tint`, `--sage-tint`, `--glass`, the
    `--r-*` radii, `--tap`) are `color-mix()` over the palette, declared on
    `:root,[data-theme]` — BOTH, because a custom property reading `var(--bg)`
    resolves where it is declared, and on `:root` alone a swatch would wear the
    page's theme. The suite asserts it.
  - **Renaming a theme needs a migration.** Olive became Forest (Nov 17), and a
    phone that saved `"olive"` would otherwise drop to Dusk with no way to tell
    why. Both readers map it — the `<head>` script (first paint) and `RENAMED` in
    `app.js` — and the suite reloads with `"olive"` saved to prove it.
  - **`--faint` is decoration, never something you must read.** It is ~3:1 on a
    card; placeholders and the tick ring were on it and moved to `--dim`.
- **`esc()` for anything interpolated into innerHTML** — this app shows other
  people's words to you.
- **Assert visibility by layout in tests** (`offsetWidth`/`getClientRects`), never
  `.hidden` — an author `display` rule beats the UA `[hidden]` rule.
- **No build step.** `style.css` gets `?v=STAMP`; the JS tree is served under
  `/js-<STAMP>/`, anchored on `src="` and global (a bare `.replace('/js/', …)`
  takes the first match anywhere in the file, and a comment mentioning a path was
  once enough to eat the stamp). **Restart to bust caches** — and restart after ANY change. A running server reads
  `index.html` and the JS from disk on every request, so an old process serves the
  NEW screen against its OLD routes: the first cut of *Whose idea* reached a phone
  that way, and an old PATCH quietly dropped a film's poster under it.
- **The suite points `CONFIG_FILE` at scratch space before requiring lib/config**,
  which resolves its path once at load. A test suite must not write into the thing
  it is testing.

## Deployment

Not deployed yet. To bring it up:

1. `sudo cp dowith.service /etc/systemd/system/` (see below), `systemctl enable --now dowith`
2. Add to `~/.cloudflared/config.yml`: `- hostname: dowith.guess-ai.app` →
   `service: http://localhost:3006`, then `cloudflared tunnel route dns hot-seat
   dowith.guess-ai.app` and restart `cloudflared`
3. Optionally put `googleClientId` **or** `cfAccessTeam` + `cfAccessAud` in
   `config.local.json` (gitignored, 0600). With neither, an invite link still signs a
   new person in (see *Invites*), and `tools/link.js` signs in someone who has one.
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
- **Andrew's backlog:**
  - Suggestions, stations and journeys are built (see *Suggestions*). Still open there:
    turn-by-turn directions, a separate energy for the next day, and learning from what
    actually got done after it was suggested.
  - **A relationship check-in.** It belongs beside Today's question and the rose, keyed
    by the pair, with their privacy rules rather than a list's.
