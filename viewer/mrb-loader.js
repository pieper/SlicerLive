// MRB (Slicer's self-contained zip) loader for SlicerLive.
// Returns the inner .mrml XML text + a Map of basename -> Uint8Array for
// every other file in the bundle. The caller is responsible for resolving
// MRML storage-node fileName attrs against the map and parsing each file
// per its extension.

import { unzipSync, strFromU8 } from 'fflate';

export function unzipMrb(bytes) {
  const entries = unzipSync(bytes);
  let mrmlXml = null;
  let mrmlPath = null;
  const files = new Map();
  for (const [path, data] of Object.entries(entries)) {
    if (!data || !data.length) continue;                   // directory entries
    const lower = path.toLowerCase();
    if (lower.endsWith('.mrml') && !mrmlXml) {
      mrmlXml = strFromU8(data);
      mrmlPath = path;
      continue;
    }
    // Index by full path AND by basename — MRML fileName refs usually use
    // basename or `Data/<basename>`; either form should resolve.
    files.set(path, data);
    const base = path.split('/').pop();
    if (base && base !== path && !files.has(base)) files.set(base, data);
  }
  if (!mrmlXml) throw new Error('No .mrml found inside MRB');
  return { mrmlXml, mrmlPath, files };
}
