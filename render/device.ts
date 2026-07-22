// WebGPU device init — identical in the browser and in Deno (same navigator.gpu).
// Requests float32-filterable so scalar volumes can be r32float 3D textures
// sampled with a filtering (trilinear) sampler.

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  features: Set<string>;
}

export async function initDevice(): Promise<Gpu> {
  const gpu = (navigator as unknown as { gpu?: GPU }).gpu;
  if (!gpu) throw new Error("WebGPU not available (need Chrome/Edge/Safari or Deno --unstable-webgpu)");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter");
  const want = ["float32-filterable"].filter((f) => adapter.features.has(f)) as GPUFeatureName[];
  const device = await adapter.requestDevice({ requiredFeatures: want });
  return { adapter, device, features: new Set(want) };
}
