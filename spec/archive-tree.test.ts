import { expect, it } from "vitest";
import {
  buildTree,
  describe,
  edgeMessage,
  move,
  orbitModel,
  completeWeeks,
  frontier,
  pathBetween,
  positionAt,
  totalProgress,
  weekComplete,
  weekProgress,
  withSeen,
  sealTime,
  withMark,
  withWeek,
  existsAt,
  historyAt,
  nearestExisting,
  nodesAt,
  postingOrder,
  replayGap,
  replaySchedule,
  REPLAY_MAX_GAP,
  sealsBetween,
  stepInTime,
} from "../public/archive-tree.js";

// The archive's keyboard rules, on a small hand-built tree (no server, no DOM):
//
//   W3 (current, root 30) ─┬─ W2 (root 20) ─┬─ W1 (root 10) ── 11
//                          ├─ 31 ── 33       ├─ 21 ── 23 ── 24
//                          └─ 32             └─ 22
//
// Week roots sit at Monday 00:00 Sydney (DST starts Sun 4 Oct 2026). 33, a
// reply to 31, is the newest thing in week 3.
const ROOT_TIMES: Record<number, string> = {
  30: "2026-10-04T13:00:00.000Z",
  20: "2026-09-27T14:00:00.000Z",
  10: "2026-09-20T14:00:00.000Z",
};
const MARK_TIMES: Record<number, string> = {
  31: "2026-10-06T01:00:00.000Z",
  32: "2026-10-06T02:00:00.000Z",
  33: "2026-10-07T00:00:00.000Z",
  21: "2026-09-29T01:00:00.000Z",
  22: "2026-09-29T02:00:00.000Z",
  23: "2026-09-30T01:00:00.000Z",
  24: "2026-09-30T02:00:00.000Z",
  11: "2026-09-22T01:00:00.000Z",
};
const mark = (id: number, parentId: number | null, weekId: number, children: number[], isRoot = false) => ({
  id,
  parentId,
  weekId,
  isRoot,
  name: isRoot ? "Marks" : `n${id}`,
  body: isRoot ? `Week ${weekId}` : `body ${id}`,
  createdAt: ROOT_TIMES[id] ?? MARK_TIMES[id],
  childCount: children.filter((c) => c % 10 !== 0).length,
  children,
  mine: false,
  seen: true,
});
const data = {
  currentWeekId: 3,
  weeks: [
    { id: 3, weekStart: "2026-10-05", label: "Week 3", rootMarkId: 30, prevWeekId: 2, archived: false },
    { id: 1, weekStart: "2026-09-21", label: "Week 1", rootMarkId: 10, prevWeekId: null, archived: true },
    { id: 2, weekStart: "2026-09-28", label: "Week 2", rootMarkId: 20, prevWeekId: 1, archived: true },
  ],
  marks: [
    mark(30, null, 3, [20, 31, 32], true),
    mark(31, 30, 3, [33]),
    mark(32, 30, 3, []),
    mark(33, 31, 3, []),
    mark(20, 30, 2, [10, 21, 22], true),
    mark(21, 20, 2, [23]),
    mark(22, 20, 2, []),
    mark(23, 21, 2, [24]),
    mark(24, 23, 2, []),
    mark(10, 20, 1, [11], true),
    mark(11, 10, 1, []),
  ],
};
const tree = buildTree(data);

it("follows the week chain newest first, whatever the array order", () => {
  expect(tree.rootId).toBe(30);
  expect(tree.weekRoots).toEqual([30, 20, 10]);
});

it("↑ goes to the parent, and from a week root to the newer week", () => {
  expect(move(tree, 33, "up")).toBe(31);
  expect(move(tree, 31, "up")).toBe(30);
  expect(move(tree, 20, "up")).toBe(30);
  expect(move(tree, 10, "up")).toBe(20);
  expect(move(tree, 30, "up")).toBeNull();
});

