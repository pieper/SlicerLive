// load dcmjs, retrying across CDN mirrors (jsdelivr/unpkg are occasionally flaky from some networks)
(function loadDcmjs() {
    // Host apps (e.g. SlicerRad) may preload a local/vendored dcmjs via a wrapper worker
    // (importScripts their copy first) — respect it instead of hitting the CDN.
    if (typeof dcmjs !== "undefined")
        return;
    // The vendored build first, copied next to this worker at build time exactly as
    // dicom-volume.js is. It carries the write-path support MRCOM needs that no published
    // version has (render/vendor/dcmjs/README.md), and keeps the worker on the SAME dcmjs as
    // the main thread — a CDN pin plus a mirror list is two places to skew.
    const mirrors = [
        './dcmjs.min.js',
        'https://cdn.jsdelivr.net/npm/dcmjs@0.49.2/build/dcmjs.min.js',
        'https://unpkg.com/dcmjs@0.49.2/build/dcmjs.min.js',
        'https://cdn.jsdelivr.net/npm/dcmjs@0.49.2/build/dcmjs.js',
        'https://unpkg.com/dcmjs@0.49.2/build/dcmjs.js',
    ];
    for (let i = 0; i < 12; i++) {
        try {
            importScripts(mirrors[i % mirrors.length]);
            return;
        }
        catch (e) { /* try next */ }
    }
    throw new Error('dcmjs: all CDN mirrors failed');
})();
const s3url = (b) => 'https://' + (b || 'idc-open-data') + '.s3.us-east-1.amazonaws.com/';
let CT_S3 = s3url(), SEG_S3 = s3url();
let MODNAME = 'image';
const post = (m, x) => self.postMessage(m, x || []);
const prog = (msg, frac) => post({ t: 'progress', msg, frac });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchRetry(url, opts, tries = 6) {
    let err;
    for (let i = 0; i < tries; i++) {
        const ac = new AbortController(), to = setTimeout(() => ac.abort(), 20000);
        try {
            const r = await fetch(url, { ...(opts || {}), signal: ac.signal });
            if (!r.ok && r.status !== 206)
                throw new Error('HTTP ' + r.status);
            return r;
        }
        catch (e) {
            err = e;
            if (i < tries - 1)
                await sleep(Math.min(4000, 250 * 2 ** i) * (0.6 + 0.8 * Math.random()));
        }
        finally {
            clearTimeout(to);
        }
    }
    throw err;
}
function naturalize(buf) {
    const dd = dcmjs.data.DicomMessage.readFile(buf);
    return dcmjs.data.DicomMetaDictionary.naturalizeDataset(dd.dict);
}
// Shared DICOM -> volume core (geometry, windowing, PixelData location, multi-frame assembly):
// ONE code path with the ReMINDer worker. A host may importScripts its own copy first.
if (typeof DicomVolume === 'undefined')
    importScripts('./dicom-volume.js');
const DV = self.DicomVolume;
const { sub, dot, cross, lps2ras } = DV;
async function fetchBuf(key, base) { return (await fetchRetry((base || CT_S3) + key)).arrayBuffer(); }
/** Windowed RGBA of one slice. `width` defaults to the 64px mosaic tile; the first slice of a
 *  series is also rendered at full width, so the reader can put a real image up while the rest
 *  of the stack is still downloading instead of only a grid of tiles. */
function makeThumb(ds, width = 64) {
    let pd = ds.PixelData;
    if (Array.isArray(pd))
        pd = pd[0];
    if (!pd)
        return null;
    const nx = ds.Columns, ny = ds.Rows, TW = Math.min(width, nx), TH = Math.max(1, Math.round(TW * ny / nx));
    const px = ds.PixelRepresentation === 1 ? new Int16Array(pd) : new Uint16Array(pd);
    const slope = Number(ds.RescaleSlope ?? 1), inter = Number(ds.RescaleIntercept ?? 0);
    const lev = Number((Array.isArray(ds.WindowCenter) ? ds.WindowCenter[0] : ds.WindowCenter) ?? 40);
    const win = Number((Array.isArray(ds.WindowWidth) ? ds.WindowWidth[0] : ds.WindowWidth)) || 400;
    const lo = lev - win / 2, sc = 255 / win, rgba = new Uint8ClampedArray(TW * TH * 4);
    for (let ty = 0; ty < TH; ty++) {
        const sy = (ty * ny / TH) | 0;
        for (let tx = 0; tx < TW; tx++) {
            let g = (px[sy * nx + ((tx * nx / TW) | 0)] * slope + inter - lo) * sc;
            g = g < 0 ? 0 : g > 255 ? 255 : g;
            const o = (ty * TW + tx) * 4;
            rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
            rgba[o + 3] = 255;
        }
    }
    return { w: TW, h: TH, rgba };
}
/** Range-read one instance's header (and, when the object is small, the whole thing). 4 MB covers
 *  the PerFrameFunctionalGroupsSequence of a ~200-frame ultrasound. */
