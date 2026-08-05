// render/device.ts
async function initDevice() {
  const gpu = navigator.gpu;
  if (!gpu) throw new Error("WebGPU not available (need Chrome/Edge/Safari or Deno --unstable-webgpu)");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter");
  const want = ["float32-filterable", "timestamp-query"].filter((f) => adapter.features.has(f));
  const lim = adapter.limits;
  const requiredLimits = {};
  const raise = (k) => {
    const v = lim[k];
    if (typeof v === "number") requiredLimits[k] = v;
  };
  raise("maxBufferSize");
  raise("maxStorageBufferBindingSize");
  raise("maxTextureDimension3D");
  const device = await adapter.requestDevice({ requiredFeatures: want, requiredLimits });
  return { adapter, device, features: new Set(want) };
}

// render/vtk-camera.ts
var sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
var add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
var scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
var cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
var dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
var norm = (a) => Math.hypot(a[0], a[1], a[2]);
var normalize = (a) => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
function rotateAboutAxis(v, axis, deg) {
  const k = normalize(axis);
  const t = deg * Math.PI / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const kv = cross(k, v);
  const kd = dot(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c)
  ];
}
var VtkCamera = class _VtkCamera {
  position;
  focalPoint;
  viewUp;
  viewAngle;
  // degrees (vtkCamera default 30)
  parallelProjection = false;
  parallelScale = 1;
  constructor(position = [0, 0, 1], focalPoint = [0, 0, 0], viewUp = [0, 1, 0], viewAngle = 30) {
    this.position = [...position];
    this.focalPoint = [...focalPoint];
    this.viewUp = [...viewUp];
    this.viewAngle = viewAngle;
  }
  /** Slicer's default 3D camera (vtkMRMLCameraNode): (0,500,0) -> origin, +S up, 30 deg. */
  static slicerDefault() {
    return new _VtkCamera([0, 500, 0], [0, 0, 0], [0, 0, 1], 30);
  }
  clone() {
    const c = new _VtkCamera(this.position, this.focalPoint, this.viewUp, this.viewAngle);
    c.parallelProjection = this.parallelProjection;
    c.parallelScale = this.parallelScale;
    return c;
  }
  get distance() {
    return norm(sub(this.focalPoint, this.position));
  }
  /** normalize(focalPoint - position) — vtkCamera::DirectionOfProjection. */
  get directionOfProjection() {
    return normalize(sub(this.focalPoint, this.position));
  }
  /** Rows of the view transform, per vtkTransform::SetupCamera. */
  basis(viewUp = this.viewUp) {
    const back = normalize(sub(this.position, this.focalPoint));
    const right = normalize(cross(viewUp, back));
    const up = cross(back, right);
    return { right, up, back };
  }
  /** vtkCamera::Azimuth — rotate position about viewUp through the focal point. */
  azimuth(deg) {
    const rel = sub(this.position, this.focalPoint);
    this.position = add(this.focalPoint, rotateAboutAxis(rel, this.viewUp, deg));
  }
  /** vtkCamera::Elevation — rotate position about -right through the focal point.
   *  Returns the rotated view-up VTK uses internally (see class comment); callers that
   *  mirror Slicer follow with orthogonalizeViewUp(rotatedUp). */
  elevation(deg) {
    const axis = scale(this.basis().right, -1);
    const rotatedUp = rotateAboutAxis(this.viewUp, axis, deg);
    const rel = sub(this.position, this.focalPoint);
    this.position = add(this.focalPoint, rotateAboutAxis(rel, axis, deg));
    return rotatedUp;
  }
  /** vtkCamera::OrthogonalizeViewUp — viewUp = row1 of the view transform. */
  orthogonalizeViewUp(usingUp = this.viewUp) {
    this.viewUp = this.basis(usingUp).up;
  }
  /** vtkCamera::Dolly — factor > 1 moves the camera toward the focal point. */
  dolly(factor) {
    if (factor <= 0) return;
    if (this.parallelProjection) {
      this.parallelScale = this.parallelScale / factor;
      return;
    }
    const d = this.distance / factor;
    const dop = this.directionOfProjection;
    this.position = sub(this.focalPoint, scale(dop, d));
  }
  /** Translate both position and focal point (used by pan). */
  translate(v) {
    this.position = add(this.position, v);
    this.focalPoint = add(this.focalPoint, v);
  }
  /** Half-height of the view plane at the focal point (perspective). */
  focalPlaneHalfHeight() {
    return this.parallelProjection ? this.parallelScale : this.distance * Math.tan(this.viewAngle * Math.PI / 360);
  }
  /** Pan by a display-space delta, moving the world under the cursor 1:1 at focal depth.
   *  Equivalent to vtkMRMLCameraWidget::ProcessTranslate's focal-depth unprojection, but
   *  expressed directly in the camera basis (exact for a centred perspective view).
   *  dxDisplay/dyDisplay are in VTK display convention (y UP). */
  panByDisplayDelta(dxDisplay, dyDisplay, viewportWidth, viewportHeight) {
    const halfH = this.focalPlaneHalfHeight();
    const mmPerPixel = 2 * halfH / viewportHeight;
    const { right, up } = this.basis();
    const motion = add(scale(right, -dxDisplay * mmPerPixel), scale(up, -dyDisplay * mmPerPixel));
    this.translate(motion);
  }
  /** Project a world (RAS) point to display pixels (y DOWN, origin top-left) for a w×h viewport.
   *  Vertical-FOV perspective matching SceneRenderer.setCamera (perspectiveZO(fovy, w/h)). `depth`
   *  is the distance along the view direction (>0 in front of the camera). Used to hit-test
   *  screen-space markup glyphs. */
  worldToDisplay(p, w, h) {
    const { right, up } = this.basis();
    const dop = this.directionOfProjection;
    const rel = sub(p, this.position);
    const depth = dot(rel, dop);
    const halfH = Math.max(1e-6, depth) * Math.tan(this.viewAngle * Math.PI / 360);
    const aspect = w / h;
    const ndcx = dot(rel, right) / (halfH * aspect);
    const ndcy = dot(rel, up) / halfH;
    return { x: (ndcx * 0.5 + 0.5) * w, y: (0.5 - ndcy * 0.5) * h, depth };
  }
  /** Inverse of worldToDisplay at a FIXED view-depth: the world point under display pixel (x,y)
   *  lying in the plane perpendicular to the view at `depth`. Dragging a 3D handle in this plane
   *  keeps its distance from the camera, so it tracks the cursor without depth ambiguity. */
  displayToWorldAtDepth(x, y, depth, w, h) {
    const { right, up } = this.basis();
    const dop = this.directionOfProjection;
    const halfH = Math.max(1e-6, depth) * Math.tan(this.viewAngle * Math.PI / 360);
    const aspect = w / h;
    const ndcx = x / w * 2 - 1;
    const ndcy = 1 - y / h * 2;
    const offset = add(scale(right, ndcx * halfH * aspect), scale(up, ndcy * halfH));
    return add(add(this.position, scale(dop, depth)), offset);
  }
  /** vtkCamera-comparable snapshot for the harness. */
  state() {
    return {
      position: [...this.position],
      focalPoint: [...this.focalPoint],
      viewUp: [...this.viewUp],
      viewAngle: this.viewAngle,
      distance: this.distance
    };
  }
};

// render/vtk-interactor.ts
var MOTION_FACTOR = 10;
var MOUSE_WHEEL_MOTION_FACTOR = 1;
function actionForButton(button, m = {}) {
  const shift = !!m.shift, ctrl = !!m.ctrl, alt = !!m.alt;
  if (button === 0) {
    if (shift && ctrl) return "scale";
    if (ctrl) return "spin";
    if (shift) return "translate";
    return "rotate";
  }
  if (button === 1) return "translate";
  if (button === 2) return "scale";
  return "none";
}
var CameraInteractor = class _CameraInteractor {
  camera;
  action = "none";
  prev = null;
  // previous position, VTK display coords
  onChange;
  constructor(camera, onChange) {
    this.camera = camera;
    this.onChange = onChange;
  }
  /** Convert browser (cssX, cssY within the view) to VTK display coords (y up). */
  static toDisplay(cssX, cssY, height) {
    return [cssX, height - cssY];
  }
  start(button, cssX, cssY, height, m = {}) {
    this.action = actionForButton(button, m);
    this.prev = _CameraInteractor.toDisplay(cssX, cssY, height);
  }
  end() {
    this.action = "none";
    this.prev = null;
  }
  /** Mouse move while dragging. width/height are the view size in CSS pixels. */
  move(cssX, cssY, width, height) {
    if (this.action === "none" || !this.prev) return;
    const [x, y] = _CameraInteractor.toDisplay(cssX, cssY, height);
    const dx = x - this.prev[0];
    const dy = y - this.prev[1];
    if (dx === 0 && dy === 0) return;
    switch (this.action) {
      case "rotate":
        this.rotate(dx, dy, width, height);
        break;
      case "translate":
        this.camera.panByDisplayDelta(dx, dy, width, height);
        break;
      case "scale":
        this.scale(dy, height);
        break;
      case "spin":
        this.spin(x, y, this.prev[0], this.prev[1], width, height);
        break;
    }
    this.prev = [x, y];
    this.onChange?.();
  }
  /** vtkMRMLCameraWidget::ProcessRotate */
  rotate(dx, dy, width, height) {
    const deltaAzimuth = -20 / width;
    const deltaElevation = -20 / height;
    const rxf = dx * deltaAzimuth * MOTION_FACTOR;
    const ryf = dy * deltaElevation * MOTION_FACTOR;
    this.camera.azimuth(rxf);
    const rotatedUp = this.camera.elevation(ryf);
    this.camera.orthogonalizeViewUp(rotatedUp);
  }
  /** vtkMRMLCameraWidget::ProcessScale — note the sign flip vs plain VTK. */
  scale(dy, height) {
    const centerY = height / 2;
    const dyf = MOTION_FACTOR * dy / centerY;
    this.camera.dolly(Math.pow(1.1, -dyf));
  }
  /** vtkMRMLCameraWidget::ProcessSpin — roll about the view plane normal. */
  spin(x, y, px, py, width, height) {
    const cx = width / 2, cy = height / 2;
    const newAngle = Math.atan2(y - cy, x - cx) * 180 / Math.PI;
    const oldAngle = Math.atan2(py - cy, px - cx) * 180 / Math.PI;
    this.roll(newAngle - oldAngle);
  }
  /** vtkCamera::Roll — rotate viewUp about the direction of projection. */
  roll(deg) {
    const cam = this.camera;
    const axis = cam.directionOfProjection;
    const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const v = cam.viewUp;
    const k = axis;
    const kv = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
    const kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
    cam.viewUp = [
      v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
      v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
      v[2] * c + kv[2] * s + k[2] * kd * (1 - c)
    ];
    cam.orthogonalizeViewUp();
    this.onChange?.();
  }
  /** Mouse wheel. `forward` = wheel away from the user = zoom in. */
  wheel(forward) {
    const e = 0.2 * MOTION_FACTOR * MOUSE_WHEEL_MOTION_FACTOR;
    this.camera.dolly(Math.pow(1.1, forward ? e : -e));
    this.onChange?.();
  }
};

// render/demos/camera-control.ts
function attachCameraControls(canvas, camera, opts = {}) {
  const interactor = new CameraInteractor(camera, opts.onChange);
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.style.touchAction = "none";
  const docEl = (canvas.ownerDocument ?? document).documentElement;
  if (docEl) docEl.style.overscrollBehavior = "none";
  canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  const pointers = /* @__PURE__ */ new Map();
  let pinch = null;
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(b.x - a.x, b.y - a.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    const { x, y } = local(e);
    pointers.set(e.pointerId, { x, y });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 1) {
      interactor.start(e.button, x, y, canvas.clientHeight, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });
      opts.onLog?.("cameraStart", { action: interactor.action, x, y, button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey });
    } else if (pointers.size === 2) {
      interactor.end();
      pinch = pinchState();
    }
  });
  const endPointer = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    canvas.releasePointerCapture?.(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {
      const p = [...pointers.values()][0];
      interactor.start(0, p.x, p.y, canvas.clientHeight, { shift: false, ctrl: false, alt: false });
    } else if (pointers.size === 0) {
      interactor.end();
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const { x, y } = local(e);
    pointers.set(e.pointerId, { x, y });
    if (pointers.size >= 2) {
      const p = pinchState();
      if (pinch) {
        if (p.dist > 0 && pinch.dist > 0) camera.dolly(p.dist / pinch.dist);
        camera.panByDisplayDelta(p.mx - pinch.mx, p.my - pinch.my, canvas.clientWidth, canvas.clientHeight);
        opts.onChange?.();
      }
      pinch = p;
    } else if (interactor.action !== "none") {
      interactor.move(x, y, canvas.clientWidth, canvas.clientHeight);
    }
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    interactor.wheel(e.deltaY < 0);
    opts.onLog?.("cameraWheel", { deltaY: e.deltaY, distance: camera.distance });
  }, { passive: false });
  return interactor;
}
function framedCamera(center, radius, distMul = 2.6) {
  return new VtkCamera(
    [center[0], center[1] + radius * distMul, center[2]],
    [...center],
    [0, 0, 1],
    30
  );
}

// render/budget-controller.ts
var BudgetController = class {
  budgetPx;
  targetMs;
  minPx;
  maxPx;
  constructor(opts = {}) {
    this.targetMs = opts.targetMs ?? 16;
    this.minPx = opts.minPx ?? 3e4;
    this.maxPx = opts.maxPx ?? 8e6;
    this.budgetPx = opts.startPx ?? 35e4;
  }
  /** Nudge the budget toward hitting targetMs. Multiplicative, clamped per step (0.8–1.25×) so the
   *  loop is stable, and bounded to [minPx, maxPx]. Faster-than-target grows it; slower shrinks it. */
  update(measuredMs) {
    if (!(measuredMs > 0) || !Number.isFinite(measuredMs)) return;
    const adj = Math.max(0.35, Math.min(1.2, this.targetMs / measuredMs));
    this.budgetPx = Math.max(this.minPx, Math.min(this.maxPx, this.budgetPx * adj));
  }
  /** Resolution scale for a `w×h` view: sqrt(budget / area), clamped to [0.25, 1]. 1 when the view
   *  already fits the budget (small window); a fraction for a big/retina window under load. */
  scale(w, h) {
    const area = Math.max(1, w * h);
    return Math.max(0.25, Math.min(1, Math.sqrt(this.budgetPx / area)));
  }
};

