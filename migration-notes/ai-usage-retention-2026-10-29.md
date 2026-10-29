# AI usage retention adapter — 2026-10-29

## Scope and reuse

This verified opt-in slice maps `adjustAiUsageRetention(channelIDs, planTierInput)` from `dimabot/src/utils/ai_usage_ledger.ts` to `dimabot/src/utils/ai_usage_retention.rs`. It reuses `RetentionTier` and its established 30/60/90-day policy, `JsDate`/`JsString`, lossless JSON, MongoDB/BSON, and each of the four existing model schemas' native collections. No parallel tier table, model, index installation, connection, retry, or worker behavior was added. Empty channel input avoids the source clock read and Mongo commands. The adapter preserves the four ordered source writes, Mongoose timestamp clock reads/casting order, and concurrent two-delete completion/first-error behavior.

Cancellation and disconnect can leave an uncertain mutation outcome. If one final delete fails, its sibling may continue after the function reports the first error; if the caller drops the future, spawned work still needs the Tokio runtime and client alive to finish. No application-level retry is provided. The driver retry configuration belongs to the caller.

The opt-in feature is `ai-usage-retention = [application-schemas, ai-usage-receipt-parser]`. No crate package, lockfile, default feature, or deployed profile changed. This is one local export, not the surrounding ledger migration: persistence callers, backfill/rebuild, model/bootstrap, API and caller adoption remain open. No performance benchmark was run.

## Verification

The frozen source SHA-256 is `553a83009ddd381bb94b28cb8dd5f736699bbded3581e2f95dfd20be7091c006` (1,284 input bindings). The eight related code, wiring, test, and oracle files were committed as `4896f1187db57e9c551214c2e51524096dd9c33a`. Parent-owned capped isolated strict all-target checks for each feature, all-feature checks, Clippy `-D warnings`, no-default-feature compilation, and eight query plus two retention ordinary tests passed (`compiler-1793284032019891565`: 126.21 s script / 135.056 s total; peak cache 8,447,475,712 bytes; minimum available memory 9,546,145,792 bytes).

The actual-source Node oracle/typecheck passed 34 retention scenarios / four declarations. Native replay against a fresh private Mongo fixture passed all 34, covering command BSON, Mongoose casts and clocks, failure order, and concurrent delete sibling behavior (`compiler-fixtures-1793284500245082430`: 7.152 s script / 17.949 s total). A separate fresh private Mongo exercise passed mutation, pool/index, disconnect and cancellation cases (`compiler-fixtures-1793284538995629407`: 2.646 s script / 12.615 s total). The combined final Node checks passed (`node-1793284627899110938`: 3.502 s script / 4.753 s total).

No deployment, source retirement, or caller adoption is claimed. Isolated-resource cleanup and production identity readbacks were handled by the parent. Final pinned Node checks passed both query and retention oracles (`node-1793285417559374117`; 3.502 s script / 4.784 s total); the parent readback reports all 19 production records unchanged. Source bindings and readback evidence are preserved under [the combined query and retention evidence directory](evidence/2026-10-29-ai-ledger-queries-retention/). Packaging/readback is complete, with 19 unchanged production records and no task-owned resources remaining.
