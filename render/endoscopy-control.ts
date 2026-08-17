// Endoscopy navigation — first-person flight through a volume's interior.
//
// This is a DIFFERENT interaction from render/demos/camera-control.ts, not a variant of it:
// that one orbits the camera POSITION about the focal point (right for looking at an object
// from outside), this one rotates the view DIRECTION about a fixed position (right for being
// inside something). Attaching both to the same canvas would fight, so the caller enables one.
//
//   left-drag           look (yaw + pitch)
//   arrow up/down       move in / out along the view axis
//   arrow left/right    yaw
//   shift+left/right    pitch
//   ctrl+left/right     roll
//   space               toggle FORWARD cruise
//   shift+space         toggle BACKWARD cruise
//   escape              stop
//
// Motion is a TOGGLED CRUISE rather than press-and-hold: set it going and steer hands-free.
// Two consequences that are easy to get wrong and are handled here:
//   - cruise SURVIVES hitting a wall. `clearance` clamps the step, it does not cancel the
//     toggle, so turning away from an obstruction resumes travel without re-pressing. Stopping
//     on contact makes entering a side branch infuriating.
//   - a modal control with no on-screen state is a trap, so `onState` fires whenever the
//     cruise changes and the caller is expected to display it.
//
// ALL rotation is in LOCAL CAMERA SPACE. The camera carries a full orthonormal basis
// (forward, up, right) and yaw/pitch/roll rotate that basis about its OWN axes:
//     yaw   about local up       pitch about local right      roll about local forward
// An earlier version rotated about a fixed world up (+S) to keep a stable horizon, as Slicer's
// Endoscopy module does for a precomputed path. That is wrong for free flight: once you have
// pitched, a world-space yaw no longer turns the way the picture says it should, and roll is
// not expressible at all. There is deliberately no gimbal clamp — with a real local basis you
// can loop and roll freely, which is the point inside a vessel.

import type { Vec3 } from "./mat4.ts";

export interface EndoCamera {
  position: Vec3;
  focalPoint: Vec3;
  viewUp: Vec3;
  viewAngle: number;
}

export type Cruise = "forward" | "back" | "stopped";

export interface EndoscopyOpts {
  /** mm per second while cruising (default 4 — vessels are small; this is a slow drift). */
  speedMmPerSec?: number;
  /** degrees per second for arrow-key turning (default 60). */
  turnDegPerSec?: number;
  /** radians per pixel of drag (default 0.005 ≈ 0.29°/px). */
  lookRadPerPx?: number;
  /** World reference "up" that keeps the horizon stable (default +S). */
  referenceUp?: Vec3;
  /** How far the focal point sits ahead of the camera, mm (default 30). */
  focalDistanceMm?: number;
  /** Called after any camera change, so the caller can redraw. */
  onChange?: () => void;
  /** Called when the cruise state changes, so the caller can show it. */
  onState?: (cruise: Cruise) => void;
  /** Called when the USER turns the camera (drag or a turn key), so an automatic steering
   *  behaviour can yield instead of fighting them for the heading. */
  onLook?: () => void;
  /** Clearance ahead (mm) along `dir`, for rails. Return Infinity when unknown/unlimited.
   *  Synchronous by design: the caller keeps a value probed asynchronously on its own cadence,
   *  because a GPU readback must never block the input loop. */
  clearance?: (dir: Vec3) => number;
  /** Stand-off kept from the wall, mm (default 6). */
  marginMm?: number;
}

export interface EndoscopyControls {
  /** Advance the flight by `dtSec`. Call once per animation frame. Returns true if the camera moved. */
  tick(dtSec: number): boolean;
  cruise(): Cruise;
  setCruise(c: Cruise): void;
  /** Point the camera without changing position (e.g. adopting a pose from Slicer). */
  lookAlong(dir: Vec3): void;
  detach(): void;
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Rotate `v` about unit axis `k` by `ang` radians (Rodrigues). */
function rotate(v: Vec3, k: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang), s = Math.sin(ang), d = dot(k, v);
  const kv = cross(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * d * (1 - c),
    v[1] * c + kv[1] * s + k[1] * d * (1 - c),
    v[2] * c + kv[2] * s + k[2] * d * (1 - c),
  ];
}