async function fetchHeader(key) {
    const HEAD = 4 << 20;
    const head = new Uint8Array(await fetchRetry(CT_S3 + key, { headers: { Range: `bytes=0-${HEAD - 1}` } }).then((r) => r.arrayBuffer()));
    const loc = DV.findPixelData(head);
    const ds = naturalize(head.slice(0, loc.tagOff).buffer);
    return { ds, head, ...loc, complete: loc.valOff + loc.pdLen <= head.length };
}
/** PixelData bytes [start, start+len) — reusing whatever the header read already pulled, then
 *  filling the rest with parallel ranged requests. */
async function fetchPixelRange(key, h, start, len) {
    const bytes = new Uint8Array(len);
    const have = Math.max(0, Math.min(h.head.length, start + len) - start);
    if (have > 0)
        bytes.set(h.head.subarray(start, start + have), 0);
    const rs = start + have, re = start + len - 1;
    if (rs <= re) {
        const CH = 8, cs = Math.ceil((re - rs + 1) / CH);
        let got = have;
        await Promise.all(Array.from({ length: CH }, (_, c) => {
            const s = rs + c * cs, e = Math.min(re, s + cs - 1);
            if (s > e)
                return null;
            return fetchRetry(CT_S3 + key, { headers: { Range: `bytes=${s}-${e}` } }).then((r) => r.arrayBuffer()).then((ab) => {
                bytes.set(new Uint8Array(ab), s - start);
                got += ab.byteLength;
                prog(`${MODNAME} ${(got / 1e6) | 0}/${(len / 1e6) | 0} MB`, 0.05 + 0.55 * got / len);
            });
        }));
    }
    return bytes;
}
/** 64px-wide thumbnail of one frame of an already-decoded volume (bit-depth agnostic, unlike
 *  makeThumb which reads a raw 16-bit instance). */
function frameThumb(vol, base, nx, ny, lo, sc) {
    const TW = 64, TH = Math.max(1, Math.round(64 * ny / nx));
    const rgba = new Uint8ClampedArray(TW * TH * 4);
    for (let ty = 0; ty < TH; ty++) {
        const sy = (ty * ny / TH) | 0;
        for (let tx = 0; tx < TW; tx++) {
            let g = (vol[base + sy * nx + ((tx * nx / TW) | 0)] - lo) * sc;
            g = g < 0 ? 0 : g > 255 ? 255 : g;
            const o = (ty * TW + tx) * 4;
            rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
            rgba[o + 3] = 255;
        }
    }
    return { w: TW, h: TH, rgba };
}
/** ONE enhanced / multi-frame instance (e.g. every ReMIND 3D ultrasound series) -> volume.
 *  Geometry + frame ordering + windowing all come from the shared DicomVolume core. */
async function buildMultiFrame(key, h, nf) {
    post({ t: 'ctinfo', count: nf });
    const bytes = h.complete
        ? h.head.subarray(h.valOff, h.valOff + h.pdLen)
        : await fetchPixelRange(key, h, h.valOff, h.pdLen);
    const v = DV.assembleMultiFrame(h.ds, bytes, {
        onFrame: (k, n) => prog(`${MODNAME} frame ${k}/${n}`, 0.62 + 0.3 * k / n),
    });
    const nx = v.dims[0], ny = v.dims[1], frameLen = nx * ny;
    const lo = v.lev - v.win / 2, sc = 255 / v.win;
    for (let k = 0; k < nf; k++) {
        const th = frameThumb(v.vol, k * frameLen, nx, ny, lo, sc);
        post({ t: 'thumb', n: k + 1, w: th.w, h: th.h, rgba: th.rgba.buffer }, [th.rgba.buffer]);
    }
    return { ...v, dtype: 'int16' };
}
/** ONE frame of a multi-frame instance, for the series-panel thumbnail — a ~450 KB ranged read
 *  instead of pulling a ~100 MB ultrasound object just to draw a 64px tile. */
