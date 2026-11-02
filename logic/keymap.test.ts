// T1: the keybinding registry — chord normalization, event resolution, rebinding, persistence.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  chordOf,
  type Command,
  formatChord,
  isTypingTarget,
  Keymap,
  KeymapError,
  normalizeChord,
} from "./keymap.ts";

const CMDS: Command[] = [
  { id: "tool.scroll", label: "Scroll", group: "Tools", defaultKeys: ["s"] },
  { id: "tool.windowLevel", label: "Window/level", group: "Tools", defaultKeys: ["w"] },
  { id: "view.togglePlane", label: "Sagittal/coronal", group: "Navigation", defaultKeys: ["x"] },
  { id: "view.next", label: "Next slice", group: "Navigation", defaultKeys: ["arrowdown", "f"] },
  { id: "finding.delete", label: "Delete finding", group: "Findings", defaultKeys: ["d"] },
  { id: "app.save", label: "Save", defaultKeys: ["ctrl+s", "meta+s"] },
];

Deno.test("chords normalize to one spelling regardless of input order or case", () => {
  assertEquals(normalizeChord("Ctrl+Shift+K"), "ctrl+shift+k");
  assertEquals(normalizeChord("shift+control+k"), "ctrl+shift+k");
  assertEquals(normalizeChord("CMD+S"), "meta+s");
  assertEquals(normalizeChord("Option+ArrowUp"), "alt+arrowup");
  assertEquals(normalizeChord("  x "), "x");
  // A chord that is only modifiers cannot be bound.
  assertEquals(normalizeChord("ctrl+"), "");
  assertEquals(normalizeChord(""), "");
});

Deno.test("chordOf keeps shift for letters and named keys but not for shifted punctuation", () => {
  assertEquals(chordOf({ key: "x" }), "x");
  assertEquals(chordOf({ key: "X", shiftKey: true }), "shift+x");
  assertEquals(chordOf({ key: "ArrowUp", shiftKey: true }), "shift+arrowup");
  // shift+4 arrives as "$"; the shifted character IS the chord, so "shift+$" would be unbindable.
  assertEquals(chordOf({ key: "$", shiftKey: true }), "$");
  assertEquals(chordOf({ key: "?", shiftKey: true }), "?");
  assertEquals(chordOf({ key: "s", ctrlKey: true }), "ctrl+s");
  assertEquals(chordOf({ key: "k", ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }), "ctrl+alt+shift+meta+k");
});

Deno.test("key events resolve to command ids", () => {
  const km = new Keymap(CMDS);
  assertEquals(km.resolve({ key: "s" }), "tool.scroll");
  assertEquals(km.resolve({ key: "X", shiftKey: true }), null);     // shift+x is not bound
  assertEquals(km.resolve({ key: "x" }), "view.togglePlane");
  assertEquals(km.resolve({ key: "ArrowDown" }), "view.next");
  assertEquals(km.resolve({ key: "f" }), "view.next");              // an alias of the same command
  assertEquals(km.resolve({ key: "s", ctrlKey: true }), "app.save");
  assertEquals(km.resolve({ key: "q" }), null);
});

Deno.test("Heather's D-is-delete default survives the registry", () => {
  const km = new Keymap(CMDS);
  assertEquals(km.resolve({ key: "d" }), "finding.delete");
  assertEquals(km.keysFor("finding.delete"), ["d"]);
});

Deno.test("overrides REPLACE defaults rather than adding to them", () => {
  const km = new Keymap(CMDS, { "tool.scroll": ["n"] });
  assertEquals(km.resolve({ key: "n" }), "tool.scroll");
  // The old binding is gone -- a rebind that left it working would be a silent duplicate.
  assertEquals(km.resolve({ key: "s" }), null);
});

Deno.test("an override for an unknown command fails loudly", () => {
  assertThrows(() => new Keymap(CMDS, { "tool.nope": ["n"] }), KeymapError, "unknown command");
});

Deno.test("duplicate command ids fail loudly", () => {
  assertThrows(
    () => new Keymap([...CMDS, { id: "tool.scroll", label: "dupe", defaultKeys: [] }]),
    KeymapError,
    "duplicate command id",
  );
});

