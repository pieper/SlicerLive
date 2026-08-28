// Session controls for a SlicerLive page: pick the SlicerLiveSessions directory (File System Access;
// OPFS when the picker is unavailable), open/create a session, attach the store to the LiveScene (autosave
// log + checkpoints + blob cache), keyboard undo/redo, bookmark, and export ("save") of the active set.
import type { LiveScene } from "../livescene.ts";
import { FsaFS, type SessionFS } from "../sessions/session-fs.ts";
import { SessionStore } from "../sessions/session-store.ts";
import { setBlobFetch } from "../zarr.ts";

const DB = "slicerlive-sessions", KEY = "sessionsRoot";
async function idb(): Promise<IDBDatabase> {
  return await new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function kvGet<T>(k: string): Promise<T | undefined> { const d = await idb(); return await new Promise((res) => { const t = d.transaction("kv").objectStore("kv").get(k); t.onsuccess = () => res(t.result as T); t.onerror = () => res(undefined); }); }
async function kvSet(k: string, v: unknown): Promise<void> { const d = await idb(); await new Promise<void>((res) => { const t = d.transaction("kv", "readwrite").objectStore("kv").put(v, k); t.onsuccess = () => res(); t.onerror = () => res(); }); }

export interface SessionUI { store?: SessionStore; status(): string; pickDirectory(): Promise<void>; openOPFS(): Promise<void>; open(name?: string): Promise<void>; exportTo(): Promise<{ nodes: number; blobs: number; missing: string[] } | null> }

export function mountSessionUI(live: LiveScene, opts: { onStatus?: (s: string) => void; blobBase: () => string } ): SessionUI {
  let root: FileSystemDirectoryHandle | undefined;
  let rootLabel = "";
  let store: SessionStore | undefined;
  const say = (s: string) => opts.onStatus?.(s);

  const installBlobCache = (st: SessionStore) => {
    setBlobFetch(async (url) => {
      const hash = url.slice(url.lastIndexOf("/") + 1);
      if (hash.startsWith("sha256-")) {
        const cached = await st.cachedBlob(hash);
        if (cached) return new Response(cached);
        const r = await fetch(url);
        if (r.ok) { const bytes = new Uint8Array(await r.clone().arrayBuffer()); void st.cacheBlob(hash, bytes); }
        return r;
      }
      return fetch(url);
    });
  };

  const api: SessionUI = {
    get store() { return store; },
    status() { return store ? `session ${store.meta.name} @ ${rootLabel} (undo ${store.undo.length})` : "no session"; },
    async pickDirectory() {
      const picker = (globalThis as unknown as { showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
      if (!picker) { say("directory picker unavailable — using browser storage (OPFS)"); return api.openOPFS(); }
      root = await picker({ mode: "readwrite", id: "slicerlive-sessions" });
      rootLabel = root.name; await kvSet(KEY, root);
      await api.open();
    },
    async openOPFS() {
      root = await navigator.storage.getDirectory(); rootLabel = "OPFS";
      await api.open();
    },
    async open(name?: string) {
      if (!root) {
        const saved = await kvGet<FileSystemDirectoryHandle>(KEY);
        if (saved) {
          const perm = await (saved as unknown as { queryPermission: (o: unknown) => Promise<string> }).queryPermission({ mode: "readwrite" });
          if (perm === "granted" || (await (saved as unknown as { requestPermission: (o: unknown) => Promise<string> }).requestPermission({ mode: "readwrite" })) === "granted") { root = saved; rootLabel = saved.name; }
        }
        if (!root) { root = await navigator.storage.getDirectory(); rootLabel = "OPFS"; }
      }
      const id = name ?? ("session-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
      const dir = await root.getDirectoryHandle(id, { create: true });
      const fs: SessionFS = new FsaFS(dir, `${rootLabel}/${id}`);
      store?.detach();
      store = new SessionStore(fs, { name: id });
      await store.open();
      await store.attach(live);
      installBlobCache(store);
      say(api.status());
    },
    async exportTo() {
      if (!store || !root) return null;
      const id = `export-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.slicerlive`;
      const target = new FsaFS(await root.getDirectoryHandle(id, { create: true }), id);
      const base = opts.blobBase();
      const r = await store.exportActiveSet(target, async (h) => { const resp = await fetch(base + h); return resp.ok ? new Uint8Array(await resp.arrayBuffer()) : null; });
      say(`exported ${r.nodes} nodes, ${r.blobs} blobs${r.missing.length ? `, ${r.missing.length} missing` : ""} → ${id}`);
      return r;
    },
  };
  addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || !store) return;
    if (e.key.toLowerCase() === "z") { e.preventDefault(); e.stopPropagation(); const r = e.shiftKey ? store.redoLast() : store.undoLast(); say(r ? `${e.shiftKey ? "redo" : "undo"} ${r.label}` : "nothing to " + (e.shiftKey ? "redo" : "undo")); }
    else if (e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); void api.exportTo(); }
    else if (e.key.toLowerCase() === "b") { e.preventDefault(); void store.bookmark("bookmark " + new Date().toLocaleTimeString()).then((b) => say(`bookmark @${b.seq}`)); }
  }, true);
  return api;
}
