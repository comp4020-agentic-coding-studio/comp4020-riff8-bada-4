import { createHash, randomBytes } from "node:crypto";
import { hasVisibleContent } from "./render.ts";

// Who's in the archive right now, where they are, and what they've said at a
// mark. All of it lives in this process's memory and nowhere else: a restart
// wipes it, which is correct, and with one machine (--ha=false) memory is the
// whole truth. Nothing here touches SQLite, and nothing logs chat text.
//
// A stream (an open GET /live) isn't a person. Every stream gets a presence
// id, but it only becomes visible to others (`join`) on its first move. The
// presence id is random and public; the visitor id it maps to never leaves
// this module.

export interface Person {
  id: string;
  name: string;
  colour: string;
  colourName: string;
  markId: number | null;
  timeTravelling: boolean;
}

export interface Line {
  id: string; // the speaker's presence id
  name: string;
  colour: string;
  colourName: string;
  text: string;
  at: string;
}

// Whatever carries events to one open /live response.
export interface Stream {
  visitorId: string;
  write(chunk: string): void;
}

// Distinct from the tree's gold, teal and rose.
export const PALETTE: readonly { colour: string; name: string }[] = [
  { colour: "#b48cff", name: "violet" },
  { colour: "#a8e05f", name: "lime" },
  { colour: "#ff9f43", name: "orange" },
  { colour: "#5fb8ff", name: "sky" },
  { colour: "#ff6b6b", name: "coral" },
  { colour: "#4be0b0", name: "mint" },
  { colour: "#e07bff", name: "orchid" },
  { colour: "#d6dbe6", name: "silver" },
];

export const MAX_LINE = 200;
export const HISTORY_LINES = 20;
export const HISTORY_MS = 10 * 60_000;
export const DEFAULT_NAME = "Someone";

interface Limit {
  rate: number; // tokens per second
  burst: number;
}

export const LIMITS = {
  move: { rate: 10, burst: 15 },
  say: { rate: 1, burst: 3 },
  wave: { rate: 1 / 3, burst: 1 },
} satisfies Record<string, Limit>;

export interface PresenceOptions {
  now?: () => number;
  graceMs?: number;
  maxStreams?: number;
  maxPerVisitor?: number;
  log?: (line: string) => void;
}

interface Entry {
  id: string;
  visitorId: string;
  name: string;
  colour: string;
  colourName: string;
  markId: number | null;
  timeTravelling: boolean;
  hidden: boolean;
  joined: boolean;
  stream: Stream | null;
  leaveAt: number | null;
  needsRoom: boolean; // a fresh stream hasn't been sent its room's history yet
}

// A short, stable tag for a visitor in the logs: enough to follow one person
// through them, never the id itself.
export function who(visitorId: string): string {
  return createHash("sha256").update(visitorId).digest("hex").slice(0, 8);
}

export function newPresenceId(): string {
  return `p_${randomBytes(9).toString("base64url")}`;
}

export type ConnectResult = { status: 200; presenceId: string } | { status: 429 | 503 };

export class Presence {
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly maxStreams: number;
  private readonly maxPerVisitor: number;
  private readonly log: (line: string) => void;
  private readonly entries = new Map<string, Entry>();
  private readonly streams = new Map<Stream, Entry>();
  private readonly rooms = new Map<number, Line[]>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(opts: PresenceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.graceMs = opts.graceMs ?? 5000;
    this.maxStreams = opts.maxStreams ?? 60;
    this.maxPerVisitor = opts.maxPerVisitor ?? 4;
    this.log = opts.log ?? (() => {});
  }

  // Opens a stream and sends it `hello`. A visitor's presence still in its
  // leave grace (no live stream) is handed back rather than minted afresh:
  // the one they asked for, or failing that their only one.
  connect(visitorId: string, name: string, hidden: boolean, requested: string | null, stream: Stream): ConnectResult {
    if (this.streams.size >= this.maxStreams) return { status: 503 };
    let mine = 0;
    for (const s of this.streams.keys()) if (s.visitorId === visitorId) mine++;
    if (mine >= this.maxPerVisitor) return { status: 429 };

    const idle = [...this.entries.values()].filter((e) => e.visitorId === visitorId && e.stream === null);
    const asked = requested ? this.entries.get(requested) : undefined;
    let entry =
      asked && asked.visitorId === visitorId && asked.stream === null ? asked : idle.length === 1 ? idle[0] : undefined;
    if (!entry) {
      entry = {
        id: newPresenceId(),
        visitorId,
        name,
        colour: "",
        colourName: "",
        markId: null,
        timeTravelling: false,
        hidden,
        joined: false,
        stream: null,
        leaveAt: null,
        needsRoom: true,
      };
      this.entries.set(entry.id, entry);
    }
    entry.stream = stream;
    entry.leaveAt = null;
    entry.needsRoom = true;
    entry.name = name;
    this.setHidden(entry, hidden);
    this.streams.set(stream, entry);
    this.send(entry, {
      type: "hello",
      presenceId: entry.id,
      hidden: entry.hidden,
      people: this.visible().filter((e) => e !== entry).map(person),
    });
    return { status: 200, presenceId: entry.id };
  }

