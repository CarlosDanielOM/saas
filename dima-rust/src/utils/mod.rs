//! Small shared utilities.
//!
//! Keep this module limited to narrow, reusable pieces rather than a generic
//! framework or a parallel data-access layer. Service foundations mirror the
//! TypeScript helpers in `dimabot/src/utils`; each is behind its own feature.

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
        feature = "otel"
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
