//! Synthetic RGBA test frames that compress like a volume rendering: smooth shaded structure, a
//! dark background, thin bright filaments and a little high-frequency texture (the shading noise
//! of a ray-marched render) — far more honest than a flat colour for sizing bitstreams.

/// Fill `w×h` RGBA8 (tight rows).
pub fn volume_like(w: usize, h: usize, seed: u32) -> Vec<u8> {
    let mut out = vec![0u8; w * h * 4];
    let cx = w as f32 * 0.5;
    let cy = h as f32 * 0.5;
    let r0 = (w.min(h) as f32) * 0.35;
    let mut s = seed.wrapping_mul(747796405).wrapping_add(2891336453);
    for y in 0..h {
        for x in 0..w {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let d = (dx * dx + dy * dy).sqrt();
            // shaded blob
            let mut v = ((r0 - d) / (r0 * 0.4)).clamp(0.0, 1.0);
            let shade = 0.55 + 0.45 * ((dx * 0.7 - dy * 0.5) / r0).clamp(-1.0, 1.0);
            // filaments
            let f = ((x as f32 * 0.11 + (y as f32 * 0.03).sin() * 9.0).sin() * 40.0).abs();
            let fil = if f < 1.5 && d < r0 * 1.6 { 0.9 } else { 0.0 };
            // xorshift texture
            s ^= s << 13; s ^= s >> 17; s ^= s << 5;
            let n = ((s & 0xff) as f32 / 255.0 - 0.5) * 0.08;
            v = (v * shade + n).max(fil);
            let i = (y * w + x) * 4;
            let bg = [13u8, 15, 23];
            let col = [0.95f32, 0.72, 0.55];
            for c in 0..3 {
                out[i + c] = (bg[c] as f32 * (1.0 - v) + 255.0 * col[c] * v).round().clamp(0.0, 255.0) as u8;
            }
            out[i + 3] = 255;
        }
    }
    out
}
