# Do With redesign: handoff

For the Claude Code session on the Pi. **Read the repo's `CLAUDE.md` first.** Every
decision it argues for still stands unless a section below says otherwise, and where
this file says "keep", it means a decision CLAUDE.md already made for a reason.

Andrew's brief, in order he gave it:

1. Make the UI look less dated, the same way The Square was redone.
2. **Keep the emojis.** Linnea types them into titles by hand. They are content, not decoration.
3. Turn Olive into a new **Forest** theme.
4. `Done together` wraps on some screens: keep the icon, drop the label.
5. Keep the streaming logos on Films.
6. A brand-new **Places** experience: link a place to a real places API, put every place
   on a map, and give a place its own detail page instead of the generic edit form.

Nothing in the app is changed on this branch. It only adds `design/redesign/`.

---

## 0. Before you start

**The GitHub copy is behind the Pi.** This branch was cut from `master` at `3ab4e52`
(Nov 5). Andrew's screenshots from Nov 17 show things this repo doesn't have yet:
the list split into **Linnea's ideas / Your ideas**, a **Whose idea** control and an
"added 11 days ago" line in the item sheet, and a **Where: Start typing a place** field.
The mockups follow the live app wherever the two differ. Because this branch only adds
files under `design/`, merge it onto the Pi's tree (`git fetch github design/redesign`,
then merge), and treat anything here that contradicts the live code as describing the
live code imperfectly.

**What is in this folder**

| Path | What |
|---|---|
| `index.html` | Every screen side by side, Dusk/Forest toggle. Open it in a browser. |
| `screens/*.html` | Static renders, Dusk. `screens/forest/` is the same in Forest. Starting state only. |
| `mockup-src/*.dc.html` | The canvas sources. Every number in this doc is in there (inline styles). `node mockup-src/render.mjs` regenerates `screens/` (needs `npm i --no-save linkedom`). |
| `tokens.css` | Forest, the new derived tokens, the contrast fixes, and the map style values. |

**Mock data.** Activities and Films titles are copied from the real list. On Places,
only **🌳 Arboretum** is real. The other places, their hours, the distances and the
poster tints are stand-ins, and the map is drawn. The real map is a Google map (§8).

**Run `npm test` after every step in §9.** Several of these changes move elements that
`client-check.js` finds by selector or asserts by layout.

---

## 1. What makes it read as current

These five rules are most of the change. The rest is applying them screen by screen.

1. **Serif for display only.** The list's name ("Linnea"), "Do With", sheet titles, a
   place's title, a poster-less card and the italic lede keep `--serif`. Rows, labels,
   chips and buttons move to `--sans`. Row titles are **16.5px / 500**. A whole list set
   in 17px serif is most of what read as 2015.
2. **Rows sit in rounded cards** (`--card`, `--r-card` 20px) with hairlines **inset**
   to start after the emoji tile (left 68px), instead of full-bleed hairline rows.
3. **Sentence-case labels.** `.fld>span`, `.month`, `.topbar .with` and the section
   headers drop `uppercase` + tracking for **13.5px / 600 `--ink2`** (`.with` is 13px /
   500 `--dim`, "To do with").
4. **Bottom sheets, not centred modals.** Every `.modal` slides up from the bottom:
   `--sheet` background, `--r-sheet` top corners, a 38×5 grabber (`--faint`), and a
   44px **X** in the header. The stacked `Cancel` / `Close` / `Not now` ghost buttons go;
   the X and a tap on the scrim do that job.
5. **44px minimum hit targets** everywhere (`--tap`). The tick, chips, the theme
   buttons and the nav were all under.

**Contrast.** `--faint` is 3.2:1 on `--bg` and 2.9:1 on `--card`, and today it is both
the placeholder colour and the tick ring's border. Both are things you need to see, so
both move to `--dim`. `--faint` stays for decoration only.

---

## 2. Tokens and themes

- **Forest replaces Olive.** The block is in `tokens.css`: pine background, birch text,
  lantern-amber accent, fern for done, wild-rose `--rose`. Contrast table in the same
  file; everything clears AA. Rename `olive` → `forest` in `THEMES` (app.js), and in
  BOTH places that read `localStorage['dw-theme']` map a stored `"olive"` to `"forest"`,
  or those phones drop back to Dusk.
- **New derived tokens:** `--sheet`, `--accent-tint`, `--sage-tint`, `--glass`, and
  radii. They are `color-mix()` over the palette, declared on `:root,[data-theme]` (the
  comment in `tokens.css` says why both), so every theme gets them with no new values.
