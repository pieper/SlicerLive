// Small GPU texture helpers shared across fields/renderers.
import type { Vec3 } from "./mat4.ts";

/** r32float 3D texture from a scalar volume (z-major: idx = (z*dy+y)*dx+x). */
export function createScalarTexture(dev: GPUDevice, data: Float32Array, dims: Vec3): GPUTexture {
  const [dx, dy, dz] = dims;
  const tex = dev.createTexture({ size: [dx, dy, dz], dimension: "3d", format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  dev.queue.writeTexture({ texture: tex }, data, { bytesPerRow: dx * 4, rowsPerImage: dy }, [dx, dy, dz]);
  return tex;
}