async function buildMultiFrameThumb(key, h, nf) {
    const nx = Number(h.ds.Columns), ny = Number(h.ds.Rows);
    const bits = Number(h.ds.BitsAllocated) || 8;
    const frameBytes = nx * ny * (bits === 8 ? 1 : 2);
    const mid = nf >> 1;
    const bytes = h.complete
        ? h.head.subarray(h.valOff + mid * frameBytes, h.valOff + (mid + 1) * frameBytes)
        : await fetchPixelRange(key, h, h.valOff + mid * frameBytes, Math.min(frameBytes, h.pdLen - mid * frameBytes));
    const gm = DV.multiFrameGeometry(h.ds, nf);
    const px = DV.pixelsOf(DV.rawBuffer(bytes), bits, h.ds.PixelRepresentation === 1);
    const vol = new Int16Array(nx * ny);
    for (let p = 0; p < nx * ny; p++)
        vol[p] = px[p] * gm.slope + gm.inter;
    const voi = DV.voiOf(h.ds, gm.shared) || DV.autoWindow(vol, false);
    // Geometry is irrelevant for a thumbnail; the caller only reads dims/win/lev/vol.
    return { vol, dims: [nx, ny, 1], ijkToRAS: DV.ijkToRASFrom([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]),
        win: voi.win, lev: voi.lev, dtype: 'int16' };
}
async function buildVolume(ctKeys, thumbOnly) {
    // A one-object image series is the enhanced / multi-frame case (every ReMIND ultrasound):
    // all frames live in a single instance with geometry in the functional groups.
    if (ctKeys.length === 1) {
        // The ranged header read needs explicit VR (IDC serves plenty of IMPLICIT VR series, where
        // there is no VR field to find). When it can't be parsed, fall back to the whole object —
        // correctness first; the ranged fast path is what keeps multi-frame ultrasound cheap.
        let h = null;
        try {
            h = await fetchHeader(ctKeys[0]);
        }
        catch (e) { /* implicit VR / encapsulated / tag past the header read */ }
        const ds0 = h ? h.ds : naturalize(await fetchBuf(ctKeys[0]));
        const nf = Number(ds0.NumberOfFrames) || 1;
        if (nf > 1) {
            if (h)
                return thumbOnly ? buildMultiFrameThumb(ctKeys[0], h, nf) : buildMultiFrame(ctKeys[0], h, nf);
            post({ t: 'ctinfo', count: nf });
            let pd = ds0.PixelData;
            if (Array.isArray(pd))
                pd = pd[0];
            const v = DV.assembleMultiFrame(ds0, new Uint8Array(pd), {
                onFrame: (k, n) => prog(`${MODNAME} frame ${k}/${n}`, 0.62 + 0.3 * k / n),
            });
            return { ...v, dtype: 'int16' };
        }
        post({ t: 'ctinfo', count: 1 });
        const ds = h ? (h.complete ? naturalize(h.head.slice(0, h.valOff + h.pdLen).buffer)
            : naturalize(await fetchBuf(ctKeys[0]))) : ds0;
        return volumeFromSlices([ds]);
    }
    post({ t: 'ctinfo', count: ctKeys.length });
    const slices = [];
    let done = 0;
    const CONC = 8;
    let idx = 0;
    async function worker() {
        while (idx < ctKeys.length) {
            const k = ctKeys[idx++];
            const ds = naturalize(await fetchBuf(k));
            // Same filter as the streaming path: a series prefix can hold a report, a
            // presentation state or a scout, and none of them is a slice of this volume.
            // Letting them through used to put a 64x64 localizer into a 512x512 stack.
            let pd0 = ds.PixelData;
            if (Array.isArray(pd0))
                pd0 = pd0[0];
            if (!pd0 || !ds.ImagePositionPatient || NON_IMAGE_SOP.has(String(ds.SOPClassUID ?? ''))
                || /LOCALIZER|MIP/i.test([].concat(ds.ImageType ?? []).join('\\'))) {
                done++;
                continue;
            }
            slices.push(ds);
            if (slices.length === 1) {
                // First slice through: a real image, full size, while the rest streams.
                const big = makeThumb(ds, 512);
                if (big)
                    post({ t: 'preview', w: big.w, h: big.h, rgba: big.rgba.buffer }, [big.rgba.buffer]);
            }
            const th = makeThumb(ds);
            if (th)
                post({ t: 'thumb', n: Number(ds.InstanceNumber) || slices.length, w: th.w, h: th.h, rgba: th.rgba.buffer }, [th.rgba.buffer]);
            done++;
            if (done % 8 === 0)
                prog(`${MODNAME} ${done}/${ctKeys.length}`, 0.05 + 0.45 * done / ctKeys.length);
        }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    if (!slices.length)
        throw new Error('this series holds no image slices — its objects are reports, ' +
            'presentation states, secondary captures or scouts, which this reader cannot display');
    return volumeFromSlices(slices);
}
/** Assemble a conventional one-frame-per-instance series (shared core), then window it. */
function volumeFromSlices(slices) {
    const isPET = MODNAME === 'PET';
    // Is this series one regular volume at all? Decided from the ACTUAL headers (the only
    // authority — the index's regularly_spaced_3d_volume flag is a hint and is sometimes wrong
    // in both directions). When it is not, the instances are stacked in InstanceNumber order
    // and the viewer is told to show a stack: images only, no reformats, no segmentation.
    const diag = DV.diagnoseSlices(slices);
    if (!diag.keep.length || !diag.keep[0].ImageOrientationPatient)
        throw new Error('this series holds no image slices with usable geometry');
    const v = DV.assembleSlices(diag.keep, { float: isPET, stack: !diag.ok, spacing: diag.spacing });
    const s0 = diag.keep[0];
    if (!diag.ok || diag.notes.length) {
        post({
            t: 'geomcheck', stack: !diag.ok, reasons: diag.reasons, notes: diag.notes,
            kept: diag.keep.length, total: slices.length, spacing: diag.spacing,
        });
    }
    let win, lev;
    if (MODNAME === 'CT') {
        win = Number((Array.isArray(s0.WindowWidth) ? s0.WindowWidth[0] : s0.WindowWidth) ?? 400);
        lev = Number((Array.isArray(s0.WindowCenter) ? s0.WindowCenter[0] : s0.WindowCenter) ?? 40);
    }
    else
        ({ win, lev } = DV.autoWindow(v.vol, isPET));
    return { ...v, win, lev, dtype: isPET ? 'float32' : 'int16', stack: !diag.ok };
}
function buildLabelmap(ds, bits, ct) {
    const [nx, ny, nz] = ct.dims;
    // The SEG frames have their OWN grid (DICOM Rows/Columns) and their own spacing, which need
    // NOT match the image series it is drawn over: an autoPET lesion SEG is 400x400 on the PET
    // grid while the CT displayed under it is 512x512. Walking the packed bitmask with the IMAGE
    // volume's dims reads every frame at the wrong stride and runs off the end of each row.
    const sx = Number(ds.Columns) || nx, sy = Number(ds.Rows) || ny;   // || : malformed SEG -> old behaviour
    const frameBytes = Math.ceil(sx * sy / 8);
    // DICOM SEG segments may overlap, and one label per voxel cannot hold that: the frame written
    // last silently wins, and a tumour inside a lung disappears into the lung. So the labelmap is
    // a STACK of label volumes — segments that overlap go in different layers, and the viewer
    // composites them (OHIF does the same thing with one representation per layer). Layers are
    // allocated only as overlap demands, so the ordinary non-overlapping SEG is exactly one.
    const layers = [new Uint8Array(nx * ny * nz)];
    const layerAt = (L) => {
        while (layers.length <= L) layers.push(new Uint8Array(nx * ny * nz));
        return layers[L];
    };
    const M = ct.ijkToRAS, inv = invAffine(M);
    const toIJK = (lps) => {
        const r = lps2ras(lps);
        return [
            inv[0] * r[0] + inv[1] * r[1] + inv[2] * r[2] + inv[3],
            inv[4] * r[0] + inv[5] * r[1] + inv[6] * r[2] + inv[7],
            inv[8] * r[0] + inv[9] * r[1] + inv[10] * r[2] + inv[11]
        ];
    };
    const shared = ds.SharedFunctionalGroupsSequence?.[0] || {};
    const sIop = (shared.PlaneOrientationSequence?.[0]?.ImageOrientationPatient || ct.iop).map(Number);
    const sPs = (shared.PixelMeasuresSequence?.[0]?.PixelSpacing || ct.ps).map(Number);
    const colW = sIop.slice(0, 3).map((v) => v * sPs[1]);
    const rowW = sIop.slice(3, 6).map((v) => v * sPs[0]);
    const colors = [], names = {}, terminology = {};
    // one coded entry {scheme, value, meaning} from a DICOM code sequence's first item (or null)
    const code = (seq) => {
        const c = seq && seq[0];
        if (!c) return null;
        return { scheme: c.CodingSchemeDesignator || '', value: c.CodeValue || '', meaning: c.CodeMeaning || '' };
    };
    for (const s of (ds.SegmentSequence || [])) {
        const rgb = s.RecommendedDisplayCIELabValue ? dcmjs.data.Colors.dicomlab2RGB(s.RecommendedDisplayCIELabValue) : [1, 1, 1];
        const num = Number(s.SegmentNumber);
        colors.push([num, rgb[0], rgb[1], rgb[2]]);
        names[num] = s.SegmentLabel || ('Segment ' + s.SegmentNumber);
        // coded anatomical terminology (SegmentedPropertyType is the primary label; category/modifier/region add context)
        const type = s.SegmentedPropertyTypeCodeSequence;
        terminology[num] = {
            category: code(s.SegmentedPropertyCategoryCodeSequence),
            type: code(type),
            typeModifier: code(type && type[0] && type[0].SegmentedPropertyTypeModifierCodeSequence),
            region: code(s.AnatomicRegionSequence),
        };
    }
    const seenSeg = new Set();
    const perFrameAll = ds.PerFrameFunctionalGroupsSequence || [];
    // Which PAIRS of segments overlap? Answered from the frame bitmasks themselves, before any
    // painting: two segments can only overlap where they both have a frame on the same plane, and
    // there it is a bitwise AND. That is ~one extra pass over the mask bytes, and it buys a layer
    // assignment that is PER SEGMENT rather than per voxel — which is what keeps the contours
    // honest. (Assign per voxel and a segment that is sometimes-overlapped lives in two layers,
    // so the layer-to-layer transition draws a contour through the middle of it.)
    const planeFrames = new Map();
    for (let f = 0; f < perFrameAll.length; f++) {
        const fg = perFrameAll[f];
        const sn = Number(fg.SegmentIdentificationSequence?.[0]?.ReferencedSegmentNumber);
        const ipp = fg.PlanePositionSequence?.[0]?.ImagePositionPatient;
        if (!sn || !ipp) continue;
        const key = ipp.map((v) => Number(v).toFixed(3)).join(',');
        const at = planeFrames.get(key) ?? [];
        if (!at.length) planeFrames.set(key, at);
        at.push({ sn, off: f * frameBytes });
    }
    const adj = new Map();   // segment -> set of segments it overlaps
    const link = (a, b) => {
        if (!adj.has(a)) adj.set(a, new Set());
        if (!adj.has(b)) adj.set(b, new Set());
        adj.get(a).add(b); adj.get(b).add(a);
    };
    for (const at of planeFrames.values()) {
        for (let a = 0; a < at.length; a++) {
            for (let b = a + 1; b < at.length; b++) {
                if (at[a].sn === at[b].sn) continue;
                for (let byte = 0; byte < frameBytes; byte++) {
                    if (bits[at[a].off + byte] & bits[at[b].off + byte]) { link(at[a].sn, at[b].sn); break; }
                }
            }
        }
    }
    // Greedy graph colouring: a segment takes the lowest layer none of its overlapping
    // neighbours already holds. Non-overlapping SEGs colour entirely to layer 0.
    const MAX_LAYERS = 4;
    const layerOf = new Map();
    let crowded = 0;
    for (const num of Object.keys(names).map(Number).sort((a, b) => a - b)) {
        const taken = new Set();
        for (const o of (adj.get(num) ?? [])) if (layerOf.has(o)) taken.add(layerOf.get(o));
        let L = 0;
        while (taken.has(L)) L++;
        if (L >= MAX_LAYERS) { L = MAX_LAYERS - 1; crowded++; }   // more overlap than we draw: topmost wins there
        layerOf.set(num, L);
    }
    // DICOM SEG allows segments to overlap, a single-label volume cannot represent it, and the
    // frame written last silently wins. Count what is lost so the viewer can say so rather than
    // letting a reader believe the topmost segment is the whole story.
    let overlapVoxels = 0;
    const overlapPairs = new Set();
    const perFrame = ds.PerFrameFunctionalGroupsSequence || [];
    const ref = (perFrame[0]?.PlanePositionSequence?.[0]?.ImagePositionPatient || [0, 0, 0]).map(Number), o0 = toIJK(ref);
    const diCol = sub(toIJK([ref[0] + colW[0], ref[1] + colW[1], ref[2] + colW[2]]), o0);
    const diRow = sub(toIJK([ref[0] + rowW[0], ref[1] + rowW[1], ref[2] + rowW[2]]), o0);
    // Step between frames, for the footprint below: the plane normal scaled by the slice thickness.
    const pm = shared.PixelMeasuresSequence?.[0] || {};
    const thick = Number(pm.SliceThickness ?? pm.SpacingBetweenSlices ?? 0) || 1;
    const nW = cross(sIop.slice(0, 3), sIop.slice(3, 6)).map((v) => v * thick);
    const diSlc = sub(toIJK([ref[0] + nW[0], ref[1] + nW[1], ref[2] + nW[2]]), o0);
    // One SEG voxel covers a BOX of image voxels when the SEG grid is the coarser one (2.04 mm
    // PET vs 0.91 mm CT = ~5 image voxels per SEG voxel). Writing a single voxel per set bit
    // stipples the mask into isolated dots — about a fifth of the lesion, invisible under the
    // overlay. Paint every image voxel whose CENTRE falls inside the SEG voxel: that is nearest-
    // neighbour resampling, the same answer a reverse/pull resample gives, and for a SEG at or
    // finer than the image grid the span collapses to the one voxel it already wrote.
    const ext = [0, 1, 2].map((a) => Math.abs(diCol[a]) + Math.abs(diRow[a]) + Math.abs(diSlc[a]));
    for (let f = 0; f < perFrame.length; f++) {
        const fg = perFrame[f];
        const segNum = fg.SegmentIdentificationSequence?.[0]?.ReferencedSegmentNumber;
        const ippLps = fg.PlanePositionSequence?.[0]?.ImagePositionPatient?.map(Number);
        if (!segNum || !ippLps)
            continue;
        if (!seenSeg.has(segNum)) {
            seenSeg.add(segNum);
            post({ t: 'seg', name: names[segNum] || ('Segment ' + segNum) });
        }
        const o = toIJK(ippLps), fb = f * frameBytes;
        const myLayer = layerOf.get(Number(segNum)) ?? 0;
        for (let row = 0; row < sy; row++) {
            const bi = o[0] + row * diRow[0], bj = o[1] + row * diRow[1], bk = o[2] + row * diRow[2], rb = row * sx;
            for (let col = 0; col < sx; col++) {
                const p = rb + col;
                if (!((bits[fb + (p >> 3)] >> (p & 7)) & 1))
                    continue;
                const x = bi + col * diCol[0], y = bj + col * diCol[1], z = bk + col * diCol[2];
                const i0 = Math.max(0, Math.ceil(x - ext[0] / 2)), i1 = Math.min(nx - 1, Math.floor(x + ext[0] / 2));
                const j0 = Math.max(0, Math.ceil(y - ext[1] / 2)), j1 = Math.min(ny - 1, Math.floor(y + ext[1] / 2));
                const k0 = Math.max(0, Math.ceil(z - ext[2] / 2)), k1 = Math.min(nz - 1, Math.floor(z + ext[2] / 2));
                for (let k = k0; k <= k1; k++)
                    for (let j = j0; j <= j1; j++)
                        for (let i = i0; i <= i1; i++) {
                            const o = k * nx * ny + j * nx + i;
                            // Count the overlap for the viewer's note, and keep the stack clean:
                            // this segment's own layer is the normal destination, but if a
                            // resampling collision put someone else there (possible when the SEG
                            // grid is coarser than the image grid, where touching SEG voxels can
                            // land on one image voxel), step up rather than overwrite them.
                            let covered = false;
                            for (let L = 0; L < layers.length; L++) {
                                const prev = layers[L][o];
                                if (prev && prev !== segNum) {
                                    if (!covered) overlapVoxels++;
                                    covered = true;
                                    overlapPairs.add(prev < segNum ? prev + ':' + segNum : segNum + ':' + prev);
                                }
                            }
                            let L = myLayer;
                            while (L < MAX_LAYERS - 1 && layerAt(L)[o] && layerAt(L)[o] !== segNum) L++;
                            layerAt(L)[o] = segNum;
                        }
            }
        }
        if (f % 200 === 0)
            prog(`SEG ${f}/${perFrame.length}`, 0.55 + 0.4 * f / perFrame.length);
    }
    return {
        lab: layers[0], extra: layers.slice(1), colors, names, terminology,
        overlap: {
            voxels: overlapVoxels,
            pairs: [...overlapPairs].map((p) => p.split(':').map(Number)),
            layers: layers.length,
            crowded,
        },
    };
}
function invAffine(m) {
    const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]], t = [m[3], m[7], m[11]];
    const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
    const id = 1 / det;
    const r = [
        (a[4] * a[8] - a[5] * a[7]) * id, (a[2] * a[7] - a[1] * a[8]) * id, (a[1] * a[5] - a[2] * a[4]) * id,
        (a[5] * a[6] - a[3] * a[8]) * id, (a[0] * a[8] - a[2] * a[6]) * id, (a[2] * a[3] - a[0] * a[5]) * id,
        (a[3] * a[7] - a[4] * a[6]) * id, (a[1] * a[6] - a[0] * a[7]) * id, (a[0] * a[4] - a[1] * a[3]) * id
    ];
    const tx = -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]);
    const ty = -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]);
    const tz = -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]);
    return [r[0], r[1], r[2], tx, r[3], r[4], r[5], ty, r[6], r[7], r[8], tz, 0, 0, 0, 1];
}
async function fetchSeg(key) {
    const HEAD = 4 << 20;
    const head = new Uint8Array(await fetchRetry(SEG_S3 + key, { headers: { Range: `bytes=0-${HEAD - 1}` } }).then((r) => r.arrayBuffer()));
    const dv = new DataView(head.buffer, head.byteOffset);
    let pt = -1;
    for (let i = 132; i + 12 <= head.length; i += 2) {
        if (head[i] === 0xE0 && head[i + 1] === 0x7F && head[i + 2] === 0x10 && head[i + 3] === 0x00) {
            const vr = String.fromCharCode(head[i + 4], head[i + 5]);
            if (vr === 'OB' || vr === 'OW' || vr === 'UN') {
                pt = i;
                break;
            }
        }
    }
    if (pt < 0)
        throw new Error('PixelData tag not in header range');
    const valOff = pt + 12, pdLen = dv.getUint32(pt + 8, true);
    if (!pdLen || pdLen === 0xFFFFFFFF)
        throw new Error('encapsulated/undefined PixelData length');
    const ds = naturalize(head.slice(0, pt).buffer);
    const bits = new Uint8Array(pdLen);
    const have = Math.max(0, Math.min(HEAD, valOff + pdLen) - valOff);
    if (have > 0)
        bits.set(head.subarray(valOff, valOff + have), 0);
    const rs = valOff + have, re = valOff + pdLen - 1;
    if (rs <= re) {
        const CH = 8, cs = Math.ceil((re - rs + 1) / CH);
        let got = have;
        await Promise.all(Array.from({ length: CH }, (_, c) => {
            const s = rs + c * cs, e = Math.min(re, s + cs - 1);
            if (s > e)
                return null;
            return fetchRetry(SEG_S3 + key, { headers: { Range: `bytes=${s}-${e}` } }).then((r) => r.arrayBuffer()).then((ab) => {
                bits.set(new Uint8Array(ab), s - valOff);
                got += ab.byteLength;
                prog(`SEG ${(got / 1e6) | 0}/${(pdLen / 1e6) | 0} MB`, 0.5 + 0.08 * got / pdLen);
            });
        }));
    }
    return { ds, bits };
}
// SOP classes that are not image slices but can share a series prefix. Anything here is
// skipped outright; everything else still has to carry a position and a pixel grid to count.
//
// Secondary Capture (…1.1.7) is deliberately NOT here. IDC uses it for both — the fused PET/CT
// MPR screenshots in acrin_flt_breast carry no position at all, while the TRAM parametric maps
// in advanced_mri_breast_lesions are ORIGINAL\PRIMARY images with full ImagePositionPatient and
// orientation. Judging it by its class dropped every instance of the second kind; judging it by
// whether it carries a position and a pixel grid gets both right.
const NON_IMAGE_SOP = new Set([
    '1.2.840.10008.5.1.4.1.1.66.4',   // Segmentation
    '1.2.840.10008.5.1.4.1.1.481.3',  // RT Structure Set
    '1.2.840.10008.5.1.4.1.1.481.2',  // RT Dose
    '1.2.840.10008.5.1.4.1.1.11.1',   // Grayscale Softcopy Presentation State
    '1.2.840.10008.5.1.4.1.1.88.11',  // Basic Text SR
    '1.2.840.10008.5.1.4.1.1.88.22',  // Enhanced SR
    '1.2.840.10008.5.1.4.1.1.88.33',  // Comprehensive SR
    '1.2.840.10008.5.1.4.1.1.88.34',  // Comprehensive 3D SR
    '1.2.840.10008.5.1.4.1.1.9.1.1',  // 12-lead ECG
]);

