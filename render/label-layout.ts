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
  standoff?: number;         // preferred distance of the card centre from its anchor (css px) — no keep-out
  keepOuts?: { x: number; y: number; radius: number }[];  // per-segment projected circles: card i hugs OUTSIDE keepOuts[i], and is pushed off ANY it overlaps
  boundary?: { minX: number; minY: number; maxX: number; maxY: number };  // screen-space AABB of ALL visible data: cards ring OUTSIDE it, toward their anchor (form-fitting, not a circle)
  ringGap?: number;          // small gap so a card HUGS just outside its segment (css px)
  keepOutForce?: number;     // outward push strength when a card intrudes on any segment
}

const DEFAULTS: Required<Omit<LayoutOpts, "keepOuts" | "boundary">> = {
  anchorSpring: 26, repulsion: 200, damping: 0.86, maxSpeed: 1600, margin: 8, gap: 10, standoff: 96,
  ringGap: 14, keepOutForce: 40,
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

  // Anchor spring. With per-segment keep-out circles (each segment's projected bounds), pull card i to a
  // point just OUTSIDE its own segment (keepOuts[i]) on the side AWAY from the rest of the anatomy — so the
  // card HUGS its segment without covering it, leader line short. Without keep-outs, sit `standoff` off the
  // pin. A separate push shoves a card off ANY segment circle it intrudes on (never obscure a rendering).
  const kos = o.keepOuts;
  const GA = 2.399963229728653;
  let gx = 0, gy = 0;
  if (kos && kos.length) { for (const k of kos) { gx += k.x; gy += k.y; } gx /= kos.length; gy /= kos.length; }

  // With MANY cards on the boundary, targeting each card's own anchor direction piles clusters of
  // co-located segments (e.g. the vertebrae, the heart chambers) into one corner where the viewport clamp
  // pins them overlapping. Instead give each card an EVENLY-SPACED slot around the box perimeter, ordered
  // by anchor angle — locality is preserved (neighbours keep neighbouring slots) but no two cards ever
  // target the same point, so they can't stack. Kept for small counts is the direct anchor-direction ring.
  let slotRank: Int32Array | null = null;
  if (o.boundary && n > 8) {
    const bnd = o.boundary, bcx = (bnd.minX + bnd.maxX) / 2, bcy = (bnd.minY + bnd.maxY) / 2;
    const order = Array.from({ length: n }, (_, i) => i)
      .sort((i, j) => Math.atan2(anchorsPx[i].y - bcy, anchorsPx[i].x - bcx) - Math.atan2(anchorsPx[j].y - bcy, anchorsPx[j].x - bcx));
    slotRank = new Int32Array(n);
    order.forEach((idx, k) => { slotRank![idx] = k; });
  }
  for (let i = 0; i < n; i++) {
    const a = anchorsPx[i], c = cards[i];
    const halfDiag = 0.5 * Math.hypot(c.w, c.h);            // centre must clear a circle by this much
    const bnd = o.boundary;
    const own = kos && kos[i];
    let tx: number, ty: number;
    if (bnd) {
      const bcx = (bnd.minX + bnd.maxX) / 2, bcy = (bnd.minY + bnd.maxY) / 2;
      const bhx = (bnd.maxX - bnd.minX) / 2, bhy = (bnd.maxY - bnd.minY) / 2;
      if (slotRank) {
        // MANY cards: even PERIMETER (arc-length) slots on the ring rectangle just outside the box, ordered
        // by anchor angle. Uniform LINEAR spacing (angular spacing would bunch on the long vertical sides).
        const RX = bhx + o.ringGap, RY = bhy + o.ringGap, W = 2 * RX, H = 2 * RY, P = 2 * (W + H);
        let s = ((slotRank[i] + 0.5) / n) * P;   // arc length clockwise from the top-left corner
        let rx: number, ry: number, nx: number, ny: number;
        if (s < W) { rx = -RX + s; ry = -RY; nx = 0; ny = -1; }                       // top
        else if ((s -= W) < H) { rx = RX; ry = -RY + s; nx = 1; ny = 0; }             // right
        else if ((s -= H) < W) { rx = RX - s; ry = RY; nx = 0; ny = 1; }              // bottom
        else { s -= W; rx = -RX; ry = RY - s; nx = -1; ny = 0; }                      // left
        tx = bcx + rx + nx * halfDiag; ty = bcy + ry + ny * halfDiag;                 // push out so the card clears the box
      } else {
        // FEW cards: ring in the card's own anchor direction (keeps the leader short).
        let dirx = a.x - bcx, diry = a.y - bcy; let dl = Math.hypot(dirx, diry);
        if (dl < 1e-2) { dirx = Math.cos(i * GA); diry = Math.sin(i * GA); dl = 1; }
        dirx /= dl; diry /= dl;
        const tEdge = Math.min(bhx / Math.max(Math.abs(dirx), 1e-4), bhy / Math.max(Math.abs(diry), 1e-4));
        const Rr = tEdge + halfDiag + o.ringGap;
        tx = bcx + dirx * Rr; ty = bcy + diry * Rr;
      }
    } else if (own) {
      let dirx = own.x - gx, diry = own.y - gy;             // outward: away from the anatomy's overall centre
      let dl = Math.hypot(dirx, diry);
      if (dl < 1e-2) { dirx = Math.cos(i * GA); diry = Math.sin(i * GA); dl = 1; }   // lone/central segment: fan out
      dirx /= dl; diry /= dl;
      const R = own.radius + halfDiag + o.ringGap;          // hug: just outside the segment
      tx = own.x + dirx * R; ty = own.y + diry * R;
    } else {
      const dx = c.x - a.x, dy = c.y - a.y, d = Math.hypot(dx, dy) || 1;
      tx = a.x + (dx / d) * o.standoff; ty = a.y + (dy / d) * o.standoff;
    }
    fx[i] += (tx - c.x) * o.anchorSpring;
    fy[i] += (ty - c.y) * o.anchorSpring;
    // push OUT of the screen-space AABB (to the nearest edge) so no card sits over any visible data
    if (o.boundary) {
      const k = o.boundary;
      const bcx = (k.minX + k.maxX) / 2, bcy = (k.minY + k.maxY) / 2;
      const bhx = (k.maxX - k.minX) / 2 + halfDiag, bhy = (k.maxY - k.minY) / 2 + halfDiag;
      const penx = bhx - Math.abs(c.x - bcx), peny = bhy - Math.abs(c.y - bcy);
      if (penx > 0 && peny > 0) {   // card centre inside the expanded box → eject along least penetration
        if (penx < peny) fx[i] += Math.sign(c.x - bcx || 1) * penx * o.keepOutForce;
        else fy[i] += Math.sign(c.y - bcy || 1) * peny * o.keepOutForce;
      }
    }
    // push the card off ANY segment circle it overlaps (don't obscure that rendering)
    if (kos) for (const k of kos) {
      let dx = c.x - k.x, dy = c.y - k.y; let d = Math.hypot(dx, dy);
      if (d < 1e-3) { dx = Math.cos(i * GA); dy = Math.sin(i * GA); d = 1; }
      const need = k.radius + halfDiag;
      if (d < need) { const push = (need - d) * o.keepOutForce; fx[i] += (dx / d) * push; fy[i] += (dy / d) * push; }
    }
  }

  // Card–card separation — when two padded AABBs overlap, push apart along the axis of LEAST penetration
  // with a force LINEAR in the penetration depth. This rests exactly at "just touching" (force → 0 as the
  // overlap closes), so cards gently spread instead of settling into a shallow overlap. (A centre-line
  // 1/d² force fails here: two wide cards stacked vertically have a large centre distance, so its
  // magnitude collapses and the anchor spring wins — the overlap the user was seeing.)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = cards[i], b = cards[j];
      const ox = (a.w + b.w) / 2 + o.gap - Math.abs(a.x - b.x);
      const oy = (a.h + b.h) / 2 + o.gap - Math.abs(a.y - b.y);
      if (ox <= 0 || oy <= 0) continue;                 // not overlapping
      if (ox <= oy) {
        const s = Math.sign(a.x - b.x || (i - j) || 1), f = o.repulsion * ox;
        fx[i] += s * f; fx[j] -= s * f;
      } else {
        const s = Math.sign(a.y - b.y || (i - j) || 1), f = o.repulsion * oy;
        fy[i] += s * f; fy[j] -= s * f;
      }
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
