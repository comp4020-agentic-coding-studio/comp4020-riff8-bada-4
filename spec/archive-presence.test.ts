import { expect, it } from "vitest";
import { applyPresence, displayNames, peopleAt, roomChanges } from "../public/archive-presence.js";

// The archive's presence bookkeeping, pure: no EventSource, no DOM.
const ana = { id: "p_a", name: "Ana", colour: "#b48cff", colourName: "violet", markId: 5, timeTravelling: false };
const bo = { id: "p_b", name: "Someone", colour: "#a8e05f", colourName: "lime", markId: 7, timeTravelling: false };
const cy = { id: "p_c", name: "Someone", colour: "#ff9f43", colourName: "orange", markId: 5, timeTravelling: false };

it("builds who's here from hello, join, move and leave", () => {
  let people = applyPresence(new Map(), { type: "hello", presenceId: "p_me", people: [ana] });
  expect([...people.keys()]).toEqual(["p_a"]);
  people = applyPresence(people, { type: "join", person: bo });
  people = applyPresence(people, { type: "move", person: { ...bo, markId: 5 } });
  expect(peopleAt(people, 5).map((p) => p.id)).toEqual(["p_a", "p_b"]);
  const before = people;
  people = applyPresence(people, { type: "leave", id: "p_a" });
  expect(people.has("p_a")).toBe(false);
  expect(before.has("p_a")).toBe(true); // a new map, the old one untouched
  expect(applyPresence(people, { type: "leave", id: "nobody" })).toBe(people);
  expect(applyPresence(people, { type: "say", markId: 5, line: {} })).toBe(people);
});

it("tells duplicate names apart by colour", () => {
  const names = displayNames([ana, bo, cy]);
  expect(names.get("p_a")).toBe("Ana");
  expect(names.get("p_b")).toBe("Someone (lime)");
  expect(names.get("p_c")).toBe("Someone (orange)");
  // your own name counts too
  expect(displayNames([ana], "Ana").get("p_a")).toBe("Ana (violet)");
});

it("reports only who arrived at or left your mark", () => {
  const before = new Map([
    ["p_a", ana],
    ["p_b", bo],
  ]);
  const after = new Map([
    ["p_b", { ...bo, markId: 5 }],
    ["p_c", { ...cy, markId: 9 }],
  ]);
  expect(roomChanges(before, after, 5)).toEqual({ arrived: ["p_b"], left: ["p_a"] });
  expect(roomChanges(before, after, 9)).toEqual({ arrived: ["p_c"], left: [] });
});
