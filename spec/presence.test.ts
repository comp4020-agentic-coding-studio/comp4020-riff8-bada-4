import { beforeEach, expect, it } from "vitest";
import { HISTORY_MS, MAX_LINE, PALETTE, Presence, type Stream } from "../src/presence.ts";

// The live-presence state machine, driven directly with an injected clock and
// fake streams that just collect the events written to them.

interface Fake extends Stream {
  events: Record<string, any>[];
  pings: number;
  of(type: string): Record<string, any>[];
}

function fake(visitorId: string): Fake {
  const s: Fake = {
    visitorId,
    events: [],
    pings: 0,
    write(chunk) {
      if (chunk.startsWith(":")) s.pings++;
      else s.events.push(JSON.parse(chunk.replace(/^data: /, "")));
    },
    of: (type) => s.events.filter((e) => e.type === type),
  };
  return s;
}

let clock: number;
let logs: string[];
let live: Presence;

beforeEach(() => {
  clock = 1_000_000;
  logs = [];
  live = new Presence({ now: () => clock, graceMs: 5000, log: (l) => logs.push(l) });
});

function open(visitorId: string, opts: { name?: string; hidden?: boolean; requested?: string } = {}) {
  const stream = fake(visitorId);
  const res = live.connect(visitorId, opts.name ?? "Someone", opts.hidden ?? false, opts.requested ?? null, stream);
  if (res.status !== 200) throw new Error(`connect ${res.status}`);
  return { stream, id: res.presenceId, visitorId };
}

type Who = ReturnType<typeof open>;
const move = (p: Who, mark: number, tt = false, hidden = false) => live.move(p.visitorId, p.id, mark, tt, "N", hidden);

it("says hello with a random presence id and nobody else yet", () => {
  const a = open("va");
  expect(a.id).toMatch(/^p_[\w-]{12}$/);
  expect(a.id).not.toContain("va");
  expect(a.stream.events).toEqual([{ type: "hello", presenceId: a.id, hidden: false, people: [] }]);
});

it("a stream isn't a person until it moves, then joins and moves", () => {
  const a = open("va");
  const b = open("vb");
  expect(b.stream.of("hello")[0].people).toEqual([]);
  expect(move(b, 7)).toBe(204);
  expect(a.stream.of("join")).toHaveLength(1);
  expect(a.stream.of("join")[0].person).toMatchObject({ id: b.id, markId: 7, timeTravelling: false });
  expect(b.stream.of("join")).toHaveLength(0); // never to yourself
  expect(move(b, 8, true)).toBe(204);
  expect(a.stream.of("move")[0].person).toMatchObject({ id: b.id, markId: 8, timeTravelling: true });
  // a later stream's hello includes b
  expect(open("vc").stream.of("hello")[0].people.map((p: { id: string }) => p.id)).toEqual([b.id]);
});

it("refuses a presence id the visitor doesn't own", () => {
  const a = open("va");
  const b = open("vb");
  expect(live.owns("vb", a.id)).toBe(false);
  expect(live.move("vb", a.id, 7, false, "B", false)).toBe(403);
  expect(live.say("vb", a.id, 7, "hi")).toBe(403);
  expect(live.wave("vb", a.id)).toBe(403);
  expect(b.stream.events.filter((e) => e.type !== "hello")).toEqual([]);
});

it("broadcasts leave only after the grace period, and a reconnect inside it cancels", () => {
  const a = open("va");
  const b = open("vb");
  move(b, 7);
  live.disconnect(b.stream);
  clock += 4999;
  live.sweep();
  expect(a.stream.of("leave")).toEqual([]);

  // back inside the grace: same id, no leave, no fresh join
  const again = open("vb", { requested: b.id });
  expect(again.id).toBe(b.id);
  clock += 10_000;
  live.sweep();
  expect(a.stream.of("leave")).toEqual([]);
  expect(move(again, 7)).toBe(204);
  expect(a.stream.of("join")).toHaveLength(1);
  expect(a.stream.of("move")).toHaveLength(1);

  live.disconnect(again.stream);
  clock += 5000;
  live.sweep();
  expect(a.stream.of("leave")).toEqual([{ type: "leave", id: b.id }]);
  expect(live.people()).toEqual([]);
  expect(logs).toContain(`live leave ${b.id}`);
});

