// Shared download-progress MOSAIC for IDC demos (DRY): while a DICOM series streams, lay out its
// slice thumbnails in a grid that fills in as they arrive (idc_tools onThumb/onSliceCount) — the
// popular loading visual from the old SEGRoulette. Overlays the view area; fades out when the scene
// is ready. Reusable by any demo that loads a slice-by-slice source.

export interface Mosaic {
  setCount(count: number): void;
  thumb(n: number, w: number, h: number, rgba: ArrayBuffer): void;
  status(msg: string): void;
  /** Show one full-size slice in place of the tile grid: a real image early, instead of only
   *  a mosaic of 64px thumbs, while the rest of the series downloads. */
  preview(w: number, h: number, rgba: ArrayBuffer): void;
  done(): void;              // fade out + remove
  reset(): void;             // clear for a new load
  /** The load failed: stop looking like it is still working. Replaces the tiles and the
   *  progress caption with a card that says what went wrong and what to try. */
  fail(title: string, detail: string, hint?: string): void;
}

export function createMosaic(host: HTMLElement): Mosaic {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;" +
    "background:radial-gradient(60% 60% at 50% 45%,rgba(20,24,38,.35),rgba(6,8,14,.75));opacity:1;transition:opacity 350ms ease-out;";
  // The first full-size slice sits ABOVE the tile grid in the column, not over it: the image is
  // what the reader wants to look at, and the mosaic is progress underneath it. Stacking them
  // made the tiles cover the image they were reporting progress on.
  const preview_ = document.createElement("canvas");
  const PREVIEW_CSS = "max-width:min(62vmin,540px);border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5);";
  preview_.style.cssText = PREVIEW_CSS + "max-height:46vh;display:none;";
  const canvas = document.createElement("canvas");
  const TILES_FULL = "max-width:min(70vmin,620px);max-height:70vh;";
  const TILES_UNDER_PREVIEW = "max-width:min(52vmin,440px);max-height:26vh;opacity:.85;";
  const TILES_CSS = "border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5);image-rendering:auto;";
  canvas.style.cssText = TILES_FULL + TILES_CSS;
  const cap = document.createElement("div");
  cap.style.cssText = "font:600 12px ui-monospace,Menlo,monospace;color:#9fe9ff;text-shadow:0 0 4px #000;";
  wrap.appendChild(preview_); wrap.appendChild(canvas); wrap.appendChild(cap);
  const hostPos = getComputedStyle(host).position;
  if (hostPos === "static") host.style.position = "relative";
  host.appendChild(wrap);

  const ctx = canvas.getContext("2d")!;
  const tmp = document.createElement("canvas");
  const tctx = tmp.getContext("2d")!;
  let cols = 1, rows = 1, cw = 0, ch = 0, count = 0, filled = 0;

  const layout = (n: number, aspect = 1) => {
    count = Math.max(1, n);
    cols = Math.ceil(Math.sqrt(count));
    rows = Math.ceil(count / cols);
    const cellW = 96;                                   // px per thumb cell
    cw = cellW; ch = Math.round(cellW / aspect);
    canvas.width = cols * cw; canvas.height = rows * ch;
    ctx.fillStyle = "#0b0e14"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  return {
    setCount(n) { layout(n); },
    thumb(n, w, h, rgba) {
      if (!count || cols * rows < count) layout(Math.max(count, n), w / h);
      if (ch !== Math.round(cw / (w / h))) { ch = Math.round(cw / (w / h)); canvas.height = rows * ch; ctx.fillStyle = "#0b0e14"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
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
    done() { wrap.style.opacity = "0"; setTimeout(() => wrap.remove(), 400); },
    reset() {
      filled = 0; count = 0;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      preview_.style.display = "none";
      canvas.style.cssText = TILES_FULL + TILES_CSS;
      wrap.style.opacity = "1";
      if (!wrap.isConnected) host.appendChild(wrap);
    },
  };
}