  // The stream closed. The person lingers for the grace period so a blip or a
  // deploy doesn't flicker them out and back in; sweep() forgets them after.
  disconnect(stream: Stream): void {
    const entry = this.streams.get(stream);
    if (!entry) return;
    this.streams.delete(stream);
    if (entry.stream === stream) {
      entry.stream = null;
      entry.leaveAt = this.now() + this.graceMs;
    }
  }

  // Forgets everyone whose grace has run out. Driven by a timer in the server
  // and directly by the tests.
  sweep(): void {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.leaveAt === null || entry.leaveAt > now) continue;
      this.entries.delete(entry.id);
      if (entry.joined && !entry.hidden) {
        this.broadcastExcept(entry, { type: "leave", id: entry.id });
        this.log(`live leave ${entry.id}`);
      }
      if (entry.markId !== null) this.dropIfEmpty(entry.markId);
    }
    for (const [key, bucket] of this.buckets) if (now - bucket.at > 60_000) this.buckets.delete(key);
  }

  // Does this visitor own this presence id? Presence ids are public, so this
  // is what stops anyone moving or speaking as someone else.
  owns(visitorId: string, presenceId: string): boolean {
    return this.entries.get(presenceId)?.visitorId === visitorId;
  }

  // The caller has already checked the mark exists. 204, 403 or 429.
  move(
    visitorId: string,
    presenceId: string,
    markId: number,
    timeTravelling: boolean,
    name: string,
    hidden: boolean,
  ): number {
    const entry = this.owned(visitorId, presenceId);
    if (!entry) return 403;
    if (!this.take(`move:${entry.id}`, LIMITS.move)) return 429;
    entry.name = name;
    this.setHidden(entry, hidden);
    const from = entry.markId;
    entry.markId = markId;
    entry.timeTravelling = timeTravelling;
    if (from !== null && from !== markId) this.dropIfEmpty(from);
    if (entry.hidden) return 204;

    if (!entry.joined) {
      entry.joined = true;
      if (!entry.colour) this.assignColour(entry);
      this.broadcastExcept(entry, { type: "join", person: person(entry) });
      this.log(`live join ${entry.id} by=${who(visitorId)}`);
    } else {
      this.broadcastExcept(entry, { type: "move", person: person(entry) });
    }
    if (from !== markId || entry.needsRoom) {
      entry.needsRoom = false;
      const lines = this.history(markId);
      if (lines.length > 0 && this.at(markId).some((e) => e !== entry)) {
        this.send(entry, { type: "room", markId, lines });
      }
    }
    return 204;
  }

  // 204, or 403 (not yours, hidden), 409 (not there, alone), 400 (blank), 429.
  say(visitorId: string, presenceId: string, markId: number, text: string): number {
    const entry = this.owned(visitorId, presenceId);
    if (!entry || entry.hidden) return 403;
    if (!entry.joined || entry.markId !== markId) return 409;
    const here = this.at(markId);
    if (!here.some((e) => e !== entry)) return 409;
    const trimmed = text.trim().slice(0, MAX_LINE);
    if (!hasVisibleContent(trimmed)) return 400;
    if (!this.take(`say:${visitorId}`, LIMITS.say)) return 429;
    const line: Line = {
      id: entry.id,
      name: entry.name,
      colour: entry.colour,
      colourName: entry.colourName,
      text: trimmed,
      at: new Date(this.now()).toISOString(),
    };
    const lines = this.rooms.get(markId) ?? [];
    lines.push(line);
    this.rooms.set(markId, lines);
    this.history(markId);
    for (const e of here) this.send(e, { type: "say", markId, line });
    this.log(`live say ${entry.id} mark=${markId}`);
    return 204;
  }

  // 204, or 403 (not yours, hidden), 409 (not at a mark yet), 429.
  wave(visitorId: string, presenceId: string): number {
    const entry = this.owned(visitorId, presenceId);
    if (!entry || entry.hidden) return 403;
    if (!entry.joined || entry.markId === null) return 409;
    if (!this.take(`wave:${visitorId}`, LIMITS.wave)) return 429;
    this.broadcastExcept(entry, { type: "wave", id: entry.id, markId: entry.markId });
    return 204;
  }

  // Hiding takes every presence of this visitor out of everyone's view at
  // once. Coming back broadcasts nothing until their next move.
  hide(visitorId: string, hidden: boolean): void {
    for (const entry of this.entries.values()) if (entry.visitorId === visitorId) this.setHidden(entry, hidden);
    this.log(`live ${hidden ? "hide" : "show"} by=${who(visitorId)}`);
  }

  // Sends one event to every open stream, hidden visitors included.
  broadcast(event: unknown): void {
    for (const entry of this.streams.values()) this.send(entry, event);
  }

  // Sends each stream its own version of an event, built from its visitor id
  // (which stays here: the builder only uses it to compare).
  broadcastEach(build: (visitorId: string) => unknown): void {
    for (const [stream, entry] of this.streams) this.send(entry, build(stream.visitorId));
  }

  // An SSE comment, so proxies see traffic on an otherwise quiet stream.
  ping(): void {
    for (const stream of this.streams.keys()) safeWrite(stream, ": ping\n\n");
  }

  people(): Person[] {
    return this.visible().map(person);
  }

  roomLines(markId: number): Line[] {
    return [...(this.rooms.get(markId) ?? [])];
  }

  get streamCount(): number {
    return this.streams.size;
  }

  private owned(visitorId: string, presenceId: string): Entry | undefined {
    const entry = this.entries.get(presenceId);
    return entry && entry.visitorId === visitorId ? entry : undefined;
  }

  private setHidden(entry: Entry, hidden: boolean): void {
    if (hidden && !entry.hidden && entry.joined) {
      entry.joined = false;
      this.broadcastExcept(entry, { type: "leave", id: entry.id });
      entry.hidden = true;
      if (entry.markId !== null) this.dropIfEmpty(entry.markId);
    }
    entry.hidden = hidden;
  }

  // Everyone others can see: joined, not hidden, not yet forgotten.
  private visible(): Entry[] {
    return [...this.entries.values()].filter((e) => e.joined && !e.hidden);
  }

  private at(markId: number): Entry[] {
    return this.visible().filter((e) => e.markId === markId);
  }

  // A room's lines, trimmed to the last HISTORY_LINES within HISTORY_MS.
  private history(markId: number): Line[] {
    const lines = this.rooms.get(markId);
    if (!lines) return [];
    const cutoff = this.now() - HISTORY_MS;
    const kept = lines.filter((l) => Date.parse(l.at) >= cutoff).slice(-HISTORY_LINES);
    if (kept.length === 0) this.rooms.delete(markId);
    else this.rooms.set(markId, kept);
    return [...kept];
  }

  // The moment a room empties, what was said there is gone.
  private dropIfEmpty(markId: number): void {
    if (this.at(markId).length === 0) this.rooms.delete(markId);
  }

  private assignColour(entry: Entry): void {
    const used = new Map<string, number>();
    for (const e of this.entries.values()) if (e.colour) used.set(e.colour, (used.get(e.colour) ?? 0) + 1);
    let best = PALETTE[0];
    for (const c of PALETTE) if ((used.get(c.colour) ?? 0) < (used.get(best.colour) ?? 0)) best = c;
    entry.colour = best.colour;
    entry.colourName = best.name;
  }

  private take(key: string, limit: Limit): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: limit.burst, at: now };
    bucket.tokens = Math.min(limit.burst, bucket.tokens + ((now - bucket.at) / 1000) * limit.rate);
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private broadcastExcept(except: Entry, event: unknown): void {
    for (const entry of this.streams.values()) if (entry !== except) this.send(entry, event);
  }

  private send(entry: Entry, event: unknown): void {
    if (entry.stream) safeWrite(entry.stream, `data: ${JSON.stringify(event)}\n\n`);
  }
}

function person(e: Entry): Person {
  return {
    id: e.id,
    name: e.name,
    colour: e.colour,
    colourName: e.colourName,
    markId: e.markId,
    timeTravelling: e.timeTravelling,
  };
}

function safeWrite(stream: Stream, chunk: string): void {
  try {
    stream.write(chunk);
  } catch {
    // a dying connection: its close handler will disconnect it
  }
}
