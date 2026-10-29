//! Small shared utilities.
//!
//! Keep this module limited to narrow, reusable pieces rather than a generic
//! framework or a parallel data-access layer. Service foundations mirror the
//! TypeScript helpers in `dimabot/src/utils`; each is behind its own feature.
//!
//! Enable individual consolidated helpers or `bot-utils` for all six. Provider
//! transports use the separate `twitch-client` and `polar-client` features.
//! These opt-in APIs do not register workers or install production adapters.
//!
//! ```
//! # #[cfg(all(feature = "keywords", feature = "eventsub"))] {
//! use dima_rust::utils::{eventsub, keywords};
//! let entries = [keywords::KeywordEntry {
//!     id: "greeting".into(), text: "hello".into(),
//!     match_mode: keywords::KeywordMatchMode::Anywhere,
//! }];
//! let index = keywords::compile_keyword_index(entries);
//! assert_eq!(keywords::match_keywords(&index, "Hello world").len(), 1);
//! let condition = eventsub::Condition::from([("broadcaster_user_id", "123")]);
//! assert_eq!(eventsub::subscription_key("channel.follow", "2", &condition),
//!     "channel.follow:2:{\"broadcaster_user_id\":\"123\"}");
//! # }
//! ```

#[cfg(any(
    feature = "mongo",
    feature = "cron-supervisor",
    feature = "bot-utils",
    feature = "keywords",
    feature = "chat-events",
    feature = "ai-usage",
    feature = "eventsub",
    feature = "domain-events",
    feature = "chat-message",
    feature = "timer-policy",
    feature = "credit-policy",
    feature = "permissions",
    feature = "cron-queue",
    feature = "twitch-client",
    feature = "qdrant",
    feature = "ast-syntax",
    feature = "reward-body",
    feature = "tts-utilities"
))]
pub mod js_compat;

#[cfg(any(
    feature = "credit-policy",
    feature = "ast-evaluator",
    feature = "reward-body",
    feature = "domain-events",
    feature = "application-schemas",
    feature = "bits-rules",
    feature = "tts-utilities"
))]
pub mod json_number;

pub mod links;
pub mod tts_defaults;

#[cfg(feature = "tts-services")]
#[path = "ai/openrouter/app_attribution.util.rs"]
pub mod openrouter_attribution;

#[cfg(feature = "eventsub")]
pub mod eventsub_bits_config;

#[cfg(feature = "reward-body")]
#[path = "twitch_reward_body.util.rs"]
pub mod twitch_reward_body;

#[cfg(feature = "mongo")]
pub mod bson_compat;
#[cfg(feature = "mongo")]
pub mod utc_time;
#[cfg(any(feature = "mongo", feature = "cron-supervisor"))]
pub mod worker_process;

#[cfg(feature = "ast-blocks")]
#[path = "ast_blocks/index.rs"]
pub mod ast_blocks;
#[cfg(feature = "ast-evaluator")]
#[path = "ast_parser/evaluator.rs"]
pub mod ast_evaluator;
#[cfg(feature = "ast-syntax")]
#[path = "ast_parser/syntax.rs"]
pub mod ast_syntax;

#[cfg(feature = "ai-credit-projection")]
pub mod ai_credit_projection;
#[cfg(feature = "ai-usage")]
pub mod ai_usage;
#[cfg(feature = "chat-events")]
pub mod chat_events;
#[cfg(feature = "command-utils")]
pub mod command_cooldown;
#[cfg(feature = "domain-events")]
pub mod domain_events;
#[cfg(feature = "eventsub")]
pub mod eventsub;
#[cfg(feature = "js-date")]
pub mod js_date;
#[cfg(feature = "tts-utilities")]
pub mod js_string;
#[cfg(feature = "keywords")]
pub mod keywords;
#[cfg(feature = "logger")]
pub mod logger;
#[cfg(feature = "tts-utilities")]
pub mod lossless_json;
#[cfg(feature = "application-schemas")]
pub mod mongoose_date;
#[cfg(feature = "observability")]
pub mod observability;
#[cfg(feature = "plan-cache")]
pub mod plan_cache_fence;
#[cfg(feature = "polar-client")]
#[path = "polarsh.rs"]
pub mod polar;
#[cfg(feature = "tts-utilities")]
pub mod tts;
#[cfg(any(feature = "credit-policy", feature = "tts-utilities"))]
#[path = "tts/usage.rs"]
pub mod tts_usage_pricing;
#[cfg(feature = "twitch-client")]
pub mod twitch;
#[cfg(feature = "twitch-emotes")]
pub mod twitch_emotes;