- Tints still go through `color-mix`, never a copied `rgba()` (CLAUDE.md, Conventions).

---

## 3. The list (Activities, Recipes, and Places when there is no map key)

Screens: `01-activities`, `02-adding`.

**Header.** Back (44px) on the left, the line rose on the right, both unchanged in
behaviour. Under them, left-aligned: "To do with" (13px/500 `--dim`) and the name in
the serif at **34px / 600, -0.02em**, followed by the ⌄. The title is still the button
that opens list settings.

**Control row.** Left: "5 to do" (14px/500 `--dim`, the open count of this tab).
Right: the two quiet chips, 40px tall, `--card2`, no border:

- **Calendar:** icon + label, as now.
- **Done together:** **the sage check icon + the count only.** The label moves to
  `aria-label="Done together, 9"`. This is the wrap fix Andrew asked for. Keep
  `aria-pressed` and everything CLAUDE.md says about what the count counts.

**Sections** (the live author split): a 24px initial in a `--card2` circle, then
"Linnea's ideas" 15px/600 and the count in `--dim`. Each section's rows are one card.

**A row** is `[emoji tile] [title / meta] [ring]`:

- **The leading emoji goes in a 44px tile** (`--card2`, `--r-tile`, emoji at 23px).
  This is presentation only: **the stored title is never touched**, the edit field
  shows the full string, and a title Linnea typed without a space
  (`🏋️Work out together`) lines up like the rest. A title with no leading emoji gets
  the kind's icon in the tile in `--dim`. Split with:

  ```js
  // Leading emoji, ZWJ sequences, skin tones, keycaps and flags included.
  const LEAD = /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|⃣|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍\p{Extended_Pictographic})*)\s*/u;
  export function leadEmoji(title) {
    const m = LEAD.exec(title);
    if (!m) return { emoji: '', rest: title };
    return { emoji: m[1], rest: title.slice(m[0].length) || title };  // an emoji-only title keeps itself
  }
  ```

  `watch.js` already strips leading symbols off a title before searching TMDB
  (`🐴 Bojack Horseman`); the Places search (§8) needs the same, so put this in one
  place both can use.
- **The ring moves to the right edge**, thumb side, so the emoji and title lead the
  row. 26px visual, 48px hit area, 1.75px border in `--dim`. It is still a ring and
  still sage when done. Every celebration rule in CLAUDE.md is relative to `.tick`, so
  the animation moves with it; check `client-check.js`'s 160ms mid-flight assertion
  still finds what it looks for.
- **Meta line** keeps everything `itemHtml()` puts there today (private/public chips,
  "someone's standing wish", place, the `COOK ↗` link, "Linnea ticked it off"), as one
  13px `--dim` line under the title.

**Composer.** One pill: 52px tall, `--r` 26px, `--card` background, the **+ inside it**
on the right (40px circle; `--accent-tint` with an `--accent` plus while empty, solid
`--accent` once there is text). Placeholder in `--dim`. The visibility row still
appears only once you start typing, exactly as now, drawn as three equal 48px segments
showing the label and its hint ("Just me / only you", "Us / you and Linnea",
"Anyone / all your people"). In a pair list the "Us" hint names the partner; in a
group, "this list". Selected = `--accent-tint` with `--accent` text.

**Bottom nav.** Behaviour unchanged, and it stays a flex sibling, **never
`position:fixed`** (the Safari 26 tinting note). Restyle only: labels 11.5px/600,
count at 0.7 opacity, active pill `--accent-tint` behind the icon (already 16%). The
mockups put the count after the word as CLAUDE.md describes; the live app leads with
it (`bd8e3ab`). Andrew didn't ask to change that, so keep what's live.

---

## 4. Films and Shows

Screen: `04-films`.

Same header, control row ("8 to watch") and sections as §3, with the poster grid:
three columns, gap 18px × 12px.

- **Poster:** `--r` 12px, a 1px inset hairline so light posters don't bleed into the
  page. Done = greyscale plus a dark overlay.
- **Ring:** bottom-right, 30px visual / 48px hit, translucent dark fill with a white
  border; done = `--accent2` with an `--on-accent2` check.
- **Caption:** title 14px/600 (two-line clamp), year 12.5px `--dim` on its own line,
  then **the streaming logos stay**: 22px tiles, `--r` 6px, as today.
- **Fix:** a logo image that fails to load must hide its tile. Today a 404 leaves a gap
  in the row (Good Will Hunting shows one). The poster already has this fallback; give
  the logos the same.

