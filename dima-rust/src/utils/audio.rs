//! Audio durations for TTS playback recovery, mirroring
//! `dimabot/src/utils/tts/tts_playback_timeout.util.ts`.
//!
//! MP3 duration sums the duration of every MPEG audio packet that symphonia
//! demuxes (no decoding), replacing the npm `mp3-duration` frame scan. WAV
//! duration reads the same fixed 44-byte header as TypeScript and returns 0
//! for anything else. Any other extension, unreadable file, or parse failure
//! yields 0, and [`tts_playback_timeout_ms`] then falls back to 60 seconds.
//!
//! These functions do blocking file I/O; call them from `spawn_blocking` in
//! async code.

use std::{fs::File, io::Read, path::Path};

use symphonia::core::{
    formats::{FormatOptions, TrackType},
    io::MediaSourceStream,
    meta::MetadataOptions,
};

/// Recovery window used when the duration is unknown.
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// Extra time after the clip for the browser to fetch and acknowledge it.
pub const PLAYBACK_GRACE_MS: u64 = 30_000;

/// Duration in whole milliseconds, rounded up; 0 when unknown.
pub fn audio_file_duration_ms(path: &Path) -> u64 {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    let seconds = match extension.as_deref() {
        Some("mp3") => mp3_duration_seconds(path),
        Some("wav") => wav_duration_seconds(path),
        _ => None,
    };
    match seconds {
        Some(seconds) if seconds.is_finite() && seconds > 0.0 => (seconds * 1000.0).ceil() as u64,
        _ => 0,
    }
}

/// Same rule as `getTtsPlaybackTimeoutMs`.
pub fn tts_playback_timeout_ms(path: &Path) -> u64 {
    match audio_file_duration_ms(path) {
        0 => DEFAULT_TIMEOUT_MS,
        duration => DEFAULT_TIMEOUT_MS.max(duration + PLAYBACK_GRACE_MS),
    }
}