#[cfg(feature = "chat-message")]
pub mod chat_message;
#[cfg(feature = "credential-crypto")]
#[path = "crypto.rs"]
pub mod credential_crypto;
#[cfg(feature = "credit-policy")]
pub mod credit_policy;
#[cfg(feature = "cron-queue")]
#[path = "cron_jobs_queue.rs"]
pub mod cron_queue;
#[cfg(feature = "permissions")]
#[path = "permissions/index.rs"]
pub mod permissions;
#[cfg(feature = "timer-policy")]
pub mod timer_policy;
#[cfg(feature = "twitch-streamers")]
#[path = "../classes/twitch_streamers.class.rs"]
pub mod twitch_streamers;
#[cfg(feature = "twitch-tokens")]
#[path = "tokens.rs"]
pub mod twitch_tokens;

#[cfg(feature = "audio")]
pub mod audio;
#[cfg(feature = "http")]
pub mod cors;
#[cfg(feature = "email")]
#[path = "email/email.service.rs"]
pub mod email;
#[cfg(feature = "jwt")]
#[path = "email/email-activation-token.rs"]
pub mod jwt;
#[cfg(feature = "mongo")]
#[path = "databases/mongodb.database.rs"]
pub mod mongo;
#[cfg(feature = "otel")]
#[path = "opentelemetry_posthog.rs"]
pub mod otel;
#[cfg(feature = "posthog")]
#[path = "posthog_events.rs"]
pub mod posthog;
#[cfg(feature = "qdrant")]
#[path = "databases/qdrant.database.rs"]
pub mod qdrant;
#[cfg(feature = "re2-compat")]
pub mod re2_compat;
#[cfg(feature = "redis")]
#[path = "databases/dragonfly.database.rs"]
pub mod redis;
#[cfg(feature = "s3")]
pub mod s3;
#[cfg(feature = "socketio")]
#[path = "../server/websocket.rs"]
pub mod socketio;

#[cfg(all(
    test,
    any(
        feature = "email",
        feature = "posthog",
        feature = "s3",
        feature = "otel",
        feature = "twitch-client",
        feature = "polar-client"
    )
))]
pub(crate) mod test_http;

/// Public PostHog project key hard-coded in `posthog_events.ts` and
/// `opentelemetry_posthog.ts`. Project keys are write-only ingestion tokens
/// meant to be embedded in clients; this is not a secret.
#[cfg(any(feature = "posthog", feature = "otel"))]
pub const POSTHOG_PROJECT_KEY: &str = "phc_ApcLd2XbNHavPCcyD9fFDVHxs7cCBPozWmSBFTqugfP";

/// Installs ring as rustls's process-wide crypto provider.
///
/// `email`, `posthog`, `s3`, and `otel` pull crates that compile rustls with
/// aws-lc-rs as well as ring, so rustls can no longer choose a default and
/// `rustls::ClientConfig::builder()` panics. Their own HTTP clients and the
/// MongoDB driver pass a provider explicitly; Redis TLS and any other code
/// using the default do not. Call this once at startup in binaries that enable
/// these features; [`redis::get_redis_client`] also calls it. It keeps ring,
/// the provider the database clients already use, and is a no-op when a
/// default is already installed.
#[cfg(any(
    feature = "email",
    feature = "posthog",
    feature = "s3",
    feature = "otel"
))]
pub fn install_default_tls_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
