//! Recovery window: minimum 60 seconds, otherwise rounded duration plus 30 seconds.
//! Parses bounded WAV/MP3 buffers; filesystem loading belongs to the later audio owner.
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

/// Buffer variant of mp3-duration 1.2.0 (the reference dependency), without its optional
/// CBR estimate. ID3v2/ID3v1 tags and corrupt bytes are skipped as in the original.
/// Work is bounded by the audio byte limit; callers should use spawn_blocking for large files.
pub fn mp3_duration_ms(audio: &[u8]) -> u64 {
    if audio.len() < 100 {
        return 0;
    }
    let mut offset = 0usize;
    if audio.starts_with(b"ID3")
        && audio
            .get(6..10)
            .is_some_and(|s| s.iter().all(|b| b & 0x80 == 0))
    {
        offset = 10 + if audio[5] & 0x10 != 0 { 10 } else { 0 };
        for (n, b) in audio[6..10].iter().enumerate() {
            offset += usize::from(*b) << (7 * (3 - n));
        }
    }
    let mut seconds = 0.0;
    while let Some(h) = audio.get(offset..offset.saturating_add(10)) {
        if h[0] == 0xff && h[1] & 0xe0 == 0xe0 {
            let version = (h[1] >> 3) & 3;
            let layer = (h[1] >> 1) & 3;
            let idx = usize::from(h[2] >> 4);
            let rates: [u32; 15] = match (version, layer) {
                (3, 3) => [
                    0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
                ],
                (3, 2) => [
                    0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
                ],
                (3, 1) => [
                    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
                ],
                (0 | 2, 3) => [
                    0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
                ],
                (0 | 2, 1 | 2) => [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
                _ => [0; 15],
            };
            let rate = rates.get(idx).copied().unwrap_or(0);
            let frequencies = match version {
                3 => [44100u32, 48000, 32000],
                2 => [22050, 24000, 16000],
                0 => [11025, 12000, 8000],
                _ => [0; 3],
            };
            let frequency = frequencies
                .get(usize::from((h[2] >> 2) & 3))
                .copied()
                .unwrap_or(0);
            let samples = match (version, layer) {
                (1, _) | (_, 0) => 0,
                (_, 3) => 384,
                (_, 2) | (3, 1) => 1152,
                _ => 576,
            };
            if rate > 0 && frequency > 0 && samples > 0 {
                let pad = u32::from((h[2] >> 1) & 1) * if layer == 3 { 4 } else { 1 };
                let size = (f64::from(samples) * f64::from(rate) * 125.0 / f64::from(frequency)
                    + f64::from(pad)) as usize;
                if size > 0 {
                    offset = offset.saturating_add(size);
                    seconds += f64::from(samples) / f64::from(frequency);
                    continue;
                }
            }
        } else if h.starts_with(b"TAG") {
            offset = offset.saturating_add(128);
            continue;
        }
        offset = offset.saturating_add(1);
    }
    // mp3-duration first rounds to nearest ms; the wrapper then ceils seconds*1000.
    duration_ms(dima_text::math_round(seconds * 1000.0) / 1000.0)
}
/// The extension is supplied by the audio owner; unknown/invalid audio uses the 60s default.
pub fn audio_playback_timeout_ms(extension: &str, audio: &[u8]) -> u64 {
    let ms = match dima_text::to_lower(extension).as_str() {
        ".wav" => wav_duration_ms(audio),
        ".mp3" => mp3_duration_ms(audio),
        _ => 0,
    };
    playback_timeout_ms(ms)
}
