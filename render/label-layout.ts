// Force-directed 2D layout for anatomy "label cards" (museum-exhibit tags). Each card is tethered by a
// leader line to a segment's anchor point (its 3D centroid projected to the screen); the layout keeps the
// cards near their anchors, non-overlapping, and on-screen, integrating toward equilibrium each frame so
// they glide smoothly as the camera or specimen moves. Pure + deterministic (no Math.random, no time
// source): the caller drives it with the current anchor pixels + dt, so it unit-tests without a GPU and
// animates in the demo's rAF loop. Positions are CARD CENTRES in CSS pixels.

export interface CardBody {
  x: number; y: number;      // centre (css px)
  vx: number; vy: number;    // velocity (css px / s)
  w: number; h: number;      // card size (css px)
}

export interface LayoutOpts {
  anchorSpring?: number;     // pull toward the anchor (1/s^2 per px)
  repulsion?: number;        // card–card separation strength
  damping?: number;          // velocity retained per second (0..1); lower = more friction
  maxSpeed?: number;         // clamp (css px / s)
  margin?: number;           // keep cards this far inside the viewport (css px)
  gap?: number;              // desired clear space between cards (css px)
  standoff?: number;         // preferred distance of the card centre from its anchor (css px)
}

const DEFAULTS: Required<LayoutOpts> = {
  anchorSpring: 18, repulsion: 90000, damping: 0.86, maxSpeed: 1600, margin: 8, gap: 10, standoff: 96,
};

/** Deterministic initial placement: fan the cards out around their anchors on a fixed golden-angle
 *  spiral (index-seeded, no randomness) so the first frame is already spread, then the sim settles it. */
export function seedCards(anchorsPx: { x: number; y: number }[], sizes: { w: number; h: number }[], standoff = DEFAULTS.standoff): CardBody[] {
  const GA = 2.399963229728653;   // golden angle (rad)
  return anchorsPx.map((a, i) => {
    const ang = i * GA;
    return { x: a.x + Math.cos(ang) * standoff, y: a.y + Math.sin(ang) * standoff, vx: 0, vy: 0, w: sizes[i].w, h: sizes[i].h };
  });
}

/** One integration step. Mutates `cards` in place. `dt` in seconds (clamped for stability). */
export function layoutStep(
  cards: CardBody[],
  anchorsPx: { x: number; y: number }[],
  viewport: { w: number; h: number },
  dtSec: number,
  opts: LayoutOpts = {},
): void {
  const o = { ...DEFAULTS, ...opts };
  const dt = Math.min(Math.max(dtSec, 0), 0.05);   // cap the step so a long frame can't explode the sim
  if (dt === 0) return;
  const n = cards.length;
  const fx = new Float64Array(n), fy = new Float64Array(n);

  // Anchor spring — pull the card toward a point `standoff` px out from its anchor along the current
  // card→anchor direction, so cards prefer to sit off the specimen (leaving the leader line visible)
  // rather than directly on the pin. Falls back to straight-to-anchor when coincident.
  for (let i = 0; i < n; i++) {
    const a = anchorsPx[i], c = cards[i];
    const dx = c.x - a.x, dy = c.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const tx = a.x + (dx / d) * o.standoff, ty = a.y + (dy / d) * o.standoff;
    fx[i] += (tx - c.x) * o.anchorSpring;
    fy[i] += (ty - c.y) * o.anchorSpring;
  }

  // Card–card repulsion — push apart when their padded AABBs overlap, along the centre separation.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = cards[i], b = cards[j];
      const ox = (a.w + b.w) / 2 + o.gap - Math.abs(a.x - b.x);
      const oy = (a.h + b.h) / 2 + o.gap - Math.abs(a.y - b.y);
      if (ox <= 0 || oy <= 0) continue;                 // not overlapping
      let dx = a.x - b.x, dy = a.y - b.y;
      let d = Math.hypot(dx, dy);
      if (d < 1e-3) { dx = (i - j) || 1; dy = 1; d = Math.hypot(dx, dy); }  // deterministic tie-break
      const overlap = Math.min(ox, oy);
      const f = (o.repulsion * overlap) / (d * d);
      const ux = dx / d, uy = dy / d;
      fx[i] += ux * f; fy[i] += uy * f;
      fx[j] -= ux * f; fy[j] -= uy * f;
    }
  }

  for (let i = 0; i < n; i++) {
    const c = cards[i];
    c.vx = (c.vx + fx[i] * dt) * Math.pow(o.damping, dt / (1 / 60));
    c.vy = (c.vy + fy[i] * dt) * Math.pow(o.damping, dt / (1 / 60));
    const sp = Math.hypot(c.vx, c.vy);
    if (sp > o.maxSpeed) { c.vx = (c.vx / sp) * o.maxSpeed; c.vy = (c.vy / sp) * o.maxSpeed; }
    c.x += c.vx * dt; c.y += c.vy * dt;

    // Keep the whole card inside the viewport (hard clamp on position + kill outward velocity).
    const hw = c.w / 2 + o.margin, hh = c.h / 2 + o.margin;
    if (c.x < hw) { c.x = hw; if (c.vx < 0) c.vx = 0; }
    else if (c.x > viewport.w - hw) { c.x = viewport.w - hw; if (c.vx > 0) c.vx = 0; }
    if (c.y < hh) { c.y = hh; if (c.vy < 0) c.vy = 0; }
    else if (c.y > viewport.h - hh) { c.y = viewport.h - hh; if (c.vy > 0) c.vy = 0; }
  }
}

/** Overlap area of two cards' padded AABBs — 0 when clear. Exposed for tests/introspection. */
export function overlapArea(a: CardBody, b: CardBody, gap = 0): number {
  const ox = (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x);
  const oy = (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}