export function attachEndoscopyControls(
  canvas: HTMLCanvasElement,
  camera: EndoCamera,
  opts: EndoscopyOpts = {},
): EndoscopyControls {
  const speed = opts.speedMmPerSec ?? 4;
  const turn = ((opts.turnDegPerSec ?? 60) * Math.PI) / 180;
  const lookRad = opts.lookRadPerPx ?? 0.005;
  const refUp: Vec3 = opts.referenceUp ?? [0, 0, 1];
  const focalDist = opts.focalDistanceMm ?? 30;
  const margin = opts.marginMm ?? 6;

  let cruise: Cruise = "stopped";
  const keys = new Set<string>();
  // Modifiers are read at the time the arrow is HELD, not only when first pressed, so you can
  // press shift mid-hold and switch from yaw to pitch without releasing.
  const mods = { shift: false, ctrl: false };

  const forward = (): Vec3 => norm([
    camera.focalPoint[0] - camera.position[0],
    camera.focalPoint[1] - camera.position[1],
    camera.focalPoint[2] - camera.position[2],
  ]);

  /** The camera's own orthonormal frame. `up` is re-orthogonalised against `forward` each time
   *  so accumulated float error cannot shear the basis over a long flight. */
  const basis = () => {
    const f = forward();
    const u0 = camera.viewUp;
    const d = dot(u0, f);
    let u = norm([u0[0] - f[0] * d, u0[1] - f[1] * d, u0[2] - f[2] * d]);
    if (!Number.isFinite(u[0])) u = norm(cross(f, [0, 0, 1]));   // degenerate viewUp
    return { f, u, r: cross(f, u) };
  };

  /** Write a frame back to the camera. Position is untouched — this is look, not move. */
  const setFrame = (f: Vec3, u: Vec3) => {
    const fn = norm(f);
    const d = dot(u, fn);
    const un = norm([u[0] - fn[0] * d, u[1] - fn[1] * d, u[2] - fn[2] * d]);
    camera.focalPoint = [
      camera.position[0] + fn[0] * focalDist,
      camera.position[1] + fn[1] * focalDist,
      camera.position[2] + fn[2] * focalDist,
    ];
    camera.viewUp = un;
  };

  const yaw = (ang: number) => { const b = basis(); setFrame(rotate(b.f, b.u, ang), b.u); };
  const pitch = (ang: number) => {
    const b = basis();
    setFrame(rotate(b.f, b.r, ang), rotate(b.u, b.r, ang));
  };
  const roll = (ang: number) => { const b = basis(); setFrame(b.f, rotate(b.u, b.f, ang)); };

  /** Point along a direction, keeping the roll as close to the current frame as possible. */
  const setDirection = (dir: Vec3) => {
    const f = norm(dir);
    const u0 = camera.viewUp;
    const d = dot(u0, f);
    let u: Vec3 = [u0[0] - f[0] * d, u0[1] - f[1] * d, u0[2] - f[2] * d];
    if (Math.hypot(u[0], u[1], u[2]) < 1e-4) u = cross(f, refUp);   // was parallel; pick any
    setFrame(f, u);
  };

  const setCruise = (c: Cruise) => {
    if (c === cruise) return;
    cruise = c;
    opts.onState?.(cruise);
  };

  // ---- look: left-drag ------------------------------------------------------------------
  let dragging = false, lastX = 0, lastY = 0;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // Shift+click belongs to the host (target picking / crosshair), not to look-drag.
    if (e.shiftKey) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (dx) yaw(-dx * lookRad);
    if (dy) pitch(-dy * lookRad);
    if (dx || dy) opts.onLook?.();
    opts.onChange?.();
    e.preventDefault();
  };
  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  // ---- keys ------------------------------------------------------------------------------
  const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Escape"]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!NAV_KEYS.has(e.key)) return;
    if (e.key === " ") {
      // Toggle; the two directions are mutually exclusive.
      const want: Cruise = e.shiftKey ? "back" : "forward";
      setCruise(cruise === want ? "stopped" : want);
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") { setCruise("stopped"); e.preventDefault(); return; }
    keys.add(e.key);
    mods.shift = e.shiftKey; mods.ctrl = e.ctrlKey || e.metaKey;
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => { keys.delete(e.key); mods.shift = e.shiftKey; mods.ctrl = e.ctrlKey || e.metaKey; };
  const onBlur = () => { keys.clear(); mods.shift = false; mods.ctrl = false; };   // held keys would otherwise stick after focus loss

  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  globalThis.addEventListener("keydown", onKeyDown);
  globalThis.addEventListener("keyup", onKeyUp);
  globalThis.addEventListener("blur", onBlur);

  return {
    cruise: () => cruise,
    setCruise,
    lookAlong: (dir) => { setDirection(dir); opts.onChange?.(); },
    tick(dtSec) {
      let moved = false;
      const dt = Math.min(dtSec, 0.1);   // clamp: a long stall must not teleport the camera

      // up/down = travel along the view axis; left/right = yaw, +shift pitch, +ctrl roll.
      let manualStep = 0;
      if (keys.has("ArrowUp")) manualStep += speed * dt;
      if (keys.has("ArrowDown")) manualStep -= speed * dt;
      const turnAmt = turn * dt;
      if (keys.has("ArrowLeft") || keys.has("ArrowRight")) {
        const sign = keys.has("ArrowLeft") ? 1 : -1;
        if (mods.ctrl) roll(turnAmt * sign);
        else if (mods.shift) pitch(turnAmt * sign);
        else yaw(turnAmt * sign);
        opts.onLook?.();
        moved = true;
      }
      if (manualStep !== 0) {
        const f = forward();
        const dir: Vec3 = manualStep > 0 ? f : [-f[0], -f[1], -f[2]];
        const room = opts.clearance ? opts.clearance(dir) - margin : Infinity;
        const step = Math.max(0, Math.min(Math.abs(manualStep), room));
        if (step > 0) {
          camera.position = [
            camera.position[0] + dir[0] * step,
            camera.position[1] + dir[1] * step,
            camera.position[2] + dir[2] * step,
          ];
          setDirection(f);
          moved = true;
        }
      }

      if (cruise !== "stopped") {
        const f = forward();
        const sign = cruise === "forward" ? 1 : -1;
        const dir: Vec3 = [f[0] * sign, f[1] * sign, f[2] * sign];
        const want = speed * dt;
        // Rails: clamp to the free distance. NOTE this does not clear the cruise — see header.
        const room = opts.clearance ? opts.clearance(dir) - margin : Infinity;
        const step = Math.max(0, Math.min(want, room));
        if (step > 0) {
          camera.position = [
            camera.position[0] + dir[0] * step,
            camera.position[1] + dir[1] * step,
            camera.position[2] + dir[2] * step,
          ];
          setDirection(f);   // keep the focal point the same distance ahead
          moved = true;
        }
      }
      if (moved) opts.onChange?.();
      return moved;
    },
    detach() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      globalThis.removeEventListener("keydown", onKeyDown);
      globalThis.removeEventListener("keyup", onKeyUp);
      globalThis.removeEventListener("blur", onBlur);
      keys.clear();
    },
  };
}