// render/demos/accum-loop.ts
function mountAdaptiveLoop(opts) {
  const target = opts.target ?? 32;
  const idleGap = opts.idleGapMs ?? 120;
  const paced = () => Promise.race([
    new Promise((r) => requestAnimationFrame(() => r())),
    new Promise((r) => setTimeout(r, 33))
  ]);
  const sync = opts.sync ?? (() => Promise.resolve());
  let running = false, stopped = false, lastKick = -1e12, wasMoving = false;
  const step = () => {
    if (performance.now() - lastKick < idleGap) {
      opts.renderMoving();
      wasMoving = true;
      return true;
    }
    if (wasMoving) {
      wasMoving = false;
      opts.renderSettled(true);
      return true;
    }
    if (opts.count() < target) {
      opts.renderSettled(false);
      return true;
    }
    return false;
  };
  const run = async () => {
    running = true;
    stopped = false;
    while (!stopped && step()) await Promise.all([sync(), paced()]);
    running = false;
  };
  return {
    kick() {
      lastKick = performance.now();
      if (!running) run();
    },
    // run() renders the 1st frame synchronously
    stop() {
      stopped = true;
    }
  };
}
function mountAdaptive3d(opts) {
  const budget = new BudgetController({ targetMs: opts.targetMs ?? 16 });
  const DBG = typeof location !== "undefined" && new URLSearchParams(location.search).has("perf");
  let dbgN = 0, dbgMoving = 0, dbgSettled = 0, dbgLast = 0;
  const dbgTick = (kind, ms, s) => {
    if (!DBG) return;
    dbgN++;
    if (kind === "mov") dbgMoving += ms;
    else dbgSettled += ms;
    const now = performance.now();
    if (now - dbgLast > 500) {
      console.log(`[perf] mov=${dbgMoving.toFixed(0)}ms/${dbgN}f settled=${dbgSettled.toFixed(0)}ms lastScale=${s.toFixed(2)} last=${ms.toFixed(1)}ms`);
      dbgLast = now;
      dbgMoving = dbgSettled = dbgN = 0;
    }
  };
  const movingCap = opts.movingScaleCap ?? 1;
  const renderMoving = () => {
    const sc = opts.scene();
    if (!sc) return;
    const { w: vw, h: vh } = opts.size();
    if (!vw || !vh) return;
    const s = Math.min(movingCap, budget.scale(vw, vh)), t0 = performance.now();
    if (s > 0.98) {
      opts.setCamera(sc, vw, vh);
      sc.renderToView(opts.view(), vw, vh);
    } else {
      const rw = Math.max(16, Math.round(vw * s)), rh = Math.max(16, Math.round(vh * s));
      opts.setCamera(sc, rw, rh);
      sc.renderUpscaled(opts.view(), rw, rh, vw, vh);
    }
    opts.gpu.device.queue.onSubmittedWorkDone().then(() => {
      const ms = performance.now() - t0;
      budget.update(ms);
      dbgTick("mov", ms, s);
    });
    opts.onFrame?.();
  };
  const renderSettled = (reset) => {
    const sc = opts.scene();
    if (!sc) return;
    const { w: vw, h: vh } = opts.size();
    if (!vw || !vh) return;
    const t0 = performance.now();
    opts.setCamera(sc, vw, vh);
    sc.renderAccum(opts.view(), vw, vh, reset);
    if (DBG) opts.gpu.device.queue.onSubmittedWorkDone().then(() => dbgTick("set", performance.now() - t0, 1));
    opts.onFrame?.();
  };
  const loop = mountAdaptiveLoop({
    renderMoving,
    renderSettled,
    count: () => opts.scene()?.accumCount() ?? 1e9,
    target: opts.target ?? 24,
    idleGapMs: opts.idleGapMs,
    sync: () => opts.gpu.device.queue.onSubmittedWorkDone()
    // GPU-paced: no backlog, input preempts
  });
  let kickN = 0, kickLast = 0;
  const draw = () => {
    if (DBG) {
      kickN++;
      const now = performance.now();
      if (now - kickLast > 500) {
        console.log(`[perf] kicks=${kickN} in 500ms`);
        kickN = 0;
        kickLast = now;
      }
    }
    loop.kick();
  };
  return { draw, budget, renderSettled, renderMoving, loop };
}

// render/mat4.ts
function identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
function multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}
function perspectiveZO(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[11] = -1;
  m[10] = far / (near - far);
  m[14] = far * near / (near - far);
  return m;
}
function lookAt(eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl;
  zy /= zl;
  zz /= zl;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  let xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx;
  m[4] = xy;
  m[8] = xz;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[1] = yx;
  m[5] = yy;
  m[9] = yz;
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[2] = zx;
  m[6] = zy;
  m[10] = zz;
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}
function invert(a) {
  const m = a;
  const b00 = m[0] * m[5] - m[1] * m[4], b01 = m[0] * m[6] - m[2] * m[4];
  const b02 = m[0] * m[7] - m[3] * m[4], b03 = m[1] * m[6] - m[2] * m[5];
  const b04 = m[1] * m[7] - m[3] * m[5], b05 = m[2] * m[7] - m[3] * m[6];
  const b06 = m[8] * m[13] - m[9] * m[12], b07 = m[8] * m[14] - m[10] * m[12];
  const b08 = m[8] * m[15] - m[11] * m[12], b09 = m[9] * m[14] - m[10] * m[13];
  const b10 = m[9] * m[15] - m[11] * m[13], b11 = m[10] * m[15] - m[11] * m[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return identity();
  det = 1 / det;
  const o = new Float32Array(16);
  o[0] = (m[5] * b11 - m[6] * b10 + m[7] * b09) * det;
  o[1] = (m[2] * b10 - m[1] * b11 - m[3] * b09) * det;
  o[2] = (m[13] * b05 - m[14] * b04 + m[15] * b03) * det;
  o[3] = (m[10] * b04 - m[9] * b05 - m[11] * b03) * det;
  o[4] = (m[6] * b08 - m[4] * b11 - m[7] * b07) * det;
  o[5] = (m[0] * b11 - m[2] * b08 + m[3] * b07) * det;
  o[6] = (m[14] * b02 - m[12] * b05 - m[15] * b01) * det;
  o[7] = (m[8] * b05 - m[10] * b02 + m[11] * b01) * det;
  o[8] = (m[4] * b10 - m[5] * b08 + m[7] * b06) * det;
  o[9] = (m[1] * b08 - m[0] * b10 - m[3] * b06) * det;
  o[10] = (m[12] * b04 - m[13] * b02 + m[15] * b00) * det;
  o[11] = (m[9] * b02 - m[8] * b04 - m[11] * b00) * det;
  o[12] = (m[5] * b07 - m[4] * b09 - m[6] * b06) * det;
  o[13] = (m[0] * b09 - m[1] * b07 + m[2] * b06) * det;
  o[14] = (m[13] * b01 - m[12] * b03 - m[14] * b00) * det;
  o[15] = (m[8] * b03 - m[9] * b01 + m[10] * b00) * det;
  return o;
}
function patientToTexture(dims, spacing, center = [0, 0, 0]) {
  const m = new Float32Array(16);
  for (let a = 0; a < 3; a++) {
    const s = 1 / (spacing[a] * dims[a]);
    m[a * 4 + a] = s;
    m[12 + a] = 0.5 - center[a] * s;
  }
  m[15] = 1;
  return m;
}
function volumeAABB(dims, spacing, center = [0, 0, 0]) {
  const ext = [dims[0] * spacing[0] / 2, dims[1] * spacing[1] / 2, dims[2] * spacing[2] / 2];
  return [
    [center[0] - ext[0], center[1] - ext[1], center[2] - ext[2]],
    [center[0] + ext[0], center[1] + ext[1], center[2] + ext[2]]
  ];
}
function transpose4(m) {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = m[r * 4 + c];
  return o;
}
function patientToTextureFromIjkToRAS(ijkToRAS, dims) {
  return invert(texToRASFromIjkToRAS(ijkToRAS, dims));
}
function texToRASFromIjkToRAS(ijkToRAS, dims) {
  const M = transpose4(ijkToRAS);
  const A = new Float32Array(16);
  for (let a = 0; a < 3; a++) {
    A[a * 4 + a] = dims[a];
    A[12 + a] = -0.5;
  }
  A[15] = 1;
  return multiply(M, A);
}
function volumeAABBFromIjkToRAS(ijkToRAS, dims) {
  const t2r = texToRASFromIjkToRAS(ijkToRAS, dims);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const u = c & 1, v = c >> 1 & 1, w = c >> 2 & 1;
    for (let r = 0; r < 3; r++) {
      const p = t2r[r] * u + t2r[4 + r] * v + t2r[8 + r] * w + t2r[12 + r];
      if (p < lo[r]) lo[r] = p;
      if (p > hi[r]) hi[r] = p;
    }
  }
  return [lo, hi];
}
function spacingFromIjkToRAS(ijkToRAS) {
  const col = (c) => Math.hypot(ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]);
  return [col(0), col(1), col(2)];
}

