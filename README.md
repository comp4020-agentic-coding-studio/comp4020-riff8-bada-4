# Marks

Marks is a shared noticeboard for a small, specific room: a crit group, and
whoever else wanders in. Type a name and a short line and it joins everyone
else's. Reply to any mark and that mark becomes a little wall of its own. At
midnight on Monday, Sydney time, the week is sealed into the archive, and a
fresh one starts.

## What good means here

Good, for this app, isn't "used by many people." [Robin Sloan's *An App Can
Be a Home-Cooked Meal*](https://www.robinsloan.com/notes/home-cooked-app/)
argues that software doesn't need scale or a business model to be worth
building. It can be made, like a meal, for people you actually know, and
judged by whether it serves them rather than whether it grows. Marks is built
for a room of a dozen people, not a public feed. [Ink & Switch's *Malleable
Software*](https://www.inkandswitch.com/essay/malleable-software/) holds the
same idea at another scale: tools shaped for exactly the work in front of
them. That's the standard for the schema too. It should be the smallest shape
that carries what the room does.

So there are still no accounts. A visitor is a random id in a cookie, set the
first time they show up. That's enough to tell two people apart and to badge a
mark as "yours" when you're back, but not to verify anyone. A name is just a
label someone types.

## Why a week

A flat wall worked for one crit. It doesn't survive a semester. After a few
weeks, reading top to bottom stops being the whole interface and becomes a
scroll past things everyone has already read. Pagination or ranking would
have fixed the length but not the shape.

A week is the room's own unit. The crit meets weekly, the briefs turn over
weekly, and a conversation about this week's work mostly belongs to this
week. So every week gets a **root mark**. Everything posted on the home page
hangs under it, and anything can be replied to, so a thread grows down from
whatever started it. The home page only ever shows this week, which keeps it
short for the same reason the original wall was short.

## Why sealing is an honest promise

At 00:00 Monday the week is archived, and archived means read-only for good:
no new marks, no replies, no edits. Marks were always permanent. Sealing
extends that from "you can't take it back" to "the conversation is over",
which is a promise about the past that the app can actually keep. When you
read last week, you're reading what it was, and nobody can quietly add to it
afterwards to change what it meant.

Nothing runs at midnight to do this. The app's machine sleeps when nobody's
using it, so the first visit after Monday 00:00 notices the new week and
creates its root. Weeks nobody visited don't get one.

## The tree and the archive

Each week's root has last week's root as its leftmost child, so the whole
history is still one tree. The **Archive** draws it as a sky. Each week is a
star system: its root is the star, the marks posted that week are planets
circling it, and replies are moons, with replies to replies as moons of
moons. Every orbit ring is a parent pointer made visible.

How close a conversation orbits says how alive it is. A planet's distance
from its star is set by the newest mark anywhere in its thread, on a log
scale, so a minute, an hour, a day and a week ago all sit visibly apart. You
can see at a glance what the room is talking about *now*, and a reply
visibly pulls a thread back in: the planet spirals to the innermost orbit
while the others ease outward to make room. A thread nobody touches drifts
slowly out. The past is further out still, along a spiral arm of dust where
older weeks recede into the fog, each smaller, its star cooling from gold
to amber to deep red. A sealed week's sky is frozen as it was at the seal,
which is the sealing promise again: what you see is how that week ended.

The orbits run on the wall clock, so two people looking at the archive at
the same moment see the planets in the same places. You fly it with the
keys: ↑ to what a body orbits, ↓ to its outermost moon, ← one orbit out to a
quieter conversation, → one orbit in to a livelier one. Out past the last
planet, ← carries on into last week, because the past is further out. `[`
and `]` jump between weeks, Home comes back to this one, and Enter opens a
mark's page. **Pause orbits** stops the sky, and hovering a body slows it to
a crawl so it's easy to click. With reduced motion the orbits stand still.
Without JavaScript or WebGL it's the same tree as nested lists, in posting
order, one expandable section per week. That's also the view screen readers
get.

This is the one place the app asks for JavaScript, and it's the one place it
takes on a real dependency: three.js, served straight from the app's own
`node_modules` without a CDN or a build step. Posting, replying and reading a
mark all work with scripts off.

## Why the archive is a game of discovery

Marks you haven't read yet are dark embers: small rocks with only a rim of
starlight and the author's name. Fly to one, or open its page, and it lights
up for good, for you. Over a semester the sky becomes a map of what *you've*
read, with the frontier (the unread replies to things you have read)
flickering faintly at its edges. When every mark in a week is lit its star
gets a gold crown.

That suits a room that comes back once a week. The question on Monday is
"what did I miss?", and a dark patch answers it without anyone having to
mark things read. It isn't about engagement: there are no streaks, no
leaderboards, nothing that nags, and nothing compares you with anyone else.
Seen-state is private. The server keeps one row per visitor per mark read,
never sends it to anyone else, and never says whether or how many other
people have read something. Everyone started with a dark archive the day
this shipped.

## Time travel

The tree shows who answered whom. It hides *when*. Press T (or **Time
travel**) and a timeline slides up, with a tick at every Monday seal and a
dot for every mark, so the bar is also a picture of the semester's rhythm.
Scrub it back and the sky ungrows: marks posted later shrink away, their
rings retract, weeks that hadn't started yet vanish, and planets migrate as
threads come alive and go quiet. A thread of light joins the marks in the
order they were said, hopping between branches and weeks, with a comet at
its head.

Space replays history from wherever you are, with quiet stretches squeezed
so a busy week takes a few seconds. Replaying a week is how you see a
conversation's real rhythm: the burst after a crit, the slow tail. `,` and
`.` step through marks one at a time in the order they were posted, and
Shift with either jumps between seals. Seals are where the timeline's
promise ("nothing can be added afterwards") becomes something you can watch:
playback crosses Monday 00:00, the week that ended flashes and locks, and
the next sun ignites. Watching a replay is spectating, so it lights nothing;
stepping onto a mark is arriving, so it does.

## Being in the archive together

A room of a dozen mostly meets at crits. The archive is now somewhere you
can bump into each other between them. Everyone else in the archive right
now is a wisp of light in their own colour, circling the body they're at and
flying along the orbits when they move. **Here now** lists who's around and
where, with Fly to and Follow; P flies to the next person, W waves. When two
or more of you stop at the same mark, a chat opens there.

Chat is deliberately ephemeral. Marks are what you keep; chat is what you
say while standing there. It lives only in the server's memory, keeps at
most the last twenty lines or ten minutes, disappears the moment everyone
leaves the mark, and never becomes a mark. That's why chatting at a mark in
a sealed week doesn't break the seal: nothing is added to the week and
nothing persists. Presence uses a random id that is never your visitor
cookie, and **Hide me** takes you out of everyone else's view entirely
(and out of chat).

New marks now arrive live, everywhere. The moment someone posts or replies,
the new moon is born in every open archive and its thread spirals inward,
and it appears at the top of the home page or mark page wall without a
reload. You can reply from the archive itself, from the selected mark's
preview. The week still rolls over lazily: an archive left open over Monday
00:00 sees the seal on the next request anyone makes, not on a timer.

## What's deliberately not here yet

There is still no way to edit or delete a mark. That was a deliberate choice
at the start, and sealing weeks makes it more important rather than less.
Presence and chat live on one machine's memory, so a deploy clears the
room; that's correct for something meant to be ephemeral, but it means the
app can't grow past one machine without a shared bus. The fog of war only
counts marks, not how long you spent reading them, and that's on purpose.

## What I read to get here

- Robin Sloan, [*An App Can Be a Home-Cooked
  Meal*](https://www.robinsloan.com/notes/home-cooked-app/) and its
  [five-year follow-up](https://www.robinsloan.com/lab/five-years-of-home-cooked-apps/)
- Ink & Switch, [*Malleable
  Software*](https://www.inkandswitch.com/essay/malleable-software/)
- the crit-8 pod's prompt for this riff, which asked for the weekly tree and
  for "time is just further left"
- the crit-9 pod's prompt, which asked for the sky, the fog of war, time
  travel and meeting each other in the archive
