# AI credit projection and usage receipt producer — 2026-10-29

## Scope and status

This is a bounded, opt-in Rust library slice for five local credit functions, their related constants, and three receipt producer functions. It does not move callers, register a worker, change a deployed worker profile, or add Cargo dependencies. Request-time callers remain TypeScript; the existing receipt consumer is already a native worker. `billing.ts` and `ai_usage_ledger.ts` remain active and cannot be retired from this work: Polar calls/reconciliation, plan fencing, usage ledger parsing and persistence, PostHog `trackAiUsageRecorded`, TTS `trackTtsUsage`, the request callers, and bootstrap remain open. Total migration remains incomplete; caller adoption and deployment are separately unperformed.

The Rust features are `ai-credit-projection` and `ai-usage-producer`. Neither is in Cargo's default features or the existing worker profiles. The default set and Mongo/Redis worker profiles are unchanged. The work adds no crates and changes no lockfile.

## Bounded export mapping

| TypeScript export | Rust mapping | Scope limit |
| --- | --- | --- |
| `getAiCreditLimitForPlan` | `get_ai_credit_limit_for_plan` | Covers the declared `Free`, `Premium`, `Pro`, `Null`, and `Undefined` variants only. Rust does not claim arbitrary invalid JavaScript runtime values. |
| `AI_CREDIT_LIMITS` | Values represented by the native limit function | No public Rust map constant. |
| `AI_CREDITS_METER_ID`, `AI_CREDITS_CACHE_SCHEMA_VERSION`, `AI_CREDITS_CACHE_TTL_SECONDS` | Matching Rust constants | The 300-second cache constant is a scoped constant mapping; this does not port `getAiCredits` or its cache orchestration. |
| `buildAiCreditsDataFromMeter` | `build_ai_credits_data_from_meter[_at]` | Local projection math, JavaScript rounding, schema version, meter ID, and Date ISO/TimeClip behavior. |
| `applyAiCreditUsageToSnapshot` | `apply_ai_credit_usage_to_snapshot[_at]` | Local snapshot update; preserves additional lossless JSON properties/order. |
| `recordAiCreditUsage` | `record_command_at`, `AiCreditProjection::record_ai_credit_usage[_at]`, default-client wrappers | Local Redis projection only. Not Polar ingestion, PostHog, or event accounting. |
| `isAiCreditsExhausted` | `AiCreditProjection::is_ai_credits_exhausted`, `is_ai_credits_exhausted_default` | Local exhaustion flags/snapshot only; no caller has switched. |
| `getAiUsageRetentionDays` | `get_ai_usage_retention_days` | Premium 60, Pro 90, otherwise 30. |
| `buildQueuedAiUsageReceipt` | `build_queued_ai_usage_receipt*` | Typed and lossless plain-data builders; no application caller has switched. |
| `enqueueAiUsageReceipt` | `AiUsageProducer::enqueue[_at]` | One append to the existing queue; does not process or persist receipts. |
| `AI_USAGE_RECEIPT_QUEUE_KEY`, `AI_USAGE_RECEIPT_PROCESSING_KEY` | Matching native constants | Names/values only; no new consumer or processing behavior. |
| `QueuedAiUsageReceipt` | Rust `QueuedAiUsageReceipt` | Typed lossless builder value; not full `AiUsageTransaction`, parser, or worker-consumer contract parity. |

All other exports in these files remain open/unreviewed. In particular, this does not port `getAiCredits`, plan/credit-pack operations, Polar requests, `parseQueuedAiUsageReceipt`, locking, Mongo receipt persistence, backfill, daily rollups, ledger state, report/query APIs, or retention adjustment.

## Reuse and actual import boundaries

The credit projection reuses `JsString`, lossless JSON, JavaScript number formatting, `JsDate` TimeClip/ISO handling, plan-cache key helpers, SHA-256 support, and the existing Redis `ConnectionManager`. The receipt producer reuses native `AiUsageContext` and `classify_adjustment`, the same lossless string/JSON/date support, and the shared Redis manager. The queue key remains `cron:ai-usage-receipts:queue`; the processing key remains `cron:ai-usage-receipts:processing`.

