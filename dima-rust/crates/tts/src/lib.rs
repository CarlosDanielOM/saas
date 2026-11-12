//! Speech preparation and provider clients. No environment reads or filesystem output.
//! The frozen reference is `dimabot/src/utils/tts` and `server/services/tts`.
//! Queue playback and usage accounting remain the responsibility of the caller.
//! # Contract notes and integration boundaries
//!
//! Counts: message maxLength, catalogue name (200), description (300), sample text (400),
//! search name (100), and speech id length are Unicode scalars. All money/provider counts use
//! `normalize::billable_characters` (UTF-16 units, exactly JS length). Twitch ranges are inclusive
//! UTF-16 offsets converted to byte boundaries. MessagePack/audio sizes are bytes; ids and tags
//! use ASCII validation. Catalogue pagination (20 items, at most 50 pages), six style tags,
//! 100 cache entries, eight CAS attempts and cleanup batches of 128 are item counts.
//!
//! Reuse: text helpers, core secrets/clock/randomness, store deadlines and scripts, billing plan
//! tiers, model settings/enumerations and Twitch channel catalogue. No Mongo writes are needed
//! here: favourites/settings persistence and voice alias lookup belong to settings/route owners
//! and must use dima-model's existing collection read/write APIs. No usage writer is defined:
//! the later queue owns accounting; this package supplies the billable count only.
//!
//! Timeouts: OpenRouter 20s, Fish 20s including retries and body, Piper 30s, catalogue 12s,
//! global emotes 3s, store handle's configured response deadline (default 5s). The composed
//! default queue operation adds a generous 60s deadline where the reference had none. Fish
//! retries 408/429/5xx twice, 1s then 2s +/-10%, Retry-After honoured within its 20s deadline.
//! No scheduling sleeps are added. Global emote cache TTLs are 3600/60s; voice cache 60s.
//!
//! Intentional differences: valid UTF-8 at cuts; 32MiB audio bound, 2MiB catalogue/global JSON,
//! 64KiB Piper errors, 20,000 global emotes, 4096 id characters; paid error bodies are suppressed
//! to prevent secret reflection. The Fish MessagePack fixed-map encoder is local because the
//! shared HTTP stack has no codec. Empty catalogue query calls are omitted because the shared
//! builder otherwise appends a question mark. No new external dependencies.
//!
//! Reference quirks retained: English attribution says `say`; no mention/repetition filtering;
//! angle cues may use an opening tag twice; unlicensed catalogue searches filter each page
//! locally; Piper accepts empty HTTP audio; lowercase Fish aliases are case sensitive. The
//! reference's Piper CLI fallback requires filesystem output and Python: this HTTP-only package
//! requires PIPER_HTTP_URL, and does not launch that sidecar. MP3/WAV durations accept buffers.
//! File paths/public URLs and deployment remain the later audio/overlay owner's responsibility.
//!
//! Streaming Fish primary is exposed separately; automatic failover must buffer a complete
//! attempt (`Clients::synthesize_buffered`) so a broken primary cannot leak partial audio into
//! the fallback. Consumers must finish a stream before booking usage or publishing audio.
#![forbid(unsafe_code)]
pub mod catalog;
pub mod credit_fallback;
pub mod deadline;
pub mod default_queue;
pub mod normalize;
pub mod playback_timeout;
pub mod providers;
pub mod session;
pub mod speech_id;
pub mod tags;

pub mod emote_names;
