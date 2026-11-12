//! The desktop AI runtime: turns with 15 s leases, speech activity, `speech:prepare` with a 2 s
//! acknowledgement, recovery (5 s) and heartbeats (15 s). Package **P4-RT-DESKTOP** fills this
//! module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `desktop_ai/activity.ts` (326 lines): `confirmRetiredSpeechActivity`, `extendSpeechActivity`,
//!   `finishMatchingSpeechActivity`, `finishSpeechActivity`, `hasSafeDesktopPetStop`,
//!   `prepareSpeechActivity`, `registerDesktopSpeechActivity`, `retireMatchingSpeechActivity`,
//!   `startSpeechActivity`
//! - `desktop_ai/execution.ts` (215 lines)
//! - `desktop_ai/service.ts` (427 lines): `cancelSpeech`, `cancelTurn`, `claimAudio`, `getTurn`,
//!   `speechEvent`, `startDesktopAiRuntime`, `submitTurn`
