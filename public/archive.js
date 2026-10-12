// Turns /archive/ into the 3D tree when it can, and leaves the server-rendered
// nested list (the no-JS and screen-reader view) in place when it can't. Keys,
// the D-pad, the preview card, announcements and deep links live here; the
// scene itself is archive-scene.js, loaded only once WebGL is known to work.
import {
  buildTree,
  completeWeeks,
  describe,
  edgeMessage,
  existsAt,
  nearestExisting,
  frontier,
  isLit,
  move,
  replies,
  totalProgress,
  weekComplete,
  weekProgress,
  withMark,
  withSeen,
  withWeek,
} from "./archive-tree.js";
import * as sound from "./archive-sound.js";
import { startTogether } from "./archive-together.js";
import { startTimeline } from "./archive-timeline.js";

/** @typedef {import("./archive-tree.js").Move} Move */

const KEYS = /** @type {Record<string, Move | "open" | "wave" | "person" | "time" | "play" | "prev" | "next" | "prevSeal" | "nextSeal">} */ ({
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Escape: "up",
  "[": "older",
  PageDown: "older",
  "]": "newer",
  PageUp: "newer",
  Home: "home",
  Enter: "open",
  w: "wave",
  W: "wave",
  p: "person",
  P: "person",
  t: "time",
  T: "time",
  " ": "play",
  ",": "prev",
  ".": "next",
  "<": "prevSeal",
  ">": "nextSeal",
});

const timeFormat = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney",
  dateStyle: "medium",
  timeStyle: "short",
});

/** @param {string} tag @param {Record<string, string>} attrs @param {string} [text] */
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function webglAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** @param {string} why */
function fallback(why) {
  document.body.classList.remove("scene-on", "scene-loading");
  const list = document.getElementById("list-view");
  if (!list || document.querySelector(".fallback-note")) return;
  list.before(el("p", { class: "notice fallback-note" }, `${why} Here's the whole tree as a list instead.`));
}

