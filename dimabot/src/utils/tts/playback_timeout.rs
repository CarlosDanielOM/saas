//! File-backed equivalent of tts_playback_timeout.util.ts. Blocking I/O.
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::{Arc, OnceLock},
};
use tokio::sync::Semaphore;

pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const PLAYBACK_GRACE_MS: u64 = 30_000;

pub fn audio_file_duration_ms(path: &Path) -> u64 {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase);
    let seconds = match extension.as_deref() {
        Some("wav") => wav_duration(path),
        Some("mp3") => mp3_duration(path),
        _ => None,
    };
    match seconds {
        Some(value) if value.is_finite() && value > 0.0 => (value * 1000.0).ceil() as u64,
        _ => 0,
    }
}
pub fn tts_playback_timeout_ms(path: &Path) -> u64 {
    DEFAULT_TIMEOUT_MS.max(audio_file_duration_ms(path).saturating_add(PLAYBACK_GRACE_MS))
}

/// Nonblocking entrypoint for async callers. At most four scans run at once;
/// cancellation does not release a permit until the blocking scan finishes.
pub async fn audio_file_duration_ms_async(path: &Path) -> u64 {
    static ADMISSION: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let admission = ADMISSION
        .get_or_init(|| Arc::new(Semaphore::new(4)))
        .clone();
    let Ok(permit) = admission.acquire_owned().await else {
        return 0;
    };
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        audio_file_duration_ms(&path)
    })
    .await
    .unwrap_or(0)
}

pub async fn tts_playback_timeout_ms_async(path: &Path) -> u64 {
    DEFAULT_TIMEOUT_MS.max(
        audio_file_duration_ms_async(path)
            .await
            .saturating_add(PLAYBACK_GRACE_MS),
    )
}
fn wav_duration(path: &Path) -> Option<f64> {
    let mut header = [0; 44];
    File::open(path).ok()?.read_exact(&mut header).ok()?;
    // Buffer.toString('ascii') clears the high bit on each byte.
    let ascii_eq = |bytes: &[u8], expected: &[u8]| {
        bytes
            .iter()
            .zip(expected)
            .all(|(byte, expected)| byte & 0x7f == *expected)
    };
    if !ascii_eq(&header[0..4], b"RIFF")
        || !ascii_eq(&header[8..12], b"WAVE")
        || !ascii_eq(&header[36..40], b"data")
    {
        return None;
    }
    let rate = u32::from_le_bytes(header[28..32].try_into().ok()?);
    let length = u32::from_le_bytes(header[40..44].try_into().ok()?);
    (rate > 0).then(|| f64::from(length) / f64::from(rate))
}

// mp3-duration 1.1.0 scans ten-byte headers, counts even incomplete final
// frames, skips ID3v2/ID3v1, then rounds accumulated seconds to milliseconds.
fn mp3_duration(path: &Path) -> Option<f64> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let mut initial = [0; 100];
    if file.read_exact(&mut initial).is_err() {
        return Some(0.0);
    }
    let mut offset = 0u64;
    if &initial[..3] == b"ID3" && initial[6..10].iter().all(|b| b & 0x80 == 0) {
        offset = 10
            + initial[6..10]
                .iter()
                .fold(0u64, |acc, b| (acc << 7) | u64::from(*b))
            + if initial[5] & 0x10 != 0 { 10 } else { 0 };
    }
    let mut duration = 0.0;
    let mut header = [0; 10];
    while offset < size {
        file.seek(SeekFrom::Start(offset)).ok()?;
        if file.read_exact(&mut header).is_err() {
            break;
        }
        if header[0] == 0xff && header[1] & 0xe0 == 0xe0 {
            if let Some((length, samples, rate)) = frame(&header) {
                offset += length;
                duration += samples / rate;
                continue;
            }
        } else if &header[..3] == b"TAG" {
            offset += 128;
            continue;
        }
        offset += 1;
    }
    Some((duration * 1000.0_f64).round() / 1000.0)
}
fn frame(h: &[u8; 10]) -> Option<(u64, f64, f64)> {
    let version = (h[1] >> 3) & 3;
    let layer = (h[1] >> 1) & 3;
    let rate_idx = usize::from((h[2] >> 2) & 3);
    let bit_idx = usize::from(h[2] >> 4);
    if version == 1 || layer == 0 || rate_idx == 3 {
        return None;
    }
    let rates = match version {
        3 => [44100, 48000, 32000],
        2 => [22050, 24000, 16000],
        _ => [11025, 12000, 8000],
    };
    let sample_rate = rates[rate_idx] as f64;
    let bitrates = match (version == 3, layer) {
        (true, 3) => [
            0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
        ],
        (true, 2) => [
            0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
        ],
        (true, _) => [
            0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
        ],
        (false, 3) => [
            0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
        ],
        (false, _) => [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    };
    let samples = if layer == 3 {
        384.0
    } else if layer == 1 && version != 3 {
        576.0
    } else {
        1152.0
    };
    let padding = f64::from((h[2] >> 1) & 1);
    // mp3-duration maps free/reserved bitrate indices to zero but still
    // counts a header when its padding yields a positive frame length.
    let bitrate = bitrates.get(bit_idx).copied().unwrap_or(0);
    // The package stores layer as a string, so its strict comparison to the
    // number 1 never selects the four-byte Layer I padding branch.
    let length = (samples * f64::from(bitrate) * 125.0 / sample_rate + padding) as u64;
    (length > 0).then_some((length, samples, sample_rate))
}