/// Sums MPEG audio packet durations; `None` when the file is not MP3.
pub fn mp3_duration_seconds(path: &Path) -> Option<f64> {
    let file = File::open(path).ok()?;
    let source = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = symphonia::core::formats::probe::Hint::new();
    hint.with_extension("mp3");
    let mut reader = symphonia::default::get_probe()
        .probe(
            &hint,
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .ok()?;
    let track = reader.default_track(TrackType::Audio)?;
    let track_id = track.id;
    let time_base = track.time_base?;

    let mut ticks: u64 = 0;
    while let Ok(Some(packet)) = reader.next_packet() {
        if packet.track_id == track_id {
            ticks = ticks.saturating_add(packet.dur.get());
        }
    }
    if ticks == 0 {
        return None;
    }
    Some(ticks as f64 * f64::from(time_base.numer.get()) / f64::from(time_base.denom.get()))
}

/// Reads the canonical 44-byte WAV header exactly like TypeScript.
pub fn wav_duration_seconds(path: &Path) -> Option<f64> {
    let mut header = [0u8; 44];
    File::open(path).ok()?.read_exact(&mut header).ok()?;
    wav_header_duration_seconds(&header)
}

fn wav_header_duration_seconds(header: &[u8; 44]) -> Option<f64> {
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" || &header[36..40] != b"data" {
        return Some(0.0);
    }
    let bytes_per_second = u32::from_le_bytes(header[28..32].try_into().ok()?);
    let data_bytes = u32::from_le_bytes(header[40..44].try_into().ok()?);
    Some(if bytes_per_second > 0 {
        f64::from(data_bytes) / f64::from(bytes_per_second)
    } else {
        0.0
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    struct TempFile(std::path::PathBuf);

    impl TempFile {
        fn new(name: &str, bytes: &[u8]) -> Self {
            let path =
                std::env::temp_dir().join(format!("dima-rust-audio-{}-{name}", std::process::id()));
            File::create(&path).unwrap().write_all(bytes).unwrap();
            Self(path)
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn wav(bytes_per_second: u32, data_bytes: u32) -> Vec<u8> {
        let mut header = Vec::with_capacity(44);
        header.extend_from_slice(b"RIFF");
        header.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        header.extend_from_slice(b"WAVEfmt ");
        header.extend_from_slice(&16u32.to_le_bytes());
        header.extend_from_slice(&1u16.to_le_bytes()); // PCM
        header.extend_from_slice(&1u16.to_le_bytes()); // mono
        header.extend_from_slice(&(bytes_per_second / 2).to_le_bytes()); // sample rate
        header.extend_from_slice(&bytes_per_second.to_le_bytes());
        header.extend_from_slice(&2u16.to_le_bytes()); // block align
        header.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        header.extend_from_slice(b"data");
        header.extend_from_slice(&data_bytes.to_le_bytes());
        header
    }

    /// MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, no padding: 417-byte frames of
    /// 1152 samples. The demuxer reads headers only, so zeroed bodies suffice.
    fn mp3(frames: usize) -> Vec<u8> {
        let mut frame = vec![0u8; 417];
        frame[..4].copy_from_slice(&[0xFF, 0xFB, 0x90, 0x64]);
        frame.repeat(frames)
    }

    #[test]
    fn wav_duration_matches_the_typescript_header_rule() {
        let file = TempFile::new("a.wav", &wav(44_100, 66_150));
        assert_eq!(audio_file_duration_ms(&file.0), 1_500);
        assert_eq!(tts_playback_timeout_ms(&file.0), 60_000);

        let long = TempFile::new("long.WAV", &wav(32_000, 32_000 * 45 + 1));
        assert_eq!(audio_file_duration_ms(&long.0), 45_001);
        assert_eq!(tts_playback_timeout_ms(&long.0), 75_001);
    }

    #[test]
    fn non_canonical_or_short_wav_headers_are_unknown() {
        let mut moved = wav(44_100, 44_100);
        moved[36..40].copy_from_slice(b"LIST");
        let file = TempFile::new("list.wav", &moved);
        assert_eq!(audio_file_duration_ms(&file.0), 0);
        let short = TempFile::new("short.wav", b"RIFF");
        assert_eq!(audio_file_duration_ms(&short.0), 0);
    }

    #[test]
    fn mp3_duration_sums_frames() {
        let frames = 100;
        let file = TempFile::new("a.mp3", &mp3(frames));
        let expected = (frames as f64 * 1152.0 / 44_100.0 * 1000.0).ceil() as u64;
        assert_eq!(audio_file_duration_ms(&file.0), expected);
    }

    #[test]
    fn unknown_inputs_fall_back_to_the_default_timeout() {
        let garbage = TempFile::new("bad.mp3", b"not audio at all");
        assert_eq!(audio_file_duration_ms(&garbage.0), 0);
        assert_eq!(tts_playback_timeout_ms(&garbage.0), DEFAULT_TIMEOUT_MS);
        let other = TempFile::new("a.ogg", &mp3(10));
        assert_eq!(audio_file_duration_ms(&other.0), 0);
        assert_eq!(
            tts_playback_timeout_ms(Path::new("/nonexistent/x.mp3")),
            DEFAULT_TIMEOUT_MS
        );
    }

    /// Opt-in parity against npm `mp3-duration` on real files: set
    /// `MP3_PARITY_CASES` to `path=seconds` pairs separated by `;`.
    /// npm counts the encoder's Xing/Info header frame as audio and symphonia
    /// does not, so Rust may be up to one frame (at most ~72 ms) shorter.
    #[test]
    #[ignore = "needs MP3_PARITY_CASES from npm mp3-duration"]
    fn mp3_duration_matches_npm_reference() {
        let cases = std::env::var("MP3_PARITY_CASES").expect("MP3_PARITY_CASES");
        for case in cases.split(';').filter(|case| !case.is_empty()) {
            let (path, seconds) = case.rsplit_once('=').unwrap();
            let reference: f64 = seconds.parse().unwrap();
            let rust = mp3_duration_seconds(Path::new(path)).expect("readable mp3");
            let difference = rust - reference;
            println!(
                "{path}: npm {reference:.3}s rust {rust:.3}s diff {:.1}ms",
                difference * 1000.0
            );
            assert!(
                (-0.073..=0.001).contains(&difference),
                "{path}: off by more than one frame"
            );
        }
    }
}
