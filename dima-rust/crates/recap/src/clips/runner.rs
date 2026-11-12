//! The VOD clip recommendation workflow: download (yt-dlp), audio and candidate cuts (ffmpeg),
//! model passes, S3 uploads, usage and job states. Package **P4-RECAP-D** fills this module; it is
//! empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/ai/clip_recommendations/vod_clip_recommendation_runner.ts` (829 lines):
//!   `calculateClipRecommendationCredits`, `fetchLatestVodForChannel`, `fetchRecentVodsForChannel`,
//!   `fetchVodById`, `runVodClipRecommendationWorkflow`