// The handful of attributes needed to place a slice, by tag. Walking for these directly is
// ~100x cheaper than naturalizing the header with dcmjs, and the metadata pass does it once per
// instance — with a full parse the pass is CPU-bound and takes longer than the pixels do.
/** The 33rd and 66th percentile of a slice, taken over the pixels that are actually VISIBLE in
 *  the window — the two greys the placeholder checkerboard uses.
 *
 *  Over the raw pixels these would both be air on most CT frames: more than half of a 512x512
 *  abdomen is outside the patient, so the 66th percentile is still -1000 and the checkerboard
 *  comes out black on black. Restricting the sample to the window is what makes the stand-in
 *  sit in the same range as what the reader will actually see. */
function percentiles(px, win, lev) {
    const stride = Math.max(1, Math.floor(px.length / 20000));
    const lo = lev - win / 2, hi = lev + win / 2;
    const samp = [];
    for (let i = 0; i < px.length; i += stride) {
        const v = px[i];
        if (v > lo && v < hi) samp.push(v);
    }
    if (samp.length < 64) return [lev - win / 4, lev + win / 4];   // nothing in the window
    samp.sort((a, b) => a - b);
    const at = (f) => samp[Math.min(samp.length - 1, Math.floor(f * samp.length))];
    return [at(0.33), at(0.66)];
}

