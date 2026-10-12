// Every sound the archive makes, synthesized with the Web Audio API: no audio
// files, no dependency. Off until the HUD's Sound toggle turns it on, and the
// AudioContext is only created then, inside that click.

/** @type {AudioContext | null} */
let ctx = null;
/** @type {GainNode | null} */
let master = null;
let on = false;

export function setSound(enabled) {
  on = enabled;
  if (!enabled || ctx) return;
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = 0.18;
  master.connect(ctx.destination);
}

export const soundOn = () => on;

/**
 * One soft enveloped note.
 * @param {number} freq @param {number} at seconds from now @param {number} dur
 * @param {{ type?: OscillatorType, gain?: number, to?: number }} [opts]
 */
function note(freq, at, dur, { type = "sine", gain = 0.5, to } = {}) {
  if (!on || !ctx || !master) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(env).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16];
const pitch = (step) => 440 * 2 ** ((PENTATONIC[step % PENTATONIC.length] + 12 * Math.floor(step / 8) - 9) / 12);

/** A soft tick on arrival, lower the deeper into the tree. @param {number} depth */
export function tick(depth) {
  note(pitch(Math.max(0, 6 - depth)) * 2, 0, 0.09, { type: "triangle", gain: 0.25 });
}

/** A brighter two-note chime when a mark lights for the first time. */
export function chime() {
  note(pitch(5) * 2, 0, 0.35, { gain: 0.35 });
  note(pitch(7) * 2, 0.08, 0.5, { gain: 0.3 });
}

/** A short rising arpeggio when a week is fully lit. */
export function arpeggio() {
  [0, 2, 4, 5, 7].forEach((s, i) => note(pitch(s) * 2, i * 0.07, 0.4, { type: "triangle", gain: 0.3 }));
}

/** A low muted thud on a move that goes nowhere. */
export function thud() {
  note(110, 0, 0.14, { gain: 0.5, to: 60 });
}

/** A new mark sprouting somewhere. */
export function sprout() {
  note(pitch(4) * 2, 0, 0.18, { type: "sine", gain: 0.18, to: pitch(6) * 2 });
}

/** Someone waving at you. */
export function wave() {
  note(pitch(6) * 2, 0, 0.3, { gain: 0.2 });
  note(pitch(4) * 2, 0.12, 0.4, { gain: 0.16 });
}

/** A tape-rewind swoop for a big backward scrub. */
export function rewind() {
  note(900, 0, 0.35, { type: "sawtooth", gain: 0.06, to: 160 });
}