it("reuses a visitor's only idle presence even without asking, but not someone else's", () => {
  const b = open("vb");
  live.disconnect(b.stream);
  expect(open("vb").id).toBe(b.id);
  const c = open("vc");
  live.disconnect(c.stream);
  expect(open("vx", { requested: c.id }).id).not.toBe(c.id);
});

it("never broadcasts a stream that didn't join, when it leaves", () => {
  const a = open("va");
  const b = open("vb");
  live.disconnect(b.stream);
  clock += 6000;
  live.sweep();
  expect(a.stream.events.map((e) => e.type)).toEqual(["hello"]);
});

it("caps streams in total and per visitor", () => {
  const small = new Presence({ now: () => clock, maxStreams: 3, maxPerVisitor: 2 });
  expect(small.connect("v", "N", false, null, fake("v")).status).toBe(200);
  expect(small.connect("v", "N", false, null, fake("v")).status).toBe(200);
  expect(small.connect("v", "N", false, null, fake("v")).status).toBe(429);
  expect(small.connect("w", "N", false, null, fake("w")).status).toBe(200);
  expect(small.connect("x", "N", false, null, fake("x")).status).toBe(503);
});

it("a hidden visitor is never broadcast but still hears everything", () => {
  const a = open("va");
  const h = open("vh", { hidden: true });
  expect(h.stream.of("hello")[0].hidden).toBe(true);
  expect(move(h, 7, false, true)).toBe(204);
  expect(live.wave(h.visitorId, h.id)).toBe(403);
  expect(live.say(h.visitorId, h.id, 7, "hi")).toBe(403);
  expect(a.stream.events.map((e) => e.type)).toEqual(["hello"]);
  move(a, 7);
  expect(h.stream.of("join")).toHaveLength(1);
});

it("hiding sends a leave, and coming back waits for the next move", () => {
  const a = open("va");
  const b = open("vb");
  move(b, 7);
  live.hide("vb", true);
  expect(a.stream.of("leave")).toEqual([{ type: "leave", id: b.id }]);
  live.hide("vb", false);
  expect(a.stream.of("join")).toHaveLength(1);
  move(b, 7);
  expect(a.stream.of("join")).toHaveLength(2);
});

it("say reaches only the people at that mark, speaker included", () => {
  const a = open("va", { name: "Ana" });
  const b = open("vb");
  const c = open("vc");
  live.move("va", a.id, 7, false, "Ana", false);
  move(b, 7);
  move(c, 8);
  expect(live.say("va", a.id, 7, "  hello there  ")).toBe(204);
  const [line] = b.stream.of("say");
  expect(line).toMatchObject({ markId: 7, line: { id: a.id, name: "Ana", text: "hello there" } });
  expect(line.line.colourName).toBeTruthy();
  expect(a.stream.of("say")).toHaveLength(1);
  expect(c.stream.of("say")).toEqual([]);
  expect(logs.find((l) => l.startsWith("live say"))).toBe(`live say ${a.id} mark=7`);
  expect(logs.join("\n")).not.toContain("hello there");
});

it("rejects saying alone, elsewhere, blank, and cuts long lines", () => {
  const a = open("va");
  const b = open("vb");
  move(a, 7);
  expect(live.say("va", a.id, 7, "anyone?")).toBe(409);
  move(b, 7);
  expect(live.say("va", a.id, 8, "wrong room")).toBe(409);
  expect(live.say("va", a.id, 7, "   ")).toBe(400);
  expect(live.say("va", a.id, 7, "\u200b\u200b")).toBe(400);
  expect(live.say("va", a.id, 7, "x".repeat(500))).toBe(204);
  expect(b.stream.of("say")[0].line.text).toHaveLength(MAX_LINE);
});