/** Decode a conventional series STRAIGHT TO ITS SLICE INDEX, posting each slice as it lands.
 *
 *  The caller supplies the volume's geometry (origin, orientation, slice spacing, dims) — which
 *  it got from the IDC index, so no header pre-pass is needed here. Each instance's own
 *  ImagePositionPatient then says which k it is, and the slice can go straight out instead of
 *  being held until the whole series is assembled. The worker never holds the volume at all.
 */
async function streamVolume(ctKeys, segKeys, geom) {
    const [nx, ny, nz] = geom.dims;
    const rowDir = geom.iop.slice(0, 3), colDir = geom.iop.slice(3, 6);
    const n = cross(rowDir, colDir);
    const base = dot(geom.origin, n), sp = geom.spacing || 1;
    post({ t: 'ctinfo', count: ctKeys.length });

    // The SEG is one object and the geometry is already known, so it decodes ALONGSIDE the
    // slices rather than after them — usually ready long before the last slice.
    const segJob = (segKeys && segKeys.length)
        ? loadSeg(segKeys, { dims: geom.dims, ijkToRAS: geom.ijkToRAS }).catch((err) => post({ t: 'segerror', error: String(err) }))
        : null;

    let placed = 0, done = 0, dropped = 0, outside = 0, idx = 0, announced = false;
    let tried = 0, bestSpread = -1, best = { p33: 0, p66: 1, voi: { win: 0, lev: 0 } };
    const CONC = 8;
    await Promise.all(Array.from({ length: CONC }, async () => {
        while (idx < ctKeys.length) {
            const key = ctKeys[idx++];
            let ds;
            try {
                ds = naturalize(await fetchBuf(key));
            }
            catch (err) {
                done++;
                continue;                      // one bad instance must not sink the series
            }
            let pd = ds.PixelData;
            if (Array.isArray(pd))
                pd = pd[0];
            const ipp = ds.ImagePositionPatient && ds.ImagePositionPatient.map(Number);
            const sop = String(ds.SOPClassUID ?? '');
            const localizer = /LOCALIZER|MIP/i.test([].concat(ds.ImageType ?? []).join('\\'));
            // A series prefix can hold things that are not slices of this volume — a report, a
            // presentation state, a scout. They are counted in instanceCount but must not be
            // placed, and must not be mistaken for a slice that failed.
            if (!pd || !ipp || localizer || NON_IMAGE_SOP.has(sop)) {
                dropped++;
                done++;
                continue;
            }
            const z = Math.round((dot(ipp, n) - base) / sp);
            if (z >= 0 && z < nz) {
                const src = DV.pixelsOf(pd, Number(ds.BitsAllocated) || 16, ds.PixelRepresentation === 1);
                const slope = Number(ds.RescaleSlope ?? 1), inter = Number(ds.RescaleIntercept ?? 0);
                const px = new Float32Array(nx * ny);
                const len = Math.min(px.length, src.length);
                for (let i = 0; i < len; i++) px[i] = src[i] * slope + inter;
                if (!announced) {
                    // The placeholder's two greys come from a real slice of THIS study, so the
                    // stand-in sits in the same intensity range as the data. In bucket order the
                    // first slice to arrive is as likely to be an end slice of nothing but air,
                    // whose percentiles are both air and whose checkerboard would be black on
                    // black — so take the first slice that actually has some contrast in it, and
                    // settle for the best seen so far if a few in a row do not.
                    const voi = voiOfSlice(ds);
                    const [p33, p66] = percentiles(px, voi.win || 400, voi.lev || 40);
                    const spread = p66 - p33;
                    if (spread > bestSpread) bestSpread = spread, best = { p33, p66, voi };
                    tried++;
                    if (spread >= (voi.win || 400) * 0.05 || tried >= 12) {
                        announced = true;
                        post({ t: 'geometry', ...geom, ...best.voi, p33: best.p33, p66: best.p66 });
                    }
                }
                post({ t: 'slice', k: z, px: px.buffer }, [px.buffer]);
                placed++;
            }
            else {
                outside++;                     // the index geometry does not describe this slice
            }
            const th = makeThumb(ds);
            if (th)
                post({ t: 'thumb', n: Number(ds.InstanceNumber) || done + 1, w: th.w, h: th.h, rgba: th.rgba.buffer }, [th.rgba.buffer]);
            done++;
            if (done % 8 === 0)
                prog(`${MODNAME} ${done}/${ctKeys.length}`, 0.05 + 0.8 * done / ctKeys.length);
        }
    }));
    if (!announced && placed) {                // every slice was flat; build from the best seen
        announced = true;
        post({ t: 'geometry', ...geom, ...best.voi, p33: best.p33, p66: best.p66 });
    }
    if (!announced) return null;               // nothing placeable: caller falls back
    if (segJob) {
        prog('decoding SEG…', 0.92);
        await segJob;
    }
    return { placed, expected: nz, dropped, outside };
}

