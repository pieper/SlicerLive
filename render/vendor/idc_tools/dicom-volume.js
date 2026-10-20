// Shared DICOM -> volume core for the SlicerLive decode workers.
//
// ONE code path for both classic workers: render/vendor/idc_tools/idc-worker.js (the IDC loader
// behind SEGRoulette / the BIR reader / SlicerRAD-IDC) and examples/remind/remind-worker.js
// (ReMINDer). Both importScripts() this file and read `self.DicomVolume`.
//
// Everything here is PURE: geometry, windowing, pixel unpacking, PixelData location, and volume
// assembly. No fetching and no postMessage — each worker keeps its own transport and progress
// reporting, so this stays reusable and testable.
(function (g) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const lps2ras = (v) => [-v[0], -v[1], v[2]]; // DICOM LPS -> RAS
  const ijkToRASFrom = (c0, c1, c2, o) => [
    c0[0], c1[0], c2[0], o[0],
    c0[1], c1[1], c2[1], o[1],
    c0[2], c1[2], c2[2], o[2],
    0, 0, 0, 1,
  ];

  /** Percentile auto-window for data with no usable VOI (MR/PET, and ultrasound — ReMIND US
   *  carries no WindowCenter/Width at all). PET clamps the floor at 0 and uses a 98th pct top. */
  function autoWindow(vol, isPET) {
    const N = vol.length, step = Math.max(1, (N / 200000) | 0), samp = [];
    for (let i = 0; i < N; i += step) {
      const v = vol[i];
      if (!isPET || v > 0) samp.push(v);
    }
    samp.sort((a, b) => a - b);
    const pct = (f) => (samp.length ? samp[Math.min(samp.length - 1, (f * samp.length) | 0)] : 0);
    const lo = isPET ? 0 : pct(0.01), hi = isPET ? (pct(0.98) || 1) : pct(0.99);
    return { lev: (lo + hi) / 2, win: Math.max(1, hi - lo) };
  }

  /** VOI straight from the dataset (or a shared functional group), else null. */
  function voiOf(ds, shared) {
    const wc = shared?.FrameVOILUTSequence?.[0]?.WindowCenter ?? ds.WindowCenter;
    const ww = shared?.FrameVOILUTSequence?.[0]?.WindowWidth ?? ds.WindowWidth;
    if (wc == null || ww == null) return null;
    const win = Number(Array.isArray(ww) ? ww[0] : ww) || 0;
    const lev = Number(Array.isArray(wc) ? wc[0] : wc);
    return win > 0 ? { win, lev } : null;
  }

  /** A Uint8Array view (e.g. a subarray of a header read) may sit at an odd byte offset, which
   *  a 16-bit typed array cannot wrap — normalise to a standalone ArrayBuffer when needed. */
  function rawBuffer(bytes) {
    return (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
      ? bytes.buffer : bytes.slice().buffer;
  }

  /** Raw stored pixels as the right typed array for BitsAllocated / PixelRepresentation. */
  function pixelsOf(buf, bits, signed) {
    if (bits === 8) return signed ? new Int8Array(buf) : new Uint8Array(buf);
    return signed ? new Int16Array(buf) : new Uint16Array(buf);
  }

  /** Locate PixelData (7FE0,0010) in an explicit-VR header buffer so its bytes can be range-read
   *  instead of downloading the whole object. Returns {valOff, pdLen}; throws when the tag isn't
   *  in `head` or the pixels are encapsulated/undefined-length (compressed). */
  function findPixelData(head) {
    const dv = new DataView(head.buffer, head.byteOffset);
    let pt = -1;
    for (let i = 132; i + 12 <= head.length; i += 2) {
      if (head[i] === 0xE0 && head[i + 1] === 0x7F && head[i + 2] === 0x10 && head[i + 3] === 0x00) {
        const vr = String.fromCharCode(head[i + 4], head[i + 5]);
        if (vr === 'OB' || vr === 'OW' || vr === 'UN') { pt = i; break; }
      }
    }
    if (pt < 0) throw new Error('PixelData tag not found in the fetched header');
    const pdLen = dv.getUint32(pt + 8, true);
    if (!pdLen || pdLen === 0xFFFFFFFF) throw new Error('encapsulated/undefined-length PixelData');
    return { tagOff: pt, valOff: pt + 12, pdLen };
  }

  /** Per-frame geometry of an enhanced / multi-frame instance: orientation, spacing, and the
   *  frame order along the slice normal (frames are NOT required to be stored in geometric
   *  order). A multi-frame object with no per-frame positions — a 2D cine rather than a 3D
   *  volume — falls back to stored order + SpacingBetweenSlices/SliceThickness. */
  function multiFrameGeometry(ds, nf) {
    const shared = ds.SharedFunctionalGroupsSequence?.[0] || {};
    const perFrame = ds.PerFrameFunctionalGroupsSequence || [];
    const iop = (shared.PlaneOrientationSequence?.[0]?.ImageOrientationPatient
      || perFrame[0]?.PlaneOrientationSequence?.[0]?.ImageOrientationPatient
      || ds.ImageOrientationPatient || [1, 0, 0, 0, 1, 0]).map(Number);
    const pm = shared.PixelMeasuresSequence?.[0] || perFrame[0]?.PixelMeasuresSequence?.[0] || {};
    const ps = (pm.PixelSpacing || ds.PixelSpacing || [1, 1]).map(Number);
    const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6), normal = cross(rowDir, colDir);
    let order, p0, spacing;
    if (perFrame.length === nf && perFrame[0]?.PlanePositionSequence?.[0]?.ImagePositionPatient) {
      order = perFrame.map((fg, f) => {
        const ipp = (fg.PlanePositionSequence?.[0]?.ImagePositionPatient || [0, 0, 0]).map(Number);
        return { f, ipp, proj: dot(ipp, normal) };
      }).sort((a, b) => a.proj - b.proj);
      p0 = order[0].ipp;
      spacing = nf > 1 ? dot(sub(order[nf - 1].ipp, p0), normal) / (nf - 1) : 1;
    } else {
      order = Array.from({ length: nf }, (_, f) => ({ f }));
      p0 = (ds.ImagePositionPatient || [0, 0, 0]).map(Number);
      spacing = Number(pm.SpacingBetweenSlices ?? pm.SliceThickness ?? ds.SpacingBetweenSlices ?? ds.SliceThickness) || 1;
    }
    if (!spacing) spacing = 1;
    const xf = shared.PixelValueTransformationSequence?.[0] || {};
    return {
      shared, perFrame, iop, ps, rowDir, colDir, normal, order, p0, spacing,
      slope: Number(xf.RescaleSlope ?? ds.RescaleSlope ?? 1),
      inter: Number(xf.RescaleIntercept ?? ds.RescaleIntercept ?? 0),
    };
  }

  /** ONE enhanced / multi-frame instance (e.g. every ReMIND 3D ultrasound series) -> volume on
   *  its native grid. `bytes` is the raw PixelData. opts.float picks Float32 over Int16 storage;
   *  opts.onFrame(k, nf) reports progress. */
  function assembleMultiFrame(ds, bytes, opts) {
    const o = opts || {};
    const nx = Number(ds.Columns), ny = Number(ds.Rows), nf = Number(ds.NumberOfFrames) || 1;
    const bits = Number(ds.BitsAllocated) || 8;
    const gm = multiFrameGeometry(ds, nf);
    const px = pixelsOf(rawBuffer(bytes), bits, ds.PixelRepresentation === 1);
    const frameLen = nx * ny;
    const vol = o.float ? new Float32Array(frameLen * nf) : new Int16Array(frameLen * nf);
    for (let k = 0; k < nf; k++) {
      const src = gm.order[k].f * frameLen, dst = k * frameLen;
      for (let p = 0; p < frameLen; p++) vol[dst + p] = px[src + p] * gm.slope + gm.inter;
      if (o.onFrame && (k % 16 === 0)) o.onFrame(k, nf);
    }
    const ijkToRAS = ijkToRASFrom(
      lps2ras(gm.rowDir.map((v) => v * gm.ps[1])),
      lps2ras(gm.colDir.map((v) => v * gm.ps[0])),
      lps2ras(gm.normal.map((v) => v * gm.spacing)),
      lps2ras(gm.p0),
    );
    const voi = voiOf(ds, gm.shared) || autoWindow(vol, false);
    return { vol, dims: [nx, ny, nf], ijkToRAS, win: voi.win, lev: voi.lev, iop: gm.iop, ps: gm.ps };
  }

  /** Can these instances be stacked into ONE regular volume, and if not, why not?
   *
   *  A DICOM "series" is only a grouping; nothing requires its instances to be slices of one
   *  evenly-sampled box. Real IDC studies routinely hold series that are two reconstructions
   *  interleaved (every position appears twice), scouts mixed in with the stack, variable
   *  spacing, or a tilted gantry (positions step sideways as well as along the normal). About a
   *  third of IDC CT series are flagged irregular in volume_geometry_index.
   *
   *  Resampling any of those onto a regular grid silently invents geometry: the MPR reformats
   *  comb or shear, the 3D render is a smear, and a segmentation drawn on the real positions
   *  lands on the wrong anatomy. So the viewer needs to KNOW, and the honest fallback is to show
   *  the instances as a stack of images and say the reformats are unavailable.
   *
   *  Returns { ok, reasons[], keep[], dropped, spacing, duplicates }: `keep` is the largest set
   *  of instances that at least share an image size + orientation (so they can be stacked at
   *  all), `spacing` the median positive gap along the normal, and `reasons` plain-language
   *  descriptions for the viewer to show. `ok` means keep[] IS a regular volume.
   *
   *  Tolerances are deliberately loose (0.25 mm or 5% of the spacing): the cost of calling a
   *  good series irregular is losing MPR on it, while the series this is aimed at are off by a
   *  whole slice or more. */
  function diagnoseSlices(slices) {
    const reasons = [];   // disqualifying: this is not one regular volume
    const notes = [];     // informational: instances left out of the volume
    // 1. Stackable at all? Group by image size + orientation + pixel spacing; anything outside
    //    the largest group cannot share a grid with it (scouts, a different FOV, a second
    //    orientation). assembleSlices would read them all at the first slice's dimensions.
    const r3 = (v) => Math.round(Number(v) * 1e3) / 1e3;
    const groups = new Map();
    let unusable = 0;
    for (const ds of slices) {
      const iop = ds.ImageOrientationPatient, ipp = ds.ImagePositionPatient;
      if (!iop || iop.length !== 6 || !ipp || !ds.Rows || !ds.Columns || !ds.PixelSpacing) {
        unusable++;
        continue;
      }
      const sig = `${ds.Rows}x${ds.Columns}|${iop.map(r3).join(",")}|${Array.from(ds.PixelSpacing, r3).join(",")}`;
      const grp = groups.get(sig) ?? [];
      if (!grp.length) groups.set(sig, grp);
      grp.push(ds);
    }
    let keep = [];
    for (const grp of groups.values()) if (grp.length > keep.length) keep = grp;
    const dropped = slices.length - keep.length;
    if (!keep.length) {
      return { ok: false, reasons: ["no instance in the series carries usable image geometry"], notes: [], keep: slices, dropped: 0, spacing: 1, duplicates: 0 };
    }
    // Instances left out are a NOTE, not a disqualification: a scout dropped from a 50-slice
    // chest CT leaves a perfectly good volume, and that is the common case.
    if (groups.size > 1) {
      notes.push(`${dropped} of ${slices.length} instances are a different image size or orientation and are not shown`);
    } else if (unusable) {
      notes.push(`${unusable} of ${slices.length} instances carry no image geometry and are not shown`);
    }

    // 2. Is the kept group an evenly-sampled box? Project each position on the plane normal.
    const iop = keep[0].ImageOrientationPatient.map(Number);
    const normal = cross(iop.slice(0, 3), iop.slice(3, 6));
    const pos = keep.map((ds) => ds.ImagePositionPatient.map(Number));
    const proj = pos.map((p) => dot(p, normal)).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < proj.length; i++) gaps.push(proj[i] - proj[i - 1]);
    // The median is taken over the NON-zero gaps: in an interleaved two-reconstruction series
    // half the gaps are 0, and a 0 mm median would call the real spacing "uneven" and leave the
    // viewer with no usable number for the grid.
    const real = gaps.filter((g) => g >= 1e-3).sort((a, b) => a - b);
    const median = real.length ? real[real.length >> 1] : 0;
    const spacing = median > 1e-4 ? median : (Number(keep[0].SliceThickness) || 1);
    const tol = Math.max(0.25, 0.05 * Math.abs(spacing));
    const duplicates = gaps.length - real.length;
    if (duplicates) {
      reasons.push(`${duplicates} instances repeat a slice position already in the series ` +
        `(two reconstructions in one series, or duplicate objects)`);
    }
    const uneven = real.filter((g) => Math.abs(g - median) > tol).length;
    if (uneven) {
      reasons.push(`slice spacing varies — ${uneven} of ${real.length} gaps differ from the ` +
        `${median.toFixed(2)} mm median by more than ${tol.toFixed(2)} mm`);
    }
    // 3. Do the positions actually march ALONG the normal? If they also drift sideways, the
    //    stack is sheared relative to the grid a reformat would sample (gantry tilt, table
    //    motion), and only the axial images themselves are trustworthy.
    // A sheared stack IS expressible as an affine matrix, but assembleSlices (like the IDC
    // index) builds k along the plane normal, so the shear would be dropped and the reformats
    // would be wrong by the drift. Tolerance is a quarter of a slice, so ordinary sub-millimetre
    // table jitter does not cost a study its MPR.
    const base = pos[0];
    let drift = 0;
    for (const p of pos) {
      const d = sub(p, base), t = dot(d, normal);
      drift = Math.max(drift, Math.hypot(d[0] - t * normal[0], d[1] - t * normal[1], d[2] - t * normal[2]));
    }
    if (drift > Math.max(1, 0.25 * Math.abs(spacing))) {
      reasons.push(`slice positions drift ${drift.toFixed(1)} mm across the image plane, not ` +
        `only along it (gantry tilt or table movement)`);
    }
    return { ok: reasons.length === 0, reasons, notes, keep, dropped, spacing, duplicates };
  }

  /** A conventional one-frame-per-instance series -> volume. `slices` are naturalized datasets;
   *  they are sorted here by position along the slice normal. */
  function assembleSlices(slices, opts) {
    const o = opts || {};
    const s0 = slices[0];
    const iop = s0.ImageOrientationPatient.map(Number);
    const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6), normal = cross(rowDir, colDir);
    // STACK mode (opts.stack, set when diagnoseSlices says this is not one regular volume):
    // order by InstanceNumber, the DICOM display order every PACS pages a stack in, so two
    // interleaved reconstructions read as one then the other instead of alternating. Position
    // order would be meaningless here anyway — that is what makes it a stack and not a volume.
    // The caller's measured spacing (the median gap) keeps the grid from collapsing; the viewer
    // shows image numbers rather than millimetres, because only the images are trustworthy.
    if (o.stack) {
      slices.sort((a, b) => (Number(a.InstanceNumber) || 0) - (Number(b.InstanceNumber) || 0));
    } else {
      slices.sort((a, b) => dot(a.ImagePositionPatient.map(Number), normal) - dot(b.ImagePositionPatient.map(Number), normal));
    }
    const nz = slices.length, ny = Number(s0.Rows), nx = Number(s0.Columns);
    const ps = s0.PixelSpacing.map(Number);
    const p0 = slices[0].ImagePositionPatient.map(Number);
    const p1 = slices[nz - 1].ImagePositionPatient.map(Number);
    const spacing = o.stack
      ? (Number(o.spacing) || Number(s0.SliceThickness) || 1)
      : nz > 1 ? dot(sub(p1, p0), normal) / (nz - 1) : (Number(s0.SliceThickness) || 1);
    const vol = o.float ? new Float32Array(nx * ny * nz) : new Int16Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) {
      const ds = slices[k];
      // PER-SLICE rescale: PET (and some CT/MR) carry a DIFFERENT RescaleSlope/RescaleIntercept on
      // every slice — applying only the first slice's values mis-scales the rest of the volume.
      const slope = Number(ds.RescaleSlope ?? 1), inter = Number(ds.RescaleIntercept ?? 0);
      let pd = ds.PixelData;
      if (Array.isArray(pd)) pd = pd[0];
      const px = pixelsOf(pd, Number(ds.BitsAllocated) || 16, ds.PixelRepresentation === 1);
      const off = k * nx * ny;
      for (let p = 0; p < nx * ny; p++) vol[off + p] = px[p] * slope + inter;
    }
    const ijkToRAS = ijkToRASFrom(
      lps2ras(rowDir.map((v) => v * ps[1])),
      lps2ras(colDir.map((v) => v * ps[0])),
      lps2ras(normal.map((v) => v * spacing)),
      lps2ras(p0),
    );
    return { vol, dims: [nx, ny, nz], ijkToRAS, iop, ps };
  }

  g.DicomVolume = {
    sub, dot, cross, lps2ras, ijkToRASFrom,
    autoWindow, voiOf, pixelsOf, rawBuffer, findPixelData,
    multiFrameGeometry, assembleMultiFrame, assembleSlices, diagnoseSlices,
  };
})(self);