// render/scene-renderer.ts
var DEFAULT_FORMAT = "rgba8unorm-srgb";
var SCENE_FLOATS = 16;
var CLIP_FLOATS = 36;
var SceneRenderer = class _SceneRenderer {
  dev;
  format;
  placed = [];
  pipeline;
  sampler;
  camBuf;
  matBuf;
  mat;
  bind;
  // PICK pass: a 1x1 ray-trace that reuses the field compositing to find the RAS point where
  // front-to-back opacity first crosses 50% (Slicer's 3D volume pick). Ghost handles excluded.
  pickPipeline;
  pickBind;
  pickOff = 0;
  // mat[] offset of the pick_cursor uniform (NDC)
  pickTarget;
  // 1x1 rgba32float (wp.xyz, hit)
  pickReadBuf;
  // PRODUCER→RECONSTRUCTOR seam (docs/UNIFIED-RENDERING-PLAN.md M1). The ray-march writes the
  // premultiplied composited sample into `traceTex` (rgba32float, lossless); `resolvePipeline`
  // composites it over the background into the output view. 1:1 for now (byte-identical); the
  // resolve pass is where spatial upsample + temporal accumulation (time-averaged AA) will live.
  resolvePipeline;
  resolveBind;
  resolveBgBuf;
  traceTex;
  traceView;
  traceW = 0;
  traceH = 0;
  // TEMPORAL ACCUMULATION (M2a, docs/UNIFIED-RENDERING-PLAN.md §3). When the view is still, each
  // frame jitters the CAMERA sub-pixel (Halton, via a clip-space translation of invVP — the shader
  // is untouched, so a non-jittered frame is byte-identical) and the Reconstructor folds it into a
  // running mean, converging to a supersampled, time-averaged-AA image. Ping-pong accum + running n.
  baseInvVP = new Float32Array(16);
  // last setCamera invVP (unjittered)
  focalPx = 1;
  // last setCamera focal (view→pixels); used to keep screen-space handles view-sized under low-res trace
  accumPipeline;
  // MRT: trace + prev-accum -> new-accum + presented view
  accumBind = [void 0, void 0];
  accumUniformBuf;
  // (bg.rgb, blend)
  accumTex = [void 0, void 0];
  accumView = [void 0, void 0];
  accumPing = 0;
  accumN = 0;
  lastAccumCam = new Float32Array(16);
  // camera (invVP) of the last accumulated frame
  lastAccumValid = false;
  // false forces a reset (after a rebuild / first frame)
  streamPipeline;
  // trace -> rgba8unorm, for compact sample readback (remote)
  streamBind;
  // its OWN bind group (auto-layout differs from this.pipeline's)
  // RESOLUTION-SCALED reconstruction (M2b): while interacting, trace at a fraction of the view
  // (BudgetController) and Catmull-Rom UPSAMPLE the low-res trace to the view — the client-superres
  // ported from the Python spike. A settled view renders native + accumulates instead.
  superresPipeline;
  superresBind;
  superresBuf;
  // (traceW, traceH, viewW, viewH)
  // The moving/upscale path traces into its OWN low-res target so it never resizes/destroys the
  // full-size traceTex the accumulation bind groups reference (that sharing caused destroyed-texture
  // submits + MRT attachment-size mismatches → 3D flicker/blank during interaction).
  lowTex;
  lowView;
  lowW = 0;
  lowH = 0;
  accumW = 0;
  accumH = 0;
  /** Emit a default AABB-distance skip for fields that don't supply their own bound.
   *
   *  OFF because it MEASURED AS A NET LOSS (render/test/profile-boxskip.ts, 448², M-series):
   *      MultiVolume +8.7%   Volume+Fiducials +7.3%   Segmentation +96.5%   SingleVolume -15.5%
   *  The appealing theory — "Panoramix sits +200mm R of CTACardio, so rays spend much of the
   *  scene box outside one volume" — is true but worthless: ImageField's out-of-box sample was
   *  ALREADY nearly free (it early-returns on the texture-bounds test), so there was no per-step
   *  cost to remove. Meanwhile every field pays a box distance + horizon bookkeeping at every
   *  step it is INSIDE its box, which is most of the march since the scene box is the union of
   *  the field boxes. Fields with their own cheap early-out are hurt worst — SegmentField
   *  (`v<=0.02||v>=0.98`) nearly doubles. The lone SingleVolume win survives warm-up but has no
   *  algorithmic explanation (the box IS the scene box there, so the bound is 0 at every sample)
   *  and is almost certainly a shader-compiler/occupancy artifact — not something to bank on.
   *
   *  Kept behind a flag rather than deleted so the negative result stays reproducible, and
   *  because it may behave differently on other GPUs (NVIDIA/AMD) — re-measure before enabling.
   *  The real win for dense volumes is an occupancy grid over air INSIDE the box, not the box. */
  static boxSkip = false;
  canTime;
  clipOff = 0;
  constructor(gpu, format = DEFAULT_FORMAT) {
    this.dev = gpu.device;
    this.format = format;
    this.canTime = gpu.features.has("timestamp-query");
    this.sampler = this.dev.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.camBuf = this.dev.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.resolveBgBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const rmod = this.dev.createShaderModule({ code: this.resolveWgsl() });
    this.resolvePipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: rmod, entryPoint: "vs_resolve" },
      fragment: { module: rmod, entryPoint: "fs_resolve", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
    this.accumUniformBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const amod = this.dev.createShaderModule({ code: this.accumWgsl() });
    this.accumPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: amod, entryPoint: "vs_resolve" },
      fragment: { module: amod, entryPoint: "fs_accum", targets: [{ format: "rgba32float" }, { format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
    this.superresBuf = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const smod = this.dev.createShaderModule({ code: this.superresWgsl() });
    this.superresPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: smod, entryPoint: "vs_resolve" },
      fragment: { module: smod, entryPoint: "fs_superres", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
  }
  /** RECONSTRUCTOR (upsampling): Catmull-Rom (bicubic, 9 bilinear taps) reconstruction of the
   *  low-res premultiplied trace, composited over the background — the client-superres from the
   *  Python spike (435b28d), on WebGPU. Slight edge sharpening from the negative lobes; premultiplied
   *  so the alpha reconstructs correctly. Used only when the trace is smaller than the view. */
  superresWgsl() {
    return (
      /* wgsl */
      `
@group(0) @binding(0) var t_trace : texture_2d<f32>;
@group(0) @binding(1) var s_lin : sampler;
@group(0) @binding(2) var<uniform> u_sr : vec4<f32>;   // (traceW, traceH, viewW, viewH)
@group(0) @binding(3) var<uniform> u_bg : vec4<f32>;
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
// Catmull-Rom via 9 bilinear taps (Sigg/Hadwiger form).
fn cr(uv : vec2<f32>, texSize : vec2<f32>) -> vec4<f32> {
  let sp = uv * texSize;
  let tp1 = floor(sp - 0.5) + 0.5;
  let f = sp - tp1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let off12 = w2 / w12;
  let inv = 1.0 / texSize;
  let p0 = (tp1 - 1.0) * inv;
  let p3 = (tp1 + 2.0) * inv;
  let p12 = (tp1 + off12) * inv;
  var r = vec4<f32>(0.0);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p0.x,  p0.y),  0.0) * (w0.x  * w0.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p12.x, p0.y),  0.0) * (w12.x * w0.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p3.x,  p0.y),  0.0) * (w3.x  * w0.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p0.x,  p12.y), 0.0) * (w0.x  * w12.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p12.x, p12.y), 0.0) * (w12.x * w12.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p3.x,  p12.y), 0.0) * (w3.x  * w12.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p0.x,  p3.y),  0.0) * (w0.x  * w3.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p12.x, p3.y),  0.0) * (w12.x * w3.y);
  r += textureSampleLevel(t_trace, s_lin, vec2<f32>(p3.x,  p3.y),  0.0) * (w3.x  * w3.y);
  return r;
}
struct RV { @builtin(position) position : vec4<f32> };
@vertex
fn vs_resolve(@builtin(vertex_index) vi : u32) -> RV {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : RV; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
@fragment
fn fs_superres(v : RV) -> @location(0) vec4<f32> {
  let uv = v.position.xy / u_sr.zw;
  let s = cr(uv, u_sr.xy);
  let a = clamp(s.a, 0.0, 1.0);
  let bg = srgb2physical(u_bg.rgb);
  return vec4<f32>(mix(bg, s.rgb, a), 1.0);
}`
    );
  }
  /** Accumulating RECONSTRUCTOR: fold this frame's traced sample into the running mean (blend =
   *  1/n; blend=1 on reset → mean=this frame) and present it over the background. MRT so one pass
   *  updates the accumulation texture AND the swap-chain view. Frame N jitters the ray sub-pixel,
   *  so the mean over N frames is a supersampled, time-averaged-AA image (still camera). */
  accumWgsl() {
    return (
      /* wgsl */
      `
@group(0) @binding(0) var t_trace : texture_2d<f32>;
@group(0) @binding(1) var t_accum : texture_2d<f32>;
@group(0) @binding(2) var<uniform> u_ra : vec4<f32>;   // (bg.r, bg.g, bg.b, blend)
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
struct RV { @builtin(position) position : vec4<f32> };
@vertex
fn vs_resolve(@builtin(vertex_index) vi : u32) -> RV {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : RV; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
struct FO { @location(0) accum : vec4<f32>, @location(1) present : vec4<f32> };
@fragment
fn fs_accum(v : RV) -> FO {
  let p = vec2<i32>(v.position.xy);
  let cur = textureLoad(t_trace, p, 0);
  let prev = textureLoad(t_accum, p, 0);
  let acc = mix(prev, cur, u_ra.w);        // blend=1 on reset -> acc = cur
  let bg = srgb2physical(u_ra.rgb);
  var o : FO;
  o.accum = acc;
  o.present = vec4<f32>(mix(bg, acc.rgb, acc.a), 1.0);
  return o;
}`
    );
  }
  /** RECONSTRUCTOR (M1: identity resolve). Composites the traced premultiplied sample over the
   *  background — the exact `mix(bg, rgb, a)` the fused fs_main used. `textureLoad` at integer
   *  coords is a 1:1 fetch (no filtering), so the output is byte-identical to the fused path.
   *  M2 replaces this with a spatial-upsample + temporal-accumulate resolve. */
  resolveWgsl() {
    return (
      /* wgsl */
      `
@group(0) @binding(0) var t_trace : texture_2d<f32>;
@group(0) @binding(1) var<uniform> u_bg : vec4<f32>;
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
struct RV { @builtin(position) position : vec4<f32> };
@vertex
fn vs_resolve(@builtin(vertex_index) vi : u32) -> RV {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : RV; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
@fragment
fn fs_resolve(v : RV) -> @location(0) vec4<f32> {
  let s = textureLoad(t_trace, vec2<i32>(v.position.xy), 0);
  let bg = srgb2physical(u_bg.rgb);
  return vec4<f32>(mix(bg, s.rgb, s.a), 1.0);
}`
    );
  }
  /** (Re)allocate the trace target + resolve bind group when the view size changes. */
  ensureTrace(width, height) {
    if (this.traceTex && this.traceW === width && this.traceH === height) return;
    this.traceTex?.destroy();
    this.traceTex = this.dev.createTexture({
      size: [width, height],
      format: "rgba32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.traceView = this.traceTex.createView();
    this.traceW = width;
    this.traceH = height;
    this.resolveBind = this.dev.createBindGroup({
      layout: this.resolvePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.traceView }, { binding: 1, resource: { buffer: this.resolveBgBuf } }]
    });
  }
  /** (Re)allocate the low-res trace target + superres bind group when the moving render size changes.
   *  Separate from traceTex so a moving frame never disturbs the accumulation textures. */
  ensureLow(width, height) {
    if (this.lowTex && this.lowW === width && this.lowH === height) return;
    this.lowTex?.destroy();
    this.lowTex = this.dev.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.lowView = this.lowTex.createView();
    this.lowW = width;
    this.lowH = height;
    this.superresBind = this.dev.createBindGroup({
      layout: this.superresPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.lowView },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.superresBuf } },
        { binding: 3, resource: { buffer: this.resolveBgBuf } }
      ]
    });
  }
  /** Adaptive (moving-frame) render: trace at `renderW×renderH` and Catmull-Rom upsample to the
   *  `viewW×viewH` output. The caller MUST have set the camera size to renderW×renderH (so the
   *  low-res rays fill the same frustum). Single frame, no accumulation — use while interacting;
   *  switch to renderAccum when the view settles. */
  renderUpscaled(view, renderW, renderH, viewW, viewH) {
    this.ensureLow(renderW, renderH);
    this.flush();
    this.dev.queue.writeBuffer(this.camBuf, 72, new Float32Array([this.focalPx * (viewH / renderH)]));
    this.dev.queue.writeBuffer(this.superresBuf, 0, new Float32Array([renderW, renderH, viewW, viewH]));
    this.dev.queue.writeBuffer(this.resolveBgBuf, 0, this.mat.subarray(12, 16));
    const enc = this.dev.createCommandEncoder();
    const tp = enc.beginRenderPass({ colorAttachments: [{ view: this.lowView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    tp.setPipeline(this.pipeline);
    tp.setBindGroup(0, this.bind);
    tp.draw(3);
    tp.end();
    const sp = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    sp.setPipeline(this.superresPipeline);
    sp.setBindGroup(0, this.superresBind);
    sp.draw(3);
    sp.end();
    this.dev.queue.submit([enc.finish()]);
  }
  /** Encode trace (producer) + resolve (reconstructor) into `enc`, output to `outView`. */
  encodeFrame(enc, outView) {
    const tp = enc.beginRenderPass({ colorAttachments: [{ view: this.traceView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    tp.setPipeline(this.pipeline);
    tp.setBindGroup(0, this.bind);
    tp.draw(3);
    tp.end();
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: outView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    rp.setPipeline(this.resolvePipeline);
    rp.setBindGroup(0, this.resolveBind);
    rp.draw(3);
    rp.end();
  }
  /** (Re)allocate the ping-pong accumulation targets + their bind groups on a size change. Tracks its
   *  OWN size and always rebuilds accumBind against the current traceView (which ensureTrace, called
   *  first in renderAccum, has just refreshed) — so the bind never dangles on a destroyed trace. */
  ensureAccum(width, height) {
    if (this.accumTex[0] && this.accumW === width && this.accumH === height) return;
    this.accumW = width;
    this.accumH = height;
    for (let k = 0; k < 2; k++) {
      this.accumTex[k]?.destroy();
      this.accumTex[k] = this.dev.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.accumView[k] = this.accumTex[k].createView();
    }
    for (let k = 0; k < 2; k++) {
      this.accumBind[k] = this.dev.createBindGroup({
        layout: this.accumPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.traceView },
          { binding: 1, resource: this.accumView[k] },
          { binding: 2, resource: { buffer: this.accumUniformBuf } }
        ]
      });
    }
    this.accumN = 0;
    this.accumPing = 0;
  }
  /** Reset temporal accumulation — call when the view changes (camera move, scene edit, resize). */
  resetAccumulation() {
    this.accumN = 0;
  }
  /** Frames accumulated since the last reset (0 before the first accumulated frame). */
  accumCount() {
    return this.accumN;
  }
  /** Accumulating render: trace this frame (sub-pixel jittered) and fold it into the running mean,
   *  presenting the mean over the background. `reset` (or a view change) restarts the mean at this
   *  frame (n=1, no jitter — byte-identical to renderToView). Call repeatedly while the view is
   *  still to converge to a supersampled, time-averaged-AA image. */
  renderAccum(view, width, height, reset) {
    this.ensureTrace(width, height);
    this.ensureAccum(width, height);
    let camChanged = !this.lastAccumValid;
    const cam = this.baseInvVP;
    for (let i = 0; i < 16 && !camChanged; i++) if (cam[i] !== this.lastAccumCam[i]) camChanged = true;
    if (camChanged) reset = true;
    this.lastAccumCam.set(cam);
    this.lastAccumValid = true;
    if (reset) this.accumN = 0;
    this.accumN += 1;
    const n = this.accumN;
    if (n > 1) {
      const jx = _SceneRenderer.halton(n, 2) - 0.5, jy = _SceneRenderer.halton(n, 3) - 0.5;
      const T = new Float32Array(16);
      T[0] = T[5] = T[10] = T[15] = 1;
      T[12] = 2 * jx / width;
      T[13] = -2 * jy / height;
      this.dev.queue.writeBuffer(this.camBuf, 0, multiply(this.baseInvVP, T));
    } else {
      this.dev.queue.writeBuffer(this.camBuf, 0, this.baseInvVP);
    }
    this.flush();
    this.dev.queue.writeBuffer(this.accumUniformBuf, 0, new Float32Array([this.mat[12], this.mat[13], this.mat[14], 1 / n]));
    const prev = this.accumPing, next = 1 - this.accumPing;
    const enc = this.dev.createCommandEncoder();
    const tp = enc.beginRenderPass({ colorAttachments: [{ view: this.traceView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    tp.setPipeline(this.pipeline);
    tp.setBindGroup(0, this.bind);
    tp.draw(3);
    tp.end();
    const ap = enc.beginRenderPass({ colorAttachments: [
      { view: this.accumView[next], loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      { view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }
    ] });
    ap.setPipeline(this.accumPipeline);
    ap.setBindGroup(0, this.accumBind[prev]);
    ap.draw(3);
    ap.end();
    this.dev.queue.submit([enc.finish()]);
    this.accumPing = next;
  }
  /** (Re)build the pipeline for a set of fields. */
  build(fields) {
    const kindCount = {};
    let uoff = SCENE_FLOATS, bbase = 3;
    this.placed = fields.map((field) => {
      const slot = kindCount[field.kind] ?? 0;
      kindCount[field.kind] = slot + 1;
      const p = { field, slot, uoff, bbase };
      uoff += field.uniformFloats();
      bbase += field.bindingCount;
      return p;
    });
    this.clipOff = uoff;
    this.pickOff = uoff + CLIP_FLOATS;
    this.mat = new Float32Array(uoff + CLIP_FLOATS + 4);
    this.matBuf = this.dev.createBuffer({ size: (uoff + CLIP_FLOATS + 4) * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = this.dev.createShaderModule({ code: this.wgsl() });
    this.pipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_trace", targets: [{ format: "rgba32float" }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
    this.pickPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_pick", targets: [{ format: "rgba32float" }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
    this.streamPipeline = this.dev.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_trace", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list", cullMode: "none" }
    });
    this.bind = this.dev.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    this.streamBind = this.dev.createBindGroup({ layout: this.streamPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    if (this.pickPipeline) this.pickBind = this.dev.createBindGroup({ layout: this.pickPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    this.setBackground(0.07, 0.08, 0.12);
    const step = this.placed.length ? Math.min(...this.placed.map((p) => p.field.sampleStep())) : 1;
    this.setSampleStep(step * 0.7);
    this.recomputeBounds();
    for (const p of this.placed) p.field.fillUniforms(this.mat, p.uoff);
    this.accumN = 0;
    this.lastAccumValid = false;
  }
  wgsl() {
    const members = this.placed.map((p) => p.field.structMembers(p.slot)).join("\n");
    const decls = this.placed.map((p) => p.field.declareBindings(p.slot, p.bbase)).join("\n");
    const modifiers = this.placed.filter((p) => p.field.modifier);
    const receivers = this.placed.filter((p) => !p.field.modifier);
    const modFns = modifiers.map((p) => p.field.samplingWGSL(p.slot)).join("\n");
    const slotOf = new Map(this.placed.map((p) => [p.field, p.slot]));
    const tpFns = receivers.map((p) => {
      const tf = p.field.transform;
      const tfSlot = tf && tf.modifier ? slotOf.get(tf) : void 0;
      const body = tfSlot === void 0 ? "  return wp;" : `  return wp + displacement_grid${tfSlot}(wp);`;
      return `fn transform_point_${p.field.kind}${p.slot}(wp : vec3<f32>) -> vec3<f32> {
${body}
}`;
    }).join("\n");
    const fieldFns = receivers.map((p) => p.field.samplingWGSL(p.slot)).join("\n");
    const wf = (v) => (Number.isFinite(v) ? v : 0).toFixed(6);
    const boxSkipWGSL = (p) => {
      const [lo, hi] = p.field.aabb();
      return `
fn skip_${p.field.kind}${p.slot}(wp : vec3<f32>) -> f32 {
  let q = max(vec3<f32>(${wf(lo[0])}, ${wf(lo[1])}, ${wf(lo[2])}) - wp,
              wp - vec3<f32>(${wf(hi[0])}, ${wf(hi[1])}, ${wf(hi[2])}));
  return length(max(q, vec3<f32>(0.0)));   // 0 inside the box, exact distance outside
}`;
    };
    const ghostFields = receivers.filter((p) => p.field.ghost);
    const normalReceivers = receivers.filter((p) => !p.field.ghost);
    const clipGuard = (p, expr) => p.field.clippable === false ? expr : `if (!clipped) { ${expr} }`;
    const sampleInto = (nm, ghost) => ghost ? `let c = sample_field_${nm}(wp, rd); if (c.a > g_op) { g_op = c.a; g_col = c.rgb / max(c.a, 1e-4); }` : `let c = sample_field_${nm}(wp, rd); sum += c;`;
    const skipBranch = (p, clip, ghost = false) => {
      const nm = `${p.field.kind}${p.slot}`;
      const smp = sampleInto(nm, ghost);
      return `    if (t >= resume_${nm}) {
      let d_${nm} = max(skip_${nm}(wp) - step, 0.0);
      if (d_${nm} > 0.0) { resume_${nm} = t + d_${nm}; }
      else { ${clip ? clipGuard(p, smp) : smp} }
    }
    if (t < resume_${nm}) { jump_t = min(jump_t, resume_${nm}); } else { all_defer = false; }`;
    };
    const plainBranch = (p, clip, ghost = false) => {
      const nm = `${p.field.kind}${p.slot}`;
      const smp = sampleInto(nm, ghost);
      return `    { ${clip ? clipGuard(p, smp) : smp} all_defer = false; }`;
    };
    const normalSkippers = normalReceivers.filter((p) => !p.field.transform).filter((p) => _SceneRenderer.boxSkip || p.field.providesSkip && p.field.skipWGSL);
    const ghostSkippers = ghostFields.filter((p) => p.field.providesSkip && p.field.skipWGSL);
    const canSkip = new Set(normalSkippers.map((p) => p.field));
    const ghostCanSkip = new Set(ghostSkippers.map((p) => p.field));
    const skipFns = [
      ...normalSkippers.map((p) => p.field.providesSkip && p.field.skipWGSL ? p.field.skipWGSL(p.slot) : boxSkipWGSL(p)),
      ...ghostSkippers.map((p) => p.field.skipWGSL(p.slot))
    ].join("\n");
    const fns = [modFns, tpFns, fieldFns, skipFns].filter((s) => s.trim()).join("\n");
    const skipInit = [...normalSkippers, ...ghostSkippers].map((p) => `  var resume_${p.field.kind}${p.slot} : f32 = -1.0e30;`).join("\n");
    const dispatch = normalReceivers.map(
      (p) => canSkip.has(p.field) ? skipBranch(p, true) : plainBranch(p, true)
    ).join("\n");
    const ghostDispatch = ghostFields.map(
      (p) => ghostCanSkip.has(p.field) ? skipBranch(p, false, true) : plainBranch(p, false, true)
    ).join("\n");
    const hasGhost = ghostFields.length > 0;
    const pickDispatch = normalReceivers.map(
      (p) => `    ${clipGuard(p, `{ let c = sample_field_${p.field.kind}${p.slot}(wp, rd); sum += c; }`)}`
    ).join("\n");
    return (
      /* wgsl */
      `
struct Camera { inv_view_proj : mat4x4<f32>, size : vec4<f32>, eye : vec4<f32> };
struct Material {
  bmin : vec4<f32>,
  bmax : vec4<f32>,
  scene : vec4<f32>,   // sample_step, _, _, _
  bg : vec4<f32>,
${members}
  clip_planes : array<vec4<f32>, 8>,   // (nx, ny, nz, offset) inward; tail so field offsets are stable
  clip_count : vec4<f32>,              // (count, _, _, _)
  pick_cursor : vec4<f32>,             // (ndc_x, ndc_y, _, _) \u2014 the ray for fs_pick
};
@group(0) @binding(0) var<uniform> u_cam : Camera;
@group(0) @binding(1) var<uniform> u_material : Material;
${this.usesSampler() ? "@group(0) @binding(2) var s_lin : sampler;" : ""}
${decls}

struct Varyings { @builtin(position) position : vec4<f32> };
@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> Varyings {
  let x = select(-1.0, 3.0, vi == 1u);
  let y = select(-1.0, 3.0, vi == 2u);
  var o : Varyings; o.position = vec4<f32>(x, y, 0.0, 1.0); return o;
}
fn srgb2physical(c : vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
  return select(lo, hi, c > vec3<f32>(0.04045));
}
fn ndc_to_world(ndc : vec4<f32>) -> vec3<f32> { let w = u_cam.inv_view_proj * ndc; return w.xyz / w.w; }
fn ign(p : vec2<f32>) -> f32 { return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715)))); }
${fns}

// PRODUCER (fs_trace): march the ray and return the composited PREMULTIPLIED sample
// (integrated.rgb, integrated.a) BEFORE the background composite \u2014 a "traced pixel". The
// Reconstructor (fs_resolve / reconstructor.ts) composites it over the background. Splitting
// trace from assemble is the seam the unified local/remote pipeline turns on (see
// docs/UNIFIED-RENDERING-PLAN.md); the background composite is identical to the fused path, so
// output is byte-identical at full density. An empty slab returns transparent (0) \u2192 resolve = bg.
@fragment
fn fs_trace(v : Varyings) -> @location(0) vec4<f32> {
  let size = u_cam.size.xy;
  let ndc_x = (v.position.x / size.x) * 2.0 - 1.0;
  let ndc_y = 1.0 - (v.position.y / size.y) * 2.0;
  let ro = ndc_to_world(vec4<f32>(ndc_x, ndc_y, 0.0, 1.0));
  let rd = normalize(ndc_to_world(vec4<f32>(ndc_x, ndc_y, 1.0, 1.0)) - ro);

  let inv = vec3<f32>(1.0) / rd;
  let tb = (u_material.bmin.xyz - ro) * inv;
  let tt = (u_material.bmax.xyz - ro) * inv;
  let tmn = min(tt, tb); let tmx = max(tt, tb);
  var t_near = max(max(tmn.x, tmn.y), tmn.z);
  var t_far  = min(min(tmx.x, tmx.y), tmx.z);
  if (t_far <= t_near || t_far <= 0.0) { return vec4<f32>(0.0); }

  let step = max(u_material.scene.x, 1e-3);
  t_near = max(t_near + step, 0.0);
  t_far  = t_far - step;
  if (t_far <= t_near) { return vec4<f32>(0.0); }
  let seed = ign(v.position.xy);
  var t = t_near;
  var integrated = vec4<f32>(0.0);
  var safety : i32 = 0;
  var saturated = false;   // LATCH: once opaque, normal fields stay off even after a ghost
                           // handle dims the accumulation (else the volume behind the handle
                           // would re-opaque over it and re-bury the shine-through).
  var g_op = 0.0;          // ghost (handle) surface: max opacity along the ray (0.5 inactive /
  var g_col = vec3<f32>(0.0);  // 1.0 active) and its colour \u2014 tracked, never accumulated.
${skipInit}
  loop {
    if (t >= t_far || safety >= 5000${hasGhost ? "" : " || integrated.a >= 0.99"}) { break; }
    let js = fract(sin(dot(v.position.xy + vec2<f32>(f32(safety) * 0.7548, f32(safety) * 0.5698), vec2<f32>(12.9898, 78.233))) * 43758.5453) - 0.5; // per-(pixel,sample) jitter \u2014 frame-invariant; temporal AA rides on the sub-pixel NDC jitter (frame.xy), which is exact identity at 0
    let wp = ro + rd * (t + js * step);
    var sum = vec4<f32>(0.0);
    var all_defer = true;        // every field guarantees emptiness here -> we may leap
    var jump_t = 1.0e30;         // nearest field horizon
    var clipped = false;         // ROI clip: sample on the negative side of any active plane
    let ccount = u32(u_material.clip_count.x);
    for (var ci = 0u; ci < ccount; ci = ci + 1u) {
      let cp = u_material.clip_planes[ci];
      if (dot(wp, cp.xyz) + cp.w < 0.0) { clipped = true; break; }
    }
    // Normal fields stop being sampled once the ray is opaque (latched); GHOST fields keep
    // their skip horizons and keep going, so a handle behind an opaque region still shines
    // through and the ray LEAPS between handles on the ghost skip (early-termination kept).
${hasGhost ? "    if (integrated.a >= 0.99) { saturated = true; }\n    if (!saturated) {" : ""}
${dispatch}
      if (sum.a > 0.0) { integrated = integrated + (1.0 - integrated.a) * vec4<f32>(sum.rgb, clamp(sum.a, 0.0, 1.0)); }
${hasGhost ? "    }" : ""}
${ghostDispatch}
    if (all_defer && jump_t > t + step) { t = jump_t; } else { t = t + step; }
    safety = safety + 1;
  }
  // GHOST x-ray, applied ONCE (never compounding): the volume IN FRONT of a handle is shown
  // at residual = 1 - handle_opacity (50% for an inactive handle at opacity 0.5, 0% for an
  // active/hovered handle at opacity 1.0), then the handle (colour g_col at opacity g_op)
  // draws over it.
  if (g_op > 0.001) {
    let ga = clamp(g_op, 0.0, 1.0);
    let residual = 1.0 - ga;
    let fA = integrated.a * residual;
    integrated = vec4<f32>(integrated.rgb * residual + (1.0 - fA) * g_col * ga, fA + (1.0 - fA) * ga);
  }
  return integrated;   // premultiplied (rgb, a); resolve composites over the background
}

// PICK: trace the cursor ray (pick_cursor NDC) through the SAME field compositing and return the
// world (RAS) position where front-to-back opacity first crosses 50% \u2014 Slicer's 3D volume pick.
// Output: (wp.x, wp.y, wp.z, hit). hit=0 means the ray never reached 50% (empty/miss).
@fragment
fn fs_pick() -> @location(0) vec4<f32> {
  let ro = ndc_to_world(vec4<f32>(u_material.pick_cursor.x, u_material.pick_cursor.y, 0.0, 1.0));
  let rd = normalize(ndc_to_world(vec4<f32>(u_material.pick_cursor.x, u_material.pick_cursor.y, 1.0, 1.0)) - ro);
  let inv = vec3<f32>(1.0) / rd;
  let tb = (u_material.bmin.xyz - ro) * inv;
  let tt = (u_material.bmax.xyz - ro) * inv;
  let tmn = min(tt, tb); let tmx = max(tt, tb);
  var t_near = max(max(tmn.x, tmn.y), tmn.z);
  var t_far  = min(min(tmx.x, tmx.y), tmx.z);
  if (t_far <= t_near || t_far <= 0.0) { return vec4<f32>(0.0); }
  let step = max(u_material.scene.x, 1e-3);
  t_near = max(t_near + step, 0.0);
  t_far  = t_far - step;
  var t = t_near;
  var acc = 0.0;
  var safety : i32 = 0;
  loop {
    if (t >= t_far || safety >= 5000 || acc >= 0.5) { break; }
    let wp = ro + rd * t;
    var clipped = false;
    let ccount = u32(u_material.clip_count.x);
    for (var ci = 0u; ci < ccount; ci = ci + 1u) {
      let cp = u_material.clip_planes[ci];
      if (dot(wp, cp.xyz) + cp.w < 0.0) { clipped = true; break; }
    }
    var sum = vec4<f32>(0.0);
${pickDispatch}
    if (sum.a > 0.0) {
      let a_new = acc + (1.0 - acc) * clamp(sum.a, 0.0, 1.0);
      if (a_new >= 0.5) { return vec4<f32>(wp, 1.0); }   // 50% crossing -> the pick point
      acc = a_new;
    }
    t = t + step;
  }
  return vec4<f32>(0.0);
}`
    );
  }
  setBackground(r, g, b) {
    this.mat[12] = r;
    this.mat[13] = g;
    this.mat[14] = b;
    this.mat[15] = 1;
  }
  setSampleStep(step) {
    this.mat[8] = step;
  }
  /** Van der Corput / Halton radical inverse in `base`. */
  static halton(i, base) {
    let f = 1, r = 0;
    while (i > 0) {
      f /= base;
      r += f * (i % base);
      i = Math.floor(i / base);
    }
    return r;
  }
  /** Set up to 8 clip planes (nx,ny,nz,offset), inward-normal, keep-side `dot(wp,n)+offset>=0`.
   *  Written into the uniform tail — a Tier-A update the next flush() uploads; no rebuild. */
  setClipPlanes(planes) {
    const n = Math.min(planes.length, 8);
    for (let i = 0; i < n; i++) this.mat.set(planes[i], this.clipOff + i * 4);
    this.mat[this.clipOff + 32] = n;
  }
  clearClip() {
    this.mat[this.clipOff + 32] = 0;
  }
  /** Axis-aligned RAS crop box [lo,hi] → 6 inward planes. offset = -dot(faceOrigin, n). */
  setClipBox(lo, hi) {
    this.setClipPlanes([
      [1, 0, 0, -lo[0]],
      [-1, 0, 0, hi[0]],
      // keep lo.x <= x <= hi.x
      [0, 1, 0, -lo[1]],
      [0, -1, 0, hi[1]],
      [0, 0, 1, -lo[2]],
      [0, 0, -1, hi[2]]
    ]);
  }
  /** Scene AABB = union of field AABBs; also picks a default sample step from the smallest field extent. */
  recomputeBounds() {
    if (!this.placed.length) return;
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of this.placed) {
      const [a, b] = p.field.aabb();
      for (let i = 0; i < 3; i++) {
        mn[i] = Math.min(mn[i], a[i]);
        mx[i] = Math.max(mx[i], b[i]);
      }
    }
    this.mat[0] = mn[0];
    this.mat[1] = mn[1];
    this.mat[2] = mn[2];
    this.mat[4] = mx[0];
    this.mat[5] = mx[1];
    this.mat[6] = mx[2];
  }
  /** Tier-A interactive update: re-pack every field's uniform block into the resident
   *  material buffer WITHOUT recompiling the pipeline or rebuilding the bind group. This is
   *  the render-side of the interaction architecture (ARCHITECTURE-2026-07-24 §7): a
   *  lightweight drag — clip planes, ROI box geometry, fiducial position, TPS displacement
   *  grid — mutates node state, the field re-derives its uniforms, and the SAME per-frame
   *  flush() the renderer already does uploads them. Cost is a CPU re-pack; no shader build.
   *
   *  Also refreshes the scene AABB (which is uniform-resident), so a moved field's ray-clip
   *  bounds stay correct. REQUIRES the field SET and each field's uniformFloats() to be
   *  unchanged since build() — geometry/appearance may change, STRUCTURE may not. A structural
   *  change (add/remove a field, a field that resizes its uniform block, or a texture swap
   *  needing refreshBindings) still goes through build()/refreshBindings(). This is exactly
   *  why moving geometry must be uniform-resident, never baked into generated WGSL — see the
   *  box-skip note above and RENDER-PERFORMANCE.md. */
  syncUniforms() {
    for (const p of this.placed) p.field.fillUniforms(this.mat, p.uoff);
    this.recomputeBounds();
  }
  /** Rebuild the bind group from the fields' current resources (e.g. after a field
   *  swapped a texture) without recompiling the pipeline. Field set/structure must be unchanged. */
  refreshBindings() {
    this.bind = this.dev.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    this.streamBind = this.dev.createBindGroup({ layout: this.streamPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
    if (this.pickPipeline) this.pickBind = this.dev.createBindGroup({ layout: this.pickPipeline.getBindGroupLayout(0), entries: this.bindGroupEntries() });
  }
  /** Only fields with texture bindings use the shared sampler. `layout: "auto"` derives the
   *  layout from what the shader ACTUALLY references, so in a scene of purely procedural
   *  fields (e.g. fiducials/markups only) binding 2 is absent from the layout — supplying it
   *  anyway fails validation and the whole view silently renders nothing. Emit the sampler
   *  declaration and its bind entry under the SAME condition so the two can't drift. */
  usesSampler() {
    return this.placed.some((p) => p.field.bindingCount > 0);
  }
  bindGroupEntries() {
    const entries = [
      { binding: 0, resource: { buffer: this.camBuf } },
      { binding: 1, resource: { buffer: this.matBuf } }
    ];
    if (this.usesSampler()) entries.push({ binding: 2, resource: this.sampler });
    for (const p of this.placed) entries.push(...p.field.bindEntries(p.slot, p.bbase));
    return entries;
  }
  setCamera(eye, center, up, fovyDeg, width, height) {
    const view = lookAt(eye, center, up);
    const proj = perspectiveZO(fovyDeg * Math.PI / 180, width / height, 1, 1e5);
    const invVP = invert(multiply(proj, view));
    this.baseInvVP = invVP;
    const cam = new Float32Array(24);
    cam.set(invVP, 0);
    this.focalPx = height / 2 / Math.tan(fovyDeg * Math.PI / 360);
    cam[16] = width;
    cam[17] = height;
    cam[18] = height / 2 / Math.tan(fovyDeg * Math.PI / 360);
    cam[20] = eye[0];
    cam[21] = eye[1];
    cam[22] = eye[2];
    this.dev.queue.writeBuffer(this.camBuf, 0, cam);
  }
  flush() {
    this.dev.queue.writeBuffer(this.matBuf, 0, this.mat);
  }
  /** Ray-trace the cursor (u,v in [0,1], y down) through the composited fields and return the
   *  RAS point where front-to-back opacity first reaches 50% — Slicer's 3D volume pick. Traces
   *  whatever renders (DVR volumes, SegmentField iso shells, RGBA), EXCLUDING ghost handles.
   *  Uses the camera set by the last setCamera(); returns null if the ray never reaches 50%. */
  async pick(u, v) {
    if (!this.pickPipeline || !this.pickBind || !this.placed.length) return null;
    this.mat[this.pickOff] = u * 2 - 1;
    this.mat[this.pickOff + 1] = 1 - v * 2;
    this.flush();
    if (!this.pickTarget) {
      this.pickTarget = this.dev.createTexture({ size: [1, 1], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      this.pickReadBuf = this.dev.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.pickTarget.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    pass.setPipeline(this.pickPipeline);
    pass.setBindGroup(0, this.pickBind);
    pass.draw(3);
    pass.end();
    enc.copyTextureToBuffer({ texture: this.pickTarget }, { buffer: this.pickReadBuf, bytesPerRow: 256, rowsPerImage: 1 }, [1, 1]);
    this.dev.queue.submit([enc.finish()]);
    await this.pickReadBuf.mapAsync(GPUMapMode.READ);
    const r = new Float32Array(this.pickReadBuf.getMappedRange().slice(0, 16));
    this.pickReadBuf.unmap();
    return r[3] > 0.5 ? [r[0], r[1], r[2]] : null;
  }
  renderToView(view, width, height) {
    this.ensureTrace(width, height);
    this.flush();
    this.dev.queue.writeBuffer(this.resolveBgBuf, 0, this.mat.subarray(12, 16));
    const enc = this.dev.createCommandEncoder();
    this.encodeFrame(enc, view);
    this.dev.queue.submit([enc.finish()]);
  }
  /** Exact GPU time of the ray-march pass (median ms over `iters`), via timestamp-query.
   *  Times ONLY the render pass — no texture copy/readback — so it reflects shader cost.
   *  Returns NaN if the device lacks timestamp-query. Deno gives full-resolution timestamps;
   *  Chrome quantizes them unless cross-origin isolated, so profile headless for sharp numbers. */
  async timePass(width, height, iters = 40) {
    if (!this.canTime) return NaN;
    this.flush();
    const target = this.dev.createTexture({ size: [width, height], format: "rgba32float", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const view = target.createView();
    const qs = this.dev.createQuerySet({ type: "timestamp", count: 2 });
    const resolve = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const read = this.dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const samples = [];
    for (let i = 0; i < iters; i++) {
      const enc = this.dev.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bind);
      pass.draw(3);
      pass.end();
      enc.resolveQuerySet(qs, 0, 2, resolve, 0);
      enc.copyBufferToBuffer(resolve, 0, read, 0, 16);
      this.dev.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const t = new BigUint64Array(read.getMappedRange());
      const ms = Number(t[1] - t[0]) / 1e6;
      read.unmap();
      if (ms > 0 && Number.isFinite(ms)) samples.push(ms);
    }
    target.destroy();
    qs.destroy();
    resolve.destroy();
    read.destroy();
    if (!samples.length) return NaN;
    samples.sort((a, b) => a - b);
    return samples[samples.length >> 1];
  }
  async renderToRGBA(width, height) {
    this.ensureTrace(width, height);
    this.flush();
    this.dev.queue.writeBuffer(this.resolveBgBuf, 0, this.mat.subarray(12, 16));
    const target = this.dev.createTexture({ size: [width, height], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const enc = this.dev.createCommandEncoder();
    this.encodeFrame(enc, target.createView());
    const bpr = Math.ceil(width * 4 / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: height }, [width, height]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(padded.subarray(y * bpr, y * bpr + width * 4), y * width * 4);
    buf.unmap();
    target.destroy();
    buf.destroy();
    return out;
  }
  /** REMOTE PRODUCER (M3): trace at width×height and read back the PREMULTIPLIED sample (pre-
   *  background) as tightly-packed rgba8 — the bytes streamed to the remote client, which runs the
   *  same reconstruction (upsample + background composite) the local resolve does. The caller sets
   *  the camera to width×height first (like renderUpscaled). Returns width*height*4 bytes. */
  async traceSamples(width, height) {
    this.flush();
    const target = this.dev.createTexture({ size: [width, height], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const enc = this.dev.createCommandEncoder();
    const tp = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    tp.setPipeline(this.streamPipeline);
    tp.setBindGroup(0, this.streamBind);
    tp.draw(3);
    tp.end();
    const bpr = Math.ceil(width * 4 / 256) * 256;
    const buf = this.dev.createBuffer({ size: bpr * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: target }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: height }, [width, height]);
    this.dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) out.set(padded.subarray(y * bpr, y * bpr + width * 4), y * width * 4);
    buf.unmap();
    target.destroy();
    buf.destroy();
    return out;
  }
};

// algorithms/geom.ts
function transpose42(m) {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = m[r * 4 + c];
  return o;
}
function spacingFromIjkToRAS2(ijkToRAS) {
  const col = (c) => Math.hypot(ijkToRAS[c], ijkToRAS[4 + c], ijkToRAS[8 + c]);
  return [col(0), col(1), col(2)];
}

// algorithms/editable-segmentation.ts
var EditableSegmentation = class {
  dims;
  ijkToRAS;
  device;
  // effects (algorithms/effects/*) build their own pipelines against this
  labelTex;
  // master (r32uint, STORAGE) — the shared buffer effects write
  dirtyCbs = [];
  constructor(device, dims, opts) {
    this.device = device;
    this.dims = dims;
    this.ijkToRAS = Array.from(opts.ijkToRAS);
    this.labelTex = device.createTexture({
      size: dims,
      dimension: "3d",
      format: "r32uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC
    });
  }
  /** The master labelmap (r32uint storage). The logic layer reads it (to derive a presence texture);
   *  editing effects write it on-GPU (A-1+). */
  masterTexture() {
    return this.labelTex;
  }
  /** Register a callback fired after any edit — the logic layer rebakes + redraws. Returns an
   *  unsubscribe (so a logic can be swapped/disposed without leaking a stale rebake). */
  onDirty(cb) {
    this.dirtyCbs.push(cb);
    return () => {
      const i = this.dirtyCbs.indexOf(cb);
      if (i >= 0) this.dirtyCbs.splice(i, 1);
    };
  }
  /** Signal that the master was edited (effects call this after writing the label texture on-GPU). */
  markDirty() {
    for (const cb of this.dirtyCbs) cb();
  }
  /** Voxel spacing (mm) from the geometry — for mm↔voxel effect params. */
  spacingMm() {
    return spacingFromIjkToRAS2(this.ijkToRAS);
  }
  /** Load a full labelmap (ids 0..255) from CPU into the master, then notify. */
  loadLabelmap(data) {
    const [dx, dy, dz] = this.dims;
    const u32 = data instanceof Uint32Array ? data : Uint32Array.from(data);
    this.device.queue.writeTexture({ texture: this.labelTex }, u32, { bytesPerRow: dx * 4, rowsPerImage: dy }, [dx, dy, dz]);
    this.markDirty();
  }
  /** Read the master labelmap back to CPU (ids per voxel, x-fastest). Handles WebGPU's 256-byte
   *  bytesPerRow alignment. For tests + zarr serialization (A-7); not on the interactive path. */
  async readLabelmap() {
    const [dx, dy, dz] = this.dims;
    const bpr = Math.ceil(dx * 4 / 256) * 256;
    const rowU32 = bpr / 4;
    const buf = this.device.createBuffer({ size: bpr * dy * dz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.labelTex }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: dy }, [dx, dy, dz]);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const padded = new Uint32Array(buf.getMappedRange());
    const out = new Uint32Array(dx * dy * dz);
    for (let z = 0; z < dz; z++) for (let y = 0; y < dy; y++) {
      const src = (z * dy + y) * rowU32, dst = (z * dy + y) * dx;
      for (let x = 0; x < dx; x++) out[dst + x] = padded[src + x];
    }
    buf.unmap();
    buf.destroy();
    return out;
  }
  destroy() {
    this.labelTex.destroy();
  }
};

// algorithms/effects/paint.ts
var PAINT_WGSL = (
  /* wgsl */
  `
struct U {
  ijkToRAS : mat4x4<f32>,   // column-major (transpose of the row-major host matrix)
  dims     : vec4<u32>,
  params   : vec4<f32>,     // x=radiusMm, y=id, z=mode(0 add/1 remove), w=pointCount
};
@group(0) @binding(0) var t_label : texture_storage_3d<r32uint, write>;
@group(0) @binding(1) var<uniform> u : U;
@group(0) @binding(2) var<storage, read> pts : array<vec4<f32>>;   // xyz = RAS sample points

fn seg_dist(p : vec3<f32>, a : vec3<f32>, b : vec3<f32>) -> f32 {
  let ab = b - a;
  let denom = max(dot(ab, ab), 1e-8);
  let t = clamp(dot(p - a, ab) / denom, 0.0, 1.0);
  return length(p - (a + t * ab));
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let p = (u.ijkToRAS * vec4<f32>(vec3<f32>(gid), 1.0)).xyz;
  let n = u32(u.params.w);
  if (n == 0u) { return; }
  var dmin = 1e30;
  if (n == 1u) {
    dmin = length(p - pts[0].xyz);
  } else {
    for (var i = 0u; i < n - 1u; i = i + 1u) {
      dmin = min(dmin, seg_dist(p, pts[i].xyz, pts[i + 1u].xyz));
    }
  }
  if (dmin <= u.params.x) {
    let id = select(u32(u.params.y), 0u, u.params.z > 0.5);   // remove \u2192 0
    textureStore(t_label, vec3<i32>(gid), vec4<u32>(id, 0u, 0u, 0u));
  }
}`
);
var PaintEffect = class {
  constructor(seg) {
    this.seg = seg;
    const dev = seg.device;
    this.dev = dev;
    this.pipe = dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: PAINT_WGSL }), entryPoint: "main" } });
    this.uni = dev.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  seg;
  dev;
  pipe;
  uni;
  ptsBuf;
  ptsCap = 0;
  /** Rasterize a stroke (RAS polyline + spherical brush) into the master, interpolating between
   *  samples, then mark the segmentation dirty (one redraw). A single point = a sphere dab. */
  stampStroke(points, opts) {
    if (points.length === 0) return;
    const dev = this.dev, dims = this.seg.dims;
    const need = points.length * 4 * 4;
    if (!this.ptsBuf || this.ptsCap < points.length) {
      this.ptsBuf?.destroy();
      this.ptsCap = Math.max(points.length, 64);
      this.ptsBuf = dev.createBuffer({ size: this.ptsCap * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    const pd = new Float32Array(points.length * 4);
    for (let i = 0; i < points.length; i++) {
      pd[i * 4] = points[i][0];
      pd[i * 4 + 1] = points[i][1];
      pd[i * 4 + 2] = points[i][2];
    }
    dev.queue.writeBuffer(this.ptsBuf, 0, pd, 0, points.length * 4);
    const ab = new ArrayBuffer(96);
    const f = new Float32Array(ab), uu = new Uint32Array(ab);
    f.set(transpose42(this.seg.ijkToRAS), 0);
    uu[16] = dims[0];
    uu[17] = dims[1];
    uu[18] = dims[2];
    uu[19] = 0;
    f[20] = opts.radiusMm;
    f[21] = opts.id ?? 1;
    f[22] = opts.mode === "remove" ? 1 : 0;
    f[23] = points.length;
    dev.queue.writeBuffer(this.uni, 0, ab);
    const bind = dev.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.seg.masterTexture().createView() },
      { binding: 1, resource: { buffer: this.uni } },
      { binding: 2, resource: { buffer: this.ptsBuf, size: need } }
    ] });
    const [gx, gy, gz] = [Math.ceil(dims[0] / 4), Math.ceil(dims[1] / 4), Math.ceil(dims[2] / 4)];
    const enc = dev.createCommandEncoder();
    const p = enc.beginComputePass();
    p.setPipeline(this.pipe);
    p.setBindGroup(0, bind);
    p.dispatchWorkgroups(gx, gy, gz);
    p.end();
    dev.queue.submit([enc.finish()]);
    this.seg.markDirty();
  }
  /** Incremental segment: weld a capsule from `prev` to `next` (one pointer move). */
  extend(prev, next, opts) {
    this.stampStroke([prev, next], opts);
  }
  destroy() {
    this.uni.destroy();
    this.ptsBuf?.destroy();
  }
};

// algorithms/seg-edit-driver.ts
var SegEditDriver = class _SegEditDriver {
  constructor(seg, opts = {}) {
    this.seg = seg;
    this.opts = opts;
    this.paint = new PaintEffect(seg);
  }
  seg;
  opts;
  paint;
  labels = /* @__PURE__ */ new Map();
  // Slicer segment id → r32uint master label
  nextLabel = 1;
  active;
  /** Normalize any of the three carriers → the bare SegEdit payload (or null). */
  static unwrap(op) {
    const o = op;
    if (o && typeof o === "object") {
      if (o.edit && typeof o.edit === "object") return o.edit;
      if (o.cmd === "segEdit" && o.args && typeof o.args === "object") return o.args;
      if (typeof o.kind === "string") return o;
    }
    return null;
  }
  labelFor(segmentId) {
    if (!segmentId) return 1;
    if (this.opts.labelForSegment) return this.opts.labelForSegment(segmentId);
    let id = this.labels.get(segmentId);
    if (id === void 0) {
      id = this.nextLabel++;
      this.labels.set(segmentId, id);
    }
    return id;
  }
  radiusFor(e) {
    return (e.brush?.diameterMm ?? this.opts.defaultDiameterMm ?? 6) / 2;
  }
  modeFor(e) {
    if (e.mode === "remove" || (e.effect ?? "").toLowerCase().startsWith("erase")) return "remove";
    return "add";
  }
  strokeOpts(e) {
    return { radiusMm: this.radiusFor(e), id: this.labelFor(e.segmentId), mode: this.modeFor(e) };
  }
  /** Apply one COMMITTED edit (all its points at once) — the replay path. */
  applyEdit(op) {
    const e = _SegEditDriver.unwrap(op);
    if (!e) return;
    if (e.kind !== "stroke") {
      this.opts.onUnhandled?.(e.kind);
      return;
    }
    const s = e;
    if (!s.points?.length) return;
    this.paint.stampStroke(s.points, this.strokeOpts(s));
  }
  // ── Incremental live path: begin / addPoint / end, as pointer samples arrive (real-time apply,
  //    no wait for mouse-up). A stroke is a pointer-drag stream, exactly like a camera drag. ──
  /** Start an incremental stroke; `meta` carries the same fields a full edit would (minus points). */
  beginStroke(meta = {}) {
    this.active = { opts: this.strokeOpts({ kind: "stroke", points: [], ...meta }), last: void 0 };
  }
  /** Add one sampled point — welds a capsule from the previous sample (first point = a dab). */
  addPoint(p) {
    if (!this.active) return;
    this.paint.stampStroke(this.active.last ? [this.active.last, p] : [p], this.active.opts);
    this.active.last = p;
  }
  endStroke() {
    this.active = void 0;
  }
  destroy() {
    this.paint.destroy();
  }
};

// render/bake.ts
var INIT_WGSL = (
  /* wgsl */
  `
struct U { dims : vec4<u32> };
@group(0) @binding(0) var t_label : texture_3d<u32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u_pal : array<vec4<f32>, 256>;
@group(0) @binding(3) var<uniform> u : U;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let label = textureLoad(t_label, vec3<i32>(gid), 0).r;
  let pal = u_pal[label & 255u];
  let present = select(0.0, 1.0, label != 0u);
  textureStore(t_out, vec3<i32>(gid), vec4<f32>(pal.rgb, present * pal.a));
}`
);
var BLUR_WGSL = (
  /* wgsl */
  `
struct U { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4> };  // axis, radius; half-kernel weights
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : U;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var av = vec3<i32>(0);
  if (u.axis_r.x == 0u) { av = vec3<i32>(1,0,0); } else if (u.axis_r.x == 1u) { av = vec3<i32>(0,1,0); } else { av = vec3<i32>(0,0,1); }
  let center = textureLoad(t_in, c, 0);
  var asum = center.a * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    let o = av * i;
    let p1 = clamp(c + o, vec3<i32>(0), dmax);
    let p2 = clamp(c - o, vec3<i32>(0), dmax);
    asum = asum + wt(u32(i)) * (textureLoad(t_in, p1, 0).a + textureLoad(t_in, p2, 0).a);
  }
  textureStore(t_out, c, vec4<f32>(center.rgb, asum));
}`
);
function gaussHalfKernel(sigma) {
  const radius = Math.max(1, Math.min(15, Math.ceil(3 * sigma)));
  const raw = new Float32Array(radius + 1);
  let total = 0;
  for (let i = 0; i <= radius; i++) {
    raw[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    total += (i === 0 ? 1 : 2) * raw[i];
  }
  const w = new Float32Array(16);
  for (let i = 0; i <= radius; i++) w[i] = raw[i] / total;
  return { radius, w };
}
var ColorizeBaker = class {
  /** `label` is either a CPU labelmap (baker allocates + uploads its own r8uint texture, the classic
   *  path) OR an EXTERNAL r8uint 3D texture the baker only READS (the shared-buffer path used by
   *  `algorithms/EditableSegmentation` — a compute effect writes the label texture on-GPU and the baker
   *  re-colorizes from it, no CPU round-trip). An external texture must be `r8uint` with at least
   *  TEXTURE_BINDING usage; the baker never writes or destroys it. */
  constructor(dev, label, dims) {
    this.dev = dev;
    this.dims = dims;
    const [dx, dy, dz] = dims;
    if (label instanceof GPUTexture) {
      this.labelTex = label;
      this.ownsLabel = false;
    } else {
      this.labelTex = dev.createTexture({ size: dims, dimension: "3d", format: "r8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      dev.queue.writeTexture({ texture: this.labelTex }, label, { bytesPerRow: dx, rowsPerImage: dy }, dims);
      this.ownsLabel = true;
    }
    this.palBuf = dev.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dimsBuf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.dimsBuf, 0, new Uint32Array([dx, dy, dz, 0]));
    this.initPipe = dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: INIT_WGSL }), entryPoint: "main" } });
    this.blurPipe = dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code: BLUR_WGSL }), entryPoint: "main" } });
    this.g = [Math.ceil(dx / 4), Math.ceil(dy / 4), Math.ceil(dz / 4)];
  }
  dev;
  dims;
  labelTex;
  ownsLabel;
  // false when the label texture is owned externally (shared buffer)
  scratch;
  // blur ping-pong (lazy; only when sigma > 0)
  palBuf;
  dimsBuf;
  initPipe;
  blurPipe;
  g;
  /** Re-upload an EDITED labelmap (same dims). Follow with bakeInto() to re-colorize into the caller's
   *  existing output textures — an in-place replace (no re-allocation, so a segmentation edit updates
   *  smoothly with no flash). */
  updateLabelmap(labelmap) {
    if (!this.ownsLabel) throw new Error("ColorizeBaker.updateLabelmap: label texture is external (write it via the owner, e.g. a compute effect), then call bakeInto()");
    const [dx, dy] = this.dims;
    this.dev.queue.writeTexture({ texture: this.labelTex }, labelmap, { bytesPerRow: dx, rowsPerImage: dy }, this.dims);
  }
  /** Allocate an output texture sized/typed for this baker's labelmap (caller owns it). */
  output() {
    return this.dev.createTexture({ size: this.dims, dimension: "3d", format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
  }
  /** (Re)colorize into `out` with `palette` (256*4 f32: rgb + presence*opacity) and Gaussian
   *  `sigmaVoxels` (0 = crisp, for the 2D slice overlay). In place — reuses everything resident. */
  bakeInto(out, palette, sigmaVoxels = 1.5) {
    const dev = this.dev, [gx, gy, gz] = this.g, [dx, dy, dz] = this.dims;
    const palData = new Float32Array(256 * 4);
    palData.set(palette.subarray(0, Math.min(palette.length, 256 * 4)));
    dev.queue.writeBuffer(this.palBuf, 0, palData);
    const enc = dev.createCommandEncoder();
    const smooth = sigmaVoxels > 0;
    if (smooth && !this.scratch) this.scratch = this.output();
    const initDst = smooth ? this.scratch : out;
    const initBind = dev.createBindGroup({ layout: this.initPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.labelTex.createView() },
      { binding: 1, resource: initDst.createView() },
      { binding: 2, resource: { buffer: this.palBuf } },
      { binding: 3, resource: { buffer: this.dimsBuf } }
    ] });
    {
      const p = enc.beginComputePass();
      p.setPipeline(this.initPipe);
      p.setBindGroup(0, initBind);
      p.dispatchWorkgroups(gx, gy, gz);
      p.end();
    }
    if (smooth) {
      const s = this.scratch;
      const { radius, w } = gaussHalfKernel(sigmaVoxels);
      const passes = [[s, out, 0], [out, s, 1], [s, out, 2]];
      for (const [src, dst, axis] of passes) {
        const ub = dev.createBuffer({ size: 16 + 16 + 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        dev.queue.writeBuffer(ub, 0, new Uint32Array([dx, dy, dz, 0, axis, radius, 0, 0]));
        dev.queue.writeBuffer(ub, 32, w);
        const b = dev.createBindGroup({ layout: this.blurPipe.getBindGroupLayout(0), entries: [
          { binding: 0, resource: src.createView() },
          { binding: 1, resource: dst.createView() },
          { binding: 2, resource: { buffer: ub } }
        ] });
        const p = enc.beginComputePass();
        p.setPipeline(this.blurPipe);
        p.setBindGroup(0, b);
        p.dispatchWorkgroups(gx, gy, gz);
        p.end();
      }
    }
    dev.queue.submit([enc.finish()]);
  }
  destroy() {
    if (this.ownsLabel) this.labelTex.destroy();
    this.scratch?.destroy();
    this.palBuf.destroy();
    this.dimsBuf.destroy();
  }
};

// render/sdf-bake.ts
var INIT_WGSL2 = (
  /* wgsl */
  `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32> };
@group(0) @binding(0) var t_label : texture_3d<u32>;
@group(0) @binding(1) var t_seed_out : texture_storage_3d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u : U;
fn labelAt(c : vec3<i32>) -> u32 {
  let d = vec3<i32>(u.dims.xyz);
  return textureLoad(t_label, clamp(c, vec3<i32>(0), d - vec3<i32>(1)), 0).r;
}
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let my = labelAt(c);
  let meIn = my != 0u;
  var boundary = false;
  var region = my;                                  // inside voxel \u2192 own label
  let offs = array<vec3<i32>, 6>(vec3<i32>(1,0,0), vec3<i32>(-1,0,0), vec3<i32>(0,1,0), vec3<i32>(0,-1,0), vec3<i32>(0,0,1), vec3<i32>(0,0,-1));
  for (var i = 0; i < 6; i = i + 1) {
    let nl = labelAt(c + offs[i]);
    let nIn = nl != 0u;
    if (nIn != meIn) { boundary = true; if (!meIn) { region = nl; } }  // outside boundary \u2192 adopt inside neighbour's label
  }
  var seed = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  if (boundary) { seed = vec4<f32>((u.ijkToRAS * vec4<f32>(vec3<f32>(gid), 1.0)).xyz, f32(region)); }
  textureStore(t_seed_out, c, seed);
}`
);
var JFA_WGSL = (
  /* wgsl */
  `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32> };
@group(0) @binding(0) var t_seed_in : texture_3d<f32>;
@group(0) @binding(1) var t_seed_out : texture_storage_3d<rgba32float, write>;
@group(0) @binding(2) var<uniform> u : U;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let p = (u.ijkToRAS * vec4<f32>(vec3<f32>(gid), 1.0)).xyz;
  let step = i32(u.params.x);
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var best = textureLoad(t_seed_in, c, 0);
  var bestD = select(1e30, distance(p, best.xyz), best.w > 0.5);
  for (var dz = -1; dz <= 1; dz = dz + 1) {
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        if (dx == 0 && dy == 0 && dz == 0) { continue; }
        let nc = clamp(c + vec3<i32>(dx, dy, dz) * step, vec3<i32>(0), dmax);
        let s = textureLoad(t_seed_in, nc, 0);
        if (s.w > 0.5) {
          let d = distance(p, s.xyz);
          if (d < bestD) { bestD = d; best = s; }
        }
      }
    }
  }
  textureStore(t_seed_out, c, best);
}`
);
var FINAL_WGSL = (
  /* wgsl */
  `
struct U { ijkToRAS : mat4x4<f32>, dims : vec4<u32>, params : vec4<f32> };
@group(0) @binding(0) var t_seed_in : texture_3d<f32>;
@group(0) @binding(1) var t_label : texture_3d<u32>;
@group(0) @binding(2) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var<uniform> u : U;
@group(0) @binding(4) var<uniform> u_pal : array<vec4<f32>, 256>;
@group(0) @binding(5) var t_attr : texture_storage_3d<rgba16float, write>;
@group(0) @binding(6) var<uniform> u_mode : array<vec4<f32>, 256>;   // .x = shading mode (0 surface, 1 volume)
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let p = (u.ijkToRAS * vec4<f32>(vec3<f32>(gid), 1.0)).xyz;
  let s = textureLoad(t_seed_in, c, 0);
  let valid = s.w > 0.5;
  let dist = select(1e3, distance(p, s.xyz), valid);
  let ins = textureLoad(t_label, c, 0).r != 0u;
  let sdf = select(dist, -dist, ins);
  let lbl = u32(s.w + 0.5) & 255u;
  let pal = select(vec4<f32>(0.0), u_pal[lbl], valid);
  let mode = select(0.0, u_mode[lbl].x, valid);
  textureStore(t_out, c, vec4<f32>(pal.rgb, sdf));
  textureStore(t_attr, c, vec4<f32>(pal.a, mode, 0.0, 0.0));   // .r = per-segment opacity, .g = shading mode
}`
);
var BLUR_WGSL2 = (
  /* wgsl */
  `
struct BU { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4> };
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : BU;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var av = vec3<i32>(0);
  if (u.axis_r.x == 0u) { av = vec3<i32>(1,0,0); } else if (u.axis_r.x == 1u) { av = vec3<i32>(0,1,0); } else { av = vec3<i32>(0,0,1); }
  let center = textureLoad(t_in, c, 0);
  var sum = center.a * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    sum = sum + wt(u32(i)) * (textureLoad(t_in, clamp(c + av * i, vec3<i32>(0), dmax), 0).a
                            + textureLoad(t_in, clamp(c - av * i, vec3<i32>(0), dmax), 0).a);
  }
  textureStore(t_out, c, vec4<f32>(center.rgb, sum));
}`
);
var COLBLUR_WGSL = (
  /* wgsl */
  `
struct BU { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4> };
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : BU;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var av = vec3<i32>(0);
  if (u.axis_r.x == 0u) { av = vec3<i32>(1,0,0); } else if (u.axis_r.x == 1u) { av = vec3<i32>(0,1,0); } else { av = vec3<i32>(0,0,1); }
  let center = textureLoad(t_in, c, 0);
  var sum = center.rgb * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    sum = sum + wt(u32(i)) * (textureLoad(t_in, clamp(c + av * i, vec3<i32>(0), dmax), 0).rgb
                            + textureLoad(t_in, clamp(c - av * i, vec3<i32>(0), dmax), 0).rgb);
  }
  textureStore(t_out, c, vec4<f32>(sum, center.a));
}`
);
var FULLBLUR_WGSL = (
  /* wgsl */
  `
struct BU { dims : vec4<u32>, axis_r : vec4<u32>, w : array<vec4<f32>, 4> };
@group(0) @binding(0) var t_in : texture_3d<f32>;
@group(0) @binding(1) var t_out : texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var<uniform> u : BU;
fn wt(i : u32) -> f32 { return u.w[i >> 2u][i & 3u]; }
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (any(gid >= u.dims.xyz)) { return; }
  let c = vec3<i32>(gid);
  let dmax = vec3<i32>(u.dims.xyz) - vec3<i32>(1);
  var av = vec3<i32>(0);
  if (u.axis_r.x == 0u) { av = vec3<i32>(1,0,0); } else if (u.axis_r.x == 1u) { av = vec3<i32>(0,1,0); } else { av = vec3<i32>(0,0,1); }
  var sum = textureLoad(t_in, c, 0) * wt(0u);
  let R = i32(u.axis_r.y);
  for (var i = 1; i <= R; i = i + 1) {
    sum = sum + wt(u32(i)) * (textureLoad(t_in, clamp(c + av * i, vec3<i32>(0), dmax), 0)
                            + textureLoad(t_in, clamp(c - av * i, vec3<i32>(0), dmax), 0));
  }
  textureStore(t_out, c, sum);
}`
);
function gaussHalfKernel2(sigma) {
  const radius = Math.max(1, Math.min(15, Math.ceil(3 * sigma)));
  const raw = new Float32Array(radius + 1);
  let total = 0;
  for (let i = 0; i <= radius; i++) {
    raw[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    total += (i === 0 ? 1 : 2) * raw[i];
  }
  const w = new Float32Array(16);
  for (let i = 0; i <= radius; i++) w[i] = raw[i] / total;
  return { radius, w };
}
var JfaSdfBaker = class {
  constructor(dev, labelTex, dims, ijkToRAS, smoothSigmaVoxels = 1) {
    this.labelTex = labelTex;
    this.dims = dims;
    this.ijkToRAS = ijkToRAS;
    this.dev = dev;
    this.smoothSigma = smoothSigmaVoxels;
    const [dx, dy, dz] = dims;
    const mk = (fmt, extra = 0) => dev.createTexture({ size: dims, dimension: "3d", format: fmt, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | extra });
    this.seed = [mk("rgba32float"), mk("rgba32float")];
    this.sdfTex = mk("rgba16float", GPUTextureUsage.COPY_DST);
    this.attrTex = mk("rgba16float", GPUTextureUsage.COPY_DST);
    this.attrScratch = mk("rgba16float", GPUTextureUsage.COPY_SRC);
    this.sdfScratch = mk("rgba16float", GPUTextureUsage.COPY_SRC);
    this.uni = dev.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.palBuf = dev.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.modeBuf = dev.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mod = (code) => dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code }), entryPoint: "main" } });
    this.initPipe = mod(INIT_WGSL2);
    this.jfaPipe = mod(JFA_WGSL);
    this.finalPipe = mod(FINAL_WGSL);
    this.blurPipe = mod(BLUR_WGSL2);
    this.colBlurPipe = mod(COLBLUR_WGSL);
    this.fullBlurPipe = mod(FULLBLUR_WGSL);
    this.g = [Math.ceil(dx / 4), Math.ceil(dy / 4), Math.ceil(dz / 4)];
    const maxDim = Math.max(dx, dy, dz);
    const steps = [];
    for (let s = 1 << Math.floor(Math.log2(maxDim - 1)); s >= 1; s >>= 1) steps.push(s);
    this.steps = steps;
  }
  labelTex;
  dims;
  ijkToRAS;
  dev;
  seed;
  // rgba32float ping-pong (RAS seed xyz + regionLabel)
  sdfTex;
  // rgba16float: .rgb = per-label colour, .a = signed dist (mm) — sampled by SegmentField
  attrTex;
  // rgba16float: .r = per-segment opacity, .g = shading mode — sampled by SegmentField
  attrScratch;
  // rgba16float attr-blur ping-pong
  sdfScratch;
  // rgba16float blur ping-pong
  uni;
  palBuf;
  // 256 × vec4 label→colour palette (.a = opacity)
  modeBuf;
  // 256 × vec4 label→shading mode (.x = 0 surface / 1 volume)
  initPipe;
  jfaPipe;
  finalPipe;
  blurPipe;
  // blurs .a (distance), carries .rgb
  colBlurPipe;
  // blurs .rgb (colour), carries .a
  fullBlurPipe;
  // blurs all channels — the attr texture (opacity + mode)
  g;
  steps;
  smoothSigma;
  /** The resident colorized-SDF texture (rgba16float: .rgb = per-label colour, .a = signed mm).
   *  Identity stable across bakes → the SceneRenderer bind group stays valid; a live edit updates in
   *  place. */
  sdfTexture() {
    return this.sdfTex;
  }
  /** The resident per-segment attribute texture (rgba16float; .r = opacity). Identity stable. */
  attrTexture() {
    return this.attrTex;
  }
  /** Set the label→colour palette (256 × rgba f32: rgb = colour, a = opacity). Call before bake(). */
  setPalette(palette) {
    const pal = new Float32Array(256 * 4);
    pal.set(palette.subarray(0, Math.min(palette.length, 256 * 4)));
    this.dev.queue.writeBuffer(this.palBuf, 0, pal);
  }
  /** Set the per-label shading mode palette (256 × vec4; .x = 0 surface shell / 1 volume DVR fill). */
  setModePalette(modes) {
    const m = new Float32Array(256 * 4);
    m.set(modes.subarray(0, Math.min(modes.length, 256 * 4)));
    this.dev.queue.writeBuffer(this.modeBuf, 0, m);
  }
  writeUni(step) {
    const ab = new ArrayBuffer(96);
    const f = new Float32Array(ab), u = new Uint32Array(ab);
    f.set(transpose4(this.ijkToRAS), 0);
    u[16] = this.dims[0];
    u[17] = this.dims[1];
    u[18] = this.dims[2];
    u[19] = 0;
    f[20] = step;
    f[21] = 0;
    f[22] = 0;
    f[23] = 0;
    this.dev.queue.writeBuffer(this.uni, 0, ab);
  }
  /** FAST bake for LIVE editing: plain JFA (approximate) + a light distance-only blur (crisp colour
   *  seams). Cheap, so it keeps up with an in-progress stroke; the seams stay voxel-jagged until the
   *  edit settles and refine() runs. */
  bake() {
    this.sweep([], this.smoothSigma, 0);
  }
  /** REFINE for a STATIC labelmap (run once the edit settles): JFA+2 extra passes → a near-exact
   *  Voronoi/SDF (fixes the small JFA mistakes near close/overlapping segments) and a colour-seam blur
   *  so neighbouring-label boundaries are smooth, not a voxel staircase. Distance blur stays at the
   *  same σ (dropping it re-introduces Voronoi facets — crispness comes from the render band, not from
   *  under-smoothing). Higher quality lives in the resident texture, so camera renders stay cheap. */
  refine() {
    this.sweep([2, 1], this.smoothSigma, 1);
  }
  /** One full sweep: init → JFA (schedule + extra) → finalize → blur .a → optional blur .rgb. */
  sweep(extraSteps, distSigma, colorSigma) {
    const dev = this.dev, [gx, gy, gz] = this.g;
    this.writeUni(0);
    let enc = dev.createCommandEncoder();
    {
      const b = dev.createBindGroup({ layout: this.initPipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.labelTex.createView() },
        { binding: 1, resource: this.seed[0].createView() },
        { binding: 2, resource: { buffer: this.uni } }
      ] });
      const p2 = enc.beginComputePass();
      p2.setPipeline(this.initPipe);
      p2.setBindGroup(0, b);
      p2.dispatchWorkgroups(gx, gy, gz);
      p2.end();
    }
    dev.queue.submit([enc.finish()]);
    let src = 0;
    for (const step of [...this.steps, ...extraSteps]) {
      this.writeUni(step);
      const dst = src ^ 1;
      enc = dev.createCommandEncoder();
      const b = dev.createBindGroup({ layout: this.jfaPipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: this.seed[src].createView() },
        { binding: 1, resource: this.seed[dst].createView() },
        { binding: 2, resource: { buffer: this.uni } }
      ] });
      const p2 = enc.beginComputePass();
      p2.setPipeline(this.jfaPipe);
      p2.setBindGroup(0, b);
      p2.dispatchWorkgroups(gx, gy, gz);
      p2.end();
      dev.queue.submit([enc.finish()]);
      src = dst;
    }
    enc = dev.createCommandEncoder();
    const bf = dev.createBindGroup({ layout: this.finalPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.seed[src].createView() },
      { binding: 1, resource: this.labelTex.createView() },
      { binding: 2, resource: this.sdfTex.createView() },
      { binding: 3, resource: { buffer: this.uni } },
      { binding: 4, resource: { buffer: this.palBuf } },
      { binding: 5, resource: this.attrTex.createView() },
      { binding: 6, resource: { buffer: this.modeBuf } }
    ] });
    const p = enc.beginComputePass();
    p.setPipeline(this.finalPipe);
    p.setBindGroup(0, bf);
    p.dispatchWorkgroups(gx, gy, gz);
    p.end();
    dev.queue.submit([enc.finish()]);
    if (distSigma > 0) this.blurStage(this.blurPipe, distSigma, this.sdfTex, this.sdfScratch);
    if (colorSigma > 0) this.blurStage(this.colBlurPipe, colorSigma, this.sdfTex, this.sdfScratch);
    if (colorSigma > 0) this.blurStage(this.fullBlurPipe, colorSigma, this.attrTex, this.attrScratch);
  }
  /** 3 separable Gaussian passes with the given pipeline (which channels it blurs), tex↔scratch,
   *  ending in scratch → copied back to `tex` so its identity stays stable for the renderer. */
  blurStage(pipe, sigma, tex, scratch) {
    const dev = this.dev, [gx, gy, gz] = this.g, [dx, dy, dz] = this.dims;
    const { radius, w } = gaussHalfKernel2(sigma);
    const passes = [[tex, scratch, 0], [scratch, tex, 1], [tex, scratch, 2]];
    const enc = dev.createCommandEncoder();
    for (const [srcT, dstT, axis] of passes) {
      const ab = new ArrayBuffer(96);
      const u32 = new Uint32Array(ab), f32 = new Float32Array(ab);
      u32[0] = dx;
      u32[1] = dy;
      u32[2] = dz;
      u32[4] = axis;
      u32[5] = radius;
      f32.set(w, 8);
      const ub = dev.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(ub, 0, ab);
      const b = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: srcT.createView() },
        { binding: 1, resource: dstT.createView() },
        { binding: 2, resource: { buffer: ub } }
      ] });
      const bp = enc.beginComputePass();
      bp.setPipeline(pipe);
      bp.setBindGroup(0, b);
      bp.dispatchWorkgroups(gx, gy, gz);
      bp.end();
    }
    enc.copyTextureToTexture({ texture: scratch }, { texture: tex }, this.dims);
    dev.queue.submit([enc.finish()]);
  }
  destroy() {
    this.seed[0].destroy();
    this.seed[1].destroy();
    this.sdfTex.destroy();
    this.attrTex.destroy();
    this.attrScratch.destroy();
    this.sdfScratch.destroy();
    this.uni.destroy();
    this.palBuf.destroy();
    this.modeBuf.destroy();
  }
};

