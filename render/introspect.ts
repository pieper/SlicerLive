// window.__slicerlive — the automation/introspection hook for the Slicer<->SlicerLive
// A/B harness. Lets the CDP driver read and set exact state (camera, planes, volume
// geometry) as NUMBERS instead of inferring behavior from screenshots, and keeps a log
// of interaction events so we can prove which binding fired and what it did.
//
// Deliberately dependency-free and demo-agnostic: each browser demo calls
// installIntrospection({...}) with whatever it can expose.

import type { Vec3 } from "./mat4.ts";

/** Camera state in BOTH the demo's orbit parameters and the concrete VTK-comparable form. */
export interface CameraState {
  /** orbit params the demo actually stores */
  azimuth: number;
  elevation: number;
  distance: number;
  /** the values handed to the renderer — directly comparable to a vtkCamera */
  position: Vec3;      // eye        (vtkCamera GetPosition)
  focalPoint: Vec3;    // center     (vtkCamera GetFocalPoint)
  viewUp: Vec3;        // up         (vtkCamera GetViewUp)
  viewAngle: number;   // fovy, deg  (vtkCamera GetViewAngle)
  parallelScale?: number;
}

export interface PlaneState { orient: string; offset01: number; /** RAS mm along the plane normal */ offsetMm?: number }

export interface VolumeState {
  name: string;
  dims: [number, number, number];
  ijkToRAS: number[];
  rasLo: Vec3;
  rasHi: Vec3;
  window?: number;
  level?: number;
}

export interface IntrospectionApi {
  getCamera(): CameraState;
  /** Set camera by orbit params and/or explicit position/focalPoint/viewUp. Re-renders. */
  setCamera(p: Partial<CameraState>): void;
  getPlanes?(): Record<string, PlaneState>;
  setPlane?(cell: string, offset01: number): void;
  getVolume?(): VolumeState;
  /** Map a view (u,v in [0,1]) in a named MPR cell to a voxel index — the picking path. */
  viewToVoxel?(cell: string, u: number, v: number): [number, number, number];
  render?(): void;
  /** Extra demo-specific state (e.g. nnLive click list, mask voxel count). */
  extra?(): Record<string, unknown>;
}

interface LogEntry { t: number; kind: string; detail: Record<string, unknown> }

export interface SlicerLiveHook extends IntrospectionApi {
  readonly ready: boolean;
  log: LogEntry[];
  logEvent(kind: string, detail?: Record<string, unknown>): void;
  clearLog(): void;
  /** Everything at once — one CDP round-trip for a full state snapshot. */
  snapshot(): Record<string, unknown>;
}

const LOG_MAX = 500;

/** Install window.__slicerlive. Safe to call once per demo after the scene is built. */
export function installIntrospection(api: IntrospectionApi): SlicerLiveHook {
  const log: LogEntry[] = [];
  const hook: SlicerLiveHook = {
    ...api,
    ready: true,
    log,
    logEvent(kind, detail = {}) {
      log.push({ t: Math.round(performance.now()), kind, detail });
      if (log.length > LOG_MAX) log.shift();
    },
    clearLog() { log.length = 0; },
    snapshot() {
      const s: Record<string, unknown> = { camera: api.getCamera() };
      try { if (api.getPlanes) s.planes = api.getPlanes(); } catch (e) { s.planesErr = String(e); }
      try { if (api.getVolume) s.volume = api.getVolume(); } catch (e) { s.volumeErr = String(e); }
      try { if (api.extra) s.extra = api.extra(); } catch (e) { s.extraErr = String(e); }
      s.logCount = log.length;
      return s;
    },
  };
  (globalThis as unknown as { __slicerlive: SlicerLiveHook }).__slicerlive = hook;
  return hook;
}
