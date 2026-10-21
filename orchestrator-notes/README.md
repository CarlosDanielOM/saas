# Orchestrator model notes

Use this file to keep concise, evidence-based observations that help choose models for future work. Read it before substantive delegation. Update it after a meaningful verified outcome or useful user feedback. These notes support the live orchestrator capability catalog; they do not replace it. Always check that catalog for current providers, exact model identifiers, effort options, and delegation support. Do not treat any identifier or option recorded here as permanent truth.

## Starting preferences

The user's current ascending capability coding tier is a user-provided starting preference:

1. GPT-6 Luna
2. MiniMax M3.1 Flash
3. DeepSeek V4.1 Flash
4. Grok 4.7
5. GPT-6.1 Sol
6. GPT-6 Astra

On 2026-10-20, the user expanded the original five-model baseline by inserting Grok 4.7 between DeepSeek V4.1 Flash and GPT-6.1 Sol. Based on their experience, the user prefers Grok as a stronger reasoning option than V4.1 Flash for more demanding/deeper exploration; this is a routing preference, not a verified benchmark. Use Grok 4.7 at high or xhigh when the live catalog advertises those effort levels. Grok is available through Cursor and Grok CLI/provider, and may also be used for scoped implementation under the same delegation and verification rules.

This is not a mandatory sequential escalation ladder. Choose the best available model for the task up front. Verified outcomes or user feedback may justify revising the working tier as well as routing by task category without another approval request. Keep the user-provided baseline above, and record the date, reason, and supporting evidence for each adjustment.

For GPT-led UI/UX and design tasks, start with DeepSeek V4.1 Flash or GPT-6.1 Sol using the existing effort preferences. The user may manually ask Claude to refine the work later. This preference applies only to GPT-led sessions; it does not set a default for Claude-led sessions.

On 2026-10-20, the user set a runtime preference for delegated work: default to full access for non-Claude delegates when the live catalog advertises it and the parent/platform permits it; use MiniMax `bypassPermissions` for full-access work when advertised. Do not use full access or bypassed permissions for Claude as Unix root (UID 0). Honor live catalog and parent limits, and use an authorized supported alternative if a mode is unavailable or refused. This preference does not change the model-tier baseline above.

## Routing observations

Keep observations brief and tied to a task category, scope, and concrete evidence. Consider exploration, single-file or function work, multi-file integration and consistency, optimization, and UI/UX design separately. Confidence should reflect how much evidence exists and how well it transfers to similar tasks. One result can inform a hypothesis; repeated, comparable results support a stronger routing change.

Separate implementation performance (correctness, consistency, rework, and time to a verified result) from generated-code runtime performance (for example, latency, throughput, or resource use). Claim runtime optimization only when measurements support it. A good build or review is not evidence of a runtime speedup.

Do not record secrets, credentials, private user data, or raw logs. Prefer short summaries and references to commits, task records, or check results.

First verified coding-performance observation: [2026-10-20 shared chat origin handling](2026-10-20-shared-chat.md). The current tier includes the user's Grok insertion above; no empirical tier reordering has been established.

2026-10-20 — Scoped Rust MongoDB connection utility: DeepSeek V4.1 Flash at high via OpenCode implemented the utility; GPT-6.1 Sol led review and integration of runtime-lifetime documentation corrections and stronger checks. Verified with four default unit tests and eight isolated authenticated MongoDB fixture cases. Evidence: `dima-rust/src/utils/mongo.rs`, `dima-rust/tests/mongo_connection.rs`. Confidence: single task. This supports the existing scoped-implementation routing; it does not change the model-tier baseline. No runtime performance claim.

2026-10-20 — Scoped Rust Redis/Dragonfly connection utility: DeepSeek V4.1 Flash at high via OpenCode implemented the utility; GPT-6.1 Sol led review, integration, and disposable Dragonfly runtime checks. Verification covered 15 unit tests, two doctests, formatting, check, clippy, build, and 13 isolated runtime cases for configuration rejection, shared-client behavior, Lua/TTL, failed-init retry, handshake timeout/retry, reconnect after a dropped socket, and blocking-command behavior with a subsequent `PING`. During fixture review, GPT-6.1 corrected the Lua fixture key TTL to 60 seconds to match its comment, and the success-case recheck passed. Confidence: single task. This supports the existing scoped-implementation routing; it does not change the model-tier baseline. No runtime performance claim.

2026-10-20 — Stateful Rust MongoDB projector port: GPT-6.1 Sol at high was selected for the cross-file state, lease, and idempotency implementation and isolated dual-implementation fixture work; GPT-6 Luna handled documentation. Lead review caught and fixed the Mongoose empty-checkpoint `active.ids` default in Rust and a TypeScript compiler-load issue in the benchmark harness. Final-code evidence includes 20 unit tests, one doctest, formatter/check/clippy/build, MongoDB 8.2.6 parity cases for retries, leases, partial writes, validation errors, concurrency and untouched dashboard state, plus CLI env/database/shutdown checks. The three-run synthetic benchmark medians were 90.727% lower worker-process RSS, 88.235% lower worker-process CPU, and 36.664% higher throughput after the first batch for Rust; see `dima-rust/benchmarks/stream_activity-2026-10-20.json`. These fixture results do not establish production/API throughput or attribute the differences to a particular implementation choice. Lead acceptance completed. Confidence: single task; no model-tier ranking change.

