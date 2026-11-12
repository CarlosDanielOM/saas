//! TTS playback: the pet and read heads, capacity, playback reports, end, control, recovery after a
//! restart, cleanup, and read TTS. Package **P4-RT-TTS-B** fills this module; it is empty until
//! then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `handlers/tts_queue.handler.ts` (lines 714–end, 619 of 1281): `ttsQueueHandler`
//! - `pets/read_tts.ts` (445 lines): `reconcileReadTtsStartup`, `startReadTts`
