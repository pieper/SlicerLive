// Shared download-progress MOSAIC for IDC demos (DRY): while a DICOM series streams, lay out its
// slice thumbnails in a grid that fills in as they arrive (idc_tools onThumb/onSliceCount) — the
// popular loading visual from the old SEGRoulette. Overlays the view area; fades out when the scene
// is ready. Reusable by any demo that loads a slice-by-slice source.

export interface Mosaic {
  setCount(count: number): void;
  thumb(n: number, w: number, h: number, rgba: ArrayBuffer): void;
  status(msg: string): void;
  done(): void;              // fade out + remove
  reset(): void;             // clear for a new load
}

export function createMosaic(host: HTMLElement): Mosaic {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:absolute;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;" +
    "background:radial-gradient(60% 60% at 50% 45%,rgba(20,24,38,.35),rgba(6,8,14,.75));opacity:1;transition:opacity 350ms ease-out;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "max-width:min(70vmin,620px);max-height:70vh;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5);image-rendering:auto;";
  const cap = document.createElement("div");
  cap.style.cssText = "font:600 12px ui-monospace,Menlo,monospace;color:#9fe9ff;text-shadow:0 0 4px #000;";
  wrap.appendChild(canvas); wrap.appendChild(cap);
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
    done() { wrap.style.opacity = "0"; setTimeout(() => wrap.remove(), 400); },
    reset() { filled = 0; count = 0; ctx.clearRect(0, 0, canvas.width, canvas.height); wrap.style.opacity = "1"; if (!wrap.isConnected) host.appendChild(wrap); },
  };
}
