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
    feature = "ast-syntax"
))]
pub mod js_compat;

#[cfg(feature = "mongo")]
pub mod bson_compat;
#[cfg(feature = "mongo")]
pub mod utc_time;
#[cfg(any(feature = "mongo", feature = "cron-supervisor"))]
pub mod worker_process;

#[cfg(feature = "ast-syntax")]
pub mod ast_syntax;

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
#[cfg(feature = "keywords")]
pub mod keywords;
#[cfg(feature = "polar-client")]
pub mod polar;
#[cfg(feature = "twitch-client")]
pub mod twitch;

#[cfg(feature = "chat-message")]
pub mod chat_message;
#[cfg(feature = "credential-crypto")]
pub mod credential_crypto;
#[cfg(feature = "credit-policy")]
pub mod credit_policy;
#[cfg(feature = "cron-queue")]
pub mod cron_queue;
#[cfg(feature = "permissions")]
pub mod permissions;
#[cfg(feature = "timer-policy")]
pub mod timer_policy;
#[cfg(feature = "twitch-tokens")]
pub mod twitch_tokens;

#[cfg(feature = "audio")]
pub mod audio;
#[cfg(feature = "http")]
pub mod cors;
#[cfg(feature = "email")]
pub mod email;
#[cfg(feature = "jwt")]
pub mod jwt;
#[cfg(feature = "mongo")]
pub mod mongo;
#[cfg(feature = "otel")]
pub mod otel;
#[cfg(feature = "posthog")]
pub mod posthog;
#[cfg(feature = "qdrant")]
pub mod qdrant;
#[cfg(feature = "re2-compat")]
pub mod re2_compat;
#[cfg(feature = "redis")]
pub mod redis;
#[cfg(feature = "s3")]
pub mod s3;
#[cfg(feature = "socketio")]
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
