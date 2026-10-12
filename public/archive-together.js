// Together in the archive: everyone else here as wisps, the Here now panel,
// waves, following, Hide me, chat at a mark, and new marks and weeks arriving
// live. The connection and the pure bookkeeping are archive-presence.js;
// drawing goes through the scene. User text only ever goes in via textContent.
import { applyPresence, connectLive, displayNames, peopleAt, roomChanges } from "./archive-presence.js";
import * as sound from "./archive-sound.js";

/** @typedef {import("./archive-presence.js").Person} Person */
/** @typedef {import("./archive-presence.js").Line} Line */

const MAX_CHAT = 200;
const MOVE_EVERY_MS = 150; // stays under the server's ~10 moves/s

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
 *   switches: HTMLElement,
 *   stage: HTMLElement,
 *   tree: () => import("./archive-tree.js").Tree,
 *   selected: () => number,
 *   select: (id: number) => void,
 *   announce: (text: string) => void,
 *   addMark: (mark: any, parentChildCount: number) => void,
 *   addWeek: (week: any, root: any) => void,
 *   timeTravelling: () => boolean,
 *   ownName: () => string,
 * }} app
 */
export function startTogether(app) {
  /** @type {Map<string, Person>} */
  let people = new Map();
  let hidden = false;
  /** @type {string | null} */
  let following = null;
  /** @type {Set<string>} muted presence ids, for this session */
  const muted = new Set();
  /** @type {Line[]} */
  let lines = [];
  let chatMark = /** @type {number | null} */ (null);
  /** @type {number | null} a mark you just posted, to fly to once it arrives */
  let pendingOwn = null;

  // ---- HUD: Hide me, Here now, chat, a second live region ---------------------------
  const hideBtn = el("button", { type: "button", class: "switch", "aria-pressed": "false" }, "Hide me");
  app.switches.append(hideBtn);

  const here = el("section", { class: "here", "aria-labelledby": "here-heading" });
  const hereHeading = el("h2", { id: "here-heading" }, "Here now");
  const hereList = el("ul");
  const hereEmpty = el("p", { class: "here-empty" }, "Nobody else is in the archive right now.");
  here.append(hereHeading, hereEmpty, hereList);

  const chat = el("section", { class: "chat", "aria-labelledby": "chat-heading" });
  chat.hidden = true;
  const chatHeading = el("h2", { id: "chat-heading" });
  const chatLog = el("ol", { class: "chat-log" });
  const chatForm = el("form", { class: "chat-form" });
  const chatLabel = el("label", { for: "chat-input" }, "Say something here");
  const chatInput = /** @type {HTMLInputElement} */ (
    el("input", { id: "chat-input", type: "text", maxlength: String(MAX_CHAT), autocomplete: "off" })
  );
  const chatNote = el("p", { class: "chat-note" }, "Chat disappears when everyone leaves. Leave a mark to keep something.");
  const chatMutes = el("p", { class: "chat-mutes" });
  chatForm.append(chatLabel, chatInput);
  chat.append(chatHeading, chatMutes, chatLog, chatForm, chatNote);

  const chatAnnounce = el("p", { class: "sr-only", "aria-live": "polite" });
  app.hud.append(here, chat);
  app.hud.after(chatAnnounce);

  const names = () => displayNames([...people.values()], app.ownName() || "Someone");
  const nameOf = (/** @type {string} */ id) => names().get(id) ?? people.get(id)?.name ?? "Someone";
  const tree = () => app.tree();

  /** "Week of 12 Oct, on Ana's mark" @param {number | null} markId */
  function whereLabel(markId) {
    const n = markId === null ? undefined : tree().nodes.get(markId);
    if (!n) return "somewhere in the archive";
    if (n.isRoot) return `at ${n.body}`;
    return `${n.label}, on ${n.name}'s mark`;
  }

  function renderHere() {
    const list = [...people.values()];
    hereList.replaceChildren();
    hereEmpty.hidden = list.length > 0;
    here.classList.toggle("is-empty", list.length === 0);
    const nm = names();
    for (const p of list) {
      const li = el("li");
      li.style.setProperty("--wisp", p.colour);
      const who = el("span", { class: "here-who" }, `${p.timeTravelling ? "⏱ " : ""}${nm.get(p.id) ?? p.name}`);
      const where = el("span", { class: "here-where" }, whereLabel(p.markId));
      const fly = el("button", { type: "button" }, "Fly to");
      fly.setAttribute("aria-label", `Fly to ${nm.get(p.id) ?? p.name}`);
      fly.addEventListener("click", () => flyTo(p.id));
      const follow = el("button", { type: "button", "aria-pressed": String(following === p.id) }, following === p.id ? "Following" : "Follow");
      follow.setAttribute("aria-label", `Follow ${nm.get(p.id) ?? p.name}`);
      follow.addEventListener("click", () => setFollow(following === p.id ? null : p.id));
      li.append(who, where, fly, follow);
      hereList.append(li);
    }
  }

  /** @param {string} id */
  function flyTo(id) {
    const p = people.get(id);
    if (!p || p.markId === null) return;
    if (tree().nodes.has(p.markId)) app.select(p.markId);
  }

  /** @param {string | null} id */
  function setFollow(id) {
    following = id;
    if (id) {
      app.announce(`Following ${nameOf(id)}. Press any movement key to stop.`);
      flyTo(id);
    }
    renderHere();
  }

  let nextPerson = 0;
  /** P: fly to the next person in turn. */
  function next() {
    const list = [...people.values()].filter((p) => p.markId !== null);
    if (list.length === 0) {
      app.announce("Nobody else is in the archive right now.");
      return;
    }
    const p = list[nextPerson++ % list.length];
    app.announce(`Flying to ${nameOf(p.id)}, ${whereLabel(p.markId)}.`);
    flyTo(p.id);
  }

  // ---- chat --------------------------------------------------------------------------
  function renderChat() {
    const mine = app.selected();
    const others = peopleAt(people, mine);
    const open = !hidden && others.length > 0;
    if (chatMark !== mine) {
      // a different room: its history comes from the server's `room`
      lines = [];
      chatMark = mine;
    }
    if (!open) {
      if (!chat.hidden && chat.contains(document.activeElement)) app.stage.focus();
      chat.hidden = true;
      return;
    }
    chat.hidden = false;
    const nm = names();
    chatHeading.textContent = `Here with ${others.map((p) => nm.get(p.id) ?? p.name).join(", ")}`;
    chatMutes.replaceChildren();
    for (const p of others) {
      const b = el("button", { type: "button", class: "mute", "aria-pressed": String(muted.has(p.id)) }, `${muted.has(p.id) ? "Unmute" : "Mute"} ${nm.get(p.id) ?? p.name}`);
      b.addEventListener("click", () => {
        if (muted.has(p.id)) muted.delete(p.id);
        else muted.add(p.id);
        renderChat();
      });
      chatMutes.append(b);
    }
    chatLog.replaceChildren();
    for (const line of lines) {
      if (muted.has(line.id)) continue;
      const li = el("li");
      li.style.setProperty("--wisp", line.colour);
      const who = el("span", { class: "chat-who" }, line.id === live.presenceId() ? "You" : nm.get(line.id) ?? line.name);
      li.append(who, document.createTextNode(` ${line.text}`));
      chatLog.append(li);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    const status = await live.post("say", { mark: String(app.selected()), text });
    if (status === 204) chatInput.value = "";
    else if (status === 429) app.announce("Slow down a little: one message a second.");
    else if (status === 400) app.announce("That message is blank.");
    else app.announce("Couldn't send that: there's nobody else here now.");
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      app.stage.focus();
    }
  });

  /** Bumping into someone: their wisp flares, a soft chime, the chat panel glows. @param {string[]} ids */
  function bump(ids) {
    if (hidden || ids.length === 0) return;
    for (const id of ids) app.scene.flareWisp(id);
    sound.wave();
    chat.classList.remove("met");
    void chat.offsetWidth;
    chat.classList.add("met");
  }

  // ---- events ------------------------------------------------------------------------
  /** @param {any} event */
  function onEvent(event) {
    const before = people;
    const mine = app.selected();
    switch (event.type) {
      case "hello":
        hidden = Boolean(event.hidden);
        hideBtn.setAttribute("aria-pressed", String(hidden));
        people = applyPresence(people, event);
        break;
      case "join":
        people = applyPresence(people, event);
        app.announce(`${nameOf(event.person.id)} came into the archive.`);
        break;
      case "move":
        people = applyPresence(people, event);
        if (following === event.person.id && event.person.markId !== null && tree().nodes.has(event.person.markId)) {
          app.select(event.person.markId);
        }
        break;
      case "leave": {
        const name = nameOf(event.id);
        people = applyPresence(people, event);
        if (following === event.id) following = null;
        if (before.has(event.id)) app.announce(`${name} left the archive.`);
        break;
      }
      case "wave": {
        const p = people.get(event.id);
        if (p) {
          app.scene.wave(event.markId, p.colour);
          sound.wave();
          if (event.markId === mine) app.announce(`${nameOf(p.id)} waved at you.`);
        }
        return;
      }
      case "room":
        if (event.markId === mine) {
          lines = event.lines;
          chatMark = mine;
          renderChat();
        }
        return;
      case "say": {
        if (event.markId !== mine) return;
        lines = [...lines, event.line].slice(-20);
        const own = event.line.id === live.presenceId();
        if (!muted.has(event.line.id)) {
          app.scene.speak(own ? null : event.line.id, event.line.text);
          if (!own) {
            chatAnnounce.textContent = "";
            requestAnimationFrame(() => (chatAnnounce.textContent = `${nameOf(event.line.id)}: ${event.line.text}`));
          }
        }
        renderChat();
        return;
      }
      case "mark": {
        const m = event.mark;
        const author = [...people.values()].find((p) => p.markId === m.parentId && p.name === m.name);
        if (author) app.scene.flareWisp(author.id);
        if (!m.mine) sound.sprout();
        app.addMark(m, event.parentChildCount);
        if (pendingOwn === m.id) {
          pendingOwn = null;
          app.select(m.id);
        }
        renderHere();
        return;
      }
      case "week":
        app.addWeek(event.week, event.root);
        return;
      default:
        return;
    }
    // presence changed: tell the scene, announce comings and goings at your mark
    if (event.type !== "hello") {
      const { arrived, left } = roomChanges(before, people, mine);
      for (const id of arrived) {
        app.announce(`${nameOf(id)} is here with you.`);
        bump([id]);
      }
      for (const id of left) if (people.has(id)) app.announce(`${nameOf(id)} moved on.`);
    }
    app.scene.setPeople(people, names());
    renderHere();
    renderChat();
  }

  const live = connectLive({
    onEvent,
    // every (re)connect: say where you are again
    onOpen: () => {
      lastSent = null;
      sendMove();
    },
  });

  // ---- your position -----------------------------------------------------------------
  /** @type {string | null} */
  let lastSent = null;
  let moveTimer = 0;
  let lastMoveAt = 0;
  function sendMove() {
    const wait = MOVE_EVERY_MS - (performance.now() - lastMoveAt);
    if (wait > 0) {
      clearTimeout(moveTimer);
      moveTimer = window.setTimeout(sendMove, wait);
      return;
    }
    const key = `${app.selected()}:${app.timeTravelling() ? 1 : 0}`;
    if (key === lastSent) return;
    lastSent = key;
    lastMoveAt = performance.now();
    void live.post("move", { mark: String(app.selected()), tt: app.timeTravelling() ? "1" : "0" });
  }

  hideBtn.addEventListener("click", async () => {
    const want = !hidden;
    const status = await live.post("hide", { hidden: want ? "1" : "0" });
    if (status !== 204) return;
    hidden = want;
    hideBtn.setAttribute("aria-pressed", String(hidden));
    app.announce(hidden ? "Hidden: nobody can see you, and you can't chat." : "Visible again.");
    if (!hidden) {
      lastSent = null;
      sendMove();
    }
    renderChat();
  });

  renderHere();
  let lastAt = app.selected();

  return {
    /** Your selection changed (by any means). */
    moved() {
      const at = app.selected();
      if (at !== lastAt) {
        lastAt = at;
        bump(peopleAt(people, at).map((p) => p.id));
      }
      sendMove();
      renderChat();
      renderHere();
    },
    /** A movement key: stop following. */
    userMoved() {
      if (following) {
        following = null;
        app.announce("Stopped following.");
        renderHere();
      }
    },
    wave() {
      if (hidden) {
        app.announce("You're hidden, so nobody would see a wave.");
        return;
      }
      void live.post("wave").then((status) => {
        if (status === 204) {
          app.scene.wave(app.selected(), "#ffffff");
          app.announce("You waved.");
        } else if (status === 429) app.announce("You just waved. Give it a few seconds.");
      });
    },
    next,
    /** A mark you just posted: fly to it once its live event lands. @param {number} id */
    expectOwn(id) {
      if (tree().nodes.has(id)) app.select(id);
      else pendingOwn = id;
    },
    people: () => people,
    /** @param {(id: number) => number} fn where a wisp shows for a mark (time travel) */
    refresh() {
      app.scene.setPeople(people, names());
      renderHere();
    },
  };
}
