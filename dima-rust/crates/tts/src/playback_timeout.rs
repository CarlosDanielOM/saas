//! Recovery window: minimum 60 seconds, otherwise rounded duration plus 30 seconds.
//! File parsing belongs to the later audio owner; this module accepts its measured seconds.
pub fn duration_ms(seconds: f64) -> u64 {
    if seconds.is_finite() && seconds > 0.0 {
        (seconds * 1000.0).ceil() as u64
    } else {
        0
    }
}
pub fn playback_timeout_ms(duration_ms: u64) -> u64 {
    60_000.max(duration_ms.saturating_add(30_000))
}
/// The reference accepts only a canonical 44-byte RIFF/WAVE header with data at offset 36.
pub fn wav_duration_ms(bytes: &[u8]) -> u64 {
    if bytes.len() < 44
        || bytes.get(0..4) != Some(b"RIFF")
        || bytes.get(8..12) != Some(b"WAVE")
        || bytes.get(36..40) != Some(b"data")
    {
        return 0;
    }
    let read = |i| {
        bytes
            .get(i..i + 4)
            .and_then(|s| <[u8; 4]>::try_from(s).ok())
            .map(u32::from_le_bytes)
            .unwrap_or(0)
    };
    let rate = read(28);
    if rate == 0 {
        0
    } else {
        duration_ms(f64::from(read(40)) / f64::from(rate))
    }
}
