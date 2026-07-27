// load dcmjs, retrying across CDN mirrors (jsdelivr/unpkg are occasionally flaky from some networks)
(function loadDcmjs() {
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
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lps2ras = (v) => [-v[0], -v[1], v[2]]; // DICOM LPS -> RAS
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
async function buildVolume(ctKeys) {
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
    const s0 = slices[0];
    const iop = s0.ImageOrientationPatient.map(Number);
    const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6);
    const normal = cross(rowDir, colDir);
    slices.sort((a, b) => dot(a.ImagePositionPatient.map(Number), normal) - dot(b.ImagePositionPatient.map(Number), normal));
    const nz = slices.length, ny = s0.Rows, nx = s0.Columns;
    const ps = s0.PixelSpacing.map(Number);
    const p0 = slices[0].ImagePositionPatient.map(Number);
    const p1 = slices[nz - 1].ImagePositionPatient.map(Number);
    const sliceSpacing = nz > 1 ? dot(sub(p1, p0), normal) / (nz - 1) : (Number(s0.SliceThickness) || 1);
    const c0 = lps2ras(rowDir.map((v) => v * ps[1])), c1 = lps2ras(colDir.map((v) => v * ps[0])), c2 = lps2ras(normal.map((v) => v * sliceSpacing)), o = lps2ras(p0);
    const ijkToRAS = [c0[0], c1[0], c2[0], o[0], c0[1], c1[1], c2[1], o[1], c0[2], c1[2], c2[2], o[2], 0, 0, 0, 1];
    const isPET = MODNAME === 'PET';
    const vol = isPET ? new Float32Array(nx * ny * nz) : new Int16Array(nx * ny * nz);
    const slope = Number(s0.RescaleSlope ?? 1), inter = Number(s0.RescaleIntercept ?? 0);
    for (let k = 0; k < nz; k++) {
        const ds = slices[k];
        let pd = ds.PixelData;
        if (Array.isArray(pd))
            pd = pd[0];
        const px = ds.PixelRepresentation === 1 ? new Int16Array(pd) : new Uint16Array(pd);
        const off = k * nx * ny;
        for (let p = 0; p < nx * ny; p++)
            vol[off + p] = px[p] * slope + inter;
    }
    let win, lev;
    if (MODNAME === 'CT') {
        win = Number((Array.isArray(s0.WindowWidth) ? s0.WindowWidth[0] : s0.WindowWidth) ?? 400);
        lev = Number((Array.isArray(s0.WindowCenter) ? s0.WindowCenter[0] : s0.WindowCenter) ?? 40);
    }
    else {
        const N = vol.length, step = Math.max(1, (N / 200000) | 0), samp = [];
        for (let i = 0; i < N; i += step) {
            const v = vol[i];
            if (!isPET || v > 0)
                samp.push(v);
        }
        samp.sort((a, b) => a - b);
        const pct = (f) => (samp.length ? samp[Math.min(samp.length - 1, (f * samp.length) | 0)] : 0);
        const lo = isPET ? 0 : pct(0.01), hi = isPET ? (pct(0.98) || 1) : pct(0.99);
        lev = (lo + hi) / 2;
        win = Math.max(1, hi - lo);
    }
    return { vol, dims: [nx, ny, nz], ijkToRAS, win, lev, iop, ps, dtype: isPET ? 'float32' : 'int16' };
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
    const colors = [], names = {};
    for (const s of (ds.SegmentSequence || [])) {
        const rgb = s.RecommendedDisplayCIELabValue ? dcmjs.data.Colors.dicomlab2RGB(s.RecommendedDisplayCIELabValue) : [1, 1, 1];
        colors.push([Number(s.SegmentNumber), rgb[0], rgb[1], rgb[2]]);
        names[Number(s.SegmentNumber)] = s.SegmentLabel || ('Segment ' + s.SegmentNumber);
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
    return { lab, colors, names };
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
    const { ctKeys, segKeys, ctBucket, segBucket, modality } = e.data;
    CT_S3 = s3url(ctBucket);
    SEG_S3 = s3url(segBucket);
    MODNAME = { CT: 'CT', MR: 'MR', PT: 'PET' }[modality] || 'image';
    try {
        prog('fetching ' + MODNAME + '…', 0.05);
        const ct = await buildVolume(ctKeys);
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
            post({ t: 'labelmap', lab: seg.lab, colors: seg.colors, names: seg.names }, [seg.lab.buffer]);
        }
        post({ t: 'alldone' });
    }
    catch (err) {
        post({ t: 'error', error: String(err && err.stack || err) });
    }
};
