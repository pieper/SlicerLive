// Types for the vendored WGSL graph executor (wgpu-net.js — see that file's header).
export const U: number;
export function f32tof16(x: number): number;
export function f16tof32(h: number): number;
export function toF16(a: ArrayLike<number>): Uint16Array;
export function fromF16(u: Uint16Array): Float32Array;
export function initDevice(): Promise<{ dev: GPUDevice; info: object; hasF16: boolean }>;
export function genConv(TM: number, TN: number, silu?: boolean, kb?: object | null): string;

export type Dtype = "f16" | "f32";
export interface Runner {
  pipe(src: string): GPUComputePipeline;
  uni(arr: number[]): GPUBuffer;
  pass(enc: GPUCommandEncoder, src: string, bufs: GPUBuffer[], wg: number[]): void;
  grid(n: number): { gx: number; wg: number[] };
}
export function makeRunner(dev: GPUDevice, dtype?: Dtype): Runner;

export interface GraphSpec {
  inputs: { name: string; shape: number[] }[];
  outputs: { name: string; shape: number[] }[];
  tensors: Record<string, number[]>;
  nodes: Record<string, unknown>[];
  weights: Record<string, { offset: number; numel: number; shape: number[] }>;
}

export class Net {
  constructor(dev: GPUDevice, R: Runner, dtype?: Dtype);
  graph: GraphSpec;
  load(graphUrl: string, weightsUrl: string): Promise<Net>;
  setInputBuffer(name: string, buf: GPUBuffer): void;
  setInputData(name: string, f32: Float32Array): void;
  run(): void;
  outBufFor(name: string): GPUBuffer;
  read(name: string): Promise<Float32Array>;
  setConvConfig(TM: number, TN: number): void;
  autotuneConv(candidates?: [number, number][], reps?: number):
    Promise<{ TM: number; TN: number; ms: number; verified: number; tried: number }>;
  graphHash(): string;
  autotune(
    gpuKey?: string,
    opts?: { candidates?: [number, number][]; reps?: number; force?: boolean; cachedOnly?: boolean },
  ): Promise<
    {
      TM: number; TN: number; ms?: number; cached: boolean; skipped?: boolean;
      key: string; verified?: number; tried?: number; error?: string;
    }
  >;
}