---

## 5. One thing, opened (the item sheet for every kind except Places)

Screen: `03-item-sheet`.

A bottom sheet. Header: the emoji tile at 56px, the title (with the emoji split off)
in the serif at 25px, a line under it ("Your idea · Activity"), and the X.

Fields, in order, each with a sentence-case label and "optional" in `--dim` where it
applies: **What** (the full raw title, emoji included), **What kind** (chips with the
kind icons; selected = `--accent-tint`), **Whose idea** (the live Mine / Linnea's
control, as a two-way segmented), **When** (date and time as two field-styled controls
side by side, with the existing "saves on change" rule and a hint that the other person
can plan it too), **Where** (pin icon inside the field), **Link** (link icon), **Notes**,
**Who sees it** (three segments with icons and a one-line hint that names the partner).
Then **Save** (primary) and **Delete** (a text button in `--warn`, trash icon). No
Cancel. Fields are 50px, `--card`, `--r-field`.

The rights don't change: someone who didn't write it sees the words read-only and no
Save, but When stays live.

---

## 6. Your lists (the shelf)

Screen: `05-your-lists`.

- "Do With" in the serif at 34px with the account avatar (44px hit) on the right. The
  "1 list" subtitle goes; the card under it says it.
- **The list card:** 52px avatar, the name in the serif at 23px, "**28** to do ·
  **18** done together" with the numbers in `--accent` and `--accent2`, a chevron. Under
  a hairline, a five-column row of the kind icons with their open counts (that is
  `groups`, which already ships).
- **Start a new list:** a row with a plus in an `--accent-tint` circle, the label, and
  "With one person, or a group with a name". A 1.5px inset `--line` border instead of
  the dashed one.
- The existing lede ("The things you keep meaning to do…") in the italic serif at the
  bottom, so an almost-empty screen still says something.

---

## 7. Account

Screen: `06-account`.

