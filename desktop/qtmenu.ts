// Native macOS menus built from a streamed app's menu tree (AppServer "menus" message), appended to
// the NSApp main menu that macmenu.ts installs. Selecting an item calls onTrigger(actionId), which the
// host forwards to the AppServer as {op:"triggerAction"}. Objective-C runtime FFI, macOS only.
// Kept separate from macmenu.ts (owned by another in-progress change); duplicates its tiny helpers.
export interface MenuItem { id?: string; text?: string; shortcut?: string; enabled?: boolean; checkable?: boolean; checked?: boolean; sep?: boolean; items?: MenuItem[] }
export interface Menu { title: string; items: MenuItem[] }

function loadObjc() {
  return Deno.dlopen("/usr/lib/libobjc.A.dylib", {
    objc_getClass: { parameters: ["buffer"], result: "pointer" },
    sel_registerName: { parameters: ["buffer"], result: "pointer" },
    objc_allocateClassPair: { parameters: ["pointer", "buffer", "usize"], result: "pointer" },
    objc_registerClassPair: { parameters: ["pointer"], result: "void" },
    class_addMethod: { parameters: ["pointer", "pointer", "pointer", "buffer"], result: "bool" },
    send: { name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "pointer" },
    send_i64: { name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "i64" },
    send_p: { name: "objc_msgSend", parameters: ["pointer", "pointer", "pointer"], result: "pointer" },
    send_pi: { name: "objc_msgSend", parameters: ["pointer", "pointer", "pointer", "i64"], result: "pointer" },
    send_ppp: { name: "objc_msgSend", parameters: ["pointer", "pointer", "pointer", "pointer", "pointer"], result: "pointer" },
    send_buf: { name: "objc_msgSend", parameters: ["pointer", "pointer", "buffer"], result: "pointer" },
    send_u64: { name: "objc_msgSend", parameters: ["pointer", "pointer", "u64"], result: "pointer" },
    send_bool: { name: "objc_msgSend", parameters: ["pointer", "pointer", "bool"], result: "pointer" },
  } as const).symbols;
}
let objcSymbols: ReturnType<typeof loadObjc> | undefined;
const objc = () => (objcSymbols ??= loadObjc());
const enc = new TextEncoder();
const cstr = (s: string) => enc.encode(s + "\0");
const cls = (name: string) => objc().objc_getClass(cstr(name));
const sel = (name: string) => objc().sel_registerName(cstr(name));
const nsstring = (s: string) => objc().send_buf(cls("NSString"), sel("stringWithUTF8String:"), cstr(s));
const CMD = 1n << 20n, SHIFT = 1n << 17n, OPTION = 1n << 19n, CTRL = 1n << 18n;

let target: Deno.PointerValue | null = null;
let callback: unknown = null;              // keeps the UnsafeCallback alive for the app's lifetime
let ids: string[] = [];                 // tag -> action id
let installed: Deno.PointerValue[] = []; // top-level NSMenuItems we added (removed on rebuild)

/** Qt shortcut ("Ctrl+Shift+S", "F5") -> NSMenuItem key equivalent + modifier mask (Cmd for Ctrl). */
function keyEquivalent(sc: string | undefined): { key: string; mask: bigint } {
  if (!sc) return { key: "", mask: 0n };
  const parts = sc.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  if (key.length !== 1) return { key: "", mask: 0n };   // F-keys etc.: skip for the POC
  let mask = 0n;
  for (const p of parts) { if (p === "Ctrl") mask |= CMD; else if (p === "Shift") mask |= SHIFT; else if (p === "Alt") mask |= OPTION; else if (p === "Meta") mask |= CTRL; }
  return { key: key.toLowerCase(), mask: mask || CMD };
}

function ensureTarget(onTrigger: (id: string) => void) {
  if (target) return target;
  const cb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    (_self, _cmd, sender) => { const tag = Number(objc().send_i64(sender, sel("tag"))); const id = ids[tag]; if (id) onTrigger(id); },
  );
  callback = cb;
  const c = objc().objc_allocateClassPair(cls("NSObject"), cstr("SLLQtMenuTarget"), 0n);
  objc().class_addMethod(c, sel("sllTrigger:"), cb.pointer, cstr("v@:@"));
  objc().objc_registerClassPair(c);
  target = objc().send(objc().send(c, sel("alloc")), sel("init"));
  return target;
}

function buildMenu(title: string, items: MenuItem[]): Deno.PointerValue {
  const menu = objc().send_p(objc().send(cls("NSMenu"), sel("alloc")), sel("initWithTitle:"), nsstring(title));
  objc().send_bool(menu, sel("setAutoenablesItems:"), false);
  for (const it of items) {
    if (it.sep) { objc().send_p(menu, sel("addItem:"), objc().send(cls("NSMenuItem"), sel("separatorItem"))); continue; }
    const text = (it.text ?? "").replace(/&(.)/g, "$1").replace(/\.\.\.$/, "…");
    const { key, mask } = keyEquivalent(it.shortcut);
    const item = objc().send_ppp(objc().send(cls("NSMenuItem"), sel("alloc")), sel("initWithTitle:action:keyEquivalent:"), nsstring(text), it.items ? null : sel("sllTrigger:"), nsstring(key));
    if (key) objc().send_u64(item, sel("setKeyEquivalentModifierMask:"), mask);
    if (it.items) objc().send_p(item, sel("setSubmenu:"), buildMenu(text, it.items));
    else if (it.id) { objc().send_p(item, sel("setTarget:"), target); objc().send_u64(item, sel("setTag:"), BigInt(ids.push(it.id) - 1)); }
    objc().send_bool(item, sel("setEnabled:"), it.enabled !== false);
    if (it.checkable) objc().send_u64(item, sel("setState:"), it.checked ? 1n : 0n);
    objc().send_p(menu, sel("addItem:"), item);
  }
  return menu;
}

/** Install (or replace) the app's menus after the host's own App menu (index 1..n). */
export function installQtMenus(menus: Menu[], onTrigger: (id: string) => void) {
  if (Deno.build.os !== "darwin") return;
  const app = objc().send(cls("NSApplication"), sel("sharedApplication"));
  const main = objc().send(app, sel("mainMenu"));
  if (!main) return;
  ensureTarget(onTrigger);
  for (const old of installed) objc().send_p(main, sel("removeItem:"), old);
  installed = []; ids = [];
  let index = 1;
  for (const m of menus) {
    const title = m.title.replace(/&(.)/g, "$1");
    if (title === "Edit" || title === "Help") { /* the host already has these; Qt's Edit/Help go under their own names */ }
    const holder = objc().send_ppp(objc().send(cls("NSMenuItem"), sel("alloc")), sel("initWithTitle:action:keyEquivalent:"), nsstring(title), null, nsstring(""));
    objc().send_p(holder, sel("setSubmenu:"), buildMenu(title, m.items));
    objc().send_pi(main, sel("insertItem:atIndex:"), holder, BigInt(index++));
    installed.push(holder);
  }
}
