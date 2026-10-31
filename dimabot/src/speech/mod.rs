//! Speech/TTS core: the speech API client, the default queue decisions, voice
//! preview, and session reset.
//!
//! Ported TypeScript sources (LANE A):
//!
//! * [`tts_client`] — `dimabot/src/functions/chats/speech.chat.ts` and its test
//!   `speech.chat.test.ts`.
//! * [`default_queue`] — `dimabot/src/utils/tts/queue_default_tts.util.ts`.
//! * [`voice_preview`] — `dimabot/src/server/services/tts/voice_preview.service.ts`.
//! * [`session_reset`] — `dimabot/src/utils/speech.ts` (`clearSpeechFiles` and
//!   `TTS_SESSION_ENDED`).
//!
//! Reuse relationships (all read-only here):
//!
//! * Text policy comes from [`crate::utils::tts`]: `normalize_tts_message_js`,
//!   `filter_expressive_tts_tags_js`, `extract_emote_names_js`,
//!   `build_spoken_user_message_js`, `resolve_kokoro_voice_str`, the provider /
//!   mode / language / source enums, and the pricing in
//!   [`crate::utils::tts_usage_pricing`].
//! * The Redis session queue is [`crate::utils::tts::session::TtsSession`]; this
//!   lane adds no second queue layout.
//! * Channel settings are decoded by
//!   [`crate::schemas::channel_tts_settings::get_channel_tts_settings`] (or
//!   `bson_to_settings_json` plus `normalize_channel_tts_settings` for a raw
//!   document), and emote names come from
//!   [`crate::utils::twitch_emotes::TwitchEmoteRuntime`].
//! * Billing reuses [`crate::utils::tts_usage::track_tts_usage`] and the credit
//!   balance reuses [`crate::utils::ai_credit_reader::get_ai_credits_default`].
//! * Preview synthesis reuses [`crate::tts_services::runtime::TtsRuntime`] and
//!   its provider implementations; nothing here re-creates a provider.
//!
//! Every collaborator is an injected concrete handle or a port with a concrete
//! production adapter in the same file. Constructors perform no I/O, read no
//! environment, and open no connection; only `create_preview_ticket` acquires
//! the process cache inside its async body, matching the source.
//!
//! The `socketio` feature adds
//! [`voice_preview::register_voice_preview`], which binds the
//! `/speech-preview/{channel}` namespace, its ticket middleware, the `preview`
//! event, the five-minute socket expiry and the 30 s lock renewal. Without that
//! feature the whole preview flow is still available as
//! [`voice_preview::handle_preview`] plus [`voice_preview::PreviewSession`].

#[cfg(feature = "speech-core")]
pub mod default_queue;
#[cfg(feature = "speech-core")]
pub mod session_reset;
#[cfg(feature = "speech-core")]
pub mod tts_client;
#[cfg(feature = "speech-core")]
pub mod voice_preview;
