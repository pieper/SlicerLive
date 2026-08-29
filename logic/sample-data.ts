// Sample Data catalog (W1) — the same files, URLs and SHA-256 checksums as Slicer's SampleData module
// (Modules/Scripted/SampleData/SampleData.py, TESTING_DATA_URL + "SHA256/<hash>"), so a parity test can load
// the identical bytes in both apps. Pure TS: fetch is injected for tests.

export interface SampleDataset { name: string; title: string; fileName: string; sha256: string; kind: "volume"; modality?: string; mb?: number }

export const TESTING_DATA_URL = "https://github.com/Slicer/SlicerTestingData/releases/download/";

export const SAMPLE_DATA: SampleDataset[] = [
  { name: "MRHead", title: "MRHead", fileName: "MR-head.nrrd", sha256: "cc211f0dfd9a05ca3841ce1141b292898b2dd2d3f08286affadf823a7e58df93", kind: "volume", modality: "MR", mb: 8 },
  { name: "CTChest", title: "CTChest", fileName: "CT-chest.nrrd", sha256: "4507b664690840abb6cb9af2d919377ffc4ef75b167cb6fd0f747befdb12e38e", kind: "volume", modality: "CT", mb: 33 },
  { name: "CTACardio", title: "CTACardio", fileName: "CTA-cardio.nrrd", sha256: "3b0d4eb1a7d8ebb0c5a89cc0504640f76a030b4e869e33ff34c564c3d3b88ad2", kind: "volume", modality: "CT", mb: 25 },
  { name: "CTAAbdomenPanoramix", title: "CTA abdomen (Panoramix)", fileName: "Panoramix-cropped.nrrd", sha256: "146af87511520c500a3706b7b2bfb545f40d5d04dd180be3a7a2c6940e447433", kind: "volume", modality: "CT", mb: 48 },
  { name: "DTIBrain", title: "DTIBrain", fileName: "DTI-Brain.nrrd", sha256: "5c78d00c86ae8d968caa7a49b870ef8e1c04525b1abc53845751d8bce1f0b91a", kind: "volume", modality: "DTI", mb: 20 },
];

/** GitHub release assets carry no CORS headers, so a browser page cannot fetch them; the same files (same
 *  SHA-256) are mirrored in the CORS-enabled SlicerLive bucket. Deno/desktop can use either. */
export const SAMPLE_MIRROR = "https://js2.jetstream-cloud.org:8001/swift/v1/slicerlive/sampledata/";
export function sampleUrl(d: SampleDataset): string { return `${TESTING_DATA_URL}SHA256/${d.sha256}`; }
export function sampleMirrorUrl(d: SampleDataset): string { return SAMPLE_MIRROR + d.fileName; }
/** Candidate URLs in order: the mirror first in a browser (CORS), GitHub first elsewhere. */
export function sampleUrls(d: SampleDataset): string[] {
  const inBrowser = typeof (globalThis as { document?: unknown }).document !== "undefined";
  return inBrowser ? [sampleMirrorUrl(d), sampleUrl(d)] : [sampleUrl(d), sampleMirrorUrl(d)];
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Fetch = (url: string, onBytes?: (n: number) => void) => Promise<Uint8Array>;

/** Default fetch with streamed progress. */
export const streamFetch: Fetch = async (url, onBytes) => {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
  const parts: Uint8Array[] = []; let total = 0;
  const rd = r.body.getReader();
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); total += value.byteLength; onBytes?.(value.byteLength); }
  const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
};

/** Download a sample dataset and VERIFY its SHA-256 (a mismatch is an error, never a warning). */
export async function downloadSample(name: string, fetchImpl: Fetch = streamFetch, onBytes?: (n: number) => void): Promise<{ dataset: SampleDataset; bytes: Uint8Array }> {
  const d = SAMPLE_DATA.find((x) => x.name === name);
  if (!d) throw new Error(`unknown sample dataset ${name}`);
  let bytes: Uint8Array | null = null, lastErr: unknown;
  for (const url of sampleUrls(d)) {
    try { bytes = await fetchImpl(url, onBytes); break; } catch (e) { lastErr = e; }
  }
  if (!bytes) throw new Error(`${d.name}: download failed (${String((lastErr as Error)?.message ?? lastErr)})`);
  const got = await sha256Hex(bytes);
  if (got !== d.sha256) throw new Error(`${d.name}: SHA-256 mismatch (got ${got.slice(0, 12)}…, expected ${d.sha256.slice(0, 12)}…)`);
  return { dataset: d, bytes };
}
