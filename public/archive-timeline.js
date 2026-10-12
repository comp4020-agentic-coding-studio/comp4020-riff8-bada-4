// Time travel: a timeline you can scrub or play to rewind the sky to any past
// moment and watch it grow back, with a thread through the marks in the order
// they were said. Client side only: everything comes from createdAt.
import {
  existsAt,
  historyAt,
  isLit,
  nearestExisting,
  postingOrder,
  replaySchedule,
  sealsBetween,
  sealTime,
  snippet,
  stepInTime,
} from "./archive-tree.js";
import * as sound from "./archive-sound.js";

const DAY = 86_400_000;
const when = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});
const dayLabel = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short" });

/** @param {string} tag @param {Record<string, string>} attrs @param {string} [text] */
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {{
 *   scene: any,
 *   hud: HTMLElement,
 *   tree: () => import("./archive-tree.js").Tree,
 *   selected: () => number,
 *   select: (id: number, opts?: { spectate?: boolean, quiet?: boolean }) => void,
 *   announce: (text: string) => void,
 *   changed: () => void,
 *   reducedMotion: () => boolean,
 * }} app
 */
export function startTimeline(app) {
  let active = false;
  let time = Date.now();
  let playing = false;
  let follow = false;
  /** @type {{ history: number, play: number }[]} */
  let schedule = [];
  let playFrom = 0;
  let caughtUp = false;
  let rewindTimer = 0;

  // ---- the bar ---------------------------------------------------------------------
  const bar = el("section", { class: "timeline", "aria-label": "Time travel" });
  bar.hidden = true;
  const row = el("div", { class: "timeline-row" });
  const playBtn = el("button", { type: "button", "aria-pressed": "false" }, "Play");
  const followBtn = el("button", { type: "button", "aria-pressed": "false" }, "Follow new marks");
  const readout = el("p", { class: "timeline-when", "aria-hidden": "true" });
  const closeBtn = el("button", { type: "button", class: "timeline-close" }, "Back to now");
  row.append(playBtn, followBtn, readout, closeBtn);
  const track = el("div", { class: "timeline-track" });
  const marksLayer = el("div", { class: "timeline-marks", "aria-hidden": "true" });
  const range = /** @type {HTMLInputElement} */ (el("input", { type: "range", class: "timeline-range", "aria-label": "Time" }));
  track.append(marksLayer, range);
  bar.append(row, track);
  app.hud.append(bar);

  const tree = () => app.tree();
  const start = () => {
    const roots = tree().weekRoots;
    return tree().nodes.get(roots[roots.length - 1])?.t ?? Date.now() - 7 * DAY;
  };
  const end = () => Math.max(Date.now(), ...[...tree().nodes.values()].map((n) => n.t));
  const pct = (/** @type {number} */ t) => `${(((t - start()) / Math.max(1, end() - start())) * 100).toFixed(3)}%`;

  /** Ticks at every seal and a dot for every mark: the semester's rhythm. */
  function renderTrack() {
    marksLayer.replaceChildren();
    for (const s of sealsBetween(tree(), start() - 1, end())) {
      const tick = el("span", { class: "timeline-tick" });
      tick.style.left = pct(s);
      tick.append(el("span", {}, dayLabel.format(new Date(s))));
      marksLayer.append(tick);
    }
    for (const id of postingOrder(tree())) {
      const n = tree().nodes.get(id);
      if (!n) continue;
      const dot = el("span", { class: `timeline-dot${isLit(n) ? " lit" : ""}${n.mine ? " mine" : ""}` });
      dot.style.left = pct(n.t);
      marksLayer.append(dot);
    }
    range.min = String(start());
    range.max = String(end());
    range.step = "60000";
  }

  const countAt = (/** @type {number} */ t) => postingOrder(tree()).filter((id) => existsAt(tree(), id, t)).length;
  const describeTime = (/** @type {number} */ t) => {
    const n = countAt(t);
    return `${when.format(new Date(t))}: ${n === 1 ? "1 mark" : `${n} marks`}`;
  };

  /**
   * Move the sky to a moment. If the selection didn't exist then, it moves
   * to its nearest ancestor that did.
   * @param {number} t @param {{ announceMove?: boolean }} [opts]
   */
  function setTime(t, { announceMove = true } = {}) {
    time = Math.min(end(), Math.max(start(), t));
    range.max = String(end());
    app.scene.setTime(time);
    app.scene.setThread(postingOrder(tree()).filter((id) => existsAt(tree(), id, time)));
    range.value = String(time);
    range.setAttribute("aria-valuetext", describeTime(time));
    readout.textContent = describeTime(time);
    const sel = app.selected();
    if (!existsAt(tree(), sel, time)) {
      const to = nearestExisting(tree(), sel, time);
      app.select(to, { spectate: true, quiet: true });
      if (announceMove) {
        const n = tree().nodes.get(to);
        app.announce(`That mark hadn't been posted yet; moved to ${n?.isRoot ? n.body : `${n?.name}'s mark`}.`);
      }
    }
    app.changed();
  }

  function enter(t = Date.now()) {
    if (!active) {
      active = true;
      bar.hidden = false;
      document.body.classList.add("tt-on");
      renderTrack();
      app.scene.setWispMark((/** @type {number} */ id) => (active ? nearestExisting(tree(), id, time) : id));
    }
    setTime(t);
    const present = end() - time < 60_000 ? "at the present, " : "";
    app.announce(`Time travel, ${present}${describeTime(time)}. Drag the timeline or press Space to play, comma and full stop to step.`);
  }

  function exit() {
    if (!active) return;
    active = false;
    stop();
    bar.hidden = true;
    document.body.classList.remove("tt-on");
    app.scene.setThread(null);
    app.scene.setRewinding(false);
    app.scene.setTime(null);
    app.scene.setWispMark((/** @type {number} */ id) => id);
    app.changed();
    app.announce("Back to now. The whole tree is here again.");
  }

  // ---- scrubbing ---------------------------------------------------------------------
  range.addEventListener("input", () => {
    stop();
    const next = Number(range.value);
    const back = next < time;
    if (back && time - next > DAY) sound.rewind();
    rewinding(back);
    setTime(next, { announceMove: false });
  });
  range.addEventListener("change", () => setTime(Number(range.value)));

  /** @param {boolean} on */
  function rewinding(on) {
    clearTimeout(rewindTimer);
    app.scene.setRewinding(on && !app.reducedMotion());
    if (on) rewindTimer = window.setTimeout(() => app.scene.setRewinding(false), 700);
  }

  // ---- playback ----------------------------------------------------------------------
  // Each play() gets its own loop id, so a pause and resume inside one frame
  // never leaves two loops running.
  let loop = 0;
  function play() {
    if (!active) enter(start());
    if (time >= end() - 60_000) setTime(start());
    playing = true;
    caughtUp = false;
    schedule = replaySchedule(tree(), time, end());
    playFrom = performance.now();
    playBtn.setAttribute("aria-pressed", "true");
    playBtn.textContent = "Pause";
    rewinding(false);
    const id = ++loop;
    requestAnimationFrame(() => tick(id));
  }

  function stop() {
    playing = false;
    caughtUp = false;
    loop++;
    playBtn.setAttribute("aria-pressed", "false");
    playBtn.textContent = "Play";
  }

  let lastLive = 0;
  /** @param {number} id */
  function tick(id) {
    if (!playing || !active || id !== loop) return;
    const before = time;
    let next;
    if (caughtUp) {
      // caught up: keep riding now, so live marks sprout as they land
      if (performance.now() - lastLive < 1000) return void requestAnimationFrame(() => tick(id));
      lastLive = performance.now();
      next = Date.now();
    } else {
      next = historyAt(schedule, (performance.now() - playFrom) / 1000);
      if (next >= (schedule.at(-1)?.history ?? next)) caughtUp = true;
    }
    // reduced motion: step from mark to mark, cut by cut
    if (app.reducedMotion() && !caughtUp) {
      const nextId = stepInTime(tree(), before, 1);
      const nt = nextId === null ? next : tree().nodes.get(nextId)?.t ?? next;
      if (nt > next) next = before;
    }
    if (next !== before) {
      const born = postingOrder(tree()).filter((id) => {
        const t = tree().nodes.get(id)?.t ?? 0;
        return t > before && t <= next;
      });
      for (const s of sealsBetween(tree(), before, next)) crossSeal(s);
      setTime(next, { announceMove: false });
      if (born.length) {
        sound.tick(2);
        if (follow) app.select(born[born.length - 1], { spectate: true });
      }
    }
    requestAnimationFrame(() => tick(id));
  }

  /** Crossing a seal is the drama: the week that ended flashes and locks. @param {number} s */
  function crossSeal(s) {
    const ended = tree().weekRoots.find((r) => sealTime(tree(), r) === s);
    if (ended === undefined) return;
    app.scene.sealCrossed(ended);
    const label = tree().nodes.get(ended)?.body ?? "A week";
    app.announce(`${label} sealed at 00:00 Monday. Nothing could be added to it after this.`);
  }

  playBtn.addEventListener("click", () => (playing ? stop() : play()));
  followBtn.addEventListener("click", () => {
    follow = !follow;
    followBtn.setAttribute("aria-pressed", String(follow));
  });
  closeBtn.addEventListener("click", exit);

  // ---- stepping ----------------------------------------------------------------------
  /** , and . : the previous or next mark in time, selected (which lights it). @param {1 | -1} dir */
  function step(dir) {
    if (!active) enter();
    stop();
    const sel = app.selected();
    const from = tree().nodes.get(sel)?.t === time ? sel : undefined;
    const id = stepInTime(tree(), time, dir, from);
    if (id === null) {
      app.announce(dir === 1 ? "That's the newest mark." : "That's the first mark there is.");
      return;
    }
    const n = /** @type {import("./archive-tree.js").TreeNode} */ (tree().nodes.get(id));
    rewinding(dir === -1);
    setTime(n.t, { announceMove: false });
    app.select(id);
    const parent = n.parentId === null ? undefined : tree().nodes.get(n.parentId);
    const under = parent?.isRoot ? parent.body : `${parent?.name}'s mark`;
    app.announce(`${when.format(new Date(n.t))}: ${n.name}, under ${under}: “${snippet(n.body, 80)}”`);
  }

  /** Shift+, and Shift+. : the previous or next seal. @param {1 | -1} dir */
  function jumpSeal(dir) {
    if (!active) enter();
    stop();
    const seals = sealsBetween(tree(), start() - 1, end());
    const s = dir === 1 ? seals.find((x) => x > time) : seals.filter((x) => x < time).at(-1);
    if (s === undefined) {
      app.announce(dir === 1 ? "No later seal." : "No earlier seal.");
      return;
    }
    rewinding(dir === -1);
    setTime(s);
    app.announce(`${when.format(new Date(s))}: a seal. ${describeTime(s)}.`);
  }

  return {
    active: () => active,
    time: () => time,
    toggle: () => (active ? exit() : enter()),
    enter,
    exit,
    /** Space */
    playPause() {
      if (playing) stop();
      else play();
    },
    step,
    jumpSeal,
    /** The preview's "Rewind to when this was posted". @param {number} t */
    rewindTo(t) {
      enter(t);
    },
    /** The tree grew (a live mark or week): new dots, and the sky at the scrub time. */
    treeChanged() {
      if (!active) return;
      renderTrack();
      if (playing && caughtUp) setTime(Date.now(), { announceMove: false });
    },
  };
}
