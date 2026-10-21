# Worker backlog scheduling review

**Status: accepted and deployed.** Run `cron-9ff771d91cda` deployed the exact tested image `sha256:2a009af0d0fabef6bd2103ef04596ed6451a1ce360c73b32c9146f8ce3878102` at `2026-10-21T20:58:08.390836997Z`. The helper rollback command is `scripts/saas-ops rollback cron-9ff771d91cda`; it restores prior accepted run `cron-7a8ca7924412`, image `sha256:c7c8203e245b263f462ee1c6ca4c1007418408ac190d9ad9b9013ec2e4801fa8`. The rollback image retains all six Rust workers with the prior cadence and older cron email templates; it does not restore a TypeScript fallback. The exact-image suites, production acceptance, readbacks, container comparison, and cleanup passed.

The durable review rule is in the root [scheduling and pacing review policy](../AGENTS.md#scheduling-and-pacing-review-for-worker-migrations). For this already-authorized change, that review added no approval gate or reconfirmation. Historical accepted rollout records in [AI usage receipts](ai-usage-receipts.md) and [roulette completion](roulette-completion.md) remain unchanged.

## Decision ledger

| Worker | Behavior under review | Decision and evidence |
| --- | --- | --- |
| AI usage receipts | Idle polling, ready queue work across bounded batches, dashboard maintenance, retry/dead-letter policy, and global/account leases. | Preserve existing `BatchOutcome` and `run_batch` signatures. Continue immediately only after a clean, fully attempted batch with `success: true`, enabled configuration, no stopping state or lost heartbeat, and compare-owner-delete global lease release returning `1`. AI batch fullness alone does not prove readiness. After a partial batch, nonfatal `Ok(success: false)`, unavailable lease, or lost lease, retain the configured poll interval (default 1 second, minimum 250 ms); no extra queue probe is needed. Fatal storage/watchdog `Err` exits for supervisor restart. Preserve retries/dead-letter behavior, account-lock acquisition retries (50 ms up to 10 seconds), 120-second account lease TTL, 30-second account heartbeat, global lease TTL (default 300 seconds, minimum 30 seconds), global heartbeat `max(TTL / 3, 5 seconds)`, and 2-second Redis heartbeat/release bounds. Keep the independent 20-second initialization/active-job/dashboard watchdog and ten-second maintenance cadence. |
| Roulette completion | Idle polling and due work across bounded channel batches, including determining whether more work is ready before waiting. | Use `PassOutcome` to distinguish fetched, changed, and ready state. Keep the bounded 100-row pass and, after a nonempty unblocked pass, use a fresh-time indexed `dueAt` `find_one` to check for remaining ready work. Continue immediately if work is ready, including when zero rows changed because a concurrent writer cleared them or partial new due rows arrived. Persistent due rows with unsettleable state suppress continuation to prevent spinning. Empty, future-only, and blocked passes wait 1 second. Preserve fatal CAS/storage behavior, the 20-second whole-pass watchdog, and 25-second supervisor grace. |

Both workers yield between bounded passes, and `--once` remains a single-pass mode. The normal-mode checks require AI progress over more than three small batches and roulette progress through 205 due rows. Readiness comes from outcome state and the fresh due-time query, not fetched or changed counts alone. For each frame transition, residual time is **the next stdout frame timestamp minus the previous stdout frame timestamp minus the next frame's `durationMs`**. Checks require residual below 700 ms while ready work remains and at least 800 ms while idle, waiting for future work, or in specified error/lease cases. They also cover empty/future-only waits, readiness independent of counts, lease safety, and shutdown.

Scope exclusions: the baseline's intentional eight-success cooldown and the stream worker's empty-checkpoint edge remain unchanged.

## Candidate build and source identity

The Rust build for candidate `cron-9ff771d91cda` completed with a warm-cache hit in 310.964 seconds under 6 CPUs, 4 GiB memory with swap disabled, 256 PIDs, two Cargo jobs, and pinned Rust 1.99.1 musl. Format, check, Clippy, unit, doc, release, and dry-run passed for both feature profiles; the three new scheduling unit tests passed. The focused source proof covered 805 runtime/build paths (26 Rust, 777 Node, one recipe, one unchanged helper). A complete-snapshot identity check covered 34 Rust and 800 Node files plus six staged native binary hashes with no mismatches. There were no dependency, manifest, Compose, environment, schema, or index changes.

The combined candidate also included previously reviewed email-template commit `c5288218` across seven email paths. The email owner had handed off the remaining cron release to the lead; its separate API release `api-793cfbcecd44` was independently accepted before this run. The exact candidate passed the seven-group email suite `653cf110`. A production-render-only check passed six groups with `deliveryAttempted: false`; no email was sent by these checks. This coordinated email check was required for this candidate and does not add an unconditional ninth suite to future cron releases.

Persistent acceptance archive: `/root/.local/state/saas-ops/649a957c15888e53/cron-9ff771d91cda/worker-backlog-acceptance/`. Key evidence files include `receipt.json`, `rust-build.log`, `candidate-source-identity.json`, `full-snapshot-identity.json`, `runtime-source-changes.json`, `suites.json`, `predeploy-verification.json`, `production-watch.json`, `production-acceptance-facts.json`, `production-log-summary.json`, `natural-receipt-drain.json`, `email-production-render.json`, `cleanup-facts.json`, and `source-isolation.json`.

## Exact-image verification

All nine suites ran against the same image and passed, 120 groups total:

| Suite | Groups | Duration |
| --- | ---: | ---: |
| AI usage receipts | 23 | 99.388 s |
| Roulette completion | 19 | 58.525 s |
| Email templates (coordinated scope) | 7 | 39.185 s |
| Raid sessions | 20 | 80.294 s |
| Stream activity | 6 | 135.418 s |
| Change-driven raid analytics | 20 | 129.098 s |
| Follow-defense baseline | 11 | 114.327 s |
| Rust-only retirement | 6 | 17.411 s |
| Raid-sessions cron pipeline | 8 | 83.570 s |

The AI and roulette checks verified ready-work residual below 700 ms and paced residual at least 800 ms, with negative controls and child-close-flushed stdout. AI normal-mode cases included 7 jobs at batch 2 (`2/2/2/1` then paced idle), six jobs at batch 2 (`2/2/2/0`, continuing until empty then paced idle), a failed full batch, three-attempt poison requeue, contention, heartbeat loss and pre-heartbeat fenced release, independent ten-second maintenance, and SIGTERM with a ready tail. Roulette processed 205 rows as `100/100/5`; a clean full 100-row pass waited when no ready remainder existed; a zero-change raw 100-row pass, whose selected rows were cleared by a concurrent writer, continued immediately to 105 other due rows; partial passes continued for newly due rows; a full 100-row persistent no-op pass waited; a later storage failure exited; and SIGTERM on 101 rows drained the current 100-row pass only. Existing parity, CLI, privacy, restart, telemetry, watchdog, and error coverage remained.

The future standard cron policy remains the six native suites, Rust-only retirement check, and raid-sessions cron pipeline check. The coordinated email suite was added only because that separately reviewed email change was included in this candidate.

## Production acceptance

The 19-sample watch ran for 190.802 seconds after deployment. All six native children remained at stable PIDs/start ticks and UID 65534, with exact binary hashes matching the build receipt; restart count was zero, no retired TypeScript artifacts appeared, and no active health reasons were reported. Only `dima-cron` changed among 17 checked containers; the other 16 were unchanged. The 12 checked collections retained all 57 full index specifications.

The stream projector advanced from sequence 34179 to 34227 during the watch; dashboard sequence advanced from 32116 to 32191. Final readback was 34230 and 32197 with no active checkpoint. Raid errors were zero; roulette due count, raid due/backfill, retention, request, and action work were zero at final readback. Session count naturally changed from 41 to 40; no cause is inferred. Startup backfill drained from 140 pending at the first sample to zero; processing/dead-letter queues were zero. The historical backfill failure counter remained 2, with no active health reason; receipt failures were zero.

Final usage readback showed 48,342 receipts, 1,445 daily records, 9 dashboards, and zero dirty dashboards. A natural receipt arrival overlapped the first post-watch readback, so its initial pending count of 1 was rechecked after drain and then zero; the receipt count went from 48,339 to 48,342. No live jobs were injected. The observational watch was quiet for roulette and raids while natural queue work and isolated fixtures exercised backlog behavior; it does not establish an exactly-once claim for unmatched natural jobs or a throughput benchmark. Analytics readback returned 21 metric groups covering RSS, CPU, and project batches for all six workers, with no nonzero errors, restarts, or health errors. Recent logs showed no supervisor exit or errors; one benign `failed: 0` field was ignored. Live email rendering passed six groups with no delivery attempt.

## Cleanup and limits

`scripts/saas-ops cleanup` exited zero; the archive records no remaining task resources, containers, or networks. The temporary format container, isolated worktree, private fixture copies, and format copies were removed. Current and rollback images and receipts remain preserved. No API or bot deployment is claimed here; the API release was independently accepted by its owner before this candidate.

Production observations establish the scoped acceptance checks above. The changing session count is reported without attributing a cause; naturally arriving queue work was not treated as injected test data. No runtime throughput or exactly-once claim is made.