Deno.test("binding a chord takes it away from whoever held it", () => {
  const km = new Keymap(CMDS);
  km.bind("finding.delete", ["s"]);
  assertEquals(km.resolve({ key: "s" }), "finding.delete");
  // tool.scroll must not keep a binding that now belongs to something else.
  assertEquals(km.keysFor("tool.scroll"), []);
  assertEquals(km.conflicts(), []);
});

Deno.test("rebinding only one of a command's aliases leaves the other alone", () => {
  const km = new Keymap(CMDS);
  km.bind("tool.scroll", ["arrowdown"]);
  assertEquals(km.resolve({ key: "ArrowDown" }), "tool.scroll");
  assertEquals(km.keysFor("view.next"), ["f"]);
});

Deno.test("binding an unknown command fails loudly", () => {
  assertThrows(() => new Keymap(CMDS).bind("nope", ["z"]), KeymapError, "unknown command");
});

Deno.test("colliding defaults are reported as conflicts", () => {
  const km = new Keymap([
    { id: "a", label: "a", defaultKeys: ["z"] },
    { id: "b", label: "b", defaultKeys: ["z"] },
  ]);
  assertEquals(km.conflicts(), [{ chord: "z", commandIds: ["a", "b"] }]);
});

Deno.test("the shipped command set has no conflicting defaults", () => {
  assertEquals(new Keymap(CMDS).conflicts(), []);
});

Deno.test("only the differences persist, and they round-trip", () => {
  const km = new Keymap(CMDS);
  assertEquals(km.toJSON(), {});
  km.bind("view.togglePlane", ["c"]);
  assertEquals(km.toJSON(), { "view.togglePlane": ["c"] });
  const restored = new Keymap(CMDS, km.toJSON());
  assertEquals(restored.resolve({ key: "c" }), "view.togglePlane");
  assertEquals(restored.resolve({ key: "x" }), null);
  assertEquals(restored.toJSON(), { "view.togglePlane": ["c"] });
});

Deno.test("reset restores defaults, for one command or all", () => {
  const km = new Keymap(CMDS);
  km.bind("tool.scroll", ["n"]);
  km.bind("tool.windowLevel", ["m"]);
  km.reset("tool.scroll");
  assertEquals(km.keysFor("tool.scroll"), ["s"]);
  assertEquals(km.keysFor("tool.windowLevel"), ["m"]);
  km.reset();
  assertEquals(km.toJSON(), {});
});

Deno.test("a rebind that frees a chord shows up in toJSON for BOTH commands", () => {
  const km = new Keymap(CMDS);
  km.bind("finding.delete", ["s"]);
  // tool.scroll lost "s", so its now-empty binding must persist too -- otherwise reloading the
  // saved map would hand "s" back to tool.scroll and create a conflict.
  assertEquals(km.toJSON(), { "tool.scroll": [], "finding.delete": ["s"] });
  assertEquals(new Keymap(CMDS, km.toJSON()).conflicts(), []);
});

Deno.test("commands group in declaration order for a shortcuts panel", () => {
  assertEquals(new Keymap(CMDS).byGroup().map((g) => [g.group, g.items.map((i) => i.command.id)]), [
    ["Tools", ["tool.scroll", "tool.windowLevel"]],
    ["Navigation", ["view.togglePlane", "view.next"]],
    ["Findings", ["finding.delete"]],
    ["", ["app.save"]],
  ]);
});

Deno.test("chords format for display, with Mac glyphs", () => {
  assertEquals(formatChord("x"), "X");
  assertEquals(formatChord("ctrl+shift+k"), "Ctrl+Shift+K");
  assertEquals(formatChord("meta+s", true), "⌘S");
  assertEquals(formatChord("arrowdown"), "↓");
  assertEquals(formatChord("escape"), "Esc");
});

Deno.test("typing into a field is not a shortcut", () => {
  assert(isTypingTarget({ tagName: "INPUT" }));
  assert(isTypingTarget({ tagName: "select" }));
  assert(isTypingTarget({ tagName: "TEXTAREA" }));
  assert(isTypingTarget({ tagName: "DIV", isContentEditable: true }));
  assert(!isTypingTarget({ tagName: "CANVAS" }));
  assert(!isTypingTarget(null));
});
