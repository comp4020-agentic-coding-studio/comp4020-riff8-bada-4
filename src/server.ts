import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { marked } from "marked";
import { clearCookie, getCookie, getVisitorId, setCookie } from "./cookies.ts";
import {
  archiveList,
  crumbs,
  escapeHtml,
  formatTime,
  hasVisibleContent,
  MAX_BODY,
  MAX_NAME,
  page,
  postForm,
  replyCount,
  wall,
} from "./render.ts";
import { openStore, SYSTEM_NAME, type MarkWithCount, type Store, type WeekRow } from "./db.ts";
import { DEFAULT_NAME, Presence, who, type Stream } from "./presence.ts";
import { weekLabel } from "./week.ts";

const PORT = Number(process.env.PORT ?? 8080);
const MAX_REQUEST_BYTES = 8192;
const HEARTBEAT_MS = 20_000;
const SWEEP_MS = 500;

// Who's in the archive and what they've said at a mark: memory only, never
// SQLite (see src/presence.ts). LIVE_GRACE_MS overrides the 5s leave grace.
const live = new Presence({
  graceMs: process.env.LIVE_GRACE_MS ? Number(process.env.LIVE_GRACE_MS) : undefined,
  log: (line) => console.log(line),
});
setInterval(() => live.ping(), HEARTBEAT_MS).unref();
setInterval(() => live.sweep(), SWEEP_MS).unref();

// One SQLite file on the mounted volume: /data survives a restart or a
// redeploy, nothing else does (see fly.toml). DATA_DIR overrides it for a
// local run, where there's no volume. A request that rolls the week over
// tells every open stream.
const dataDir = process.env.DATA_DIR ?? "/data";
mkdirSync(dataDir, { recursive: true });
const store: Store = openStore(`${dataDir}/marks.sqlite`, { onNewWeek: broadcastWeek });

// three.js is served from node_modules under its version, and our client
// modules under a hash of their contents, so both can be cached for good and a
// deploy can never mix old and new modules in one page.
const THREE_VERSION = (JSON.parse(readFileSync("node_modules/three/package.json", "utf8")) as { version: string })
  .version;
const PUBLIC_HASH = (() => {
  const hash = createHash("sha256");
  for (const file of readdirSync("public").sort()) hash.update(file).update(readFileSync(join("public", file)));
  return hash.digest("hex").slice(0, 10);
})();
const STATIC = `/static/${PUBLIC_HASH}/`;
const IMMUTABLE = "public, max-age=31536000, immutable";
const STATIC_ROOTS: [prefix: string, dir: string][] = [
  [`/vendor/three@${THREE_VERSION}/addons/`, "node_modules/three/examples/jsm"],
  [`/vendor/three@${THREE_VERSION}/`, "node_modules/three/build"],
  [STATIC, "public"],
];
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

function notFound(res: ServerResponse): void {
  sendHtml(
    res,
    404,
    page("Not found", `<main><h1>Nothing here</h1><p>That mark doesn't exist. <a href="/">Back to this week</a>.</p></main>`),
  );
}

function sealedNotice(weekId: number | null): string {
  const week = weekId === null ? undefined : store.getWeek(weekId);
  const label = week ? weekLabel(week.week_start) : "This week";
  return `<p class="notice">${escapeHtml(label)} is archived. It sealed at 00:00 Monday, Sydney time, and nothing can be added to it now. <a href="/">Leave a mark on this week instead</a>.</p>`;
}

function homePage(visitorId: string, lastName: string, now: Date): string {
  const week = store.currentWeek(now);
  const marks = store.children(week.root_mark_id);
  return page(
    "Marks",
    `<header>
  <h1>Marks</h1>
  <p>${escapeHtml(weekLabel(week.week_start))}. Leave a short mark; at 00:00 Monday it's sealed into the <a href="/archive/">archive</a>, for good.</p>
</header>
<main>
${postForm("/", lastName, "Leave it", "Your mark")}
<h2 class="muted">This week</h2>
${wall(marks, visitorId, "No marks yet this week. Be the first.")}
</main>`,
    { nav: "home" },
  );
}

