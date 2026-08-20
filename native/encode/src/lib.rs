//! Hardware frame encoding for the LiveRenderer.
//!
//! The transport ships independent intra frames (each patch is its own image — that is what keeps
//! every frame droppable and preemptable), so the encoder of interest is an *intra-only* hardware
//! encoder. The NVENC engine on the L4 (Ada) does AV1 intra at a few ms per 4K frame; the same
//! engine is reachable via `VK_KHR_video_encode_av1` (probed on 2026-08-20) once the Vulkan Video
//! tooling matures — it will slot in behind the same trait.

pub mod synth;
