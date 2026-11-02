// A central keybinding registry: commands declare their defaults, a user override map is layered
// on top, and one resolver turns a KeyboardEvent into a command id.
//
// Today every surface in SlicerLive attaches its own `keydown` handler with the bindings inlined
// (the IHE BIR reader's table is the most developed of them). That makes bindings impossible to
// show the user, impossible to reassign, and impossible to check for conflicts — all three of
// which a reading workstation needs, because radiologists arrive with another product's shortcuts
// already in their fingers.
//
// Deliberately NOT a dispatcher: resolve() returns a command id and the caller decides what to do
// with it. Keeping the lookup pure is what makes it testable without a DOM.

/** A key chord in normal form: modifiers in a fixed order, then one lower-cased key.
 *  Examples: "x", "shift+x", "ctrl+alt+k", "arrowup", "escape", "?". */
export type Chord = string;

export interface Command {
  id: string;
  /** Shown in a shortcuts panel. */
  label: string;
  /** Groups the shortcut list, e.g. "Tools", "Navigation". */
  group?: string;
  /** Chords bound to this command out of the box. May be empty. */
  defaultKeys: Chord[];
  /** Longer help text for a shortcuts panel. */
  description?: string;
}

/** Normalize a chord string so "Ctrl+Shift+K", "shift+ctrl+k" and "CONTROL+SHIFT+K" compare equal.
 *  Modifier order is fixed as ctrl, alt, shift, meta — matching how they are printed. */
export function normalizeChord(chord: string): Chord {
  const parts = chord.split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return "";
  const mods = new Set<string>();
  let key = "";
  for (const part of parts) {
    if (part === "ctrl" || part === "control") mods.add("ctrl");
    else if (part === "alt" || part === "option") mods.add("alt");
    else if (part === "shift") mods.add("shift");
    else if (part === "meta" || part === "cmd" || part === "command") mods.add("meta");
    else key = part;
  }
  if (!key) return "";
  const order = ["ctrl", "alt", "shift", "meta"].filter((m) => mods.has(m));
  return [...order, key].join("+");
}

/** The subset of KeyboardEvent this module needs, so resolve() is testable without a DOM. */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

/** The chord a key event represents, in normal form.
 *
 *  `shift` is recorded only for keys where it is not already baked into `key`: shift+4 arrives as
 *  "$", so reporting "shift+$" would never match anything a user could bind. For a single
 *  printable character the shifted character IS the chord; for named keys (ArrowUp, Tab, Escape)
 *  and for letters the modifier is kept. */
export function chordOf(e: KeyLike): Chord {
  const raw = e.key;
  const key = raw.length === 1 ? raw.toLowerCase() : raw.toLowerCase();
  const printable = raw.length === 1;
  const isLetter = printable && /^[a-z]$/i.test(raw);
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey && (!printable || isLetter)) mods.push("shift");
  if (e.metaKey) mods.push("meta");
  return [...mods, key].join("+");
}

/** Should a key event be ignored because the user is typing into a field? */
export function isTypingTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "OPTION";
}

export interface Conflict {
  chord: Chord;
  commandIds: string[];
}

export class KeymapError extends Error {}

/** Commands plus the user's overrides. Overrides REPLACE a command's chords rather than adding to
 *  them, so a user who rebinds a key does not silently keep the old one as well. */
export class Keymap {
  readonly commands: readonly Command[];
  #byId = new Map<string, Command>();
  #keys = new Map<string, Chord[]>();        // commandId -> chords
  #lookup = new Map<Chord, string>();        // chord -> commandId (last writer wins)