2026-10-21 — Rust projector batch tuning and idle polling documentation: GPT-6 Luna at high reconciled the implementation policy and benchmark report against the raw fixture artifacts. The 48 worker-run matrix (24 runs per implementation) passed persisted parity, and the isolated idle fixture verified capped backoff, backlog drain, reset, and prompt signal shutdown; see `dima-rust/STREAM_ACTIVITY.md` and `dima-rust/benchmarks/stream_activity-batches-2026-10-21.json`. This supports the existing routing for source-backed documentation; it does not change model-tier ranking or claim a general model capability benchmark.

2026-10-21 — Rust stream-activity production integration: GPT-6.1 Sol led native implementation, integration, and acceptance through Codex; GPT-6 Luna updated the source-backed operational and rollout documentation. The capped cron candidate passed focused parity, checkpoint-recovery, telemetry, child-restart, and signal checks before cron-only deployment; production observation confirmed the Rust projector as the sole stream-activity worker and verified checkpoint progress and analytics metrics. See `dima-rust/STREAM_ACTIVITY.md` for release identity and bounded production observations. Confidence: single task. This supports the existing routing for stateful integration and documentation; no model-tier change or capability/performance ranking is inferred.

2026-10-21 — Raid analytics Rust migration and Mongo-only worker build: GPT-6.1 Sol led implementation, build isolation, candidate verification, deployment, and production acceptance; GPT-6 Luna reconciled the source-backed rollout and operations documentation. The capped feature audit passed no-feature, Redis, PostgreSQL, HTTP, and all-feature checks plus the Redis-only TLS-provider regression check. Separately, Mongo-only checks passed 18 unit tests and one doc test. A corrected release-cache hygiene step produced an accepted 649.777-second cold and 102.007-second warm Mongo-only Rust build with dependencies reused and both release binaries rebuilt; this is build-time evidence only. Candidate cron run `cron-b24a505b7fc8` passed all 10 raid and five stream behavior assertions, then deployed cron-only. A 165-second initial production acceptance watch confirmed one native raid child at UID 65534, no TypeScript raid worker, all 75 summaries refreshed, zero due/errors/restarts, accepted analytics telemetry, and continuing stream checkpoint progress. CPU samples are unmatched to the pre-deploy window and early RSS observations are not steady-state benchmarks. Evidence: `migration-notes/raid-analytics.md`, `ops/README.md`. Confidence: single task. Supports the current integration/documentation routing; no model-tier ranking or general runtime-performance claim is inferred.

2026-10-21 — Raid worker phase/health follow-up, controlled comparisons, and release docs: GPT-6.1 Sol led bounded implementation, candidate verification, and deployment; GPT-6 Luna at high via Codex reconciled the migration, Rust guide, and ops docs against source, the two benchmark artifacts, and production acceptance evidence. Final candidate `cron-23e91b98cf64` used the already validated Rust 1.99.1 image and passed 21 unit tests, one doc test, 11 parser tests, 56 ops tests, 11 raid checks, five stream checks, and 27 strict-parity benchmark runs before deployment. The 100-second production watch and later zero-backlog health readback passed; the admin bundle also passed its served-asset check with mocked APIs. A separate 54-run shared-query experiment was deferred because CPU changes were inconsistent. The final synthetic comparison shows materially different Rust/TypeScript fixture medians but does not establish production gains; final versus previous Rust performance also varied, with dense projection slower. Evidence: `dima-rust/benchmarks/raid-analytics-query-experiment-2026-10-21.json`, `dima-rust/benchmarks/raid-analytics-2026-10-21.json`, `migration-notes/raid-analytics.md`. Confidence: single task. Supports the existing Sol implementation / Luna documentation routing for this bounded integration; no model-tier change or broad runtime-performance claim.

2026-10-21 — Follow-defense baseline source-backed release documentation: GPT-6 Luna at high via Codex reconciled the TypeScript/Rust contract, behavior fixture, build/deployment receipts, and production watch across the migration, project, and ops guides. GPT-6.1 Sol led implementation, review, build, and deployment; lead review corrected the excluded-day denominator guard and zero-stream average edge case. `git diff --check` and local reference/path checks passed. Evidence: `migration-notes/follow-defense-baseline.md`, `ops/README.md`. Confidence: single documentation task. This supports the existing source-backed documentation routing; no tier ranking or model-capability change is inferred. The measured RSS difference is short and unmatched; no CPU or throughput improvement is claimed.

## Blank observation template

Copy this block for each meaningful outcome:

```text
Date:
Provider / model / version + effort:
Task category / scope / constraints:
Concrete result and verification evidence (commit, task, or check references):
Rework / failures:
Latency / cost (only when actually measured):
User feedback:
Confidence:
Routing implication:
```
