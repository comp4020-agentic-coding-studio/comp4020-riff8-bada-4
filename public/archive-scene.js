// The archive as a sky you travel through: each week a star system, marks as
// planets, replies as moons. Rendering, animation and pointer input only:
// what the keys mean, what gets announced and what the preview shows live in
// archive.js, and the orbit model itself in archive-tree.js.
import * as THREE from "three";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { isLit as nodeLit, orbitModel, pathBetween, positionAt, snippet } from "./archive-tree.js";

/** @typedef {import("./archive-tree.js").Tree} Tree */
/** @typedef {import("./archive-tree.js").OrbitModel} OrbitModel */
/** @typedef {"full" | "small" | "none"} Strength */

const BACKGROUND = 0x04060e;
const COLOURS = {
  // Bodies sit just past 1 so the bloom pass catches them; rings sit below
  // its threshold, so they stay hairlines rather than floodlights.
  sun: new THREE.Color(1.6, 1.12, 0.45),
  mark: new THREE.Color(0.24, 0.8, 1.0), // teal
  mine: new THREE.Color(1.1, 0.36, 0.85), // rose: marks you left
  ember: new THREE.Color(0.16, 0.13, 0.12),
  rim: new THREE.Color(0.55, 0.42, 0.3),
  ring: new THREE.Color(0.28, 0.55, 0.68),
  ringDim: new THREE.Color(0.12, 0.16, 0.2),
  arm: new THREE.Color(1.0, 0.78, 0.5),
  pulse: new THREE.Color(2.6, 2.3, 1.6),
  crown: new THREE.Color(1.8, 1.3, 0.5),
};
// Stars cool with age: gold, amber, deep red.
const STAR_AGES = [new THREE.Color(1.6, 1.12, 0.45), new THREE.Color(1.25, 0.62, 0.22), new THREE.Color(0.95, 0.32, 0.14), new THREE.Color(0.6, 0.16, 0.1)];
const ELEVATION = THREE.MathUtils.degToRad(36); // the default camera looks down at the plane
const LABEL_NEAR = 16;
const LABEL_FAR = 30;
const RING_SEGMENTS = 128;
const REFRESH_MS = 30_000;

/** A soft round glow, drawn once, for particles, halos and the pulse. */
function glowTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const v3 = (p) => new THREE.Vector3(p.x, p.y, p.z);

/**
 * @param {{
 *   tree: Tree,
 *   container: HTMLElement,
 *   initialId: number,
 *   reducedMotion: boolean,
 *   onSelect: (id: number) => void,
 *   onHover: (id: number | null) => void,
 *   onOpen: (id: number) => void,
 * }} opts
 */
