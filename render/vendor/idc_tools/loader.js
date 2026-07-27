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
                    seg = { lab: new Uint8Array(m.lab), colors: m.colors, names: m.names };
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
/** Spin a random series from the manifest and load it. `filter` narrows the pool (e.g. CT only). */
export async function spinRandom(handlers = {}, opts) {
    const manifest = await loadManifest(opts?.manifestUrl);
    const entry = pickRandom(manifest, opts?.filter);
    return loadSeries(entry, handlers, opts);
}