// render/fields.ts
var SegmentField = class {
  kind = "seg";
  bindingCount;
  // 1 (value texture) + 1 when an sdf attr (opacity) texture is bound
  clippable;
  tex;
  attrTex;
  // sdf per-voxel attributes (.r = opacity)
  p2t;
  box;
  color;
  opacity;
  shade;
  bandMm;
  stepMm;
  mode;
  colorFromTex;
  constructor(tex, dims, spacing, opts) {
    this.tex = tex;
    const center = opts.center ?? [0, 0, 0];
    let voxelMm;
    if (opts.ijkToRAS) {
      this.p2t = patientToTextureFromIjkToRAS(opts.ijkToRAS, dims);
      this.box = volumeAABBFromIjkToRAS(opts.ijkToRAS, dims);
      voxelMm = Math.min(...spacingFromIjkToRAS(opts.ijkToRAS));
    } else {
      this.p2t = patientToTexture(dims, spacing, center);
      this.box = volumeAABB(dims, spacing, center);
      voxelMm = Math.min(...spacing);
    }
    this.color = opts.color;
    this.opacity = opts.opacity ?? 1;
    this.shade = opts.shade ?? [0.2, 0.85, 0.3, 32];
    this.bandMm = opts.bandMm ?? voxelMm;
    this.stepMm = opts.sampleStepMm ?? Math.max(0.5 * voxelMm, 0.1);
    this.clippable = opts.clippable ?? true;
    this.mode = opts.mode ?? "iso";
    this.colorFromTex = opts.colorFromTexture ?? false;
    this.attrTex = this.mode === "sdf" ? opts.attrTexture : void 0;
    this.bindingCount = this.attrTex ? 2 : 1;
  }
  uniformFloats() {
    return 28;
  }
  // mat4(16) + color(4) + shade(4) + params(4)
  aabb() {
    return this.box;
  }
  sampleStep() {
    return this.stepMm;
  }
  setTexture(tex, destroyPrev = true) {
    if (destroyPrev && this.tex !== tex) this.tex.destroy();
    this.tex = tex;
  }
  structMembers(s) {
    return [
      `  seg${s}_p2t : mat4x4<f32>,`,
      `  seg${s}_color : vec4<f32>,`,
      // rgb, opacity
      `  seg${s}_shade : vec4<f32>,`,
      // ka, kd, ks, shininess
      `  seg${s}_params : vec4<f32>,`
      // band_mm, _, _, _
    ].join("\n");
  }
  declareBindings(s, base) {
    const value = `@group(0) @binding(${base}) var t_seg${s} : texture_3d<f32>;`;
    return this.attrTex ? `${value}
@group(0) @binding(${base + 1}) var t_attr${s} : texture_3d<f32>;` : value;
  }
  samplingWGSL(s) {
    if (this.mode === "sdf") {
      return (
        /* wgsl */
        `
fn v_seg${s}(wp : vec3<f32>) -> f32 {   // signed distance (mm)
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return 1e3; }   // far outside \u2192 culled
  return textureSampleLevel(t_seg${s}, s_lin, t, 0.0).a;
}
fn col_seg${s}(wp : vec3<f32>) -> vec3<f32> {   // per-label colour of the nearest region
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec3<f32>(0.0); }
  return textureSampleLevel(t_seg${s}, s_lin, t, 0.0).rgb;
}${this.attrTex ? `
fn attr_seg${s}(wp : vec3<f32>) -> vec2<f32> {   // per-segment (.x = opacity, .y = shading mode)
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec2<f32>(0.0); }
  return textureSampleLevel(t_attr${s}, s_lin, t, 0.0).rg;
}` : ""}
// Shell (surface) contribution at wp: crisp Phong shell around sdf=0. Weighted by (1-mode) so it
// morphs smoothly into the volume contribution across a blurred surface\u2194volume boundary.
fn surface_seg${s}(wp : vec3<f32>, rd : vec3<f32>, sdf : f32, band : f32, step : f32, seg_op : f32, op0 : f32) -> vec4<f32> {
  let d_mm = abs(sdf);
  if (d_mm > band + step) { return vec4<f32>(0.0); }
  let a = 1.0 - clamp(d_mm / band, 0.0, 1.0);
  if (a <= 0.0) { return vec4<f32>(0.0); }
  let op = clamp(a * op0 * seg_op, 0.0, 1.0);
  let h = step;
  let g = vec3<f32>(
    v_seg${s}(wp + vec3<f32>(h,0,0)) - v_seg${s}(wp - vec3<f32>(h,0,0)),
    v_seg${s}(wp + vec3<f32>(0,h,0)) - v_seg${s}(wp - vec3<f32>(0,h,0)),
    v_seg${s}(wp + vec3<f32>(0,0,h)) - v_seg${s}(wp - vec3<f32>(0,0,h))) / (2.0 * h);
  let glen = length(g);
  if (glen < 1e-5) { return vec4<f32>(0.0); }
  var n = g / glen;
  if (dot(n, -rd) < 0.0) { n = -n; }
  let ka = u_material.seg${s}_shade.x; let kd = u_material.seg${s}_shade.y;
  let ks = u_material.seg${s}_shade.z; let sh = u_material.seg${s}_shade.w;
  let ldn = max(dot(-rd, n), 0.0);
  let refl = normalize(2.0 * ldn * n + rd);
  let rdv = max(dot(refl, -rd), 0.0);
  let col = col_seg${s}(wp);
  var lit = col * ka + col * (kd * ldn) + vec3<f32>(ks * pow(rdv, max(sh, 1.0)));
  lit = srgb2physical(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * op, op);
}
fn sample_field_seg${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let op0 = u_material.seg${s}_color.a;
  if (op0 <= 0.0) { return vec4<f32>(0.0); }
  let sdf = v_seg${s}(wp);
  let band = max(u_material.seg${s}_params.x, 1e-3);
  let step = max(u_material.scene.x, 1e-3);
${this.attrTex ? `  let at = attr_seg${s}(wp);        // (opacity, shading mode)
  let seg_op = at.x;
  if (seg_op <= 0.0) { return vec4<f32>(0.0); }
  let mode = clamp(at.y, 0.0, 1.0);
  // Surface and volume are BLENDED by the (seam-blurred, fractional) mode, so an opaque-surface
  // segment and a translucent-volume segment meet with a smooth transition instead of a jagged,
  // voxel-quantized classification edge.
  var acc = vec4<f32>(0.0);
  if (mode > 0.001 && sdf < 0.0) {
    // VOLUME: translucent DVR fill of the interior (~24 mm opacity-unit-distance).
    let vop = clamp(op0 * seg_op * step / 24.0, 0.0, 1.0);
    if (vop > 0.0) {
      let vcol = srgb2physical(clamp(col_seg${s}(wp), vec3<f32>(0.0), vec3<f32>(1.0)));
      acc += mode * vec4<f32>(vcol * vop, vop);
    }
  }
  if (mode < 0.999) {
    acc += (1.0 - mode) * surface_seg${s}(wp, rd, sdf, band, step, seg_op, op0);
  }
  return acc;` : `  return surface_seg${s}(wp, rd, sdf, band, step, 1.0, op0);`}
}`
      );
    }
    const alphaWGSL = this.mode === "surface" ? (
      /* wgsl */
      `
  let step = max(u_material.scene.x, 1e-3);
  let op = clamp(op0 * glen * step, 0.0, 1.0);
  if (op <= 0.0) { return vec4<f32>(0.0); }`
    ) : (
      /* wgsl */
      `
  // Local first-order signed distance to the v=0.5 isosurface (mm), then a
  // 1-voxel opacity band around it: crisp opaque shell, sub-voxel anti-aliased.
  let d_mm = abs((v - 0.5) / glen);
  let band = max(u_material.seg${s}_params.x, 1e-3);
  let a = 1.0 - clamp(d_mm / band, 0.0, 1.0);
  if (a <= 0.0) { return vec4<f32>(0.0); }
  let op = clamp(a * op0, 0.0, 1.0);`
    );
    const colWGSL = this.colorFromTex ? (
      /* wgsl */
      `
fn col_seg${s}(wp : vec3<f32>) -> vec3<f32> {
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return vec3<f32>(0.0); }
  return textureSampleLevel(t_seg${s}, s_lin, t, 0.0).rgb;
}`
    ) : "";
    const colExpr = this.colorFromTex ? `col_seg${s}(wp)` : `u_material.seg${s}_color.rgb`;
    return (
      /* wgsl */
      `
fn v_seg${s}(wp : vec3<f32>) -> f32 {
  let t4 = u_material.seg${s}_p2t * vec4<f32>(transform_point_seg${s}(wp), 1.0);
  let t = t4.xyz;
  if (any(t < vec3<f32>(0.0)) || any(t > vec3<f32>(1.0))) { return 0.0; }
  return textureSampleLevel(t_seg${s}, s_lin, t, 0.0).a;   // Gaussian-smoothed presence in .a
}${colWGSL}
fn sample_field_seg${s}(wp : vec3<f32>, rd : vec3<f32>) -> vec4<f32> {
  let op0 = u_material.seg${s}_color.a;
  if (op0 <= 0.0) { return vec4<f32>(0.0); }
  let v = v_seg${s}(wp);
  // Skip deep interior / exterior: |grad| ~ 0 there so no shell to emit.
  if (v <= 0.02 || v >= 0.98) { return vec4<f32>(0.0); }
  let h = max(u_material.scene.x, 1e-3);
  let g = vec3<f32>(
    v_seg${s}(wp + vec3<f32>(h,0,0)) - v_seg${s}(wp - vec3<f32>(h,0,0)),
    v_seg${s}(wp + vec3<f32>(0,h,0)) - v_seg${s}(wp - vec3<f32>(0,h,0)),
    v_seg${s}(wp + vec3<f32>(0,0,h)) - v_seg${s}(wp - vec3<f32>(0,0,h))) / (2.0 * h);
  let glen = length(g);
  if (glen < 1e-5) { return vec4<f32>(0.0); }${alphaWGSL}
  // Phong from the same gradient, normal flipped to face the camera.
  var n = g / glen;
  if (dot(n, -rd) < 0.0) { n = -n; }
  let ka = u_material.seg${s}_shade.x; let kd = u_material.seg${s}_shade.y;
  let ks = u_material.seg${s}_shade.z; let sh = u_material.seg${s}_shade.w;
  let ldn = max(dot(-rd, n), 0.0);
  let refl = normalize(2.0 * ldn * n + rd);
  let rdv = max(dot(refl, -rd), 0.0);
  let col = ${colExpr};
  var lit = col * ka + col * (kd * ldn) + vec3<f32>(ks * pow(rdv, max(sh, 1.0)));
  lit = srgb2physical(clamp(lit, vec3<f32>(0.0), vec3<f32>(1.0)));
  return vec4<f32>(lit * op, op);
}`
    );
  }
  fillUniforms(out, off) {
    out.set(this.p2t, off);
    out[off + 16] = this.color[0];
    out[off + 17] = this.color[1];
    out[off + 18] = this.color[2];
    out[off + 19] = this.opacity;
    out[off + 20] = this.shade[0];
    out[off + 21] = this.shade[1];
    out[off + 22] = this.shade[2];
    out[off + 23] = this.shade[3];
    out[off + 24] = this.bandMm;
  }
  bindEntries(_s, base) {
    const e = [{ binding: base, resource: this.tex.createView() }];
    if (this.attrTex) e.push({ binding: base + 1, resource: this.attrTex.createView() });
    return e;
  }
};