function markPage(mark: MarkWithCount, visitorId: string, lastName: string, now: Date): string {
  const archived = store.isArchived(mark, now);
  const kids = store.children(mark.id);
  const mine = mark.visitor_id === visitorId;
  let heading: string;
  let extra = "";
  if (mark.is_root) {
    heading = `<h1>${escapeHtml(mark.body)}</h1>`;
    const week = mark.week_id === null ? undefined : store.getWeek(mark.week_id);
    const older = week?.prev_week_id ? store.getWeek(week.prev_week_id) : undefined;
    const newer = store.weeks().find((w) => w.prev_week_id === week?.id);
    extra = `<nav class="week-nav" aria-label="Weeks">
  ${older ? `<a href="/m/${older.root_mark_id}">← ${escapeHtml(weekLabel(older.week_start))}</a>` : "<span></span>"}
  ${newer ? `<a href="/m/${newer.root_mark_id}">${escapeHtml(weekLabel(newer.week_start))} →</a>` : ""}
</nav>`;
  } else {
    heading = `<h1>A mark by ${escapeHtml(mark.name)}</h1>
<div class="mark focus-mark${mine ? " mine" : ""}">
  <p class="mark-body">${escapeHtml(mark.body)}</p>
  <p class="mark-meta"><time datetime="${escapeHtml(mark.created_at)}">${formatTime(mark.created_at)}</time>${
    mine ? ' <span class="badge">yours</span>' : ""
  } · ${replyCount(mark.child_count)}</p>
</div>`;
  }
  const title = mark.is_root ? `${mark.body} · Marks` : `${mark.name}: ${mark.body.slice(0, 40)} · Marks`;
  return page(
    title,
    `${crumbs(store.ancestors(mark))}
<main>
${heading}
${extra}
<p><a href="/archive/#m-${mark.id}">Find in archive</a></p>
${archived ? sealedNotice(mark.week_id) : postForm(`/m/${mark.id}`, lastName, "Reply", "Your reply")}
<h2 class="muted">${mark.is_root ? "Marks" : "Replies"}</h2>
${wall(kids, visitorId, archived ? "No replies, and now there never will be." : "No replies yet.")}
</main>`,
  );
}

function archivePage(visitorId: string, now: Date): string {
  const current = store.currentWeek(now);
  const byParent = new Map<number, MarkWithCount[]>();
  for (const m of store.allMarks()) {
    if (m.parent_id === null) continue;
    const list = byParent.get(m.parent_id) ?? [];
    list.push(m);
    byParent.set(m.parent_id, list);
  }
  const importMap = JSON.stringify({
    imports: {
      three: `/vendor/three@${THREE_VERSION}/three.module.js`,
      "three/addons/": `/vendor/three@${THREE_VERSION}/addons/`,
    },
  });
  return page(
    "Archive · Marks",
    `<main id="archive">
<h1>Archive</h1>
<p class="muted" id="archive-intro">Every week of marks, newest first. Each week seals at 00:00 Monday, Sydney time.</p>
<section id="list-view" aria-labelledby="list-heading">
<h2 id="list-heading">The whole tree</h2>
${archiveList(store.weeks(), byParent, current.id, visitorId, store.seenIds(visitorId))}
</section>
</main>`,
    {
      nav: "archive",
      bodyClass: "archive-page",
      head: `<link rel="stylesheet" href="${STATIC}archive.css">
<script type="importmap">${importMap}</script>
<script type="module" src="${STATIC}archive.js"></script>`,
    },
  );
}

