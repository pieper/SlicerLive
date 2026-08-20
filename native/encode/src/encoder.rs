//! Reusable NVENC AV1-intra encoder for the LiveRenderer sidecar.
//!
//! Each encoded patch is an INDEPENDENT intra frame (gopLength 1, no inter prediction) — that is
//! what keeps every frame of the transport droppable and preemptable. NVENC sessions are fixed
//! size and patches vary, so sessions are cached in a small LRU keyed by the (even-rounded) patch
//! size; during a drag the size is stable, so the working set is one or two entries.
use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use cudarc::driver::CudaContext;
use nvidia_video_codec_sdk::{
    sys::nvEncodeAPI::{
        NV_ENC_BUFFER_FORMAT, NV_ENC_CODEC_AV1_GUID, NV_ENC_PARAMS_RC_MODE, NV_ENC_PIC_TYPE,
        NV_ENC_PRESET_P4_GUID, NV_ENC_QP, NV_ENC_TUNING_INFO,
    },
    EncodePictureParams, Encoder as NvEncoder, EncoderInitParams, EncoderInput, ErrorKind, Session,
};

/// A live NVENC session plus its input/output buffers, for one coded size.
///
/// Self-referential: the buffers borrow `&session.encoder`. `session` is BOXED so its heap address
/// is stable when this struct moves (the driver state lives behind a pointer inside `Encoder`, so
/// only the borrow's target address matters). Field order = DROP order: buffers first, box last —
/// the buffers must release before the session they borrow.
struct Sized {
    input: nvidia_video_codec_sdk::Buffer<'static>,
    output: nvidia_video_codec_sdk::Bitstream<'static>,
    _session: Box<Session>,
    pitch: usize,
    used: u64,
}

pub struct Av1Encoder {
    ctx: Arc<CudaContext>,
    sessions: HashMap<(u32, u32), Sized>,
    tick: u64,
    max_sessions: usize,
}

impl Av1Encoder {
    pub fn new(device: usize) -> Result<Self> {
        let ctx = CudaContext::new(device).context("CUDA context (is libcuda injected?)")?;
        // Confirm AV1 is present up front so a missing capability fails at startup, not mid-stream.
        let enc = NvEncoder::initialize_with_cuda(ctx.clone())?;
        anyhow::ensure!(
            enc.get_encode_guids()?.contains(&NV_ENC_CODEC_AV1_GUID),
            "GPU has no AV1 encode"
        );
        Ok(Self { ctx, sessions: HashMap::new(), tick: 0, max_sessions: 24 })
    }

