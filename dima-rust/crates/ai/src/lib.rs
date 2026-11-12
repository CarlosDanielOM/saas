//! AI clients, thread storage, and pure prompt, context, and memory rules.
//!
//! # Reference failure inventory
//!
//! `tests/client_faults.rs`, `tests/minimax.rs`, `tests/batcher.rs` supplement
//! the recorded request tests; faults use only `dima_http::testing::MockServer`.
//!
//! * LFM2 and OpenRouter: retry only HTTP 429/500/502/503/504 and thrown fetch
//!   failures (including connection errors and header timeout). Wait 1s/3s/5s,
//!   falling back to 5s for further configured retries. LFM2 defaults to two
//!   retries, 10s per attempt; OpenRouter three retries, 30s. Exhausted HTTP
//!   status returns an API-status error; exhausted transport errors, malformed
//!   JSON and truncated bodies return the single/batch fallback error. No body
//!   parsing retry. Neither has a reference overall deadline or caller signal:
//!   fetch.utils replaces the supplied signal. Rust future owners can cancel
//!   by dropping the future. Empty input returns an error before HTTP; OpenRouter
//!   additionally requires channel context. Provider error objects return an
//!   error; Rust deliberately redacts their messages (possible credentials).
//!   LFM2 distinguishes absent, empty/invalid vector and batch count mismatch;
//!   OpenRouter trusts batch count. LFM2 sorts indexes; OpenRouter keeps order.
//! * MiniMax: missing key is config failure (Rust rejects at provider build).
//!   SDK retries connections, timeouts, 408/409/429/all 5xx twice with exponential
//!   500ms/1s backoff scaled randomly by .75..1, honoring retry-after-ms or
//!   retry-after up to 60s and x-should-retry. Final 429 is rate_limited, 5xx
//!   overloaded, other 4xx bad_request, other errors upstream. Header timeout is
//!   60s/attempt; event idle watchdog 120s spans retries and resets on events.
//!   Malformed/truncated/unfinished streams fail upstream without retries;
//!   in-stream overloaded_error/rate_limit_error retain their classifications.
//!   Caller abort is aborted before headers or during a stream. Tool failures
//!   return tool_result errors to the model; caller abort still stops the call.
//! * Search: no status-specific handling, retry, reference timeout or caller
//!   signal. HTTP error JSON can succeed. A truthy error returns Search failed;
//!   absent/empty results succeed empty. Fetch, JSON and shape exceptions return
//!   the exception message. Rust redacts transport/parse diagnostics to fixed
//!   messages because upstream URLs/text can contain credentials. Added timeout
//!   is 60s, and cancellation is by dropping the owned future.
//! * Batcher: flush after 350ms or 500 messages; embedding error/missing vectors
//!   or any Qdrant upsert failure retries the entire batch three total times,
//!   re-embedding each time, waiting 1s then 2s. Exhaustion drops the whole batch;
//!   a single bad item is never treated as a successful partial batch. No caller
//!   cancellation/deadline exists in TypeScript; Rust shutdown drops owned work.
//!
//! Existing safety bounds: embedding count 500, queue 2000 (bursts split into
//! batches), HTTP bodies 8 MiB, MiniMax overall 30 minutes and tool/sink calls
//! 120s. Embedding body deadlines cover the full response rather than only
//! headers. These bound reference-unbounded work; no external calls occur in tests.
//! Timing tests use Tokio virtual time where practical, with loopback IO allowed
//! to settle between ticks; request count and 1s/3s/5s or 1s/2s waits are asserted.
#![forbid(unsafe_code)]
pub mod batcher;
pub mod embeddings;
pub mod language;
pub mod memory;
pub mod memory_store;
pub mod minimax;
pub mod prompts;
pub mod qdrant;
pub mod search;
pub mod summary;
pub mod threads;

// Integration notes: embedding batch sinks own the existing Qdrant upsert and use
// language::Detector when queued language is absent. This keeps src/qdrant intact.
// Provider errors deliberately do not echo raw embedding error messages; those can
// contain credentials. Summary schema diagnostics preserve reference text; JSON
// correction prompts deliberately use Rust diagnostics with position and a bounded
// excerpt; JavaScript runtime parser wording is not part of the migration contract.