// The whole tree in one response, presented as children arrays. A week root's
// parent is the next newer week's root and its leftmost child is the previous
// week's root; childCount counts only real replies. Never includes visitor_id:
// `mine` and `seen` are worked out here, per request.
function archiveJson(visitorId: string, now: Date): unknown {
  const current = store.currentWeek(now);
  const weeks = store.weeks();
  const newerRoot = new Map<number, number>();
  for (const w of weeks) {
    if (w.prev_week_id === null) continue;
    const prev = weeks.find((p) => p.id === w.prev_week_id);
    if (prev) newerRoot.set(prev.root_mark_id, w.root_mark_id);
  }
  const marks = store.allMarks();
  const seen = store.seenIds(visitorId);
  const children = new Map<number, number[]>();
  for (const w of weeks) {
    const prev = weeks.find((p) => p.id === w.prev_week_id);
    children.set(w.root_mark_id, prev ? [prev.root_mark_id] : []);
  }
  for (const m of marks) {
    if (m.parent_id === null) continue;
    const list = children.get(m.parent_id) ?? [];
    list.push(m.id);
    children.set(m.parent_id, list);
  }
  return {
    currentWeekId: current.id,
    weeks: weeks.map((w) => ({
      id: w.id,
      weekStart: w.week_start,
      label: weekLabel(w.week_start),
      rootMarkId: w.root_mark_id,
      prevWeekId: w.prev_week_id,
      archived: w.id !== current.id,
    })),
    marks: marks.map((m) => {
      const mine = !m.is_root && m.visitor_id === visitorId;
      return {
        id: m.id,
        parentId: m.is_root ? (newerRoot.get(m.id) ?? null) : m.parent_id,
        weekId: m.week_id,
        isRoot: m.is_root === 1,
        name: m.name,
        body: m.body,
        createdAt: m.created_at,
        childCount: m.child_count,
        children: children.get(m.id) ?? [],
        mine,
        seen: m.is_root === 1 || mine || seen.has(m.id),
      };
    }),
  };
}

// A POST the browser says came from another site is refused outright. A
// missing header (curl, an old browser) is let through: the cookie is
// SameSite=Lax, so a cross-site form post wouldn't carry it anyway.
function crossSite(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site !== undefined && site !== "same-origin";
}

// A small form body, or undefined if it's over the request size limit.
async function readForm(req: IncomingMessage): Promise<URLSearchParams | undefined> {
  try {
    return new URLSearchParams(await readBody(req));
  } catch {
    return undefined;
  }
}

function sendStatus(res: ServerResponse, status: number): void {
  res.writeHead(status, { "Cache-Control": "no-store" });
  res.end();
}

// A positive integer id from a form field, or undefined.
function formId(value: string | null): number | undefined {
  return value !== null && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
}