/** Window/level a viewer should start from: the slice's own VOI for CT, else let the main
 *  thread auto-window once it has data. */
function voiOfSlice(ds) {
    const w = Array.isArray(ds.WindowWidth) ? ds.WindowWidth[0] : ds.WindowWidth;
    const l = Array.isArray(ds.WindowCenter) ? ds.WindowCenter[0] : ds.WindowCenter;
    return { win: Number(w) || 0, lev: Number(l ?? 0) || 0 };
}

/** Fetch + decode the SEG and post it. Separated so it can run CONCURRENTLY with the image
 *  slices: the segmentation is one object, so it is often ready long before the last slice. */
async function loadSeg(segKeys, ctLike) {
    let parsed;
    try {
        parsed = await fetchSeg(segKeys[0]);
    }
    catch (err) {
        const buf = await fetchBuf(segKeys[0], SEG_S3);
        const ds = naturalize(buf);
        let pd = ds.PixelData;
        if (Array.isArray(pd))
            pd = pd[0];
        parsed = { ds, bits: new Uint8Array(pd) };
    }
    const seg = buildLabelmap(parsed.ds, parsed.bits, ctLike);
    post(
        { t: 'labelmap', lab: seg.lab, extra: seg.extra, colors: seg.colors, names: seg.names, terminology: seg.terminology, overlap: seg.overlap },
        [seg.lab.buffer, ...seg.extra.map((e) => e.buffer)],
    );
}