function initialId(tree) {
  const fromHash = location.hash.match(/^#m-(\d+)$/);
  const fromQuery = new URLSearchParams(location.search).get("at");
  const id = Number(fromHash?.[1] ?? fromQuery ?? NaN);
  return tree.nodes.has(id) ? id : tree.rootId;
}

async function main() {
  const archive = document.getElementById("archive");
  const list = document.getElementById("list-view");
  if (!archive || !list) return;

  if (!webglAvailable()) {
    fallback("This browser isn't offering WebGL, so the 3D archive can't run.");
    return;
  }
  document.body.classList.add("scene-on", "scene-loading");

  let tree;
  let sceneModule;
  try {
    const [res, mod] = await Promise.all([fetch("/archive.json"), import("./archive-scene.js")]);
    if (!res.ok) throw new Error(`archive.json: ${res.status}`);
    tree = buildTree(await res.json());
    sceneModule = mod;
  } catch {
    fallback("The 3D archive couldn't load.");
    return;
  }

  // ---- chrome: stage, toggle, preview, D-pad, legend, live region -------------
  const stage = el("div", {
    id: "stage",
    class: "stage",
    tabindex: "0",
    role: "application",
    "aria-label": "Archive tree. Arrow keys move, Enter opens. The list view has the same tree as text.",
  });
  const hud = el("div", { class: "hud" });
  const toggle = el("button", { type: "button", class: "view-toggle", "aria-pressed": "false" }, "List view");
  const switches = el("div", { class: "switches", role: "group", "aria-label": "Sky settings" });
  const pauseBtn = el("button", { type: "button", class: "switch", "aria-pressed": "false" }, "Pause orbits");
  const soundBtn = el("button", { type: "button", class: "switch", "aria-pressed": "false" }, "Sound");
  const timeBtn = el("button", { type: "button", class: "switch", "aria-pressed": "false" }, "Time travel");
  switches.append(timeBtn, pauseBtn, soundBtn);
  const announce = el("p", { class: "sr-only", "aria-live": "polite" });

  const preview = el("section", { class: "preview", "aria-label": "Selected mark" });
  const pWho = el("p", { class: "preview-who" });
  const pBody = el("p", { class: "preview-body" });
  const pMeta = el("p", { class: "preview-meta" });
  const pOpen = el("a", { class: "preview-open", href: "/" }, "Open");
  preview.append(pWho, pBody, pMeta, pOpen);
  // Grow a branch from where you are: a small reply form for marks in this week.
  const reply = el("form", { class: "reply" });
  const rName = /** @type {HTMLInputElement} */ (
    el("input", { id: "reply-name", name: "name", required: "", maxlength: "40", autocomplete: "name" })
  );
  rName.value = archive.dataset.name ?? "";
  const rBody = /** @type {HTMLTextAreaElement} */ (el("textarea", { id: "reply-body", name: "body", required: "", maxlength: "280", rows: "2" }));
  const rBodyLabel = el("label", { for: "reply-body" }, "Reply here");
  const rSend = el("button", { type: "submit" }, "Reply");
  reply.append(el("label", { for: "reply-name" }, "Your name"), rName, rBodyLabel, rBody, rSend);
  const sealedLine = el("p", { class: "preview-sealed" }, "Sealed: nothing can be added to this week now.");
  const rewindBtn = el("button", { type: "button", class: "preview-rewind" }, "Rewind to when this was posted");
  preview.append(reply, sealedLine, rewindBtn);

  const dpad = el("div", { class: "dpad", role: "group", "aria-label": "Move through the tree" });
  /** @type {[Move, string, string][]} */
  const pads = [
    ["up", "↑", "What this orbits"],
    ["left", "←", "One orbit out (quieter)"],
    ["home", "⌂", "This week"],
    ["right", "→", "One orbit in (livelier)"],
    ["down", "↓", "Outermost moon"],
  ];
  for (const [m, glyph, label] of pads) {
    const b = el("button", { type: "button", class: `pad pad-${m}`, "aria-label": label, title: label }, glyph);
    b.addEventListener("click", () => go(m));
    dpad.append(b);
  }

  const legend = el("details", { class: "legend" });
  legend.append(el("summary", {}, "Keys"));
  const dl = el("dl");
  for (const [k, v] of [
    ["↑ / Esc", "what this orbits (from a week: the newer week)"],
    ["↓", "its outermost moon"],
    ["← →", "one orbit out (quieter) / in (livelier); out past the last planet is last week"],
    ["[ ]", "older / newer week"],
    ["Enter", "open"],
    ["Home", "back to this week"],
    ["W", "wave at whoever's here"],
    ["P", "fly to the next person here"],
    ["T", "time travel on / off (Esc leaves it)"],
    ["Space", "play history from the scrub point"],
    [", .", "previous / next mark in time"],
    ["Shift + , .", "previous / next seal"],
  ]) {
    dl.append(el("dt", {}, k), el("dd", {}, v));
  }
  legend.append(dl);
  // Closed by default: open, it covers the sky's labels. The stage's own
  // label names the keys for screen readers.

  const progress = el("p", { class: "progress" });
  const pWeek = el("span", { class: "progress-week" });
  const pAll = el("span", { class: "progress-all" });
  progress.append(pWeek, pAll);

  hud.append(legend, switches, progress, preview, dpad);
  list.before(toggle);
  // Inside <main>, so every control sits in a landmark; the HUD is fixed-position.
  archive.append(hud, announce);
  archive.after(stage);

  // ---- state ---------------------------------------------------------------------
  let selected = initialId(tree);
  /** @type {number | null} */
  let hovered = null;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  function showPreview() {
    const id = hovered ?? selected;
    const n = tree.nodes.get(id);
    if (!n) return;
    if (n.isRoot) {
      pWho.textContent = n.body;
      pBody.textContent =
        id === tree.rootId
          ? "This week. Everything posted on the home page hangs here until 00:00 Monday."
          : "A sealed week. Nothing can be added to it now.";
      pMeta.textContent = n.childCount === 1 ? "1 mark" : `${n.childCount} marks`;
    } else if (!isLit(n)) {
      // A hovered ember shows who wrote it, not what they said.
      pWho.textContent = n.name;
      pBody.textContent = "Unexplored, fly here to read it.";
      pMeta.textContent = `${timeFormat.format(new Date(n.createdAt))} · ${replies(n.childCount)}`;
    } else {
      pWho.textContent = n.mine ? `${n.name} (yours)` : n.name;
      pBody.textContent = n.body;
      pMeta.textContent = `${timeFormat.format(new Date(n.createdAt))} · ${replies(n.childCount)}`;
    }
    pOpen.href = id === tree.rootId ? "/" : `/m/${id}`;
    pOpen.textContent = n.isRoot ? `Open ${n.body}` : `Open ${n.name}'s mark`;
    preview.classList.toggle("is-hover", hovered !== null && hovered !== selected);
    // The reply form belongs to the selection, and never vanishes mid-typing.
    const sel = tree.nodes.get(selected);
    const typing = reply.contains(document.activeElement);
    // no replying from the past: time travel is spectating
    const open = Boolean(sel && sel.weekIndex === 0 && !sel.archived && !timeline.active());
    if (!typing) {
      reply.hidden = !open || (hovered !== null && hovered !== selected);
      rBodyLabel.textContent = sel?.isRoot ? "Leave a mark on this week" : `Reply to ${sel?.name ?? "this"}`;
    }
    sealedLine.hidden = Boolean(open || !sel || (hovered !== null && hovered !== selected));
    rewindBtn.hidden = Boolean(!sel || sel.isRoot || (hovered !== null && hovered !== selected));
  }
  rewindBtn.addEventListener("click", () => {
    const n = tree.nodes.get(selected);
    if (n) timeline.rewindTo(n.t);
  });

  reply.addEventListener("submit", async (e) => {
    e.preventDefault();
    const target = selected;
    rSend.setAttribute("disabled", "");
    try {
      const res = await fetch(`/m/${target}`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: rName.value, body: rBody.value }),
      });
      if (res.status === 201) {
        const { id } = await res.json();
        rBody.value = "";
        stage.focus();
        together.expectOwn(id);
      } else if (res.status === 403) announce.textContent = "That week has sealed, so nothing can be added to it now.";
      else if (res.status === 404) announce.textContent = "That mark doesn't exist any more.";
      else announce.textContent = "Write a name and something to say first.";
    } catch {
      announce.textContent = "Couldn't reach the server. Try again in a moment.";
    } finally {
      rSend.removeAttribute("disabled");
    }
  });

  const scene = sceneModule.startScene({
    tree,
    container: stage,
    initialId: selected,
    reducedMotion: reduce.matches,
    onSelect: (id) => select(id),
    onHover: (id) => {
      hovered = id;
      showPreview();
    },
    onOpen: (id) => open(id),
    onChip: (personId) => together.flyTo(personId),
  });
  document.body.classList.remove("scene-loading");
  reduce.addEventListener("change", () => {
    scene.setReducedMotion(reduce.matches);
    // a flight cancelled by the switch never lands; light what it was flying to
    for (const pending of [...lighting]) land(pending);
  });
  // What landing somewhere does: the scene plays the arrival, and a mark lit
  // on the way lights up as you land, at full strength.
  /** @type {Set<number>} marks lit in the logical tree but not yet in the scene */
  const lighting = new Set();
  /** @type {Map<number, number>} landing on this mark completes this week root */
  const celebrations = new Map();
  /** The tree as the scene draws it: marks still being flown to stay dark until you land. */
  function shown() {
    let t = tree;
    for (const id of lighting) {
      const n = t.nodes.get(id);
      if (n) t = { ...t, nodes: new Map(t.nodes).set(id, { ...n, seen: false }) };
    }
    return t;
  }

  /** Light a mark in the scene (you landed, or flew on past it), celebrating a finished week. @param {number} id */
  function land(id) {
    lighting.delete(id);
    scene.refresh(shown());
    updateFog();
    const root = celebrations.get(id);
    if (root === undefined) return;
    celebrations.delete(id);
    scene.celebrate(root);
    sound.arpeggio();
    const label = tree.nodes.get(root)?.body ?? "This week";
    later(() => (announce.textContent = `${label} complete: every mark lit.`), 1200);
  }

  scene.onArrive((id, strength) => {
    const n = tree.nodes.get(id);
    if (n && strength === "full") sound.chime();
    else if (n) sound.tick(n.depth + (n.isRoot ? 0 : 1));
    if (lighting.has(id)) land(id);
  });

  function updateFog() {
    const drawn = shown();
    scene.setFog({ frontier: frontier(drawn), complete: completeWeeks(drawn) });
    const n = tree.nodes.get(selected);
    if (n) {
      const week = weekProgress(tree, n.weekId);
      pWeek.textContent = `${n.label}: ${week.lit} / ${week.total} lit`;
    }
    const all = totalProgress(tree);
    pAll.textContent = `${all.lit} / ${all.total} all time`;
  }

  /** @param {() => void} fn @param {number} ms */
  function later(fn, ms) {
    setTimeout(fn, ms);
  }

  /** Light a mark for this visitor: in memory now, on the server in the background. @param {number} id */
  function light(id) {
    const n = tree.nodes.get(id);
    if (!n || isLit(n)) return false;
    const wasComplete = weekComplete(tree, n.weekId);
    tree = withSeen(tree, id);
    lighting.add(id);
    if (!wasComplete && weekComplete(tree, n.weekId)) {
      const root = tree.weekRoots.find((r) => tree.nodes.get(r)?.weekId === n.weekId);
      if (root !== undefined) celebrations.set(id, root);
    }
    fetch("/seen", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id: String(id) }),
    }).catch(() => {});
    return true;
  }
  pauseBtn.addEventListener("click", () => {
    const on = pauseBtn.getAttribute("aria-pressed") !== "true";
    pauseBtn.setAttribute("aria-pressed", String(on));
    scene.setPaused(on);
    announce.textContent = on ? "Orbits paused." : "Orbits moving.";
  });
  soundBtn.addEventListener("click", () => {
    const on = soundBtn.getAttribute("aria-pressed") !== "true";
    soundBtn.setAttribute("aria-pressed", String(on));
    sound.setSound(on);
    if (on) sound.tick(1);
  });
  // A hook for checks and curious devtools users; holds no private data.
  Object.assign(window, {
    __archive: { stats: scene.stats, selected: () => selected, screenOf: scene.screenOf, positionAt: scene.positionAt },
  });

  /**
   * Arrive at a mark: by key, D-pad, click or deep link. Spectating (time
   * travel moving you, playback following) shows it without lighting it.
   * @param {number} id @param {{ spectate?: boolean, quiet?: boolean }} [opts]
   */
  function select(id, { spectate = false, quiet = false } = {}) {
    // In time travel nothing can be selected that didn't exist yet (a peer
    // ahead of you, a deep link, your own new reply): its nearest ancestor
    // that did stands in, which is where its wisp waits too.
    if (timeline.active() && !existsAt(tree, id, timeline.time())) id = nearestExisting(tree, id, timeline.time());
    // a flight cut short by this one still lit what it was flying to
    for (const pending of [...lighting]) if (pending !== id) land(pending);
    const same = id === selected;
    const first = !spectate && light(id);
    hovered = null;
    selected = id;
    scene.select(id, { strength: first ? "full" : spectate ? "none" : "small" });
    // already there (spectating it, say): no flight will land, so light it now
    if (first && same && lighting.has(id)) land(id);
    showPreview();
    updateFog();
    if (!quiet) announce.textContent = `${first ? "New. " : ""}${describe(tree, id, scene.order())}`;
    together.moved();
    // Track position in the URL without a history entry per keypress.
    history.replaceState(null, "", `#m-${id}`);
  }

  /** @param {number} id */
  function open(id) {
    location.href = id === tree.rootId ? "/" : `/m/${id}`;
  }

  /** @param {Move} m */
  function go(m) {
    together.userMoved();
    let next = move(tree, selected, m, scene.order());
    // in time travel, only through marks that existed at the scrub time
    if (next !== null && timeline.active() && !existsAt(tree, next, timeline.time())) {
      next = m === "home" ? nearestExisting(tree, next, timeline.time()) : null;
      if (next === selected) next = null;
    }
    if (next === null) {
      sound.thud();
      scene.bump(m);
      // Re-set even if unchanged, so a repeated edge still gets announced.
      announce.textContent = "";
      requestAnimationFrame(() => (announce.textContent = edgeMessage(tree, selected, m)));
      stage.classList.remove("bump");
      void stage.offsetWidth;
      stage.classList.add("bump");
      return;
    }
    select(next);
  }

  document.addEventListener("keydown", (e) => {
    if (!document.body.classList.contains("scene-on")) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // Only when nothing else has focus: nav links, the preview's Open link and
    // the D-pad buttons keep their own keys.
    if (e.target !== document.body && e.target !== stage) return;
    const action = KEYS[e.key];
    if (!action) return;
    // Esc leaves time travel while it's on, and means "up" otherwise; Space
    // only plays inside time travel.
    if (e.key === "Escape" && timeline.active()) {
      e.preventDefault();
      timeline.exit();
      return;
    }
    if (action === "play" && !timeline.active()) return;
    e.preventDefault();
    if (action === "time") timeline.toggle();
    else if (action === "play") timeline.playPause();
    else if (action === "prev") timeline.step(-1);
    else if (action === "next") timeline.step(1);
    else if (action === "prevSeal") timeline.jumpSeal(-1);
    else if (action === "nextSeal") timeline.jumpSeal(1);
    else if (action === "open") open(selected);
    else if (action === "wave") together.wave();
    else if (action === "person") together.next();
    else go(action);
  });

  window.addEventListener("hashchange", () => {
    const id = initialId(tree);
    if (id !== selected) select(id);
  });

  toggle.addEventListener("click", () => {
    const listOn = document.body.classList.toggle("scene-on") === false;
    toggle.setAttribute("aria-pressed", String(listOn));
    toggle.textContent = listOn ? "Tree view" : "List view";
    if (listOn) {
      // Land the list on the same mark the tree was showing.
      const item = document.getElementById(`m-${selected}`);
      for (let d = item?.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;
      // after the layout switch, or the scroll lands against the old layout
      requestAnimationFrame(() => item?.scrollIntoView({ block: "center" }));
    }
  });

  // ---- together: presence, chat, and new marks arriving live -----------------------
  /** @type {ReturnType<typeof startTogether>} */
  const together = startTogether({
    scene,
    hud,
    switches,
    stage,
    tree: () => tree,
    selected: () => selected,
    select: (id) => select(id),
    announce: (text) => {
      announce.textContent = "";
      requestAnimationFrame(() => (announce.textContent = text));
    },
    addMark(mark, parentChildCount) {
      if (tree.nodes.has(mark.id)) return;
      tree = withMark(tree, mark, parentChildCount);
      scene.setTree(shown(), { born: mark.id });
      updateFog();
      showPreview();
      timeline.treeChanged();
      if (mark.mine) rName.value = mark.name;
    },
    addWeek(week, root) {
      const old = tree.nodes.get(tree.rootId);
      tree = withWeek(tree, week, root);
      scene.setTree(shown(), { week: root.id });
      updateFog();
      showPreview();
      timeline.treeChanged();
      const text = `${old?.body ?? "Last week"} has sealed. ${week.label} has begun.`;
      announce.textContent = "";
      requestAnimationFrame(() => (announce.textContent = text));
    },
    timeTravelling: () => timeline.active(),
    ownName: () => rName.value.trim(),
  });

  // ---- time travel ----------------------------------------------------------------
  const timeline = startTimeline({
    scene,
    hud,
    tree: () => tree,
    selected: () => selected,
    select: (id, opts) => select(id, opts),
    announce: (text) => {
      announce.textContent = "";
      requestAnimationFrame(() => (announce.textContent = text));
    },
    changed: () => {
      timeBtn.setAttribute("aria-pressed", String(timeline.active()));
      together.moved();
      showPreview();
    },
    reducedMotion: () => reduce.matches,
  });
  timeBtn.addEventListener("click", () => timeline.toggle());

  // A deep link is an arrival too.
  const firstLit = light(selected);
  if (firstLit) land(selected);
  showPreview();
  updateFog();
  announce.textContent = `${firstLit ? "New. " : ""}${describe(tree, selected, scene.order())}`;
}

main();
