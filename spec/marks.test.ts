import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { afterEach, expect, inject, it } from "vitest";

// The tree of marks, checked against the RUNNING app (see
// spec/global-setup.ts), same as invariants.test.ts: post on this week's root,
// reply under any mark, and read the whole tree back from the archive.
const baseUrl = inject("baseUrl");

async function post(path: string, name: string, body: string, cookie?: string): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams({ name, body }).toString(),
    redirect: "manual",
  });
}

async function html(path: string): Promise<string> {
  const res = await fetch(new URL(path, baseUrl));
  expect(res.status).toBe(200);
  return res.text();
}

interface ArchiveMark {
  id: number;
  parentId: number | null;
  weekId: number;
  name: string;
  body: string;
  createdAt: string;
  childCount: number;
  children: number[];
  mine: boolean;
  seen: boolean;
  isRoot: boolean;
}

interface Archive {
  currentWeekId: number;
  weeks: { id: number; rootMarkId: number; weekStart: string; label: string }[];
  marks: ArchiveMark[];
}

async function archive(cookie?: string): Promise<Archive> {
  const res = await fetch(new URL("/archive.json", baseUrl), { headers: cookie ? { Cookie: cookie } : {} });
  expect(res.status).toBe(200);
  return (await res.json()) as Archive;
}

async function findMark(body: string): Promise<ArchiveMark> {
  const mark = (await archive()).marks.find((m) => m.body === body);
  expect(mark, `no mark with body ${body}`).toBeDefined();
  return mark!;
}

it("a mark posted on / shows up on /", async () => {
  const marker = `mark-${randomUUID()}`;
  const res = await post("/", "Test Visitor", marker);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  expect(await html("/")).toContain(marker);
});

it("a reply on /m/<id> shows up there and not on /", async () => {
  const parentBody = `parent-${randomUUID()}`;
  await post("/", "Parent", parentBody);
  const parent = await findMark(parentBody);

  const replyBody = `reply-${randomUUID()}`;
  const res = await post(`/m/${parent.id}`, "Replier", replyBody);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe(`/m/${parent.id}`);

  expect(await html(`/m/${parent.id}`)).toContain(replyBody);
  expect(await html("/")).not.toContain(replyBody);
});

it("reply counts are right, on the wall and in the archive", async () => {
  const parentBody = `counted-${randomUUID()}`;
  await post("/", "Counter", parentBody);
  const parent = await findMark(parentBody);
  for (let i = 0; i < 3; i++) await post(`/m/${parent.id}`, "R", `r${i}-${randomUUID()}`);

  expect((await findMark(parentBody)).childCount).toBe(3);
  const doc = new JSDOM(await html("/")).window.document;
  const link = doc.querySelector(`a[href="/m/${parent.id}"]`);
  expect(link?.textContent).toBe("3 replies");
});

it("the mark page shows a breadcrumb up to the week root and a Find in archive link", async () => {
  const parentBody = `crumb-${randomUUID()}`;
  await post("/", "Crumb", parentBody);
  const parent = await findMark(parentBody);
  const childBody = `crumb-child-${randomUUID()}`;
  await post(`/m/${parent.id}`, "Child", childBody);
  const child = await findMark(childBody);

  const doc = new JSDOM(await html(`/m/${child.id}`)).window.document;
  const crumbs = [...doc.querySelectorAll('nav[aria-label="Breadcrumb"] a')].map((a) => a.getAttribute("href"));
  expect(crumbs).toEqual([`/m/${parent.parentId}`, `/m/${parent.id}`]);
  expect(doc.querySelector(`a[href="/archive/#m-${child.id}"]`)).not.toBeNull();
  expect(doc.querySelector(`form[action="/m/${child.id}"]`)).not.toBeNull();
});

it("posting under a mark that doesn't exist stores nothing", async () => {
  const marker = `ghost-${randomUUID()}`;
  const res = await post("/m/999999999", "Ghost", marker);
  expect(res.status).toBe(404);
  expect((await archive()).marks.some((m) => m.body === marker)).toBe(false);
});

it("404s for unknown and malformed mark ids", async () => {
  expect((await fetch(new URL("/m/999999999", baseUrl))).status).toBe(404);
  expect((await fetch(new URL("/m/abc", baseUrl))).status).toBe(404);
  expect((await fetch(new URL("/m/1.5", baseUrl))).status).toBe(404);
});

