//! The pet runtime and its sockets, mouth curves from audio (CPU work on `spawn_blocking`: 2
//! active, 8 queued, 5 s), and the TTS envelope. Package **P4-RT-PETS** fills this module; it is
//! empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `pets/runtime.ts` (465 lines): `MAX_PET_AUDIO_BYTES`, `assetUrls`, `getPetRuntime`
//! - `pets/socket.ts` (293 lines): `registerPetSockets`
//! - `pets/mouth_analysis.ts` (89 lines)
//! - `pets/mouth_curves.ts` (71 lines)
//! - `pets/mouth_curves.worker.ts` (12 lines)
//! - `pets/tts_envelope.ts` (59 lines): `inspectTtsAudio`, `ttsEnvelope`