// logic/segmentation-logic.ts
var SegmentationLogic = class {
  // quiescence before the settle-refine (sdf mode)
  constructor(device, seg, opts = {}) {
    this.seg = seg;
    this.renderMode = opts.renderMode ?? "sdf";
    this.sigma = opts.sigmaVoxels ?? 1;
    this.bandMm = opts.bandMm;
    this.opacity = opts.opacity ?? 1;
    this.setLabelColor(1, opts.color ?? [0.3, 0.85, 0.55]);
    if (this.renderMode === "sdf") {
      this.sdf = new JfaSdfBaker(device, seg.masterTexture(), seg.dims, seg.ijkToRAS);
    } else {
      this.baker = new ColorizeBaker(device, seg.masterTexture(), seg.dims);
      this.presenceTex = this.baker.output();
    }
    this.rebake();
    this.scheduleRefine();
    this.unsubDirty = seg.onDirty(() => {
      this.rebake();
      for (const cb of this.redrawCbs) cb();
      this.scheduleRefine();
    });
  }
  seg;
  renderMode;
  sdf;
  // sdf path
  baker;
  // surface path
  presenceTex;
  sigma;
  bandMm;
  opacity;
  palette = new Float32Array(256 * 4);
  // label id → (r,g,b, opacity); shared by both paths
  modePalette = new Float32Array(256 * 4);
  // label id → (.x = shading mode: 0 surface / 1 volume) — sdf only
  segField;
  redrawCbs = [];
  unsubDirty;
  refineTimer;
  refineDelayMs = 180;
  /** Assign a display colour to a label id (0..255). Keeps the current opacity (defaults to 1 =
   *  opaque). Takes effect on the next rebake. */
  setLabelColor(id, rgb) {
    if (id < 1 || id > 255) return;
    const o = id * 4;
    this.palette[o] = rgb[0];
    this.palette[o + 1] = rgb[1];
    this.palette[o + 2] = rgb[2];
    if (this.palette[o + 3] === 0) this.palette[o + 3] = 1;
  }
  /** Per-segment opacity (0 = hidden, 1 = opaque) — palette alpha. Enables translucent surface-model
   *  rendering (see through outer segments to inner ones). Rebake/refine to apply. */
  setLabelOpacity(id, opacity) {
    if (id < 1 || id > 255) return;
    this.palette[id * 4 + 3] = Math.max(0, Math.min(1, opacity));
  }
  /** Per-segment shading (sdf mode): "surface" = crisp SDF shell (surface model), "volume" = DVR fill
   *  of the interior (translucent cloud). Rebake/refine to apply. */
  setLabelShading(id, shading) {
    if (id < 1 || id > 255) return;
    this.modePalette[id * 4] = shading === "volume" ? 1 : 0;
  }
  /** Re-derive the render texture from the current master + palette (FAST, in place). */
  rebake() {
    if (this.sdf) {
      this.sdf.setPalette(this.palette);
      this.sdf.setModePalette(this.modePalette);
      this.sdf.bake();
    } else this.baker.bakeInto(this.presenceTex, this.palette, this.sigma);
  }
  /** Schedule the settle-refine after quiescence (debounced; sdf mode only). */
  scheduleRefine() {
    if (!this.sdf) return;
    if (this.refineTimer !== void 0) clearTimeout(this.refineTimer);
    this.refineTimer = setTimeout(() => {
      this.refineTimer = void 0;
      this.refineNow();
    }, this.refineDelayMs);
  }
  /** Run the settle-refine now (JFA+2 + tighter distance blur + colour-seam blur), then redraw.
   *  Public so a test — or an app that knows the edit is done — can force the high-quality bake. */
  refineNow() {
    if (this.refineTimer !== void 0) {
      clearTimeout(this.refineTimer);
      this.refineTimer = void 0;
    }
    if (this.sdf) {
      this.sdf.setPalette(this.palette);
      this.sdf.setModePalette(this.modePalette);
      this.sdf.refine();
      for (const cb of this.redrawCbs) cb();
    }
  }
  /** A SegmentField bound to the shared render texture — hand this to the SceneRenderer once; edits
   *  update it in place. Colour comes from the texture (per-label); the uniform supplies opacity. */
  field() {
    if (!this.segField) {
      const tex = this.sdf ? this.sdf.sdfTexture() : this.presenceTex;
      const voxelMm = Math.min(...this.seg.spacingMm());
      const band = this.bandMm ?? (this.renderMode === "sdf" ? 0.65 * voxelMm : void 0);
      this.segField = new SegmentField(tex, this.seg.dims, [1, 1, 1], {
        color: [1, 1, 1],
        opacity: this.opacity,
        ijkToRAS: this.seg.ijkToRAS,
        mode: this.renderMode === "sdf" ? "sdf" : "surface",
        colorFromTexture: true,
        bandMm: band,
        clippable: false,
        attrTexture: this.sdf ? this.sdf.attrTexture() : void 0
        // per-segment opacity (sdf)
      });
    }
    return this.segField;
  }
  /** Notified after every edit (post-rebake) so the app can redraw. */
  onRedraw(cb) {
    this.redrawCbs.push(cb);
  }
  destroy() {
    if (this.refineTimer !== void 0) clearTimeout(this.refineTimer);
    this.unsubDirty();
    this.sdf?.destroy();
    this.baker?.destroy();
    this.presenceTex?.destroy();
  }
};

