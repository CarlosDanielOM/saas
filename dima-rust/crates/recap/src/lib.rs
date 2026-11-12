//! The cron's AI jobs over finished streams: stream summaries and their context, the stream
//! memory workflow (summary, memories, the email), and VOD clip recommendations (download, cuts,
//! model passes, previews, notifications).
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`; the plan for this
//! crate is `ledger/upper-layers.md` (layer 8 of section 2.3).
//!
//! # Dependencies, and why
//!
//! - `dima-ai`: model calls and channel memories.
//! - `dima-stream`: the finished stream's sessions and chat.
//! - `dima-billing`: every model call is charged usage.
//! - `dima-email`: the completion emails.
//! - `dima-platform`: S3 uploads and the media tools (yt-dlp, ffmpeg) of P2-PLATFORM-SVC-4.
//! - `dima-events`: the durable job intents the cron consumes.
//!
//! It needs neither the engine nor its host. The cron runs the jobs (P4-CRON-RECAP); the API
//! reads clip recommendations through [`clips`] (`dima-routes::data`). The bot does not link it.
//!
//! # Modules and the packages that fill them
//!
//! - [`summary`], by P4-RECAP-A (wave 1).
//! - [`memory`], by P4-RECAP-B (wave 2).
//! - [`clips`], by P4-RECAP-C (wave 1); [`clips::runner`]: P4-RECAP-D (wave 2).
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod clips;
pub mod memory;
pub mod summary;