it("↓ goes to the first real mark, never the previous-week edge", () => {
  expect(move(tree, 30, "down")).toBe(31);
  expect(move(tree, 20, "down")).toBe(21);
  expect(move(tree, 10, "down")).toBe(11);
  expect(move(tree, 32, "down")).toBeNull();
});

it("← past a week's first mark steps into last week", () => {
  expect(move(tree, 32, "left")).toBe(31);
  expect(move(tree, 31, "left")).toBe(20);
  expect(move(tree, 20, "left")).toBeNull();
  expect(move(tree, 20, "right")).toBe(31);
  expect(move(tree, 32, "right")).toBeNull();
  expect(move(tree, 33, "left")).toBeNull();
  expect(move(tree, 30, "left")).toBeNull();
});

it("[ and ] jump between week roots", () => {
  expect(move(tree, 30, "older")).toBe(20);
  expect(move(tree, 23, "older")).toBe(10);
  expect(move(tree, 10, "older")).toBeNull();
  expect(move(tree, 10, "newer")).toBe(20);
  expect(move(tree, 24, "newer")).toBe(20);
  expect(move(tree, 30, "newer")).toBeNull();
  expect(move(tree, 24, "home")).toBe(30);
  expect(move(tree, 30, "home")).toBeNull();
});

it("flies up to the common ancestor and back down", () => {
  expect(pathBetween(tree, 33, 32)).toEqual([33, 31, 30, 32]);
  expect(pathBetween(tree, 24, 11)).toEqual([24, 23, 21, 20, 10, 11]);
  expect(pathBetween(tree, 30, 24)).toEqual([30, 20, 21, 23, 24]);
  expect(pathBetween(tree, 22, 22)).toEqual([22]);
});

