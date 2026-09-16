// High-level loaders: list a series' DICOM keys, then run the decode worker and surface a CTVolume (+SEG).
import { s3ListKeys } from './s3.js';
import { loadManifest, pickRandom } from './roulette.js';
let _worker = null; // one live worker; a new load terminates the previous (frees IDC connections)
function resolveWorkerURL(opts) {
    if (opts?.workerUrl)
        return opts.workerUrl;
    return new URL('./idc-worker.js', import.meta.url); // sits next to the built loader
}
function runWorker(ctKeys, segKeys, ctBucket, segBucket, modality, handlers, opts) {
    if (_worker) {
        try {
            _worker.terminate();
        }
        catch { /* ignore */ }
        _worker = null;
    }
    return new Promise((resolve, reject) => {
        const w = new Worker(resolveWorkerURL(opts)); // classic worker (uses importScripts for dcmjs)
        _worker = w;
        let ct, seg;
        let chain = Promise.resolve(); // serialize async handler work
        w.onmessage = (e) => {
            const m = e.data;
            switch (m.t) {
                case 'ctinfo':
                    handlers.onSliceCount?.(m.count);
                    break;
                case 'thumb':
                    handlers.onThumb?.(m.n, m.w, m.h, m.rgba);
                    break;
                case 'seg':
                    handlers.onSegName?.(m.name);
                    break;
                case 'progress':
                    handlers.onProgress?.({ frac: m.frac, msg: m.msg });
                    break;
                case 'ct': {
                    const Ctor = m.dtype === 'float32' ? Float32Array : Int16Array;
                    ct = { vol: new Ctor(m.vol), dims: m.dims, ijkToRAS: m.ijkToRAS, win: m.win, lev: m.lev, dtype: m.dtype, modality };
                    chain = chain.then(() => handlers.onCT?.(ct)).catch((err) => console.error('[idc_tools] onCT', err));
                    break;
                }
                case 'labelmap': {
                    seg = { lab: new Uint8Array(m.lab), colors: m.colors, names: m.names, terminology: m.terminology };
                    chain = chain.then(() => handlers.onLabelmap?.(seg)).catch((err) => console.error('[idc_tools] onLabelmap', err));
                    break;
                }
                case 'error':
                    w.terminate();
                    if (_worker === w)
                        _worker = null;
                    reject(new Error(m.error));
                    break;
                case 'alldone':
                    w.terminate();
                    if (_worker === w)
                        _worker = null;
                    chain.then(() => resolve({ ct: ct, seg }));
                    break;
            }
        };
        w.onerror = (e) => { w.terminate(); if (_worker === w)
            _worker = null; reject(new Error('idc_tools worker: ' + (e.message || e))); };
        w.postMessage({ ctKeys, segKeys, ctBucket, segBucket, modality });
    });
}
/** Load one series (and its SEG, if present) by manifest entry. */
export async function loadSeries(entry, handlers = {}, opts) {
    const modality = { CT: 'CT', MR: 'MR', PT: 'PET' }[entry.m] || entry.m;
    const ctKeys = await s3ListKeys(entry.c, entry.cb);
    if (!ctKeys.length)
        throw new Error('idc_tools: no DICOM under CT prefix ' + entry.c);
    const segKeys = entry.s ? await s3ListKeys(entry.s, entry.sb) : [];
    const r = await runWorker(ctKeys, segKeys, entry.cb, entry.sb, modality, handlers, opts);
    r.entry = entry;
    return r;
}
/** Decode ONE representative (middle) slice of a series into a small grayscale preview — for the
 *  OHIF-style series panel. Uses a PRIVATE, short-lived worker (NOT the shared singleton), so it
 *  never terminates or is terminated by a main series load, and several can run at once.
 *  Returns { vol, dims:[w,h,1], win, lev } or null (no DICOM under the prefix / decode failed /
 *  the object carries no pixel data, e.g. SR/RTSTRUCT). */
export async function loadThumbnail(prefix, bucket, modality, opts) {
    const keys = await s3ListKeys(prefix, bucket);
    if (!keys.length)
        return null;
    const mid = keys[Math.floor(keys.length / 2)];
    const mod = { CT: 'CT', MR: 'MR', PT: 'PET' }[modality] || modality;
    return new Promise((resolve) => {
        let w;
        try {
            w = new Worker(resolveWorkerURL(opts));
        }
        catch {
            return resolve(null);
        }
        let out = null;
        const done = (v) => { try {
            w.terminate();
        }
        catch { /* ignore */ } resolve(v); };
        w.onmessage = (e) => {
            const m = e.data;
            if (m.t === 'ct')
                out = { vol: new (m.dtype === 'float32' ? Float32Array : Int16Array)(m.vol), dims: m.dims, win: m.win, lev: m.lev };
            else if (m.t === 'alldone')
                done(out);
            else if (m.t === 'error')
                done(null);
        };
        w.onerror = () => done(null);
        w.postMessage({ ctKeys: [mid], segKeys: [], ctBucket: bucket, segBucket: bucket, modality: mod });
    });
}
/** Spin a random series from the manifest and load it. `filter` narrows the pool (e.g. CT only). */
export async function spinRandom(handlers = {}, opts) {
    const manifest = await loadManifest(opts?.manifestUrl);
    const entry = pickRandom(manifest, opts?.filter);
    return loadSeries(entry, handlers, opts);
}
