# Cooking, rethought: handoff

For the Claude Code session on the Pi. **Read the repo's `CLAUDE.md` first**, then
`design/redesign/HANDOFF.md` (PR #1). This branch is stacked on that one: the recipe
screens use its tokens, its bottom sheets, its list header, its composer and its item
sheet, and this file only describes what is new.

Andrew's brief:

> Can you reimagine a cooking experience for us? Something maybe that could track
> ingredients you have, let you adjust for serving amount, see each step by step with
> timers and maybe even scrape all the info from the url linked recipe too perhaps

He has since confirmed one thing: **separate pantries**, one per person.

Nothing in the app is changed on this branch. It only adds `design/recipes/`.

---

## 0. Before you start

**Order.** Build the redesign's §9 steps 1 to 5 first (tokens, sheets, the list, the
shelf, the item sheet). Everything here assumes them. Recipes do not depend on Places.

**The GitHub copy is behind the Pi**, exactly as the redesign handoff says. Merge
`design/recipes` onto the Pi's tree the same way (`git fetch github design/recipes`,
then merge), and where this file contradicts the live code, it is describing the live
code imperfectly.

| Path | What |
|---|---|
| `index.html` | Every screen side by side, Dusk/Forest toggle. Open it in a browser. |
| `screens/*.html` | Static renders, Dusk. `screens/forest/` is the same in Forest. Starting state only. |
| `mockup-src/*.dc.html` | The canvas sources. Every size and colour in this doc is in there as inline styles. `node mockup-src/render.mjs` regenerates `screens/` (needs `npm i --no-save linkedom`). |

**Mock data.** The four recipe titles are the real list (💍🐣 Marry Me Chicken, 🍝
Lasagna, 🍚 Risotto, 🥩 Beef Wellington, via Linnea). **The Marry Me Chicken
ingredients, amounts and steps were written for the mockup and are not NYT's**, the
photo is a gradient placeholder, and the pantry contents are made up.

**Token names.** The mockups use the canvas's names. In CSS they are: surface =
`--card`, raised = `--card2`, text = `--ink`, text2 = `--ink2`, sage = `--accent2`,
sage tint = `--sage-tint`, accent tint = `--accent-tint`, on sage = `--on-accent2`.

**Run `npm test` after every step in §12.**

---

## 1. The experience

Seven screens, in the order you meet them:

1. **`01-recipes`: the tab is a shelf of cards**, like Films. A recipe that has been
   read shows its photo, its time, its servings and **"Have 8 of 11"**. One that hasn't
   keeps Linnea's emoji, big, and offers **Add the recipe**. **Pantry** and **To buy**
   sit at the top.
2. **`02-reading-a-link`: paste a link and it reads the recipe.** A sheet says what it
   found (photo, ingredients, steps, timers, time and servings) and what you're short.
   **Nothing is saved until you press Save**, and the title stays exactly as typed.
3. **`03-link-without-a-recipe`: when a page won't give its recipe up,** you paste the
   text instead, or just keep the link.
4. **`04-recipe`: the recipe page replaces the edit form** for this kind, the way the
   place page does for Places. Servings, ingredients checked against a kitchen, steps
   with their timers, notes, and **Start cooking**.
5. **`05-cooking`: one step per screen**, big type, only that step's ingredients
   (scaled), a timer you start with one tap, and a tray of timers already running.
6. **`06-made-it`**: would you make it again, what ran out, tweaks for next time. Then
   it is in Done together.
7. **`07-kitchen`**: your pantry (Have, Low, Out) and what to buy, and Linnea's, one
   switch away.

---

## 2. The Recipes tab (`01-recipes`)

The list header, control row and composer are the redesign's §3, unchanged. Then:

- **Two kitchen tiles** in a two-column grid: **Pantry** (basket icon on `--sage-tint`,
  "16 things") and **To buy** (checklist icon on `--accent-tint`, "4 things"). 64px
  tall, `--card`, 18px radius. Both open the Kitchen (§7), on the matching tab.