export function startScene({ tree: initialTree, container, initialId, reducedMotion, onSelect, onHover, onOpen }) {
  let tree = initialTree;
  let motion = !reducedMotion;
  let paused = false;
  const glow = glowTexture();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(BACKGROUND);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.className = "scene-canvas";
  container.append(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.domElement.className = "scene-labels";
  labels.domElement.setAttribute("aria-hidden", "true");
  container.append(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.FogExp2(BACKGROUND, 0.013);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 600);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.minDistance = 2.5;
  controls.maxDistance = 70;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = 1.5;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.4, 0.7);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---- a far starfield, outside the fog ---------------------------------------
  {
    const n = 1400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = 220 + Math.random() * 120;
      const s = Math.sqrt(1 - u * u);
      pos.set([r * s * Math.cos(a), r * u, r * s * Math.sin(a)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(
      g,
      new THREE.PointsMaterial({ size: 0.9, color: 0x8899bb, transparent: true, opacity: 0.55, fog: false, sizeAttenuation: true }),
    );
    scene.add(stars);
  }

  // ---- the orbit model, and what the scene is easing toward ------------------------
  // In live mode "now" is the wall clock, nudged past the newest mark so a
  // server clock slightly ahead of ours never hides a fresh arrival.
  const newestT = () => Math.max(...[...tree.nodes.values()].map((n) => n.t));
  const liveNow = () => Math.max(Date.now(), newestT());
  let model = orbitModel(tree, liveNow());
  let modelAt = performance.now();

  /**
   * Per body: displayed radius easing toward the model's, with an optional
   * swirl (an extra turn as it spirals in), a displayed anchor for stars, and
   * growth (0 = not born, 1 = condensed on its ring).
   * @type {Map<number, { r: number, rFrom: number, rTo: number, start: number, dur: number, swirl: boolean,
   *   anchor: THREE.Vector3 | null, aFrom: THREE.Vector3 | null, aTo: THREE.Vector3 | null, aStart: number,
   *   grow: number, growTarget: number, growDelay: number, size: number }>}
   */
  const disp = new Map();
  const nowS = () => performance.now() / 1000;

  // ---- bodies --------------------------------------------------------------------
  const sphere = new THREE.SphereGeometry(1, 28, 18);
  const ringGeometry = (() => {
    const pts = [];
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  })();
  const world = new THREE.Group();
  scene.add(world);

  /**
   * @type {Map<number, { mesh: THREE.Mesh, halo: THREE.Sprite, rim: THREE.Sprite, label: CSS2DObject, el: HTMLElement,
   *   who: HTMLElement, what: HTMLElement, ring: THREE.Line | null, crown: THREE.Mesh | null,
   *   pop: { start: number, amp: number } | null, lit: number, flare: number, pos: THREE.Vector3 }>}
   */
  const bodies = new Map();

  function makeBody(id) {
    const node = tree.nodes.get(id);
    if (!node) return;
    const mesh = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: COLOURS.mark.clone(), toneMapped: false }));
    mesh.userData.id = id;
    world.add(mesh);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glow, color: COLOURS.mark.clone(), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    world.add(halo);
    // An ember's thin rim catching starlight.
    const rim = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glow, color: COLOURS.rim, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    world.add(rim);
    let ring = null;
    let crown = null;
    if (!node.isRoot) {
      ring = new THREE.Line(
        ringGeometry,
        new THREE.LineBasicMaterial({ color: COLOURS.ring.clone(), transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }),
      );
      world.add(ring);
    } else {
      crown = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.025, 6, 96),
        new THREE.MeshBasicMaterial({ color: COLOURS.crown, toneMapped: false, transparent: true, opacity: 0 }),
      );
      crown.rotation.x = Math.PI / 2;
      world.add(crown);
    }

    // Body text is real DOM, filled with textContent only.
    const el = document.createElement("div");
    el.className = `bubble${node.isRoot ? " bubble-root" : ""}${node.mine ? " bubble-mine" : ""}`;
    const who = document.createElement("span");
    who.className = "bubble-who";
    const what = document.createElement("span");
    what.className = "bubble-what";
    el.append(who, what);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      pick(id);
    });
    el.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") setHover(id);
    });
    el.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") setHover(null);
    });
    const label = new CSS2DObject(el);
    label.center.set(0.5, node.isRoot ? 1 : 0);
    world.add(label);
    const b = { mesh, halo, rim, label, el, who, what, ring, crown, pop: null, lit: isLit(id) ? 1 : 0, flare: 0, pos: new THREE.Vector3() };
    bodies.set(id, b);
    restyle(id);
  }

  /** Lit: a root, your own mark, or one you've explored. @param {number} id */
  const isLit = (id) => nodeLit(tree.nodes.get(id));

  /** Label text and colours for a body, from the tree as it is now. @param {number} id */
  function restyle(id) {
    const b = bodies.get(id);
    const node = tree.nodes.get(id);
    if (!b || !node) return;
    if (node.isRoot) {
      const live = id === model.weeks[0];
      b.who.textContent = live ? `${node.body} · now` : node.body;
      const n = model.order.get(id)?.filter((k) => !tree.nodes.get(k)?.isRoot).length ?? 0;
      b.what.textContent = n === 0 ? "No marks" : n === 1 ? "1 mark" : `${n} marks`;
    } else {
      const lit = isLit(id);
      b.who.textContent = node.name;
      // An ember shows only who wrote it; the text appears once it's lit.
      b.what.textContent = lit ? snippet(node.body, 56) : "";
      b.el.classList.toggle("bubble-ember", !lit);
    }
    b.el.classList.toggle("bubble-mine", Boolean(node.mine));
  }

  for (const id of tree.nodes.keys()) makeBody(id);

  // ---- selection marker, pulse, effects ------------------------------------------------
  const selRing = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.03, 8, 64),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1.1, 1.1, 1.15), toneMapped: false }),
  );
  world.add(selRing);
  const pulse = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glow, color: COLOURS.pulse, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  pulse.scale.setScalar(1.4);
  pulse.visible = false;
  world.add(pulse);

  // Shockwaves: thin rings that expand from an arrival and fade.
  const shockGeometry = new THREE.RingGeometry(0.92, 1, 64);
  /** @type {{ mesh: THREE.Mesh, start: number, size: number, dur: number, id: number }[]} */
  const shocks = [];
  function shockwave(id, size, colour, dur = 0.42) {
    const mesh = new THREE.Mesh(
      shockGeometry,
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    );
    world.add(mesh);
    shocks.push({ mesh, start: nowS(), size, dur, id });
  }

  // Bursts: a spray of glow particles that dies off.
  /** @type {{ points: THREE.Points, vel: Float32Array, origin: THREE.Vector3, start: number, dur: number }[]} */
  const bursts = [];
  function burst(origin, colour, count, speed, dur = 0.45) {
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const k = speed * (0.4 + Math.random() * 0.8);
      vel.set([s * Math.cos(a) * k, u * k, s * Math.sin(a) * k], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(
      g,
      new THREE.PointsMaterial({ map: glow, size: 0.22, color: colour, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    );
    world.add(points);
    bursts.push({ points, vel, origin: origin.clone(), start: nowS(), dur });
  }

  // ---- the galactic arm: a dust lane through the week systems into the fog ---------------
  const ARM_PARTICLES = 1100;
  const armGeometry = new THREE.BufferGeometry();
  const armPos = new Float32Array(ARM_PARTICLES * 3);
  const armU = new Float32Array(ARM_PARTICLES);
  const armSpread = new Float32Array(ARM_PARTICLES * 3);
  for (let i = 0; i < ARM_PARTICLES; i++) {
    armU[i] = Math.random();
    // most dust hugs the lane; a little strays wide
    const wide = Math.random() < 0.2 ? 3 : 1;
    armSpread.set([(Math.random() - 0.5) * 3.2 * wide, (Math.random() - 0.5) * 0.9 * wide, (Math.random() - 0.5) * 3.2 * wide], i * 3);
  }
  armGeometry.setAttribute("position", new THREE.BufferAttribute(armPos, 3));
  const armCol = new Float32Array(ARM_PARTICLES * 3);
  armGeometry.setAttribute("color", new THREE.BufferAttribute(armCol, 3));
  const armMaterial = new THREE.PointsMaterial({
    map: glow,
    size: 0.38,
    vertexColors: true,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const arm = new THREE.Points(armGeometry, armMaterial);
  scene.add(arm);
  /** @type {THREE.CatmullRomCurve3 | null} */
  let armCurve = null;
  let armKey = "";
  /** Rebuild the arm's spine when the week anchors move. */
  function updateArm() {
    const anchors = model.weeks.map((id) => disp.get(id)?.anchor ?? new THREE.Vector3());
    const key = anchors.map((a) => `${a.x.toFixed(1)},${a.z.toFixed(1)}`).join(";");
    if (key === armKey) return;
    armKey = key;
    const pts = anchors.map((a) => a.clone());
    // carry on past the oldest week, out into the fog
    const last = pts.at(-1) ?? new THREE.Vector3();
    const prev = pts.at(-2) ?? new THREE.Vector3(-1, 0.3, 4);
    const dir = last.clone().sub(prev).normalize();
    pts.push(last.clone().addScaledVector(dir, 14).add(new THREE.Vector3(dir.z * 5, -2, -dir.x * 5)));
    pts.push(last.clone().addScaledVector(dir, 30).add(new THREE.Vector3(dir.z * 12, -5, -dir.x * 12)));
    // and start a little ahead of the sun, so the lane runs through it
    pts.unshift((pts[0] ?? new THREE.Vector3()).clone().addScaledVector(pts[1].clone().sub(pts[0]).normalize(), -6));
    armCurve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  }

  // ---- easing between models ---------------------------------------------------------
  /**
   * Bring the display toward a new model. Bodies whose orbit changed glide
   * there; `spiral` names bodies that just came back to life and spiral in.
   * @param {{ dur?: number, spiral?: Set<number> }} [opts]
   */
  function applyModel({ dur = 4, spiral = new Set() } = {}) {
    const t = nowS();
    for (const [id, body] of model.bodies) {
      let d = disp.get(id);
      if (!d) {
        d = {
          r: body.r,
          rFrom: body.r,
          rTo: body.r,
          start: t,
          dur: 0,
          swirl: false,
          anchor: body.anchor ? v3(body.anchor) : null,
          aFrom: null,
          aTo: null,
          aStart: 0,
          grow: 0,
          growTarget: 1,
          growDelay: 0,
          size: body.size,
        };
        disp.set(id, d);
      }
      d.growTarget = 1;
      d.size = body.size;
      if (Math.abs(d.rTo - body.r) > 1e-3) {
        const animate = motion && d.grow > 0;
        d.rFrom = animate ? d.r : body.r;
        d.rTo = body.r;
        d.start = t;
        d.dur = animate ? (spiral.size ? 1.5 : dur) : 0;
        d.swirl = animate && spiral.has(id) && body.r < d.r;
        if (!animate) d.r = body.r;
      }
      if (body.anchor) {
        const to = v3(body.anchor);
        if (!d.anchor) d.anchor = to.clone();
        if (!d.aTo || d.aTo.distanceTo(to) > 1e-3) {
          d.aFrom = d.anchor.clone();
          d.aTo = to;
          d.aStart = t;
          if (!motion) d.anchor.copy(to);
        }
      }
    }
    // Bodies the model no longer holds (time travel) shrink away.
    for (const [id, d] of disp) if (!model.bodies.has(id)) d.growTarget = 0;
    for (const id of model.weeks) restyle(id);
  }

  /** @param {number} now @param {{ dur?: number, spiral?: Set<number> }} [opts] */
  function rebuild(now, opts) {
    model = orbitModel(tree, now);
    modelAt = performance.now();
    applyModel(opts);
  }
  applyModel();
  // Grow in from the centre on first load: stars first, then each ring
  // sweeping round with its body condensing on it.
  for (const [id, d] of disp) {
    const node = tree.nodes.get(id);
    const week = Math.max(0, model.weeks.indexOf(model.bodies.get(id)?.weekRoot ?? -1));
    d.growDelay = motion ? week * 0.35 + (node?.depth ?? 0) * 0.28 : 0;
    d.grow = motion ? 0 : 1;
  }
  let loadedAt = nowS();

  // ---- sky time: the shared clock, with local slow-downs ---------------------------------
  // Everyone's sky follows Date.now(). Hovering slows the whole sky to a
  // crawl, the selected body's own system slows while you're on it, and Pause
  // stops it; afterwards it eases back to the shared clock.
  let skyLag = 0;
  /** @type {Map<number, number>} lag per slowed system, keyed by the body it orbits */
  const systemLag = new Map();
  let frozenAt = Date.now(); // the moment reduced motion stopped the sky
  let hovered = /** @type {number | null} */ (null);
  const skyTime = () => (motion ? Date.now() - skyLag : frozenAt);
  /** @param {number} id */
  const bodyTime = (id) => {
    let t = skyTime();
    if (!motion) return t;
    for (let p = tree.nodes.get(id)?.parentId; p !== null && p !== undefined; p = tree.nodes.get(p)?.parentId) {
      const lag = systemLag.get(p);
      if (lag) {
        t -= lag;
        break;
      }
    }
    return t;
  };

  const live = {
    radius: (id) => disp.get(id)?.r,
    anchor: (id) => disp.get(id)?.anchor ?? undefined,
    swirl: (id) => {
      const d = disp.get(id);
      if (!d || !d.swirl || !motion) return 0;
      return Math.PI * 2 * easeInOut(clamp01((nowS() - d.start) / d.dur));
    },
    time: bodyTime,
  };
  /** World position of a body right now (as of the last frame). @param {number} id */
  const posOf = (id) => bodies.get(id)?.pos.clone() ?? new THREE.Vector3();

  // ---- camera, selection and flight ----------------------------------------------------
  let selected = initialId;
  /**
   * @type {{ start: number, duration: number, from: THREE.Vector3, ids: number[], dist0: number, dist1: number,
   *   strength: Strength, chained: boolean } | null}
   */
  let flight = null;
  /** @type {{ start: number, dir: THREE.Vector3, amp: number } | null} */
  let overshoot = null;
  /** @type {{ start: number, dir: THREE.Vector3 } | null} */
  let nudge = null;
  let viewDist = 20;
  /** @type {(id: number, strength: Strength) => void} */
  let arrivalHook = () => {};

  /** How far back to sit to frame a body and its moons. @param {number} id */
  function frameDistance(id) {
    const b = model.bodies.get(id);
    if (!b) return 12;
    if (tree.nodes.get(id)?.isRoot) return Math.min(64, b.extent * 2.0 + 6);
    return Math.min(40, Math.max(8, b.extent * 3.6 + 4));
  }

  function placeCamera(id) {
    const target = posOf(id);
    viewDist = frameDistance(id);
    controls.target.copy(target);
    camera.position.copy(target).add(new THREE.Vector3(0, Math.sin(ELEVATION), Math.cos(ELEVATION)).multiplyScalar(viewDist));
    controls.update();
  }

  /** The live route from a world point along the hierarchy to `ids`' end. */
  function routePoints(from, ids) {
    return [from, ...ids.map((id) => posOf(id))];
  }

  /** A point along a route at fraction e, arcing a little above each hop. */
  function alongRoute(pts, e) {
    const lens = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = pts[i].distanceTo(pts[i - 1]);
      lens.push(l);
      total += l;
    }
    if (total < 1e-6) return pts.at(-1).clone();
    let d = e * total;
    for (let i = 0; i < lens.length; i++) {
      if (d <= lens[i] || i === lens.length - 1) {
        const s = lens[i] === 0 ? 1 : clamp01(d / lens[i]);
        const p = pts[i].clone().lerp(pts[i + 1], s);
        p.y += Math.sin(Math.PI * s) * lens[i] * 0.12;
        return p;
      }
      d -= lens[i];
    }
    return pts.at(-1).clone();
  }

  /**
   * Select a body. With motion, fly there from wherever the camera actually
   * is, along the hierarchy, and land on it as it moves.
   * @param {number} id @param {{ strength?: Strength }} [opts]
   */
  function select(id, { strength = "small" } = {}) {
    if (!bodies.has(id)) return;
    const from = selected;
    selected = id;
    for (const [bid, b] of bodies) b.el.classList.toggle("is-selected", bid === id);
    systemLag.set(id, systemLag.get(id) ?? 0);
    if (!motion || from === id) {
      flight = null;
      pulse.visible = false;
      viewDist = frameDistance(id);
      if (!motion) {
        const offset = camera.position.clone().sub(controls.target).setLength(viewDist);
        const target = posOf(id);
        controls.target.copy(target);
        camera.position.copy(target).add(offset);
        container.classList.remove("cut");
        void container.offsetWidth;
        container.classList.add("cut");
      }
      if (from !== id) arrive(id, strength);
      return;
    }
    // A key mid-flight starts the next flight from where the camera is, not
    // from the last destination, and keeps its momentum.
    const chained = flight !== null;
    const ids = pathBetween(tree, from, id).slice(1);
    const start = controls.target.clone();
    const pts = routePoints(start, ids);
    let length = 0;
    for (let i = 1; i < pts.length; i++) length += pts[i].distanceTo(pts[i - 1]);
    const base = Math.min(1.7, 0.42 + length * 0.03);
    flight = {
      start: nowS(),
      duration: chained ? Math.max(0.28, base * 0.6) : base,
      from: start,
      ids,
      dist0: camera.position.distanceTo(controls.target),
      dist1: frameDistance(id),
      strength,
      chained,
    };
    overshoot = null;
    pulse.visible = true;
  }

  /** The destination reacts: squash-and-pop, shockwave, burst. @param {number} id @param {Strength} strength */
  function arrive(id, strength) {
    arrivalHook(id, strength);
    const b = bodies.get(id);
    if (!b || !motion || strength === "none") return;
    const full = strength === "full";
    const node = tree.nodes.get(id);
    const size = disp.get(id)?.size ?? 0.3;
    const colour = node?.isRoot ? COLOURS.sun : node?.mine ? COLOURS.mine : COLOURS.mark;
    b.pop = { start: nowS(), amp: full ? 0.75 : 0.35 };
    shockwave(id, size, colour.clone().multiplyScalar(full ? 1.2 : 0.7), full ? 0.45 : 0.32);
    burst(b.pos, colour, full ? 46 : 16, full ? 4.2 : 2.2, full ? 0.48 : 0.32);
    if (full) b.flare = 1;
  }

  /** Feel the wall: the camera nudges toward the blocked direction and springs back. @param {string} dir */
  function bump(dir) {
    if (!motion) return;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const v =
      dir === "left" ? right.negate() : dir === "right" ? right : dir === "up" ? up : dir === "down" ? up.negate() : null;
    if (!v) return;
    nudge = { start: nowS(), dir: v.multiplyScalar(Math.max(0.25, viewDist * 0.035)) };
  }

  // Click/tap a body to fly there; again (or its preview's Open) to open it.
  function pick(id) {
    if (id === selected) onOpen(id);
    else onSelect(id);
  }
  function setHover(id) {
    if (id === hovered) return;
    hovered = id;
    renderer.domElement.style.cursor = id === null ? "" : "pointer";
    onHover(id);
  }

  // Raycast clicks on the canvas, ignoring drags (which orbit).
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let down = { x: 0, y: 0 };
  const hit = (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    // Bodies are small and moving; test against a generous proxy radius.
    let best = null;
    let bestDist = Infinity;
    for (const [id, b] of bodies) {
      if (!b.mesh.visible) continue;
      const centre = b.pos;
      const along = centre.clone().sub(raycaster.ray.origin).dot(raycaster.ray.direction);
      if (along <= 0) continue;
      const d = raycaster.ray.distanceSqToPoint(centre);
      const r = Math.max(b.mesh.scale.x * 1.6, along * 0.022);
      if (d < r * r && along < bestDist) {
        best = id;
        bestDist = along;
      }
    }
    return best;
  };
  renderer.domElement.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const id = hit(e);
    if (id !== null) pick(id);
  });
  let hoverFrame = 0;
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || e.buttons !== 0 || hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      setHover(hit(e));
    });
  });
  renderer.domElement.addEventListener("pointerleave", () => setHover(null));

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    // Pull back on narrow screens so a system still fits.
    camera.fov = w < 640 ? 66 : 52;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    labels.setSize(w, h);
  }
  new ResizeObserver(resize).observe(container);
  resize();

  // ---- the frame -------------------------------------------------------------------
  const tmp = new THREE.Vector3();
  const tilt = new THREE.Euler(0, 0, 0, "ZYX");
  let last = nowS();
  let placed = false;

  function updatePositions(t) {
    // Every body's world position this frame, parents before children.
    const done = new Set();
    const place = (id) => {
      if (done.has(id)) return;
      done.add(id);
      const b = bodies.get(id);
      const p = positionAt(model, id, t, live);
      if (b && p) b.pos.set(p.x, p.y, p.z);
    };
    for (const id of model.weeks) place(id);
    for (const id of model.bodies.keys()) place(id);
  }

  /** @param {number} id @param {import("./archive-tree.js").TreeNode} node @returns {"full" | "name" | "none"} */
  function labelLevel(id, node) {
    if (id === selected || id === hovered) return "full";
    if (node.isRoot) return "name";
    const sel = tree.nodes.get(selected);
    if (!sel) return "none";
    if (node.parentId === selected || id === sel.parentId) return "name";
    if (!sel.isRoot && node.parentId === sel.parentId) return "name";
    return "none";
  }

  function frame() {
    const ts = nowS();
    const dt = Math.min(0.1, ts - last);
    last = ts;

    // Sky clock: lag behind the shared clock while hovering or paused, then
    // catch back up (up to 4x speed) once released.
    if (motion) {
      const rate = paused ? 0 : hovered !== null ? 0.06 : 1;
      if (rate < 1) skyLag += dt * 1000 * (1 - rate);
      else if (skyLag > 0) skyLag = Math.max(0, skyLag - dt * 1000 * Math.min(3, 0.4 + skyLag / 1500));
      for (const [id, lag] of systemLag) {
        if (id === selected && !tree.nodes.get(id)?.isRoot) systemLag.set(id, lag + dt * 1000 * 0.65);
        else if (lag <= 0) systemLag.delete(id);
        else systemLag.set(id, Math.max(0, lag - dt * 1000 * Math.min(3, 0.4 + lag / 1500)));
      }
    }

    // Recompute the orbit model every ~30 s, so cooling threads drift out.
    if (motion && !timeTravel && performance.now() - modelAt > REFRESH_MS) rebuild(liveNow(), { dur: 6 });

    // Ease radii, anchors and growth toward the model.
    for (const [id, d] of disp) {
      if (d.dur > 0) {
        const u = clamp01((ts - d.start) / d.dur);
        d.r = d.rFrom + (d.rTo - d.rFrom) * easeInOut(u);
        if (u >= 1) {
          d.dur = 0;
          d.swirl = false;
          d.r = d.rTo;
        }
      }
      if (d.anchor && d.aFrom && d.aTo) {
        const u = motion ? clamp01((ts - d.aStart) / 2.2) : 1;
        d.anchor.copy(d.aFrom).lerp(d.aTo, easeInOut(u));
      }
      if (!motion) d.grow = d.growTarget;
      else if (ts - loadedAt > d.growDelay) {
        const speed = d.growTarget > d.grow ? 1.25 : 2.2;
        d.grow = d.growTarget > d.grow ? Math.min(d.growTarget, d.grow + dt * speed) : Math.max(d.growTarget, d.grow - dt * speed);
      }
    }
    updateArm();

    const t = skyTime();
    updatePositions(t);
    if (!placed) {
      placeCamera(selected);
      placed = true;
    }

    const breath = (phase) => (motion ? 1 + Math.sin(ts * 1.6 + phase) * 0.05 : 1);
    for (const [id, b] of bodies) {
      const d = disp.get(id);
      const node = tree.nodes.get(id);
      const body = model.bodies.get(id);
      if (!d || !node) {
        b.mesh.visible = b.halo.visible = b.rim.visible = b.label.visible = false;
        if (b.ring) b.ring.visible = false;
        if (b.crown) b.crown.visible = false;
        continue;
      }
      const isStar = node.isRoot;
      // Growth: the ring sweeps round first, then the body condenses on it.
      const ringT = isStar ? 1 : clamp01(d.grow / 0.6);
      const bodyT = isStar ? clamp01(d.grow / 0.6) : clamp01((d.grow - 0.5) / 0.5);
      const grownScale = bodyT === 0 ? 0 : bodyT < 1 && d.growTarget > 0 ? easeOutBack(bodyT) : bodyT;

      // Lit eases between ember and full colour, so lighting up is dawn.
      const target = isLit(id) ? 1 : 0;
      b.lit += (target - b.lit) * Math.min(1, dt * (target > b.lit ? 3.2 : 8));
      if (Math.abs(target - b.lit) < 0.002) b.lit = target;

      // Squash-and-pop on arrival.
      let sx = 1;
      let sy = 1;
      if (b.pop) {
        const tau = ts - b.pop.start;
        if (tau > 0.42) b.pop = null;
        else {
          const k = b.pop.amp * Math.sin(tau * 22) * Math.exp(-tau * 9);
          sy = 1 + k;
          sx = 1 - k * 0.45;
        }
      }
      b.flare = Math.max(0, b.flare - dt * 1.6);

      const weekIndex = Math.max(0, model.weeks.indexOf(body?.weekRoot ?? -1));
      let colour;
      let size = d.size;
      if (isStar) {
        colour = STAR_AGES[Math.min(STAR_AGES.length - 1, weekIndex)].clone();
      } else {
        const lit = node.mine ? COLOURS.mine : COLOURS.mark;
        colour = COLOURS.ember.clone().lerp(lit, b.lit);
        // Embers are small; frontier embers flicker faintly.
        size *= 0.62 + 0.38 * b.lit;
        if (frontier.has(id) && motion && b.lit < 0.5) colour.multiplyScalar(1 + 0.9 * Math.max(0, Math.sin(ts * 2.3 + id) ** 8));
        // Older weeks are dimmer.
        colour.multiplyScalar(1 - Math.min(0.45, weekIndex * 0.12));
      }
      colour.multiplyScalar(1 + b.flare * 0.8);
      /** @type {THREE.MeshBasicMaterial} */ (b.mesh.material).color.copy(colour);
      const s = size * grownScale * breath(id);
      b.mesh.scale.set(s * sx, s * sy, s * sx);
      b.mesh.position.copy(b.pos);
      b.mesh.visible = s > 1e-4;

      const haloMat = /** @type {THREE.SpriteMaterial} */ (b.halo.material);
      haloMat.color.copy(colour);
      const haloScale = isStar ? (weekIndex === 0 ? 7.5 : 5) : 3.2;
      haloMat.opacity = isStar ? (weekIndex === 0 ? 0.6 + Math.sin(ts * 0.7) * 0.05 * (motion ? 1 : 0) : 0.45) : 0.16 * b.lit;
      b.halo.scale.setScalar(s * haloScale * (1 + b.flare));
      b.halo.position.copy(b.pos);
      b.halo.visible = b.mesh.visible && haloMat.opacity > 0.01;

      const rimMat = /** @type {THREE.SpriteMaterial} */ (b.rim.material);
      rimMat.opacity = isStar ? 0 : 0.5 * (1 - b.lit);
      b.rim.scale.setScalar(s * 2.6);
      b.rim.position.copy(b.pos);
      b.rim.visible = b.mesh.visible && rimMat.opacity > 0.01;

      // The orbit ring is the parent pointer made visible.
      if (b.ring && body && node.parentId !== null) {
        const parent = bodies.get(node.parentId);
        b.ring.visible = ringT > 0 && Boolean(parent);
        if (parent) b.ring.position.copy(parent.pos);
        tilt.set(body.tiltX, 0, body.tiltZ, "ZYX");
        b.ring.rotation.copy(tilt);
        b.ring.scale.setScalar(Math.max(0.001, d.r));
        b.ring.geometry.setDrawRange(0, Math.max(2, Math.floor((RING_SEGMENTS + 1) * ringT)));
        const mat = /** @type {THREE.LineBasicMaterial} */ (b.ring.material);
        // Rings between lit bodies glow; rings around unexplored ones stay faint.
        const parentLit = isLit(node.parentId) ? 1 : 0.3;
        mat.color.copy(COLOURS.ringDim).lerp(COLOURS.ring, b.lit * parentLit);
        mat.opacity = (0.16 + 0.34 * b.lit * parentLit) * (1 - Math.min(0.5, weekIndex * 0.12)) * (id === selected ? 1.6 : 1);
      }
      if (b.crown) {
        const want = complete.has(id) ? 1 : 0;
        const mat = /** @type {THREE.MeshBasicMaterial} */ (b.crown.material);
        mat.opacity += (want * 0.85 - mat.opacity) * Math.min(1, dt * (want ? 2 : 0.8));
        b.crown.visible = mat.opacity > 0.01 && b.mesh.visible;
        b.crown.position.copy(b.pos);
        b.crown.scale.setScalar(s * 1.9 * (motion ? 1 + Math.sin(ts * 1.2) * 0.03 : 1));
      }

      // Labels fade with distance, and only once their body has condensed.
      // a star's label sits above it, clear of its inner planets
      if (isStar) b.label.position.set(b.pos.x, b.pos.y + s * 1.25 + 0.2, b.pos.z);
      else b.label.position.set(b.pos.x, b.pos.y - s - 0.12, b.pos.z);
      b.label.getWorldPosition(tmp);
      const dist = tmp.distanceTo(camera.position);
      // relative to how far back the camera is framing, so zooming out to a
      // whole system still labels its planets
      const far = Math.max(LABEL_FAR, viewDist * 1.9) * (isStar ? 1.8 : 1);
      const near = clamp01((far - dist) / (far * (1 - LABEL_NEAR / LABEL_FAR)));
      // Only what's around the selection is labelled, so a busy system stays
      // readable: full text for the selection (and whatever's hovered),
      // names for its parent, siblings and moons, and stars always.
      const rel = labelLevel(id, node);
      const opacity = rel === "none" ? 0 : id === selected ? bodyT : near * bodyT * (0.55 + 0.45 * b.lit);
      b.label.visible = opacity > 0.03;
      if (b.label.visible) {
        b.el.style.opacity = opacity.toFixed(2);
        b.el.classList.toggle("bubble-compact", rel === "name");
      }
    }

    // The selection ring faces the camera and slowly turns.
    const sel = bodies.get(selected);
    if (sel) {
      selRing.position.copy(sel.pos);
      selRing.quaternion.copy(camera.quaternion);
      selRing.scale.setScalar(Math.max(0.12, sel.mesh.scale.x) * 1.45 * (motion ? 1 + Math.sin(ts * 3) * 0.05 : 1));
      selRing.visible = sel.mesh.visible;
    }

    // Flight: along the hierarchy between live positions, pulse running ahead.
    const focus = posOf(selected);
    if (flight) {
      const u = clamp01((ts - flight.start) / flight.duration);
      const e = flight.chained ? easeOut(u) : easeInOut(u);
      const pts = routePoints(flight.from, flight.ids);
      const point = alongRoute(pts, e);
      const offset = camera.position.clone().sub(controls.target);
      offset.setLength(flight.dist0 + (flight.dist1 - flight.dist0) * e);
      controls.target.copy(point);
      camera.position.copy(point).add(offset);
      pulse.position.copy(alongRoute(pts, Math.min(1, e + 0.12 + (1 - e) * 0.1)));
      /** @type {THREE.SpriteMaterial} */ (pulse.material).opacity = 1 - u * u;
      if (u >= 1) {
        const dir = pts.at(-1).clone().sub(alongRoute(pts, 0.94));
        const strength = flight.strength;
        flight = null;
        pulse.visible = false;
        viewDist = frameDistance(selected);
        if (dir.lengthSq() > 1e-6 && strength !== "none") {
          overshoot = { start: ts, dir: dir.normalize(), amp: strength === "full" ? 0.55 : 0.28 };
        }
        arrive(selected, strength);
      }
    } else {
      // Ride along with the selected body as it orbits.
      const delta = focus.clone().sub(controls.target);
      const k = motion ? Math.min(1, dt * 6) : 1;
      if (delta.length() < 30 || !motion) {
        controls.target.addScaledVector(delta, k);
        camera.position.addScaledVector(delta, k);
      }
      // ease the framing distance
      const offset = camera.position.clone().sub(controls.target);
      if (motion && Math.abs(offset.length() - viewDist) > 0.05 && framing) {
        offset.setLength(offset.length() + (viewDist - offset.length()) * Math.min(1, dt * 3));
        camera.position.copy(controls.target).add(offset);
      }
    }
    // Arrival overshoot and the edge nudge are offsets that settle to zero.
    const extra = new THREE.Vector3();
    if (overshoot) {
      const tau = ts - overshoot.start;
      if (tau > 0.45) overshoot = null;
      else extra.addScaledVector(overshoot.dir, overshoot.amp * Math.sin(tau * 13) * Math.exp(-tau * 8));
    }
    if (nudge) {
      const tau = ts - nudge.start;
      if (tau > 0.28) nudge = null;
      else extra.addScaledVector(nudge.dir, Math.sin((tau / 0.28) * Math.PI) * (1 - tau / 0.28));
    }

    // Shockwaves and bursts.
    for (let i = shocks.length - 1; i >= 0; i--) {
      const s = shocks[i];
      const u = (ts - s.start) / s.dur;
      if (u >= 1) {
        world.remove(s.mesh);
        /** @type {THREE.Material} */ (s.mesh.material).dispose();
        shocks.splice(i, 1);
        continue;
      }
      s.mesh.position.copy(posOf(s.id));
      s.mesh.quaternion.copy(camera.quaternion);
      s.mesh.scale.setScalar(s.size * (1.3 + easeOut(u) * 5));
      /** @type {THREE.MeshBasicMaterial} */ (s.mesh.material).opacity = 0.9 * (1 - u);
    }
    for (let i = bursts.length - 1; i >= 0; i--) {
      const bst = bursts[i];
      const tau = ts - bst.start;
      const u = tau / bst.dur;
      if (u >= 1) {
        world.remove(bst.points);
        bst.points.geometry.dispose();
        /** @type {THREE.Material} */ (bst.points.material).dispose();
        bursts.splice(i, 1);
        continue;
      }
      const arr = /** @type {Float32Array} */ (bst.points.geometry.attributes.position.array);
      const travel = tau * (1 - u * 0.5);
      for (let j = 0; j < arr.length; j += 3) {
        arr[j] = bst.origin.x + bst.vel[j] * travel;
        arr[j + 1] = bst.origin.y + bst.vel[j + 1] * travel;
        arr[j + 2] = bst.origin.z + bst.vel[j + 2] * travel;
      }
      bst.points.geometry.attributes.position.needsUpdate = true;
      /** @type {THREE.PointsMaterial} */ (bst.points.material).opacity = 1 - u * u;
    }

    // Dust drifts along the arm into the past (backward while rewinding).
    arm.visible = Boolean(armCurve);
    if (armCurve) {
      const arr = /** @type {Float32Array} */ (armGeometry.attributes.position.array);
      const flow = motion ? (rewinding ? -0.0009 : 0.00035) : 0;
      // the stretch of arm into a completed week glows brighter
      const crowned = [...complete].map((id) => bodies.get(id)?.pos).filter(Boolean);
      const col = /** @type {Float32Array} */ (armGeometry.attributes.color.array);
      for (let i = 0; i < ARM_PARTICLES; i++) {
        armU[i] = (armU[i] + flow + 1) % 1;
        armCurve.getPointAt(armU[i], tmp);
        let boost = 0;
        for (const c of crowned) boost = Math.max(boost, Math.exp(-(tmp.distanceToSquared(c) / 60)));
        const k = 1 + boost * 2.2;
        col[i * 3] = COLOURS.arm.r * k;
        col[i * 3 + 1] = COLOURS.arm.g * k;
        col[i * 3 + 2] = COLOURS.arm.b * k;
        arr[i * 3] = tmp.x + armSpread[i * 3];
        arr[i * 3 + 1] = tmp.y + armSpread[i * 3 + 1] + (motion ? Math.sin(ts * 0.5 + i) * 0.15 : 0);
        arr[i * 3 + 2] = tmp.z + armSpread[i * 3 + 2];
      }
      armGeometry.attributes.position.needsUpdate = true;
      armGeometry.attributes.color.needsUpdate = true;
    }

    controls.target.add(extra);
    camera.position.add(extra);
    controls.update();
    composer.render();
    labels.render(scene, camera);
    controls.target.sub(extra);
    camera.position.sub(extra);
  }

  // Framing eases only right after a selection, so a user's own zoom sticks.
  let framing = true;
  controls.addEventListener("start", () => (framing = false));

  // Hooks for the later parts; plain state the frame reads.
  let timeTravel = false;
  let rewinding = false;
  /** @type {Set<number>} */
  let frontier = new Set();
  /** @type {Set<number>} */
  let complete = new Set();

  renderer.setAnimationLoop(frame);

  return {
    /** @param {number} id @param {{ strength?: Strength }} [opts] */
    select(id, opts) {
      framing = true;
      select(id, opts);
    },
    bump,
    /** Current orbit order, quietest first, for move(). */
    order: () => model.order,
    model: () => model,
    /** @param {boolean} on */
    setPaused(on) {
      paused = on;
    },
    /** @param {boolean} reduced */
    setReducedMotion(reduced) {
      motion = !reduced;
      if (reduced) {
        frozenAt = Date.now() - skyLag;
        flight = null;
        overshoot = nudge = null;
        pulse.visible = false;
      } else {
        skyLag = Date.now() - frozenAt;
      }
    },
    /**
     * Swap in a new tree (a live arrival, your reply, or a mark lit). `born`
     * is a new mark: its ring sweeps round, it condenses, and its whole
     * thread spirals inward.
     * @param {Tree} next @param {{ born?: number }} [opts]
     */
    setTree(next, { born } = {}) {
      tree = next;
      for (const id of tree.nodes.keys()) if (!bodies.has(id)) makeBody(id);
      const spiral = new Set();
      if (born !== undefined) for (let p = born; p !== null && p !== undefined; p = tree.nodes.get(p)?.parentId) spiral.add(p);
      if (!timeTravel) rebuild(liveNow(), { spiral: born === undefined ? undefined : spiral, dur: 1.5 });
      for (const id of tree.nodes.keys()) restyle(id);
      if (born !== undefined) {
        const d = disp.get(born);
        if (d) {
          d.grow = motion ? 0 : 1;
          d.growDelay = 0;
        }
      }
    },
    /** Swap in a tree with the same marks (one just lit): restyle only. @param {Tree} next */
    refresh(next) {
      tree = next;
      for (const id of tree.nodes.keys()) restyle(id);
    },
    /** Frontier embers flicker; complete weeks wear a crown. */
    setFog({ frontier: f, complete: c }) {
      frontier = f;
      complete = c;
    },
    /** A week fully lit: a bigger burst and a double shockwave from its star. @param {number} rootId */
    celebrate(rootId) {
      const b = bodies.get(rootId);
      if (!b || !motion) return;
      const size = disp.get(rootId)?.size ?? 1;
      shockwave(rootId, size, COLOURS.crown, 0.8);
      setTimeout(() => shockwave(rootId, size, COLOURS.crown, 0.9), 160);
      burst(b.pos, COLOURS.crown, 140, 9, 1.1);
      b.flare = 1;
    },
    /** @param {(id: number, strength: Strength) => void} fn called on every arrival */
    onArrive(fn) {
      arrivalHook = fn;
    },
    /** For checks: how many bodies the scene holds and whether it's mid-flight. */
    stats: () => ({
      nodes: bodies.size,
      bodies: [...disp.values()].filter((d) => d.growTarget > 0).length,
      flying: flight !== null,
      selected,
      cameraTarget: controls.target.toArray().map((x) => Number(x.toFixed(3))),
    }),
    /** For checks: where a body is on screen (pixels), or null. @param {number} id */
    screenOf(id) {
      const b = bodies.get(id);
      if (!b || !b.mesh.visible) return null;
      const p = b.pos.clone().project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
    },
    /** For checks: a body's world position at a given wall-clock time, from the model. @param {number} id @param {number} t */
    positionAt: (id, t) => positionAt(model, id, t),
  };
}
