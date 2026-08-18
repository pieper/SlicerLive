/** Range decoder + adaptive context model for the progressive fine tier.
 *
 *  A direct transcription of src/livecodec/rangecoder.py and the context in
 *  scripts/pack_staged.py. Encoder and decoder must agree on every symbol, so
 *  anything "tidied up" here desynchronises the stream: the 64-bit `low` on the
 *  encoder side is why the decoder discards a priming byte, and the frequency
 *  update, the halving threshold and the neighbour quantisation must match term
 *  for term. livecodec-range.test.ts checks this against vectors the Python
 *  side produced.
 */

const TOP = 1 << 24;

export class RangeDecoder {
  private pos = 0;
  private range = 0xFFFFFFFF;
  private code = 0;

  constructor(private readonly buf: Uint8Array) {
    this.byte();                                   // encoder's priming byte
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
  }

  private byte(): number {
    return this.pos < this.buf.length ? this.buf[this.pos++] : 0;
  }

  /** `cums` holds K+1 cumulative frequencies; returns the decoded symbol. */
  decode(cums: Int32Array, K: number): number {
    const tot = cums[K];
    const r = Math.floor(this.range / tot);
    let v = Math.floor(this.code / r);
    if (v > tot - 1) v = tot - 1;
    let s = 0;
    while (cums[s + 1] <= v) s++;
    this.code = (this.code - r * cums[s]) >>> 0;
    this.range = r * (cums[s + 1] - cums[s]);
    while (this.range < TOP) {
      this.code = ((this.code * 256) + this.byte()) >>> 0;
      this.range = (this.range * 256) >>> 0;
    }
    return s;
  }
}

/** One frequency table per context. The increment, the ceiling and the halving
 *  rule are load-bearing: they define the probabilities, so they mirror
 *  AdaptiveModel in rangecoder.py rather than being tuned here. */
export class AdaptiveModel {
  readonly freq: Int32Array;
  readonly cums: Int32Array;
  private readonly K: number;
  private readonly inc = 24;
  private readonly limit = 1 << 13;

  constructor(nCtx: number, K: number) {
    this.K = K;
    this.freq = new Int32Array(nCtx * K).fill(1);
    this.cums = new Int32Array(K + 1);
  }

  cumsFor(c: number): Int32Array {
    const base = c * this.K;
    this.cums[0] = 0;
    for (let i = 0; i < this.K; i++) this.cums[i + 1] = this.cums[i] + this.freq[base + i];
    return this.cums;
  }

  update(c: number, s: number): void {
    const base = c * this.K;
    this.freq[base + s] += this.inc;
    let tot = 0;
    for (let i = 0; i < this.K; i++) tot += this.freq[base + i];
    if (tot > this.limit) {
      for (let i = 0; i < this.K; i++) this.freq[base + i] = (this.freq[base + i] + 1) >> 1;
    }
  }
}

export const NBR = 4;      // neighbour quantisation classes; matches pack_staged.py

export interface StageIndex { parts: number[]; buckets: number[]; nbr: number }

/** Decode one stage for one channel, refining `prevQ` in place into the finer
 *  bucket grid. Every context term is causal in C-order, so the context of each
 *  site is available from what has already been reconstructed. */
export function decodeStage(
  buf: Uint8Array, prevQ: Int32Array, prevN: number, q: number,
  K: number, dims: [number, number, number, number],
): Int32Array {
  const [C, D, H, W] = dims;
  const dec = new RangeDecoder(buf);
  const model = new AdaptiveModel(NBR * NBR * NBR * NBR, K);
  const out = new Int32Array(prevQ.length);
  const sc = (a: number) => Math.floor((a * NBR) / Math.max(1, q));
  const hereScale = Math.max(1, prevN);
  const HW = H * W, DHW = D * HW;
  for (let k = 0; k < C; k++) {
    for (let z = 0; z < D; z++) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = k * DHW + z * HW + y * W + x;
          const left = x ? sc(out[i - 1]) : 0;
          const up = y ? sc(out[i - W]) : 0;
          const pz = z ? sc(out[i - HW]) : 0;
          const here = Math.floor((prevQ[i] * NBR) / hereScale);
          const c = ((here * NBR + left) * NBR + up) * NBR + pz;
          const s = dec.decode(model.cumsFor(c), K);
          model.update(c, s);
          out[i] = Math.floor((prevQ[i] * q) / hereScale) + s;
        }
      }
    }
  }
  return out;
}

/** Bucket index -> the code value the FSQ dequantiser expects. A stage that has
 *  not reached full resolution knows only an interval, so it reconstructs at the
 *  interval centre, which is what makes an early stage renderable at all. */
export function bucketsToCodes(q: Int32Array, nBuckets: number, levels: number): Float32Array {
  const out = new Float32Array(q.length);
  const w = levels / nBuckets;
  for (let i = 0; i < q.length; i++) {
    out[i] = nBuckets >= levels ? q[i] : Math.min(levels - 1, (q[i] + 0.5) * w - 0.5);
  }
  return out;
}