it("every page carries a Home/Archive nav with the current one marked", async () => {
  const home = new JSDOM(await html("/")).window.document;
  expect(home.querySelector('nav a[href="/"][aria-current="page"]')).not.toBeNull();
  expect(home.querySelector('nav a[href="/archive/"]')?.hasAttribute("aria-current")).toBe(false);
  const arch = new JSDOM(await html("/archive/")).window.document;
  expect(arch.querySelector('nav a[href="/archive/"][aria-current="page"]')).not.toBeNull();
  expect(arch.querySelector('a[href="/readme/"]')).not.toBeNull();
});

it("/archive/ lists the current week as a nested list without any script", async () => {
  const parentBody = `nested-${randomUUID()}`;
  await post("/", "Nest", parentBody);
  const parent = await findMark(parentBody);
  const childBody = `nested-child-${randomUUID()}`;
  await post(`/m/${parent.id}`, "Nest", childBody);
  const child = await findMark(childBody);
  const { currentWeekId, weeks } = await archive();
  const current = weeks.find((w) => w.id === currentWeekId)!;

  // JSDOM doesn't run scripts by default: this is the page as JS-off sees it.
  const doc = new JSDOM(await html("/archive/")).window.document;
  const week = doc.getElementById(`m-${current.rootMarkId}`);
  expect(week?.tagName).toBe("DETAILS");
  expect(week?.hasAttribute("open")).toBe(true);
  expect(week?.querySelector("summary")?.textContent).toContain(current.label);
  const nested = doc.querySelector(`#m-${parent.id} > ul > #m-${child.id} > a`);
  expect(nested?.getAttribute("href")).toBe(`/m/${child.id}`);
});

it("/archive.json has the tree's shape and never exposes a visitor id", async () => {
  const visitor = randomUUID();
  const marker = `mine-${randomUUID()}`;
  await post("/", "Mine", marker, `visitor=${visitor}`);
  const res = await fetch(new URL("/archive.json", baseUrl), { headers: { Cookie: `visitor=${visitor}` } });
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  const raw = await res.text();
  expect(raw).not.toContain(visitor);
  expect(raw).not.toContain("visitor_id");
  const data = JSON.parse(raw) as Archive;
  expect(data.marks.find((m) => m.body === marker)?.mine).toBe(true);
  expect(data.weeks.length).toBeGreaterThan(0);
  const ids = new Set(data.marks.map((m) => m.id));
  for (const m of data.marks) {
    expect(Object.keys(m)).toEqual(
      expect.arrayContaining(["id", "parentId", "weekId", "name", "body", "createdAt", "childCount", "children"]),
    );
    for (const c of m.children) expect(ids.has(c)).toBe(true);
  }
  // The current week's root tops the tree; its leftmost child is last week's.
  const current = data.weeks.find((w) => w.id === data.currentWeekId)!;
  expect(data.marks.find((m) => m.id === current.rootMarkId)?.parentId).toBeNull();
});

it("rejects a mark with an empty body without storing it", async () => {
  const marker = `empty-${randomUUID()}`;
  await post("/", marker, "");
  expect(await html("/")).not.toContain(marker);
});

it("rejects a name made only of zero-width characters", async () => {
  const marker = `zwsp-${randomUUID()}`;
  await post("/", "\u200b\u200b\u200b", marker);
  expect(await html("/")).not.toContain(marker);
});

it("accepts a name that merely contains a zero-width character", async () => {
  const marker = `zwsp-ok-${randomUUID()}`;
  await post("/", "Jo\u200bhn", marker);
  expect(await html("/")).toContain(marker);
});

it("still serves pages when a cookie value is malformed percent-encoding", async () => {
  for (const path of ["/", "/archive/", "/archive.json"]) {
    const res = await fetch(new URL(path, baseUrl), { headers: { Cookie: "visitor=%" } });
    expect(res.status).toBe(200);
  }
});

it("issues a fresh visitor cookie per anonymous request", async () => {
  const a = await post("/", "A", `a-${randomUUID()}`);
  const b = await post("/", "B", `b-${randomUUID()}`);
  expect(a.headers.get("set-cookie")).toMatch(/^visitor=/);
  expect(b.headers.get("set-cookie")).toMatch(/^visitor=/);
  expect(a.headers.get("set-cookie")).not.toBe(b.headers.get("set-cookie"));
});

