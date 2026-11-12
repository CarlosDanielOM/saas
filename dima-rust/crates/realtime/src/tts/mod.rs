//! The TTS queue: types, initialisation, status, queueing requests and processing the next one
//! (synthesis, the credit fallback, `speech` emissions, usage records, files under
//! `public/speech`). Package **P4-RT-TTS-A** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `handlers/tts_queue.handler.ts` (lines 1–713, 662 of 1281): `ttsQueueHandler`

pub mod playback;
