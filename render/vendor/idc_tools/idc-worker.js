// load dcmjs, retrying across CDN mirrors (jsdelivr/unpkg are occasionally flaky from some networks)
(function loadDcmjs() {
    // Host apps (e.g. SlicerRad) may preload a local/vendored dcmjs via a wrapper worker
    // (importScripts their copy first) — respect it instead of hitting the CDN.
    if (typeof dcmjs !== "undefined")
        return;
    const mirrors = [
        'https://cdn.jsdelivr.net/npm/dcmjs@0.41.0/build/dcmjs.min.js',
        'https://unpkg.com/dcmjs@0.41.0/build/dcmjs.min.js',
        'https://cdn.jsdelivr.net/npm/dcmjs@0.41.0/build/dcmjs.js',
        'https://unpkg.com/dcmjs@0.41.0/build/dcmjs.js',
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
function makeThumb(ds) {
    let pd = ds.PixelData;
    if (Array.isArray(pd))
        pd = pd[0];
    if (!pd)
        return null;
    const nx = ds.Columns, ny = ds.Rows, TW = 64, TH = Math.max(1, Math.round(64 * ny / nx));
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
            slices.push(ds);
            const th = makeThumb(ds);
            if (th)
                post({ t: 'thumb', n: Number(ds.InstanceNumber) || slices.length, w: th.w, h: th.h, rgba: th.rgba.buffer }, [th.rgba.buffer]);
            done++;
            if (done % 8 === 0)
                prog(`${MODNAME} ${done}/${ctKeys.length}`, 0.05 + 0.45 * done / ctKeys.length);
        }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    return volumeFromSlices(slices);
}
/** Assemble a conventional one-frame-per-instance series (shared core), then window it. */
function volumeFromSlices(slices) {
    const isPET = MODNAME === 'PET';
    const v = DV.assembleSlices(slices, { float: isPET });
    const s0 = slices[0];
    let win, lev;
    if (MODNAME === 'CT') {
        win = Number((Array.isArray(s0.WindowWidth) ? s0.WindowWidth[0] : s0.WindowWidth) ?? 400);
        lev = Number((Array.isArray(s0.WindowCenter) ? s0.WindowCenter[0] : s0.WindowCenter) ?? 40);
    }
    else
        ({ win, lev } = DV.autoWindow(v.vol, isPET));
    return { ...v, win, lev, dtype: isPET ? 'float32' : 'int16' };
}
function buildLabelmap(ds, bits, ct) {
    const [nx, ny, nz] = ct.dims, frameBytes = (nx * ny) >> 3;
    const lab = new Uint8Array(nx * ny * nz);
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
    const perFrame = ds.PerFrameFunctionalGroupsSequence || [];
    const ref = (perFrame[0]?.PlanePositionSequence?.[0]?.ImagePositionPatient || [0, 0, 0]).map(Number), o0 = toIJK(ref);
    const diCol = sub(toIJK([ref[0] + colW[0], ref[1] + colW[1], ref[2] + colW[2]]), o0);
    const diRow = sub(toIJK([ref[0] + rowW[0], ref[1] + rowW[1], ref[2] + rowW[2]]), o0);
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
        for (let row = 0; row < ny; row++) {
            const bi = o[0] + row * diRow[0], bj = o[1] + row * diRow[1], bk = o[2] + row * diRow[2], rb = row * nx;
            for (let col = 0; col < nx; col++) {
                const p = rb + col;
                if (!((bits[fb + (p >> 3)] >> (p & 7)) & 1))
                    continue;
                const i = Math.round(bi + col * diCol[0]), j = Math.round(bj + col * diCol[1]), k = Math.round(bk + col * diCol[2]);
                if (i >= 0 && i < nx && j >= 0 && j < ny && k >= 0 && k < nz)
                    lab[k * nx * ny + j * nx + i] = segNum;
            }
        }
        if (f % 200 === 0)
            prog(`SEG ${f}/${perFrame.length}`, 0.55 + 0.4 * f / perFrame.length);
    }
    return { lab, colors, names, terminology };
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
self.onmessage = async (e) => {
    const { ctKeys, segKeys, ctBucket, segBucket, modality, thumbOnly } = e.data;
    CT_S3 = s3url(ctBucket);
    SEG_S3 = s3url(segBucket);
    MODNAME = { CT: 'CT', MR: 'MR', PT: 'PET' }[modality] || modality || 'image';
    try {
        prog('fetching ' + MODNAME + '…', 0.05);
        const ct = await buildVolume(ctKeys, thumbOnly);
        post({ t: 'ct', vol: ct.vol, dims: ct.dims, ijkToRAS: ct.ijkToRAS, win: ct.win, lev: ct.lev, dtype: ct.dtype }, [ct.vol.buffer]);
        if (segKeys && segKeys.length) {
            prog('fetching SEG…', 0.5);
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
            const seg = buildLabelmap(parsed.ds, parsed.bits, ct);
            post({ t: 'labelmap', lab: seg.lab, colors: seg.colors, names: seg.names, terminology: seg.terminology }, [seg.lab.buffer]);
        }
        post({ t: 'alldone' });
    }
    catch (err) {
        post({ t: 'error', error: String(err && err.stack || err) });
    }
};
