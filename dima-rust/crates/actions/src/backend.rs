//! The bot and the cron's side of the request surface to the API process:
//! `dima_twitch::functions::chats::speech::BackendApi` over internal HTTP (`INTERNAL_API_URL`) and
//! `dima_twitch::functions::clips::ClipPublisher` over Dragonfly pub/sub. Package **P4-ACT-MEDIA**
//! fills this module; it is empty until then.
//!
//! No TypeScript file of its own: the reference calls `fetch` and `pubSubManager.publish` inline in
//! `control_tts.chat.ts`, `speech.chat.ts`, `overlay.functions.ts` and the clip functions. Calls
//! stay HTTP in the first cut (lead's decision on plan question 9). The API implements the same
//! traits in process (`dima-realtime::backend`).
