// LightningMenu — v0 of the SlicerLive state-explorer.
//
// Spacebar (or the gold lightning bolt in the upper-left of the viewport)
// strikes a fractal lightning tree from the button outward. Each branch tip
// is a candidate state-transition for the current LiveScene. More likely
// guesses get bigger, more central tiles (the trunk endpoint and main
// branches); less likely ones live on the smaller twigs.
//
// Click an entry to "apply" it (v0 = host hook + toast; real apply paths
// land next).
//
// The catalog data here is a v0 vendored snapshot of
//   LiveInterface/src/catalog/{layouts,vrPresets}.ts
// because viewer/build.sh runs in a Docker container that only mounts
// viewer/, not the sibling LiveInterface/. When the build grows to bundle
// from @slicerlive/liveinterface, the whole inline block goes away.

// ---------------------------------------------------------------------------
// Vendored catalog snapshot (matches LiveInterface/src/catalog/, 2026-06-20)
// ---------------------------------------------------------------------------

const layoutsCatalog = [
  { category: 'layout', id: 'one-up-3d', label: '3D only', shape: [[0,0,1,1]],
    description: 'Single 3D view, maximum screen real estate.', delta: { kind: 'layout', layoutId: 4, layoutSymbol: 'SlicerLayoutOneUp3DView' } },
  { category: 'layout', id: 'dual-3d', label: 'Dual 3D', shape: [[0,0,0.48,1],[0.52,0,0.48,1]],
    description: 'Two 3D views — compare rendering parameters.', delta: { kind: 'layout', layoutId: 15, layoutSymbol: 'SlicerLayoutDual3DView' } },
  { category: 'layout', id: 'one-up-red', label: 'Axial', shape: [[0,0,1,1]], shapeAccent: '#e85a5a',
    description: 'Axial slice only, full screen.', appliesWhen: { hasVolume: true }, delta: { kind: 'layout', layoutId: 6, layoutSymbol: 'SlicerLayoutOneUpRedSliceView' } },
  { category: 'layout', id: 'one-up-yellow', label: 'Sagittal', shape: [[0,0,1,1]], shapeAccent: '#e8c95a',
    description: 'Sagittal slice only, full screen.', appliesWhen: { hasVolume: true }, delta: { kind: 'layout', layoutId: 7, layoutSymbol: 'SlicerLayoutOneUpYellowSliceView' } },
  { category: 'layout', id: 'one-up-green', label: 'Coronal', shape: [[0,0,1,1]], shapeAccent: '#5ae89a',
    description: 'Coronal slice only, full screen.', appliesWhen: { hasVolume: true }, delta: { kind: 'layout', layoutId: 8, layoutSymbol: 'SlicerLayoutOneUpGreenSliceView' } },
  { category: 'layout', id: 'side-by-side', label: 'Side by side', shape: [[0,0,0.48,1],[0.52,0,0.48,1]],
    description: 'Two slice views side by side.', appliesWhen: { hasVolume: true }, delta: { kind: 'layout', layoutId: 29, layoutSymbol: 'SlicerLayoutSideBySideView' } },
  { category: 'layout', id: 'conventional', label: 'Conventional',
    shape: [[0,0,1,0.5],[0,0.55,0.32,0.45],[0.34,0.55,0.32,0.45],[0.68,0.55,0.32,0.45]],
    description: '3D on top, three slices below.', appliesWhen: { hasVolume: true }, delta: { kind: 'layout', layoutId: 2, layoutSymbol: 'SlicerLayoutConventionalView' } },
  { category: 'layout', id: 'four-up', label: '4-up',
    shape: [[0,0,0.48,0.48],[0.52,0,0.48,0.48],[0,0.52,0.48,0.48],[0.52,0.52,0.48,0.48]],
    description: '3D + axial + sagittal + coronal.', appliesWhen: { hasVolume: true }, delta: { kind: 'layout', layoutId: 3, layoutSymbol: 'SlicerLayoutFourUpView' } },
  { category: 'layout', id: 'three-by-three-slice', label: '3×3 slices',
    shape: [[0,0,0.31,0.31],[0.35,0,0.31,0.31],[0.69,0,0.31,0.31],[0,0.35,0.31,0.31],[0.35,0.35,0.31,0.31],[0.69,0.35,0.31,0.31],[0,0.69,0.31,0.31],[0.35,0.69,0.31,0.31],[0.69,0.69,0.31,0.31]],
    description: 'Nine slice viewports in a 3×3 grid.', appliesWhen: { hasVolume: true }, delta: { kind: 'layout', layoutId: 33, layoutSymbol: 'SlicerLayoutThreeByThreeSliceView' } },
  { category: 'layout', id: 'compare-grid', label: 'Compare grid',
    shape: [[0,0,0.31,0.48],[0.35,0,0.31,0.48],[0.69,0,0.31,0.48],[0,0.52,0.31,0.48],[0.35,0.52,0.31,0.48],[0.69,0.52,0.31,0.48]],
    description: 'N×M comparison grid.', appliesWhen: { hasVolume: true }, delta: { kind: 'layout', layoutId: 23, layoutSymbol: 'SlicerLayoutCompareGridView' } },
];

// Gradient swatches roughly evoke each preset's transfer-function palette.
const vrPresetsCatalog = [
  { category: 'vr-preset', id: 'ct-bone', label: 'CT-Bone', swatch: 'linear-gradient(90deg,#3a1a08 0%,#9a4a1c 38%,#ed8a30 65%,#fff5d0 100%)',
    description: 'Skeleton — bone opaque, soft tissue translucent.', appliesWhen: { modality: 'CT' }, delta: { kind: 'vr-preset', presetName: 'CT-Bone' } },
  { category: 'vr-preset', id: 'ct-lung', label: 'CT-Lung', swatch: 'linear-gradient(90deg,#0a0a14 0%,#1c2c44 45%,#3a78a4 80%,#dfe9f0 100%)',
    description: 'Lung parenchyma — air visible, soft tissue suppressed.', appliesWhen: { modality: 'CT' }, delta: { kind: 'vr-preset', presetName: 'CT-Lung' } },
  { category: 'vr-preset', id: 'ct-soft-tissue', label: 'CT-Soft-Tissue', swatch: 'linear-gradient(90deg,#1a0e08 0%,#7a4830 50%,#dba87e 85%,#fff0d8 100%)',
    description: 'Soft-tissue emphasis across organs.', appliesWhen: { modality: 'CT' }, delta: { kind: 'vr-preset', presetName: 'CT-Soft-Tissue' } },
  { category: 'vr-preset', id: 'ct-chest-contrast-enhanced', label: 'CT-Chest-CE', swatch: 'linear-gradient(90deg,#100808 0%,#883830 45%,#ddb070 80%,#fff5dc 100%)',
    description: 'IV-contrast thoracic studies.', appliesWhen: { modality: 'CT' }, delta: { kind: 'vr-preset', presetName: 'CT-Chest-Contrast-Enhanced' } },
  { category: 'vr-preset', id: 'ct-pulmonary-arteries', label: 'CT-Pulm-Art', swatch: 'linear-gradient(90deg,#080814 0%,#2c1c54 45%,#a44078 78%,#ffd0d8 100%)',
    description: 'Pulmonary artery emphasis (PE workups).', appliesWhen: { modality: 'CT' }, delta: { kind: 'vr-preset', presetName: 'CT-Pulmonary-Arteries' } },
  { category: 'vr-preset', id: 'ct-aaa', label: 'CT-AAA', swatch: 'linear-gradient(90deg,#1c0a08 0%,#9c3030 50%,#e09060 80%,#fff0c8 100%)',
    description: 'Aortic aneurysm — emphasizes vasculature.', appliesWhen: { modality: 'CT' }, delta: { kind: 'vr-preset', presetName: 'CT-AAA' } },
  { category: 'vr-preset', id: 'ct-cardiac', label: 'CT-Cardiac', swatch: 'linear-gradient(90deg,#180808 0%,#6c2828 45%,#cc7060 78%,#fce4d0 100%)',
    description: 'Heart chambers and myocardium.', appliesWhen: { modality: 'CT' }, delta: { kind: 'vr-preset', presetName: 'CT-Cardiac' } },
  { category: 'vr-preset', id: 'ct-mip', label: 'CT-MIP', swatch: 'linear-gradient(90deg,#000 0%,#888 60%,#fff 100%)',
    description: 'Maximum intensity projection.', appliesWhen: { modality: 'CT' }, delta: { kind: 'vr-preset', presetName: 'CT-MIP' } },
  { category: 'vr-preset', id: 'ct-x-ray', label: 'CT-X-ray', swatch: 'linear-gradient(90deg,#000 0%,#3a3a3a 40%,#bcbcbc 80%,#fff 100%)',
    description: 'Planar X-ray appearance.', appliesWhen: { modality: 'CT' }, delta: { kind: 'vr-preset', presetName: 'CT-X-ray' } },
  // MR
  { category: 'vr-preset', id: 'mr-default', label: 'MR-Default', swatch: 'linear-gradient(90deg,#000 0%,#444 50%,#bcbcbc 85%,#fff 100%)',
    description: 'Generic MR transfer function.', appliesWhen: { modality: 'MR' }, delta: { kind: 'vr-preset', presetName: 'MR-Default' } },
  { category: 'vr-preset', id: 'mr-angio', label: 'MR-Angio', swatch: 'linear-gradient(90deg,#0a0814 0%,#3a2870 45%,#8c5cc0 80%,#f0e0ff 100%)',
    description: 'MR angiography.', appliesWhen: { modality: 'MR' }, delta: { kind: 'vr-preset', presetName: 'MR-Angio' } },
  { category: 'vr-preset', id: 'mr-t2-brain', label: 'MR-T2-Brain', swatch: 'linear-gradient(90deg,#000 0%,#3c3c3c 45%,#a0a0a0 80%,#f4f4ff 100%)',
    description: 'T2-weighted brain — gray/white matter, CSF.', appliesWhen: { modality: 'MR' }, delta: { kind: 'vr-preset', presetName: 'MR-T2-Brain' } },
  { category: 'vr-preset', id: 'mr-mip', label: 'MR-MIP', swatch: 'linear-gradient(90deg,#000 0%,#666 60%,#fff 100%)',
    description: 'MR maximum intensity projection.', appliesWhen: { modality: 'MR' }, delta: { kind: 'vr-preset', presetName: 'MR-MIP' } },
];

function matchesCondition(condition, caps) {
  if (!condition) return true;
  if (condition.hasVolume && !caps.hasVolume) return false;
  if (condition.hasSegmentation && !caps.hasSegmentation) return false;
  if (condition.modality && caps.activeModality !== condition.modality) return false;
  if (condition.minSegments != null && (caps.segmentCount || 0) < condition.minSegments) return false;
  return true;
}

// ---- New catalog entries (vendored from LiveInterface/src/catalog) -----

