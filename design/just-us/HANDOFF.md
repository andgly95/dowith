# Just us, reimagined: handoff

For the Claude Code session on the Pi. **Read the repo's `CLAUDE.md` first**, its "Just us"
section above all, then `design/redesign/HANDOFF.md` (PR #1). This branch is stacked on
that one for its tokens and sheets. It does not depend on the recipes branch (PR #2).

Andrew's brief:

> Can we reimagine the pleasure inventory (rose) feature on the do with app?

**This is a client-only change.** Every number and view in these screens comes from what
`GET /api/space/:id/pleasure` already returns. `lib/pleasure.js`, its routes and its tests
stay exactly as they are, and so do the privacy rules (§6). If you find yourself editing
`view()`, stop: something here has been misread.

Nothing in the app is changed on this branch. It only adds `design/just-us/`.

---

## 0. Before you start

**The GitHub copy is behind the Pi**, as the redesign handoff says. Merge `design/just-us`
onto the Pi's tree the same way, and where this file contradicts the live code, it is
describing the live code imperfectly. The rose code was rewritten recently (3ab4e52, "a body
you tap, cards, matches that bloom"); this builds on that, it doesn't undo it.

| Path | What |
|---|---|
| `index.html` | Every screen side by side, Dusk/Forest toggle. Open it in a browser. |
| `screens/*.html` | Static renders, Dusk. `screens/forest/` is the same in Forest. Starting state only. |
| `mockup-src/*.dc.html` | The canvas sources. Every size and colour in this doc is in there as inline styles. `node mockup-src/render.mjs` regenerates `screens/` (needs `npm i --no-save linkedom`). |

**Mock data, deliberately.** The partner in every screen is a stand-in called **Sam**, and
**every answer is made up**. The catalogue words are the real ones from `lib/pleasure.js`. No
screenshot of the live feature is in this repo, because they show real answers and this repo
is public.

**Tokens.** The mockups' names, in CSS:

| Mockup | CSS | What |
|---|---|---|
| `t.rose` | `--rose` | already per theme |
| `roseTint` | `color-mix(in srgb, var(--rose) 16%, transparent)` | chips, the back pill, icon tiles |
| `roseInk` | `color-mix(in srgb, var(--rose) 75%, var(--ink))` | text on the tint |
| `onRose` | `color-mix(in srgb, var(--bg) 65%, black)` | text on a filled `--rose` button |
| `roomCard` | `color-mix(in srgb, var(--rose) 7%, var(--card))` | every card in the room |
| `roomTop` / `roomSheet` | the sheet gradient: `--rose` at 12% fading to 4% over the sheet colour by 340px | the room itself (the live `.modal-in.rose` already does this at 15% → 5%; keep yours if it looks right) |
| `cool` | **`--rose-cool`**, new, per theme: Dusk `#7a7b9d`, Forest `#758697` | the "No" end of the warmth scale |

**Warmth** is one colour ramp from `--rose-cool` (No) to `--rose` (Yes, please):
`color-mix(in oklab, var(--rose) <w>%, var(--rose-cool))`, with `w` from the live `WARM`
table (no 0, soft 20, maybe 50, yes 78, love 100; the live table has soft at 15 and maybe at
45, and either is fine). In Dusk that is `#7a7b9d`, `#8e7999`, `#ad7694`, `#ca728e`, `#e0708a`.

**Run `npm test` after every step in §9.**

---

## 1. The experience

Four screens, and one that isn't drawn:

1. **`01-front-door`.** The rose opens here, always. **Nothing on it names an act or a body
   part**: a phone gets glanced at, and this is the screen that is open when it does.
2. **`02-body`.** Points on a soft figure that glow with how much you like it there, with
   **Together / Yours / Sam's** views. Tap a point and answer act by act on a row of five
   tiles, with Sam's answer marked on the same row.
3. **`03-things-to-try`.** One card at a time, as now, but bigger, with five answer bubbles
   that warm as they go right, plus Back and Not now.
4. **`04-you-both-want`.** The matches, grouped by how keen you both are, with **Pick one for
   us** and writing your own question.
5. **All answers** (not drawn). The live "The list", restyled with the body's tile rows
   (§4.4).

The two segmented controls stacked at the top of the sheet (Body / Things to try, then One at
a time / The list) are gone. The front door replaces the first, and §4's "All answers" link
replaces the second.

---

## 2. The front door (`01-front-door`)

A bottom sheet, as now. Top to bottom:

- **"Just us"** in the serif, italic, 34px, and "with Sam · only the two of you" under it
  (`data.partner`). The X is a 44px circle on `roseTint`.
- **The matches card.** A line rose at 44px in `--rose`, the **count** in the serif at 54px,
  "things you both want" under it, on a `roseTint` → `roomCard` gradient. When there are new
  matches, a filled `--rose` chip top-right: "**2 new**". Tapping the card opens §5.
  - Count: `data.matches.length`. New: matches not in `seenSet()`.
  - No matches yet: the count reads 0 and the line reads "Anything you both lean yes to
    shows up here".
- **Three doors**, each a 72px `roomCard` row with a 44px `roseTint` icon tile and a chevron:
  - **Body:** "Where each of you likes it · 11 of 15 places", the parts you have answered
    anything for, out of `data.parts.length`.
  - **Things to try:** "14 of 27 answered · 13 left", and a 30px progress ring (a
    `conic-gradient` in `--rose` over `roseTint`) before the chevron. Counts include your
    own questions, as `cardsHtml()` does now.
  - **Ask your own:** "A question for the two of you". It opens §5 and focuses the field.
- **A lock line** at the bottom, 13px `--dim`: "Only the two of you can open this. Things to
  try show up only when you both lean yes, so a no never gives anything away."

**Opening behaviour changes.** `openRose()` currently opens straight onto the list when
there are unseen matches, which puts names on screen the moment the sheet opens. Open on the
front door every time. The "2 new" chip is the invitation, and the dot on the corner rose
works exactly as now.

---

## 3. Body (`02-body`)

### 3.1 The page

- **Header:** a back pill ("‹ *Just us*", the words in the italic serif, on `roseTint`),
  then **"Body"** in the serif at 32px.
- **Together / Yours / Sam's**: a three-way segmented control on `roomCard`; the selected
  segment is filled `--rose` with `onRose` text.
- **The figure**, centred, with a small **Front / Back** control top-right (stacked, 64×36
  segments) and a 74px warmth bar bottom-left labelled "No … Yes".
- **The panel** for the chosen part (§3.3). Neck is chosen when the page opens, so the panel
  is never empty.
- A note: "Sam sees your answers here, and you see Sam's. That's the point of this half:
  'this, not that.' Tap your answer again to take it back."

### 3.2 The figure

It replaces the zoned mannequin (`FRONT`, `BACK`, `figure()`, the `.zone` paths). Two layers
in a 200×420 box, drawn at 90%:

- **The body**: one fill colour (`roomSheet` mixed 12% toward `--ink`), no outline. A head
  ellipse, a neck, a torso path, arms and legs as round-capped strokes, hands and feet. The
  exact shapes are in `mockup-src/JustUs-Body.dc.html` (`figure_svg` drew them); copy them.
- **Points**, one HTML `<button>` each, absolutely positioned over the SVG (not SVG
  elements, so they are real buttons with labels and focus). 44px hit area, centred on the
  point:
  - **Front:** hair (100,18), ears (76,44)/(124,44), lips (100,58), neck (100,80),
    shoulders (68,96)/(132,96), chest (100,106), nipples (85,124)/(115,124), stomach
    (100,172), hips (70,214)/(130,214), genitals (100,238), inner thighs (91,274)/(109,274),
    hands (41,226)/(159,226), feet (82,404)/(118,404).
  - **Back:** hair (100,30), ears (76,46)/(124,46), neck (100,80), shoulders, back
    (100,150), butt (86,240)/(114,240), hands, feet.
  - A part with two points (ears, hands …) lights both; either one opens it.
- **What a point shows**, for heat `h` (0–1, or none):
  - unanswered: a 9px hollow dot with a 1.5px `--dim` ring. The label says "not answered
    yet".
  - answered: a 9px dot in the warmth colour, plus a blurred glow behind it,
    `24 + 22h` px across, opacity `0.3 + 0.6h`, `filter: blur(7px)`.
  - chosen: a 24px ring in `--ink`. In the Together view, a part where you **both** said yes
    or yes, please to any act gets a 19px ring in `--rose` (`heatOf().both`, as now).
- **Heat:** Together is the live `heatOf()`. Yours and Sam's average just that side's
  answers for the part.

### 3.3 The panel

A `roomCard` panel, 24px radius:

- The part name in the serif at 25px; on the right, the partner's badge (an 18px circle,
  2px `--ink` ring, their initial) and "Sam's answer".
- A tiny scale legend: "← No" … "Yes, please →" in 12px `--dim`.
- **One row per act**: the act name (16/600) and on the right your answer in its warmth
  colour ("You: Yes, please"), or "Not answered" in `--dim`. Under it, **five tiles** in a
  row, 40px tall, 12px radius, 5px apart, cool → warm left to right. Each tile is its warmth
  colour at 20%; yours is filled solid with a 2px inset `--ink` ring. **The partner's answer
  is their badge, sitting on the top edge of that tile.** Leave 13px between the row's label
  and its tiles so the badge never touches the text.
- Tapping your answer again clears it, as now. Keep `data-act` and `data-level` on the tiles:
  the client check finds them by those.

This replaces `dots()` for body answers. The five-dot row with a label under the chosen dot
read like a form; five tiles read like a scale.

---

## 4. Things to try (`03-things-to-try`)

### 4.1 The page

- Back pill and **"Things to try"** (serif 32), with **All answers** (text, `roseInk`) on
  the right of the pill row. It opens §4.4.
- Progress: "14 of 27 answered" left, "13 left" right, 13.5px `--dim`, then a 4px bar in
  `--rose` over `roseTint`.

### 4.2 The card

- **The deck:** the card with two cards peeking behind it (inset 11px and 22px, 9px and 18px
  lower, `roomCard` at 85% and 60%). It reads as a pile, so "one at a time" explains itself.
- **The card:** 330px tall, 28px radius, a `roomCard` gradient warming toward `--rose` at
  the top (22%), and a deep shadow. Inside: the group chip top-left ("Playful · 4 of 13", on
  `roseTint`); the label in the serif at **38px**, vertically centred; at the bottom,
  "Sam only finds out if you both lean yes." in 13.5px `--dim`.
- **Swiping is unchanged**: right is yes, left is no, up is maybe, with the card flying off
  in that direction (`fling()`, `bindCard()`).

### 4.3 Answering

- **Five bubbles** under the card, in five equal columns: No, Soft no, Maybe, Yes, Yes,
  please. Each sits centred in a fixed 50px box, so the labels line up: `34 + 14w` px across,
  filled with its warmth colour at `0.35 + 0.5w`, with a 1.5px inset ring of the full colour.
  So they grow and warm left to right. Labels 12px/600, `white-space: nowrap`.
- A hint row under them: "← swipe for no", "↑ maybe", "yes →", 12px `--dim`.
- **Back** (undo icon) and **Not now**, as 44px text buttons at the bottom.
  - Not now is the live "Skip for now" (`skipped`).
  - **Back is new**: it reopens the last card answered *in this sitting*, with that answer
    showing, and answering it again replaces it. Keep the ids answered this session in a
    stack beside `skipped`. It never shows anything the queue wouldn't.
- **The end:** a 64px line rose in `--rose`, "That's all of them" (serif 30), "You can
  change any answer from the list, or ask something of your own.", and **See what you both
  want**: a filled `--rose` button with `onRose` text. It is coral (`--accent`) today, which
  breaks the room's one colour.

### 4.4 All answers (not drawn)

The live `listHtml()`, restyled: sections by group (Gentle, Playful, Adventurous, Your own) as
`roomCard` cards, each item a row with the §3.3 tile scale and no partner badge (their answers
to these are never sent, and must not be). Your own questions keep the way to take them back,
as a 44px text button "Take back" rather than a bare ✕. Opening this list no longer marks
matches seen; only §5 does.

---

## 5. You both want (`04-you-both-want`)

- Back pill, then **"You both want 9"**, the count in `--dim`.
- **Pick one for us**: a card on the `roseTint` → `roomCard` gradient. Before a pick:
  "Can't choose? Let it pick one of these for you." and a full-width `--rose` button with a
  shuffle icon. After: "How about" (13px `roseInk`) over the pick in the serif at 28px, and
  the button reads **Another**. It is a random choice from `data.matches`, never the same one
  twice in a row, entirely on the device, and never stored or sent anywhere.
- **Three groups**, by the cooler of the two answers:
  - **You both said "yes, please"** (both `love`), heading in `--rose`.
  - **You both said yes** (both at `yes` or warmer), heading in `roseInk`.
  - **One of you said maybe** (anything else that matched), heading in `--ink2`, and each row
    gets a sub-line: "You: maybe", "Sam: maybe" or "Both of you: maybe".
  - A heading reads "You both said yes · 4". An empty group isn't shown.
- **Rows:** the label in the serif at 19px in a `roomCard` card, hairlines between. A new
  match (in `fresh`) gets a filled `--rose` "New" chip. Opening this screen marks matches
  seen, which is what the old list did.
- **Ask your own**, at the bottom: a 50px field ("Something you'd like to try", 80 chars, the
  live `rsNew`) and a 50px round `roseTint` + button, then: "Sam sees the question, not who
  asked it. It shows up here only if you both lean yes, and only you can take it back."
- **No matches yet:** the live `matchesHtml()` empty copy, and no pick card.

---

## 6. What stays exactly as it is

- `lib/pleasure.js`, both routes, the wire, and every test that pins them.
- **The rules:** a pair only; keyed by the two people, not the list; body answers shown to
  the partner in full; things to try shown only as matches; the partner's try answers never
  sent; no push, no digest, nothing on `/api/state`.
- The corner rose and its dot, `peekRose()`, `seenSet()` / `markSeen()`.
- **The bloom** when a match happens while you answer. It shows the label, which is fine: the
  person looking is the person who just answered.
- `--rose` as the room's one colour, with `--accent` nowhere inside the sheet.

---

## 7. Accessibility and motion

- Every point, tile and bubble is a real button with a label. The points say the part and
  whether it's answered; the tiles say the level and, on the partner's, "(Sam's answer)".
- Together / Yours / Sam's and Front / Back are radio groups (`role="radiogroup"`,
  `aria-checked`).
- The glow is decoration. Nothing is shown by colour alone: the panel names every answer in
  words.
- Reduced motion: no card fling (as now), no glow transition, the bloom without its draw-on.
- `esc()` on your own questions and on `data.partner`, as now.

---

## 8. Tests

`test/client-check.js` walks the rose (lines ~558–590 on GitHub's copy). Keep these working
by keeping their hooks, and update the rest in the same commit:

- `#spaceRose` and `#roseSheet` stay.
- `.zone[data-part="neck"]`: the points replace zones. Give each point `data-part`, and change
  the selector to `[data-part="neck"]`.
- `[data-act="kiss"][data-level="love"].on`: keep `data-act` / `data-level` and an `.on`
  class on the chosen tile.
- `[data-rs="try"]`: the front door's Things to try door. Give it `data-rs="try"`.
- `.rs-prog` text containing "1 of": keep the class on the progress line.
- `[data-mode="list"]` then `[data-id="blindfold"][data-level="yes"]`: the All answers link
  gets `data-mode="list"`, and §4.4's rows keep `data-id` / `data-level`.

Add:

- **The front door names nothing:** with matches present, the open sheet's text contains no
  label from `data.try` and no part from `data.parts` (assert on `textContent`).
- The three views change the figure: a part answered only by the partner glows in Together
  and Sam's, and is hollow in Yours.
- Back on the cards returns the previous card with its answer marked.
- Visibility by layout, not `.hidden`, as CLAUDE.md says.

---

## 9. Build order

Each on its own, `npm test` green before the next, CLAUDE.md's "Just us" section updated in
the same commit as what it describes.

1. **Tokens:** `--rose-cool` in both themes, the warmth ramp, the room colours.
2. **The front door**, and `openRose()` always opening on it.
3. **You both want** (§5), with Pick one for us and Ask your own.
4. **Things to try** (§4): the deck, the bubbles, Back, the rose end screen, All answers.
5. **Body** (§3): the figure, the points, the three views, the tile panel. Biggest, so last.
6. **CLAUDE.md:** rewrite the "Just us" bullets that describe the old screens (the five-dot
   scale, the two-tier tabs, opening onto new matches).

## 10. Open questions for Andrew

- **Opening on the front door every time** (proposed), or still straight onto new matches?
- **"Sam's" view of the body map:** the data is already shared in full, so nothing new is
  revealed. Is a whole view of it welcome, or should the map stay Together and Yours?
- **Pick one for us:** keep it, or is it one feature too many?
