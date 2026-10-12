# The archive becomes a game: flight that feels good, and a tree you light up by exploring it

You're picking up Marks where the crit-8 riff left it: a weekly tree of marks,
server-rendered, `node:sqlite` on the Fly volume, no build step, and an
Archive at `/archive/` that you fly through in three.js. Read `README.md`,
`CLAUDE.md`, `src/`, `public/` and `spec/` first. They're small. The
archive lives in three files: `public/archive-scene.js` (rendering, flight,
pointer input), `public/archive.js` (keys, D-pad, HUD, announcements) and
`public/archive-tree.js` (pure tree logic, unit-tested in
`spec/archive-tree.test.ts`).

This run turns the archive from a diagram you can move around into
**something that plays like a small exploration game**. It has four parts
that feed each other:

1. **Game feel.** Moving through the tree should feel responsive and
   physical, and arriving somewhere should feel like an event.
2. **Fog of war.** Marks you haven't explored are dark embers. Flying to one
   lights it up for good, for you. The tree slowly becomes a map of what
   you've read.
3. **Time travel.** A timeline you can scrub, or play, to rewind the tree to
   any past moment and watch it grow back. A glowing thread runs through the
   branches in the order things were actually said.
4. **Together in the archive.** You see everyone else who's in the archive
   right now, as wisps of light that fly along the branches as they move.
   When two or more of you stop at the same mark, you can chat there. The
   chat vanishes when the mark empties.

Nobody is around to answer questions. Where this prompt leaves something
open, make the call and explain it in the commit message.

## Part 1: game feel (mostly `archive-scene.js` and `archive.js`)

Today the camera already eases along the real edges with a pulse of light
running ahead. Keep that. What's missing is everything around it:

- **Arrival.** When a flight lands, the destination reacts. The bubble does a
  quick squash-and-pop (overshoot, then settle), a thin shockwave ring expands
  from it and fades, and a small burst of glow particles sprays outward and
  dies off. The camera should arrive with a slight overshoot and settle rather
  than stopping dead. Keep it short (well under half a second) so fast
  movement never feels sluggish. Revisiting a mark you've already lit gets a
  smaller version. Lighting a new one gets the full version (see Part 2).
- **No snapping, and buffered input.** Right now a key press mid-flight
  starts a new flight from the old destination, and the camera visibly jumps.
  Fix that: a new flight starts from wherever the camera actually is. Holding
  an arrow key (key repeat) or tapping quickly should feel like gliding along
  the branches, with chained flights getting shorter, not like a series of
  restarts. The logical selection, URL hash, preview and live-region
  announcement can still update immediately on each key.
- **Hitting an edge.** There's already a `bump` class when a move goes
  nowhere. Make it directional: the camera nudges a little toward the blocked
  direction and springs back, so you can feel the wall.
- **Sound, off by default.** Add a "Sound" toggle button to the HUD
  (`aria-pressed`, keyboard reachable, in `<main>` like the rest of the HUD).
  Synthesize everything with the Web Audio API. No audio files and no
  dependency. A soft tick on arrival, pitched by depth in the tree. A brighter
  two-note chime when a mark lights up for the first time. A short rising
  arpeggio when a week is fully lit. A low muted thud on an edge bump. Keep it
  quiet and pleasant. The setting doesn't need to survive a reload.
- **Reduced motion wins.** With `prefers-reduced-motion`, none of the
  squash, shockwave, burst, overshoot or nudge happens. Keep the existing cut
  behaviour. Sound is not motion, so the toggle still works there.

## Part 2: fog of war

### What counts as "seen"

A mark is **seen** by a visitor (the cookie id, as now) when:

