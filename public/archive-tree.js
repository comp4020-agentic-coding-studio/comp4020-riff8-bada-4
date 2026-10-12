// The archive's tree model, independent of three.js and the DOM: navigation
// rules, flight paths, the orbit model and announcements. Pure functions over
// the /archive.json payload, so spec/archive-tree.test.ts can check them.
//
// The tree: the current week's root is the top. A week root's children are
// the previous week's root (leftmost) and then that week's marks; a mark's
// children are its replies. The sky draws it as star systems: a week root is
// a star, its marks are planets and replies are moons. Siblings come in orbit
// order, quietest (outermost) first, so "left" is "further out", and stepping
// left past a week's outermost planet lands in last week.

/**
 * @typedef {{ id: number, parentId: number | null, weekId: number, isRoot: boolean,
 *   name: string, body: string, createdAt: string, childCount: number,
 *   children: number[], mine: boolean, seen?: boolean }} ArchiveMark
 * @typedef {{ id: number, weekStart: string, label: string, rootMarkId: number,
 *   prevWeekId: number | null, archived: boolean }} ArchiveWeek
 * @typedef {{ currentWeekId: number, weeks: ArchiveWeek[], marks: ArchiveMark[] }} ArchiveData
 * @typedef {ArchiveMark & { weekIndex: number, depth: number, label: string, archived: boolean, t: number }} TreeNode
 * @typedef {{ nodes: Map<number, TreeNode>, rootId: number, weekRoots: number[] }} Tree
 * @typedef {"up" | "down" | "left" | "right" | "older" | "newer" | "home"} Move
 */

/** @param {ArchiveData} data @returns {Tree} */
export function buildTree(data) {
  const weeks = new Map(data.weeks.map((w) => [w.id, w]));
  const current = weeks.get(data.currentWeekId);
  if (!current) throw new Error("archive has no current week");
  // Newest first, following the chain rather than trusting array order.
  const weekRoots = [];
  for (let w = current; w; w = w.prevWeekId === null ? undefined : weeks.get(w.prevWeekId)) {
    weekRoots.push(w.rootMarkId);
  }
  const weekIndex = new Map(data.weeks.map((w) => [w.id, weekRoots.indexOf(w.rootMarkId)]));
  /** @type {Map<number, TreeNode>} */
  const nodes = new Map();
  for (const m of data.marks) {
    const week = weeks.get(m.weekId);
    nodes.set(m.id, {
      ...m,
      weekIndex: weekIndex.get(m.weekId) ?? 0,
      depth: 0,
      label: week?.label ?? "",
      archived: week?.archived ?? true,
      t: Date.parse(m.createdAt),
    });
  }
  // Depth within the week: 0 for a root, 1 for a top-level mark, and so on.
  for (const node of nodes.values()) {
    let depth = 0;
    let n = node;
    while (!n.isRoot && n.parentId !== null) {
      const parent = nodes.get(n.parentId);
      if (!parent) break;
      depth++;
      n = parent;
    }
    node.depth = depth;
  }
  return { nodes, rootId: current.rootMarkId, weekRoots };
}

/** @param {Tree} tree @param {number} id */
function realChildren(tree, id) {
  return (tree.nodes.get(id)?.children ?? []).filter((c) => !tree.nodes.get(c)?.isRoot);
}

/**
 * Where a key takes you from `id`, or null at an edge. `order` is the orbit
 * order from orbitModel (quietest first); without it, posting order.
 * @param {Tree} tree @param {number} id @param {Move} move
 * @param {Map<number, number[]>} [order] @returns {number | null}
 */
