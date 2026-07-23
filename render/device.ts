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

  // Real medical volumes are large: CTACardio is 512x512x321 -> a 336 MB r32float
  // texture, whose writeTexture staging buffer exceeds Chrome's DEFAULT maxBufferSize
  // (256 MB). Deno/wgpu defaults higher, which is why headless never hit this. Raise the
  // size-related limits to the adapter's maximum so large single volumes upload and bind.
  const lim = adapter.limits;
  const requiredLimits: Record<string, number> = {};
  const raise = (k: keyof GPUSupportedLimits) => {
    const v = lim[k] as number | undefined;
    if (typeof v === "number") requiredLimits[k] = v;
  };
  raise("maxBufferSize");
  raise("maxStorageBufferBindingSize");
  raise("maxTextureDimension3D");

  const device = await adapter.requestDevice({ requiredFeatures: want, requiredLimits });
  return { adapter, device, features: new Set(want) };
}
