// IDC public-bucket S3 helpers (main thread — s3ListKeys needs DOMParser).
// IDC spreads series across several open, CORS-enabled buckets (idc-open-data, idc-open-data-cr, ...).
export const idcS3 = (bucket) => 'https://' + (bucket || 'idc-open-data') + '.s3.us-east-1.amazonaws.com/';
/** fetch with retries + jittered exponential backoff (the IDC S3 endpoint returns transient errors under concurrency). */
export async function fetchRetry(url, opts, tries = 6) {
    let err;
    for (let i = 0; i < tries; i++) {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), 20000); // free a stalled connection from the per-host pool
        try {
            const r = await fetch(url, { ...(opts || {}), signal: ac.signal });
            if (!r.ok && r.status !== 206)
                throw new Error('HTTP ' + r.status);
            return r;
        }
        catch (e) {
            err = e;
            if (i < tries - 1)
                await new Promise((res) => setTimeout(res, Math.min(4000, 250 * 2 ** i) * (0.6 + 0.8 * Math.random())));
        }
        finally {
            clearTimeout(to);
        }
    }
    throw err;
}
/** List every `.dcm` object key under a series prefix via S3 ListObjectsV2 (paged). */
export async function s3ListKeys(prefix, bucket) {
    if (!prefix.endsWith('/'))
        prefix += '/';
    const base = idcS3(bucket);
    const keys = [];
    let token = null, more = true;
    while (more) {
        let url = `${base}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
        if (token)
            url += `&continuation-token=${encodeURIComponent(token)}`;
        const xml = new DOMParser().parseFromString(await fetchRetry(url).then((r) => r.text()), 'application/xml');
        for (const e of Array.from(xml.getElementsByTagName('Key'))) {
            const k = e.textContent;
            if (k && /\.dcm$/i.test(k))
                keys.push(k); // skip S3 folder-marker keys
        }
        more = xml.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
        token = more ? xml.getElementsByTagName('NextContinuationToken')[0]?.textContent ?? null : null;
    }
    return keys;
}
/** Build an OHIF viewer deep-link for a study (for "open in IDC viewer" links). */
export function ohifViewerURL(studyInstanceUID) {
    return studyInstanceUID
        ? `https://viewer.imaging.datacommons.cancer.gov/viewer/${studyInstanceUID}`
        : null;
}
