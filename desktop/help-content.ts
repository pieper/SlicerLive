// The Help-menu documentation dialog, injected into every page by webview.init
// and opened via webview.eval("__sllShowHelp()") from the native Help menu.
// Mac-style modal card over the current page; the demo list is built live from
// /scenes/index.json so it stays true to whatever the gallery currently ships.
export const HELP_INIT_JS = `
window.__sllShowHelp = async function () {
  const existing = document.getElementById("sll-help-backdrop");
  if (existing) { existing.remove(); return; }

  const bd = document.createElement("div");
  bd.id = "sll-help-backdrop";
  bd.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);" +
    "display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)";
  const card = document.createElement("div");
  card.style.cssText = "width:min(680px,90vw);max-height:84vh;display:flex;flex-direction:column;" +
    "background:#1e1e2a;color:#d8d8e0;border:1px solid #3a3a4e;border-radius:12px;" +
    "box-shadow:0 22px 60px rgba(0,0,0,.55);font:13px/1.55 -apple-system,system-ui,sans-serif;overflow:hidden";
  card.innerHTML =
    '<div style="display:flex;align-items:center;padding:14px 18px;border-bottom:1px solid #2a2a3a">' +
    '  <div style="font-size:16px;font-weight:650">SlicerLive Help</div>' +
    '  <div id="sll-help-close" style="margin-left:auto;width:24px;height:24px;border-radius:12px;background:#2a2a3a;' +
    '       display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px;color:#aab">✕</div>' +
    '</div>' +
    '<div id="sll-help-body" style="overflow-y:auto;padding:6px 18px 16px">' +
    '  <p style="opacity:.85">Live 3D Slicer scenes rendered <b>in this window on your own GPU</b> (WebGPU) —' +
    '  no Slicer install, no render server. Pick a demo from the gallery; imaging data streams from public' +
    '  Jetstream2 cloud storage and is cached locally, so a demo is much faster the second time you open it.</p>' +
    '  <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:#9fb3d0;margin:16px 0 6px">Mouse & trackpad</h3>' +
    '  <table style="border-collapse:collapse;width:100%">' + [
        ["3D views — rotate", "drag with the left button"],
        ["3D views — pan", "shift-drag, or drag with the middle button"],
        ["3D views — zoom", "scroll / two-finger swipe, or drag with the right button"],
        ["Slice (2D) views — step through slices", "scroll / two-finger swipe"],
        ["Slice (2D) views — zoom", "hold ⌃ control while scrolling"],
        ["Crosshair (four-up demos)", "hold ⇧ shift and move the mouse — all views follow"],
      ].map(function (r) {
        return '<tr><td style="padding:3px 14px 3px 0;white-space:nowrap;color:#b8c4d8">' + r[0] +
               '</td><td style="padding:3px 0;opacity:.8">' + r[1] + '</td></tr>';
      }).join("") + '</table>' +
    '  <p style="opacity:.7;margin-top:8px">The mappings match desktop 3D Slicer, so anything you know from Slicer carries over.' +
    '  Each demo also has its own on-page controls (presets, phase players, comparison sliders …) — explained in its footer.</p>' +
    '  <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:#9fb3d0;margin:16px 0 6px">Keyboard</h3>' +
    '  <table style="border-collapse:collapse">' + [
        ["⌘[ or ⌘←", "back to the gallery (or use the ← button, top left of every demo)"],
        ["⇧⌘?", "this help"],
        ["⌘M / ⌘W / ⌘Q", "minimize / close window / quit"],
      ].map(function (r) {
        return '<tr><td style="padding:3px 14px 3px 0;white-space:nowrap;color:#b8c4d8">' + r[0] +
               '</td><td style="padding:3px 0;opacity:.8">' + r[1] + '</td></tr>';
      }).join("") + '</table>' +
    '  <h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:#9fb3d0;margin:16px 0 6px">The demos</h3>' +
    '  <div id="sll-help-demos" style="opacity:.6">loading…</div>' +
    '</div>';
  bd.appendChild(card);
  document.body.appendChild(bd);

  const close = function () { bd.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = function (e) { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  bd.addEventListener("click", function (e) { if (e.target === bd) close(); });
  card.querySelector("#sll-help-close").onclick = close;

  try {
    const scenes = await (await fetch("/scenes/index.json")).json();
    const list = document.getElementById("sll-help-demos");
    if (!list) return;
    list.style.opacity = "1";
    list.innerHTML = scenes.filter(function (s) { return !s.legacy; }).map(function (s) {
      return '<div style="margin:0 0 10px">' +
        '<a href="/' + s.page + '" style="color:#7fa8e0;text-decoration:none;font-weight:600">' + s.name + '</a>' +
        (s.wip ? ' <span style="font-size:10px;color:#caa">work in progress</span>' : '') +
        '<div style="opacity:.65;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' +
        (s.desc || '') + '</div></div>';
    }).join("") +
    '<div style="opacity:.55;margin-top:4px">…plus a Legacy section (vtk.js viewer) at the bottom of the gallery page.</div>';
    list.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", close); });
  } catch (e) {
    const list = document.getElementById("sll-help-demos");
    if (list) list.textContent = "could not load the demo list: " + e;
  }
};
`;