const wlPresetsCatalog = [
  { category: 'wl-preset', id: 'wl-ct-bone', label: 'CT-Bone (W/L)',
    description: 'W=1000 L=400 — emphasize bone.', appliesWhen: { modality: 'CT' },
    delta: { kind: 'wl-preset', presetName: 'CT-Bone', window: 1000, level: 400 } },
  { category: 'wl-preset', id: 'wl-ct-air', label: 'CT-Air (W/L)',
    description: 'W=1000 L=-426 — emphasize air-filled structures.', appliesWhen: { modality: 'CT' },
    delta: { kind: 'wl-preset', presetName: 'CT-Air', window: 1000, level: -426 } },
  { category: 'wl-preset', id: 'wl-ct-brain', label: 'CT-Brain (W/L)',
    description: 'W=100 L=50 — brain tissue window.', appliesWhen: { modality: 'CT' },
    delta: { kind: 'wl-preset', presetName: 'CT-Brain', window: 100, level: 50 } },
  { category: 'wl-preset', id: 'wl-ct-abdomen', label: 'CT-Abdomen (W/L)',
    description: 'W=350 L=40 — abdominal soft tissue.', appliesWhen: { modality: 'CT' },
    delta: { kind: 'wl-preset', presetName: 'CT-Abdomen', window: 350, level: 40 } },
  { category: 'wl-preset', id: 'wl-ct-lung', label: 'CT-Lung (W/L)',
    description: 'W=1400 L=-500 — lung parenchyma.', appliesWhen: { modality: 'CT' },
    delta: { kind: 'wl-preset', presetName: 'CT-Lung', window: 1400, level: -500 } },
  { category: 'wl-preset', id: 'wl-pet', label: 'PET (W/L)',
    description: 'W=10000 L=6000.', appliesWhen: { modality: 'PET' },
    delta: { kind: 'wl-preset', presetName: 'PET', window: 10000, level: 6000 } },
  { category: 'wl-preset', id: 'wl-dti', label: 'DTI (W/L)',
    description: 'W=1 L=0.5 — DTI scalar (e.g. FA).', appliesWhen: { modality: 'DTI' },
    delta: { kind: 'wl-preset', presetName: 'DTI', window: 1, level: 0.5 } },
];

function camN(p, u, sym) {
  const m = Math.hypot(p[0], p[1], p[2]) || 1;
  return { kind: 'camera', position: [p[0]/m, p[1]/m, p[2]/m], viewUp: u, symbol: sym };
}
const cameraPresetsCatalog = [
  { category: 'camera', id: 'cam-anterior',  label: 'Anterior view',  description: 'From the front (along −Y).',  delta: camN([0,1,0],   [0,0,1], 'A') },
  { category: 'camera', id: 'cam-posterior', label: 'Posterior view', description: 'From behind (along +Y).',     delta: camN([0,-1,0],  [0,0,1], 'P') },
  { category: 'camera', id: 'cam-superior',  label: 'Superior view',  description: 'From above (along −Z).',      delta: camN([0,0,1],   [0,1,0], 'S') },
  { category: 'camera', id: 'cam-inferior',  label: 'Inferior view',  description: 'From below (along +Z).',      delta: camN([0,0,-1],  [0,-1,0],'I') },
  { category: 'camera', id: 'cam-right',     label: 'Right view',     description: 'Patient\'s right side.',      delta: camN([1,0,0],   [0,0,1], 'R') },
  { category: 'camera', id: 'cam-left',      label: 'Left view',      description: 'Patient\'s left side.',       delta: camN([-1,0,0],  [0,0,1], 'L') },
  { category: 'camera', id: 'cam-iso-as',    label: 'Iso (A+S)',      description: 'Upper-anterior isometric.',   delta: camN([0,1,1],   [0,0,1], 'AS') },
  { category: 'camera', id: 'cam-iso-ras',   label: 'Iso (R+A+S)',    description: 'Upper-anterior-right iso.',   delta: camN([1,1,1],   [0,0,1], 'RAS') },
];

const segVisBundlesCatalog = [
  { category: 'segment-vis', id: 'seg-all-on',  label: 'All segments on',
    description: 'Show every segment.',                            appliesWhen: { hasSegmentation: true, minSegments: 1 },
    delta: { kind: 'segment-vis', mode: 'all-on' } },
  { category: 'segment-vis', id: 'seg-all-off', label: 'All segments off',
    description: 'Hide every segment.',                            appliesWhen: { hasSegmentation: true, minSegments: 1 },
    delta: { kind: 'segment-vis', mode: 'all-off' } },
  { category: 'segment-vis', id: 'seg-solo-first', label: 'Solo first segment',
    description: 'Show only the first segment.',                   appliesWhen: { hasSegmentation: true, minSegments: 2 },
    delta: { kind: 'segment-vis', mode: 'solo-first' } },
  { category: 'segment-vis', id: 'seg-fade-others', label: 'Fade other segments',
    description: 'Highlight first; dim the rest (v0: shows all).', appliesWhen: { hasSegmentation: true, minSegments: 2 },
    delta: { kind: 'segment-vis', mode: 'fade-others' } },
];

/** Rank entries by a v0 heuristic — most "universally useful right now" first.
 *  This is the placeholder for the eventual learned-confidence model. */
function rankEntries(caps, dynamic) {
  const all = [
    ...layoutsCatalog, ...vrPresetsCatalog, ...wlPresetsCatalog,
    ...cameraPresetsCatalog, ...segVisBundlesCatalog,
    ...(dynamic || []),       // scene-specific entries (series-switch, etc.)
  ].filter((e) => matchesCondition(e.appliesWhen, caps));
  const score = (e) => {
    let s = 0;
    if (e.category === 'vr-preset' && caps.activeModality && e.appliesWhen && e.appliesWhen.modality === caps.activeModality) {
      s += 100;
      if (e.id === 'ct-bone' || e.id === 'mr-default') s += 50;
      if (e.id === 'ct-chest-contrast-enhanced' || e.id === 'ct-soft-tissue' || e.id === 'mr-t2-brain') s += 25;
    }
    if (e.category === 'wl-preset' && caps.activeModality && e.appliesWhen && e.appliesWhen.modality === caps.activeModality) {
      s += 75;                                                                // useful but a 2D-only concern -> below VR + layout
      if (e.id === 'wl-ct-bone' || e.id === 'wl-ct-brain') s += 20;
    }
    if (e.category === 'layout') {
      s += 60;
      if (e.id === 'four-up') s += 60;
      if (e.id === 'one-up-3d' || e.id === 'conventional') s += 30;
      if (e.id === 'one-up-red' || e.id === 'one-up-yellow' || e.id === 'one-up-green') s += 15;
    }
    if (e.category === 'camera') {
      s += 50;                                                                // visually fun and visible everywhere
      if (e.id === 'cam-anterior' || e.id === 'cam-iso-ras') s += 20;         // most common starting orientations
    }
    if (e.category === 'segment-vis') {
      s += 45;                                                                // only useful if there are segments; condition gates
      if (e.id === 'seg-solo-first') s += 15;
    }
    if (e.category === 'series-switch') {
      // Switching series for a multi-series ReMIND-style study is a major,
      // very-visible action -- rank highly so it shows up on the trunk + branches.
      s += 90;
    }
    return s;
  };
  return all.map((e) => [e, score(e)]).sort((a, b) => b[1] - a[1]).map(([e]) => e);
}

// ---------------------------------------------------------------------------
// Fractal lightning tree geometry — programmatic
//
// Origin at the lightning button. Trunk fans down-right. Three primary
// branches break off the trunk; each carries one twig. Tile sizes scale with
// depth: trunk endpoint = LARGE, branches = MEDIUM, twigs = SMALL.
// ---------------------------------------------------------------------------

const TIER_SIZES = {
  large:  { w: 220, h: 130, fz: 14, desc: true,  swatchH: 18 },
  medium: { w: 156, h: 92,  fz: 12, desc: true,  swatchH: 12 },
  small:  { w: 116, h: 64,  fz: 11, desc: false, swatchH: 9 },
};

/** Lay tiles out on a polar fan from the button origin. Each tile gets its
 *  OWN bolt from the button (no shared trunk) — visually this reads as a
 *  burst of forked lightning radiating out. Tier assigns importance: large
 *  in the center-right, mediums above/along/below, smalls on the outer arc.
 *  Angles in radians from horizontal-right; sweeping clockwise as Y grows. */
function buildTree(originX, originY) {
  const vw = Math.max(420, window.innerWidth);
  const vh = Math.max(360, window.innerHeight);
  // Scale radii to the viewport — narrower viewports pull tiles closer
  const R = Math.min(1.0, vw / 1280) * Math.min(1.0, vh / 820);
  // Plan: [tier, angleRad, baseDist]. Angles chosen for visual spread + so
  // tiles don't crowd vertically or horizontally.
  const plan = [
    ['large',   0.55,  380],         // central, slightly above the trunk axis
    ['medium',  0.12,  330],         // upper
    ['medium',  0.55,  600],         // farther along the central axis
    ['medium',  1.05,  340],         // lower
    ['small',  -0.20,  470],         // upper outer
    ['small',   0.25,  560],
    ['small',   0.55,  780],         // very far on central axis
    ['small',   0.95,  580],
    ['small',   1.35,  470],         // lower outer
  ];
  const slots = [], segs = [];
  for (const [tier, a, dRaw] of plan) {
    const d = dRaw * (0.7 + 0.3 * R);     // shrink toward 70% on tiny viewports
    const cx = originX + Math.cos(a) * d;
    const cy = originY + Math.sin(a) * d;
    slots.push({ tier, cx, cy, anchorX: originX, anchorY: originY });
    // Bolt goes from origin to an anchor JUST INSIDE the tile (so the path
    // visually terminates at the tile's near edge, not its center).
    const ts = TIER_SIZES[tier];
    const inset = Math.max(ts.w, ts.h) * 0.45;
    const ax = cx - Math.cos(a) * inset, ay = cy - Math.sin(a) * inset;
    const depth = tier === 'large' ? 0 : tier === 'medium' ? 1 : 2;
    segs.push({ x1: originX, y1: originY, x2: ax, y2: ay, depth });
  }
  // Resolve any residual overlap (cheap insurance for small viewports).
  resolveTileOverlap(slots);
  // Clamp to viewport.
  const margin = 12;
  for (const s of slots) {
    const ts = TIER_SIZES[s.tier];
    s.cx = Math.max(margin + ts.w / 2, Math.min(vw - margin - ts.w / 2, s.cx));
    s.cy = Math.max(margin + ts.h / 2, Math.min(vh - margin - ts.h / 2, s.cy));
  }
  return { segs, slots };
}

function rectFor(slot) {
  const ts = TIER_SIZES[slot.tier];
  return { x: slot.cx - ts.w / 2, y: slot.cy - ts.h / 2, w: ts.w, h: ts.h };
}
function rectsOverlap(a, b, pad = 10) {
  return !(a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x ||
           a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y);
}
function resolveTileOverlap(slots) {
  // Greedy: walk slots in priority order (large -> medium -> small). For each
  // slot, if it overlaps any earlier slot, slide it further away from its
  // anchor (along the anchor -> center vector) in steps until clear.
  const order = ['large', 'medium', 'small'];
  const placed = [];
  for (const tier of order) {
    for (const slot of slots) {
      if (slot.tier !== tier) continue;
      // unit vector anchor -> center
      const ax = slot.cx - slot.anchorX, ay = slot.cy - slot.anchorY;
      const len = Math.max(1, Math.hypot(ax, ay));
      const ux = ax / len, uy = ay / len;
      let iter = 0;
      while (iter++ < 40) {
        const r = rectFor(slot);
        const hit = placed.some((p) => rectsOverlap(r, p));
        if (!hit) break;
        slot.cx += ux * 14; slot.cy += uy * 14;
      }
      placed.push(rectFor(slot));
    }
  }
}