async function handleSeen(req: IncomingMessage, res: ServerResponse, visitorId: string, now: Date): Promise<void> {
  if (crossSite(req)) return sendStatus(res, 403);
  const form = await readForm(req);
  if (!form) return sendStatus(res, 413);
  const id = formId(form.get("id"));
  if (id === undefined) return sendStatus(res, 400);
  if (!store.getMark(id)) return sendStatus(res, 404);
  store.markSeen(visitorId, id, now);
  sendStatus(res, 204);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

// ---- Live: /live and its POSTs ---------------------------------------------

// A new mark, to every open stream: the public fields /archive.json sends,
// with `mine` and `seen` worked out per recipient. Only ever called after
// store.post succeeded.
function broadcastMark(id: number, authorVisitorId: string): void {
  const mark = store.getMark(id);
  const parent = mark?.parent_id == null ? undefined : store.getMark(mark.parent_id);
  if (!mark || !parent) return;
  live.broadcastEach((visitorId) => {
    const mine = visitorId === authorVisitorId;
    return {
      type: "mark",
      mark: {
        id: mark.id,
        parentId: parent.id,
        weekId: mark.week_id,
        isRoot: false,
        name: mark.name,
        body: mark.body,
        createdAt: mark.created_at,
        childCount: 0,
        children: [],
        mine,
        seen: mine,
      },
      parentChildCount: parent.child_count,
    };
  });
}

// The store's new-week hook: whoever's request crossed 00:00 Monday, every
// open archive hears about the new root. Lazy, like the rollover itself.
function broadcastWeek(week: WeekRow): void {
  const root = store.getMark(week.root_mark_id);
  if (!root) return;
  const prev = week.prev_week_id === null ? undefined : store.getWeek(week.prev_week_id);
  live.broadcast({
    type: "week",
    week: {
      id: week.id,
      weekStart: week.week_start,
      label: weekLabel(week.week_start),
      rootMarkId: week.root_mark_id,
      prevWeekId: week.prev_week_id,
      archived: false,
    },
    root: {
      id: root.id,
      parentId: null,
      weekId: week.id,
      isRoot: true,
      name: SYSTEM_NAME,
      body: root.body,
      createdAt: root.created_at,
      childCount: 0,
      children: prev ? [prev.root_mark_id] : [],
      mine: false,
      seen: true,
    },
  });
}

// The name others see: the one this visitor last posted under.
function liveName(req: IncomingMessage): string {
  const name = (getCookie(req, "name") ?? "").trim().slice(0, MAX_NAME);
  return hasVisibleContent(name) ? name : DEFAULT_NAME;
}

function liveHidden(req: IncomingMessage): boolean {
  return getCookie(req, "presence") === "hidden";
}

function handleLive(req: IncomingMessage, res: ServerResponse, url: URL, visitorId: string, now: Date): void {
  store.currentWeek(now);
  // hello is written during connect, before we know whether to answer 200,
  // so hold it until the headers are out.
  let pending: string[] | null = [];
  const stream: Stream = {
    visitorId,
    write: (chunk) => {
      if (pending) pending.push(chunk);
      else res.write(chunk);
    },
  };
  const result = live.connect(visitorId, liveName(req), liveHidden(req), url.searchParams.get("presence"), stream);
  if (result.status !== 200) {
    res.writeHead(result.status, { "Cache-Control": "no-store", "Retry-After": "10" });
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  res.write(pending.join(""));
  pending = null;
  res.on("close", () => live.disconnect(stream));
}

async function handleLivePost(
  req: IncomingMessage,
  res: ServerResponse,
  action: string,
  visitorId: string,
  now: Date,
): Promise<void> {
  if (crossSite(req)) return sendStatus(res, 403);
  const form = await readForm(req);
  if (!form) return sendStatus(res, 413);
  // Position posts are frequent, which makes them the lazy rollover's tick.
  store.currentWeek(now);

  if (action === "hide") {
    const hidden = form.get("hidden") === "1";
    if (hidden) setCookie(res, "presence", "hidden");
    else clearCookie(res, "presence");
    live.hide(visitorId, hidden);
    return sendStatus(res, 204);
  }

  const presenceId = form.get("presence") ?? "";
  if (!live.owns(visitorId, presenceId)) return sendStatus(res, 403);
  if (action === "wave") return sendStatus(res, live.wave(visitorId, presenceId));

  const markId = formId(form.get("mark"));
  if (markId === undefined) return sendStatus(res, 400);
  if (action === "move") {
    if (!store.getMark(markId)) return sendStatus(res, 404);
    const tt = form.get("tt") === "1";
    return sendStatus(res, live.move(visitorId, presenceId, markId, tt, liveName(req), liveHidden(req)));
  }
  // say
  return sendStatus(res, live.say(visitorId, presenceId, markId, form.get("text") ?? ""));
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  for (const [prefix, dir] of STATIC_ROOTS) {
    if (!pathname.startsWith(prefix)) continue;
    const base = resolve(dir);
    let rel: string;
    try {
      rel = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return false;
    }
    const file = resolve(base, normalize(rel));
    const type = CONTENT_TYPES[extname(file)];
    if (!file.startsWith(base + sep) || !type) return false;
    try {
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": type, "Cache-Control": IMMUTABLE });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  visitorId: string,
  parentId: number | null,
  now: Date,
): Promise<void> {
  // The archive's Reply here form asks for JSON; everything else gets the
  // form-post-and-redirect answers, unchanged.
  const json = (req.headers.accept ?? "").includes("application/json");
  const params = new URLSearchParams(await readBody(req));
  const name = (params.get("name") ?? "").trim().slice(0, MAX_NAME);
  const body = (params.get("body") ?? "").trim().slice(0, MAX_BODY);
  const back = parentId === null ? "/" : `/m/${parentId}`;
  if (!hasVisibleContent(name) || !hasVisibleContent(body)) {
    if (parentId !== null && !store.getMark(parentId)) {
      return json ? sendJson(res, 404, { error: "not-found" }) : notFound(res);
    }
    if (json) return sendJson(res, 400, { error: "blank" });
    res.writeHead(303, { Location: back });
    res.end();
    return;
  }
  const result = store.post(visitorId, name, body, parentId, now);
  if (!result.ok) {
    if (json) return sendJson(res, result.reason === "not-found" ? 404 : 403, { error: result.reason });
    if (result.reason === "not-found") return notFound(res);
    const parent = store.getMark(parentId ?? 0);
    sendHtml(
      res,
      403,
      page("Archived · Marks", `<main><h1>That week is sealed</h1>${sealedNotice(parent?.week_id ?? null)}</main>`),
    );
    return;
  }
  setCookie(res, "name", name);
  console.log(`post mark=${result.id} parent=${result.parentId} by=${who(visitorId)}`);
  broadcastMark(result.id, visitorId);
  if (json) return sendJson(res, 201, { id: result.id });
  const current = store.currentWeek(now);
  res.writeHead(303, { Location: result.parentId === current.root_mark_id ? "/" : back });
  res.end();
}

function markId(pathname: string): number | undefined {
  const match = pathname.match(/^\/m\/(\d{1,15})\/?$/);
  return match ? Number(match[1]) : undefined;
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const now = new Date();

      if ((req.method === "GET" || req.method === "HEAD") && (await serveStatic(url.pathname, res))) return;

      const visitorId = getVisitorId(req, res);
      const lastName = getCookie(req, "name") ?? "";

      if (url.pathname === "/") {
        if (req.method === "POST") return await handlePost(req, res, visitorId, null, now);
        if (req.method === "GET") return sendHtml(res, 200, homePage(visitorId, lastName, now));
      }

      if (url.pathname.startsWith("/m/")) {
        const id = markId(url.pathname);
        const mark = id === undefined ? undefined : store.getMark(id);
        if (req.method === "POST" && id !== undefined) return await handlePost(req, res, visitorId, id, now);
        if (req.method === "GET") {
          if (!mark) return notFound(res);
          if (mark.id === store.currentWeek(now).root_mark_id) {
            res.writeHead(302, { Location: "/" });
            res.end();
            return;
          }
          const html = markPage(mark, visitorId, lastName, now);
          if (!mark.is_root) store.markSeen(visitorId, mark.id, now);
          return sendHtml(res, 200, html);
        }
        return notFound(res);
      }

      if (req.method === "GET" && url.pathname === "/archive/") {
        return sendHtml(res, 200, archivePage(visitorId, now));
      }

      if (req.method === "POST" && url.pathname === "/seen") return await handleSeen(req, res, visitorId, now);

      if (req.method === "GET" && url.pathname === "/live") return handleLive(req, res, url, visitorId, now);
      const liveAction = url.pathname.match(/^\/live\/(move|say|wave|hide)$/)?.[1];
      if (req.method === "POST" && liveAction) return await handleLivePost(req, res, liveAction, visitorId, now);
      if (req.method === "GET" && url.pathname === "/archive") {
        res.writeHead(301, { Location: "/archive/" });
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/archive.json") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" });
        res.end(JSON.stringify(archiveJson(visitorId, now)));
        return;
      }

      if (req.method === "GET" && url.pathname === "/readme/") {
        const md = readFileSync("README.md", "utf8");
        const html = await marked.parse(md);
        return sendHtml(res, 200, page("About this app", `<main>${html}</main>`));
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("something went wrong");
    }
  })();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on :${PORT}`);
});

