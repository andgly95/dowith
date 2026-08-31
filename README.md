# Do With

A to-do list where the **with** is the point.

Not a task app with sharing bolted on: the unit is a list you keep *with someone*,
and it is titled from whichever side you're standing on. You see "to do with
Linnea"; she sees "to do with Andrew". The same list.

*Go record shopping. Watch "Obsession". Go swing dancing.* Not chores — which is
why the tick is a ring rather than a checkbox, and why anyone who can see a thing
can tick it off. Doing it is the point, and "Linnea ticked off record shopping" is
the nice bit.

## Who sees what

| | |
|---|---|
| **Just me** | you, and nobody else — not even the person the list is with |
| **Us** | everyone in that list |
| **Anyone** | everyone you share any list with |

*Anyone* isn't a feed. It's a standing wish — "I want to see this band" — sitting
where any of your people might say *let's go*. It surfaces in all your lists, and
stops at the edge of them. No discovery, no directory, no strangers: your friend's
friend can't see it, and neither can anyone else.

## Groups

A list can hold two people or eight. A pair needs no name; a group gets one.

## Getting in

By invite only. Signing in on its own gets you nothing — someone sends you a link,
and the link says who sent it before you commit to anything.

## Modular by design

Items carry a namespaced bag that features hang off, with one rule: a module can
add fields, and a module can never change who can see something. Two ship today —
a place and a link — which is the smallest number that proves the seam works. A map
view is a renderer over the items that carry a place.

## Running it

```bash
npm install
npm test          # 43 assertions + a headless-chromium check
node server.js    # port 3006
```

Needs a Google OAuth **Web application** client ID, or Cloudflare Access in front,
in `config.local.json` (gitignored). No client secret: ID tokens are verified
against Google's public keys.
