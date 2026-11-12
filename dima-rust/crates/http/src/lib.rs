//! The one outbound HTTP stack of the backend.
//!
//! Every outside service (Twitch, OpenRouter, Polar, Resend, PostHog, Fish Audio, S3, Qdrant, our
//! own sidecars) gets a thin client in its feature crate built on this one, so timeouts, retries,
//! limits, telemetry and test mocking are solved here once. No vendor SDKs.
//!
//! - [`HttpClient`]: one shared connection pool (rustls with ring, HTTP/1.1, gzip/brotli/deflate
//!   accepted and decoded as Node's `fetch` does), no proxy variables, no automatic redirects or
//!   retries underneath.
//! - [`Provider`]: one outside service: telemetry name, base URL (overridable by configuration,
//!   which is how the rig points everything at local mocks), default headers, timeouts, body
//!   limit, retry policy, redirect handling, concurrency cap. [`ProviderRegistry`] holds them.
//! - [`RequestBuilder`]: built against a provider with a [`Path`] template, so feature crates
//!   never concatenate hosts and telemetry never sees ids. JSON, JavaScript-exact JSON, exact
//!   bytes, forms and streamed bodies.
//! - [`Response`]: every read has a byte limit (over it is an error, not a cut), an idle timeout,
//!   the total deadline and shutdown; bodies as bytes, text, JSON, a writer, chunks, or
//!   [`SseStream`].
//! - [`RetryPolicy`]: one configurable policy (statuses, failures, backoff, jitter from
//!   [`dima_core::Random`], `Retry-After` / `retry-after-ms` / `Ratelimit-Reset`, attempt and time
//!   bounds, idempotency), including the reference's Helix 401 refresh via [`Credential`].
//! - [`Error`]: one typed error that never prints credentials.
//! - [`guard`]: the guarded client for user-supplied URLs (SSRF protection).
//! - [`observe`]: the telemetry seam.
//! - `testing` (feature `test-util`): a loopback recorder server for other crates' tests.
//!
//! **Defaults** (see the constants in [`provider`]): 60 s per attempt, 10 s to connect, 30 s idle
//! between body chunks, 8 MiB body, redirects are an error, no retries.
//!
//! **Example**: declare a provider, send JSON with a retry policy, read an event stream, fetch a
//! user-supplied URL.
//!
//! ```no_run
//! use dima_http::guard::{GuardPolicy, GuardedClient};
//! use dima_http::{HttpClient, Path, Provider, ProviderRegistry, RetryPolicy};
//! use std::time::Duration;
//!
//! # async fn demo() -> Result<(), Box<dyn std::error::Error>> {
//! let shutdown = dima_core::Shutdown::new();
//! let key = dima_core::SecretString::from("sk-or-...");
//!
//! // At startup: the binary declares its providers and applies configuration overrides.
//! let registry = ProviderRegistry::builder()
//!     .provider(
//!         Provider::builder("openrouter", "https://openrouter.ai/api/v1")
//!             .secret_header("authorization", &dima_core::SecretString::new(format!("Bearer {}", key.expose())))
//!             .header("x-openrouter-title", "DomDimaBot")
//!             .timeout(Duration::from_secs(30))
//!             .retry(RetryPolicy::fetch_with_retry(&[
//!                 Duration::from_secs(1),
//!                 Duration::from_secs(3),
//!                 Duration::from_secs(5),
//!             ])),
//!     )
//!     .base_url_override("openrouter", "http://127.0.0.1:18080") // the rig's mock
//!     .build()?;
//! let client = HttpClient::builder().shutdown(shutdown.clone()).build()?;
//! let openrouter = registry.get("openrouter")?;
//!
//! // A JSON request with the provider's retry policy.
//! #[derive(serde::Deserialize)]
//! struct Embeddings { data: Vec<serde_json::Value> }
//! let embeddings: Embeddings = client
//!     .post(openrouter, "/embeddings")
//!     .json(&serde_json::json!({ "model": "qwen/qwen3-embedding-8b", "input": "hola" }))
//!     .send_json()
//!     .await?;
//!
//! // A streamed answer: headers within 60 s, then at most 120 s between chunks.
//! let mut stream = client
//!     .post(openrouter, "/chat/completions")
//!     .json(&serde_json::json!({ "model": "m", "stream": true, "messages": [] }))
//!     .retry(RetryPolicy::none())
//!     .headers_timeout(Duration::from_secs(60))
//!     .idle_timeout(Duration::from_secs(120))
//!     .timeout(Duration::from_secs(600))
//!     .send()
//!     .await?
//!     .error_for_status()
//!     .await?
//!     .sse();
//! while let Some(event) = stream.next_event().await {
//!     let event = event?;
//!     if event.data == "[DONE]" { break; }
//! }
//!
//! // A path with ids: the template is what telemetry and errors show.
//! let path = Path::template("/generation/{}", &["gen-123"])?;
//! let _ = client.get(openrouter, path).send().await?;
//!
//! // A user-supplied URL.
//! let media = GuardedClient::new(
//!     GuardPolicy::https_hosts(["cdn.streamelements.com", "static.streamelements.com"]),
//!     shutdown.clone(),
//! )?;
//! let image = media
//!     .get("https://cdn.streamelements.com/uploads/a.png")
//!     .max_bytes(50 * 1024 * 1024)
//!     .timeout(Duration::from_secs(120))
//!     .send()
//!     .await?
//!     .error_for_status()
//!     .await?
//!     .bytes()
//!     .await?;
//! # let _ = (embeddings.data, image);
//! # Ok(())
//! # }
//! ```
//!
//! Rules for everything in this workspace are in `dima-rust/MIGRATION.md`.
#![forbid(unsafe_code)]
#![warn(missing_docs)]

mod client;
mod error;
pub mod guard;
pub mod observe;
mod path;
pub mod provider;
mod redact;
mod response;
pub mod retry;
pub mod sse;
#[cfg(feature = "test-util")]
pub mod testing;

pub use client::{Credential, HttpClient, HttpClientBuilder, Refresh, RequestBuilder};
pub use error::{
    BlockReason, BoxError, Error, FailureClass, RequestInfo, Result, StatusError, TimeoutKind,
};
pub use path::{Path, PathError};
pub use provider::{ConfigError, Provider, ProviderBuilder, ProviderRegistry, Redirects};
pub use response::Response;
pub use retry::RetryPolicy;
pub use sse::{SseEvent, SseStream};

/// Re-exported so callers name headers and methods without another dependency.
pub use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
/// The streamed request body type ([`RequestBuilder::body_stream`]).
pub use reqwest::Body as StreamBody;