it("rate-limits chat to a small burst, then about one a second", () => {
  const a = open("va");
  const b = open("vb");
  move(a, 7);
  move(b, 7);
  const statuses = Array.from({ length: 5 }, (_, i) => live.say("va", a.id, 7, `m${i}`));
  expect(statuses).toEqual([204, 204, 204, 429, 429]);
  clock += 1000;
  expect(live.say("va", a.id, 7, "later")).toBe(204);
});

it("rate-limits moves and waves", () => {
  const a = open("va");
  const statuses = Array.from({ length: 20 }, () => move(a, 7));
  expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  clock += 2000;
  expect(move(a, 7)).toBe(204);
  expect(live.wave("va", a.id)).toBe(204);
  expect(live.wave("va", a.id)).toBe(429);
  clock += 3000;
  expect(live.wave("va", a.id)).toBe(204);
});

it("waves go to everyone else, and only once you're at a mark", () => {
  const a = open("va");
  const b = open("vb");
  expect(live.wave("vb", b.id)).toBe(409);
  move(b, 7);
  expect(live.wave("vb", b.id)).toBe(204);
  expect(a.stream.of("wave")).toEqual([{ type: "wave", id: b.id, markId: 7 }]);
  expect(b.stream.of("wave")).toEqual([]);
});

it("keeps a room's history while anyone's there, sends it to newcomers, drops it when empty", () => {
  const a = open("va");
  const b = open("vb");
  move(a, 7);
  move(b, 7);
  live.say("va", a.id, 7, "first");
  // b steps away and back: a is still there, so the history is too
  move(b, 8);
  expect(live.roomLines(7)).toHaveLength(1);
  move(b, 7);
  expect(b.stream.of("room")).toEqual([{ type: "room", markId: 7, lines: [expect.objectContaining({ text: "first" })] }]);

  // both leave: the room empties and its lines go
  move(a, 9);
  move(b, 9);
  expect(live.roomLines(7)).toEqual([]);
  const c = open("vc");
  move(c, 7);
  move(a, 7);
  expect(a.stream.of("room")).toEqual([]);
  expect(c.stream.of("room")).toEqual([]);
});

it("forgetting the last person at a mark drops its history too", () => {
  const a = open("va");
  const b = open("vb");
  move(a, 7);
  move(b, 7);
  live.say("va", a.id, 7, "hi");
  move(b, 8);
  live.disconnect(a.stream);
  clock += 5000;
  live.sweep();
  expect(live.roomLines(7)).toEqual([]);
});

it("trims history to 20 lines and 10 minutes", () => {
  const a = open("va");
  const b = open("vb");
  move(a, 7);
  move(b, 7);
  for (let i = 0; i < 25; i++) {
    clock += 1000;
    live.say("va", a.id, 7, `line ${i}`);
  }
  const lines = live.roomLines(7);
  expect(lines).toHaveLength(20);
  expect(lines[0].text).toBe("line 5");
  clock += HISTORY_MS - 5000;
  const c = open("vc");
  move(c, 7);
  const sent = c.stream.of("room")[0].lines as { text: string }[];
  expect(sent.length).toBeLessThan(20);
  expect(sent.at(-1)?.text).toBe("line 24");
});

it("gives people distinct colours from the palette, least-used first", () => {
  const people = PALETTE.map((_, i) => open(`v${i}`));
  people.forEach((p) => move(p, 1));
  const colours = live.people().map((p) => p.colour);
  expect(new Set(colours).size).toBe(PALETTE.length);
  for (const p of live.people()) expect(PALETTE.find((c) => c.colour === p.colour)?.name).toBe(p.colourName);
});

it("sends per-stream events and pings to every stream, joined or not", () => {
  const a = open("va");
  const h = open("vh", { hidden: true });
  live.broadcastEach((visitorId) => ({ type: "mark", mine: visitorId === "va" }));
  live.ping();
  expect(a.stream.of("mark")).toEqual([{ type: "mark", mine: true }]);
  expect(h.stream.of("mark")).toEqual([{ type: "mark", mine: false }]);
  expect(a.stream.pings).toBe(1);
  expect(h.stream.pings).toBe(1);
});