    fn make(&self, w: u32, h: u32, qp: u32) -> Result<Sized> {
        // start_session consumes the Encoder; a fresh one per session is cheap.
        let enc = NvEncoder::initialize_with_cuda(self.ctx.clone())?;
        let mut preset = enc.get_preset_config(
            NV_ENC_CODEC_AV1_GUID,
            NV_ENC_PRESET_P4_GUID,
            NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
        )?;
        let cfg = &mut preset.presetCfg;
        cfg.gopLength = 1;
        cfg.frameIntervalP = 0;
        cfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_MODE::NV_ENC_PARAMS_RC_CONSTQP;
        cfg.rcParams.constQP = NV_ENC_QP { qpInterP: qp, qpInterB: qp, qpIntra: qp };
        cfg.encodeCodecConfig.av1Config.idrPeriod = 1;
        let mut init = EncoderInitParams::new(NV_ENC_CODEC_AV1_GUID, w, h);
        init.preset_guid(NV_ENC_PRESET_P4_GUID)
            .tuning_info(NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY)
            .encode_config(cfg)
            .display_aspect_ratio(w, h)
            .framerate(30, 1);
        // The Session and its buffers borrow the Encoder; we keep them together for the encoder's
        // lifetime, so transmute the borrows to 'static (sound: they never outlive `session`).
        let session: Box<Session> = Box::new(enc.start_session(NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_ABGR, init)?);
        // Borrow the boxed session's encoder; the borrows are valid for as long as the Box lives
        // and we never move out of it (we do not) — so extend them to 'static.
        let input = session.create_input_buffer()?;
        let output = session.create_output_bitstream()?;
        let pitch = (input.pitch() as usize).max(w as usize * 4);
        let input = unsafe { std::mem::transmute::<_, nvidia_video_codec_sdk::Buffer<'static>>(input) };
        let output = unsafe { std::mem::transmute::<_, nvidia_video_codec_sdk::Bitstream<'static>>(output) };
        Ok(Sized { _session: session, input, output, pitch, used: 0 })
    }

    /// Encode one PREMULTIPLIED-RGBA patch (tight rows, w*h*4 bytes) to an AV1 intra bitstream,
    /// compositing over `bg` first (AV1 carries no alpha). `bg` is linear 0..255 RGB.
    pub fn encode(&mut self, rgba: &[u8], w: u32, h: u32, qp: u32, bg: [u8; 3]) -> Result<Vec<u8>> {
        // NVENC wants even dimensions; round UP and let the extra column/row be edge padding.
        let cw = (w + 1) & !1;
        let ch = (h + 1) & !1;
        self.tick += 1;
        let tick = self.tick;

        if self.sessions.len() >= self.max_sessions && !self.sessions.contains_key(&(cw, ch)) {
            if let Some((&k, _)) = self.sessions.iter().min_by_key(|(_, s)| s.used) {
                self.sessions.remove(&k);
            }
        }
        if !self.sessions.contains_key(&(cw, ch)) {
            let s = self.make(cw, ch, qp)?;
            self.sessions.insert((cw, ch), s);
        }
        let s = self.sessions.get_mut(&(cw, ch)).unwrap();
        s.used = tick;

        // Pack the patch into the pitched, possibly-larger coded buffer, compositing each
        // premultiplied sample over the background to opaque ABGR. The autovectorizer turns this
        // tight per-pixel loop into SIMD on the host's widest ISA (AVX-512 on the Modal L4), which
        // is why the whole crate is built with -C target-cpu=native. Edge columns/rows are
        // replicated so the (0..1 px) even-rounding padding shows no seam to the encoder.
        let row = w as usize * 4;
        let mut buf = vec![0u8; s.pitch * ch as usize];
        for y in 0..h as usize {
            let src = &rgba[y * row..y * row + row];
            let dst = &mut buf[y * s.pitch..y * s.pitch + cw as usize * 4];
            for x in 0..w as usize {
                let p = &src[x * 4..x * 4 + 4];
                let a = p[3] as u32;
                let ia = 255 - a;
                // premultiplied over bg: out = src + bg*(1-a); ABGR byte order in the buffer,
                // sample bytes are r,g,b,a → write b,g,r,a wait: input is RGBA, NVENC ABGR wants
                // byte0=A? No — ABGR format = bytes [A,B,G,R]? NVENC ABGR is 0xAABBGGRR little =
                // memory R,G,B,A. So our RGBA maps 1:1. Composite each colour channel.
                dst[x * 4] = (p[0] as u32 + bg[0] as u32 * ia / 255).min(255) as u8;       // R
                dst[x * 4 + 1] = (p[1] as u32 + bg[1] as u32 * ia / 255).min(255) as u8;   // G
                dst[x * 4 + 2] = (p[2] as u32 + bg[2] as u32 * ia / 255).min(255) as u8;   // B
                dst[x * 4 + 3] = 255;                                                       // opaque
            }
            // replicate the last real column across the even-rounding pad
            for x in w as usize..cw as usize {
                let (a, b) = (x * 4, (w as usize - 1) * 4);
                dst.copy_within(b..b + 4, a);
            }
        }
        for y in h as usize..ch as usize {
            let (prev, cur) = buf.split_at_mut(y * s.pitch);
            cur[..s.pitch].copy_from_slice(&prev[(h as usize - 1) * s.pitch..(h as usize - 1) * s.pitch + s.pitch]);
        }

        unsafe { s.input.lock()?.write(&buf) };
        loop {
            match s._session.encode_picture(
                &mut s.input,
                &mut s.output,
                EncodePictureParams {
                    picture_type: NV_ENC_PIC_TYPE::NV_ENC_PIC_TYPE_IDR,
                    ..Default::default()
                },
            ) {
                Ok(()) => break,
                Err(e) if e.kind() == ErrorKind::EncoderBusy => {
                    std::thread::sleep(std::time::Duration::from_micros(150))
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(s.output.lock()?.data().to_vec())
    }
}