export function move(tree, id, move, order) {
  const node = tree.nodes.get(id);
  if (!node) return tree.rootId;
  const kids = (/** @type {number} */ p) => order?.get(p) ?? tree.nodes.get(p)?.children ?? [];
  switch (move) {
    case "up":
      return node.parentId;
    case "down":
      return kids(id).find((c) => !tree.nodes.get(c)?.isRoot) ?? null;
    case "left":
    case "right": {
      if (node.parentId === null) return null;
      const siblings = kids(node.parentId);
      const at = siblings.indexOf(id) + (move === "left" ? -1 : 1);
      return siblings[at] ?? null;
    }
    case "older":
      return tree.weekRoots[node.weekIndex + 1] ?? null;
    case "newer": {
      // From a mark, "newer" first lands on its own week's root.
      if (!node.isRoot) return tree.weekRoots[node.weekIndex];
      return tree.weekRoots[node.weekIndex - 1] ?? null;
    }
    case "home":
      return id === tree.rootId ? null : tree.rootId;
  }
  return null;
}

/** @param {Tree} tree @param {number} id @returns {number[]} id, its parent, ..., the top */
function lineage(tree, id) {
  const out = [];
  for (let n = tree.nodes.get(id); n; n = n.parentId === null ? undefined : tree.nodes.get(n.parentId)) {
    out.push(n.id);
  }
  return out;
}

/**
 * The walk from a to b along real edges: up to their common ancestor, then
 * down. Both ends included.
 * @param {Tree} tree @param {number} a @param {number} b @returns {number[]}
 */
export function pathBetween(tree, a, b) {
  const up = lineage(tree, a);
  const down = lineage(tree, b);
  const inUp = new Set(up);
  const meet = down.findIndex((id) => inUp.has(id));
  if (meet === -1) return [a, b];
  return [...up.slice(0, up.indexOf(down[meet]) + 1), ...down.slice(0, meet).reverse()];
}

