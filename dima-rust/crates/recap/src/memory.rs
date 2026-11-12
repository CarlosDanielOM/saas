//! The stream memory workflow per finished stream: summary, memories, the email, usage events,
//! durable job states. Package **P4-RECAP-B** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/ai/memory/stream_memory_runner.ts` (784 lines): `runStreamMemoryWorkflow`
//! - `utils/ai/memory/stream_memory_apply.ts` (320 lines)
//!
//! The durable job consumer that runs it is the cron's (P4-CRON-RECAP).
