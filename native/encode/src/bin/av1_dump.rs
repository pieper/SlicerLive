//! Encode ONE synthetic frame to NVENC AV1 intra and write the raw bitstream to a file, so the
//! browser seam (WebCodecs VideoDecoder 'av01') can be tested against real NVENC output. Also
//! prints the leading OBU types, since that determines what the decoder needs (sequence header
//! in-band vs. as a separate `description`).
use std::io::Write;

use anyhow::{Context, Result};
use cudarc::driver::CudaContext;
use nvidia_video_codec_sdk::{
    sys::nvEncodeAPI::{
        NV_ENC_BUFFER_FORMAT, NV_ENC_CODEC_AV1_GUID, NV_ENC_PARAMS_RC_MODE, NV_ENC_PIC_TYPE,
        NV_ENC_PRESET_P4_GUID, NV_ENC_QP, NV_ENC_TUNING_INFO,
    },
    EncodePictureParams, Encoder, EncoderInitParams, EncoderInput, ErrorKind,
};

fn main() -> Result<()> {
    let w = 512u32;
    let h = 512u32;
    let out_path = std::env::args().nth(1).unwrap_or_else(|| "/tmp/frame.av1".into());

    let ctx = CudaContext::new(0)?;
    let encoder = Encoder::initialize_with_cuda(ctx)?;
    let mut preset = encoder.get_preset_config(
        NV_ENC_CODEC_AV1_GUID, NV_ENC_PRESET_P4_GUID,
        NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY)?;
    let cfg = &mut preset.presetCfg;
    cfg.gopLength = 1;
    cfg.frameIntervalP = 0;
    cfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_MODE::NV_ENC_PARAMS_RC_CONSTQP;
    cfg.rcParams.constQP = NV_ENC_QP { qpInterP: 28, qpInterB: 28, qpIntra: 28 };
    cfg.encodeCodecConfig.av1Config.idrPeriod = 1;
    // AV1 render size = coded size (no cropping metadata needed at these dims).
    let mut init = EncoderInitParams::new(NV_ENC_CODEC_AV1_GUID, w, h);
    init.preset_guid(NV_ENC_PRESET_P4_GUID)
        .tuning_info(NV_ENC_TUNING_INFO::NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY)
        .encode_config(cfg)
        .display_aspect_ratio(w, h)
        .framerate(30, 1);
    let session = encoder
        .start_session(NV_ENC_BUFFER_FORMAT::NV_ENC_BUFFER_FORMAT_ABGR, init)
        .context("start_session")?;
    let mut input = session.create_input_buffer()?;
    let mut output = session.create_output_bitstream()?;

    let row = w as usize * 4;
    let pitch = (input.pitch() as usize).max(row);
    let frame = liverender_encode::synth::volume_like(w as usize, h as usize, 3);
    let pitched = if pitch == row { frame } else {
        let mut p = vec![0u8; pitch * h as usize];
        for y in 0..h as usize { p[y * pitch..y * pitch + row].copy_from_slice(&frame[y * row..(y + 1) * row]); }
        p
    };
    unsafe { input.lock()?.write(&pitched) };
    loop {
        match session.encode_picture(&mut input, &mut output, EncodePictureParams {
            picture_type: NV_ENC_PIC_TYPE::NV_ENC_PIC_TYPE_IDR, ..Default::default() }) {
            Ok(()) => break,
            Err(e) if e.kind() == ErrorKind::EncoderBusy => std::thread::sleep(std::time::Duration::from_micros(200)),
            Err(e) => return Err(e.into()),
        }
    }
    let lock = output.lock()?;
    let data = lock.data();
    std::fs::File::create(&out_path)?.write_all(data)?;

    // Walk the low-overhead OBU stream and report the header types (obu_type is bits 3..6 of byte 0).
    let mut i = 0usize;
    let mut kinds = Vec::new();
    while i < data.len() && kinds.len() < 8 {
        let b = data[i];
        let obu_type = (b >> 3) & 0xf;
        let has_size = (b >> 1) & 1;
        kinds.push(obu_type);
        if has_size == 0 { break; }
        // read leb128 size
        i += 1;
        if (b & 1) == 1 { i += 1; } // extension flag
        let mut size = 0u64; let mut shift = 0;
        loop { let x = data[i]; i += 1; size |= ((x & 0x7f) as u64) << shift; if x & 0x80 == 0 { break; } shift += 7; }
        i += size as usize;
    }
    println!("wrote {} bytes to {out_path} · leading OBU types {:?} (1=seqhdr 3=frame_hdr 6=frame 2=td)", data.len(), kinds);
    Ok(())
}
