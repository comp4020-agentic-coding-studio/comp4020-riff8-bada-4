// New marks on the home and mark pages, live. Progressive enhancement: with
// JS off these pages are exactly what the server sent. This listens on /live
// but never posts a position, so it never shows up as a person anywhere.
// User text only ever goes in through textContent.

const HIDDEN_CLOSE_MS = 60_000; // a forgotten background tab lets the machine sleep
const MAX_BACKOFF_MS = 60_000;

const timeFormat = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney",
  dateStyle: "medium",
  timeStyle: "short",
});

const replyCount = (n) => (n === 1 ? "1 reply" : `${n} replies`);

const main = document.querySelector("main[data-wall]");
if (main && "EventSource" in window) start(main, Number(main.dataset.wall));

function start(main, wallId) {
  let source = null;
  let hiddenTimer;
  let retryTimer;
  let backoff = 1000;

  function open() {
    clearTimeout(retryTimer);
    if (source) return;
    source = new EventSource("/live");
    source.onopen = () => {
      backoff = 1000;
    };
    source.onmessage = (e) => {
      let event;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      if (event.type === "mark") onMark(event);
    };
    // EventSource retries network errors itself; any other failure (a 503
    // while the machine restarts, the stream cap) closes it for good.
    source.onerror = () => {
      if (source?.readyState !== EventSource.CLOSED) return;
      source = null;
      retryTimer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    };
  }

  function close() {
    clearTimeout(retryTimer);
    source?.close();
    source = null;
  }

  document.addEventListener("visibilitychange", () => {
    clearTimeout(hiddenTimer);
    if (document.hidden) hiddenTimer = setTimeout(close, HIDDEN_CLOSE_MS);
    else open();
  });
  if (document.hidden) hiddenTimer = setTimeout(close, HIDDEN_CLOSE_MS);
  open();

  function onMark({ mark, parentChildCount }) {
    if (mark.parentId === wallId) {
      if (!main.querySelector(`li.mark a[href="/m/${mark.id}"]`)) insert(mark);
      const focus = main.querySelector(".focus-mark .reply-count");
      if (focus) focus.textContent = replyCount(parentChildCount);
    }
    for (const link of main.querySelectorAll(`ol.marks > li.mark a[href="/m/${mark.parentId}"]`)) {
      link.textContent = replyCount(parentChildCount);
    }
  }

  function insert(mark) {
    let list = main.querySelector("ol.marks");
    if (!list) {
      list = document.createElement("ol");
      list.className = "marks";
      const empty = main.querySelector(":scope > p.empty");
      if (empty) empty.replaceWith(list);
      else main.append(list);
    }
    highlightStyle();
    list.prepend(item(mark));
  }
}

// The same markup as markItem() in src/render.ts.
function item(mark) {
  const li = document.createElement("li");
  li.className = mark.mine ? "mark mine live-new" : "mark live-new";
  const body = document.createElement("p");
  body.className = "mark-body";
  body.textContent = mark.body;
  const meta = document.createElement("p");
  meta.className = "mark-meta";
  const time = document.createElement("time");
  time.dateTime = mark.createdAt;
  time.textContent = timeFormat.format(new Date(mark.createdAt));
  meta.append(`${mark.name} · `, time);
  if (mark.mine) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "yours";
    meta.append(" ", badge);
  }
  const replies = document.createElement("a");
  replies.href = `/m/${mark.id}`;
  replies.textContent = replyCount(mark.childCount);
  meta.append(" · ", replies);
  li.append(body, meta);
  return li;
}

let styled = false;
function highlightStyle() {
  if (styled) return;
  styled = true;
  const style = document.createElement("style");
  style.textContent = `@keyframes live-new { from { background: color-mix(in srgb, Highlight 30%, transparent); } }
.mark.live-new { animation: live-new 3s ease-out; }
@media (prefers-reduced-motion: reduce) { .mark.live-new { animation-timing-function: step-end; } }`;
  document.head.append(style);
}