self.onmessage = async (e) => {
    const { ctKeys, segKeys, ctBucket, segBucket, modality, thumbOnly, geometry, segOnly } = e.data;
    CT_S3 = s3url(ctBucket);
    SEG_S3 = s3url(segBucket);
    MODNAME = { CT: 'CT', MR: 'MR', PT: 'PET' }[modality] || modality || 'image';
    try {
        // SEG-ONLY: the caller already has the image volume decoded and only wants a different
        // segmentation drawn over it. `segOnly` carries that volume's grid ({dims, ijkToRAS}),
        // which is all the SEG decoder needs — so switching segmentation costs one object,
        // not the whole series again.
        if (segOnly && segKeys && segKeys.length) {
            prog('fetching SEG…', 0.1);
            await loadSeg(segKeys, segOnly);
            post({ t: 'alldone' });
            return;
        }
        prog('fetching ' + MODNAME + '…', 0.05);
        // Streaming path: the caller knows the geometry, so slices go out as they decode and the
        // SEG is fetched at the same time instead of after the last slice.
        // Streaming path: the caller knows the geometry (from the IDC index), so each instance's
        // own ImagePositionPatient says which slice it is and the pixels can go out as they
        // decode. Objects in the prefix that are not slices of this volume are dropped here.
        if (geometry && ctKeys.length > 1 && !thumbOnly) {
            const r = await streamVolume(ctKeys, segKeys, geometry);
            if (r) {
                post({ t: 'ctdone', placed: r.placed, expected: r.expected, dropped: r.dropped, outside: r.outside });
                post({ t: 'alldone' });
                return;
            }
            prog('nothing placeable — rereading the series', 0.05);
        }
        const ct = await buildVolume(ctKeys, thumbOnly);
        post({ t: 'ct', vol: ct.vol, dims: ct.dims, ijkToRAS: ct.ijkToRAS, win: ct.win, lev: ct.lev, dtype: ct.dtype }, [ct.vol.buffer]);
        if (segKeys && segKeys.length && !ct.stack) {
            prog('fetching SEG…', 0.5);
            await loadSeg(segKeys, ct);
        }
        post({ t: 'alldone' });
    }
    catch (err) {
        post({ t: 'error', error: String(err && err.stack || err) });
    }
};