/** Recursive midpoint-displacement fractal lightning between two endpoints.
 *  Returns an SVG `d` string. At each level, displace the midpoint perpendicular
 *  to the segment by a random amount (capped by amp), then recurse on the two
 *  halves with reduced amp. Optionally sprouts a short side-fork (the visual
 *  "branches" you get in real lightning) with probability `branchProb`. */
function fractalBoltSegments(x1, y1, x2, y2, depth, amp, branchProb) {
  const out = [];
  const stack = [{ x1, y1, x2, y2, depth, amp }];
  while (stack.length) {
    const s = stack.pop();
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    if (s.depth === 0 || len < 4) { out.push([s.x1, s.y1, s.x2, s.y2]); continue; }
    const px = -dy / len, py = dx / len;
    const off = (Math.random() - 0.5) * 2 * s.amp;
    const mx = (s.x1 + s.x2) / 2 + px * off;
    const my = (s.y1 + s.y2) / 2 + py * off;
    stack.push({ x1: mx, y1: my, x2: s.x2, y2: s.y2, depth: s.depth - 1, amp: s.amp * 0.58 });
    stack.push({ x1: s.x1, y1: s.y1, x2: mx, y2: my, depth: s.depth - 1, amp: s.amp * 0.58 });
    // Side fork
    if (branchProb > 0 && Math.random() < branchProb && s.depth > 2) {
      const baseA = Math.atan2(dy, dx);
      const a = baseA + (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.55);
      const bl = len * (0.18 + Math.random() * 0.22);
      const bx = mx + Math.cos(a) * bl, by = my + Math.sin(a) * bl;
      stack.push({ x1: mx, y1: my, x2: bx, y2: by, depth: s.depth - 2, amp: s.amp * 0.4 });
    }
  }
  return out;
}
function segmentsToPathD(segs) {
  // Group into chains where possible (consecutive segs share an endpoint),
  // but it's cheap to just emit M/L pairs.
  let d = '';
  for (const [x1, y1, x2, y2] of segs) {
    d += 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + 'L' + x2.toFixed(1) + ' ' + y2.toFixed(1);
  }
  return d;
}
function jitterPath(x1, y1, x2, y2, depth) {
  // depth-tuned recursion + amplitude + side-branching probability
  const len = Math.hypot(x2 - x1, y2 - y1);
  const recDepth = depth === 0 ? 7 : depth === 1 ? 6 : 5;
  const amp = depth === 0 ? Math.min(36, len * 0.16)
            : depth === 1 ? Math.min(22, len * 0.14)
            :               Math.min(14, len * 0.12);
  const branchProb = depth === 0 ? 0.55 : depth === 1 ? 0.40 : 0.20;
  return segmentsToPathD(fractalBoltSegments(x1, y1, x2, y2, recDepth, amp, branchProb));
}

// ---------------------------------------------------------------------------
// UI — button, menu (fractal tree), spacebar
// ---------------------------------------------------------------------------

function lightningSvg(px) {
  px = px || 28;
  return (
    '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px + '" style="display:block;overflow:visible">' +
      '<defs>' +
        '<filter id="lmGlow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.6"/></filter>' +
        '<linearGradient id="lmGold" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0%" stop-color="#fff4c2"/><stop offset="45%" stop-color="#ffd34d"/><stop offset="100%" stop-color="#ffa726"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<path d="M14 1 L4 13 L11 13 L8 23 L20 10 L13 10 Z" fill="#ffc63a" opacity="0.55" filter="url(#lmGlow)"/>' +
      '<path d="M14 1 L4 13 L11 13 L8 23 L20 10 L13 10 Z" fill="url(#lmGold)" stroke="#fff7d6" stroke-width="0.5" stroke-linejoin="round"/>' +
    '</svg>'
  );
}

// Mini-scene visual for a tile. Layouts -> SVG of viewport shape;
// VR presets -> a gradient swatch in the entry's palette.
// Map a catalog entry to CSS for its tile preview background.
// PREFERRED PATH: a per-entry REAL re-render (host's generateTilePreviews hook
// applied the delta against a forked scene, captured the canvas, and put the
// data URL in _lmTilePreviews). That image IS what the scene becomes -- no
// CSS approximation needed.
// FALLBACK: the single shared snapshot of the current scene + per-category
// CSS filter/crop that approximates the delta. Used while per-entry renders
// are still in flight, or when the host doesn't support generateTilePreviews.
function snapshotStyleFor(entry) {
  const perEntry = _lmTilePreviews && _lmTilePreviews.get && _lmTilePreviews.get(entry.id);
  if (perEntry) {
    return 'background-image:url(' + JSON.stringify(perEntry) + '); background-size:cover; background-position:center;';
  }
  if (!_lmSnapshot) return null;
  const base = 'background-image:url(' + JSON.stringify(_lmSnapshot) + '); background-size:cover; background-position:center;';
  if (entry.category === 'layout' && entry.shape) {
    // Crop to the relevant quadrant of the current 4-up canvas.
    // SlicerLive's existing layout is 4-up: top-left=axial, top-right=3D, bottom-left=coronal, bottom-right=sagittal.
    const QUAD = {
      'one-up-3d':     '100% 0%',          // top-right quadrant zoom
      'one-up-red':    '0% 0%',            // top-left = axial
      'one-up-green':  '0% 100%',          // bottom-left = coronal
      'one-up-yellow': '100% 100%',        // bottom-right = sagittal
    };
    if (QUAD[entry.id]) {
      return base + ' background-size:200% 200%; background-position:' + QUAD[entry.id] + ';';
    }
    // 4-up / conventional / others: just show the snapshot as-is.
    return base;
  }
  if (entry.category === 'vr-preset' && entry.swatch) {
    // Approximate the preset's palette via hue-rotate + saturate on top of the snapshot.
    // Hue extracted from the gradient's first warm stop -- crude but conveys "this gets warmer / cooler".
    const swatch = entry.swatch || '';
    let hue = 0, sat = 1, bright = 1;
    if (/CT-Bone|CT-Bones|CT-Cropped|CT-Soft|CT-Muscle|CT-Fat|CT-Chest|CT-Liver/i.test(entry.label)) { hue = -8; sat = 1.4; bright = 1.1; }
    else if (/CT-Lung|CT-Pulm/i.test(entry.label))     { hue = 30; sat = 0.7; bright = 0.9; }
    else if (/CT-MIP|MR-MIP/i.test(entry.label))       { hue = 0;  sat = 0;   bright = 1.05; }
    else if (/CT-AAA|CT-Cardiac|CT-Coronary/i.test(entry.label)) { hue = -15; sat = 1.5; bright = 1.0; }
    else if (/CT-X-ray/i.test(entry.label))            { hue = 0;  sat = 0;   bright = 0.95; }
    else if (/MR-Default|MR-T2-Brain/i.test(entry.label)) { hue = 0; sat = 0.5; bright = 1.0; }
    else if (/MR-Angio/i.test(entry.label))            { hue = 60; sat = 1.2; bright = 1.0; }
    else if (/US-Fetal/i.test(entry.label))            { hue = 20; sat = 0.6; bright = 1.0; }
    return base + ' filter: brightness(' + bright + ') saturate(' + sat + ') hue-rotate(' + hue + 'deg);';
  }
  if (entry.category === 'wl-preset' && entry.delta) {
    // CSS brightness/contrast that approximates the W/L change.
    // The current canvas was rendered with the volume's intrinsic W/L; this is the *change* from that.
    // Heuristic: narrower window -> higher contrast; lower level -> dimmer.
    const W = entry.delta.window, L = entry.delta.level;
    // Reference: 1000/0 = unity; CT-Bone(1000,400) lifts level; CT-Lung(1400,-500) darkens.
    const contrast = Math.max(0.5, Math.min(2.5, 1000 / Math.max(1, W)));
    const brightness = Math.max(0.4, Math.min(1.6, 1 + L / 1500));
    return base + ' filter: contrast(' + contrast.toFixed(2) + ') brightness(' + brightness.toFixed(2) + ');';
  }
  if (entry.category === 'camera') {
    // No real re-render at this size -- show the snapshot with a perspective rotation
    // suggesting the new viewing angle. Imperfect but visually telegraphs "camera moved".
    const p = entry.delta.position;
    const ry = Math.atan2(p[0], p[1] + 0.001) * 180 / Math.PI * 0.4;  // L/R tilt
    const rx = Math.atan2(p[2], Math.hypot(p[0], p[1]) + 0.001) * 180 / Math.PI * 0.35;
    return base + ' transform: perspective(220px) rotateY(' + ry.toFixed(1) + 'deg) rotateX(' + (-rx).toFixed(1) + 'deg);';
  }
  // segment-vis fallthrough handled in renderer (overlay dots on top)
  if (entry.category === 'segment-vis') return base;
  return base;
}

function tileVisualHTML(entry, tier) {
  const ts = TIER_SIZES[tier];
  if (entry.category === 'layout' && entry.shape) {
    const w = ts.w - 22, h = ts.h - (ts.desc ? 52 : 32);
    let rects = '';
    for (const [rx, ry, rw, rh] of entry.shape) {
      rects += '<rect x="' + (rx * w).toFixed(1) + '" y="' + (ry * h).toFixed(1) + '" width="' + (rw * w).toFixed(1) + '" height="' + (rh * h).toFixed(1) + '"' +
               ' fill="' + (entry.shapeAccent || 'rgba(255,210,90,0.18)') + '" stroke="rgba(255,235,160,0.55)" stroke-width="0.8" rx="2"/>';
    }
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="display:block;border-radius:4px">' + rects + '</svg>';
  }
  if (entry.category === 'vr-preset' && entry.swatch) {
    return '<div style="height:' + ts.swatchH + 'px;border-radius:4px;background:' + entry.swatch + ';box-shadow:inset 0 0 0 1px rgba(255,255,255,0.18)"></div>';
  }
  if (entry.category === 'wl-preset' && entry.delta) {
    // Visualize W/L as a brightness ramp: black left → mid gray at level → white right
    const W = entry.delta.window, L = entry.delta.level;
    const lo = L - W / 2, hi = L + W / 2;
    return '<div style="height:' + ts.swatchH + 'px;border-radius:4px;background:linear-gradient(90deg,#000,#777 50%,#fff);box-shadow:inset 0 0 0 1px rgba(255,255,255,0.18)" title="W=' + W + ' L=' + L + ' (' + lo.toFixed(0) + '..' + hi.toFixed(0) + ')"></div>';
  }
  if (entry.category === 'camera' && entry.delta) {
    // Mini "RAS axes" graphic with the camera position highlighted
    const w = ts.w - 22, h = Math.min(48, ts.h - (ts.desc ? 52 : 32));
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.32;
    const p = entry.delta.position;
    // Project the 3D unit direction onto a 2D pseudo-iso view: x' = X - 0.5*Y, y' = Z - 0.5*Y
    const px = cx + p[0] * r - p[1] * r * 0.5;
    const py = cy - p[2] * r + p[1] * r * 0.5;
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="display:block">' +
      // Axis lines
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx + r) + '" y2="' + cy + '" stroke="#ff8a8a" stroke-width="1"/>' +
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + cx + '" y2="' + (cy - r) + '" stroke="#8aff9a" stroke-width="1"/>' +
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx - r * 0.5) + '" y2="' + (cy + r * 0.5) + '" stroke="#8aaaff" stroke-width="1"/>' +
      // Camera position dot
      '<circle cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="3.5" fill="#ffd86b" stroke="#fff" stroke-width="1"/>' +
      // Symbol label
      '<text x="' + (w - 4) + '" y="' + (h - 4) + '" text-anchor="end" font-family="-apple-system,system-ui" font-size="10" font-weight="700" fill="rgba(255,236,140,0.85)">' + entry.delta.symbol + '</text>' +
      '</svg>';
  }
  if (entry.category === 'segment-vis') {
    // Small row of dots representing segments + the bundle's visibility state
    const mode = entry.delta && entry.delta.mode;
    const dots = [];
    for (let i = 0; i < 6; i++) {
      let on = true;
      if (mode === 'all-off') on = false;
      else if (mode === 'solo-first') on = (i === 0);
      else if (mode === 'fade-others') on = (i === 0);
      // all-on -> on stays true
      const color = on ? '#ffd86b' : 'rgba(255,236,140,0.18)';
      const opacity = on ? '1' : '0.55';
      dots.push('<circle cx="' + (8 + i * 16) + '" cy="10" r="5" fill="' + color + '" opacity="' + opacity + '" stroke="rgba(255,255,255,0.3)" stroke-width="0.7"/>');
    }
    return '<svg width="' + (8 + 6 * 16) + '" height="20" viewBox="0 0 ' + (8 + 6 * 16) + ' 20" style="display:block">' + dots.join('') + '</svg>';
  }
  return '';
}

