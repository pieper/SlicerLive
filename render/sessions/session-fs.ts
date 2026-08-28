// SessionFS — the minimal file-system surface a Session needs, so the same store runs on the browser's
// File System Access directory (user-picked SlicerLiveSessions/), OPFS (fallback), Deno (desktop shell,
// tests) or memory (tests). Paths are "/"-separated and relative to the session root.

export interface SessionFS {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  appendText(path: string, text: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array | null>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;
  /** A human-readable location (absolute path when known, e.g. Deno / the desktop shell). */
  describe(): string;
}

export class MemoryFS implements SessionFS {
  files = new Map<string, Uint8Array>();
  private enc = new TextEncoder(); private dec = new TextDecoder();
  readText(p: string) { const b = this.files.get(p); return Promise.resolve(b ? this.dec.decode(b) : null); }
  writeText(p: string, t: string) { this.files.set(p, this.enc.encode(t)); return Promise.resolve(); }
  appendText(p: string, t: string) { const old = this.files.get(p); const add = this.enc.encode(t); const out = new Uint8Array((old?.length ?? 0) + add.length); if (old) out.set(old); out.set(add, old?.length ?? 0); this.files.set(p, out); return Promise.resolve(); }
  readBytes(p: string) { return Promise.resolve(this.files.get(p) ?? null); }
  writeBytes(p: string, b: Uint8Array) { this.files.set(p, b); return Promise.resolve(); }
  exists(p: string) { return Promise.resolve(this.files.has(p)); }
  list(dir: string) { const pre = dir.replace(/\/$/, "") + "/"; return Promise.resolve([...this.files.keys()].filter((k) => k.startsWith(pre)).map((k) => k.slice(pre.length)).filter((k) => !k.includes("/"))); }
  describe() { return "memory"; }
}

export class DenoFS implements SessionFS {
  constructor(private root: string) {}
  private p(path: string) { return `${this.root}/${path}`; }
  private async ensureDir(path: string) { const i = path.lastIndexOf("/"); if (i > 0) await Deno.mkdir(this.p(path.slice(0, i)), { recursive: true }); else await Deno.mkdir(this.root, { recursive: true }); }
  async readText(p: string) { try { return await Deno.readTextFile(this.p(p)); } catch { return null; } }
  async writeText(p: string, t: string) { await this.ensureDir(p); await Deno.writeTextFile(this.p(p), t); }
  async appendText(p: string, t: string) { await this.ensureDir(p); await Deno.writeTextFile(this.p(p), t, { append: true }); }
  async readBytes(p: string) { try { return await Deno.readFile(this.p(p)); } catch { return null; } }
  async writeBytes(p: string, b: Uint8Array) { await this.ensureDir(p); await Deno.writeFile(this.p(p), b); }
  async exists(p: string) { try { await Deno.stat(this.p(p)); return true; } catch { return false; } }
  async list(dir: string) { const out: string[] = []; try { for await (const e of Deno.readDir(this.p(dir))) out.push(e.name); } catch { /* none */ } return out; }
  describe() { return this.root; }
}

/** File System Access API (Chromium) — also what OPFS hands out (`navigator.storage.getDirectory()`). */
export class FsaFS implements SessionFS {
  constructor(private root: FileSystemDirectoryHandle, private label = "directory") {}
  private async dir(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string } | null> {
    const parts = path.split("/").filter(Boolean); const name = parts.pop()!;
    let d = this.root;
    for (const p of parts) { try { d = await d.getDirectoryHandle(p, { create }); } catch { return null; } }
    return { dir: d, name };
  }
  async readText(p: string) { const b = await this.readBytes(p); return b ? new TextDecoder().decode(b) : null; }
  async writeText(p: string, t: string) { await this.writeBytes(p, new TextEncoder().encode(t)); }
  async appendText(p: string, t: string) {
    const r = await this.dir(p, true); if (!r) return;
    const fh = await r.dir.getFileHandle(r.name, { create: true });
    const size = (await fh.getFile()).size;
    const w = await fh.createWritable({ keepExistingData: true });
    await w.seek(size); await w.write(t); await w.close();
  }
  async readBytes(p: string) { const r = await this.dir(p, false); if (!r) return null; try { const fh = await r.dir.getFileHandle(r.name); return new Uint8Array(await (await fh.getFile()).arrayBuffer()); } catch { return null; } }
  async writeBytes(p: string, b: Uint8Array) { const r = await this.dir(p, true); if (!r) return; const fh = await r.dir.getFileHandle(r.name, { create: true }); const w = await fh.createWritable(); await w.write(b); await w.close(); }
  async exists(p: string) { const r = await this.dir(p, false); if (!r) return false; try { await r.dir.getFileHandle(r.name); return true; } catch { try { await r.dir.getDirectoryHandle(r.name); return true; } catch { return false; } } }
  async list(dir: string) { const out: string[] = []; const parts = dir.split("/").filter(Boolean); let d = this.root; for (const p of parts) { try { d = await d.getDirectoryHandle(p); } catch { return out; } } for await (const k of (d as unknown as { keys(): AsyncIterable<string> }).keys()) out.push(k); return out; }
  describe() { return this.label; }
}
