// Shared download-progress MOSAIC for IDC demos (DRY): while a DICOM series streams, lay out its
// slice thumbnails in a grid that fills in as they arrive (idc_tools onThumb/onSliceCount) — the
// popular loading visual from the old SEGRoulette. Overlays the view area; fades out when the scene
// is ready. Reusable by any demo that loads a slice-by-slice source.

export interface MosaicOpts {
  /** Pack the progress display into the bottom of the layout instead of floating it over the
   *  views. The views stay usable (and visible) while data streams in, and when the strip is
   *  packed away at the end they grow into the space — which is the "done" signal. */
  strip?: boolean;
}

export interface Mosaic {
  setCount(count: number): void;
  thumb(n: number, w: number, h: number, rgba: ArrayBuffer): void;
  status(msg: string): void;
  /** Show one full-size slice in place of the tile grid: a real image early, instead of only
   *  a mosaic of 64px thumbs, while the rest of the series downloads. */
  preview(w: number, h: number, rgba: ArrayBuffer): void;
  /** Fade out + remove. In strip mode this also hands the room back to the views, and resolves
   *  only once that has happened — deferred while a gesture is in flight, so a resize can never
   *  land in the middle of someone's zoom or orbit. */
  done(): Promise<void>;
  reset(): void;             // clear for a new load
  /** The load failed: stop looking like it is still working. Replaces the tiles and the
   *  progress caption with a card that says what went wrong and what to try. */
  fail(title: string, detail: string, hint?: string): void;
}

/** Count pointers currently held down, globally. The strip reads it so it never repacks the
 *  layout in the middle of a drag. Capture-phase and passive: it observes, never interferes. */
function trackPointers() {
  const g = globalThis as unknown as { __slPointersDown?: number; __slPointersTracked?: boolean };
  if (g.__slPointersTracked) return;
  g.__slPointersTracked = true;
  g.__slPointersDown = 0;
  const opt = { capture: true, passive: true } as const;
  globalThis.addEventListener("pointerdown", () => g.__slPointersDown = (g.__slPointersDown ?? 0) + 1, opt);
  const up = () => g.__slPointersDown = Math.max(0, (g.__slPointersDown ?? 0) - 1);
  globalThis.addEventListener("pointerup", up, opt);
  globalThis.addEventListener("pointercancel", up, opt);
}

