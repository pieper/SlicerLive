import { fetchRetry } from './s3.js';
/** Load segroulette.json (rows of {c,s,m,col,...} plus optional stats). Cache-busted. */
export async function loadManifest(url = 'segroulette.json') {
    const data = await fetchRetry(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now()).then((r) => r.json());
    return { rows: (data.rows || data), stats: data.stats || null };
}
/** Pick a random series, collection-uniform. Optional predicate filters (e.g. CT only). */
export function pickRandom(manifest, filter) {
    const byCol = {};
    for (const e of manifest.rows) {
        if (filter && !filter(e))
            continue;
        (byCol[e.col] = byCol[e.col] || []).push(e);
    }
    const cols = Object.keys(byCol);
    if (!cols.length)
        throw new Error('idc_tools: no series match the filter');
    const list = byCol[cols[Math.floor(Math.random() * cols.length)]];
    return list[Math.floor(Math.random() * list.length)];
}