let _lmBtn = null;
let _lmBtnSvg = null;
// Proximity state for the button: norm is 0 (cursor touching the button) → 1 (cursor far away).
// angle is the radians from the button center to the cursor (used to point a plasma arc).
const _lmBtnState = { norm: 1, angle: 0, rafPending: false };
let _lmFlickerIv = 0;
let _lmOverlay = null;
let _lmHooks = null;
// Carousel state (valid while _lmOverlay is open)
let _lmRanked = [];         // entries in order of confidence
let _lmTiles = [];          // tile DOM elements parallel to _lmRanked (or null)
let _lmSelectedIdx = -1;    // -1 = no carousel selection yet
let _lmPreviewEl = null;    // big centered preview element while cycling
let _lmSnapshot = null;     // data URL of the current scene canvas (fallback shared snapshot)
let _lmTilePreviews = null; // Map<entry.id, dataURL> — per-entry real re-renders (progressive)
let _lmFreezeEl = null;     // static-snapshot layer that covers the canvas during preview loop

function closeMenu() {
  if (_lmOverlay) { _lmOverlay.remove(); _lmOverlay = null; }
  if (_lmFreezeEl) { _lmFreezeEl.remove(); _lmFreezeEl = null; }
  // If a drag was in progress, clean up the orphan ghost + target highlight.
  if (_lmDragGhost) { _lmDragGhost.remove(); _lmDragGhost = null; }
  if (_lmDragTarget) { _lmHighlightDropTarget(_lmDragTarget, false); _lmDragTarget = null; }
  _lmRanked = []; _lmTiles = []; _lmSelectedIdx = -1; _lmPreviewEl = null;
  _lmSnapshot = null; _lmTilePreviews = null;
  _lmRepaintButton();        // released the "engaged" plasma state, return to natural proximity behavior
}
function toggleMenu() {
  if (_lmOverlay) { closeMenu(); return; }
  openMenu();
}

// Apply whichever entry is currently selected; if none, apply the top.
function applyCurrent() {
  if (!_lmHooks || !_lmHooks.applyEntry || !_lmRanked.length) { closeMenu(); return; }
  const idx = _lmSelectedIdx >= 0 ? _lmSelectedIdx : 0;
  try { _lmHooks.applyEntry(_lmRanked[idx]); }
  catch (e) { console.error('[lightning] applyEntry threw', e); }
  closeMenu();
}

// Highlight the tile at the given index; unhighlight all others.
function highlightTile(idx) {
  for (let i = 0; i < _lmTiles.length; i++) {
    const t = _lmTiles[i]; if (!t) continue;
    if (i === idx) {
      t.style.boxShadow = '0 14px 36px rgba(0,0,0,0.6), 0 0 38px rgba(255,210,90,0.55), inset 0 1px 0 rgba(255,255,255,0.2)';
      t.style.borderColor = 'rgba(255,236,140,0.85)';
      t.style.transform = 'translateY(0) scale(1.04)';
    } else {
      t.style.boxShadow = '0 8px 24px rgba(0,0,0,0.55), 0 0 18px rgba(255,180,60,0.18), inset 0 1px 0 rgba(255,255,255,0.12)';
      t.style.borderColor = 'rgba(255,206,90,0.32)';
      t.style.transform = 'translateY(0) scale(1)';
    }
  }
}