// algorithms/demos/algorithms-scene.ts
var LABEL_COLORS = [
  [0.3, 0.85, 0.55],
  [0.35, 0.65, 0.95],
  [0.95, 0.6, 0.3],
  [0.9, 0.35, 0.45],
  [0.7, 0.45, 0.95],
  [0.35, 0.85, 0.9],
  [0.95, 0.85, 0.35],
  [0.95, 0.5, 0.8],
  [0.55, 0.8, 0.35],
  [0.5, 0.55, 0.9],
  [0.9, 0.7, 0.5],
  [0.8, 0.8, 0.85]
];
function buildAlgorithmsScene(gpu, format) {
  const dims = [96, 96, 96];
  const sp = 2;
  const ijkToRAS = [sp, 0, 0, -96, 0, sp, 0, -96, 0, 0, sp, -96, 0, 0, 0, 1];
  const seg = new EditableSegmentation(gpu.device, dims, { ijkToRAS });
  const paint = new PaintEffect(seg);
  const keyToId = /* @__PURE__ */ new Map();
  const labelColors = [];
  const labelLook = /* @__PURE__ */ new Map();
  let nextId = 1;
  const applyLook = (id) => {
    const lk = labelLook.get(id);
    logic.setLabelOpacity(id, lk.op);
    logic.setLabelShading(id, lk.shading);
  };
  const allocId = (key) => {
    let id = keyToId.get(key);
    if (id !== void 0) return id;
    id = nextId++;
    const rgb = LABEL_COLORS[(id - 1) % LABEL_COLORS.length];
    keyToId.set(key, id);
    labelColors.push([id, rgb]);
    labelLook.set(id, { op: 1, shading: "surface" });
    logic.setLabelColor(id, rgb);
    applyLook(id);
    return id;
  };
  const scene = new SceneRenderer(gpu, format);
  const redrawCbs = [];
  let mode = "sdf";
  let logic;
  let allOpacity = 1;
  const makeLogic = () => {
    logic = new SegmentationLogic(gpu.device, seg, { renderMode: mode, opacity: 1, sigmaVoxels: 1 });
    for (const [id, rgb] of labelColors) {
      logic.setLabelColor(id, rgb);
      applyLook(id);
    }
    logic.onRedraw(() => {
      for (const cb of redrawCbs) cb();
    });
    scene.build([logic.field()]);
    scene.setBackground(0.05, 0.06, 0.09);
  };
  makeLogic();
  const driver = new SegEditDriver(seg, { labelForSegment: (segId) => allocId(segId) });
  allocId("seed");
  const [nx, ny, nz] = dims;
  const lab = new Uint8Array(nx * ny * nz);
  const c = [48, 48, 48], rv = 15;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const dx = x - c[0], dy = y - c[1], dz = z - c[2];
    if (dx * dx + dy * dy + dz * dz <= rv * rv) lab[(z * ny + y) * nx + x] = 1;
  }
  seg.loadLabelmap(lab);
  const center = [0, 0, 0];
  const radius = Math.hypot(96, 96, 96);
  let pokeN = 0;
  return {
    scene,
    seg,
    paint,
    driver,
    center,
    radius,
    dims,
    poke(centerRAS, radiusMm) {
      paint.stampStroke([centerRAS], { radiusMm, id: allocId(`poke_${pokeN++}`), mode: "add" });
    },
    onRedraw(cb) {
      redrawCbs.push(cb);
    },
    setRenderMode(m) {
      if (m === mode) return;
      logic.destroy();
      mode = m;
      makeLogic();
      for (const cb of redrawCbs) cb();
    },
    renderMode: () => mode,
    refine() {
      logic.refineNow();
    },
    setAllOpacity(op) {
      allOpacity = op;
      for (const [id] of labelColors) {
        labelLook.get(id).op = op;
        applyLook(id);
      }
      logic.refineNow();
    },
    allOpacity: () => allOpacity,
    randomizeLook() {
      for (const [id] of labelColors) {
        const lk = { op: 0.3 + Math.random() * 0.7, shading: Math.random() < 0.5 ? "surface" : "volume" };
        labelLook.set(id, lk);
        applyLook(id);
      }
      logic.refineNow();
    },
    resetLook() {
      allOpacity = 1;
      for (const [id] of labelColors) {
        labelLook.set(id, { op: 1, shading: "surface" });
        applyLook(id);
      }
      logic.refineNow();
    }
  };
}