  constructor(commands: Command[], overrides: Record<string, string[]> = {}) {
    this.commands = commands;
    for (const c of commands) {
      if (this.#byId.has(c.id)) throw new KeymapError(`duplicate command id: ${c.id}`);
      this.#byId.set(c.id, c);
    }
    for (const id of Object.keys(overrides)) {
      if (!this.#byId.has(id)) throw new KeymapError(`override for unknown command: ${id}`);
    }
    for (const c of commands) {
      const src = overrides[c.id] ?? c.defaultKeys;
      this.#keys.set(c.id, src.map(normalizeChord).filter(Boolean));
    }
    this.#reindex();
  }

  #reindex(): void {
    this.#lookup.clear();
    for (const [id, chords] of this.#keys) for (const ch of chords) this.#lookup.set(ch, id);
  }

  /** The command a key event triggers, or null. */
  resolve(e: KeyLike): string | null {
    return this.#lookup.get(chordOf(e)) ?? null;
  }

  /** The command bound to a chord, or null. */
  commandFor(chord: string): string | null {
    return this.#lookup.get(normalizeChord(chord)) ?? null;
  }

  keysFor(commandId: string): Chord[] {
    return [...(this.#keys.get(commandId) ?? [])];
  }

  command(commandId: string): Command | undefined {
    return this.#byId.get(commandId);
  }

  /** Rebind a command, replacing its chords. Any chord taken from another command is removed from
   *  it, so the map stays single-valued — the alternative is a shortcut that silently stops
   *  working because something else claimed it. */
  bind(commandId: string, chords: string[]): void {
    if (!this.#byId.has(commandId)) throw new KeymapError(`unknown command: ${commandId}`);
    const wanted = chords.map(normalizeChord).filter(Boolean);
    for (const [id, existing] of this.#keys) {
      if (id === commandId) continue;
      const kept = existing.filter((ch) => !wanted.includes(ch));
      if (kept.length !== existing.length) this.#keys.set(id, kept);
    }
    this.#keys.set(commandId, wanted);
    this.#reindex();
  }

  /** Restore one command's defaults, or all of them. */
  reset(commandId?: string): void {
    for (const c of this.commands) {
      if (commandId && c.id !== commandId) continue;
      this.#keys.set(c.id, c.defaultKeys.map(normalizeChord).filter(Boolean));
    }
    this.#reindex();
  }

  /** Chords claimed by more than one command. Only reachable by constructing a map with colliding
   *  defaults — bind() prevents it afterwards — which is exactly the case worth catching in a test. */
  conflicts(): Conflict[] {
    const seen = new Map<Chord, string[]>();
    for (const [id, chords] of this.#keys) {
      for (const ch of chords) {
        const list = seen.get(ch) ?? [];
        list.push(id);
        seen.set(ch, list);
      }
    }
    return [...seen].filter(([, ids]) => ids.length > 1).map(([chord, commandIds]) => ({ chord, commandIds }));
  }

  /** Only the chords that differ from the defaults — what to persist. */
  toJSON(): Record<string, Chord[]> {
    const out: Record<string, Chord[]> = {};
    for (const c of this.commands) {
      const now = this.#keys.get(c.id) ?? [];
      const def = c.defaultKeys.map(normalizeChord).filter(Boolean);
      if (now.length !== def.length || now.some((ch, i) => ch !== def[i])) out[c.id] = [...now];
    }
    return out;
  }

  /** Grouped for a shortcuts panel, in command declaration order. */
  byGroup(): { group: string; items: { command: Command; keys: Chord[] }[] }[] {
    const out: { group: string; items: { command: Command; keys: Chord[] }[] }[] = [];
    for (const c of this.commands) {
      const g = c.group ?? "";
      let bucket = out.find((x) => x.group === g);
      if (!bucket) out.push(bucket = { group: g, items: [] });
      bucket.items.push({ command: c, keys: this.keysFor(c.id) });
    }
    return out;
  }
}

/** Human-readable chord, for a shortcuts panel. Uses the platform's modifier glyphs on Mac. */
export function formatChord(chord: Chord, mac = false): string {
  const parts = normalizeChord(chord).split("+");
  const key = parts.pop() ?? "";
  const glyph: Record<string, string> = mac
    ? { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" }
    : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta" };
  const named: Record<string, string> = {
    arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
    escape: "Esc", " ": "Space", enter: "Enter", tab: "Tab", backspace: "Backspace", delete: "Del",
  };
  const shown = named[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  const mods = parts.map((m) => glyph[m] ?? m);
  return mac ? [...mods, shown].join("") : [...mods, shown].join("+");
}
