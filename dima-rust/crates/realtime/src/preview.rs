//! TTS voice previews (the 30 s preview lock). Package **P4-RT-SOCKETS** fills this module; it is
//! empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `server/services/tts/voice_preview.service.ts` (151 lines): `createPreviewTicket`
