# Today's question: handoff

For the Claude Code session on the Pi. **Read the repo's `CLAUDE.md` first**, the *Just us*
and *Nudges* sections above all, because this feature borrows both of their rules.

Andrew's brief:

> Can we add like a daily question that you have to answer to see the other person's
> answers, maybe you can select whether you want romance or sexual or friend type
> relationship questions and have a streak feature, kind of like Agape

**This is a server change and a client change.** A new pure module (`lib/questions.js`),
its catalogue, its routes and its truth tables, then the card, the sheets and two screens.
Nothing in the app is changed on this branch. It only adds `design/daily-question/`.

Two calls were made without Andrew, and are easy to change (§10): **pairs only** for now,
and **a missed day ends the streak**.

---

## 0. Before you start

**The GitHub copy may be behind the Pi.** Merge `design/daily-question` onto the Pi's tree,
and where this file contradicts the live code, it is describing the live code imperfectly.
This was drawn against `c28baf7` ("Posters and recipe cards finish with the moment too").

| Path | What |
|---|---|
| `index.html` | Every screen side by side, Dusk/Forest toggle. Open it in a browser. |
| `screens/*.html` | Static renders, Dusk. `screens/forest/` is the same in Forest. `screens/png/` for GitHub. |
| `mockup-src/*.dc.html` | The canvas sources. Every size and colour is in there as inline styles. `node mockup-src/render.mjs` regenerates `screens/` (needs `npm i --no-save linkedom`). |
| `questions.md` | The starter catalogue: Friends, Romance, Spicy, with stable ids. |

**Mock data, deliberately.** The partner is a stand-in called **Sam** and every answer is
made up. The questions are the real ones from `questions.md`.

**Tokens.** All derived from the palette, the way `CLAUDE.md` asks:

| Mockup | CSS | What |
|---|---|---|
| `cardTop` | `color-mix(in srgb, var(--accent) 13%, var(--card))` | the top of the card's wash, fading to `--card` by 75% |
| `cardLine` | `color-mix(in srgb, var(--accent) 22%, transparent)` | the card's 1px inset ring |
| `flameBg` | `var(--accent-tint)` | the streak pill, the flame's halo |
| `glow` | `color-mix(in srgb, var(--accent) 28%, transparent)` | the streak moment's outer glow |
| `faceBg` | `color-mix(in srgb, var(--ink) 16%, var(--card2))` | the initial circles |
| `roseTint`, `roseInk`, `roomCard`, `roomTop`/`roomSheet`, `onRose` | as in the Just us handoff | everything on a Spicy day |

Type follows the redesign: **the question is the display face** (the serif, 22px on the
card, 24–26px in a sheet, 18.5px in the history); everything else is `--sans`.

**Run `npm test` after every step in §9.**

---

## 1. The experience

One question a day, the same one for both of you. **You answer it to see theirs.** Once you
have both answered, you can react, say something about it, and turn an answer into a thing
to do. Every day you both answer adds one to a streak.

It lives on the pair list, because the list IS the relationship in this app: the card sits
at the top of the list, above the whose-idea sections, and scrolls with it.

### 1.1 The card, in three states

**A. You haven't answered** (`01-on-the-list`). The full card:

- `Today's question · Romance` (the kind, in `--dim`), and the **streak pill** on the right:
  a flame and the number, in `--accent` on `flameBg`. The pill opens the history.
- The question in the serif, 22px. Tapping it opens the answer sheet.
- Sam's initial with a small sage check if Sam has answered, `Sam answered` and
  `Answer to see theirs`, and an **Answer** button (filled accent, 44px). If Sam hasn't
  answered: no check, `Sam hasn't answered yet`, same button.

