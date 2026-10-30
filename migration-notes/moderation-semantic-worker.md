# Moderation semantic worker — 2026-10-30

The `src/utils/moderation/semantic_worker.ts` row is now **partial**: a bounded native service adapter for both exports is implemented and verified against the immutable TypeScript baseline at commit `65d600dc`. The Rust implementation is commit `1d76b435`. The current TypeScript worker still calls the TypeScript module; no caller adoption, source retirement, deployment, or push occurred.

## Reused paths and remaining adapter gap

The native `SemanticWorker` composes existing `AiCreditProjection`, `AiCreditReader`, `SemanticProvider`, spam and semantic policy helpers, native BSON conversion, and `PolarCacheUsage`. Construction takes caller-owned concrete handles and performs no I/O. `process_next` implements the claim, policy, credit, evaluation, update, and late-audit path; `maintain` expires requests and processes bounded charge work.

The application still needs a bootstrap adapter that binds the application database and shared Redis-derived projection, reader, provider, and usage services to the worker. The scheduled worker binary/supervisor registration is absent. The complete billing and Polar ingest closure is not present: this adapter reuses cache-mode `PolarCacheUsage`, while Polar immediate/batch paths and downstream billing remain open. Mongo schema/model wiring, automatic logger telemetry/OTel bootstrap, and whole-source logging-throw behavior also remain outside this bounded local mapping. The concrete service constructor does not by itself implement those bootstrap and integration steps.

## Behavior and evidence

The source uses one atomic claim per processing pass and processes at most ten oldest pending charges during maintenance. The native adapter adds no helper sleeps. The 750 ms timeout bounds only the credit reader’s Polar provider request; Redis and Mongo reads do not share that end-to-end budget. `PolarCacheUsage` retains its existing 8 s lease, 350 ms poll and 2.5 s wait cap. Native code adds no application-level Mongo mutation retry and inherits the caller's Mongo driver policy. Fault fixtures disable driver retries to isolate application behavior.

The pinned source corpus has 41 records. Its authored map assigns 39 records to concrete private Mongo/Redis/loopback fixtures and identifies two source-only cases: a mocked available negative balance, which ordinary credit-reader output does not produce, and an unconditional ingestion throw. The latter is not called unreachable: telemetry/logging can throw beyond ordinary queue and console catches. Four ignored worker cases passed: three concrete private-service suites and one full source-trace audit. The audit does not mean all 41 cases were concretely replayed.

Four normal BSON regressions and one ignored 54-case BSON replay passed. Final formatting, scoped, minimal, Mongo/Redis, and all-feature/all-target strict checks passed. Remaining BSON boundaries include reader-stage invalid-regex behavior, eager nested decoder errors, and malformed schema-shaped BSON outside the tested contract. These are the verified limits; the earlier author-only handoff's broad claim that the adapter simply rejects legacy DBPointer, complex regex, and DBRef `__proto__` cases is superseded by the final BSON projection evidence.

The exact-source final runs were `node-1793353870017934370` and `compiler-fixtures-1793353821109683319`, both bound to source-tree SHA-256 `6c199f40fefd469346533f57182204a8ee1aedce66dde9ace6e00a9b8c7971bb`. The later Node postcheck `node-1793354263387812460` used the same tree. The source receipt binds 1,454 Git inputs plus ten reused SDK inputs. Compiler-fixtures took 194.936 seconds and the full final phase 206.214 seconds, under 6 CPU / 4 GiB no-swap / 256 PID / two-job limits; minimum available memory was 9,083,023,360 bytes and peak cache 7,707,127,808 bytes. No worker benchmark was run.

Production readback reported all 18 production records unchanged and no remaining task-owned resources. Proactive cleanup of the private build cache removed 31 completed debug executables and freed 1,085,304,832 bytes; no quota increase or guard failure occurred.

This moves the frozen 806-row inventory from 17 locally complete and 23 partial rows to **17 locally complete and 24 partial rows**. The other 805 rows and top-level inventory metadata are unchanged. Total migration completion remains `null`; this worker's broader dependency closure is not claimed complete. See the [handoff](moderation-semantic-worker-handoff.md) and [indexed evidence](evidence/2026-10-30-moderation-semantic-worker/README.md).
