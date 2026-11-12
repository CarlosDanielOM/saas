//! Bot runtime metrics (`metrics:bot:*`, flushed every `BOT_METRICS_INTERVAL_MS`, default 30 s) and
//! product events. Package **P4-BOT-INGRESS** fills this module; it is empty until then.
//!
//! TypeScript it ports (baseline `0c71108e`), with the exports other packages call, which are the
//! public entry points the plan promises:
//!
//! - `utils/observability/bot_runtime_metrics.ts` (516 lines): `endMessageHandlerMetric`,
//!   `recordRedisOpsEstimate`, `recordSemanticMemoryMetric`, `recordStreamMemoryActionMetric`,
//!   `recordStreamMemoryJobMetric`, `recordThreadRoutingMetric`, `startBotRuntimeMetricsLoop`,
//!   `startMessageHandlerMetric`
//! - `utils/posthog_events.ts` (177 lines): `identifyStreamer`, `trackAiOperation`,
//!   `trackAiUsageRecorded`, `trackCommand`, `trackTts`
//!
//! Both files are loaded by every process in the reference; recorders the API or the cron call land
//! where those processes can reach them (open question in the P4-SKEL report).
