//! NOT YET PORTED — scheduled for lane E round 3.
//! Thumbnail constants from `thumbnail_generator.ts`.
//! Fetching, ffmpeg execution, upload and persistence remain unimplemented.

/// Target thumbnail width in pixels.
pub const THUMB_WIDTH: u32 = 480;
/// ffmpeg JPEG quality parameter.
pub const THUMB_JPEG_QUALITY: u32 = 5;
/// Maximum declared source size in bytes.
pub const MAX_INPUT_FETCH_BYTES: u64 = 200 * 1024 * 1024;

/// The initial decision before attempting thumbnail generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThumbnailDecision {
    /// Existing ready thumbnail needs no work.
    AlreadyReady,
    /// Audio assets should be marked skipped.
    SkipAudio,
    /// Increment attempts and generate a thumbnail.
    Generate,
}
/// Select the initial source decision; ready takes precedence over audio.
pub fn initial_decision(status: &str, has_asset: bool, media_type: &str) -> ThumbnailDecision {
    if status == "ready" && has_asset { ThumbnailDecision::AlreadyReady }
    else if media_type == "audio" { ThumbnailDecision::SkipAudio }
    else { ThumbnailDecision::Generate }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn ready_precedes_audio() { assert_eq!(initial_decision("ready", true, "audio"), ThumbnailDecision::AlreadyReady); }
    #[test] fn skip_audio() { assert_eq!(initial_decision("failed", false, "audio"), ThumbnailDecision::SkipAudio); }
    #[test] fn ready_without_asset_generates() { assert_eq!(initial_decision("ready", false, "video"), ThumbnailDecision::Generate); }
}