A bottom sheet over the shelf. Header: 56px avatar, the name in the serif at 26px, X.
Then grouped cards: **People you can share with** and **The Square** (icons, value on
the right); **Nudges** with its switch and sub-line; **Theme**, "on this device": two
preview cards (a tiny list drawn in that theme's colours) with a check on the current
one. Each preview should carry `data-theme` itself so it paints from the real block,
which is exactly what the attribute scoping in CLAUDE.md was built for. **Sign out** as
a row in `--warn`. No Close button.

---

## 8. Places, rethought

Screens: `07-places`, `08-places-been`, `09-add-place`, `10-place`, `11-place-been`.

### 8.1 The experience

- **The Places tab is a map with the list under it.** The map fills the top half;
  the list is a sheet starting just under halfway. **Linnea's emojis are the pins.**
- **To go / Been** (a segmented control floating over the map) replaces the
  `Done together` toggle on this tab. "Been" turns the map into everywhere you've gone
  together, in `--accent2` pins, newest first. The other set stays on the map as 12px
  dots, so the map never empties.
- **Tap a pin** and its row highlights (and scrolls into view); **tap a row** and its pin
  grows (52px, with a label chip) and the map pans to it.
- **Rows:** the emoji tile with a small whose-idea initial (L / A) on its corner, the
  title as typed, and "Blues Alley · Georgetown · 3.6 mi". Been rows read
  "Went Oct 4 · Can't wait to go back".
- **Adding:** typing in the Places composer turns the list into **Which one?**: up to
  three numbered predictions from Google, with the same numbers on the map. **One tap
  pins it.** The **+ still adds it as words**, with no pin. That keeps CLAUDE.md's
  "choosing, not guessing": nothing is pinned unless somebody picked it. A
  **"Pinned to the map"** card with Undo follows. The title stays exactly as typed.
- **The place page replaces the edit form** (§8.5).

### 8.2 Why Google, and the rules that shape the code

Google has the best data for small local businesses, and Directions can hand straight
off to the Google Maps app. Three facts decide the architecture. Check them against the current docs
when you build, because Google changes pricing more often than this file will change:

- **Places data can't go on a non-Google map**, and **coordinates from it may only be
  cached for 30 days**. The place ID is the only thing you may keep indefinitely
  (Google Maps Platform Service Specific Terms, Places API section). So `map.js` (OSM
  tiles) can't draw these pins: the Places tab uses the **Maps JavaScript API**.
  `map.js` and `geo.js` can still draw items whose coordinates came from Nominatim, since
  that is OSM data, not Google's.
- **Cost:** each Essentials SKU has 10,000 free calls a month, Pro 5,000, Enterprise
  1,000. Autocomplete keystrokes are free when the typing session ends in a Place
  Details call **with the same session token**. Field masks decide the tier, and a
  request is billed at the highest tier among its fields: `location`/`formattedAddress`
  are Essentials, `displayName`/`primaryType` are Pro, `regularOpeningHours`/`websiteUri`
  are Enterprise. Two people will never get near the caps, but set daily quotas in the
  Cloud console anyway.
- **Directions are free.** Google Maps URLs need no key, and a place ID in the URL
  opens that exact place. On an iPhone they open the Google Maps app.

**Check this now:** if the live "Start typing a place" field autocompletes against the
public Nominatim server, that is against its usage policy (no autocomplete, one request
a second). It should move onto §8.4.

### 8.3 Data

`mod.place` grows. The module gate in `lib/modules.js` must accept these **first**, or a
write will appear to succeed and change nothing:

```js
mod.place = {
  name,        // the user's own words for where ("that ramen bar in Adams Morgan").
               //   Stays. It is the fallback when there is no pin, and it is not Google's.
  gid,         // Google place ID. The ONE Google value stored permanently.
               //   Validate /^[A-Za-z0-9_-]{10,300}$/; it ends up in a URL.
  lat, lng,    // ONLY for legacy Nominatim pins. Never write Google coordinates here.
  book,        // boolean: "Book ahead"
  again,       // 'soon' | 'maybe' | 'once' | null: "Would you go back?" (set once done)
  memory,      // ≤2000 chars: "What was it like?" Separate from notes, so going somewhere
               //   doesn't overwrite why you wanted to go.
}
```

**Google's content is a cache, never the record:** `state.gplaces[gid] = { at,
displayName, shortAddress, area, type, lat, lng }`, swept after 30 days and refetched
lazily, shared across everybody like `state.places`. Hours and website are fetched when a
place page opens and are not stored.

**Rights**, following the split CLAUDE.md already draws:

| Field | Who may set it | Why |
|---|---|---|
| `gid` (pin / change the place) | the author | it changes what the item *is*, like the title |
| `book` | anyone who can see it | it's planning, like `when` |
| `again`, `memory` | anyone who can see it, once done | it's the record, like `done` |

A new `POST /api/item/:id/place` carrying `{book?, again?, memory?}` keeps PATCH's
rules intact, the same way `setWhen` got its own route.

### 8.4 Server: `lib/places.js`

Shaped like `watch.js`: a pure core the suite can test with no network, and the store
required lazily.

- `GET /api/places/suggest?q=&session=&lat=&lng=` → Autocomplete (New) with the
  session token, a location bias (the device's position if the client sent one, else a
  configured `placesBias`), and `origin` set so each prediction comes back with a
  distance. Strip the leading emoji first (§3's `leadEmoji`). Minimum 3 characters.
  Returns `[{ gid, main, secondary, meters }]` and **decides nothing**.
- **Pinning:** creating with `{ title, kind: 'place', gid, session }`, or
  `POST /api/item/:id/pin { gid, session }`, closes the session with one Place Details
  call (Pro fields: `id,displayName,shortFormattedAddress,addressComponents,location,primaryTypeDisplayName`),
  stores `gid`, and warms the cache.
- `GET /api/item/:id/place` → the live details for the place page (Enterprise fields:
  `regularOpeningHours,currentOpeningHours,websiteUri,googleMapsUri` plus the cached
  ones). Goes through `myItem()`, so it answers 404 for anything the caller can't see.
- **Config** (gitignored `config.local.json`): `googlePlacesKey` (server only;
  restrict it to Places API (New) and the Pi's IP), `googleMapsKey` (browser; restrict
  it by HTTP referrer to the app's domain and to Maps JavaScript API), and
  `googleMapIds: { dusk, forest }`. **With no key, the Places tab is the ordinary list
  from §3**, the same way the shelf works with no TMDB key. The suite runs with no key,
  so that path is the one it tests.
- **Privacy, worth writing into CLAUDE.md:** the typed text and, while you type on the
  Places tab with permission, the device's position go to Google. That's the same trade
  as TMDB and Nominatim, and private items are no exception. Never store the position.

### 8.5 Client

**Places tab.** When the tab's kind is `place` and a key exists, the screen swaps the
list for map + sheet:

- The map is a child of `.screen`, not `position:fixed`. Load Maps JS lazily the first
  time the tab opens (`importLibrary('maps')`, `importLibrary('marker')`), with the Map ID
  for the current theme. Markers are `AdvancedMarkerElement` with HTML content: a 40px
  `--sheet` bubble with a 2.5px ring (`--accent` to go, `--accent2` been) holding
  `leadEmoji(title).emoji`, or the kind icon when there is none.
- **Floating controls** (back, To go / Been, the rose) use `--glass` with a backdrop
  blur. They sit near the top edge, which is exactly what CLAUDE.md says Safari 26
  samples for the status-bar tint. **Measure on the phone.** If it tints, drop the blur
  or move them below the safe area.
- The sheet has a fixed height in v1, holding the header ("6 places to go", "with
  Linnea · closest first"), a Calendar icon button, the rows, the composer and the nav.
- **Distance** comes from `navigator.geolocation`, asked once when the tab first opens.
  If it is denied, drop the distance and sort by newest.

**Which one?** (`09-add-place`). After 3 characters the rows swap for up to three
predictions: a numbered tile, name, secondary text, distance. "Results from Google Maps"
sits above them. A new `crypto.randomUUID()` session per typing run. One tap creates the
item pinned. **+ creates it as words.** The visibility row still appears while typing.

**The place page** (`10-place`, `11-place-been`) replaces the item sheet for kind
`place`. Top to bottom:

1. A map snippet (180px, `--r` 20px) centred on the pin, with the X over it.
2. The title as typed in the serif at 28px, a pencil to edit the words (author only),
   then the pin icon + Google's name, then "Botanical garden · Northeast · 8.9 mi".
3. Four round actions: **Directions** (primary, opens a Google Maps URL with
   `destination_place_id`), **Plan it** (becomes **Go again** once been), **Website**,
   **Share** (`navigator.share` with `googleMapsUri`).
4. Live info card: hours ("Open today" in `--accent2`), address, website, with the line
   "Hours and address come from Google Maps, fresh each time you open this."
5. **Your plan:** When (with "Pick a day", saving on change as now) and **Book ahead**
   (switch, "A nudge to reserve once it has a day").
6. **Whose idea**, **Why go** (the existing notes), **Who sees it**.
7. **We went here**: a full-width `--sage-tint` button. It is `done`, by another name.
8. A card with **Change the place** (opens Which one? with the title as the query),
   **Move to another tab**, and **Delete** in `--warn`.

**Once been**, step 5 becomes a **Been together** card in `--sage-tint`: the date and
who ticked it off ("Sat, Nov 8 · Linnea ticked it off"), **Change date**, and **Would
you go back?** with three chips (Can't wait / Maybe someday / Once was enough). Why go
gives way to **What was it like?** (`memory`). "We went here" becomes a quiet "Not been
after all".

**Places without a pin** (every place on the live list today, the Arboretum included)
show **Find it on the map** in place of the map snippet, opening Which one? with the
title as the query. Never match them in bulk: CLAUDE.md's "a wrong poster is worse than
none" goes double for a pin.

**Optional, v1.1:** when a `book: true` place gets a day, the planning nudge says
"Book it" ("Linnea planned Blues Alley for Sat · book ahead").

---

## 9. Build order

Each step on its own, `npm test` green before the next, and CLAUDE.md updated in the
same commit as the thing it describes.

1. **Tokens:** Forest in, Olive out (with the `dw-theme` migration), the derived
   tokens, `--faint` → `--dim` for placeholders and the ring.
2. **Sheets:** every `.modal` becomes a bottom sheet with grabber and X; remove the
   stacked dismiss buttons.
3. **The list:** cards, sections, emoji tile (`leadEmoji`), ring on the right, header,
   the Done together chip, the composer.
4. **Shelf, home, account:** §4, §6, §7, including the logo fallback.
5. **The item sheet:** §5.
6. **Places server:** module fields + gate, `lib/places.js`, the routes, tests for the
   no-key fallback, the field gate, 404 scoping, session-token passthrough and the 30-day
   sweep.
7. **Places client:** the tab, markers, Which one?, the place page, Find it on the map.
8. **CLAUDE.md:** Themes, The map, Geocoding, HTTP routes, and the Google privacy note.

## 10. Open questions for Andrew

- Google Maps Platform needs a billing account with a card on file even inside the free
  caps. OK to set one up?
- **Would you go back?** is one shared answer in the mockups. One answer each would be
  more "with", at the cost of a second row.
- Pinning or changing the place: author only (proposed), or anyone who can see it?
- The Book ahead nudge: now, or later?
