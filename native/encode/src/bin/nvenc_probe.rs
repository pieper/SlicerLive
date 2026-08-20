//! Does NVENC AV1 *intra-only* encoding work on this host, and what does it cost?
//! For each patch size × preset × QP: upload → encode → readback (ms each) and the bitstream size.
//! Run ON the GPU host (links the driver's libnvidia-encode): see native/modal_build.py.
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use cudarc::driver::CudaContext;
use nvidia_video_codec_sdk::{
    sys::nvEncodeAPI::{
        NV_ENC_BUFFER_FORMAT, NV_ENC_CODEC_AV1_GUID, NV_ENC_PARAMS_RC_MODE, NV_ENC_PIC_TYPE,
        NV_ENC_PRESET_P1_GUID, NV_ENC_PRESET_P4_GUID, NV_ENC_QP, NV_ENC_TUNING_INFO,
    },
    EncodePictureParams, Encoder, EncoderInitParams, EncoderInput, ErrorKind,
};

fn main() {
    if let Err(e) = run() {
        eprintln!("ERROR: {e:#}");
        std::process::exit(1);
    }
}

/// One size/preset/QP measurement.
fn measure(ctx: &std::sync::Arc<CudaContext>, w: u32, h: u32, preset: nvidia_video_codec_sdk::sys::nvEncodeAPI::GUID, qp: u32, label: &str) -> Result<()> {
    // start_session consumes the Encoder, so one per session (opening one is cheap).
    let encoder = Encoder::initialize_with_cuda(ctx.clone())?;
    let mut preset_cfg = encoder.get_preset_config(
        NV_ENC_CODEC_AV1_GUID,
        preset,
        NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
    )?;
    let cfg = &mut preset_cfg.presetCfg;
    // INTRA ONLY: every frame a key frame — no inter prediction, no reorder, no lookahead. This is
    // what makes every encoded patch independent, hence droppable and preemptable.
    cfg.gopLength = 1;
    cfg.frameIntervalP = 0;
    cfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_MODE::NV_ENC_PARAMS_RC_CONSTQP;
    cfg.rcParams.constQP = NV_ENC_QP { qpInterP: qp, qpInterB: qp, qpIntra: qp };
    cfg.encodeCodecConfig.av1Config.idrPeriod = 1;

    let mut init = EncoderInitParams::new(NV_ENC_CODEC_AV1_GUID, w, h);
    init.preset_guid(preset)
        .tuning_info(NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY)
        .encode_config(cfg)
        .framerate(30, 1);
    let session = encoder
        .start_session(NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_ABGR, init)
        .with_context(|| format!("start_session {w}x{h}"))?;
    let mut input = session.create_input_buffer()?;
    let mut output = session.create_output_bitstream()?;

    let row = w as usize * 4;
    let pitch = (input.pitch() as usize).max(row);
    let frame = liverender_encode::synth::volume_like(w as usize, h as usize, 7);
    // The input buffer is pitched; always build exactly pitch*h bytes so the write stays in bounds.
    let pitched: Vec<u8> = if pitch == row {
        frame
    } else {
        let mut p = vec![0u8; pitch * h as usize];
        for y in 0..h as usize {
            p[y * pitch..y * pitch + row].copy_from_slice(&frame[y * row..(y + 1) * row]);
        }
        p
    };

    let (mut up, mut enc, mut rd, mut bytes) = (0f64, 0f64, 0f64, 0usize);
    const N: usize = 8;
    for i in 0..N {
        let t0 = Instant::now();
        unsafe { input.lock()?.write(&pitched) };
        let t1 = Instant::now();
        loop {
            match session.encode_picture(
                &mut input,
                &mut output,
                EncodePictureParams {
                    input_timestamp: i as u64,
                    picture_type: NV_ENC_PIC_TYPE::NV_ENC_PIC_TYPE_IDR,
                    ..Default::default()
                },
            ) {
                Ok(()) => break,
                Err(e) if e.kind() == ErrorKind::EncoderBusy => std::thread::sleep(Duration::from_micros(200)),
                Err(e) => return Err(e.into()),
            }
        }
        let t2 = Instant::now();
        let n = output.lock()?.data().len();
        let t3 = Instant::now();
        if i > 1 {
            // skip the first two (session warm-up)
            up += (t1 - t0).as_secs_f64() * 1e3;
            enc += (t2 - t1).as_secs_f64() * 1e3;
            rd += (t3 - t2).as_secs_f64() * 1e3;
            bytes = n;
        }
    }
    let k = (N - 2) as f64;
    println!(
        "{w}x{h} {label} qp{qp}: upload {:.2} · encode {:.2} · readback {:.2} ms · {} kB ({:.3} B/px; raw {} kB, {:.0}x)",
        up / k, enc / k, rd / k, bytes / 1000, bytes as f64 / (w * h) as f64,
        (w * h * 4) / 1000, (w * h * 4) as f64 / bytes.max(1) as f64
    );
    Ok(())
}

fn run() -> Result<()> {
    let ctx = CudaContext::new(0).context("CUDA context (is libcuda injected?)")?;
    let encoder = Encoder::initialize_with_cuda(ctx.clone()).context("NVENC open session")?;
    let guids = encoder.get_encode_guids()?;
    let av1 = guids.contains(&NV_ENC_CODEC_AV1_GUID);
    println!("nvenc codecs: {} · AV1={}", guids.len(), av1);
    if !av1 {
        return Err(anyhow!("no AV1 encode on this GPU"));
    }
    println!("AV1 input formats include ABGR (our sample format, no color-convert needed)\n");

    for (w, h) in [(1024u32, 1024u32), (1920, 1088), (3840, 2160)] {
        for (label, preset) in [("P1", NV_ENC_PRESET_P1_GUID), ("P4", NV_ENC_PRESET_P4_GUID)] {
            for qp in [20u32, 28, 40] {
                if let Err(e) = measure(&ctx, w, h, preset, qp, label) {
                    println!("{w}x{h} {label} qp{qp}: FAILED — {e:#}");
                }
            }
        }
    }
    Ok(())
}