it("announces the selection and explains the edges", () => {
  expect(describe(tree, 23)).toBe("Week 2, mark by n23: “body 23”, 1 reply, Enter to open.");
  expect(describe(tree, 30)).toBe("Week 3, this week, 2 marks. Down arrow to read it, Enter to open.");
  expect(edgeMessage(tree, 30, "up")).toMatch(/top/);
  expect(edgeMessage(tree, 20, "left")).toMatch(/\[/);
});

const NOW = Date.parse("2026-10-07T01:00:00.000Z");
const MIN = 60_000;

it("seals a week at the next Monday 00:00 Sydney, across a DST change", () => {
  expect(sealTime(tree, 20)).toBe(Date.parse(ROOT_TIMES[30]));
  expect(sealTime(tree, 10)).toBe(Date.parse(ROOT_TIMES[20]));
});

it("puts the most recently active sibling on the smallest orbit", () => {
  const m = orbitModel(tree, NOW);
  // 31's thread was last active at 33 (yesterday); 32 a day before that
  expect(m.bodies.get(31)!.r).toBeLessThan(m.bodies.get(32)!.r);
  // and the order quietest first, behind last week's root
  expect(m.order.get(30)).toEqual([20, 32, 31]);
});

it("spreads a minute, an hour, a day and a week ago over visibly different orbits", () => {
  const now = Date.parse("2026-10-11T01:00:00.000Z");
  const lone = (ago: number) => {
    const t = buildTree({
      currentWeekId: 3,
      weeks: [data.weeks[0]],
      marks: [
        { ...mark(30, null, 3, [99], true), childCount: 1 },
        { ...mark(99, 30, 3, []), createdAt: new Date(now - ago).toISOString() },
      ],
    });
    return orbitModel(t, now).bodies.get(99)!.r;
  };
  const [minute, hour, day, week] = [MIN, 60 * MIN, 1440 * MIN, 6 * 1440 * MIN].map(lone);
  expect(hour - minute).toBeGreaterThan(1);
  expect(day - hour).toBeGreaterThan(1);
  expect(week - day).toBeGreaterThan(0.75);
});

it("moves a whole thread to the innermost orbit when it gets a new reply", () => {
  const at = new Date(NOW - 2 * MIN).toISOString();
  const t = withMark(tree, { ...tree.nodes.get(33)!, id: 34, parentId: 32, children: [], childCount: 0, createdAt: at });
  expect(t.nodes.get(32)!.children).toEqual([34]);
  expect(tree.nodes.get(32)!.children).toEqual([]); // the old tree is untouched
  const m = orbitModel(t, NOW);
  expect(m.bodies.get(32)!.r).toBeLessThan(m.bodies.get(31)!.r);
  expect(m.order.get(30)).toEqual([20, 31, 32]);
});

it("never lets neighbouring systems overlap", () => {
  const m = orbitModel(tree, NOW);
  for (const [parent, kids] of m.order) {
    const bodies = kids.map((k) => m.bodies.get(k)!).filter((b) => b.anchor === null);
    bodies.sort((a, b) => a.r - b.r);
    if (bodies.length) expect(bodies[0].r).toBeGreaterThanOrEqual(m.bodies.get(parent)!.size + bodies[0].extent);
    for (let i = 1; i < bodies.length; i++) {
      expect(bodies[i].r - bodies[i - 1].r).toBeGreaterThanOrEqual(bodies[i].extent + bodies[i - 1].extent);
    }
  }
  // and whole week systems along the arm keep clear of each other
  const roots = m.weeks.map((id) => m.bodies.get(id)!);
  for (let i = 1; i < roots.length; i++) {
    const [a, b] = [roots[i - 1].anchor!, roots[i].anchor!];
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(roots[i - 1].extent + roots[i].extent);
  }
});

it("freezes a sealed week's system at its seal", () => {
  const a = orbitModel(tree, NOW);
  const b = orbitModel(tree, NOW + 3 * 1440 * MIN);
  for (const id of [20, 21, 22, 23, 24, 10, 11]) {
    expect(b.bodies.get(id)!.r).toBe(a.bodies.get(id)!.r);
    expect(b.bodies.get(id)!.period).toBe(a.bodies.get(id)!.period);
  }
  // while this week's conversations drift outward as they cool
  expect(b.bodies.get(31)!.r).toBeGreaterThan(a.bodies.get(31)!.r);
});

it("gives everyone the same sky at the same moment", () => {
  const t = NOW + 12_345;
  const other = orbitModel(buildTree(JSON.parse(JSON.stringify(data))), NOW);
  const m = orbitModel(tree, NOW);
  for (const id of [31, 32, 33, 23, 24]) {
    expect(positionAt(m, id, t)).toEqual(positionAt(m, id, t));
    expect(positionAt(other, id, t)).toEqual(positionAt(m, id, t));
  }
  // and planets really do move
  expect(positionAt(m, 31, t + 5000)).not.toEqual(positionAt(m, 31, t));
});

it("only holds what existed at a moment", () => {
  const m = orbitModel(tree, Date.parse("2026-10-06T01:30:00.000Z"));
  expect(m.bodies.has(31)).toBe(true);
  expect(m.bodies.has(32)).toBe(false);
  expect(m.bodies.has(33)).toBe(false);
  expect(orbitModel(tree, Date.parse(ROOT_TIMES[30]) - 1).weeks).toEqual([20, 10]);
  // a week root exists from exactly its own start, which is the previous seal
  expect(orbitModel(tree, Date.parse(ROOT_TIMES[30])).weeks).toEqual([30, 20, 10]);
});

it("walks siblings in orbit order: ← outward to quieter, → inward to livelier", () => {
  const order = orbitModel(tree, NOW).order;
  expect(move(tree, 31, "left", order)).toBe(32);
  expect(move(tree, 32, "left", order)).toBe(20);
  expect(move(tree, 32, "right", order)).toBe(31);
  expect(move(tree, 31, "right", order)).toBeNull();
  expect(move(tree, 20, "right", order)).toBe(32);
  // ↓ is the outermost moon, never last week's star
  expect(move(tree, 30, "down", order)).toBe(32);
  expect(move(tree, 31, "down", order)).toBe(33);
});

// Fog of war: the same tree, with week 2 mostly unexplored.
const foggy = buildTree({
  ...data,
  marks: data.marks.map((m) => ({ ...m, seen: m.isRoot || [21, 33].includes(m.id), mine: m.id === 22 })),
});

it("counts lit marks per week and all time, roots excluded", () => {
  // week 2: 21 seen, 22 mine, 23 and 24 dark
  expect(weekProgress(foggy, 2)).toEqual({ lit: 2, total: 4 });
  expect(weekProgress(foggy, 3)).toEqual({ lit: 1, total: 3 });
  expect(totalProgress(foggy)).toEqual({ lit: 3, total: 8 });
});

it("finds the frontier: unlit marks whose parent is lit", () => {
  // 23 hangs off 21 (seen); 24 hangs off 23 (dark); 31/32 off this week's root
  expect([...frontier(foggy)].sort()).toEqual([11, 23, 31, 32]);
});

it("lights a mark as a new tree, and completes a week when the last one lights", () => {
  expect(weekComplete(foggy, 2)).toBe(false);
  let t = withSeen(foggy, 23);
  expect(foggy.nodes.get(23)!.seen).toBe(false);
  expect(t.nodes.get(23)!.seen).toBe(true);
  expect(frontier(t).has(24)).toBe(true);
  expect(weekComplete(t, 2)).toBe(false);
  t = withSeen(t, 24);
  expect(weekComplete(t, 2)).toBe(true);
  expect(completeWeeks(t)).toEqual(new Set([20]));
  expect(withSeen(t, 24)).toBe(t); // already lit: unchanged
});

it("never calls an empty week complete", () => {
  const empty = buildTree({
    currentWeekId: 3,
    weeks: [data.weeks[0]],
    marks: [{ ...mark(30, null, 3, [], true), childCount: 0 }],
  });
  expect(weekComplete(empty, 3)).toBe(false);
});

it("announces an unexplored mark without its text", () => {
  expect(describe(foggy, 23)).toBe("Week 2, unexplored mark by n23, 1 reply. Select it to read it.");
});

it("rolls over to a new week: a new root on top, last week sealed beneath it", () => {
  const t = withWeek(
    tree,
    { id: 4, weekStart: "2026-10-12", label: "Week 4", rootMarkId: 40, prevWeekId: 3, archived: false },
    { ...mark(40, null, 4, [30], true), createdAt: "2026-10-11T13:00:00.000Z" },
  );
  expect(t.rootId).toBe(40);
  expect(t.weekRoots).toEqual([40, 30, 20, 10]);
  expect(t.nodes.get(30)!.parentId).toBe(40);
  expect(t.nodes.get(31)!.archived).toBe(true);
  expect(move(t, 40, "down")).toBeNull(); // nobody's posted in the new week yet
  expect(move(t, 30, "up")).toBe(40);
  expect(orbitModel(t, Date.parse("2026-10-12T00:00:00.000Z")).weeks).toEqual([40, 30, 20, 10]);
});

// Time travel.
const T = (iso: string) => Date.parse(iso);

it("lists marks in posting order across the whole tree, ties broken by id", () => {
  expect(postingOrder(tree)).toEqual([11, 21, 22, 23, 24, 31, 32, 33]);
  const tied = withMark(tree, { ...tree.nodes.get(32)!, id: 35, parentId: 30, children: [], childCount: 0, createdAt: MARK_TIMES[32] });
  expect(postingOrder(tied).slice(-3)).toEqual([32, 35, 33]);
});

it("knows what existed at a moment, including week roots that didn't yet", () => {
  const at = T("2026-09-29T01:30:00.000Z");
  expect([...nodesAt(tree, at)].sort((a, b) => a - b)).toEqual([10, 11, 20, 21]);
  expect(existsAt(tree, 30, at)).toBe(false);
  // before the first week, nothing at all
  expect(nodesAt(tree, T("2026-09-01T00:00:00.000Z")).size).toBe(0);
  // a week root exists from exactly its own start, which is the last seal
  expect(existsAt(tree, 30, T(ROOT_TIMES[30]))).toBe(true);
  expect(existsAt(tree, 30, T(ROOT_TIMES[30]) - 1)).toBe(false);
});

it("steps to the next and previous mark in time", () => {
  expect(stepInTime(tree, T("2026-09-29T01:30:00.000Z"), 1)).toBe(22);
  expect(stepInTime(tree, T("2026-09-29T01:30:00.000Z"), -1)).toBe(21);
  expect(stepInTime(tree, T(MARK_TIMES[22]), 1, 22)).toBe(23);
  expect(stepInTime(tree, T(MARK_TIMES[22]), -1, 22)).toBe(21);
  expect(stepInTime(tree, T("2026-09-01T00:00:00.000Z"), -1)).toBeNull();
  expect(stepInTime(tree, T("2026-09-01T00:00:00.000Z"), 1)).toBe(11);
  expect(stepInTime(tree, T(MARK_TIMES[33]), 1, 33)).toBeNull();
  // two marks at the same moment still step one at a time
  const tied = withMark(tree, { ...tree.nodes.get(32)!, id: 35, parentId: 30, children: [], childCount: 0, createdAt: MARK_TIMES[32] });
  expect(stepInTime(tied, T(MARK_TIMES[32]), 1, 32)).toBe(35);
  expect(stepInTime(tied, T(MARK_TIMES[32]), -1, 35)).toBe(32);
});

it("finds the seals between two moments", () => {
  expect(sealsBetween(tree, T("2026-09-25T00:00:00.000Z"), T("2026-10-07T00:00:00.000Z"))).toEqual([
    T(ROOT_TIMES[20]),
    T(ROOT_TIMES[30]),
  ]);
  // a seal at exactly the end counts; at exactly the start doesn't
  expect(sealsBetween(tree, T(ROOT_TIMES[20]), T(ROOT_TIMES[30]))).toEqual([T(ROOT_TIMES[30])]);
});

it("falls back to the nearest ancestor that existed", () => {
  const at = T("2026-09-30T01:30:00.000Z"); // 23 exists, 24 doesn't yet
  expect(nearestExisting(tree, 24, at)).toBe(23);
  expect(nearestExisting(tree, 23, at)).toBe(23);
  // this week's marks before this week began: the newest week that existed
  expect(nearestExisting(tree, 33, at)).toBe(20);
  expect(nearestExisting(tree, 30, at)).toBe(20);
  // before anything, the oldest week
  expect(nearestExisting(tree, 24, T("2026-09-01T00:00:00.000Z"))).toBe(10);
});

it("compresses quiet stretches in the replay clock", () => {
  expect(replayGap(3 * 86_400_000)).toBe(REPLAY_MAX_GAP);
  expect(replayGap(10 * 60_000)).toBeLessThan(REPLAY_MAX_GAP);
  expect(replayGap(20 * 60_000)).toBeCloseTo(replayGap(10 * 60_000) * 2);
  const from = T(ROOT_TIMES[30]);
  const to = T("2026-10-11T12:00:00.000Z");
  const s = replaySchedule(tree, from, to);
  const total = s.at(-1)!.play;
  expect(total).toBeLessThan(10);
  expect(historyAt(s, 0)).toBe(from);
  expect(historyAt(s, total)).toBe(to);
  expect(historyAt(s, total + 5)).toBe(to);
  // every mark gets its own moment in the replay
  for (const id of [31, 32, 33]) expect(s.some((k) => k.history === T(MARK_TIMES[id]))).toBe(true);
});
