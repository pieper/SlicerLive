// "Transforms" panel (W6): create a linear transform, apply it to the active volume (or markup), nudge its
// translation, reset to identity, and Harden (bake the world matrix into the node's geometry and clear the
// ref) — Slicer's Transforms module core. Live edits re-place the field via the transform chain in the image
// DM. Plain DOM, theme.css. Matrices row-major, RAS.
import type { AppShell } from "./app-shell.ts";
import type { LiveScene } from "../livescene.ts";

interface Hooks {
  __createTransform: () => string;
  __applyTransformTo: (nodeId: string, transformId: string) => void;
  __translateTransform: (transformId: string, dx: number, dy: number, dz: number) => void;
  __identityTransform: (transformId: string) => void;
  __hardenTransform: (nodeId: string) => void;
  __transforms: () => { id: string; name: string; matrix: number[] }[];
  __volumeList: () => { imageId: string; name: string }[];
  __nodeTransform: (nodeId: string) => string | null;
}
const g = () => globalThis as unknown as Hooks;

export function registerTransformsPanel(shell: AppShell, opts: { live: LiveScene; onStatus?: (s: string) => void }): void {
  const { live } = opts;
  let root: HTMLElement | null = null;
  const status = (s: string) => { opts.onStatus?.(s); shell.setStatus(s); };
  let target = "";   // the node the panel transforms
  let dragging = false;   // while a slider is dragged, suppress the subscribe-driven re-render (which would detach the slider)

  function render() {
    if (!root) return;
    const vols = g().__volumeList?.() ?? [];
    if (!target || !vols.some((v) => v.imageId === target)) target = vols[0]?.imageId ?? "";
    const tid = target ? g().__nodeTransform?.(target) : null;
    const tf = tid ? g().__transforms().find((t) => t.id === tid) : undefined;
    const m = tf?.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    root.innerHTML = `
      <h2>Transforms</h2>
      <div class="sl-row"><label>Node</label><select class="sl-tf-target">${vols.map((v) => `<option value="${v.imageId}"${v.imageId === target ? " selected" : ""}>${v.name}</option>`).join("")}</select></div>
      <div class="sl-row"><button class="sl-primary sl-tf-apply">${tid ? "Transform applied" : "Apply a transform"}</button></div>
      ${tid ? `
      <h3>Translation (mm)</h3>
      <div class="sl-row"><label>R</label><input class="sl-tf-x" type="range" min="-100" max="100" step="1" value="${m[3]}"><span class="sl-tf-xv">${m[3].toFixed(0)}</span></div>
      <div class="sl-row"><label>A</label><input class="sl-tf-y" type="range" min="-100" max="100" step="1" value="${m[7]}"><span class="sl-tf-yv">${m[7].toFixed(0)}</span></div>
      <div class="sl-row"><label>S</label><input class="sl-tf-z" type="range" min="-100" max="100" step="1" value="${m[11]}"><span class="sl-tf-zv">${m[11].toFixed(0)}</span></div>
      <div class="sl-row"><button class="sl-tf-identity">Identity</button><button class="sl-tf-harden">Harden</button></div>
      <p class="sl-hint">Matrix: [${m.map((x) => x.toFixed(2)).join(", ")}]</p>` : ""}`;
    const $ = <T extends HTMLElement>(s: string) => root!.querySelector(s) as T;
    $("select.sl-tf-target").addEventListener("change", (e) => { target = (e.target as HTMLSelectElement).value; render(); });
    $(".sl-tf-apply").addEventListener("click", () => { if (g().__nodeTransform(target)) return; const id = g().__createTransform(); g().__applyTransformTo(target, id); status("transform applied"); render(); });
    const setAbs = () => { const cur = g().__transforms().find((t) => t.id === g().__nodeTransform(target))!.matrix; const x = Number($<HTMLInputElement>("input.sl-tf-x").value), y = Number($<HTMLInputElement>("input.sl-tf-y").value), z = Number($<HTMLInputElement>("input.sl-tf-z").value); g().__translateTransform(g().__nodeTransform(target)!, x - cur[3], y - cur[7], z - cur[11]); };
    for (const [ax, lab] of [["x", "xv"], ["y", "yv"], ["z", "zv"]] as const) {
      const sl = $(`input.sl-tf-${ax}`);
      sl?.addEventListener("pointerdown", () => { dragging = true; });
      sl?.addEventListener("input", (e) => { ($(`.sl-tf-${lab}`) as HTMLElement).textContent = Number((e.target as HTMLInputElement).value).toFixed(0); setAbs(); });
      sl?.addEventListener("change", () => { dragging = false; render(); });
    }
    $(".sl-tf-identity")?.addEventListener("click", () => { g().__identityTransform(g().__nodeTransform(target)!); render(); });
    $(".sl-tf-harden")?.addEventListener("click", () => { g().__hardenTransform(target); status("transform hardened"); render(); });
  }

  shell.registerPanel({ id: "transforms", title: "Transforms", order: 7, mount(el) { root = el; render(); } });
  live.subscribe((c) => { if (!dragging && (c.type === "transform" || c.type === "image")) render(); });
}
