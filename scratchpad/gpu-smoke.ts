const gpu = (navigator as any).gpu;
if(!gpu){ console.log("NO navigator.gpu"); Deno.exit(1); }
const ad = await gpu.requestAdapter({ powerPreference:"high-performance" });
if(!ad){ console.log("NO adapter"); Deno.exit(1); }
const dev = await ad.requestDevice();
console.log("adapter OK. features:", [...ad.features].join(","));
// trivial compute: add 1 to a buffer
const N=8; const data=new Float32Array([0,1,2,3,4,5,6,7]);
const buf=dev.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
dev.queue.writeBuffer(buf,0,data);
const mod=dev.createShaderModule({code:`@group(0) @binding(0) var<storage,read_write> d:array<f32>; @compute @workgroup_size(8) fn main(@builtin(global_invocation_id) g:vec3u){ d[g.x]=d[g.x]+1.0; }`});
const pipe=dev.createComputePipeline({layout:"auto",compute:{module:mod,entryPoint:"main"}});
const bg=dev.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:buf}}]});
const enc=dev.createCommandEncoder(); const pass=enc.beginComputePass(); pass.setPipeline(pipe); pass.setBindGroup(0,bg); pass.dispatchWorkgroups(1); pass.end();
const rb=dev.createBuffer({size:data.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
enc.copyBufferToBuffer(buf,0,rb,0,data.byteLength); dev.queue.submit([enc.finish()]);
await rb.mapAsync(GPUMapMode.READ); const out=new Float32Array(rb.getMappedRange().slice(0));
console.log("compute result:", [...out].join(","), "(expect 1..8)");