**B. You've answered, Sam hasn't.** A slim row (not drawn; build it from the card's parts):
the question icon, `Today's question · Waiting on Sam`, the streak pill. Tapping it opens
your answer, which you can still change.

**C. You've both answered.** A slim row: `You both answered` and the pill. If Sam's answer
arrived since you last looked, it says `Sam answered · See what they said` with an accent
dot. Tapping it opens the reveal.

Not on the **Places** tab (the map has no room for it) and not in **Done together**.
Shown on every other tab of a pair list, in the same place.

### 1.2 Answering (`02-answering`)

A bottom sheet, like every sheet now: grabber, `Today's question` in the serif with the date
and the kind under it, the 44px X.

- The question, 24px serif.
- **Your answer**: a textarea, 16.5px, accent border once it has something in it.
- **Sam's answer, locked**: Sam's initial, `Sam's answer`, `Locked` with a lock icon, and two
  rounded bars in `--card2`. **The bars are a drawing, not blurred text**: nothing of Sam's
  answer is on the phone (§4). `You'll see it the moment you answer.`
- **Answer and see Sam's**, full width. Disabled until there is something to send.
- Under it, the truth about editing: if Sam has answered, `Sam's already in, so yours is
  final once you send it.`; if not, `You can change it until Sam answers.`

For a **this or that** question the textarea is two big buttons instead, side by side, and
choosing one sends it.

### 1.3 Both answers (`03-both-answers`)

What the sheet becomes the moment you answer, without closing:

- **The streak moment**, if your answer completed the day: a filled accent disc with the
  flame, ringed in `flameBg` and glowing, then `13 days in a row` in the serif and
  `You've both answered every day since Nov 6`. Use `burst()` from `motion.js` on the disc
  and `haptic('success')`. At 7, 30, 100 and 365 the line changes (`A whole week of
  answers`, `A month of answers`…). If you were first, no moment: the sheet just says
  `Sent. You'll see Sam's when they answer.` and the card goes to state B.
- The question, 21px serif.
- **Sam's answer** first, then **yours**, each in a card: initial, name, the time, the text
  at 17px.
- On Sam's: **reactions**, four emoji buttons (❤️ 😂 🥹 🔥), one at a time, tap again to take
  it back. On yours, `Sam can react once they've seen it`, or Sam's reaction once there is
  one.
- **+ Add to Activities** on both (§1.4). Once added: `✓ On your list`, in sage.
- **Say something about it…**: a one-line reply, pill-shaped, with send. Replies show
  under the answers as small bubbles, oldest first.
- **Every question so far ›** at the bottom.

A **this or that** day where you chose the same: `You both said a mountain cabin`, in a sage
chip, in place of the two cards.

### 1.4 Add to Activities

This is what makes it a Do With feature and not an Agape clone: questions like "what's
something you've never done that you'd want to try with me?" produce things to do.

Tapping it switches to the Activities tab and opens the composer **with the answer in it,
selected**, so it can be trimmed ("Pottery class") before adding. It is an ordinary new item:
`shared`, the existing create route. If the answer was Sam's, PATCH `ideaBy` to Sam after
creating it (the author may credit, see *Whose idea*), so it lands under Sam's ideas.
`✓ On your list` is remembered on the device per answer; it is a convenience, not a record.

**Never on a Spicy day.** That would put the answer on the list.

### 1.5 Every question so far (`04-every-question`)

A pushed screen, reached from the streak pill and from the bottom of the reveal.

- Back to the list, `Your questions` in the serif, `Every one you've answered together`.
- Three tiles: **days in a row** (with the flame), **longest streak**, **answered together**.
- By month, newest first, one card per month: the date and the kind, the question in the
  serif, then `Sam` and `You` with their answers. A matched this-or-that shows the sage chip.
- A day only you answered: `Only you answered. Sam can still catch up.` A day only Sam
  answered: `Answer to see Sam's`, which opens the answer sheet for that day (§2.4).
- Under the last card: `Just us questions aren't here. They keep to the rose.`

### 1.6 Which questions (`05-which-questions`)

A sheet, from **Today's question** in the list's settings (the title's ⌄ menu) and from a
long press on the card.

- **Kinds of question**: three rows with switches.
  - **Friends**: `Easy ones. Food, memories, this or that.` On by default.
  - **Romance**: `About the two of you, and how it feels.` Off by default.
  - **Spicy**, with the rose icon and a rose switch: `Intimate ones. They open in Just us,
    never on the list.` Off by default.
- Under a switch you turned on that Sam hasn't: `Waiting on Sam. They won't be told you
  turned it on.` (rose ink for Spicy, `--dim` for the others). Once you both have:
  `You're both in.` in sage.
- `You each choose for yourselves. A kind comes up once you've both turned it on.`
- **Questions come from**: the kinds in play, `Friends · Romance`, or `Nothing yet. Turn
  one on.`
- **Reminder**: `Nudge me at` with a time field, `Only if I haven't answered yet`. Default
  8:00 PM. Clearing the time turns it off.
- **Pause questions on this list**: pauses for both of you, and says who did on the card
  (`Paused by Sam · Resume`). Paused days don't count against the streak.

The canvas board has a tweak, `samSpicy`, to show both states of the Spicy note.

### 1.7 A Just us day (`06-just-us-day-list`, `07-just-us-day-room`)

When today's question is a Spicy one, **the list never shows it.** The card goes rose (the
rose icon, a rose wash and ring) and says, in the italic serif, `Today's is one for just the
two of you.` Sam's status as usual, and **Open** with a lock, in rose, which opens the rose
straight onto the question.

In the room the sheet is the room's: the `Just us` back pill, `Today's question · Spicy`,
the question in the serif, your answer (`Only Sam will read this`), Sam's locked answer on
`roomCard` with rose bars, **Answer and see Sam's** in rose, and the lock note:
`Only the two of you can open this. The question never shows on the list, in a notification
or in your history, and Sam's answer isn't on your phone until you've answered.`

The reveal on a Spicy day is §1.3 in the room's colours, **without** Add to Activities and
without the streak disc's accent (use `--rose` for the disc).

**The rose's front door gains a fourth door**, `Today's question`, only while Spicy is in
play. Like the others it names nothing: `Waiting for you`, `Sam answered`, or `You both
answered`. The room's own history of Spicy questions is behind it.

---

## 2. The rules

### 2.1 One question a day, the same for both

A **day** is a calendar date in the pair's zone, `YYYY-MM-DD`, never an instant, for the same
reason `item.when` is. The zone is stored on the pair's record, set from
`Intl.DateTimeFormat().resolvedOptions().timeZone` by whoever first turns questions on, and
changeable in the settings sheet if the two of you move. The server computes "today" in that
zone with `Intl`; it runs in UTC and its own date is wrong half the evening.

The day's question is **picked once and stored** (`qid`), the first time anyone asks for that
day. Changing the kinds later changes tomorrow, never today.

### 2.2 Which question

`questions.pick({ inPlay, asked, pairKey, date })`, pure:

- Rotate through the kinds in play, in catalogue order, by the day's index since the pair
  started, so two kinds alternate and three take turns.
- Within a kind, take the next question not yet asked, in an order shuffled once per pair
  (seeded by `pairKey`), so two pairs don't march through the same sequence. When a kind is
  used up, start it again.
- No kinds in play (both turned everything off, or paused): no question, no card.

### 2.3 Answering, and seeing theirs

- **Sam's answer is not sent until you have answered.** Not blurred, not hidden in the DOM:
  absent from the response. `view(day, uid)` returns the partner's answer text only when
  `day.answers[uid]` exists, and otherwise just `{ answered: true|false }`. This is the
  feature; it gets a truth table (§8).
- **Your answer can change until both have answered.** After that it is final: the
  answer route answers 409. Otherwise the second person could read the first answer and
  then the first could rewrite theirs to match.
- Reactions and replies exist only once both have answered (409 before).
- Answers are text up to 1,000 characters, or a pick index for this-or-that. Replies are
  up to 500 characters, 20 a day.

### 2.4 Catching up

Either of you can answer a past day at any time. It shows in the history and unlocks the
other's answer, but **it does not mend the streak**: a day counts only if both answers have
an `at` on that date, in the pair's zone.

### 2.5 The streak

- **Current**: consecutive counted days, ending today if today counts yet, else yesterday.
  Today not being done yet never breaks it; the day has to end first.
- **Paused days are skipped**, neither counting nor breaking.
- **Longest** and **answered together** (days with both answers, catch-ups included) come
  from the same pass.
- Pure, in `lib/questions.js`, from the day records. Never stored.

### 2.6 Kinds are opt-in, each of you for yourself

`decks[uid]` is the list of kinds you turned on. A kind is **in play** when both of you have
it. **The wire carries your own list and the kinds in play, and never Sam's list.** So
turning on Romance or Spicy tells Sam nothing, the same arrangement as the rose's things to
try. This applies to all three kinds, not just Spicy, because "I wanted romance questions and
you didn't" is not a message the app should deliver for anyone.

Spicy needs a **pair**, and is in play only when both have it on.

---

## 3. The model

Keyed by the **pair of people**, exactly like `state.pleasure`, with `pleasure.pairKey`:

```js
state.questions[pairKey] = {
  zone: 'America/New_York',
  decks:  { [uid]: ['friends', 'romance', 'spicy'] },   // each person's own opt-ins
  remind: { [uid]: '20:00' | null },
  paused: { by, at } | null,
  startedOn: 'YYYY-MM-DD',                               // for the rotation's day index
  days: {
    'YYYY-MM-DD': {
      qid, kind,                                         // picked once, stored
      answers: { [uid]: { text?, pick?, at } },
      reacts:  { [uid]: '❤️' | '😂' | '🥹' | '🔥' },      // on the OTHER person's answer
      replies: [{ by, text, at }],
      paused?: true,                                      // a day that fell while paused
    },
  },
}
```

- **Leaving a pair list deletes the record**, in the same line that deletes the rose's:
  those answers were given to one person in particular.
- **Pairs only.** On a group list every route here answers 404, and there is no card.
- The catalogue lives in `lib/questions.js` (or `lib/questions-catalogue.js` beside it),
  server-side, with the ids from `questions.md`. An id outside it is refused.

---

## 4. Routes

Everything goes through `myPair(req, res)` (already in `routes.js` for the rose), so a list you
are not in, or a group list, is a 404.

| Route | What |
|---|---|
| `GET /api/space/:id/question` | today (§4.1), the streak, your settings, the kinds in play |
| `POST /api/space/:id/question/answer` | `{date, text}` or `{date, pick}`; 409 once both answered; not for a Spicy day |
| `POST /api/space/:id/question/react` | `{date, emoji \| null}`; 409 before both answered |
| `POST /api/space/:id/question/reply` | `{date, text}`; 409 before both answered |
| `POST /api/space/:id/question/settings` | `{decks?, remind?, zone?, paused?}` — your own decks and reminder only |
| `GET /api/space/:id/question/history?before=YYYY-MM` | a month at a time, newest first, **no Spicy days** |
| `GET`·`POST /api/space/:id/pleasure` | gains `question` (§5): today's Spicy question, answering it, its history |

### 4.1 Today, on the list's route

```js
today: {
  date, kind: 'romance', type: 'open' | 'pick', text, options?,   // no text on a Spicy day
  justUs: false,                                                   // true on a Spicy day: no kind, no text
  mine: { text?, pick?, at } | null,
  theirs: { answered: true } | { text?, pick?, at },               // text only if you answered
  reacts, replies,                                                  // only once both answered
  final: bool,
}
```

### 4.2 On `/api/state`

Per **pair** space, two things for the shelf and the card's first paint: `question: { streak,
waiting }`, where `waiting` means today exists and you haven't answered. No text, no kind.
The shelf's list card shows the flame and the streak beside the counts, and an accent dot when
`waiting`.

---

## 5. Spicy keeps to the rose

Every rule the rose has, Spicy has:

- **Its question and answers travel only on the rose's route.** `GET /api/space/:id/question`
  on a Spicy day says `justUs: true` and the two answered flags, nothing else. The text, the
  answers, the reactions, the replies and the Spicy history all ride `GET /api/space/:id/
  pleasure` as `question: questions.roomView(record, uid)`, and answering one goes through
  `POST /api/space/:id/pleasure` with `{ question: { date, text } }`.
- **Never in a push, never on `/api/state`, never in the history route.** The day still counts
  toward the streak, which is a number and says nothing.
- **Never Add to Activities.**
- **Pairs only**, keyed by the two of you, deleted when either leaves.
- In play only when **both** turned it on, and turning it on tells the other nothing (§2.6).

`lib/pleasure.js` itself does not need to change. The pleasure GET attaches the question view
beside what it already returns; keep that logic in `lib/questions.js`.

---

## 6. Nudges

Through `push.js`'s `sendTo`. The audience is the other member of the pair and nobody else;
there is no item, so `audienceFor` doesn't apply, but its rule does: never further than a
screen would go.

**No question text in any push, on any day, of any kind.** A lock screen reads itself out
loud, and a Friends question is no different from a Spicy one at a glance from across a room.

| When | To | Title · body |
|---|---|---|
| Sam answers and you haven't | you | `Sam answered today's question` · `Answer to see theirs` |
| Sam answers and you already had | you | `Sam answered` · `See what they said` |
| Your reminder time, you haven't answered, today exists, not paused | you | `Today's question is waiting` · `Keep your 12-day streak going` (or nothing, at 0) |

At most one of each per person per day. Reactions and replies push nothing for now; they are
seen the next time the card is open. The reminder runs off a minute check alongside the cook
timers' tick, in the pair's zone.

---

## 7. Copy

Sentence case, no exclamation marks, the partner by first name, the way the rest of the app
talks. The strings in §1 are the strings. `Sam` stands for the other person's name.

---

## 8. Tests

`test/test.js`, pure first:

- **`view` truth table**: for every combination of (you answered, they answered), the
  partner's text is present **only** when you answered. Dump the whole view to JSON and
  search it for the partner's text.
- **Final**: once both have answered, a changed answer is refused; before, it replaces.
- **Kinds**: in play is the intersection; for every combination of your and their decks, the
  view for you contains your list and the intersection, and **never their list**. Assert by
  searching the JSON for a deck only they turned on.
- **Spicy never leaks**: with Spicy in play and today a Spicy day, the text of the question
  appears in none of `/api/state`, `/question`, `/question/history`, and none of the payloads
  handed to `sendTo` (stub it). It does appear on `/pleasure`.
- **Pick**: deterministic for a pair and a date; no repeat within a kind until it is used up;
  today's `qid` survives a change of kinds.
- **Streak**: consecutive days; today undone doesn't break it; a catch-up doesn't count;
  paused days are skipped; a date boundary in the pair's zone is honored on a server in UTC
  (answer at 11:30 PM New York, which is the next day in UTC).
- **Pairs only**: every route is 404 on a group list and to a stranger.
- **Leave**: leaving the pair list deletes `state.questions[pairKey]`.

`test/client-check.js`:

- The card is on the list and **hit-testable**; state A shows the question, B and C the slim
  row, by layout not `.hidden`.
- On a Spicy day the open list's text contains **no Spicy question** (the same assertion the
  rose's front door has), and Open lands in the room with it.
- Answering reveals the partner's answer and the streak moment draws (catch it mid-flight,
  as the tick-off check does).
- Add to Activities lands an item under the partner's ideas.

---

## 9. Build order

1. **`lib/questions.js`** and the catalogue: `pick`, `view`, `roomView`, `streak`, `inPlay`,
   `clean*` for answers, settings and replies. Pure. The §8 pure tests.
2. **Routes** (§4) and the `/api/state` summary. The leave cleanup. The route tests.
3. **The card** (state A, then B and C) on the pair list, and **the answer sheet**.
4. **The reveal**: answers, reactions, replies, the streak moment.
5. **Add to Activities.**
6. **Which questions**, from the list settings.
7. **Every question so far.**
8. **Spicy**: the rose card, the room's question, the front door's fourth door, `/pleasure`
   carrying it. The leak tests.
9. **Nudges**: partner answered, the reminder.
10. Update `CLAUDE.md`: a *Today's question* section with §2, §5 and §6 in it, the routes table
    and the model.

---

## 10. Open, for Andrew

- **Group lists.** Pairs only for now. The natural next step is Friends questions for a group,
  where everyone answers to see everyone's and the streak counts days everyone answered.
- **The streak.** A missed day ends it. Agape-style alternatives: one free day off a week
  each, or a "freeze" earned every 7 days. Either is a change to `streak()` alone.
- **More questions.** `questions.md` is a starter set. Later, the "AI, quietly" thread could
  propose questions shaped by the list itself ("You both added three ramen places, …"), still
  picked from by the same rules.
