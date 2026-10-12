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
**something that plays like a small exploration game**. It has three parts
that feed each other:

1. **Game feel.** Moving through the tree should feel responsive and
   physical, and arriving somewhere should feel like an event.
2. **Fog of war.** Marks you haven't explored are dark embers. Flying to one
   lights it up for good, for you. The tree slowly becomes a map of what
   you've read.
3. **Time travel.** A timeline you can scrub, or play, to rewind the tree to
   any past moment and watch it grow back. A glowing thread runs through the
   branches in the order things were actually said.

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
weeks with replies, so the thread visibly hops between branches. Check there
are no console errors, that fast key-repeat doesn't snap the camera, that
leaving time travel restores the full tree, and that the list view and JS-off
pages still work. Then judge it: if arriving doesn't feel like an event, or
the rewind doesn't feel like turning back time, tune it until it does.

## Docs

Update `README.md` before the rules: a short section arguing why the
archive is a game of discovery. The point is that the tree becomes a map of
what *you've* read, which suits a room that comes back weekly; it's not about
engagement. Say that seen-state is private, and that everyone starts with a
dark archive the day this ships. Add a paragraph on time travel: the tree
shows who answered whom, and the time line shows when. Replaying a week is
how you see a conversation's real rhythm. Seals are where the timeline's
promise ("nothing can be added afterwards") becomes something you can watch
happen. Add the new keys to the README's archive section. Add one line to the rules block in
`CLAUDE.md` (below the riff block, which stays untouched) covering the `seen`
table: it's per-visitor, never exposed, and there are no read receipts.

## Leave alone

- No accounts, no new dependencies (Web Audio and three.js cover all of
  this), no build step, no CDN.
- Posting, replying, sealing, week arithmetic and the lazy rollover. None of
  it changes.
- What the existing keys *mean* (`move()` in `archive-tree.js`) and the tree
  layout. This run changes how movement *feels*, not where it goes. Time
  travel only hides what didn't exist yet; it never repositions nodes. Add
  the new keys (`T`, `Space`, `,`, `.`) to the legend without changing the
  old ones.
- Time travel needs no server change and no schema change.
- User text still goes in via `textContent` only on the client and
  `escapeHtml` on the server.
- The list view stays complete and readable for screen readers and JS-off
  visitors.

Commit in small, deployable steps (server + specs, then game feel, then fog
of war, then time travel, then docs), and keep `main` green throughout. If
you run short, ship parts 1 and 2 complete and polished before starting
part 3. A finished, good-feeling smaller game beats three half-done ones.