/** @param {string} s @param {number} max */
export function snippet(s, max) {
  const line = s.split(/\r?\n/)[0];
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** @param {number} n */
export function replies(n) {
  return n === 1 ? "1 reply" : `${n} replies`;
}

/** The first real mark of a root's week, for its bubble. @param {Tree} tree @param {number} id */
export function firstMark(tree, id) {
  const first = realChildren(tree, id)[0];
  return first === undefined ? undefined : tree.nodes.get(first);
}

/**
 * What the live region says when a node is selected. With the orbit order,
 * a mark also says where it sits among its siblings, livelier inward.
 * @param {Tree} tree @param {number} id @param {Map<number, number[]>} [order] @returns {string}
 */
export function describe(tree, id, order) {
  const n = tree.nodes.get(id);
  if (!n) return "";
  if (!n.isRoot && order && n.parentId !== null) {
    const sibs = (order.get(n.parentId) ?? []).filter((s) => !tree.nodes.get(s)?.isRoot);
    const at = sibs.indexOf(id);
    if (sibs.length > 1 && at !== -1) {
      const where =
        at === sibs.length - 1 ? "the innermost, liveliest orbit" : at === 0 ? "the outermost, quietest orbit" : `orbit ${sibs.length - at} of ${sibs.length} from the centre`;
      return `${describe(tree, id)} On ${where}.`;
    }
  }
  if (n.isRoot) {
    const state = id === tree.rootId ? "this week" : "sealed";
    const count = n.childCount === 1 ? "1 mark" : `${n.childCount} marks`;
    return `${n.label}, ${state}, ${count}. Down arrow to read it, Enter to open.`;
  }
  if (!isLit(n)) return `${n.label}, unexplored mark by ${n.name}, ${replies(n.childCount)}. Select it to read it.`;
  return `${n.label}, mark by ${n.name}: “${snippet(n.body, 90)}”, ${replies(n.childCount)}, Enter to open.`;
}

/** Why a key did nothing. @param {Tree} tree @param {number} id @param {Move} move */
export function edgeMessage(tree, id, move) {
  const n = tree.nodes.get(id);
  switch (move) {
    case "up":
      return "This is the top of the tree: this week.";
    case "down":
      return n?.isRoot ? "Nobody left a mark this week." : "No moons: nobody has replied to this mark.";
    case "left":
    case "right": {
      if (n?.isRoot && id === tree.rootId) return "This is this week's star. Down arrow to its planets, [ for last week.";
      if (n?.isRoot && move === "left") return "Already the outermost orbit. Press [ for the week before this one.";
      if (n?.isRoot) return "Nothing further in. Down arrow to this week's planets.";
      const parent = n?.parentId === null || n?.parentId === undefined ? undefined : tree.nodes.get(n.parentId);
      const body = parent?.isRoot ? "planet" : "moon";
      const around = parent?.isRoot ? "" : ` round ${parent?.name}'s mark. Up arrow goes back to it`;
      return move === "left"
        ? `Already the outermost ${body}${around || ", and this is the oldest week"}.`
        : `Already the innermost ${body}: the liveliest conversation here${around}.`;
    }
    case "older":
      return "This is the oldest week.";
    case "newer":
      return "This is the newest week.";
    case "home":
      return "Already at this week.";
  }
  return "";
}


// ---- the sky: an orbit model -------------------------------------------------
//
// Each week is a star system. A body's orbit radius is set by how recently its
// conversation (the mark plus all its replies) was last active, on a log
// scale, then pushed outward so no two neighbouring systems overlap. Phase
// comes from a hash of the id and the wall clock, so everyone sees the same
// sky at the same moment. Angular speed follows Kepler (period ∝ r^1.5) on a
// body's structural lane, which only changes when a mark is posted, so the
// angle is integrated piecewise across those moments and never jumps.

const MINUTE = 60_000;
const WEEK_MS = 7 * 86_400_000;
export const STAR_SIZE = 1.1;

const offsetFormat = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", timeZoneName: "longOffset" });
/** Sydney's UTC offset in minutes at an instant. @param {number} ms */
function sydneyOffset(ms) {
  const name = offsetFormat.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = name.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/**
 * When a week sealed: 00:00 the following Monday, Sydney time.
 * @param {Tree} tree @param {number} rootId
 */
export function sealTime(tree, rootId) {
  const start = tree.nodes.get(rootId)?.t ?? 0;
  const naive = start + WEEK_MS;
  return naive + (sydneyOffset(start) - sydneyOffset(naive)) * MINUTE;
}

/** A stable 0..1 hash of an id. @param {number} id @param {number} [salt] */
export function hash01(id, salt = 0) {
  let h = (id * 2654435761 + salt * 40503) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 2 ** 32;
}

/** @param {Tree} tree @param {number} id @param {number} at */
function kidsAt(tree, id, at) {
  return realChildren(tree, id).filter((c) => (tree.nodes.get(c)?.t ?? Infinity) <= at);
}

/** Size of a body from its depth and how many replies hang under it. @param {number} depth @param {number} desc */
function bodySize(depth, desc) {
  if (depth === 0) return STAR_SIZE;
  const base = depth === 1 ? 0.27 : 0.1 * 0.68 ** (depth - 2);
  return base * Math.min(depth === 1 ? 2.1 : 1.6, 1 + 0.3 * Math.sqrt(desc));
}

/** Orbit radius from how long ago a conversation was last active (log scale). @param {number} depth @param {number} ago */
function ageRadius(depth, ago) {
  const k = depth === 1 ? 1.25 : 0.16 * 0.55 ** (depth - 2);
  return k * Math.log10(1 + Math.max(0, ago) / MINUTE);
}
const GAP = (/** @type {number} */ depth) => (depth === 1 ? 0.45 : 0.2 * 0.55 ** (depth - 2));

/**
 * One week system laid out at a moment: every body's radius, size, extent
 * (how far its own moons reach) and its children in orbit order.
 * @param {Tree} tree @param {number} rootId @param {number} at @param {boolean} useAge @param {number} [depth0]
 */
function systemAt(tree, rootId, at, useAge, depth0 = 0) {
  /** @type {Map<number, { active: number, desc: number, size: number, extent: number, r: number, depth: number }>} */
  const out = new Map();
  /** @type {Map<number, number[]>} quietest first */
  const order = new Map();
  /** @param {number} id @param {number} depth */
  const place = (id, depth) => {
    const node = /** @type {TreeNode} */ (tree.nodes.get(id));
    const kids = kidsAt(tree, id, at);
    let active = node.isRoot ? -Infinity : node.t;
    let desc = 0;
    for (const k of kids) {
      const b = place(k, depth + 1);
      active = Math.max(active, b.active);
      desc += 1 + b.desc;
    }
    const size = bodySize(depth, desc);
    // liveliest first for the spacing pass; ties go to the older id being quieter
    const ranked = kids
      .map((k) => /** @type {[number, NonNullable<ReturnType<typeof out.get>>]} */ ([k, out.get(k)]))
      .sort((a, b) => b[1].active - a[1].active || b[0] - a[0]);
    let prevR = size;
    let prevExt = 0;
    const gap = GAP(depth + 1);
    for (const [, b] of ranked) {
      const min = prevR + prevExt + b.extent + gap;
      // planets keep clear of their star's corona; moons of their planet
      const inner = size * (depth === 0 ? 1.0 : 0.5);
      b.r = Math.max(min + (prevExt === 0 ? inner : 0), useAge ? size + inner + gap + b.extent + ageRadius(depth + 1, at - b.active) : 0);
      prevR = b.r;
      prevExt = b.extent;
    }
    order.set(id, ranked.map(([k]) => k).reverse());
    const entry = { active, desc, size, extent: ranked.length ? prevR + prevExt : size, r: 0, depth };
    out.set(id, entry);
    return entry;
  };
  place(rootId, depth0);
  return { bodies: out, order };
}

/** Seconds for one turn on a structural lane, Kepler-ish. @param {number} depth @param {number} lane */
function periodFor(depth, lane) {
  const p = 22 * lane ** 1.5 * (depth === 1 ? 1 : 1.6);
  return Math.min(900, Math.max(depth === 1 ? 45 : 20, p));
}

/** @type {WeakMap<Tree, Map<number, { from: number, period: number, angle: number }[]>>} */
const pieceCache = new WeakMap();

/**
 * Every body's angular speed over its life: a new piece wherever a mark posted
 * in its parent's subtree could have changed its lane. Depends only on the
 * tree, so it's built once per tree.
 * @param {Tree} tree
 */
function orbitPieces(tree) {
  const cached = pieceCache.get(tree);
  if (cached) return cached;
  /** @type {Map<number, { from: number, period: number, angle: number }[]>} */
  const pieces = new Map();
  for (const rootId of tree.weekRoots) {
    const seal = sealTime(tree, rootId);
    /** @param {number} id @returns {number[]} creation times in this subtree */
    const times = (id) => realChildren(tree, id).flatMap((k) => [tree.nodes.get(k)?.t ?? 0, ...times(k)]);
    /** @param {number} id @param {number} depth */
    const walk = (id, depth) => {
      const events = [...new Set(times(id))].filter((t) => t <= seal).sort((a, b) => a - b);
      for (const at of events) {
        const lanes = systemAt(tree, id, at, false, depth).bodies;
        for (const k of kidsAt(tree, id, at)) {
          const b = lanes.get(k);
          if (!b) continue;
          const list = pieces.get(k) ?? [];
          const period = periodFor(depth + 1, b.r);
          if (list.at(-1)?.period !== period) list.push({ from: Math.max(at, tree.nodes.get(k)?.t ?? at), period, angle: 0 });
          pieces.set(k, list);
        }
      }
      for (const k of realChildren(tree, id)) walk(k, depth + 1);
    };
    walk(rootId, 0);
  }
  // Cumulative angle at the start of each piece, from a hashed phase at birth.
  for (const [id, list] of pieces) {
    let angle = hash01(id) * Math.PI * 2;
    for (let i = 0; i < list.length; i++) {
      list[i].angle = angle;
      const next = list[i + 1];
      if (next) angle += ((next.from - list[i].from) / 1000 / list[i].period) * Math.PI * 2;
    }
  }
  pieceCache.set(tree, pieces);
  return pieces;
}

/**
 * @typedef {{ id: number, parentId: number | null, depth: number, r: number, size: number,
 *   extent: number, scale: number, period: number, tiltX: number, tiltZ: number,
 *   active: number, weekRoot: number, anchor: { x: number, y: number, z: number } | null }} Body
 * @typedef {{ now: number, bodies: Map<number, Body>, order: Map<number, number[]>,
 *   weeks: number[], pieces: Map<number, { from: number, period: number, angle: number }[]> }} OrbitModel
 */

/**
 * The sky at `now`: only what existed then, each week frozen at its seal.
 * The newest existing week is the sun at the centre; older ones recede along
 * a spiral arm, each a little smaller.
 * @param {Tree} tree @param {number} now @returns {OrbitModel}
 */
export function orbitModel(tree, now) {
  const weeks = tree.weekRoots.filter((id) => (tree.nodes.get(id)?.t ?? Infinity) <= now);
  /** @type {Map<number, Body>} */
  const bodies = new Map();
  /** @type {Map<number, number[]>} */
  const order = new Map();
  const pieces = orbitPieces(tree);
  let dist = 0;
  let prevExt = 0;
  weeks.forEach((rootId, k) => {
    const at = Math.min(now, sealTime(tree, rootId));
    const sys = systemAt(tree, rootId, at, true);
    const scale = Math.max(0.4, 0.8 ** k);
    const ext = (sys.bodies.get(rootId)?.extent ?? STAR_SIZE) * scale;
    let anchor = { x: 0, y: 0, z: 0 };
    if (k > 0) {
      dist += prevExt + ext + 4;
      const theta = Math.PI - 0.55 + 0.42 * (k - 1);
      anchor = { x: dist * Math.sin(theta), y: -1.6 * k, z: dist * Math.cos(theta) };
    }
    prevExt = ext;
    for (const [id, b] of sys.bodies) {
      const node = /** @type {TreeNode} */ (tree.nodes.get(id));
      const list = pieces.get(id) ?? [];
      let period = list[0]?.period ?? 60;
      for (const p of list) if (p.from <= now) period = p.period;
      bodies.set(id, {
        id,
        parentId: node.isRoot ? null : node.parentId,
        depth: b.depth,
        r: b.r * scale,
        size: b.size * scale,
        extent: b.extent * scale,
        scale,
        period,
        tiltX: (hash01(id, 1) - 0.5) * 0.2,
        tiltZ: (hash01(id, 2) - 0.5) * 0.2,
        active: b.active,
        weekRoot: rootId,
        anchor: node.isRoot ? anchor : null,
      });
    }
    for (const [id, kids] of sys.order) order.set(id, kids);
  });
  // A week root's leftmost child is still the previous week's root.
  weeks.forEach((rootId, k) => {
    const prev = weeks[k + 1];
    if (prev !== undefined) order.set(rootId, [prev, ...(order.get(rootId) ?? [])]);
  });
  return { now, bodies, order, weeks, pieces };
}

/**
 * A body's orbital angle at wall-clock time `t` (ms).
 * @param {OrbitModel} model @param {number} id @param {number} t
 */
export function angleAt(model, id, t) {
  const list = model.pieces.get(id);
  if (!list || list.length === 0) return hash01(id) * Math.PI * 2;
  let p = list[0];
  for (const q of list) if (q.from <= t) p = q;
  return p.angle + ((t - p.from) / 1000 / p.period) * Math.PI * 2;
}

/**
 * Where a body is at time `t` (ms): its parent's position plus its own tilted
 * orbit. `live` can override radii, anchors and add a swirl, for a scene
 * easing between models.
 * @param {OrbitModel} model @param {number} id @param {number} t
 * @param {{ radius?: (id: number) => number | undefined, anchor?: (id: number) => { x: number, y: number, z: number } | undefined,
 *   swirl?: (id: number) => number, time?: (id: number) => number }} [live]
 * @returns {{ x: number, y: number, z: number } | null}
 */
export function positionAt(model, id, t, live) {
  const b = model.bodies.get(id);
  if (!b) return null;
  if (b.anchor) return live?.anchor?.(id) ?? b.anchor;
  const parent = b.parentId === null ? null : positionAt(model, b.parentId, t, live);
  if (!parent) return null;
  const r = live?.radius?.(id) ?? b.r;
  const a = angleAt(model, id, live?.time?.(id) ?? t) + (live?.swirl?.(id) ?? 0);
  // a circle in the XZ plane, tipped a few degrees about X then Z
  const x0 = r * Math.cos(a);
  const z0 = r * Math.sin(a);
  const y1 = -z0 * Math.sin(b.tiltX);
  const z1 = z0 * Math.cos(b.tiltX);
  const x2 = x0 * Math.cos(b.tiltZ) - y1 * Math.sin(b.tiltZ);
  const y2 = x0 * Math.sin(b.tiltZ) + y1 * Math.cos(b.tiltZ);
  return { x: parent.x + x2, y: parent.y + y2, z: parent.z + z1 };
}

/**
 * The tree with one more mark in it (a live arrival or your own reply), as a
 * new tree; the old one is left as it was.
 * @param {Tree} tree @param {ArchiveMark} mark @param {number} [parentChildCount]
 * @returns {Tree}
 */
export function withMark(tree, mark, parentChildCount) {
  if (tree.nodes.has(mark.id) || mark.parentId === null) return tree;
  const parent = tree.nodes.get(mark.parentId);
  if (!parent) return tree;
  const nodes = new Map(tree.nodes);
  nodes.set(parent.id, {
    ...parent,
    children: [...parent.children, mark.id],
    childCount: parentChildCount ?? parent.childCount + 1,
  });
  nodes.set(mark.id, {
    ...mark,
    children: [...mark.children],
    weekIndex: parent.weekIndex,
    depth: parent.isRoot ? 1 : parent.depth + 1,
    label: parent.label,
    archived: parent.archived,
    t: Date.parse(mark.createdAt),
  });
  return { ...tree, nodes };
}

// ---- fog of war ------------------------------------------------------------------
// A mark is lit for you once you've arrived at it (or opened its page), or if
// you wrote it. Week roots are always lit: they're the landmarks.

/** @param {TreeNode | undefined} n */
export function isLit(n) {
  return Boolean(n && (n.isRoot || n.mine || n.seen));
}

/**
 * How much of a week you've lit.
 * @param {Tree} tree @param {number} weekId @returns {{ lit: number, total: number }}
 */
export function weekProgress(tree, weekId) {
  let lit = 0;
  let total = 0;
  for (const n of tree.nodes.values()) {
    if (n.isRoot || n.weekId !== weekId) continue;
    total++;
    if (isLit(n)) lit++;
  }
  return { lit, total };
}

/** Everything you've lit, all time. @param {Tree} tree */
export function totalProgress(tree) {
  let lit = 0;
  let total = 0;
  for (const n of tree.nodes.values()) {
    if (n.isRoot) continue;
    total++;
    if (isLit(n)) lit++;
  }
  return { lit, total };
}

/** A week with marks in it, every one lit. An empty week isn't complete. @param {Tree} tree @param {number} weekId */
export function weekComplete(tree, weekId) {
  const p = weekProgress(tree, weekId);
  return p.total > 0 && p.lit === p.total;
}

/** Week roots whose week is complete. @param {Tree} tree @returns {Set<number>} */
export function completeWeeks(tree) {
  const out = new Set();
  for (const id of tree.weekRoots) {
    const root = tree.nodes.get(id);
    if (root && weekComplete(tree, root.weekId)) out.add(id);
  }
  return out;
}

/** The frontier: unlit marks whose parent is lit, the hint of where to go next. @param {Tree} tree */
export function frontier(tree) {
  const out = new Set();
  for (const n of tree.nodes.values()) {
    if (isLit(n) || n.parentId === null) continue;
    if (isLit(tree.nodes.get(n.parentId))) out.add(n.id);
  }
  return out;
}

/**
 * The tree with one mark lit, as a new tree (the same tree if it already was).
 * @param {Tree} tree @param {number} id @returns {Tree}
 */
export function withSeen(tree, id) {
  const n = tree.nodes.get(id);
  if (!n || isLit(n)) return tree;
  const nodes = new Map(tree.nodes);
  nodes.set(id, { ...n, seen: true });
  return { ...tree, nodes };
}

/**
 * The tree after a lazy rollover: a new week root at the top, last week's
 * root becoming its leftmost child, and everything older sealed.
 * @param {Tree} tree @param {ArchiveWeek} week @param {ArchiveMark} root @returns {Tree}
 */
export function withWeek(tree, week, root) {
  if (tree.nodes.has(root.id)) return tree;
  /** @type {Map<number, TreeNode>} */
  const nodes = new Map();
  for (const [id, n] of tree.nodes) nodes.set(id, { ...n, weekIndex: n.weekIndex + 1, archived: true });
  const prev = nodes.get(tree.rootId);
  if (prev) nodes.set(prev.id, { ...prev, parentId: root.id });
  nodes.set(root.id, {
    ...root,
    children: prev ? [prev.id] : [],
    weekIndex: 0,
    depth: 0,
    label: week.label,
    archived: false,
    t: Date.parse(root.createdAt),
  });
  return { nodes, rootId: root.id, weekRoots: [root.id, ...tree.weekRoots] };
}

// ---- time travel ------------------------------------------------------------------
// The tree shows who answered whom; these show when. All of it works off
// createdAt (a week root's is its Monday 00:00), with ties broken by id.

/** Every mark in the order it was said, roots excluded. @param {Tree} tree @returns {number[]} */
export function postingOrder(tree) {
  return [...tree.nodes.values()]
    .filter((n) => !n.isRoot)
    .sort((a, b) => a.t - b.t || a.id - b.id)
    .map((n) => n.id);
}

/** Did this node exist at time t? @param {Tree} tree @param {number} id @param {number} t */
export function existsAt(tree, id, t) {
  const n = tree.nodes.get(id);
  return Boolean(n && n.t <= t);
}

/** Every node that existed at time t. @param {Tree} tree @param {number} t @returns {Set<number>} */
export function nodesAt(tree, t) {
  const out = new Set();
  for (const n of tree.nodes.values()) if (n.t <= t) out.add(n.id);
  return out;
}

/**
 * The next (dir 1) or previous (dir -1) mark in time from a moment, or null.
 * With `fromId`, marks posted at exactly `t` are ordered by id around it, so
 * two marks with the same createdAt still step one at a time.
 * @param {Tree} tree @param {number} t @param {1 | -1} dir @param {number} [fromId]
 * @returns {number | null}
 */
export function stepInTime(tree, t, dir, fromId) {
  const order = postingOrder(tree);
  const key = (/** @type {number} */ id) => {
    const n = /** @type {TreeNode} */ (tree.nodes.get(id));
    return [n.t, n.id];
  };
  const after = (/** @type {number} */ id) => {
    const [nt, nid] = key(id);
    if (nt !== t) return nt > t;
    return fromId === undefined ? false : nid > fromId;
  };
  const before = (/** @type {number} */ id) => {
    const [nt, nid] = key(id);
    if (nt !== t) return nt < t;
    return fromId === undefined ? false : nid < fromId;
  };
  if (dir === 1) return order.find(after) ?? null;
  for (let i = order.length - 1; i >= 0; i--) if (before(order[i])) return order[i];
  return null;
}

/**
 * Seal moments (Monday 00:00 Sydney) strictly after `a` and up to `b`,
 * oldest first: the start of every week with a root, and the seal of each.
 * @param {Tree} tree @param {number} a @param {number} b @returns {number[]}
 */
export function sealsBetween(tree, a, b) {
  const out = new Set();
  for (const id of tree.weekRoots) {
    const start = tree.nodes.get(id)?.t;
    if (start !== undefined) out.add(start);
    out.add(sealTime(tree, id));
  }
  return [...out].filter((s) => s > a && s <= b).sort((x, y) => x - y);
}

/**
 * The node itself if it existed at t, else its nearest ancestor that did. A
 * week root's ancestors are newer weeks, so past the top of the week the
 * answer is the newest week that existed then (or the oldest, before any).
 * @param {Tree} tree @param {number} id @param {number} t @returns {number}
 */
export function nearestExisting(tree, id, t) {
  for (let n = tree.nodes.get(id); n; n = n.parentId === null ? undefined : tree.nodes.get(n.parentId)) {
    if (n.isRoot) break;
    if (n.t <= t) return n.id;
  }
  const roots = tree.weekRoots.filter((r) => existsAt(tree, r, t));
  const own = tree.nodes.get(id);
  // the mark's own week root, if that week had started
  for (let n = own; n; n = n.parentId === null ? undefined : tree.nodes.get(n.parentId)) {
    if (n.isRoot) {
      if (n.t <= t) return n.id;
      break;
    }
  }
  return roots[0] ?? tree.weekRoots.at(-1) ?? tree.rootId;
}

// Replay speed: a busy week plays in roughly 8--10 s, and no stretch of
// silence ever takes more than a beat.
export const REPLAY_RATE = 0.2 / 3_600_000; // playback s per history ms: 0.2 s an hour
export const REPLAY_MAX_GAP = 0.45; // s: the longest any quiet stretch takes
export const REPLAY_BEAT = 0.16; // s: the least between two marks, so each visibly sprouts

/** Playback seconds for a gap in history (ms): linear, then capped. @param {number} gap */
export function replayGap(gap) {
  if (gap <= 0) return 0;
  return Math.max(REPLAY_BEAT, Math.min(gap * REPLAY_RATE, REPLAY_MAX_GAP));
}

/**
 * The replay clock: keyframes from `from` to `to` at every posting moment
 * and seal, each gap compressed by replayGap. historyAt() reads it.
 * @param {Tree} tree @param {number} from @param {number} to
 * @returns {{ history: number, play: number }[]}
 */
export function replaySchedule(tree, from, to) {
  const moments = new Set([from, to, ...sealsBetween(tree, from, to)]);
  for (const n of tree.nodes.values()) if (!n.isRoot && n.t > from && n.t < to) moments.add(n.t);
  const sorted = [...moments].sort((a, b) => a - b);
  const out = [];
  let play = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) play += replayGap(sorted[i] - sorted[i - 1]);
    out.push({ history: sorted[i], play });
  }
  return out;
}

/** History time at `play` seconds into a schedule. @param {{ history: number, play: number }[]} schedule @param {number} play */
export function historyAt(schedule, play) {
  if (schedule.length === 0) return 0;
  if (play <= 0) return schedule[0].history;
  for (let i = 1; i < schedule.length; i++) {
    const a = schedule[i - 1];
    const b = schedule[i];
    if (play <= b.play) {
      const span = b.play - a.play;
      return span <= 0 ? b.history : a.history + ((play - a.play) / span) * (b.history - a.history);
    }
  }
  return /** @type {{ history: number }} */ (schedule.at(-1)).history;
}
