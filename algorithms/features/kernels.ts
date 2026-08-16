// Feature-cortex kernels — WGSL bodies for the FeatureRunner. Each is a discriminative
// operator DESIGNED from renal radiology and CALIBRATED ("weights" = the p0..p7 params)
// on labeled KiTS data. The runner supplies IN(x,y,z) (HU, out-of-bounds = -1024),
// P.p0..p7 (params), and writes `o` per voxel.

export const K = {
  // Phase-normalized enhancement: 0 at fat, 1 at cortex. p0=fatHU(~-110), p1=cortexHU(per-case).
  // Robust across contrast phase because both anchors are sampled in-scan.
  relEnhance: {
    body: `let v = IN(x,y,z); o = (v - P.p0) / max(1.0, P.p1 - P.p0);`,
    params: (fatHU: number, cortexHU: number) => [fatHU, cortexHU],
  },

  // Fat wall / barrier: 1.0 where voxel is fat (HU < p0, ~-30), else 0. Phase-invariant.
  fatWall: {
    body: `o = select(0.0, 1.0, IN(x,y,z) < P.p0);`,
    params: (fatThresh = -30) => [fatThresh],
  },

  // Soft-tissue envelope candidate: 1 where HU in [p0,p1] (parenchyma-ish, not fat, not
  // bone/contrast), else 0. p0~ -20 (above fat), p1~ 320 (below bone/excreted contrast).
  softTissue: {
    body: `let v = IN(x,y,z); o = select(0.0, 1.0, v > P.p0 && v < P.p1);`,
    params: (lo = -20, hi = 320) => [lo, hi],
  },

  // Local variance at radius p0 (fine texture). Normal kidney (structured cortex/medulla)
  // reads HIGH; solid tumor reads LOWER. Output raw variance (HU^2).
  localVar: {
    body: `
      let R = i32(P.p0);
      var s = 0.0; var s2 = 0.0; var n = 0.0;
      for (var dz=-R; dz<=R; dz++){ for (var dy=-R; dy<=R; dy++){ for (var dx=-R; dx<=R; dx++){
        if(!INB(x+dx,y+dy,z+dz)){ continue; }
        let v = IN(x+dx,y+dy,z+dz); s += v; s2 += v*v; n += 1.0;
      }}}
      let m = s/n; o = s2/n - m*m;`,
    params: (radius = 1) => [radius],
  },

  // Gradient magnitude (central differences). High at the fat capsule and organ borders.
  gradMag: {
    body: `
      let gx = IN(x+1,y,z) - IN(x-1,y,z);
      let gy = IN(x,y+1,z) - IN(x,y-1,z);
      let gz = IN(x,y,z+1) - IN(x,y,z-1);
      o = sqrt(gx*gx + gy*gy + gz*gz) * 0.5;`,
    params: () => [],
  },

  // Fat-enclosure: fraction of the 6 axis directions along which a fat voxel (HU < p0) is
  // reached within p1 steps. High = voxel sits inside a fat-wrapped organ (kidney interior),
  // which liver/bowel/muscle interiors are NOT. The organ-defined-by-its-wall probe.
  fatEnclose: {
    body: `
      let ft = P.p0; let R = i32(P.p1);
      var hits = 0.0;
      var dirs = array<vec3<i32>,6>(vec3<i32>(1,0,0),vec3<i32>(-1,0,0),vec3<i32>(0,1,0),vec3<i32>(0,-1,0),vec3<i32>(0,0,1),vec3<i32>(0,0,-1));
      for (var d = 0; d < 6; d = d + 1) {
        let dir = dirs[d]; var hit = 0.0;
        for (var s = 1; s <= R; s = s + 1) {
          let xx = x + dir.x*s; let yy = y + dir.y*s; let zz = z + dir.z*s;
          if (!INB(xx,yy,zz)) { break; }
          if (IN(xx,yy,zz) < ft) { hit = 1.0; break; }
        }
        hits = hits + hit;
      }
      o = hits / 6.0;`,
    params: (fatHU = -30, maxSteps = 40) => [fatHU, maxSteps],
  },

  // Gas proximity: 1 if a gas voxel (HU < p0, e.g. -200) is within p1 steps in ANY of the 6
  // axis directions. Bowel wraps a gas/fluid lumen → high; the solid kidney → 0. A bowel rejector.
  gasNear: {
    body: `
      let gt = P.p0; let R = i32(P.p1); var hit = 0.0;
      var dirs = array<vec3<i32>,6>(vec3<i32>(1,0,0),vec3<i32>(-1,0,0),vec3<i32>(0,1,0),vec3<i32>(0,-1,0),vec3<i32>(0,0,1),vec3<i32>(0,0,-1));
      for (var d = 0; d < 6; d = d + 1) {
        let dir = dirs[d];
        for (var s = 1; s <= R; s = s + 1) {
          let xx = x + dir.x*s; let yy = y + dir.y*s; let zz = z + dir.z*s;
          if (!INB(xx,yy,zz)) { break; }
          if (IN(xx,yy,zz) < gt) { hit = 1.0; break; }
        }
      }
      o = hit;`,
    params: (gasHU = -200, maxSteps = 12) => [gasHU, maxSteps],
  },

  // Architectural-disruption proxy: ratio of fine-scale structure (var at R=p0) to
  // mid-scale mean-abs-deviation (R=p1). Organized parenchyma has strong fine structure;
  // a uniform tumor blob has weak fine structure relative to its size. Low output = blob.
  fineStructure: {
    body: `
      let R = i32(P.p0);
      var s = 0.0; var s2 = 0.0; var n = 0.0;
      for (var dz=-R; dz<=R; dz++){ for (var dy=-R; dy<=R; dy++){ for (var dx=-R; dx<=R; dx++){
        if(!INB(x+dx,y+dy,z+dz)){ continue; }
        let v = IN(x+dx,y+dy,z+dz); s += v; s2 += v*v; n += 1.0;
      }}}
      let m = s/n; let varf = max(0.0, s2/n - m*m);
      o = sqrt(varf);`, // std-dev in HU
    params: (radius = 1) => [radius],
  },
} as const;
