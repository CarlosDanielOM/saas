//! Speech preparation and provider clients. No environment reads or filesystem output.
//! The frozen reference is `dimabot/src/utils/tts` and `server/services/tts`.
//! Queue playback and usage accounting remain the responsibility of the caller.
#![forbid(unsafe_code)]
pub mod catalog;
pub mod credit_fallback;
pub mod deadline;
pub mod normalize;
pub mod playback_timeout;
pub mod providers;
pub mod session;
pub mod speech_id;
pub mod tags;