// Build the big "carousel" preview for entry. Visual fills ~70% viewport,
// shows the entry's label + description + a LARGE version of its visual hint.
// Layouts -> big viewport grid; VR presets -> wide gradient swatch + palette
// notes. (Live re-render against the user's actual data lands later — for
// now the preview makes the metaphor concrete via stylized representations.)
function buildPreviewElement(entry) {
  const vw = Math.max(640, window.innerWidth), vh = Math.max(440, window.innerHeight);
  const W = Math.min(Math.round(vw * 0.72), 980);
  const H = Math.min(Math.round(vh * 0.76), 720);
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:absolute; left:50%; top:50%; transform:translate(-50%,-50%) scale(0.97);' +
    ' width:' + W + 'px; height:' + H + 'px; padding:24px 28px 22px; border-radius:18px;' +
    ' background:linear-gradient(135deg, rgba(40,46,72,0.74), rgba(14,18,32,0.84));' +
    ' backdrop-filter:blur(28px) saturate(1.7); -webkit-backdrop-filter:blur(28px) saturate(1.7);' +
    ' border:1px solid rgba(255,222,120,0.5);' +
    ' box-shadow:0 24px 64px rgba(0,0,0,0.7), 0 0 60px rgba(255,180,60,0.28), inset 0 1px 0 rgba(255,255,255,0.16);' +
    ' opacity:0; transition:opacity 140ms ease-out, transform 140ms cubic-bezier(.2,.7,.2,1);' +
    ' display:flex; flex-direction:column; gap:14px; color:#fff5d6; overflow:hidden;';

  // Header: category chip + label + modality
  const head = document.createElement('div');
  head.style.cssText = 'display:flex; align-items:baseline; gap:14px;';
  const chip = document.createElement('span');
  const CAT_LABEL = {
    'layout': 'Layout', 'vr-preset': 'Volume rendering preset',
    'wl-preset': 'Window / Level', 'camera': 'Camera view', 'segment-vis': 'Segments',
    'series-switch': 'Switch series',
  };
  chip.textContent = CAT_LABEL[entry.category] || entry.category;
  chip.style.cssText = 'font:700 10px -apple-system,system-ui,sans-serif;letter-spacing:1.4px;text-transform:uppercase;color:#ffd86b;padding:3px 9px;border:1px solid rgba(255,210,90,0.5);border-radius:8px;';
  const lab = document.createElement('div');
  lab.textContent = entry.label;
  lab.style.cssText = 'font:800 28px -apple-system,system-ui,sans-serif;letter-spacing:0.3px;text-shadow:0 0 24px rgba(255,200,80,0.45);';
  head.appendChild(chip); head.appendChild(lab);
  if (entry.appliesWhen && entry.appliesWhen.modality) {
    const mod = document.createElement('span');
    mod.textContent = entry.appliesWhen.modality;
    mod.style.cssText = 'font:600 11px -apple-system,system-ui,sans-serif;letter-spacing:1px;color:rgba(238,247,255,0.55);margin-left:auto;';
    head.appendChild(mod);
  }
  wrap.appendChild(head);

  if (entry.description) {
    const desc = document.createElement('div');
    desc.textContent = entry.description;
    desc.style.cssText = 'font:14px -apple-system,system-ui,sans-serif;color:rgba(238,247,255,0.78);line-height:1.45;max-width:88%;';
    wrap.appendChild(desc);
  }

  // Big visual — fills the rest of the card.
  // When we have a live snapshot of the current scene, USE IT as the background
  // (with the same per-category CSS filter / crop that the tile uses) so the
  // carousel preview shows the user's actual data, not an abstract icon. The
  // category-specific overlays (axes, dots, W/L numbers) layer on top.
  const big = document.createElement('div');
  const snapStyle = _lmSnapshot ? snapshotStyleFor(entry) : null;
  big.style.cssText = 'flex:1; min-height:0; display:flex; align-items:center; justify-content:center; border-radius:12px;' +
    ' background:rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.08); position:relative; overflow:hidden;' +
    (snapStyle ? ' ' + snapStyle : '');
  // When snapshot is available, layer category-specific overlays ON TOP rather
  // than the old stylized "big visual". This keeps the abstract icon as the
  // fallback for the no-snapshot case (drop mode etc.).
  if (_lmSnapshot && entry.category === 'segment-vis') {
    const inner = document.createElement('div');
    inner.style.cssText = 'position:absolute; bottom:24px; left:0; right:0; display:flex; gap:18px; flex-wrap:wrap; justify-content:center; align-items:center; padding:0 12px;';
    const mode = entry.delta && entry.delta.mode;
    for (let i = 0; i < 7; i++) {
      let on = true;
      if (mode === 'all-off') on = false;
      else if (mode === 'solo-first') on = (i === 0);
      else if (mode === 'fade-others') on = (i === 0);
      const d = document.createElement('div');
      d.style.cssText = 'width:48px; height:48px; border-radius:12px;' +
        ' background:' + (on ? 'linear-gradient(135deg,#ffd86b,#ff9c1c)' : 'rgba(8,10,18,0.6)') + ';' +
        ' box-shadow:' + (on ? '0 6px 24px rgba(255,180,60,0.55), inset 0 1px 0 rgba(255,255,255,0.25)' : 'inset 0 0 0 1px rgba(255,236,140,0.3)') + ';' +
        ' opacity:' + (on ? '1' : '0.7') + ';';
      inner.appendChild(d);
    }
    big.appendChild(inner);
  } else if (_lmSnapshot && entry.category === 'camera' && entry.delta) {
    // Big symbol badge in the corner of the snapshot
    const sym = document.createElement('div');
    sym.textContent = entry.delta.symbol;
    sym.style.cssText = 'position:absolute; bottom:18px; right:22px; font:800 64px -apple-system,system-ui,sans-serif;' +
      ' color:#fff5d6; padding:6px 16px; border-radius:14px; background:rgba(8,10,18,0.62); border:2px solid rgba(255,236,140,0.55);' +
      ' text-shadow:0 0 24px rgba(255,200,80,0.6);';
    big.appendChild(sym);
  } else if (_lmSnapshot && entry.category === 'series-switch') {
    // Big "→ <series label>" pill, centered at the bottom
    const sym = document.createElement('div');
    sym.innerHTML = '<span style="opacity:0.7; font-weight:400">switch to</span> &nbsp; ' + (entry.delta.seriesLabel || 'series').replace(/</g, '&lt;');
    sym.style.cssText = 'position:absolute; bottom:22px; left:50%; transform:translateX(-50%); font:700 22px -apple-system,system-ui,sans-serif;' +
      ' color:#1a0f00; padding:10px 28px; border-radius:14px; background:linear-gradient(135deg,#ffd86b,#ff9c1c);' +
      ' box-shadow:0 8px 30px rgba(255,160,40,0.55), inset 0 1px 0 rgba(255,255,255,0.3);';
    big.appendChild(sym);
  } else if (_lmSnapshot && entry.category === 'wl-preset' && entry.delta) {
    // W/L numeric callout
    const wl = document.createElement('div');
    wl.innerHTML = 'W=<b>' + entry.delta.window + '</b> · L=<b>' + entry.delta.level + '</b>';
    wl.style.cssText = 'position:absolute; bottom:22px; left:50%; transform:translateX(-50%); font:600 22px -apple-system,system-ui,sans-serif;' +
      ' color:#fff5d6; padding:8px 18px; border-radius:12px; background:rgba(8,10,18,0.62); border:1px solid rgba(255,236,140,0.45);' +
      ' text-shadow:0 0 12px rgba(255,200,80,0.4);';
    big.appendChild(wl);
  } else if (_lmSnapshot && (entry.category === 'layout' || entry.category === 'vr-preset')) {
    // Snapshot + filter/crop is sufficient — no overlay needed. (The crop /
    // CSS filter is already applied via snapStyle on the container.)
  } else if (entry.category === 'layout' && entry.shape) {
    const w = Math.round(W * 0.78), h = Math.round((H - 200) * 0.92);
    let rects = '';
    for (const [rx, ry, rw, rh] of entry.shape) {
      rects += '<rect x="' + (rx * w).toFixed(1) + '" y="' + (ry * h).toFixed(1) + '" width="' + (rw * w).toFixed(1) + '" height="' + (rh * h).toFixed(1) + '"' +
               ' fill="' + (entry.shapeAccent || 'rgba(255,210,90,0.16)') + '" stroke="rgba(255,235,160,0.7)" stroke-width="1.4" rx="6"/>';
    }
    big.innerHTML = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="display:block">' + rects + '</svg>';
  } else if (entry.category === 'vr-preset' && entry.swatch) {
    const swatch = document.createElement('div');
    swatch.style.cssText = 'width:80%; height:48%; border-radius:10px; background:' + entry.swatch + ';' +
      ' box-shadow:inset 0 0 0 1px rgba(255,255,255,0.18), 0 6px 30px rgba(255,180,60,0.18);';
    big.appendChild(swatch);
    const note = document.createElement('div');
    note.textContent = '(live preview on the loaded volume lands next — for now: the preset\'s characteristic color palette)';
    note.style.cssText = 'position:absolute; bottom:12px; left:0; right:0; text-align:center; font:11px -apple-system,system-ui,sans-serif; color:rgba(238,247,255,0.45);';
    big.appendChild(note);
  } else if (entry.category === 'wl-preset' && entry.delta) {
    // Big W/L brightness ramp + numeric callout
    const W2 = entry.delta.window, L2 = entry.delta.level, lo = L2 - W2/2, hi = L2 + W2/2;
    const inner = document.createElement('div');
    inner.style.cssText = 'width:78%; display:flex; flex-direction:column; gap:14px; align-items:center;';
    const ramp = document.createElement('div');
    ramp.style.cssText = 'width:100%; height:120px; border-radius:12px; background:linear-gradient(90deg,#000,#777 50%,#fff);' +
      ' box-shadow:inset 0 0 0 1px rgba(255,255,255,0.2), 0 6px 30px rgba(255,180,60,0.18);';
    inner.appendChild(ramp);
    const numbers = document.createElement('div');
    numbers.innerHTML = 'Window <b style="color:#fff5d6">' + W2 + '</b> · Level <b style="color:#fff5d6">' + L2 + '</b><br>' +
      '<span style="opacity:0.55">intensity range ' + lo.toFixed(0) + ' … ' + hi.toFixed(0) + '</span>';
    numbers.style.cssText = 'text-align:center; font:600 18px -apple-system,system-ui,sans-serif; line-height:1.6;';
    inner.appendChild(numbers);
    big.appendChild(inner);
  } else if (entry.category === 'camera' && entry.delta) {
    // Big 3-axis schematic with the camera position marker
    const sz = Math.min(Math.round(W * 0.42), Math.round((H - 220) * 0.7));
    const cx = sz / 2, cy = sz / 2, r = sz * 0.36;
    const p = entry.delta.position;
    const px = cx + p[0] * r - p[1] * r * 0.5;
    const py = cy - p[2] * r + p[1] * r * 0.5;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(sz)); svg.setAttribute('height', String(sz));
    svg.setAttribute('viewBox', '0 0 ' + sz + ' ' + sz);
    svg.style.cssText = 'display:block;';
    // Axes
    svg.innerHTML =
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx + r) + '" y2="' + cy + '" stroke="#ff8a8a" stroke-width="2"/>' +
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + cx + '" y2="' + (cy - r) + '" stroke="#8aff9a" stroke-width="2"/>' +
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx - r * 0.5) + '" y2="' + (cy + r * 0.5) + '" stroke="#8aaaff" stroke-width="2"/>' +
      '<text x="' + (cx + r + 4) + '" y="' + (cy + 4) + '" font:600 12px sans-serif fill="#ff8a8a">R</text>' +
      '<text x="' + (cx + 4) + '" y="' + (cy - r - 4) + '" font:600 12px sans-serif fill="#8aff9a">S</text>' +
      '<text x="' + (cx - r * 0.5 - 14) + '" y="' + (cy + r * 0.5 + 12) + '" font:600 12px sans-serif fill="#8aaaff">A</text>' +
      // Focal-camera ray
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + px + '" y2="' + py + '" stroke="rgba(255,236,140,0.55)" stroke-width="2" stroke-dasharray="3 3"/>' +
      '<circle cx="' + px + '" cy="' + py + '" r="10" fill="#ffd86b" stroke="#fff" stroke-width="2"/>' +
      '<text x="' + (px + 14) + '" y="' + (py + 5) + '" font:700 16px sans-serif fill="#fff5d6">' + entry.delta.symbol + '</text>';
    big.appendChild(svg);
  } else if (entry.category === 'segment-vis') {
    const mode = entry.delta && entry.delta.mode;
    const inner = document.createElement('div');
    inner.style.cssText = 'display:flex; gap:18px; flex-wrap:wrap; justify-content:center; align-items:center; padding:0 12px;';
    for (let i = 0; i < 7; i++) {
      let on = true;
      if (mode === 'all-off') on = false;
      else if (mode === 'solo-first') on = (i === 0);
      else if (mode === 'fade-others') on = (i === 0);
      const d = document.createElement('div');
      d.style.cssText = 'width:64px; height:64px; border-radius:14px; transition:opacity 100ms ease-out;' +
        ' background:' + (on ? 'linear-gradient(135deg,#ffd86b,#ff9c1c)' : 'rgba(255,236,140,0.10)') + ';' +
        ' box-shadow:' + (on ? '0 6px 24px rgba(255,180,60,0.45), inset 0 1px 0 rgba(255,255,255,0.25)' : 'inset 0 0 0 1px rgba(255,236,140,0.2)') + ';' +
        ' opacity:' + (on ? '1' : '0.55') + ';';
      inner.appendChild(d);
    }
    big.appendChild(inner);
  } else {
    big.textContent = '(no preview visual)';
    big.style.color = 'rgba(238,247,255,0.45)';
  }
  wrap.appendChild(big);

  const hint = document.createElement('div');
  hint.innerHTML = '<span style="opacity:0.6">← →</span> cycle · <span style="opacity:0.6">space</span> apply · <span style="opacity:0.6">esc</span> dismiss';
  hint.style.cssText = 'font:12px -apple-system,system-ui,sans-serif; color:rgba(238,247,255,0.55); text-align:center; letter-spacing:0.3px;';
  wrap.appendChild(hint);

  return wrap;
}

function showPreviewFor(idx) {
  if (!_lmOverlay || !_lmRanked.length) return;
  // Wrap index
  if (idx < 0) idx = _lmRanked.length - 1;
  if (idx >= _lmRanked.length) idx = 0;
  _lmSelectedIdx = idx;
  const entry = _lmRanked[idx];
  // Replace previous preview
  if (_lmPreviewEl) { _lmPreviewEl.remove(); _lmPreviewEl = null; }
  _lmPreviewEl = buildPreviewElement(entry);
  _lmOverlay.appendChild(_lmPreviewEl);
  requestAnimationFrame(() => { if (_lmPreviewEl) { _lmPreviewEl.style.opacity = '1'; _lmPreviewEl.style.transform = 'translate(-50%,-50%) scale(1)'; } });
  highlightTile(idx);
}

