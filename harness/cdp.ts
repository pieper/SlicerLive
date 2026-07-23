// Minimal Chrome DevTools Protocol client for the SlicerLive <-> Slicer A/B harness.
// Deno has a native WebSocket, so no deps. Chrome is always launched HEADED (on-screen)
// so the user can watch and intervene — never headless (see docs/HARNESS.md).
//
// Gives us true browser-level synthetic input (Input.dispatchMouseEvent), deterministic
// state readback (Runtime.evaluate), and pixel capture (Page.captureScreenshot) — the
// three things we need to prove SlicerLive behaves identically to native Slicer.

export interface Target { id: string; type: string; title: string; url: string; webSocketDebuggerUrl?: string }

export class CDP {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: unknown) => void }>();
  private listeners = new Map<string, ((p: unknown) => void)[]>();

  static async targets(port = 9222): Promise<Target[]> {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`);
    return await r.json() as Target[];
  }

  /** Wait for Chrome's debug endpoint to come up (after launching it). */
  static async waitForChrome(port = 9222, timeoutMs = 20000): Promise<Target[]> {
    const end = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < end) {
      try { return await CDP.targets(port); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 200)); }
    }
    throw new Error(`Chrome debug port ${port} not reachable: ${lastErr}`);
  }

  /** Attach to the first page target (optionally matching a url substring). */
  static async attachToPage(port = 9222, urlMatch?: string): Promise<CDP> {
    const targets = await CDP.waitForChrome(port);
    const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    const t = (urlMatch ? pages.find((p) => p.url.includes(urlMatch)) : undefined) ?? pages[0];
    if (!t) throw new Error("no page target found");
    const c = new CDP();
    await c.connect(t.webSocketDebuggerUrl!);
    return c;
  }

  connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
            else p.res(msg.result);
          }
        } else if (msg.method) {
          for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params);
        }
      };
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, cb: (p: unknown) => void) {
    const arr = this.listeners.get(method) ?? [];
    arr.push(cb);
    this.listeners.set(method, arr);
  }

  /** Evaluate JS in the page and return the value (deep-serialized via JSON). */
  async eval<T = unknown>(expr: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression: `(async () => { ${expr} })()`, returnByValue: true, awaitPromise: true },
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  /** Navigate and wait for a genuinely NEW document to finish loading.
   *
   *  Waiting on Page.loadEventFired alone is not enough: when navigating to the URL the
   *  page is already on, a subsequent `waitFor(...)` can match state left over from the
   *  OLD document and the test then runs against a page that is about to be wiped
   *  (symptom: synthetic input lands during reload, before listeners are attached, and
   *  silently does nothing). So we stamp the current document and wait until the stamp
   *  is gone AND readyState is complete — i.e. a different document is fully loaded. */
  async goto(url: string, waitMs = 60000): Promise<void> {
    await this.send("Page.enable");
    const stamp = `s${Date.now()}_${Math.round(performance.now())}`;
    try { await this.eval(`window.__cdpNavStamp = ${JSON.stringify(stamp)}; return 1;`); } catch { /* blank page */ }
    await this.send("Page.navigate", { url });
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      try {
        const fresh = await this.eval<boolean>(
          `return window.__cdpNavStamp !== ${JSON.stringify(stamp)} && document.readyState === "complete";`,
        );
        if (fresh) return;
      } catch { /* mid-navigation: execution context destroyed */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`goto(${url}) did not reach a fresh loaded document within ${waitMs}ms`);
  }

  /** Wait until `expr` (a JS expression returning boolean) is true. */
  async waitFor(expr: string, timeoutMs = 60000, pollMs = 200): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { if (await this.eval<boolean>(`return !!(${expr});`)) return true; } catch { /* page may be mid-navigation */ }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  async screenshot(path: string): Promise<void> {
    const r = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await Deno.writeFile(path, Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
  }

  // --- true browser-level synthetic input -------------------------------------
  async mouse(type: "mousePressed" | "mouseReleased" | "mouseMoved", x: number, y: number, opts: {
    button?: "left" | "middle" | "right" | "none"; buttons?: number; clickCount?: number; modifiers?: number;
  } = {}) {
    await this.send("Input.dispatchMouseEvent", {
      type, x, y,
      button: opts.button ?? "left",
      buttons: opts.buttons ?? (type === "mouseReleased" ? 0 : 1),
      clickCount: opts.clickCount ?? (type === "mouseMoved" ? 0 : 1),
      modifiers: opts.modifiers ?? 0,
    });
  }

  /** Press-drag-release with interpolated moves (like a real user drag). */
  async drag(x0: number, y0: number, x1: number, y1: number, opts: { button?: "left" | "middle" | "right"; steps?: number; modifiers?: number } = {}) {
    const button = opts.button ?? "left", steps = opts.steps ?? 12, modifiers = opts.modifiers ?? 0;
    const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
    await this.mouse("mouseMoved", x0, y0, { button: "none", buttons: 0, modifiers });
    await this.mouse("mousePressed", x0, y0, { button, buttons, modifiers });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.mouse("mouseMoved", x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, { button, buttons, modifiers });
      await new Promise((r) => setTimeout(r, 8));
    }
    await this.mouse("mouseReleased", x1, y1, { button, buttons: 0, modifiers });
  }

  async wheel(x: number, y: number, deltaY: number, modifiers = 0) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers, buttons: 0 });
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}