export function createMosaic(host: HTMLElement, opts: MosaicOpts = {}): Mosaic {
  const strip = !!opts.strip;
  trackPointers();
  const wrap = document.createElement("div");
  wrap.style.cssText = strip
    // A row packed at the bottom of the host's column: thumbnails left, caption right. It takes
    // real layout space, so the views above are a little smaller while it is there.
    ? "position:relative;flex:0 0 auto;display:block;" +
      "height:var(--sl-strip-h,132px);box-sizing:border-box;overflow:hidden;" +
      "background:#070a11;border-top:1px solid #1b2740;" +
      "transition:height 420ms cubic-bezier(.4,0,.2,1),opacity 260ms ease-out;"
    : "position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;" +
      "background:radial-gradient(60% 60% at 50% 45%,rgba(20,24,38,.35),rgba(6,8,14,.75));opacity:1;transition:opacity 350ms ease-out;";
  // The first full-size slice sits ABOVE the tile grid in the column, not over it: the image is
  // what the reader wants to look at, and the mosaic is progress underneath it. Stacking them
  // made the tiles cover the image they were reporting progress on.
  const preview_ = document.createElement("canvas");
  const PREVIEW_CSS = "max-width:min(62vmin,540px);border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5);";
  preview_.style.cssText = PREVIEW_CSS + (strip ? "max-height:100%;" : "max-height:46vh;") + "display:none;";
  const canvas = document.createElement("canvas");
  const TILES_FULL = "max-width:min(70vmin,620px);max-height:70vh;";
  const TILES_UNDER_PREVIEW = "max-width:min(52vmin,440px);max-height:26vh;opacity:.85;";
  const TILES_CSS = "border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5);image-rendering:auto;";
  // In the strip the tiles ARE the strip: they span its full width, and the grid is laid out to
  // the strip's own aspect so they fill the height too without being stretched.
  const TILES_STRIP = "display:block;width:100%;height:100%;object-fit:cover;";
  canvas.style.cssText = strip ? TILES_STRIP : TILES_FULL + TILES_CSS;
  const cap = document.createElement("div");
  cap.style.cssText = strip
    // Over the tiles, not beside them — the strip's width belongs to the thumbnails.
    ? "position:absolute;left:50%;bottom:7px;transform:translateX(-50%);z-index:1;" +
      "font:600 12px ui-monospace,Menlo,monospace;color:#9fe9ff;text-shadow:0 0 5px #000,0 0 5px #000;" +
      "background:rgba(5,8,14,.55);padding:2px 10px;border-radius:6px;pointer-events:none;white-space:nowrap;"
    : "font:600 12px ui-monospace,Menlo,monospace;color:#9fe9ff;text-shadow:0 0 4px #000;";
  wrap.appendChild(preview_); wrap.appendChild(canvas); wrap.appendChild(cap);
  if (!strip) {
    const hostPos = getComputedStyle(host).position;
    if (hostPos === "static") host.style.position = "relative";
  }
  host.appendChild(wrap);

  /** Resolves when no pointer is held down anywhere — i.e. nobody is mid-drag. */
  const idle = (): Promise<void> => {
    const down = () => (globalThis as unknown as { __slPointersDown?: number }).__slPointersDown ?? 0;
    if (!down()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (down()) return;
        globalThis.removeEventListener("pointerup", check, true);
        globalThis.removeEventListener("pointercancel", check, true);
        // Just after the release, so the gesture's own final redraw lands first. A timer, not
        // requestAnimationFrame: a window that is occluded when the pointer comes up gets no
        // frames, and the strip would then never pack away.
        setTimeout(resolve, 32);
      };
      globalThis.addEventListener("pointerup", check, true);
      globalThis.addEventListener("pointercancel", check, true);
    });
  };

  const ctx = canvas.getContext("2d")!;
  const tmp = document.createElement("canvas");
  const tctx = tmp.getContext("2d")!;
  let cols = 1, rows = 1, cw = 0, ch = 0, count = 0, filled = 0, laidOut = false;

  /** Rows x columns for `n` tiles of the given aspect. The overlay mosaic wants a square-ish
   *  block; the strip wants the grid shaped like the strip itself — as wide as the page and only
   *  as tall as the strip — so the tiles fill it without being stretched or letterboxed. */
  const gridFor = (n: number, aspect: number): [number, number] => {
    if (!strip) { const c = Math.ceil(Math.sqrt(n)); return [c, Math.ceil(n / c)]; }
    const box = wrap.getBoundingClientRect();
    const W = Math.max(1, box.width), H = Math.max(1, box.height || 132);
    let best: [number, number] = [n, 1], bestScale = 0;
    for (let r = 1; r <= Math.min(n, 12); r++) {
      const c = Math.ceil(n / r);
      // How big each tile can be in this arrangement; the arrangement that makes them biggest
      // is the one that wastes the least of the strip.
      const scale = Math.min(W / (c * aspect), H / r);
      if (scale > bestScale) { bestScale = scale; best = [c, r]; }
    }
    return best;
  };
  const layout = (n: number, aspect = 1) => {
    count = Math.max(1, n);
    [cols, rows] = gridFor(count, aspect);
    const cellW = strip ? Math.max(8, Math.round(1600 / cols)) : 96;   // px per thumb cell
    cw = cellW; ch = Math.round(cellW / aspect);
    canvas.width = cols * cw; canvas.height = rows * ch;
    ctx.fillStyle = "#0b0e14"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  return {
    setCount(n) { layout(n); },
    thumb(n, w, h, rgba) {
      const aspect = w / h;
      if (!count || cols * rows < count) layout(Math.max(count, n), aspect);
      else if (!laidOut) { laidOut = true; layout(count, aspect); }   // first tile: true aspect
      if (ch !== Math.round(cw / aspect)) { ch = Math.round(cw / aspect); canvas.height = rows * ch; ctx.fillStyle = "#0b0e14"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      tmp.width = w; tmp.height = h;
      tctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
      const idx = Math.max(0, (n | 0) - 1) % (cols * rows);
      const cx = (idx % cols) * cw, cy = Math.floor(idx / cols) * ch;
      ctx.drawImage(tmp, cx, cy, cw, ch);
      filled++;
      cap.textContent = `streaming ${filled}${count ? " / " + count : ""} slices…`;
    },
    status(msg) { cap.textContent = msg; },
    preview(w, h, rgba) {
      preview_.width = w;
      preview_.height = h;
      preview_.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
      preview_.style.display = "block";
      // The image takes the room; the tiles step down to a progress strip beneath it.
      canvas.style.cssText = TILES_UNDER_PREVIEW + TILES_CSS;
    },
    fail(title, detail, hint) {
      // Leaving the last progress message up is what made a dead load look like a live one.
      preview_.remove();
      canvas.remove();
      cap.remove();
      const card = document.createElement("div");
      card.style.cssText = "max-width:min(560px,86vw);padding:16px 18px;border-radius:12px;" +
        "background:rgba(18,10,12,.92);border:1px solid rgba(255,107,116,.5);color:#ffd9dc;" +
        "font:13px/1.5 -apple-system,system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5);";
      const h = document.createElement("div");
      h.textContent = title;
      h.style.cssText = "font:700 14px -apple-system,system-ui,sans-serif;color:#ff6b74;margin-bottom:7px;";
      const d = document.createElement("div");
      d.textContent = detail;
      d.style.cssText = "word-break:break-word;color:#f2dfe1;";
      card.appendChild(h); card.appendChild(d);
      if (hint) {
        const t = document.createElement("div");
        t.textContent = hint;
        t.style.cssText = "margin-top:9px;padding-top:9px;border-top:1px solid rgba(255,255,255,.14);" +
          "color:#cdb8bb;font-size:12px;";
        card.appendChild(t);
      }
      const copy = document.createElement("button");
      copy.textContent = "Copy details";
      copy.style.cssText = "margin-top:11px;padding:5px 11px;border-radius:7px;cursor:pointer;" +
        "background:rgba(255,255,255,.1);color:#ffd9dc;border:1px solid rgba(255,255,255,.22);font:inherit;";
      copy.onclick = () => {
        const text = `${title}\n${detail}${hint ? "\n" + hint : ""}\n${location.href}`;
        navigator.clipboard?.writeText(text).then(
          () => (copy.textContent = "Copied"),
          () => (copy.textContent = "Press ⌘C"),
        );
      };
      card.appendChild(copy);
      wrap.appendChild(card);
    },
    done() {
      if (!strip) {
        wrap.style.opacity = "0";
        setTimeout(() => wrap.remove(), 400);
        return Promise.resolve();
      }
      // Packing the strip away resizes every view. Doing that mid-gesture would yank the thing
      // under the pointer, so wait for the pointer to come up first — a zoom or an orbit that is
      // still in progress finishes undisturbed, and the layout settles after it.
      return idle().then(() =>
        new Promise<void>((resolve) => {
          wrap.style.height = "0px";
          wrap.style.padding = "0px";
          wrap.style.opacity = "0";
          setTimeout(() => { wrap.remove(); resolve(); }, 460);
        })
      );
    },
    reset() {
      filled = 0; count = 0; laidOut = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      preview_.style.display = "none";
      canvas.style.cssText = (strip ? "max-height:100%;max-width:62vw;" : TILES_FULL) + TILES_CSS;
      wrap.style.opacity = "1";
      if (!wrap.isConnected) host.appendChild(wrap);
    },
  };
}
