//! The desktop AI model: the conversation and turn collections, turn input and turn updates.
//! Package **P4-FEAT-ASSETS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `desktop_ai/schema.ts` (34 lines): `DesktopAiConversation`, `DesktopAiTurn`
//! - `desktop_ai/updates.ts` (71 lines): `BOT_AUDIO_DELIVERY_MS`, `TURN_STATUS_FEATURE`,
//!   `changeTurn`, `notifyTurnUpdated`, `refreshPetTurnUpdates`, `subscribeTurnUpdates`,
//!   `turnWireRevision`, `updateTurn`
//! - `desktop_ai/input.ts` (31 lines): `isTurnId`, `parseTurnInput`, `truncateReply`,
//!   `turnFingerprint`
//!
//! The desktop AI runtime is `dima-realtime::desktop_ai` (P4-RT-DESKTOP).
