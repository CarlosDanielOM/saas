# Cron supervisor telemetry counters release

**Accepted 2026-10-22.** Current cron release: `cron-be76d96c7a39`, image `sha256:f5ccef5ad569484a318da211718d5b903c061913944a9ac8345082fd0ef24c05`. The supported rollback is `scripts/saas-ops rollback cron-be76d96c7a39`, which restores the prior accepted pet release `cron-ea507552f33d` / image `sha256:46706ffeb3c55bfcaf67964675d3fc6404dc965a52b55009c787f1a8b1c328c5`.

## Change and source contract

This release adds Rust index runtime telemetry to the existing dual-supervisor cron container. `dima-rust/src/supervisor/telemetry.rs` samples `cron_index_rust.rss_bytes`, `cron_index_rust.cpu_cores`, and the exporter’s cumulative `cron_index_rust.telemetry_dropped` counter on its ten-second cadence; shutdown sends already buffered metrics in a bounded final flush. Telemetry remains best-effort. With telemetry disabled, the exporter makes no periodic or final connection while Rust worker supervision stays active. The fixed metric names and required worker/resource samples are checked by [`ops/checks/cron-supervisors-fixtures/telemetry-assertions.mjs`](../ops/checks/cron-supervisors-fixtures/telemetry-assertions.mjs).

The exact-candidate build receipt records the capped Rust build at 3 CPUs and 4 GiB, taking 417.672 seconds with Rust 1.99.1. Only the cron index executable changed; all seven native worker executables were byte-identical to their previous accepted binaries. The checked source worktrees were removed after byte-identity checks against commits `4455b569`, `0c70a8f2`, and `9afe3a9f`.

## Candidate and production evidence

All eight exact-image supervisor checks passed: TypeScript and native ownership, per-owner child restart, fail-closed Rust-index death, bridge shutdown, supervisor RSS/CPU exports, telemetry-disabled supervision, draining 20,000 worker frames with unread diagnostic stdout, and aggregate/mixed-exit and output validation. The telemetry-disabled case verifies that observability does not control worker lifecycle.

Production verification sampled the deployed process topology four times. Every sample passed; Node remained PID 1, the Rust index ran as UID 65534, and all seven native workers were present. Only `dima-cron` changed among the 19 checked containers; the other 18 were unchanged. Fresh production telemetry readbacks showed Rust-index RSS of 2,359,296–2,420,736 bytes, CPU of approximately 0.001–0.003 cores, and zero dropped telemetry across the sampled buckets. These are short scoped observations, not a performance benchmark.

The cron build and verifier used run `cron-be76d96c7a39`. Its receipt records source digest `1ce915796d983b1bb32b6185b76dcefce8633924fcc244f55d0bc5af01cd5fe3`, Rust source digest `69be8e7df25c26a0c5e7f5831c5632fbf87e51dbd376f0886df97a4817a3fe29`, and check digest `47614918d42899cc43376295d1f7e5362662faea9f0e3db94fe0b582021a6077`, along with deployed status, build limits/duration, and no remaining task-owned resources. The rollback receipt remains available.

## Related admin and documentation releases

The admin release `admin-8f956fd79cf8` (artifact digest `6a2d13f91e59fe2cbcf1a5cf798646174e7e370a8acc6872cfb9cb021dc23628`) stops summing cumulative telemetry-drop samples and displays the latest reported reading. It was verified in preview and against the exact candidate with mocked API responses. Checks covered repeated polling, real counter increases, restart resets, overlapping-instance bucket averages, range changes, reload and missing samples, service scoping, and the independent collector warning. Accessibility and overflow checks passed at 320/390/1280px in dark and light themes. The first browser check raced asynchronous rendering; the corrected check waited for rendered states. Production verification was asset-only: a fresh collaborative-browser fetch found `index.html` SHA-256 `7ff4c575da1a808eb5607ba701821d28f5247efa6d4e53ad7d0e8b8e95832643` and `chunk-6CPKRFHO.js` SHA-256 `86cbb6f282b15430ff84403cbad69ca8fb0649a1c6f248730e583a2ad19c23d6`, matching the exact deployed bundle. Direct `urllib` access was denied by Cloudflare (403), so the collaborative browser was used.

The docs release `docs-fb1811b980e5` (artifact digest `c3d436aa1e5ed3d70230413f69ec5b57693e33b71022dd3d36a69e3590fcffdd`) passed 66 unit tests, a 135-URL check, the bilingual Roulette HTML and `index.txt` behavior check, and the `llms.txt` check. The initial assertion expected a nonexistent “100 slots” phrase; source review corrected it to the documented last-one-standing mode’s 100-entry capacity. Fresh browser-fetched production hashes for the English and Spanish HTML and `index.txt`, including the new text, matched the built `dist` output.

Production checks did not use an authenticated UI or live mutating API flow. Admin interactions were exercised only with mocks in preview and exact-candidate verification; production validation covered served assets. Docs production validation covered fetched static assets and content. Candidate cleanup completed for all three runs with empty resource lists; rollback receipts were retained.

## Evidence records

- Private receipts: `/root/.local/state/saas-ops/649a957c15888e53/{cron-be76d96c7a39,admin-8f956fd79cf8,docs-fb1811b980e5}/receipt.json`.
- Release checks and production snapshots: `/root/.local/state/pending-prod-20261022/{cron-build.log,cron-verify.log,cron-production.log,cron-production-topology.json,cron-production-metrics.json,cron-container-change.json,admin-preview-check.log,admin-verify.log,admin-production-assets.json,docs-unit.log,docs-verify.log,docs-llms-verify.log,docs-deploy.log}`.
- Source and checks: [`dima-rust/src/supervisor/telemetry.rs`](../dima-rust/src/supervisor/telemetry.rs), [`ops/checks/cron-supervisors-fixtures/telemetry-assertions.mjs`](../ops/checks/cron-supervisors-fixtures/telemetry-assertions.mjs), and the admin and docs behavior-check logs above.

The policy, queue, token, and Qdrant folder utilities have since passed final source-backed library validation (2026-10-23); they remain opt-in contracts only. No production caller has adopted them, no worker registration or deployment occurred, and this accepted production release record is unchanged. See [`policy-queue-token-utils.md`](policy-queue-token-utils.md) and [`qdrant-folder.md`](qdrant-folder.md) for scope and evidence.
