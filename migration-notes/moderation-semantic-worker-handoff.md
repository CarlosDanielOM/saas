# Moderation semantic worker implementation handoff

Status: **partial local native service adapter verified**. This is not source retirement, scheduled-worker adoption, caller adoption, or full moderation dependency completion. The original author-only draft below was superseded by final source-bound verification; see the [acceptance note](moderation-semantic-worker.md) and [indexed evidence](evidence/2026-10-30-moderation-semantic-worker/README.md).

## Implemented mapping

The Rust `SemanticWorker` is constructor-injected with the application `Database`, `AiCreditProjection`, `AiCreditReader`, `SemanticProvider`, and `PolarCacheUsage`. Construction performs no I/O. Its `process_next` / `process_next_with_clock` and `maintain` / `maintain_with_clock` methods cover the bounded claim/evaluate/update/late-audit path and expiry/charge-maintenance pass. The implementation reuses existing native semantic and spam policy, plan policy, credit projection and verified-credit reader, BSON conversion, and cache-mode Polar usage paths.

## Boundaries

No application-specific bootstrap factory, worker binary, cron supervisor registration, TypeScript caller switch, source retirement, deployment, or push is included. The caller still owns concrete database and shared Redis-derived services. Immediate/batch Polar ingestion and downstream billing are open. BSON reader-stage invalid regex, eager nested decoder errors, malformed schema-shaped BSON, automatic logger telemetry/OTel startup, and source logging-throw behavior remain bounded gaps. No worker benchmark or speed claim is available.

The source corpus is 41 records: 39 have a concrete fixture mapping and two remain source-only. One source-only record forces an available negative credit balance that the ordinary reader does not produce. The other forces ingestion to throw; it is not considered unreachable because telemetry/logging may throw outside ordinary queue/console catches. Four ignored worker cases passed, comprising three concrete private-service suites plus an all-record trace audit. The audit is not a full concrete replay of all 41 records.

Pacing remains one claim and at most ten charge records per pass with no helper sleeps. The worker reuses the provider-only 750 ms credit-reader deadline and the existing cache usage lease/wait timing. No application-level Mongo mutation retry is added; the application inherits driver policy, while fault fixtures disable retries for fault isolation.

## Immutable source and candidate

TypeScript source baseline commit: `65d600dc` (`dimabot/src/utils/moderation/semantic_worker.ts` SHA-256 `8c6161cace13a2be249b0a0005576ff522d45949eff6517426b26ebafbe62de1`, 87 lines). Rust code commit: `1d76b435`. Final exact-source run pair: `node-1793353870017934370` and `compiler-fixtures-1793353821109683319`; both use source-tree SHA-256 `6c199f40fefd469346533f57182204a8ee1aedce66dde9ace6e00a9b8c7971bb`, 1,464 inputs. Node postcheck `node-1793354263387812460` also matches. The evidence package retains all receipt hashes, compressed logs and oracle payloads, source snapshots, cleanup readout and reproduction helpers.

Final compiler-fixtures duration was 194.936 seconds and the final sequence 206.214 seconds under 6 CPUs, 4 GiB memory/no swap, 256 PIDs, two Cargo jobs; min available memory 9,083,023,360 bytes and peak cache 7,707,127,808 bytes. Verification succeeded for four normal BSON regressions, one ignored BSON replay of 54 cases, formatting, scoped/minimal/Mongo-Redis/all-feature strict profiles, and four ignored worker cases. Production readback showed 18 records unchanged and zero owned resources remaining.