Source declarations were inspected rather than inferred from the inventory's flattened import list. In `billing.ts`, `IUsers` is type-only; `getDragonflyClient` and `node:crypto`'s `createHash` are runtime imports used by the scoped projection methods (and other billing code). The plan-cache module is a runtime import for the unported `getAiCredits` path; referral and credit-pack imports belong to other billing exports. `getAiCredits` also dynamically imports `UsersSchema` at runtime. In `ai_usage_ledger.ts`, `RedisClientType`, `AiUsageContext`, `AiUsageTransaction`, `AiUsageWindow`, and `AiUsageRetentionTier` are type-only imports. The dashboard, daily, ledger-state, and receipt Mongoose schemas and `withAiUsageLock` are runtime imports for persistence/reporting outside the receipt producer slice. `classifyAdjustment` is a runtime import used by the scoped builder and has an existing native equivalent.

The native receipt builder accepts plain data: declared string fields may be absent, null, or strings; quantity may be absent, null, or a binary64 value. Missing keys represent JavaScript `undefined`, and null is retained where the source uses nullish mapping. Invalid runtime types, getters/hooks, prototypes, explicit undefined-valued extra fields, and non-plain objects are outside this API. The structured builder preserves arbitrary UTF-16 code units and binary64 values, including NaN quantity. JSON output preserves the source wire behavior, including escaped lone surrogates and `null` for non-finite numbers.

The native producer can serialize escaped lone surrogates losslessly. The incompatibility is in the **existing native** `ai_usage_receipts` worker consumer, which parses through `serde_json::Value` and rejects escaped lone surrogates. The producer does not silently rewrite those values to conceal the downstream gap.

## Redis behavior and diagnostics

`recordAiCreditUsage` guards empty channels and non-positive/non-finite credits before cache, clock, or marker work. For an external ID, its marker suffix is SHA-256 hex; without an ID the key suffix is `untracked`, but no dedupe marker is claimed. With an external ID, the Lua script first does `SET marker NX EX 31-days`; only after claiming that marker does it read the credit snapshot. Therefore an absent/malformed snapshot, or a later Lua error after the marker write, can consume the ID without applying the projection. This ordering matches the source script. The credit projection has a 31-day TTL; the cache snapshot must be version 3 and its `available` field must not be `false`. The script rounds consumed credits up, updates used/balance/status, and writes both canonical `twitch:<channel>:ai:exhaust` and legacy `<channel>:ai:exhaust` flags without expiry when exhausted.

The native implementation clones the same multiplexed `ConnectionManager`, applies a request deadline, and sends `EVAL` once. An uncertain timeout, cancellation, or disconnect is never replayed at the application layer. Polar remains authoritative and the source behavior is best-effort local projection. Receipt enqueue likewise sends one `RPUSH` to the existing queue and does not retry when the outcome may be uncertain. The Redis driver may reconnect for later operations; that is not a replay of these mutations.

Rust preserves the logical error payload (`channelID`, `error`) and source prefix. Native `eprintln!` formatting, console inspector rendering, and Redis diagnostic wording are runtime boundaries and are not claimed byte-identical to Node's `console.error` output.

## Verified baseline evidence

The verified baseline source SHA-256 is `77fc976da064a87c02ec1fce93cd0e4820dfe53a7eac9feb5fab453c482d80f7`. Commits are `e8b41990` (projection) and `c2a0d6f7` (receipt producer). `compiler-fixtures-1793256166045626940` passed in 269.868 seconds total (259.765 seconds script time). Strict standalone and all-feature format/check/Clippy, plus the no-feature check, passed. The run reported 178 test executions; that includes overlapping dependency tests and a subprocess-only no-op helper, so it is not 178 unique tests. This is the full baseline proof for the credit projection and unchanged TTS source. Post-Node replay `node-1793256476785298801` passed with the same baseline source hash.

The pinned Node 24.22.1 / V8 13.6.233.17-node.58 / TypeScript 5.9.3 credit oracle covered 1,956 cases: 5 limits, 1,015 meter projections, 504 snapshot applications, 387 record-command cases, and 45 exhaustion cases. One Rust source replay of those 1,956 cases passed. The receipt oracle covered 338 receipts, 20 retention cases, and 3,325 source assertions; source parity was regenerated after the later bounded optimization and every receipt, retention, and assertion output matched.

The baseline producer benchmark used five prepared pools, seven trials, 32,000 warmups, and 262,144 iterations (32,768 for the large case). It measures builder + wire serialization + UTF-8 byte summation, excluding Redis, setup, and clock I/O. Medians are microseconds per operation:

| Pool | TypeScript | Rust baseline |
| --- | ---: | ---: |
| Typed ASCII | 5.488255 | 5.582935 |
| Typed Unicode | 6.597315 | 5.710032 |
| Lossless nullish | 5.272826 | 5.741841 |
| Lossless surrogate | 6.512388 | 5.661869 |
| Lossless large | 37.699973 | 8.833420 |