- they arrive at it in the 3D archive (selected by key, D-pad, click or deep
  link; hovering doesn't count), or
- they open its page, `GET /m/<id>`, which works with JS off, or
- they wrote it (`mine`). That's derived, so it needs no row.

Week roots are always lit. They're the landmarks of the map.

### Server

- Add a table, additively and safely at boot against the populated volume:
  `seen (visitor_id text not null, mark_id integer not null references
  marks(id), seen_at text not null, primary key (visitor_id, mark_id))`.
  Inserting is idempotent (`insert or ignore`). Never touch `marks` rows.
- `GET /m/<id>` records a seen row for that visitor. A GET with a side effect
  is fine here, because only the reader ever sees it.
- `POST /seen` with a form-encoded `id` records one mark as seen for the
  current visitor and answers `204`. An unknown or malformed id stores nothing
  and gets a 4xx, never a 500. Reject cross-site writes: if `Sec-Fetch-Site`
  is present and isn't `same-origin`, answer `403`. The client sends it with
  `fetch(..., { method: "POST", keepalive: true })` and doesn't wait for it.
- `/archive.json` gains a per-request `seen: boolean` on every mark, worked
  out the same way as `mine`: true for roots, for your own marks and for
  marks you have a row for. It still never includes `visitor_id`.
- **No read receipts.** Nothing anywhere reveals whether, or how many,
  *other* people have seen a mark. Seen-state is private to the person it
  belongs to.
- The no-JS `/archive/` list (`archiveList` in `src/render.ts`) shows a small
  text marker, such as `new`, on marks this visitor hasn't seen, so the
  fallback carries the same information as the scene. Everything in the list
  stays fully readable. The fog is a 3D-scene thing only. Leave the home page
  and mark-page walls as they are.

### The scene

- **Unseen marks are embers:** small, dim and desaturated, below the bloom
  threshold, with no halo. Their label shows only the author's name; the body
  snippet appears once lit. Hovering an unseen mark shows the author and
  "Unexplored, fly here to read it" in the preview instead of the body.
  Selecting it lights it, so keyboard users never lose access to the text.
  Don't rely on colour alone: size, glow and label all change.
- **Lighting up** is the Part 1 arrival at full strength. The ember ramps to
  its full colour (teal, or rose for your own), bloom flares, the burst fires
  and the label unfurls its snippet. Then the client records it with
  `POST /seen` and updates the in-memory tree, with no refetch.
- **Branches carry the light.** An edge between two lit marks glows at full
  strength; an edge into unexplored territory stays dim. **Frontier** marks,
  the unseen children of lit marks, flicker faintly, so there's always a hint
  of where to go next. No flicker with reduced motion.
- **Progress, not competition.** The HUD shows how much of the selected
  mark's week you've lit, for example `Week of 5 Oct: 9 / 23 lit`, plus a
  quieter all-time total. When the last mark in a week lights up, that week's
  root gets a lasting "complete" treatment, such as a gold crown ring and a
  brighter spine segment into it. A one-off celebration plays (a bigger burst,
  plus the arpeggio if sound is on), and the live region says so. A week
  with no marks isn't "complete". There are no leaderboards, no streaks, no
  comparison with other visitors, and nothing that nags.
- **Announcements:** `describe()` says "unexplored" for unseen marks. The
  first arrival at a mark is announced as new. Completing a week is
  announced.
- Put the logic in `archive-tree.js` as pure functions: lit/total per week,
  the frontier, whether a week is complete, and how marking a node seen
  updates the tree. Unit-test them in `spec/archive-tree.test.ts`. Keep the
  three.js side to rendering.

## Part 3: time travel

The tree's shape shows *who replied to whom*. It hides *when*. Each mark's
`createdAt` is already in `/archive.json` (and a week root's is its Monday
00:00), so this part is client-side only, with no server or schema change.

### The timeline

- Press `T`, or a "Time travel" button in the HUD, to enter time-travel mode.
  A **timeline bar** slides up along the bottom of the stage. It runs from the
  oldest week's start to now, with a tick and a short label at every
  Monday 00:00 seal, and a small dot for every mark at its posting time. The
  dots cluster where the room was busy, so the bar doubles as a picture of the
  semester's rhythm. Lit and unlit marks (Part 2) show on the dots too.
- The scrub head is a real `<input type="range">`. It's keyboard-operable,
  and its `aria-valuetext` gives the date, time and how many marks exist at
  that moment, so it works without the 3D scene making sense to you.
- Leaving time-travel mode (`T` again, `Esc`, or the button) snaps the tree
  back to now. `Esc` already means "up" in `KEYS`. It leaves time travel
  only while the mode is on, and keeps its old meaning otherwise.

### Rewinding the tree

- Scrubbing back makes the tree **ungrow**: every mark posted after the scrub
  time shrinks away and its branch retracts toward its parent. Scrubbing
  forward regrows them. At any scrub time, the tree looks exactly as it did
  at that moment, including week roots that didn't exist yet. Drive this off
  the existing growth machinery (edge draw range plus bubble bloom), but keyed
  to the scrub time instead of time since page load.
- While rewinding, the particles that drift down the spine flow *backward*,
  up toward the present, and the scene takes on a slight cool desaturation.
  Playing forward restores both. With sound on, a short synthesized
  tape-rewind swoop plays on a big backward scrub.
- If the selected mark stops existing at the scrub time, the selection moves
  to its nearest ancestor that does exist, and the live region says so. Arrow
  keys still navigate, but only through marks that exist at the scrub time.

### The time line through the branches

- In time-travel mode, draw a **luminous thread through the marks in posting
  order**. Each mark connects to the next one posted, so the line visibly
  hops between branches and weeks the way the conversation actually did.
  Make it thinner and a different hue from the tree's edges, and route it
  as a gentle curve rather than a straight line, so it reads as a separate
  layer woven through the tree. It's drawn only up to the scrub time.
- A small **comet** rides the head of the thread at the scrub time, with a
  short fading tail, so scrubbing feels like dragging time itself through the
  tree.

### Play, step, jump

- `Space` (or a Play button) **replays history** from the scrub point at a
  speed where a busy week takes roughly 8 to 10 seconds. Quiet stretches are
  compressed, so nobody watches days of nothing. Each mark sprouts as its
  moment arrives, with a soft tick if sound is on. A "follow" toggle makes the
  camera fly to each new mark as it appears. Off by default, the camera stays
  where you put it.
- **Crossing a seal is the drama.** When playback passes a Monday 00:00, the
  week that just ended flashes and visibly locks (its root dims slightly and
  gets a seal ring). The new week's root then sprouts at the top of the spine,
  and the old one slides down-left into the past. The live region announces
  the seal.
- `,` and `.` **step** to the previous or next mark in time, moving the scrub
  head to it and selecting it, so you can walk the conversation in the order
  it was said. `Shift+,` and `Shift+.` jump to the previous or next seal.
  Announce each step, for example `Tue 6 Oct, 3:14 pm: Ana, under Week of
  5 Oct: "…"`.
- The preview card of a selected mark gains **"Rewind to when this was
  posted"**, which scrubs to that moment in time-travel mode.
- Time travel is spectating. Playback and stepping don't mark anything seen.
  Only arriving at a mark the Part 2 way does that, so stepping onto a mark
  with `,`/`.` counts but watching it sprout in playback doesn't. Embers stay
  embers in the replay.
- **Reduced motion:** scrubbing jumps cut-style with no ungrow animation, no
  comet tail, no backward particles and no seal flash. Playback steps from
  mark to mark with cuts. All the information is still there.

### Logic and tests

Pure functions in `archive-tree.js`, unit-tested in
`spec/archive-tree.test.ts`:

- posting order across the whole tree
- which nodes exist at time *t*
- next and previous mark in time from a given time
- the seal times between two moments
- the nearest existing ancestor of a node at time *t*
- the replay clock's compression of quiet stretches

Edge cases worth a test: two marks with the same `createdAt`, so order must
be stable (fall back to id). A time before the first week. A week root at
exactly its seal time.

## Part 4: together in the archive (live presence, live branches, mark-side chat)

This is the app's first real-time feature. The README currently says
real-time "belongs to later crits", so update that. Three things go live:
where people are, what they say at a mark, and **every new mark**. The moment
someone posts a mark or a reply, its branch grows into everyone's archive,
and it appears on the home page and mark pages too, without a reload.

### Transport: Server-Sent Events, no dependency

- `GET /live` is a `text/event-stream` built on plain `node:http`. Use SSE,
  not WebSockets: SSE needs no dependency, and the rules forbid adding one
  without justification. The browser sends updates with small same-origin
  `fetch` POSTs. Send a comment heartbeat every ~20s so Fly's proxy keeps the
  stream open.
- **A stream isn't a person.** Opening `/live` gets you the events. You only
  appear to others (`join`) once your archive client posts a position. So the
  home and mark pages can listen for new marks without anyone showing up as
  "here".
- All presence and chat state lives **in server memory only**, in a new
  module (`src/presence.ts`). Never write it to SQLite and never log
  message text. A restart or deploy wipes it, and that's correct. There's
  one machine (`--ha=false`), so in-memory is the whole truth.
- **Identity:** each person gets an **ephemeral presence id**, random and
  never derived from `visitor_id`, which still never leaves the server. Map
  presence id → visitor id server-side only. Every POST carries the presence
  id, and the server checks that the request's `visitor` cookie owns it.
  Presence ids are visible to everyone, so this ownership check is what stops
  someone moving or speaking as another person. Wrong owner gets `403`.
- **Reconnects:** when a stream drops, wait ~5s before broadcasting
  `leave`. If the same visitor reconnects inside that window, give them back
  the same presence id, so a network blip or a deploy doesn't make everyone
  flicker out and back in.
- **The machine must still sleep.** An open stream keeps the Fly machine
  awake (`auto_stop_machines` in `fly.toml`). The client closes its
  EventSource once the tab has been hidden for ~60s, and reopens it, then
  re-sends its position, when the tab is visible again. A forgotten
  background tab must not keep the app running all night.
- **Limits** (the machine has 256 MB): cap total streams (around 60) and
  streams per visitor (around 4). Rate-limit moves to ~10/s and chat to about
  1 message/s with a small burst, returning `429` past the limit. Reject
  cross-site POSTs with the same `Sec-Fetch-Site` rule as `POST /seen`.
- **Event shapes** are JSON:
  - `hello`: your presence id, plus a snapshot of everyone else
  - `join`, `move`, `leave`, `wave`
  - `say`, which goes only to people at that mark
  - `mark`: a new mark, sent to every stream, hidden visitors included
  - `week`: a new week root was created by the lazy rollover
  
  A person is `{ id, name, colour, markId, timeTravelling }`. `name` is the
  `name` cookie (the name they last posted under), capped at `MAX_NAME`, or
  "Someone" if they've never posted. Disambiguate duplicate names with their
  colour, for example "Someone (amber)". The client renders every name and
  message with `textContent` only.

### Seeing each other

- Each other person is a **wisp**: a small glowing orb in their own colour,
  picked from a palette distinct from the tree's gold, teal and rose. It
  orbits the bubble they're at, and several people at one mark spread around
  it rather than stacking. Their name floats beside it as a CSS2D label that
  fades with distance like the bubble labels. You don't see a wisp for
  yourself; you have the selection ring.
- **Travelling:** when someone moves, their wisp **flies along the real
  edges** from their old mark to the new one, using the same `flightPath` and
  easing as your own camera. A short fading trail follows it, so you can
  watch them travel through the branches. If they move again mid-flight, the
  wisp carries on from where it is, never snapping (the same rule as Part 1).
- **Off-screen people** get a small chip at the edge of the stage in their
  colour, with their name, pointing toward them. Clicking it flies you there.
- **A "Here now" panel** in the HUD lists everyone present with where they
  are (the week label and "on Ana's mark"). Each entry has **Fly to** and
  **Follow** buttons. Follow makes your camera ride along behind them until
  you press a movement key or unfollow. `P` flies you to the next person in
  turn. This panel is also the accessible way to know who's around.
- **Wave:** `W` sends a wave at your current mark. Everyone who can see that
  mark gets a ripple in your colour from it (and a soft chime if their sound
  is on). It's rate-limited to one every few seconds.
- **"Hide me"** is a HUD toggle (`aria-pressed`), on the server side. It
  sets a `presence=hidden` cookie, and a hidden visitor is never broadcast at
  all: you still see others, but nobody sees you, and you can't chat. It
  survives a reload because it's a cookie.
- **The live region** stays polite. It announces when someone joins or
  leaves the archive and when someone arrives at or leaves *your* mark, but
  not every move anyone makes.
- **With other parts:** someone else's presence never marks anything seen for
  you. Following them does, because you actually arrive (Part 2). A peer at an
  ember you haven't lit doesn't reveal its text. If a peer's mark doesn't
  exist at your scrub time (Part 3), their wisp waits, ghosted, at the
  nearest ancestor that does. A peer who is time travelling shows a small
  clock glyph.
- **Reduced motion:** wisps cut from mark to mark with no flight, trail or
  orbit, and waves show as a brief static highlight.

### Chatting at a mark

- A **room is a mark.** When two or more visible people are at the same mark,
  a **chat panel** opens in the HUD for everyone there: "Here with Ana, Ben",
  the message list, and a labelled text input (around 200 characters, Enter
  sends, `Esc` returns focus to the stage). The archive's keys already ignore
  input that isn't aimed at the body or stage. Keep it that way so typing
  never moves you. When you leave the mark, the panel closes for you; when
  you're the only one left, it closes.
- **Speech bubbles in the scene:** each message also floats briefly above
  the speaker's wisp (or above your selection, for your own), MMO-style, then
  fades. They're rendered as DOM with `textContent`.
- **The server enforces the room:** `say` is accepted only from a visible
  person who is currently at that mark with at least one other visible person
  there. It goes only to the people at that mark. Blank or zero-width-only
  text is rejected with the same `hasVisibleContent` check as marks. Over-long
  text is cut to the limit.
- **It's ephemeral, and it says so.** A room keeps at most its last ~20 lines
  or ~10 minutes, whichever is less, so someone who walks up mid-conversation
  sees a little context. The moment a room empties, its lines are dropped. The
  panel carries a quiet line: "Chat disappears when everyone leaves. Leave a
  mark to keep something." Chat never becomes a mark on its own.
- **Sealed weeks:** chatting at a mark in a sealed week is fine. Nothing is
  added to the week and nothing persists, so the seal's promise holds. Say
  this in the README.
- **Mute:** each person in your chat panel has a Mute button that hides
  their messages and bubbles for you. It's client-side and lasts for the
  session, and it's the only moderation a room of a dozen needs.
- **A second live region** announces other people's messages ("Ana: …"),
  separate from the navigation announcements.

### New branches, live

- **The broadcast.** After `store.post` succeeds, and only then, broadcast a
  `mark` event on `/live`. Sealed-week rejections, blank posts and unknown
  parents broadcast nothing. The payload has exactly the public fields
  `/archive.json` already sends for a mark (`id`, `parentId`, `weekId`,
  `isRoot`, `name`, `body`, `createdAt`, `childCount: 0`, `children: []`),
  plus the parent's new `childCount`. `mine` and `seen` are worked out **per
  recipient**, server-side, against each stream's visitor id: true for the
  author's own streams, false for everyone else. Never `visitor_id`.
- **Rollover stays lazy.** When a request triggers a new week root
  (`ensureWeekIn` in `src/db.ts`), broadcast a `week` event with the new week
  and its root. Do it through a hook or callback on the store, not a timer.
  The rule says rollover happens on request and never on a timer, so an
  archive left open over Monday 00:00 updates on the next request anyone
  makes. Position posts are frequent, so that's soon.
- **In the archive, a new branch grows in.** Add the node to the in-memory
  tree and re-run `layout()`. A new reply widens its week, so siblings can
  shift. Every node whose position changed **glides** to its new spot over
  about 0.6s, and its edges bend with it. Never jump. The new edge then grows
  out from its parent and the bubble blooms, reusing the load-time growth
  animation. If it's someone else's mark, it arrives as an ember (Part 2),
  with a soft sprout sound if sound is on. The frontier flicker and the HUD's
  lit/total update. The current week can lose a "complete" crown this way;
  let it fade off gracefully. If the camera's selected node moves, the camera
  follows smoothly.
- **The author.** If the author is present and visible in the archive, their
  wisp gives a brief bright flare at the new mark's parent as it sprouts.
  Hidden authors' marks still appear; they just aren't tied to a wisp.
- **With time travel (Part 3):** a new mark gets a dot at the end of the
  timeline bar and extends the thread. If you're scrubbed into the past, it
  stays hidden until you return to now. If playback has caught up to now,
  it sprouts as it lands.
- **A new week, live:** on a `week` event, play the same seal-crossing
  animation as Part 3's playback. The old week flashes and locks, and the new
  root sprouts at the top of the spine. Announce it. If you were sitting in
  the old current week, you stay where you are; it's simply sealed now.
- **Grow a branch from where you are.** The preview card of a mark in the
  current week gets a small **Reply here** form (name prefilled from the
  `name` cookie, same limits as the mark page). It posts to the existing
  `POST /m/<id>` handler with `Accept: application/json`. For that header
  only, the handler answers `201 { id }` instead of the 303 redirect, and
  `403`/`404` with a JSON reason instead of the HTML pages. The form posts
  through the same `store.post` path, so sealing and validation are exactly
  the same. Your new branch grows in right in front of you, already lit
  because it's yours, with the full Part 1 ignition. Then the camera flies
  to it. Sealed marks get no form, just the existing "sealed" line. With JS
  off, the mark page is still where you reply.
- **Home and mark pages, as progressive enhancement.** A small script
  (`public/live-wall.js`, no three.js) listens on `/live`. When a `mark`
  event arrives whose parent is the mark this page shows (the current week's
  root, on `/`), it inserts the mark at the top of the wall. The wall is
  newest-first (`wall()` in `src/render.ts`). An empty wall is a
  `<p class="empty">` rather than a list, so replace it with the list.
  Build it with DOM and `textContent` to match `markItem`'s markup exactly:
  the name, body, time, "yours" badge and reply link. Give it a short
  highlight that fades. Reply counts on the page's existing marks update too. The same
  hidden-tab rule closes the stream. With JS off, these pages are exactly
  what they are today.

### Logic and tests

- `src/presence.ts` holds the session and room logic as plain functions or
  a class over an injected clock: join, move, leave with grace, room
  membership, history trimming and rate limits. Unit-test it directly, like
  `spec/store.test.ts` does for the store.
- Client state lives in `public/archive-presence.js`: the EventSource,
  reconnect and visibility handling, merging snapshots and events, and who's
  at my mark. Keep the parts that can be pure, pure, and test those too.
  Rendering wisps and bubbles goes through a small API on the scene object.

## Specs

Extend `spec/marks.test.ts` (it gates the deploy) with HTTP checks against
the running app:

- every mark in `/archive.json` has a boolean `seen`, and still no `visitor_id`
- roots and your own marks are `seen: true` with no visit
- after `GET /m/<id>` with a cookie, that mark is `seen: true` for that cookie
  and `false` for a fresh one
- `POST /seen` stores and answers 204. An unknown or malformed id stores
  nothing and isn't a 500. A cross-site `Sec-Fetch-Site` gets 403.
- the no-JS `/archive/` list shows the "new" marker on an unseen mark and not
  on a seen one
- `GET /live` answers `text/event-stream` with a `hello`. Neither it nor
  any later event ever contains a visitor cookie's value.
- a stream that never posts a position never appears in anyone's events
- with A streaming, B posting a mark on `/` gives A a `mark` event with the
  public fields and `mine: false`. B's own stream gets `mine: true`. A reply
  on `/m/<id>` carries the right `parentId` and the parent's new
  `childCount`.
- a rejected post (blank, unknown parent, sealed week) broadcasts nothing
- `POST /m/<id>` with `Accept: application/json` answers `201 { id }` and
  the mark exists afterwards. An unknown parent is a JSON 404. Without the
  header the 303 behaviour is unchanged.
- in `spec/store.test.ts`, with an injected clock: the new-week hook fires
  exactly once when a request crosses Monday 00:00 Sydney, and never on a
  plain request within the week
- with two visitors streaming, B moving to a mark gives A a `move` with B's
  presence id. Closing B's stream gives A a `leave` after the grace period.
- a POST using another visitor's presence id gets 403 and broadcasts nothing.
  A move to an unknown mark gets a 4xx and broadcasts nothing.
- a hidden visitor (`presence=hidden`) never appears in anyone's events
- with A and B at the same mark, A's `say` reaches B. C, at a different
  mark, gets nothing. Saying when alone, at a mark you're not at, or while
  hidden is a 4xx. Blank text is rejected, and a burst past the limit gets
  429.
- chatting creates no marks (the mark count in `/archive.json` doesn't
  change), and once the room empties a newcomer gets no history

The SSE checks must close every stream they open (`AbortController`) so the
test run never hangs. Don't wait out real timers longer than necessary: make
the grace period and limits configurable by env var for the test container
if you need to. If you do, keep the production defaults in the code.

Keep `spec/invariants.test.ts` green and every existing spec passing.
`pnpm check` must be green against a locally running app before each push.

## Look at it

This is mostly a feel change, so tests aren't enough. Run the app against a
scratch `DATA_DIR` seeded with `scripts/seed.ts` (never `/data`). Drive
`/archive/` in a real browser (headless Chrome is fine) and take
screenshots: the tree mostly dark on a fresh cookie, a mark mid-ignition, a
completed week with its crown, and the HUD counter. For time travel, also
capture the timeline bar, the tree rewound to mid-week, the thread and comet
mid-scrub, and playback crossing a seal. Seed marks across at least three
weeks with replies, so the thread visibly hops between branches. For
presence and chat, open two or three browser contexts with separate cookies
and different `name` cookies. Screenshot one context watching another's wisp
fly between branches, an off-screen chip, two wisps at one mark with the chat
panel open, and a speech bubble. For live branches: post a reply from one
context, both from the mark page and from the archive's Reply here, and
screenshot the other context's archive mid-sprout with its siblings gliding
aside. Check that a second context sitting on `/` sees the new mark appear at
the top of its wall without a reload. Check that hiding the tab closes the stream
and showing it again restores your wisp for the others. Check there are no
console errors, that fast key-repeat doesn't snap the camera, that leaving
time travel restores the full tree, that typing in chat never moves you, and
that the list view and JS-off pages still work. Then judge it: if arriving
doesn't feel like an event, the rewind doesn't feel like turning back time,
or meeting someone at a mark doesn't feel like bumping into them, tune it
until it does.

## Docs

Update `README.md` before the rules: a short section arguing why the
archive is a game of discovery. The point is that the tree becomes a map of
what *you've* read, which suits a room that comes back weekly; it's not about
engagement. Say that seen-state is private, and that everyone starts with a
dark archive the day this ships. Add a paragraph on time travel: the tree
shows who answered whom, and the time line shows when. Replaying a week is
how you see a conversation's real rhythm. Seals are where the timeline's
promise ("nothing can be added afterwards") becomes something you can watch
happen. Add a section on being in the archive together. A room of a dozen
mostly meets at crits, and this makes the archive somewhere you can bump into
each other. Chat is deliberately ephemeral: marks are what you keep, chat is
what you say while standing there. That's why chatting in a sealed week
doesn't break the seal. Say that new marks now arrive live, everywhere,
and that the week still rolls over lazily: an open archive sees the seal on
the next request, not on a timer. Rewrite "What's deliberately not here yet"
so it no longer claims real-time is missing. Add the new keys to the
README's archive section.

Add two lines to the rules block in `CLAUDE.md` (below the riff block, which
stays untouched):

- the `seen` table is per-visitor, never exposed, and there are no read
  receipts
- presence and chat are in memory only, never written to SQLite and never
  logged. They use ephemeral presence ids, never `visitor_id`, over SSE with
  no dependency, and every POST is checked against the visitor cookie that
  owns the presence id.
- a live `mark` event carries only the fields `/archive.json` already
  exposes. `mine` and `seen` are worked out per recipient. It's broadcast
  only after a successful `store.post`.

## Leave alone

- No accounts, no new dependencies (Web Audio, SSE and three.js cover all of
  this, so no `ws` and no socket library), no build step, no CDN. Chat names
  come from the existing `name` cookie; don't add a profile or a sign-in.
- Posting, replying, sealing, week arithmetic and the lazy rollover. The
  rules don't change. Posting only gains a broadcast after success and a
  JSON answer for `Accept: application/json`. The form-post-and-redirect
  path behaves exactly as now.
- What the existing keys *mean* (`move()` in `archive-tree.js`) and the tree
  layout. This run changes how movement *feels*, not where it goes. Time
  travel only hides what didn't exist yet; it never repositions nodes. Add
  the new keys (`T`, `Space`, `,`, `.`, `P`, `W`) to the legend without
  changing the old ones.
- Time travel needs no server change and no schema change. Presence and chat
  need no schema change at all; they never touch SQLite.
- The home page and mark pages get no presence or chat, and no wisps. Their
  only live addition is new marks appearing on the wall, as progressive
  enhancement. With JS off they look and work exactly as they do now.
- User text still goes in via `textContent` only on the client and
  `escapeHtml` on the server.
- The list view stays complete and readable for screen readers and JS-off
  visitors.

Commit in small, deployable steps (seen-state server + specs, game feel, fog
of war, `/live` + presence server + specs, live branches, wisps, chat, time
travel, docs), and keep `main` green throughout. Finish each part, complete
and polished, before starting the next, in the order 1, 2, 4, 3. Presence,
live branches and chat come before time travel because being in the archive
together is what the room asked for most. Part 4's notes on time travel
apply once Part 3 exists, so wire them up when you build Part 3. If you run short, a finished, good-feeling smaller game beats four
half-done ones. Whatever didn't get built goes in the README's "not here
yet" section, so the next run can pick it up.