it("serves three.js and the client modules with JavaScript content types", async () => {
  const doc = new JSDOM(await html("/archive/")).window.document;
  const map = JSON.parse(doc.querySelector('script[type="importmap"]')!.textContent!) as {
    imports: Record<string, string>;
  };
  const app = doc.querySelector('script[type="module"]')!.getAttribute("src")!;
  for (const path of [map.imports.three, app]) {
    const res = await fetch(new URL(path, baseUrl));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/javascript/);
  }
  // an encoded slash survives URL parsing, so this really asks for ../
  expect((await fetch(new URL(app.replace("archive.js", "..%2fpackage.json"), baseUrl))).status).toBe(404);
});

// ---- Fog of war: per-visitor seen-state -------------------------------------

const visitorCookie = (): string => `visitor=${randomUUID()}`;

function form(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

it("every mark in /archive.json has a boolean seen, and still no visitor_id", async () => {
  const cookie = visitorCookie();
  const res = await fetch(new URL("/archive.json", baseUrl), { headers: { Cookie: cookie } });
  const raw = await res.text();
  expect(raw).not.toContain("visitor_id");
  expect(raw).not.toContain(cookie.slice("visitor=".length));
  for (const m of (JSON.parse(raw) as Archive).marks) expect(typeof m.seen).toBe("boolean");
});

it("roots and your own marks are seen with no visit; others' aren't", async () => {
  const author = visitorCookie();
  const marker = `own-${randomUUID()}`;
  await post("/", "Own", marker, author);
  const mine = (await archive(author)).marks;
  expect(mine.find((m) => m.body === marker)?.seen).toBe(true);
  for (const root of mine.filter((m) => m.isRoot)) expect(root.seen).toBe(true);
  expect((await archive(visitorCookie())).marks.find((m) => m.body === marker)?.seen).toBe(false);
});

it("GET /m/<id> marks it seen for that cookie only", async () => {
  const marker = `visit-${randomUUID()}`;
  await post("/", "Visited", marker);
  const { id } = await findMark(marker);
  const reader = visitorCookie();
  const res = await fetch(new URL(`/m/${id}`, baseUrl), { headers: { Cookie: reader } });
  expect(res.status).toBe(200);
  expect((await archive(reader)).marks.find((m) => m.id === id)?.seen).toBe(true);
  expect((await archive(visitorCookie())).marks.find((m) => m.id === id)?.seen).toBe(false);
});

it("POST /seen stores and answers 204; bad ids are 4xx; cross-site is 403", async () => {
  const marker = `seen-${randomUUID()}`;
  await post("/", "Seen", marker);
  const { id } = await findMark(marker);
  const reader = visitorCookie();

  const cross = await form("/seen", { id: String(id) }, { Cookie: reader, "Sec-Fetch-Site": "cross-site" });
  expect(cross.status).toBe(403);
  expect((await archive(reader)).marks.find((m) => m.id === id)?.seen).toBe(false);

  for (const bad of ["999999999", "abc", "-1", "1.5", ""]) {
    const res = await form("/seen", { id: bad }, { Cookie: reader });
    expect(res.status, `id=${bad}`).toBeGreaterThanOrEqual(400);
    expect(res.status, `id=${bad}`).toBeLessThan(500);
  }

  const ok = await form("/seen", { id: String(id) }, { Cookie: reader, "Sec-Fetch-Site": "same-origin" });
  expect(ok.status).toBe(204);
  expect((await archive(reader)).marks.find((m) => m.id === id)?.seen).toBe(true);
  // idempotent
  expect((await form("/seen", { id: String(id) }, { Cookie: reader })).status).toBe(204);
});

it("the no-JS archive list marks unseen marks new, and not seen ones", async () => {
  const unseenBody = `fog-${randomUUID()}`;
  const seenBody = `lit-${randomUUID()}`;
  await post("/", "Fog", unseenBody);
  await post("/", "Lit", seenBody);
  const unseen = await findMark(unseenBody);
  const seen = await findMark(seenBody);
  const reader = visitorCookie();
  await form("/seen", { id: String(seen.id) }, { Cookie: reader });

  const res = await fetch(new URL("/archive/", baseUrl), { headers: { Cookie: reader } });
  const doc = new JSDOM(await res.text()).window.document;
  expect(doc.querySelector(`#m-${unseen.id} > .new`)?.textContent).toBe("new");
  expect(doc.querySelector(`#m-${seen.id} > .new`)).toBeNull();
  // still readable: the link text is untouched
  expect(doc.querySelector(`#m-${unseen.id} > a`)?.textContent).toContain(unseenBody);
});

// ---- Live: /live, presence, chat and live marks -----------------------------

// The tests run with the production defaults (CI starts the image with only
// PORT set), so the leave test waits out the real ~5s grace.

type LiveEvent = { type: string; [key: string]: any };

interface LiveStream {
  presenceId: string;
  hello: LiveEvent;
  events: LiveEvent[];
  raw: () => string;
  of: (type: string) => LiveEvent[];
  waitFor: (pred: (e: LiveEvent) => boolean, ms?: number) => Promise<LiveEvent>;
  close: () => void;
}

const opened: LiveStream[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Opens /live with a cookie and reads its `data:` lines as JSON events, until
// closed. Every stream is closed after each test so the run never hangs.
async function openLive(cookie: string, query = ""): Promise<LiveStream> {
  const ctrl = new AbortController();
  const res = await fetch(new URL(`/live${query}`, baseUrl), { headers: { Cookie: cookie }, signal: ctrl.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
  const events: LiveEvent[] = [];
  let raw = "";
  let wake = () => {};
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const text = decoder.decode(chunk, { stream: true });
      raw += text;
      buffer += text;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as LiveEvent);
        }
      }
      wake();
    }
  })().catch(() => {});
  const waitFor = async (pred: (e: LiveEvent) => boolean, ms = 3000): Promise<LiveEvent> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = events.find(pred);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching event within ${ms}ms; got ${JSON.stringify(events)}`);
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, Math.min(left, 100));
      });
    }
  };
  const hello = await waitFor((e) => e.type === "hello");
  const stream: LiveStream = {
    presenceId: hello.presenceId as string,
    hello,
    events,
    raw: () => raw,
    of: (type) => events.filter((e) => e.type === type),
    waitFor,
    close: () => ctrl.abort(),
  };
  opened.push(stream);
  return stream;
}

function livePost(path: string, cookie: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return form(path, fields, { Cookie: cookie, ...headers });
}

const moveTo = (cookie: string, presence: string, mark: number, tt = false) =>
  livePost("/live/move", cookie, { presence, mark: String(mark), ...(tt ? { tt: "1" } : {}) });
const say = (cookie: string, presence: string, mark: number, text: string) =>
  livePost("/live/say", cookie, { presence, mark: String(mark), text });

// A fresh mark in the current week to stand at.
async function freshMark(label: string): Promise<number> {
  const body = `${label}-${randomUUID()}`;
  await post("/", "Spot", body);
  return (await findMark(body)).id;
}

const mentions = (s: LiveStream, presenceId: string) => s.raw().includes(presenceId);

it("GET /live is an event stream that says hello, and never leaks the cookie", async () => {
  const visitor = randomUUID();
  const res = await fetch(new URL("/live", baseUrl), { headers: { Cookie: `visitor=${visitor}` } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
  expect(res.headers.get("cache-control")).toBe("no-store");
  await res.body?.cancel();

  const a = await openLive(`visitor=${visitor}`);
  expect(a.hello).toMatchObject({ type: "hello", hidden: false });
  expect(a.presenceId).toMatch(/^p_/);
  expect(Array.isArray(a.hello.people)).toBe(true);
  // drive some traffic past it, then check nothing it was sent has the id
  const mark = await freshMark("leak");
  await moveTo(`visitor=${visitor}`, a.presenceId, mark);
  await post("/", "Leak", `leak-${randomUUID()}`, `visitor=${visitor}`);
  await a.waitFor((e) => e.type === "mark");
  expect(a.raw()).not.toContain(visitor);
});

it("a new mark reaches every stream, mine only for its author", async () => {
  const aCookie = visitorCookie();
  const bCookie = visitorCookie();
  const a = await openLive(aCookie);
  const b = await openLive(bCookie);
  const body = `live-${randomUUID()}`;
  expect((await post("/", "Bea", body, bCookie)).status).toBe(303);

  const forA = await a.waitFor((e) => e.type === "mark" && e.mark.body === body);
  const forB = await b.waitFor((e) => e.type === "mark" && e.mark.body === body);
  const stored = await findMark(body);
  const { currentWeekId, weeks } = await archive();
  const root = weeks.find((w) => w.id === currentWeekId)!.rootMarkId;
  expect(forA.mark).toEqual({
    id: stored.id,
    parentId: root,
    weekId: currentWeekId,
    isRoot: false,
    name: "Bea",
    body,
    createdAt: stored.createdAt,
    childCount: 0,
    children: [],
    mine: false,
    seen: false,
  });
  expect(forB.mark).toMatchObject({ id: stored.id, mine: true, seen: true });
  expect(forA.parentChildCount).toBe((await archive()).marks.find((m) => m.id === root)!.childCount);
  for (const s of [a, b]) {
    expect(s.raw()).not.toContain(aCookie.slice(8));
    expect(s.raw()).not.toContain(bCookie.slice(8));
  }

  // a reply carries its parent and the parent's new reply count
  const replyBody = `live-reply-${randomUUID()}`;
  await post(`/m/${stored.id}`, "Ana", replyBody, aCookie);
  const reply = await a.waitFor((e) => e.type === "mark" && e.mark.body === replyBody);
  expect(reply.mark).toMatchObject({ parentId: stored.id, mine: true });
  expect(reply.parentChildCount).toBe(1);
});

it("a rejected post broadcasts nothing", async () => {
  // A sealed week can't be reached over HTTP without faking the server's
  // clock; spec/store.test.ts covers sealing, and the broadcast only ever
  // follows a successful store.post.
  const a = await openLive(visitorCookie());
  const blankName = `rejected-${randomUUID()}`;
  const ghost = `rejected-${randomUUID()}`;
  await post("/", "  ", blankName);
  await post("/", "Ana", "\u200b");
  expect((await post("/m/999999999", "Ana", ghost)).status).toBe(404);
  const json = await fetch(new URL("/m/999999999", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ name: "Ana", body: ghost }).toString(),
  });
  expect(json.status).toBe(404);
  await sleep(300);
  expect(a.of("mark")).toEqual([]);
});

it("POST with Accept: application/json answers 201 {id}, or a JSON reason", async () => {
  const parent = await freshMark("json-parent");
  const postJson = (path: string, name: string, body: string) =>
    fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ name, body }).toString(),
      redirect: "manual",
    });

  const body = `json-${randomUUID()}`;
  const res = await postJson(`/m/${parent}`, "Jay", body);
  expect(res.status).toBe(201);
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  expect(res.headers.get("set-cookie")).toMatch(/name=Jay/);
  const { id } = (await res.json()) as { id: number };
  expect((await findMark(body)).id).toBe(id);
  expect((await findMark(body)).parentId).toBe(parent);

  const ghost = await postJson("/m/999999999", "Jay", `ghost-${randomUUID()}`);
  expect(ghost.status).toBe(404);
  expect(await ghost.json()).toEqual({ error: "not-found" });

  const blank = await postJson(`/m/${parent}`, "Jay", "   ");
  expect(blank.status).toBe(400);
  expect(await blank.json()).toEqual({ error: "blank" });

  const top = await postJson("/", "Jay", `json-top-${randomUUID()}`);
  expect(top.status).toBe(201);

  // without the header, nothing changes
  const plain = await post(`/m/${parent}`, "Jay", `plain-${randomUUID()}`);
  expect(plain.status).toBe(303);
  expect(plain.headers.get("location")).toBe(`/m/${parent}`);
});

it(
  "B moving gives A a join then a move; B's stream closing gives A a leave after the grace",
  async () => {
    const aCookie = visitorCookie();
    const bCookie = `${visitorCookie()}; name=Bea`;
    const a = await openLive(aCookie);
    const b = await openLive(bCookie);
    const silent = await openLive(visitorCookie());
    const [m1, m2] = [await freshMark("move-1"), await freshMark("move-2")];

    expect((await moveTo(bCookie, b.presenceId, m1)).status).toBe(204);
    const join = await a.waitFor((e) => e.type === "join" && e.person.id === b.presenceId);
    expect(join.person).toMatchObject({ id: b.presenceId, name: "Bea", markId: m1, timeTravelling: false });
    expect(join.person.colour).toMatch(/^#[0-9a-f]{6}$/);
    expect(typeof join.person.colourName).toBe("string");

    expect((await moveTo(bCookie, b.presenceId, m2, true)).status).toBe(204);
    const move = await a.waitFor((e) => e.type === "move" && e.person.id === b.presenceId);
    expect(move.person).toMatchObject({ markId: m2, timeTravelling: true });
    // a newcomer's hello includes B, and never the silent stream
    const c = await openLive(visitorCookie());
    expect(c.hello.people.map((p: { id: string }) => p.id)).toContain(b.presenceId);

    b.close();
    silent.close();
    // (earlier tests' people leave too, as their grace runs out)
    const leave = await a.waitFor((e) => e.type === "leave" && e.id === b.presenceId, 9000);
    expect(leave).toEqual({ type: "leave", id: b.presenceId });
    await sleep(500);
    // a stream that never posted a position never appears, joining or leaving
    for (const s of [a, c]) expect(mentions(s, silent.presenceId)).toBe(false);
    expect(a.of("leave").filter((e) => e.id === b.presenceId)).toHaveLength(1);
  },
  15_000,
);

it("a reconnect inside the grace gets the same presence id back, with no leave", async () => {
  const a = await openLive(visitorCookie());
  const bCookie = visitorCookie();
  const b = await openLive(bCookie);
  const mark = await freshMark("blip");
  await moveTo(bCookie, b.presenceId, mark);
  await a.waitFor((e) => e.type === "join");
  b.close();
  await sleep(200);
  const again = await openLive(bCookie, `?presence=${b.presenceId}`);
  expect(again.presenceId).toBe(b.presenceId);
  await moveTo(bCookie, again.presenceId, mark);
  await a.waitFor((e) => e.type === "move" && e.person.id === b.presenceId);
  const aboutB = a.events.filter((e) => JSON.stringify(e).includes(b.presenceId)).map((e) => e.type);
  expect(aboutB).toEqual(["join", "move"]);
});

it("a POST as someone else's presence is 403; an unknown mark is 4xx; neither broadcasts", async () => {
  const aCookie = visitorCookie();
  const bCookie = visitorCookie();
  const a = await openLive(aCookie);
  const b = await openLive(bCookie);
  const mark = await freshMark("owner");
  expect((await moveTo(aCookie, b.presenceId, mark)).status).toBe(403);
  expect((await say(aCookie, b.presenceId, mark, "impostor")).status).toBe(403);
  expect((await livePost("/live/wave", aCookie, { presence: b.presenceId })).status).toBe(403);
  expect((await moveTo(bCookie, b.presenceId, 999999999)).status).toBe(404);
  expect((await livePost("/live/move", bCookie, { presence: b.presenceId, mark: "abc" })).status).toBe(400);
  expect((await moveTo(bCookie, b.presenceId, mark)).status).toBe(204);
  // cross-site, even from the owner
  const cross = await livePost(
    "/live/move",
    bCookie,
    { presence: b.presenceId, mark: String(mark) },
    { "Sec-Fetch-Site": "cross-site" },
  );
  expect(cross.status).toBe(403);
  await sleep(300);
  // only B's one real move got through
  expect(a.events.filter((e) => JSON.stringify(e).includes(b.presenceId)).map((e) => e.type)).toEqual(["join"]);
  expect(a.raw()).not.toContain("impostor");
});

it("a hidden visitor never appears in anyone's events", async () => {
  const a = await openLive(visitorCookie());
  const hCookie = `${visitorCookie()}; presence=hidden`;
  const h = await openLive(hCookie);
  expect(h.hello.hidden).toBe(true);
  const mark = await freshMark("hidden");
  expect((await moveTo(hCookie, h.presenceId, mark)).status).toBe(204);
  expect((await livePost("/live/wave", hCookie, { presence: h.presenceId })).status).toBe(403);
  expect((await say(hCookie, h.presenceId, mark, "psst")).status).toBe(403);
  // but they still hear new marks
  const body = `heard-${randomUUID()}`;
  await post("/", "Ana", body);
  await h.waitFor((e) => e.type === "mark" && e.mark.body === body);
  h.close();
  await sleep(300);
  expect(mentions(a, h.presenceId)).toBe(false);
});

it("Hide me takes you out with a leave, and sets the presence cookie", async () => {
  const a = await openLive(visitorCookie());
  const bCookie = visitorCookie();
  const b = await openLive(bCookie);
  const mark = await freshMark("hide");
  await moveTo(bCookie, b.presenceId, mark);
  await a.waitFor((e) => e.type === "join");

  const hide = await livePost("/live/hide", bCookie, { hidden: "1" });
  expect(hide.status).toBe(204);
  expect(hide.headers.get("set-cookie")).toMatch(/^presence=hidden;/);
  await a.waitFor((e) => e.type === "leave" && e.id === b.presenceId);
  const hidden = `${bCookie}; presence=hidden`;
  await moveTo(hidden, b.presenceId, mark);

  const show = await livePost("/live/hide", hidden, { hidden: "0" });
  expect(show.headers.get("set-cookie")).toMatch(/^presence=;.*Max-Age=0/);
  await sleep(200);
  expect(a.of("join")).toHaveLength(1); // nothing until the next move
  await moveTo(bCookie, b.presenceId, mark);
  await a.waitFor((e) => e.type === "join" && a.of("join").length === 2);
  expect(
    (await livePost("/live/hide", bCookie, { hidden: "1" }, { "Sec-Fetch-Site": "cross-site" })).status,
  ).toBe(403);
});

it("say reaches the people at that mark and nobody else", async () => {
  const [aCookie, bCookie, cCookie] = [`${visitorCookie()}; name=Ana`, visitorCookie(), visitorCookie()];
  const [a, b, c] = [await openLive(aCookie), await openLive(bCookie), await openLive(cCookie)];
  const [here, there] = [await freshMark("room"), await freshMark("elsewhere")];

  await moveTo(aCookie, a.presenceId, here);
  expect((await say(aCookie, a.presenceId, here, "anyone?")).status).toBe(409); // alone
  await moveTo(bCookie, b.presenceId, here);
  await moveTo(cCookie, c.presenceId, there);
  expect((await say(aCookie, a.presenceId, there, "wrong room")).status).toBe(409);
  expect((await say(aCookie, a.presenceId, here, "   ")).status).toBe(400);
  expect((await say(aCookie, a.presenceId, here, "\u200b\u200b")).status).toBe(400);

  expect((await say(aCookie, a.presenceId, here, "hello, room")).status).toBe(204);
  const heard = await b.waitFor((e) => e.type === "say");
  expect(heard).toMatchObject({ markId: here, line: { id: a.presenceId, name: "Ana", text: "hello, room" } });
  expect(typeof heard.line.at).toBe("string");
  await a.waitFor((e) => e.type === "say");
  await sleep(200);
  expect(c.of("say")).toEqual([]);
  expect(c.raw()).not.toContain("hello, room");

  // over-long lines are cut, and a burst past the limit is refused
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await say(aCookie, a.presenceId, here, "x".repeat(300))).status);
  expect(statuses).toContain(429);
  expect((await b.waitFor((e) => e.type === "say" && e.line.text.startsWith("x"))).line.text).toHaveLength(200);
});

it("chat makes no marks, and once the room empties a newcomer gets no history", async () => {
  const [aCookie, bCookie, cCookie] = [visitorCookie(), visitorCookie(), visitorCookie()];
  const [a, b] = [await openLive(aCookie), await openLive(bCookie)];
  const [here, away] = [await freshMark("ephemeral"), await freshMark("away")];
  const before = (await archive()).marks.length;

  await moveTo(aCookie, a.presenceId, here);
  await moveTo(bCookie, b.presenceId, here);
  expect((await say(aCookie, a.presenceId, here, "this will vanish")).status).toBe(204);
  expect((await archive()).marks.length).toBe(before);

  // while someone's still there, a newcomer sees the context
  const c = await openLive(cCookie);
  await moveTo(cCookie, c.presenceId, here);
  const room = await c.waitFor((e) => e.type === "room");
  expect(room).toMatchObject({ markId: here, lines: [expect.objectContaining({ text: "this will vanish" })] });

  // everyone walks away: the room empties and its lines go
  for (const [cookie, s] of [[aCookie, a], [bCookie, b], [cCookie, c]] as const) {
    expect((await moveTo(cookie, s.presenceId, away)).status).toBe(204);
  }
  const dCookie = visitorCookie();
  const d = await openLive(dCookie);
  await moveTo(dCookie, d.presenceId, here);
  await moveTo(aCookie, a.presenceId, here);
  await sleep(300);
  expect(d.of("room")).toEqual([]);
  expect(a.of("room")).toEqual([]);
  expect(d.raw()).not.toContain("this will vanish");
});