function openMenu() {
  if (_lmOverlay || !_lmHooks) return;
  const caps = (_lmHooks.getCapabilities && _lmHooks.getCapabilities()) || { hasVolume: false };
  const dynamic = (_lmHooks.getDynamicEntries && _lmHooks.getDynamicEntries()) || [];
  const ranked = rankEntries(caps, dynamic);
  _lmRanked = ranked; _lmSelectedIdx = -1; _lmTiles = [];
  // Snapshot the current scene canvas — tile previews use this as their background
  // so each candidate is rendered ON THE USER'S DATA, not an abstract icon.
  _lmSnapshot = (_lmHooks.getSnapshot && _lmHooks.getSnapshot()) || null;
  // Freeze the canvas behind the menu: paint the captured snapshot as a fully
  // opaque layer ABOVE the live canvas but BELOW the menu overlay. The
  // per-tile preview loop will mutate the live canvas (camera shifts, VR
  // preset swaps), but nothing of that flicker is visible to the user
  // because the freeze layer covers it. Removed on closeMenu.
  if (_lmSnapshot) {
    _lmFreezeEl = document.createElement('div');
    _lmFreezeEl.style.cssText = 'position:fixed; inset:0; z-index:75; pointer-events:none;' +
      ' background-image:url(' + JSON.stringify(_lmSnapshot) + ');' +
      ' background-size:cover; background-position:center;';
    document.body.appendChild(_lmFreezeEl);
  }

  // Full-viewport overlay (subtle dim + SVG tree + HTML tiles)
  _lmOverlay = document.createElement('div');
  _lmOverlay.style.cssText =
    'position:fixed; inset:0; z-index:76; background:rgba(8,10,18,0.36);' +
    ' opacity:0; transition:opacity 120ms ease-out; pointer-events:auto;' +
    ' font:12px/1.4 -apple-system, system-ui, sans-serif; color:#eef7ff;';
  // click on dim background closes
  _lmOverlay.addEventListener('mousedown', (ev) => { if (ev.target === _lmOverlay) closeMenu(); });
  document.body.appendChild(_lmOverlay);
  // fade dim in
  requestAnimationFrame(() => { _lmOverlay.style.opacity = '1'; });
  _lmRepaintButton();        // menu open → force the button into plasma state regardless of cursor

  // Origin = lightning button's right edge
  let originX = 14 + 48, originY = 12 + 28;       // fallback if button not laid out
  if (_lmBtn) {
    const r = _lmBtn.getBoundingClientRect();
    originX = Math.round(r.right - 4); originY = Math.round(r.bottom - 6);
  }
  const { segs, slots } = buildTree(originX, originY);

  // ----- Empty state -----
  if (!ranked.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'position:absolute; left:' + (originX + 20) + 'px; top:' + (originY + 20) + 'px;' +
      ' max-width:340px; padding:14px 16px; border-radius:12px;' +
      ' background:linear-gradient(135deg, rgba(58,64,88,0.55), rgba(20,24,38,0.62));' +
      ' backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);' +
      ' border:1px solid rgba(255,255,255,0.22); box-shadow:0 12px 40px rgba(0,0,0,0.55);';
    empty.innerHTML = '<div style="font:800 13px -apple-system,system-ui,sans-serif;letter-spacing:0.5px;margin-bottom:6px">Lightning</div>' +
      '<div style="color:rgba(238,247,255,0.6);font-size:12px">Nothing applicable yet — load a volume to see candidate state-transitions.</div>' +
      '<div style="margin-top:10px;font-size:11px;color:rgba(238,247,255,0.4)">space toggle · esc to dismiss</div>';
    _lmOverlay.appendChild(empty);
    return;
  }

  // ----- SVG fractal tree -----
  // The bolt is rendered in FIVE stacked layers per segment for the "burning
  // out the display" feel: ambient halo (very wide blur, soft white), outer
  // glow (wide blur, gold), inner glow (mid blur, brighter), bright core,
  // white-hot spine. Plus a separate "secondary fork" path layer drawn
  // independently with similar but thinner styling.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(window.innerWidth));
  svg.setAttribute('height', String(window.innerHeight));
  svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;overflow:visible;';
  svg.innerHTML =
    '<defs>' +
      '<linearGradient id="lmBolt" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0%" stop-color="#ffffff"/>' +
        '<stop offset="25%" stop-color="#fff7d6"/>' +
        '<stop offset="60%" stop-color="#ffd34d"/>' +
        '<stop offset="100%" stop-color="#ff7a14"/>' +
      '</linearGradient>' +
      '<filter id="lmHalo"     x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="14"/></filter>' +
      '<filter id="lmGlowWide" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="7"/></filter>' +
      '<filter id="lmGlowMid"  x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3"/></filter>' +
      '<filter id="lmGlowTight" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.4"/></filter>' +
    '</defs>';
  _lmOverlay.appendChild(svg);

  // Each segment becomes a 5-layer stack of recursive-fractal paths sharing
  // the same `d`. depth: 0=trunk (loudest), 1=branch, 2=twig.
  const segPaths = [];
  for (const s of segs) {
    const d = jitterPath(s.x1, s.y1, s.x2, s.y2, s.depth);
    const W = s.depth === 0 ? { halo:18, wide:11, mid:6, core:3.6, spine:1.6 }
            : s.depth === 1 ? { halo:13, wide:8,  mid:4.5, core:2.6, spine:1.1 }
            :                 { halo:9,  wide:5,  mid:3,   core:1.8, spine:0.7 };

    const mk = (stroke, w, opacity, filter) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', d); el.setAttribute('fill', 'none');
      el.setAttribute('stroke', stroke); el.setAttribute('stroke-width', String(w));
      el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round');
      el.setAttribute('opacity', String(opacity));
      if (filter) el.setAttribute('filter', 'url(#' + filter + ')');
      svg.appendChild(el);
      return el;
    };
    const halo  = mk('#fff8e0',     W.halo,  0.55, 'lmHalo');
    const wide  = mk('#ffb340',     W.wide,  0.85, 'lmGlowWide');
    const mid   = mk('url(#lmBolt)', W.mid,  0.95, 'lmGlowMid');
    const core  = mk('url(#lmBolt)', W.core, 1.00, 'lmGlowTight');
    const spine = mk('#ffffff',      W.spine, 1.00, null);

    segPaths.push({ layers: [halo, wide, mid, core, spine], depth: s.depth });
  }

  // Strike-in animation: trace each segment via stroke-dashoffset, staggered
  // by depth (trunk → branches → twigs). Plasma flicker via a brief opacity
  // jitter on the wide/halo layers immediately after the strike completes.
  for (const p of segPaths) {
    for (const el of p.layers) {
      const len = el.getTotalLength();
      el.style.strokeDasharray = String(len);
      el.style.strokeDashoffset = String(len);
      const dur = 110 + p.depth * 35;
      const delay = p.depth * 60;
      el.style.transition = 'stroke-dashoffset ' + dur + 'ms cubic-bezier(.18,.78,.22,1) ' + delay + 'ms';
    }
  }
  requestAnimationFrame(() => {
    for (const p of segPaths) for (const el of p.layers) el.style.strokeDashoffset = '0';
  });
  // Crackle: after the trunk strike, give the halo + wide layers a brief
  // opacity flicker — feels like the bolt is burning the display.
  setTimeout(() => {
    for (const p of segPaths) {
      const halo = p.layers[0], wide = p.layers[1];
      const flicker = () => {
        if (!_lmOverlay) return;
        halo.style.opacity = (0.35 + Math.random() * 0.35).toFixed(2);
        wide.style.opacity = (0.7 + Math.random() * 0.25).toFixed(2);
      };
      let n = 0; const iv = setInterval(() => { flicker(); if (++n > 6 || !_lmOverlay) clearInterval(iv); }, 70 + Math.random() * 60);
    }
  }, 350);

  // ----- Tiles at slot endpoints -----
  // Highest-ranked entry goes on the LARGE (trunk) slot; next 3 on medium
  // (branches); rest on small (twigs). If there are fewer entries than slots,
  // the trailing slots stay empty.
  for (let i = 0; i < slots.length && i < ranked.length; i++) {
    const slot = slots[i];
    const entry = ranked[i];
    const ts = TIER_SIZES[slot.tier];
    // tile container (off-screen first; fade in after its branch draws)
    const tile = document.createElement('div');
    tile.style.cssText =
      'position:absolute; left:' + Math.round(slot.cx - ts.w / 2) + 'px; top:' + Math.round(slot.cy - ts.h / 2) + 'px;' +
      ' width:' + ts.w + 'px; height:' + ts.h + 'px;' +
      ' padding:8px 10px 9px; border-radius:11px; cursor:pointer;' +
      ' background:linear-gradient(135deg, rgba(48,54,78,0.62), rgba(18,22,36,0.7));' +
      ' backdrop-filter:blur(14px) saturate(1.4); -webkit-backdrop-filter:blur(14px) saturate(1.4);' +
      ' border:1px solid rgba(255,206,90,0.32);' +
      ' box-shadow:0 8px 24px rgba(0,0,0,0.55), 0 0 18px rgba(255,180,60,0.18), inset 0 1px 0 rgba(255,255,255,0.12);' +
      ' opacity:0; transform:translateY(-4px) scale(0.94);' +
      ' transition:opacity 160ms ease-out, transform 160ms cubic-bezier(.2,.7,.2,1), box-shadow 120ms ease-out;' +
      ' display:flex; flex-direction:column; gap:5px; overflow:hidden;';
    tile.onmouseenter = () => {
      tile.style.boxShadow = '0 10px 28px rgba(0,0,0,0.6), 0 0 26px rgba(255,205,80,0.32), inset 0 1px 0 rgba(255,255,255,0.16)';
      tile.style.borderColor = 'rgba(255,222,120,0.55)';
    };
    tile.onmouseleave = () => {
      tile.style.boxShadow = '0 8px 24px rgba(0,0,0,0.55), 0 0 18px rgba(255,180,60,0.18), inset 0 1px 0 rgba(255,255,255,0.12)';
      tile.style.borderColor = 'rgba(255,206,90,0.32)';
    };
    tile.onclick = (ev) => {
      ev.stopPropagation();
      // Drag-to-mix: if a drag just ended on this tile, the synthetic click
      // should NOT also fire the apply. Skip and let the drop handler own it.
      if (_lmDragJustHappened) { _lmDragJustHappened = false; return; }
      if (_lmHooks && _lmHooks.applyEntry) {
        try { _lmHooks.applyEntry(entry); }
        catch (e) { console.error('[lightning] applyEntry threw', e); }
      }
      closeMenu();
    };
    attachDragToMix(tile, i);     // drag from THIS tile onto another tile -> apply both deltas

    // Live snapshot preview as the tile background (when available). Each entry's
    // delta is approximated via CSS filters / crops / transforms on top of the
    // captured scene -- way more honest than abstract icons. True per-delta
    // re-rendering is a follow-up.
    const previewH = Math.round(ts.h - (ts.desc ? 52 : 32));
    const preview = document.createElement('div');
    preview.className = 'lm-tile-preview';
    const snapStyle = snapshotStyleFor(entry);
    preview.style.cssText = 'flex:1 1 auto; min-height:' + previewH + 'px; border-radius:6px; overflow:hidden; position:relative;' +
      ' background-color:#0a0c14;' +     // fallback if no snapshot
      (snapStyle ? ' ' + snapStyle : '');
    if (!_lmSnapshot) {
      // No snapshot yet (empty scene / drop mode) — fall back to the old abstract icon.
      preview.innerHTML = tileVisualHTML(entry, slot.tier);
    } else if (entry.category === 'segment-vis') {
      // Segment-vis: overlay dots on top of the snapshot to indicate state
      const mode = entry.delta && entry.delta.mode;
      const dotRow = document.createElement('div');
      dotRow.style.cssText = 'position:absolute; bottom:6px; left:6px; right:6px; display:flex; gap:5px; justify-content:center;';
      for (let k = 0; k < 6; k++) {
        let on = true;
        if (mode === 'all-off') on = false;
        else if (mode === 'solo-first') on = (k === 0);
        else if (mode === 'fade-others') on = (k === 0);
        const d = document.createElement('div');
        d.style.cssText = 'width:9px; height:9px; border-radius:50%;' +
          ' background:' + (on ? '#ffd86b' : 'rgba(0,0,0,0.55)') + ';' +
          ' box-shadow:' + (on ? '0 0 6px rgba(255,180,60,0.7)' : '0 0 0 1px rgba(255,236,140,0.3)') + ';';
        dotRow.appendChild(d);
      }
      preview.appendChild(dotRow);
    } else if (entry.category === 'camera' && entry.delta) {
      // Small symbol badge in the corner indicates the camera direction (A/P/L/R/S/I/RAS)
      const sym = document.createElement('div');
      sym.textContent = entry.delta.symbol;
      sym.style.cssText = 'position:absolute; bottom:4px; right:6px; font:700 11px -apple-system,system-ui,sans-serif;' +
        ' color:#fff5d6; padding:2px 6px; border-radius:6px; background:rgba(8,10,18,0.65); border:1px solid rgba(255,236,140,0.4);' +
        ' text-shadow:0 0 8px rgba(255,200,80,0.4);';
      preview.appendChild(sym);
    } else if (entry.category === 'series-switch') {
      // Big "→ <series label>" pill at the bottom indicating the swap target
      const sym = document.createElement('div');
      sym.innerHTML = '→ ' + (entry.delta.seriesLabel || 'series').replace(/</g, '&lt;');
      sym.style.cssText = 'position:absolute; bottom:4px; left:6px; right:6px; font:700 11px -apple-system,system-ui,sans-serif;' +
        ' color:#1a0f00; padding:3px 8px; border-radius:6px; background:linear-gradient(135deg,#ffd86b,#ff9c1c);' +
        ' box-shadow:0 4px 14px rgba(255,160,40,0.45); text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      preview.appendChild(sym);
    } else if (entry.category === 'wl-preset' && entry.delta) {
      // W/L numeric badge in the corner
      const wl = document.createElement('div');
      wl.textContent = 'W=' + entry.delta.window + ' L=' + entry.delta.level;
      wl.style.cssText = 'position:absolute; bottom:4px; right:6px; font:600 10px -apple-system,system-ui,sans-serif;' +
        ' color:#fff5d6; padding:2px 5px; border-radius:5px; background:rgba(8,10,18,0.65); border:1px solid rgba(255,236,140,0.4);';
      preview.appendChild(wl);
    }
    tile.appendChild(preview);

    // Label sits ABOVE the snapshot so it doesn't disappear into bright pixels.
    // Using a 100%-width strip with a frosted bg keeps it readable.
    const label = document.createElement('div');
    label.textContent = entry.label;
    label.style.cssText = 'position:absolute; top:8px; left:10px; right:10px; padding:3px 7px; border-radius:6px;' +
      ' font:700 ' + ts.fz + 'px -apple-system,system-ui,sans-serif;color:#fff5d6;letter-spacing:0.2px;' +
      ' background:rgba(8,10,18,0.55); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);' +
      ' text-shadow:0 0 10px rgba(255,200,80,0.45); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    tile.appendChild(label);

    if (ts.desc && entry.description) {
      const desc = document.createElement('div');
      desc.textContent = entry.description;
      desc.style.cssText = 'position:absolute; bottom:8px; left:10px; right:10px; padding:3px 7px; border-radius:6px;' +
        ' font:11px -apple-system,system-ui,sans-serif;color:rgba(238,247,255,0.85);line-height:1.3;' +
        ' background:rgba(8,10,18,0.55); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);' +
        ' overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      tile.appendChild(desc);
    }
    _lmOverlay.appendChild(tile);
    _lmTiles[i] = tile;

    // Fade-in staggered after the connecting branch finishes drawing.
    const tileDelay = slot.tier === 'large' ? 130 : slot.tier === 'medium' ? 200 : 270;
    setTimeout(() => { tile.style.opacity = '1'; tile.style.transform = 'translateY(0) scale(1)'; }, tileDelay);
  }

  // Footer hint
  const foot = document.createElement('div');
  foot.style.cssText = 'position:absolute; left:14px; bottom:10px; font:11px -apple-system,system-ui,sans-serif;' +
    ' color:rgba(238,247,255,0.5); padding:6px 10px; border-radius:8px;' +
    ' background:rgba(8,10,18,0.4); border:1px solid rgba(255,255,255,0.08);';
  foot.textContent = 'space · click apply · drag tile → tile to mix · esc dismiss · cmd+z undo';
  _lmOverlay.appendChild(foot);

  // ----- Kick off per-tile REAL re-renders in the background -----
  // Each entry forks the scene, applies its delta, renders, captures, and
  // restores. ~50 ms per tile × 9 ≈ 500 ms total — runs while the user is
  // looking at the placeholders. Tiles update progressively as the previews
  // land. Skip when the host doesn't support it (e.g. no scene loaded).
  if (_lmHooks.generateTilePreviews && ranked.length) {
    // Width hint: the largest visible tier's pixel width.
    const dimsHint = { w: TIER_SIZES.large.w };
    Promise.resolve(_lmHooks.generateTilePreviews(ranked.slice(0, slots.length), dimsHint))
      .then((map) => {
        // The menu could have been closed in the meantime; the snapshot map only
        // matters while the overlay is still alive.
        if (!_lmOverlay) return;
        _lmTilePreviews = map || new Map();
        _refreshAllTilePreviews();
        // If the carousel preview is currently up, refresh it too.
        if (_lmPreviewEl && _lmSelectedIdx >= 0) showPreviewFor(_lmSelectedIdx);
      })
      .catch((err) => console.warn('[lightning] generateTilePreviews failed', err));
  }
}

