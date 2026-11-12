//! AI clients, thread storage, and pure prompt, context, and memory rules.
#![forbid(unsafe_code)]
pub mod batcher;
pub mod embeddings;
pub mod language;
pub mod memory;
pub mod minimax;
pub mod prompts;
pub mod qdrant;
pub mod search;
pub mod summary;
pub mod threads;

// Integration notes: embedding batch sinks own the existing Qdrant upsert and use
// language::Detector when queued language is absent. This keeps src/qdrant intact.
// Provider errors deliberately do not echo raw embedding error messages; those can
// contain credentials. Summary schema diagnostics preserve reference text; non-EOF
// JSON syntax diagnostics retain serde wording (an integration parity limitation).