ASCII is near parity; the nullish case is 8.895% slower in Rust; the large prepared case is 4.27× faster. These are bounded kernel timings, not application latency or production throughput.

The Node trial set was reused unchanged for the new source-only native-core hash. The explicit rebinding audit is recorded at `migration-notes/evidence/2026-10-29-ai-credit-receipt/artifacts/ai-credit-receipt/benchmark-reuse-audit.json`; baseline input hash `72a0a095c23891dd0b38bdc095ad5b09018c20dd5f7df98da3bd004e07f34fda`, new input hash `2a281ba3d198a30f81b84eff7a53b907344c57027e2ac203d900583d52895732`. The prepared inputs differ only in the native core hash, as recorded by the rebinding audit; the TypeScript trials were reused. See also the [dated orchestration note](../orchestrator-notes/2026-10-29-ai-credit-receipt.md).

## Verified receipt optimization

A bounded source-only optimization, commit `01d35033`, skips building a temporary classification map for non-adjustment receipt kinds. Final source SHA-256 is `02ab55a9d484c01af695793b55d6313280f30080c76db5ad9b5a909b440ac78f`. Its regenerated source-parity outputs matched all 338 receipts, 20 retention cases, and 3,325 assertions. `compiler-fixtures-1793256739341677553` passed in 184.692 seconds total (174.613 seconds script time), covering ordinary/source receipt cases, real Redis behavior, standalone producer strict check/Clippy, all-feature all-target strict check/Clippy, no-feature check, formatting, and release benchmark. Post-Node replay `node-1793256972582181383` passed with the final source hash. This optimized receipt verification does not replace the credit projection's 1,956-case baseline result because the credit implementation did not change; source bindings are distinct.

Final TypeScript/Rust medians in microseconds per operation were: typed ASCII `5.488254673 / 4.729704720` (1.16038×; sample ranges overlap), typed Unicode `6.597315228 / 4.798382866` (1.37490×), lossless nullish `5.272826218 / 4.931949913` (1.06912×; small), lossless surrogate `6.512388226 / 5.195385979` (1.25349×), and lossless large `37.699973267 / 8.866506592` (4.25195×). All seven checksums matched for every workload. ASCII Rust samples were 4.436–5.311 µs versus TypeScript 5.166–5.783 µs and overlap; treat it as near parity. Against its own baseline, Rust nullish latency fell 14.105%; large latency rose 0.375%, with overlapping ranges and no material change. Every pool uses `entryKind: usage`; these performance measurements do not measure adjustment receipts, whose cases remain in correctness parity only. Do not generalize these kernel timings to application latency, production throughput, CPU/RSS, or unconditional speedups.

The capped run used 6 CPUs, a 4 GiB memory=swap limit (no swap), 256 PIDs, two Cargo jobs, and an 8 GiB private cache. Final peak cache use was 8,490,975,232 bytes with minimum host-available memory 8,203,841,536 bytes; the baseline readings were 8,486,318,080 and 9,184,546,816 bytes, respectively. The final readback found 19 production records unchanged and no task-owned containers, networks, or volumes remaining.

Three failed compiler attempts remain recorded: the initial private `ConnectionInfo.addr` test access, a disconnect fixture whose retained TCP clone blocked EOF, and a Clippy test-seed type annotation. The follow-up accessor/fixture/annotation fixes resolved harness issues; these failed attempts are preserved as failures, not application defects.

The evidence index is [README.md](evidence/2026-10-29-ai-credit-receipt/README.md); it links the [verification summary](evidence/2026-10-29-ai-credit-receipt/verification-summary.json), [baseline source binding](evidence/2026-10-29-ai-credit-receipt/baseline-source-binding.json), [final source binding](evidence/2026-10-29-ai-credit-receipt/source-binding.json), [benchmark reuse audit](evidence/2026-10-29-ai-credit-receipt/artifacts/ai-credit-receipt/benchmark-reuse-audit.json), [final readback](evidence/2026-10-29-ai-credit-receipt/artifacts/ai-credit-receipt/final-readback.json), raw reports, and recorded verifier runs. The standalone [receipt benchmark](evidence/2026-10-29-ai-credit-receipt/receipt-benchmark.html) was visually checked at 390 and 718 px in dark mode; the [visual record](evidence/2026-10-29-ai-credit-receipt/visual-verification.json) binds the exact HTML. No deployment, caller adoption, source retirement, or push occurred.
