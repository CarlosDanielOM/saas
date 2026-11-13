# Rust worker migration notes

This directory records historical Rust migrations and related library work. The seven cron responsibilities returned to TypeScript on 2026-11-13; see [typescript-workers-return.md](typescript-workers-return.md). The per-worker Rust records below are historical, not current deployment instructions.

| Migration | Status | Canonical record | Technical reference |
| --- | --- | --- | --- |
| TypeScript workers returned | Current source | [typescript-workers-return.md](typescript-workers-return.md) | [Cron workflow](../ops/README.md#cron-workers) |
| Stream activity | Historical | [stream-activity.md](stream-activity.md) | [Projector](../dima-rust/STREAM_ACTIVITY.md) |
| Raid analytics | Historical | [raid-change-driven.md](raid-change-driven.md) | [Original migration](raid-analytics.md) |
| Follow-defense baseline | Historical | [follow-defense-baseline.md](follow-defense-baseline.md) | |
| Roulette completion | Historical | [roulette-completion.md](roulette-completion.md) | |
| AI usage receipts | Historical | [ai-usage-receipts.md](ai-usage-receipts.md) | |
| TypeScript entrypoint retirement | Historical | [typescript-worker-retirement.md](typescript-worker-retirement.md) | [Archive](../archives/typescript-workers/2026-10-21/README.md) |
| Raid sessions | Historical | [raid-sessions.md](raid-sessions.md) | |
| Backlog scheduling | Historical | [worker-backlog-scheduling.md](worker-backlog-scheduling.md) | |
| Dashboard activity | Historical | [dashboard-activity.md](dashboard-activity.md) | |
| Shared Rust worker utilities | Historical | [worker-shared-utils.md](worker-shared-utils.md) | |
| Dual cron supervisors | Historical | [dual-cron-supervisors.md](dual-cron-supervisors.md) | |
| Permission core | Opt-in Rust library compile and parity verification passed; no live callers or production release. | [permission-core.md](permission-core.md) | 3,681 source-backed parity cases |
| AST syntax core | Pure `ast-syntax` contract finalized; 1,200-case corpus and 109 test executions passed. Compilation-only microbenchmark is mixed and does not establish production latency. No TypeScript caller wiring or deployment. | [ast-syntax-core.md](ast-syntax-core.md) | [Benchmark artifact](../dima-rust/benchmarks/ast-syntax-2026-10-25.json) |
| AST evaluator | Accepted utility-only scope: quality, benchmark, bounded R2 review, and cleanup receipts complete; 14/15 prepared medians were lower for Rust. No callers or evaluator deployment. | [ast-evaluator.md](ast-evaluator.md) | [Full 15-workload medians and receipts](../dima-rust/benchmarks/ast-evaluator-2026-10-25.json) |
| AST blocks core | Capped quality verification passed (163 test executions across repeated profiles); the same 467-case oracle passed in both profiles. Paired release benchmark had lower Rust medians in 19/21 operations; synthetic only, with no production-latency or single-optimization claim. No TypeScript caller integration or deployment. | [ast-blocks.md](ast-blocks.md) | [Benchmark artifact](../dima-rust/benchmarks/ast-blocks-2026-10-25.json) |
| AST pure functions | Accepted opt-in library scope: final source hashes, formatting/checks/Clippy, parity, three paired release runs, R2 review, and cleanup passed. Rust medians were lower in 19/30 synthetic workloads. ASCII casing shortcut was rejected and removed after failing its Unicode guard. No caller wiring or deployment. | [ast-pure-functions.md](ast-pure-functions.md) | [Final benchmark and acceptance artifact](../dima-rust/benchmarks/ast-pure-functions-2026-10-26.json) |
| TwitchStreamers Rust library | Accepted opt-in library: capped quality, source oracle, both profile suites, and disposable MongoDB/Dragonfly adapter fixtures passed. Whole-source parity follow-up passed 66 mocked differential scenarios and native race fixtures; no TypeScript caller or production adoption, and mixed-writer coordination remains required. | [twitch-streamers.md](twitch-streamers.md), [parity follow-up](twitch-streamers-parity.md) | [Rust API](../dima-rust/src/utils/twitch_streamers.rs) |
| TwitchStreamers pre-port review | Source-level risks and approved improvements; implementation and remaining adoption review are summarized in the linked migration record. | [twitch-streamers-pre-port-review.md](twitch-streamers-pre-port-review.md) | [Current TypeScript owner](../dimabot/src/classes/twitch_streamers.class.ts) |
| Cache and logger pre-port review | Logger and plan-cache utilities are accepted as opt-in library code; other cache recommendations remain unselected. No caller adoption or deployment. | [cache-logger-pre-port-review.md](cache-logger-pre-port-review.md) | [TypeScript cache protocol](../dimabot/src/utils/plan_cache_fence.ts) |
| Shared Rust logger utility | Opt-in core and Redis/OTEL adapters passed capped quality, 56-case source parity, adapter, and disposable-cache verification. No TypeScript caller adoption, worker-profile change, or deployment; logger is independent of plan-cache fencing. | [shared-logger.md](shared-logger.md) | [Rust logger API](../dima-rust/src/utils/logger.rs) |
| Plan-cache fence utility | Accepted opt-in library scope: capped quality and source parity plus 135 disposable Dragonfly scenarios. No caller adoption, worker-profile change, or deployment; mutation deadline expiry was not fault-injected. | [plan-cache-fence.md](plan-cache-fence.md) | [Rust API](../dima-rust/src/utils/plan_cache_fence.rs) |

TypeScript util foundations (library only, not deployed) are tracked separately in [ts-util-foundations.md](ts-util-foundations.md): approved crates, parity evidence, known differences, and the wrappers still to build.
