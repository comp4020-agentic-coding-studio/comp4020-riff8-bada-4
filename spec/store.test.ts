import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openStore, type Store } from "../src/db.ts";

// Archival can't be reached end to end without faking the server's clock, so
// this drives the DB layer directly with a scratch file and an injected `now`.
let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marks-"));
  store = openStore(join(dir, "marks.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const thisWeek = new Date("2026-10-07T01:00:00Z"); // Wed 7 Oct, Sydney
const nextWeek = new Date("2026-10-12T02:00:00Z"); // Mon 12 Oct, Sydney
const threeWeeksOn = new Date("2026-10-28T02:00:00Z");

it("rolls over lazily at 00:00 Monday and chains the new root to the old", () => {
  const a = store.currentWeek(thisWeek);
  expect(store.currentWeek(thisWeek).id).toBe(a.id);
  const b = store.currentWeek(nextWeek);
  expect(b.id).not.toBe(a.id);
  expect(b.prev_week_id).toBe(a.id);
  expect(store.getMark(b.root_mark_id)?.body).toBe("Week of 12 Oct 2026");
});

it("chains across weeks nobody visited without creating roots for them", () => {
  const a = store.currentWeek(thisWeek);
  const c = store.currentWeek(threeWeeksOn);
  expect(c.prev_week_id).toBe(a.id);
  expect(store.weeks()).toHaveLength(2);
});

it("seals a week: a post under an archived mark is rejected and stores nothing", () => {
  const posted = store.post("v", "Ana", "hello", null, thisWeek);
  expect(posted.ok).toBe(true);
  if (!posted.ok) return;
  const reply = store.post("v", "Bo", "a reply", posted.id, thisWeek);
  expect(reply.ok).toBe(true);

  const before = store.allMarks().length;
  expect(store.post("v", "Cy", "too late", posted.id, nextWeek)).toEqual({ ok: false, reason: "archived" });
  const oldRoot = store.getMark(posted.parentId)!;
  expect(store.post("v", "Cy", "too late", oldRoot.id, nextWeek)).toEqual({ ok: false, reason: "archived" });
  // the new root (created by the rejected requests) is the only new row
  expect(store.allMarks().length).toBe(before + 1);
  expect(store.isArchived(oldRoot, nextWeek)).toBe(true);

  // and posting to the home page lands under the new week instead
  const fresh = store.post("v", "Cy", "new week", null, nextWeek);
  expect(fresh.ok && fresh.parentId).toBe(store.currentWeek(nextWeek).root_mark_id);
});

it("rejects a post under a mark that doesn't exist", () => {
  expect(store.post("v", "Ana", "hi", 12345, thisWeek)).toEqual({ ok: false, reason: "not-found" });
});

it("fires the new-week hook once, after a request crosses 00:00 Monday Sydney", () => {
  const file = join(dir, "hooked.sqlite");
  const fired: { id: number; week_start: string; prev_week_id: number | null }[] = [];
  const hooked = openStore(file, { onNewWeek: (w) => fired.push(w) });
  try {
    // the very first request creates the first week's root: that's a new week too
    const a = hooked.currentWeek(thisWeek);
    expect(fired).toHaveLength(1);
    fired.length = 0;

    // plain requests within the week, including posts, never fire it
    hooked.currentWeek(thisWeek);
    hooked.post("v", "Ana", "hi", null, thisWeek);
    hooked.currentWeek(new Date("2026-10-11T12:59:59Z")); // Sun 23:59:59 Sydney (AEDT)
    expect(fired).toEqual([]);

    // the first request after Monday 00:00 Sydney creates the root, once
    const monday = new Date("2026-10-11T13:00:00Z"); // Mon 12 Oct 00:00 AEDT
    const b = hooked.currentWeek(monday);
    hooked.currentWeek(monday);
    hooked.post("v", "Bo", "first of the week", null, nextWeek);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ id: b.id, week_start: "2026-10-12", prev_week_id: a.id });
    // the hook ran after the commit: the root is already readable
    expect(hooked.getMark(b.root_mark_id)?.is_root).toBe(1);
  } finally {
    hooked.close();
  }
});

it("doesn't fire the new-week hook for the boot backfill", () => {
  store.close();
  const file = join(dir, "marks.sqlite");
  // a pre-tree mark with no parent, as the crit-8 table held them
  const raw = new DatabaseSync(file);
  raw.exec("delete from weeks; delete from marks;");
  raw
    .prepare("insert into marks (visitor_id, name, body, created_at, is_root) values (?, ?, ?, ?, 0)")
    .run("v", "Old", "pre-tree", "2026-09-01T00:00:00Z");
  raw.close();
  const fired: unknown[] = [];
  store = openStore(file, { onNewWeek: (w) => fired.push(w) });
  expect(store.weeks()).toHaveLength(1);
  expect(fired).toEqual([]);
});

it("records seen marks per visitor, idempotently", () => {
  const posted = store.post("author", "Ana", "hello", null, thisWeek);
  if (!posted.ok) throw new Error("post failed");
  store.markSeen("reader", posted.id, thisWeek);
  store.markSeen("reader", posted.id, nextWeek);
  expect([...store.seenIds("reader")]).toEqual([posted.id]);
  expect(store.seenIds("someone-else").size).toBe(0);
});

it("never lists a week's previous-week root among its children", () => {
  store.post("v", "Ana", "old", null, thisWeek);
  const b = store.currentWeek(nextWeek);
  expect(store.children(b.root_mark_id)).toEqual([]);
});
