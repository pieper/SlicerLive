// Native macOS menu bar for the webview app, via Objective-C runtime FFI.
// webview_deno creates the NSApplication but no main menu (so no ⌘Q, no
// Edit-menu clipboard in text fields). Call installMacMenu() after the Webview
// is constructed (AppKit is loaded by then) and before webview.run().
//
// Menus: <App> (About / Hide / Quit ⌘Q) · Edit (clipboard, first-responder
// targeted — required for ⌘C/⌘V to work in WKWebView) · Window (Minimize ⌘M,
// Zoom, Close ⌘W) · Help (<App> Help ⌘? → onHelp callback, fired on the main
// thread while webview.run() is blocked, same re-entry path as bind()).

const objc = Deno.dlopen("/usr/lib/libobjc.A.dylib", {
  objc_getClass: { parameters: ["buffer"], result: "pointer" },
  sel_registerName: { parameters: ["buffer"], result: "pointer" },
  objc_allocateClassPair: { parameters: ["pointer", "buffer", "usize"], result: "pointer" },
  objc_registerClassPair: { parameters: ["pointer"], result: "void" },
  class_addMethod: { parameters: ["pointer", "pointer", "pointer", "buffer"], result: "bool" },
  // objc_msgSend under one alias per call shape we need.
  send: { name: "objc_msgSend", parameters: ["pointer", "pointer"], result: "pointer" },
  send_p: { name: "objc_msgSend", parameters: ["pointer", "pointer", "pointer"], result: "pointer" },
  send_ppp: { name: "objc_msgSend", parameters: ["pointer", "pointer", "pointer", "pointer", "pointer"], result: "pointer" },
  send_buf: { name: "objc_msgSend", parameters: ["pointer", "pointer", "buffer"], result: "pointer" },
  send_u64: { name: "objc_msgSend", parameters: ["pointer", "pointer", "u64"], result: "pointer" },
} as const).symbols;

const enc = new TextEncoder();
const cstr = (s: string) => enc.encode(s + "\0");
const cls = (name: string) => objc.objc_getClass(cstr(name));
const sel = (name: string) => objc.sel_registerName(cstr(name));
const nsstring = (s: string) => objc.send_buf(cls("NSString"), sel("stringWithUTF8String:"), cstr(s));

const CMD = 1n << 20n, SHIFT = 1n << 17n, OPTION = 1n << 19n;

function menuItem(
  title: string,
  action: Deno.PointerValue | null,
  key: string,
  opts: { target?: Deno.PointerValue; mask?: bigint } = {},
): Deno.PointerValue {
  const item = objc.send(cls("NSMenuItem"), sel("alloc"));
  const it = objc.send_ppp(item, sel("initWithTitle:action:keyEquivalent:"), nsstring(title), action, nsstring(key));
  if (opts.target) objc.send_p(it, sel("setTarget:"), opts.target);
  if (opts.mask !== undefined) objc.send_u64(it, sel("setKeyEquivalentModifierMask:"), opts.mask);
  return it;
}

function submenu(mainMenu: Deno.PointerValue, title: string): Deno.PointerValue {
  const holder = menuItem(title, null, "");
  objc.send_p(mainMenu, sel("addItem:"), holder);
  const menu = objc.send_p(objc.send(cls("NSMenu"), sel("alloc")), sel("initWithTitle:"), nsstring(title));
  objc.send_p(holder, sel("setSubmenu:"), menu);
  return menu;
}

function addItems(menu: Deno.PointerValue, items: (Deno.PointerValue | "sep")[]) {
  for (const i of items) {
    objc.send_p(menu, sel("addItem:"), i === "sep" ? objc.send(cls("NSMenuItem"), sel("separatorItem")) : i);
  }
}

// Kept module-global so the FFI callback and its target object outlive install.
let helpCallback: unknown;

export function installMacMenu(appName: string, onHelp: () => void) {
  if (Deno.build.os !== "darwin") return;
  const app = objc.send(cls("NSApplication"), sel("sharedApplication"));

  // A tiny NSObject subclass whose sllShowHelp: method runs onHelp.
  const cb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    () => onHelp(),
  );
  helpCallback = cb;
  const targetCls = objc.objc_allocateClassPair(cls("NSObject"), cstr("SLLMenuTarget"), 0n);
  objc.class_addMethod(targetCls, sel("sllShowHelp:"), cb.pointer, cstr("v@:@"));
  objc.objc_registerClassPair(targetCls);
  const helpTarget = objc.send(objc.send(targetCls, sel("alloc")), sel("init"));

  const mainMenu = objc.send(objc.send(cls("NSMenu"), sel("alloc")), sel("init"));

  addItems(submenu(mainMenu, appName), [
    menuItem(`About ${appName}`, sel("orderFrontStandardAboutPanel:"), "", { target: app }),
    "sep",
    menuItem(`Hide ${appName}`, sel("hide:"), "h", { target: app }),
    menuItem("Hide Others", sel("hideOtherApplications:"), "h", { target: app, mask: CMD | OPTION }),
    menuItem("Show All", sel("unhideAllApplications:"), "", { target: app }),
    "sep",
    menuItem(`Quit ${appName}`, sel("terminate:"), "q", { target: app }),
  ]);

  addItems(submenu(mainMenu, "Edit"), [
    menuItem("Undo", sel("undo:"), "z"),
    menuItem("Redo", sel("redo:"), "z", { mask: CMD | SHIFT }),
    "sep",
    menuItem("Cut", sel("cut:"), "x"),
    menuItem("Copy", sel("copy:"), "c"),
    menuItem("Paste", sel("paste:"), "v"),
    menuItem("Select All", sel("selectAll:"), "a"),
  ]);

  const windowMenu = submenu(mainMenu, "Window");
  addItems(windowMenu, [
    menuItem("Minimize", sel("performMiniaturize:"), "m"),
    menuItem("Zoom", sel("performZoom:"), ""),
    "sep",
    menuItem("Close", sel("performClose:"), "w"),
  ]);
  objc.send_p(app, sel("setWindowsMenu:"), windowMenu);

  const helpMenu = submenu(mainMenu, "Help");
  addItems(helpMenu, [
    menuItem(`${appName} Help`, sel("sllShowHelp:"), "?", { target: helpTarget }),
  ]);
  objc.send_p(app, sel("setHelpMenu:"), helpMenu);

  objc.send_p(app, sel("setMainMenu:"), mainMenu);
}