// ---- Drag-to-mix ----------------------------------------------------------
// mousedown on a tile starts a "maybe drag" gesture: after the cursor moves
// past a small threshold (5 px), a "ghost" of the tile follows the cursor and
// the tile under the cursor highlights as the drop target. mouseup over a
// different tile applies BOTH deltas as one undoable step (via the host's
// applyMixed hook). Click without movement falls through to the tile's
// existing onclick (apply just this entry). Cancellation: mouseup outside any
// other tile, or ESC during drag.
const _LM_DRAG_THRESH = 5;
let _lmDragGhost = null;
let _lmDragTarget = null;
let _lmDragJustHappened = false;   // set briefly after a drag so the synthetic click is swallowed

function _lmFindTileUnderCursor(x, y, exclude) {
  for (let i = 0; i < _lmTiles.length; i++) {
    const t = _lmTiles[i];
    if (!t || t === exclude) continue;
    const r = t.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { tile: t, idx: i };
  }
  return null;
}
function _lmMakeGhost(srcTile) {
  // Snapshot the tile's appearance by cloning it. Inline styles + bg-image
  // data URLs carry over. Add a "+" badge so the mix gesture is obvious.
  const g = srcTile.cloneNode(true);
  const r = srcTile.getBoundingClientRect();
  g.style.position = 'fixed';
  g.style.left = (r.left) + 'px';
  g.style.top  = (r.top)  + 'px';
  g.style.width  = r.width  + 'px';
  g.style.height = r.height + 'px';
  g.style.opacity = '0.85';
  g.style.transform = 'translate(0,0) scale(0.92) rotate(-2.5deg)';
  g.style.transition = 'transform 80ms ease-out';
  g.style.pointerEvents = 'none';
  g.style.zIndex = '90';
  g.style.boxShadow = '0 18px 50px rgba(0,0,0,0.6), 0 0 36px rgba(255,210,90,0.45), inset 0 1px 0 rgba(255,255,255,0.22)';
  g.style.border = '1px solid rgba(255,236,140,0.85)';
  const plus = document.createElement('div');
  plus.textContent = '+';
  plus.style.cssText = 'position:absolute; right:-12px; bottom:-12px; width:34px; height:34px;' +
    ' border-radius:50%; background:linear-gradient(135deg,#ffd86b,#ff9c1c); color:#1a0f00;' +
    ' display:flex; align-items:center; justify-content:center; font:800 24px -apple-system,system-ui,sans-serif;' +
    ' box-shadow:0 6px 18px rgba(0,0,0,0.55), 0 0 14px rgba(255,200,80,0.55);';
  g.appendChild(plus);
  return g;
}
function _lmHighlightDropTarget(tile, on) {
  if (!tile) return;
  if (on) {
    tile.style.boxShadow = '0 14px 36px rgba(0,0,0,0.6), 0 0 42px rgba(255,210,90,0.7), inset 0 1px 0 rgba(255,255,255,0.22)';
    tile.style.borderColor = 'rgba(255,236,140,0.95)';
    tile.style.transform = 'translateY(-2px) scale(1.04)';
  } else {
    tile.style.boxShadow = '0 8px 24px rgba(0,0,0,0.55), 0 0 18px rgba(255,180,60,0.18), inset 0 1px 0 rgba(255,255,255,0.12)';
    tile.style.borderColor = 'rgba(255,206,90,0.32)';
    tile.style.transform = 'translateY(0) scale(1)';
  }
}

function attachDragToMix(tile, sourceIdx) {
  tile.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    const startX = ev.clientX, startY = ev.clientY;
    let dragging = false;

    const onMove = (mv) => {
      if (!dragging) {
        if (Math.hypot(mv.clientX - startX, mv.clientY - startY) < _LM_DRAG_THRESH) return;
        dragging = true;
        _lmDragGhost = _lmMakeGhost(tile);
        document.body.appendChild(_lmDragGhost);
      }
      // Position ghost so its origin tracks the cursor offset from start
      const r = tile.getBoundingClientRect();
      _lmDragGhost.style.transform = 'translate(' + (mv.clientX - startX) + 'px,' + (mv.clientY - startY) + 'px) scale(0.92) rotate(-2.5deg)';
      // Update drop target highlight
      const hit = _lmFindTileUnderCursor(mv.clientX, mv.clientY, tile);
      const newTarget = hit ? hit.tile : null;
      if (newTarget !== _lmDragTarget) {
        if (_lmDragTarget) _lmHighlightDropTarget(_lmDragTarget, false);
        if (newTarget) _lmHighlightDropTarget(newTarget, true);
        _lmDragTarget = newTarget;
      }
    };

    const onUp = (uv) => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      if (!dragging) return;     // click without drag — let normal onclick handle it
      _lmDragJustHappened = true;
      // Stop the synthetic click from also firing the source tile's apply
      setTimeout(() => { _lmDragJustHappened = false; }, 80);

      const hit = _lmFindTileUnderCursor(uv.clientX, uv.clientY, tile);
      if (_lmDragTarget) _lmHighlightDropTarget(_lmDragTarget, false);
      if (_lmDragGhost) { _lmDragGhost.remove(); _lmDragGhost = null; }
      _lmDragTarget = null;
      if (hit && _lmHooks && _lmHooks.applyMixed) {
        try { _lmHooks.applyMixed(_lmRanked[sourceIdx], _lmRanked[hit.idx]); }
        catch (e) { console.error('[lightning mix]', e); }
        closeMenu();
      }
      // If no drop target, drag is just cancelled. Menu stays open.
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  });
}

// Re-render each tile's preview-div CSS using the (possibly updated) snapshot
// map. Cheap: we just rewrite the background-image style + drop any CSS
// approximation filters since the per-entry render is the truth.
function _refreshAllTilePreviews() {
  for (let i = 0; i < _lmTiles.length; i++) {
    const tile = _lmTiles[i]; const entry = _lmRanked[i];
    if (!tile || !entry) continue;
    const preview = _lmTilePreviews && _lmTilePreviews.get && _lmTilePreviews.get(entry.id);
    if (!preview) continue;
    const previewDiv = tile.querySelector('.lm-tile-preview');
    if (!previewDiv) continue;
    previewDiv.style.backgroundImage = 'url(' + JSON.stringify(preview) + ')';
    previewDiv.style.backgroundSize = 'cover';
    previewDiv.style.backgroundPosition = 'center';
    previewDiv.style.filter = 'none';
    previewDiv.style.transform = 'none';
    // Quick crossfade-style swap so the upgrade feels intentional rather than a "pop"
    previewDiv.style.transition = 'opacity 200ms ease-out';
    previewDiv.style.opacity = '0.6';
    requestAnimationFrame(() => requestAnimationFrame(() => { previewDiv.style.opacity = '1'; }));
  }
}

