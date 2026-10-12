// Being in the archive together, client side: the /live connection (with
// reconnects and the hidden-tab rule) and the pure bookkeeping of who's
// where. Rendering goes through the scene; what gets announced is archive.js.

const HIDDEN_CLOSE_MS = 60_000; // a forgotten background tab lets the machine sleep
const MAX_BACKOFF_MS = 30_000;

/**
 * @typedef {{ id: string, name: string, colour: string, colourName: string, markId: number | null,
 *   timeTravelling: boolean }} Person
 * @typedef {{ id: string, name: string, colour: string, colourName: string, text: string, at: string }} Line
 * @typedef {Map<string, Person>} People
 */

/**
 * Fold one /live event into who's here. Returns a new map when it changed.
 * @param {People} people @param {any} event @returns {People}
 */
export function applyPresence(people, event) {
  switch (event.type) {
    case "hello":
      return new Map((event.people ?? []).map((/** @type {Person} */ p) => [p.id, p]));
    case "join":
    case "move":
      return new Map(people).set(event.person.id, event.person);
    case "leave": {
      if (!people.has(event.id)) return people;
      const next = new Map(people);
      next.delete(event.id);
      return next;
    }
  }
  return people;
}

/** Everyone else at a mark. @param {People} people @param {number} markId */
export function peopleAt(people, markId) {
  return [...people.values()].filter((p) => p.markId === markId);
}

/**
 * Names as others see them: "Someone" twice becomes "Someone (amber)" and
 * "Someone (sky)". `self` (your own name) counts toward duplicates.
 * @param {Person[]} list @param {string} [self] @returns {Map<string, string>}
 */
export function displayNames(list, self) {
  const counts = new Map();
  for (const n of [...list.map((p) => p.name), ...(self === undefined ? [] : [self])]) counts.set(n, (counts.get(n) ?? 0) + 1);
  return new Map(list.map((p) => [p.id, counts.get(p.name) > 1 ? `${p.name} (${p.colourName})` : p.name]));
}

/**
 * Who arrived at and who left a mark between two snapshots, for the live
 * region: only changes at `markId` (yours) are worth announcing.
 * @param {People} before @param {People} after @param {number} markId
 */
export function roomChanges(before, after, markId) {
  const was = new Set(peopleAt(before, markId).map((p) => p.id));
  const now = new Set(peopleAt(after, markId).map((p) => p.id));
  return {
    arrived: [...now].filter((id) => !was.has(id)),
    left: [...was].filter((id) => !now.has(id)),
  };
}

/**
 * The /live connection. Reopens with backoff when the stream fails for good
 * (a 503 while the machine restarts), asks for the same presence id back,
 * closes after a minute hidden and reopens when the tab is visible.
 * @param {{ onEvent: (event: any) => void, onOpen?: () => void }} opts
 */
export function connectLive({ onEvent, onOpen }) {
  /** @type {EventSource | null} */
  let source = null;
  /** @type {string | null} */
  let presenceId = null;
  let backoff = 1000;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let hiddenTimer;

  function open() {
    clearTimeout(retryTimer);
    if (source) return;
    const url = presenceId ? `/live?presence=${encodeURIComponent(presenceId)}` : "/live";
    source = new EventSource(url);
    source.onmessage = (e) => {
      let event;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      if (event.type === "hello") {
        presenceId = event.presenceId;
        backoff = 1000;
      }
      onEvent(event);
      if (event.type === "hello") onOpen?.();
    };
    // EventSource retries network errors itself; anything else closes it.
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

  /**
   * A same-origin form POST to /live/<action> carrying the presence id.
   * @param {string} action @param {Record<string, string>} fields @returns {Promise<number>} status
   */
  async function post(action, fields = {}) {
    if (!presenceId && action !== "hide") return 0;
    try {
      const res = await fetch(`/live/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ presence: presenceId ?? "", ...fields }),
      });
      return res.status;
    } catch {
      return 0;
    }
  }

  open();
  return {
    post,
    presenceId: () => presenceId,
    connected: () => source !== null && source.readyState === EventSource.OPEN,
  };
}