// algorithms/demos/algorithms-browser.ts
var status = (msg, err = false) => {
  const el = document.getElementById("status-text");
  if (el) {
    el.textContent = msg;
    el.style.color = err ? "#ff6b74" : "#9fb3d0";
  }
};
async function main() {
  const canvas = document.getElementById("gpu");
  if (!navigator.gpu) {
    status("WebGPU not available \u2014 try Chrome/Edge 113+ or Safari 18+.", true);
    return;
  }
  status("initializing WebGPU\u2026");
  const gpu = await initDevice();
  globalThis.__gpuErr = [];
  gpu.device.addEventListener("uncapturederror", (e) => globalThis.__gpuErr.push(String(e.error?.message ?? e.error)));
  const ctx = canvas.getContext("webgpu");
  const preferred = navigator.gpu.getPreferredCanvasFormat();
  const srgb = preferred + "-srgb";
  ctx.configure({ device: gpu.device, format: preferred, viewFormats: [srgb], alphaMode: "opaque" });
  const a = buildAlgorithmsScene(gpu, srgb);
  const camera = framedCamera(a.center, a.radius, 2.8);
  const a3d = mountAdaptive3d({
    scene: () => a.scene,
    view: () => ctx.getCurrentTexture().createView({ format: srgb }),
    size: () => ({ w: canvas.width, h: canvas.height }),
    setCamera: (s, w, h) => s.setCamera(camera.position, camera.focalPoint, camera.viewUp, camera.viewAngle, w, h),
    gpu,
    onFrame: () => {
    }
  });
  const draw = () => a3d.draw();
  const drawNow = () => a3d.renderSettled(true);
  a.onRedraw(() => drawNow());
  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const size = Math.min(760, Math.floor(canvas.clientWidth * dpr));
    canvas.width = size;
    canvas.height = size;
    drawNow();
  };
  globalThis.addEventListener("resize", resize);
  attachCameraControls(canvas, camera, { onChange: draw });
  let n = 0;
  const poke = () => {
    const R = 70;
    const c = [(Math.random() * 2 - 1) * R, (Math.random() * 2 - 1) * R, (Math.random() * 2 - 1) * R];
    a.poke(c, 16 + Math.random() * 12);
    status(`poked ${++n} sphere${n === 1 ? "" : "s"} through the shared buffer \xB7 surface re-rendered in place`);
  };
  document.getElementById("poke")?.addEventListener("click", poke);
  let painting = false, strokeN = 0;
  const paintStroke = async () => {
    if (painting) return;
    painting = true;
    const R = 55, N = 26;
    const cx = (Math.random() * 2 - 1) * 30, cy = (Math.random() * 2 - 1) * 30, cz = (Math.random() * 2 - 1) * 30;
    a.driver.beginStroke({ segmentId: `stroke_${++strokeN}`, effect: "Paint", brush: { shape: "sphere", diameterMm: 14 } });
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1) * Math.PI * 1.5;
      a.driver.addPoint([cx + R * Math.cos(t), cy + R * Math.sin(t) * 0.6, cz + i / N * 40 - 20]);
      status(`painting stroke from the SegEdit stream\u2026 sample ${i + 1}/${N}`);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    a.driver.endStroke();
    status(`painted a stroke via SegEditDriver (${N} samples, interpolated) \xB7 orbit to inspect`);
    painting = false;
  };
  document.getElementById("paint")?.addEventListener("click", paintStroke);
  const modeBtn = document.getElementById("mode");
  const syncModeBtn = () => {
    if (modeBtn) modeBtn.textContent = a.renderMode() === "sdf" ? "Render: SDF" : "Render: Gaussian";
  };
  syncModeBtn();
  modeBtn?.addEventListener("click", () => {
    a.setRenderMode(a.renderMode() === "sdf" ? "surface" : "sdf");
    syncModeBtn();
    drawNow();
    status(`render path: ${a.renderMode() === "sdf" ? "SDF (crisp, terrace-free)" : "Gaussian (gradient-opacity)"}`);
  });
  document.getElementById("rand")?.addEventListener("click", () => {
    a.randomizeLook();
    drawNow();
    status("randomized per-segment opacity + surface/volume shading");
  });
  document.getElementById("opaque")?.addEventListener("click", () => {
    a.resetLook();
    drawNow();
    status("all segments opaque surfaces");
  });
  document.getElementById("reset")?.addEventListener("click", () => location.reload());
  resize();
  status("surface-mode segmentation \xB7 drag to orbit \xB7 scroll/pinch to zoom \xB7 Poke to edit the shared buffer");
  globalThis.__algoDbg = {
    dist: () => camera.distance,
    err: () => (globalThis.__gpuErr || []).length
  };
}
main();