- **The live author split** (Linnea's ideas / Your ideas), each section a **two-column
  grid of cards** rather than a card of rows.
- **A card** is a 4:3 tile (18px radius) and a caption under it:
  - **Read recipe:** the photo fills the tile, with the site name ("NYT Cooking") in a
    dark glass chip bottom-left. Caption: the full title as typed, emojis included,
    15px/600; "40 min · serves 4" 12.5px `--dim`; then a 7px dot and **"Have 8 of 11"**
    in `--accent`, or **"Have everything"** in `--accent2`. The count is against your
    own kitchen.
  - **No recipe yet:** the tile is `--card2` with the leading emoji at 46px. The tile
    shows the **whole leading emoji run, up to two** (💍🐣), because a 4:3 tile has the
    room. Rows elsewhere keep the redesign's `leadEmoji`, which takes one. Caption: the
    title without the emoji, "via Linnea" when that applies, and **Add the recipe** (link
    icon, `--accent`), which opens the sheet in §3.
  - **The ring** sits bottom-right on the tile, inside a 48px hit area: 28px, white
    border over a photo, `--dim` border over an emoji tile, `--accent2` filled when done.
    Ticking it off from here is still "made it" without the ceremony (§6 is the
    ceremony).
- **Composer:** "Add a recipe, or paste a link…". If what was typed contains a URL,
  **+** opens the sheet in §3 instead of adding the words. Text around the URL becomes
  the title. A bare URL takes the recipe's own name as the title.
- **The share target.** `/share?url=` with a recipe page runs the same read. When it
  finds a recipe, the share sheet defaults the kind to Recipe and the title to its name.
  This is the iOS Shortcut path, and it is the best way recipes will get in.

The `recipe` row in `lib/kinds.js` gets **`cook: true`** (and `manifest()` passes it on),
the same way `art: true` marks the poster kinds, so the client decides to draw cards and
the kitchen tiles from the manifest and keeps no list of its own.

---

## 3. Reading a link (`02-reading-a-link`, `03-link-without-a-recipe`)

A bottom sheet (the redesign's sheet, grabber and X).

**Found** (`02`): title "Found the recipe" in the serif at 25px; the URL in a `--card`
field with a link icon; a 112×84 thumbnail beside "From NYT Cooking", the page's own
name in the serif at 22px, and **"Saved under your title: 💍🐣 Marry Me Chicken"**. Then
**What came with it**, a card of rows with sage checks: Photo, Ingredients ("11, with
amounts"), Steps ("6, three with timers"), Time and servings. A row whose data is
missing gets an empty ring and "not on this page" instead of a check, so the sheet
never claims more than it got. Then the **In your kitchen** card ("8 of 11", a 6px
`--accent2` bar, "To buy: sun-dried tomatoes, heavy cream, parmesan"), and **Save the
recipe** (primary, 54px) with "Saved for the two of you, with the link back to the
original." under it.

**Nothing found** (`03`): title "Couldn't read this one"; the URL; a card saying
**"This page doesn't share its recipe"**; a 9-row **Paste the recipe** textarea;
**Read what I pasted** (primary) and **Just keep the link** (text button). Reading pasted
text lands on the Found sheet, so it is checked before it is saved, the same as a link.

This follows CLAUDE.md's **choosing, not guessing**: the read is shown to the person who
asked for it, and they decide.

---

## 4. The recipe page (`04-recipe`)

A full-height sheet, top to bottom:

- **Hero:** the photo, 210px tall, 22px radius, the X (glass, 44px) top-right, and a
  **"NYT Cooking ↗"** chip bottom-left that opens the original. **The link back is
  always on screen.**
- **Title** as typed, serif 29px; "Linnea's idea · Recipe" under it.
- **Prep / Cook / Total**, three `--card` tiles. A missing value drops its tile.
- **Servings:** "Servings" and **"Amounts change, times don't"** on the left, then
  minus, the number (22px/700, tabular), plus (44px round `--card2` buttons). 1 to 24.
  **Per device** (`localStorage` `dw-serves:<itemId>`): it is about tonight, not about the
  recipe, so it is not stored on the item. With no yield on the recipe it becomes a
  multiplier (×½, ×1, ×1½, ×2, ×3).
- **Ingredients**, with a **Mine / Linnea's** segmented control on the heading line
  (pairs only; a group list shows your kitchen and no switch). Under it:
  - the **readiness card**: "In your kitchen" / "In Linnea's kitchen", "8 of 11" in
    `--accent2`, the bar, and **Add 3 to the list** (`--accent-tint`), which becomes
    **On the list** (`--sage-tint`) once pressed. Hidden when nothing is missing.
  - **one row per ingredient**: a 22px ring in a 44px button, then the **scaled amount
    in bold** and the rest of the line. The ring is filled `--accent2` when that kitchen
    has it. **Tapping it writes that kitchen's pantry** (need → Have, have → Out). A line
    the parser couldn't read is shown exactly as published and never scaled.
- **Steps**, a numbered card. A step with a timer shows a chip ("5 min timer",
  `--accent-tint`).
- **Our notes:** `item.notes` (author-editable, read-only to the other person, as now),
  followed by the tweaks from every time it was made (§6), newest first, "Nov 17 ·
  Andrew: more garlic". Once it has been made: "Made 2 times · last Nov 17" above it.
- **A card of three rows:** **Edit details** (opens the redesign's §5 item sheet, with
  "Linnea's idea · Us" on the right), **Read the link again**, **Delete** (`--warn`,
  author only).
- **A sticky bottom bar** over a fade: **Plan it** (opens the existing When control) and
  **Start cooking** (primary, play icon).

States the mockup doesn't draw: **a link but no recipe yet** shows the link and a
primary **Read the recipe** where the ingredients would be; **no link** shows **Add the
recipe**, which opens §3 with an empty field.

---

## 5. Cook mode (`05-cooking`)

Full screen, no nav, no composer.

- **Top row:** X (stop cooking, back to the page), "Step 3 of 6" (15.5px/600,
  `aria-live`), and a "Serves 4" pill.
- **Progress:** one 4px segment per step, `--accent` up to the current one.
- **A quiet line:** "Screen stays on" on the left (only while a wake lock is actually
  held; hidden otherwise, see §10.3) and, on the right, "Linnea's on step 4" (§9.6).
- **Running timers** from other steps: chips ("Sear · 3:12", `--accent-tint`; `--accent2`
  and "done" when finished). Tapping one jumps to its step.
- **The step:** its number in a 44px `--accent-tint` circle, the text at **25px/500,
  line-height 1.38**. Readable from across a counter is the whole design.
- **For this step:** the ingredients this step uses, as chips, **scaled to the chosen
  servings** (the mockup shows the base amounts).
- **The timer card**, when the step has one: label and length ("Cook · 2 min"), the time
  left at 40px/700 tabular, and a 60px play/pause button. Starting it registers it with
  the server (§9.5), so a locked phone still gets told.
- **Back** and **Next step** (58px, Next is primary). The last step's button is
  **Finish** in `--accent2`, and it goes to §6.

Leaving mid-recipe remembers the step on this device for six hours
(`dw-cook:<itemId>`), and coming back offers "Pick up at step 3?".

The mockup labels step 3's timer "Garlic". The parser (§9.1) labels timers with the
verb nearest before the duration, which for that step is "Cook". That is fine: the
chip also says which step it belongs to when there's room ("Step 3 · Cook").

---

## 6. Made it (`06-made-it`)

Full screen: an 88px `--accent2` circle with a check, **"Made it"** in the serif at
36px, the title, and "Cooked together · Tue, Nov 17". Then three cards:

- **Would you make it again?** Can't wait / Maybe someday / Once was enough. Same
  three values as a place's `again` (`'soon' | 'maybe' | 'once'`).
- **Ran out of anything?** "Tap it and it goes on the list to buy." Chips for the
  ingredients the kitchen you cooked from had. A tapped chip sets that pantry entry to Out.
- **Tweaks for next time**, a textarea.

**Done** (primary) records it (§8.3) and ticks the item off, so it moves to Done
together. "It moves to Done together, with your notes." under the button.

In Done together, a made recipe reads "Made Nov 17 · Can't wait". **Make it again**
un-ticks it and keeps the history.

---

## 7. Kitchen (`07-kitchen`)

A pushed screen with a back arrow, not a sheet: you stand in front of a fridge with it.

- **"Kitchen"** in the serif at 34px, and on the same line the **Mine / Linnea's**
  switch (pairs only).
- **Pantry 16 / To buy 4**, a two-way segmented control, counts in the labels.
- **Pantry:** an "Add to the pantry…" field, then **aisle groups** (Produce, Fridge and
  freezer, Cupboard, Spices, Other), each a card of rows: the name, and a state pill on
  the right that **cycles Have → Low → Out**. **Have is quiet** (`--dim` text, no fill);
  **Low** is `--accent-tint` / `--accent`; **Out** is `--card2` / `--ink`. Only the things
  that need you have colour. Footnote: "Tap to cycle: Have, Low, Out. Out goes on the
  list to buy. Recipes check against whichever kitchen you're cooking in."
- **To buy:** **Send the list** (Web Share, falling back to copying the text), then
  groups: **For Marry Me Chicken** (the rows added from a recipe, each with its amount),
  and **Running low** (pantry entries at Low or Out that aren't already listed). Each row
  is a 26px ring and the name with a sub-line. **Ticking strikes the row through and it
  stays until you leave the screen**, then moves into the pantry as Have. A mis-tap is
  one more tap to undo.

Aisles come from a small table (§9.3). A wrong aisle is cosmetic.

---

## 8. Data

Every new field goes through a gate **first**, or a write will appear to succeed and
change nothing. Caps are listed because the gate is where they live.

### 8.1 `mod.recipe`: a new module in `lib/modules.js`

```js
mod.recipe = {
  name,        // the page's own name ("Marry Me Chicken"). The item TITLE stays as typed.
  site,        // "NYT Cooking": publisher or og:site_name, else the hostname without www.
  image,       // '<24 hex>.<jpg|png|webp>' in data/img/, or null. /^[a-f0-9]{24}\.(jpg|png|webp)$/
  yield,       // { n: 4, unit: 'servings' } or null. n 1..100
  prep, cook, total,   // whole minutes, 0..2880, or null
  ingredients: [{
    text,      // the line as published, ≤300. Always kept: it is the fallback display.
    q, q2,     // quantity, and the top of a range ("2 to 3"); numbers or null
    unit,      // canonical unit from a fixed table ('cup','tbsp','tsp','lb','oz','g','kg',
               //   'ml','l','clove','can','pinch', …) or null
    name,      // what it is ("sun-dried tomatoes"), ≤120
    note,      // after the comma or in brackets ("chopped"), ≤120, or null
  }],          // ≤60
  steps: [{
    text,      // ≤1500, plain text (tags stripped, entities decoded)
    timers: [{ secs, label }],   // ≤4 per step, secs 5..21600, label ≤24
    uses: [i], // indexes into ingredients that this step mentions
  }],          // ≤40
  from,        // 'page' | 'paste'
  readAt, readBy,
}
```

The URL stays in `mod.link`, where it already is. A pasted recipe needs no link.

Leave the kind's `mods` as `['link']`: `mods` is what the item sheet offers to type,
and nobody types a recipe slice. The gate keeps every slice it recognises whatever the
kind, so reclassifying a recipe keeps it (CLAUDE.md: a kind suggests, it never
confiscates).

### 8.2 Images: `data/img/`

Do With hosts no images today, and hotlinking the recipe site's photo would hand every
viewer's IP to that site and break when they move it. So the read downloads the image
once: image/* only, **2 MB cap**, the type **sniffed from the first bytes** (JPEG, PNG,
WebP) rather than trusted from the header, and stored content-addressed as
`data/img/<first 24 hex of sha256>.<ext>`, so the same photo is stored once. Served by
`GET /api/img/:name` behind the sign-in guard, `Cache-Control: private, max-age=31536000,
immutable`. A daily sweep deletes files no item references (a read that was never saved
leaves one behind). `data/` is already gitignored and already in the backups.

From a JSON-LD `image` array, prefer the one closest to 4:3 when width and height are
given, else the first.

### 8.3 `item.cooked`: the record

```js
item.cooked = [{ at, by, again, tweaks }]   // ≤20, newest last. tweaks ≤500
```

Its own operation, like `setDone` and `setWhen`, and the same right: **anyone who can
see the item** (making it is doing the thing together). `POST /api/item/:id/cooked`
appends and ticks the item off; the existing "ticked off" push fires only on the first
transition, as now.

### 8.4 `state.kitchens`: one per person

```js
state.kitchens[uid] = {
  pantry: { [key]: { name, state: 'have'|'low'|'out', aisle, by, at } },  // ≤400
  buy:    [{ id, name, amount, for: itemId|null, by, at }],                // ≤200
}
```

`key` is `kitchen.key(name)` (§9.3), so "Chicken thighs" and "boneless chicken thighs"
land on the same entry. `name` is stored as typed. `by` records who changed it, because
you can change your partner's.

### 8.5 Who may do what

| Action | Who | Why |
|---|---|---|
| Set or change the link, title, notes | the author | unchanged: the sentence is theirs |
| Read the item's link, paste a recipe, Read the link again | anyone who can see it | it is derived from the link the author chose, like the TMDB and geocode backfills |
| Record it as made (`cooked`) | anyone who can see it | it is the record, like `done` |
| Start a timer, post a cooking step | anyone who can see it | |
| See or change a kitchen | **its owner and anyone who shares a pair list with them** | see below |

**Kitchens are a new audience, so they get a pure rule and a truth table**, like
`canSee`. `kitchen.canUse(viewerId, ownerId, spaces)` is true for yourself and for
someone you share a **pair** space with, and false otherwise, including people you only
share a group list with. A kitchen is someone's home. Starting narrow is cheap to widen
later; the reverse is a disclosure. Every kitchen route answers **404** when it's false,
the same as everything else here. Kitchen changes notify nobody.

---

## 9. Server

### 9.1 `lib/recipe.js`: pure

No I/O, no store, fully tested with fixtures in `test/test.js`.

- **`fromHtml(html, pageUrl)`**: every `<script type="application/ld+json">` block,
  `JSON.parse` in a try (skip what fails), then walk objects, arrays, `@graph` and
  `mainEntity` for a node whose `@type` is `'Recipe'` or an array containing it. First one
  wins. Returns the shaped recipe or null.
  - `recipeIngredient` (or the legacy `ingredients`).
  - `recipeInstructions`: a string (split on newlines, or on `<li>`/`<p>` when it's
    HTML), an array of strings, `HowToStep` (`text`, else `name`), or `HowToSection`
    (flatten its `itemListElement`).
  - `recipeYield`: a number, a string ("Serves 4-6" → 4), or an array (first with a
    number).
  - `prepTime`/`cookTime`/`totalTime`: ISO 8601 (`PT1H5M` → 65). Total falls back to
    prep + cook.
  - Strip tags and decode entities everywhere. Sites put HTML in these fields.
- **`parseLine(text)`** → `{ text, q, q2, unit, name, note }`: leading quantities
  including mixed numbers ("1 1/2"), Unicode fractions ("1½", "¾"), decimals and ranges
  ("2 to 3", "2-3"); a unit from a fixed alias table (tablespoons/tbsp/Tbs/T → `tbsp`,
  teaspoons/tsp/t → `tsp`, pounds/lb → `lb`, …); the note after a comma or in brackets.
  **Anything it can't read keeps `q: null`**, and the page shows the line as published.
  Never guess an amount.
- **`timersIn(text)`**: durations in seconds/minutes/hours, with ranges ("10 to 12
  minutes" → 10 min: it is easier to add time than to undo it), words ("a minute",
  "one hour"), "1½ hours". Skip anything over 6 hours and "overnight". Label: the cooking
  verb nearest **before** the duration from a fixed list (bake, boil, braise, brown,
  chill, cook, fry, grill, knead, marinate, proof, reduce, rest, rise, roast, sauté, sear,
  simmer, soak, steam, toast, whisk …), else "Step N".
- **`usesIn(step, ingredients)`**: an ingredient is used by a step when its head noun
  (`kitchen.key`'s last word) appears in the step text.
- **`fromText(text)`**: the paste reader. Split into lines; find an Ingredients heading
  and a Steps / Instructions / Directions / Method / Preparation heading; without
  headings, quantity-led or bulleted lines are ingredients and numbered or long lines are
  steps. Strip bullets and numbering.
- **`yieldOf`, `minutes`** and the shaping helpers, exported for the suite.

### 9.2 `lib/fetchpage.js`: the one place that fetches a URL somebody typed

This is a server fetching an arbitrary URL on request, which is how an app gets used to
probe the network it sits on. The Square already solved this in `lib/linkpreview.js`;
port its guards, and close one gap:

- http and https only; **4 redirects at most, each one re-checked**; 8 s timeout; HTML
  capped at **3 MB** (streamed, aborted past the cap); `text/html` only for pages.
- **Refuse private addresses at connect time**, not just before: use `http(s).request`
  with a `lookup` function that rejects loopback, RFC 1918, link-local, CGNAT
  (100.64/10), ULA (fc00::/7), `::`, `0.0.0.0` and IPv4-mapped IPv6 forms of all of
  them. Checking the name before fetching leaves a DNS-rebinding gap; checking in
  `lookup` doesn't, because the check is on the address actually connected to.
- A real User-Agent (`DoWith/1.0 (+https://dowith.guess-ai.app)`). Some sites will still
  refuse: that is §3's "nothing found", never an error screen.
- **Rate-limited per person**: 30 reads an hour, in memory. Signed-in only (§9.4).
- `PREVIEW_ALLOW_PRIVATE=1`, test-only, like The Square's, so the suite can serve a
  fixture page from localhost.

NYT Cooking is behind a subscription and may serve a page without the recipe. Test with
the real Marry Me Chicken link before promising anything; the paste path exists for
exactly this.

### 9.3 `lib/kitchen.js`: pure

- **`key(name)`**: lowercase, drop accents, drop brackets and everything after a comma,
  drop preparation and size words (chopped, minced, diced, sliced, grated, shredded,
  crushed, softened, melted, divided, boneless, skinless, large, medium, small, "to
  taste", "to serve", "for serving"), simple singulars (tomatoes → tomato, leaves → leaf,
  thighs → thigh), collapse spaces.
- **`match(ingredients, pantry)`** → one boolean per ingredient. An ingredient is had
  when a pantry entry at Have or Low has a key whose words are all in the ingredient's key
  **and whose last word (the head noun) is the same**, so "olive oil" matches
  "extra-virgin olive oil" and "chicken broth" never matches "chicken thighs". Water is
  always had; salt and black pepper are had unless the pantry says Out. **No match means
  need**: a false "you have it" costs a trip to the shop, a false "you need it" costs one
  tap.
- **`aisleOf(name)`**: head noun first, then any word, from a small table (garlic,
  onion, lemon, basil … → Produce; chicken, egg, butter, cream, cheese … → Fridge and
  freezer; salt, thyme, cumin, flakes, powder … → Spices; broth, flour, rice, oil, can …
  → Cupboard), else Other.
- **`canUse(viewerId, ownerId, spaces)`**: §8.5.
- **`running(kitchen)`**: pantry entries at Low or Out whose key isn't on the buy list.

### 9.4 Routes

Add `/api/recipe`, `/api/kitchen`, `/api/timer` and `/api/img` to the guard prefixes in
`routes.js`. Every item route goes through `myItem()`, every kitchen route through
`kitchen.canUse`, so both answer 404 for what you can't see.

| Route | What |
|---|---|
| `POST /api/recipe/read {url}` | Fetch and read a page, download its image. Returns `{ok, recipe}` or `{ok:false, why}` (`no-recipe`, `refused`, `too-big`, `unreachable`, `slow-down`). **Saves nothing.** |
| `POST /api/recipe/paste {text}` | `fromText`, through the gate. Saves nothing. |
| `POST /api/space/:spaceId/item` | Unchanged route; the body may now carry `mod.recipe` (it is cleaned by the gate like any slice). |
| `POST /api/item/:id/recipe {recipe}` / `{clear:true}` | Attach the previewed recipe to an existing item. `complete` right. |
| `POST /api/item/:id/cooked {again, tweaks}` | §8.3. `complete` right. |
| `POST /api/item/:id/timer {secs, label, step}` | §9.5. Returns `{id, endsAt, now}`. |
| `DELETE /api/timer/:id` | Your own timers only. |
| `GET`/`POST /api/item/:id/cooking {step}` | §9.6. |
| `GET /api/kitchen/:uid` | `{owner, pantry, buy, running}`. |
| `POST /api/kitchen/:uid/pantry {name, state}` | `state: null` removes it. |
| `POST /api/kitchen/:uid/buy` | `{add:[{name, amount, for}]}`, `{got:id}`, `{gotKey:key}` (a Running low row), `{remove:id}`. `for` must be an item the caller can see, or it is dropped. |
| `GET /api/img/:name` | §8.2. |

**On the wire:** `wire()` gains `kitchens: [{id, name}]` (yours first, then pair
partners). `GET /api/space/:id/items` adds, for each recipe item, **`ready: { [uid]:
[bool…] }`** for the viewer's kitchen and, in a pair space, the partner's. The matcher
stays on the server, in one tested place, and the client renders what it was sent, the
same rule CLAUDE.md applies to `canSee`.

### 9.5 Timers and push

A countdown on a phone stops being useful the moment the phone locks, which in a kitchen
is constantly. So a started timer is also registered with the server:

```js
state.timers = [{ id, uid, itemId, step, label, endsAt }]   // ≤6 per person, ≤6 h each
```

`endsAt` is computed **on the server** from `secs`, and the response carries the server's
`now` so the client can correct for its own clock. A 10 s interval (started in
`server.js` beside `push.start()`) sends due timers as a push to **the person who
started it only**, then drops them: title "Cook is done", body the item title, tag
`timer-<id>`, URL back into cook mode. Pausing deletes it and keeps the remainder on the
client; resuming registers a new one. Timers survive a restart because they are in the
store.

### 9.6 "Linnea's on step 4" (last, and optional)

`POST /api/item/:id/cooking {step}` records `state.cooking[itemId][uid] = {step, at}`;
`GET` returns everyone else who posted in the last 20 minutes. Cook mode posts on every
step change and polls every 15 s while open. It never pushes. Build it last, and skip it
if the polling feels like too much for what it is.

---

## 10. Client

### 10.1 Files

- `public/js/recipes.js`: the card grid, the kitchen tiles, the read sheet (§2, §3).
- `public/js/recipe.js`: the page (§4) and **`amount(q, scale, unit)`**, the formatter.
- `public/js/cook.js`: cook mode and Made it (§5, §6), wake lock, timers.
- `public/js/kitchen.js`: the Kitchen screen (§7).

### 10.2 Scaling

`amount(q, scale, unit)` is pure and is asserted in `test/client-check.js` by importing the
module in the page:

- cups, spoons and unitless counts: the nearest of ⅛ ¼ ⅓ ½ ⅔ ¾ ("1½", "¾"); from 10
  up, whole numbers.
- g and ml: nearest 5 under 100, nearest 10 above. kg and l: one decimal.
- cloves, cans, eggs and the like: the nearest ½, never below ½.
- `q2` scales with `q` and renders as a range ("2–3").
- `q: null`: the published line, unscaled.

Times never scale. That is what "Amounts change, times don't" is telling people.

### 10.3 Keeping the screen on

`navigator.wakeLock.request('screen')` on entering cook mode, released on leaving,
re-requested on `visibilitychange` back to visible (the system drops it whenever the
page is hidden). **Show "Screen stays on" only while the sentinel is held.** In installed
home-screen web apps on iOS this API did not work until iOS 18.4, so on an older phone the
line just isn't there, which is honest.

### 10.4 Accessibility and motion

- **Don't put the per-second countdown in an `aria-live` region** (the mockup does). A
  screen reader would read it every second. Announce start, pause and done instead, and
  keep a visually hidden label updated once a minute.
- Every ring and stepper is a 44px target, `aria-pressed` on rings, and the ring's label
  says what it means ("Have it: garlic", "Need it: heavy cream").
- Reduced motion: no progress animation, no transitions between steps.
- `esc()` on everything that came from a page. A recipe is somebody else's words, the
  same as an item from your partner.

---

## 11. Tests

In `test/test.js` (the existing suite):

- **Fixtures for `fromHtml`:** a standalone Recipe, an array, an `@graph`, a
  `HowToSection` recipe, instructions as one HTML string, entities and tags in names, a
  page with JSON-LD but no Recipe, and a page with a broken JSON block before a good one.
- **`parseLine`** truth table: mixed numbers, Unicode fractions, ranges, every unit alias,
  notes, and lines it must leave alone ("salt and pepper to taste", "1 (14-ounce) can
  coconut milk").
- **`timersIn`**: ranges, words, hours, "a side", the 6 h and overnight skips, the label
  verb.
- **`kitchen.match`**: "chicken broth" vs "chicken thighs", "olive oil" vs
  "extra-virgin olive oil", the staples, Out beats a staple.
- **`kitchen.canUse` truth table:** self, pair partner, group-only co-member, stranger.
  Then end to end: every kitchen route returns 404 for a group-only co-member.
- **The fetch guard:** private and mapped addresses refused at `lookup`, a redirect into a
  private address refused, the size cap, the content type. Serve fixtures from the
  suite's own server with `PREVIEW_ALLOW_PRIVATE=1`.
- **The gate:** an image name that isn't 24 hex plus an extension, a `javascript:` link,
  oversized arrays and strings, an unknown unit.
- **Timers:** due timers push to the starter only, and a private item's timer never
  pushes to anyone else.
- **`test/client-check.js`:** `amount()` cases; the recipe page renders a published line it
  couldn't parse unscaled; cook mode's step text is at least 24px; "Screen stays on" is
  absent when `navigator.wakeLock` is missing. Assert visibility by layout, as CLAUDE.md
  says.

---

## 12. Build order

Each step on its own, `npm test` green before the next, and CLAUDE.md updated in the same
commit as the thing it describes.

1. **`lib/recipe.js`** and its fixtures. Pure, no routes yet.
2. **The `recipe` module** in the gate, `cook: true` on the kind, `lib/fetchpage.js`,
   images, `POST /api/recipe/read` and `/paste`, the read sheet (§3), and the share
   target.
3. **The recipe page** (§4) with servings and `amount()`, without the kitchen.
4. **The Recipes tab** (§2).
5. **Kitchens:** `lib/kitchen.js`, its truth table, the routes, `ready` on the wire, the
   Kitchen screen (§7), the readiness card and rings on the page, the tiles on the tab.
6. **Cook mode** (§5) with client timers and the wake lock, then **server timers and
   push** (§9.5).
7. **Made it** (§6) and `cooked`.
8. **"Linnea's on step 4"** (§9.6), if wanted.
9. **CLAUDE.md:** a "Recipes and the kitchen" section (the kitchen audience rule first),
   the routes table, the fetch guard, and the `data/img/` note under the store.

## 13. Open questions for Andrew

- **Who can see a kitchen:** pair partners only (proposed), or anyone you share any list
  with?
- **Attaching a recipe to someone else's item** (reading its link, pasting the text):
  anyone who can see it (proposed), or the author only?
- **Timer alarms:** only to whoever started the timer (proposed), or to both of you when
  you're both in cook mode for the same recipe?
- **"Linnea's on step 4":** worth the polling, or leave it out?
