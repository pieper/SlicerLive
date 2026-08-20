//! LiveRenderer encode sidecar: a long-lived process that turns RGBA patches into AV1 intra frames
//! on the GPU, spoken to over a Unix socket by the (Deno) render server.
//!
//!   liverender-sidecar <socket-path>
//!
//! Framing (both directions, little-endian), one request → one reply, in order:
//!   request : u16 w · u16 h · u16 qp · u8 bgR · u8 bgG · u8 bgB · u32 rgba_len · rgba[rgba_len]
//!   reply   : u32 av1_len · av1[av1_len]     (av1_len == 0 ⇒ encode error; server falls back)
//!
//! One connection at a time is expected (the render server holds it for its lifetime); a dropped
//! connection just waits for the next. Encode is ~0.05 ms, so a synchronous loop is ample.
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};

use anyhow::Result;
use liverender_encode::Av1Encoder;

fn read_exact(s: &mut UnixStream, buf: &mut [u8]) -> std::io::Result<()> {
    s.read_exact(buf)
}

fn serve(mut stream: UnixStream, enc: &mut Av1Encoder) -> Result<()> {
    let mut hdr = [0u8; 13];
    loop {
        if read_exact(&mut stream, &mut hdr).is_err() {
            return Ok(()); // peer closed
        }
        let w = u16::from_le_bytes([hdr[0], hdr[1]]) as u32;
        let h = u16::from_le_bytes([hdr[2], hdr[3]]) as u32;
        let qp = u16::from_le_bytes([hdr[4], hdr[5]]) as u32;
        let bg = [hdr[6], hdr[7], hdr[8]];
        let len = u32::from_le_bytes([hdr[9], hdr[10], hdr[11], hdr[12]]) as usize;
        let mut rgba = vec![0u8; len];
        read_exact(&mut stream, &mut rgba)?;

        let reply = match enc.encode(&rgba, w, h, qp, bg) {
            Ok(av1) => av1,
            Err(e) => {
                eprintln!("[sidecar] encode {w}x{h} failed: {e:#}");
                Vec::new()
            }
        };
        stream.write_all(&(reply.len() as u32).to_le_bytes())?;
        stream.write_all(&reply)?;
        stream.flush()?;
    }
}

fn main() -> Result<()> {
    let path = std::env::args().nth(1).expect("usage: sidecar <socket-path>");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    let mut enc = Av1Encoder::new(0)?;
    eprintln!("[sidecar] AV1 encoder ready, listening on {path}");
    // Signal readiness on stdout so the parent can wait for it deterministically.
    println!("READY");
    std::io::stdout().flush().ok();
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                if let Err(e) = serve(stream, &mut enc) {
                    eprintln!("[sidecar] connection ended: {e:#}");
                }
            }
            Err(e) => eprintln!("[sidecar] accept: {e:#}"),
        }
    }
    Ok(())
}