// Plasma-globe button SVG. The button has THREE visual states governed by a single
// "proximity" value `norm` (0 = touching, 1 = far away):
//   - DORMANT (norm ≈ 1): a subtle glowing gold dot with a gentle breath. Pilot-light.
//   - PLASMA  (norm ≈ 0): a translucent gold globe with ambient arcs flickering inside +
//                         one bright arc pointing at the cursor (glass plasma globe).
//   - STRIKE  (click):    no change at the button itself — the existing menu's fractal
//                         lightning is the "strike out" and emerges from the button origin.
// All viewBox coordinates are in a 100x100 frame; the button is 48px but overflow is
// visible so the plasma can bloom outward.
function plasmaButtonSvg() {
  return (
    '<svg viewBox="0 0 100 100" width="48" height="48" style="display:block;overflow:visible">' +
      '<defs>' +
        '<radialGradient id="lmDotGrad" cx="50" cy="50" r="22" gradientUnits="userSpaceOnUse">' +
          '<stop offset="0%" stop-color="#fffce8"/>' +
          '<stop offset="35%" stop-color="#ffd34d"/>' +
          '<stop offset="100%" stop-color="#ffa726" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<radialGradient id="lmGlobeGrad" cx="50" cy="50" r="44" gradientUnits="userSpaceOnUse">' +
          '<stop offset="0%" stop-color="#ffffff"/>' +
          '<stop offset="25%" stop-color="#fff7d6"/>' +
          '<stop offset="60%" stop-color="#ffd34d" stop-opacity="0.85"/>' +
          '<stop offset="100%" stop-color="#ff7a14" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<radialGradient id="lmGlassHi" cx="38" cy="36" r="30" gradientUnits="userSpaceOnUse">' +
          '<stop offset="0%" stop-color="rgba(255,255,255,0.5)"/>' +
          '<stop offset="60%" stop-color="rgba(255,255,255,0.06)"/>' +
          '<stop offset="100%" stop-color="rgba(255,255,255,0)"/>' +
        '</radialGradient>' +
        '<filter id="lmGlowSoft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5"/></filter>' +
        '<filter id="lmGlowTight" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.4"/></filter>' +
        // Plasma turbulence — displaces the arc paths into wiggly fractal shapes (re-seeds via flicker)
        '<filter id="lmPlasma" x="-60%" y="-60%" width="220%" height="220%">' +
          '<feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" seed="3"/>' +
          '<feDisplacementMap in="SourceGraphic" scale="6"/>' +
          '<feGaussianBlur stdDeviation="0.6"/>' +
        '</filter>' +
      '</defs>' +
      // -------- DORMANT (fades out as cursor approaches) --------
      '<g class="lm-dot" opacity="1">' +
        '<circle cx="50" cy="50" r="22" fill="url(#lmDotGrad)" opacity="0.55" filter="url(#lmGlowSoft)"/>' +
        '<circle cx="50" cy="50" r="10" fill="url(#lmDotGrad)" filter="url(#lmGlowTight)"/>' +
        '<circle cx="50" cy="50" r="4"  fill="#fff7d6"/>' +
        // Breath animation on the inner core: gentle pulse
        '<animate xlink:href="#" attributeName="opacity" values="0.8;1.0;0.8" dur="2.6s" repeatCount="indefinite"/>' +
      '</g>' +
      // -------- PLASMA GLOBE (fades in as cursor approaches) --------
      '<g class="lm-globe" opacity="0">' +
        // Outer warm halo
        '<circle cx="50" cy="50" r="46" fill="url(#lmGlobeGrad)" opacity="0.55" filter="url(#lmGlowSoft)"/>' +
        // Globe body
        '<circle cx="50" cy="50" r="30" fill="url(#lmGlobeGrad)" filter="url(#lmGlowTight)"/>' +
        // Glass highlight (off-center, upper-left)
        '<circle cx="50" cy="50" r="30" fill="url(#lmGlassHi)"/>' +
        // Ambient arcs (3 spaced angles, plasma-displaced, flicker driven by JS)
        '<g class="lm-arcs-ambient" filter="url(#lmPlasma)">' +
          '<path d="M 50 50 L 72 36" stroke="#fff7d6" stroke-width="1.6" stroke-linecap="round" fill="none" opacity="0.75"/>' +
          '<path d="M 50 50 L 30 62" stroke="#fff7d6" stroke-width="1.4" stroke-linecap="round" fill="none" opacity="0.65"/>' +
          '<path d="M 50 50 L 56 76" stroke="#fff7d6" stroke-width="1.4" stroke-linecap="round" fill="none" opacity="0.65"/>' +
        '</g>' +
        // Cursor-directed arc — rotated by JS to point toward the cursor (glass-plasma-globe feel)
        '<g class="lm-arc-cursor" transform="rotate(0 50 50)" filter="url(#lmPlasma)">' +
          '<path d="M 50 50 L 78 50" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" fill="none" opacity="0.95"/>' +
        '</g>' +
        // Hot white center (above the arcs' origins so they look anchored)
        '<circle cx="50" cy="50" r="6" fill="#ffffff" opacity="0.95" filter="url(#lmGlowTight)"/>' +
      '</g>' +
    '</svg>'
  );
}

function updateLightningButton() {
  if (!_lmBtnSvg) return;
  const dot = _lmBtnSvg.querySelector('.lm-dot');
  const globe = _lmBtnSvg.querySelector('.lm-globe');
  const arcCursor = _lmBtnSvg.querySelector('.lm-arc-cursor');
  if (!dot || !globe) return;
  // While the menu is open, force the plasma state — the button is "engaged" and the
  // dormant dot would look wrong sitting under an open lightning tree.
  const effectiveNorm = _lmOverlay ? 0 : _lmBtnState.norm;
  // Smooth easing: cubic so the morph isn't linear and feels more "responsive"
  const eased = effectiveNorm * effectiveNorm * (3 - 2 * effectiveNorm);    // smoothstep
  dot.setAttribute('opacity', eased.toFixed(3));
  globe.setAttribute('opacity', (1 - eased).toFixed(3));
  if (arcCursor) {
    const deg = _lmBtnState.angle * 180 / Math.PI;
    arcCursor.setAttribute('transform', 'rotate(' + deg.toFixed(1) + ' 50 50)');
  }
  // Subtle button scale-up as the cursor approaches (overflow:visible lets it bloom)
  if (_lmBtn) _lmBtn.style.transform = 'scale(' + (1 + (1 - eased) * 0.18).toFixed(3) + ')';
}

// Open and close hook into the button morph so it forces plasma on menu state changes.
function _lmRepaintButton() { try { updateLightningButton(); } catch (_) {} }

function onMouseMoveForBtn(ev) {
  if (!_lmBtn) return;
  const r = _lmBtn.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const dx = ev.clientX - cx, dy = ev.clientY - cy;
  const dist = Math.hypot(dx, dy);
  // norm = 0 inside the button, → 1 at "reach radius" away. Reach radius ~ 140 px so the
  // plasma is reactive when the cursor is anywhere near the upper-left corner.
  const reach = 140;
  const inside = Math.max(0, dist - r.width / 2);
  _lmBtnState.norm = Math.max(0, Math.min(1, inside / reach));
  _lmBtnState.angle = Math.atan2(dy, dx);
  if (!_lmBtnState.rafPending) {
    _lmBtnState.rafPending = true;
    requestAnimationFrame(() => { _lmBtnState.rafPending = false; updateLightningButton(); });
  }
}

// Plasma flicker: cycle the turbulence seed and arc opacities while the globe is visible
// so the arcs feel alive (not a static SVG). Cheap — just a few attribute writes per tick.
function startPlasmaFlicker() {
  if (_lmFlickerIv) return;
  _lmFlickerIv = setInterval(() => {
    if (!_lmBtnSvg) return;
    // Skip the work when the globe is mostly invisible (norm > 0.75 = dormant)
    if (_lmBtnState.norm > 0.75 && !_lmOverlay) return;
    const turb = _lmBtnSvg.querySelector('#lmPlasma feTurbulence');
    if (turb) turb.setAttribute('seed', String(Math.floor(Math.random() * 256)));
    const arcs = _lmBtnSvg.querySelectorAll('.lm-arcs-ambient path');
    arcs.forEach((p) => p.setAttribute('opacity', (0.45 + Math.random() * 0.45).toFixed(2)));
    const cursorArc = _lmBtnSvg.querySelector('.lm-arc-cursor path');
    if (cursorArc) cursorArc.setAttribute('opacity', (0.75 + Math.random() * 0.25).toFixed(2));
  }, 110);
}

function ensureLightningButton() {
  if (_lmBtn) return;
  _lmBtn = document.createElement('button');
  _lmBtn.title = 'Lightning · state explorer (space)';
  // No background, no border — the plasma globe IS the visual. overflow:visible so the
  // outer halo + arcs can bloom past the button's hit rect. Fixed size matches the SVG.
  _lmBtn.style.cssText = 'position:fixed; top:8px; left:10px; z-index:79; cursor:pointer; padding:0;' +
    ' width:48px; height:48px; display:inline-flex; align-items:center; justify-content:center;' +
    ' overflow:visible; border:0; border-radius:50%; background:transparent;' +
    ' transition:transform 120ms cubic-bezier(.18,.78,.22,1);';
  _lmBtn.innerHTML = plasmaButtonSvg();
  _lmBtnSvg = _lmBtn.querySelector('svg');
  _lmBtn.onclick = (ev) => { ev.stopPropagation(); toggleMenu(); };
  document.body.appendChild(_lmBtn);
  // Global mouse tracking → button morph. Capture-phase so menu overlay can't block it.
  document.addEventListener('mousemove', onMouseMoveForBtn, true);
  startPlasmaFlicker();
  // Initial paint so the dormant dot shows before the user moves the mouse.
  updateLightningButton();
}

function shouldIgnoreKeyEvent(ev) {
  const t = ev.target;
  if (!t) return false;
  const tag = (t.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (t.isContentEditable) return true;
  return false;
}

let _lmKeysBound = false;
function bindGlobalKeys() {
  if (_lmKeysBound) return;
  _lmKeysBound = true;
  document.addEventListener('keydown', (ev) => {
    if (shouldIgnoreKeyEvent(ev)) return;
    if (ev.key === ' ' || ev.code === 'Space') {
      ev.preventDefault();
      if (_lmOverlay) {
        // Menu open: space APPLIES the current preview (or the top candidate
        // if the user hasn't cycled yet). This is the carousel commit gesture.
        applyCurrent();
      } else {
        toggleMenu();
      }
      return;
    }
    if (ev.key === 'Escape' && _lmOverlay) { ev.preventDefault(); closeMenu(); return; }
    if (_lmOverlay && (ev.key === 'ArrowRight' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      const next = _lmSelectedIdx < 0 ? 0 : _lmSelectedIdx + 1;
      showPreviewFor(next);
      return;
    }
    if (_lmOverlay && (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp')) {
      ev.preventDefault();
      const prev = _lmSelectedIdx < 0 ? _lmRanked.length - 1 : _lmSelectedIdx - 1;
      showPreviewFor(prev);
      return;
    }
  });
}

/** Public API. Call once after the viewer has rendered.
 *  hooks:
 *   - getCapabilities(): { hasVolume, hasSegmentation, activeModality }
 *   - applyEntry(entry): host-side handler when the user clicks a catalog entry
 */
export function installLightningMenu(hooks) {
  _lmHooks = hooks || {};
  ensureLightningButton();
  bindGlobalKeys();
}
