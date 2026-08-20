//! Hardware frame encoding for the LiveRenderer.
//!
//! The transport ships independent intra frames (each patch is its own image — that is what keeps
//! every frame droppable and preemptable), so the encoder of interest is an *intra-only* hardware
//! encoder. The NVENC engine on the L4 (Ada) does AV1 intra at ~0.05 ms/frame; the same engine is
//! reachable via `VK_KHR_video_encode_av1` once the Vulkan Video tooling matures — it will slot in
//! behind the same interface.

pub mod encoder;
pub mod synth;

pub use encoder::Av1Encoder;
