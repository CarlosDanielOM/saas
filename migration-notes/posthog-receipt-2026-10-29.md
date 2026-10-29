# PostHog event tracking and receipt parser handoff — 2026-10-29

## Scope and source mapping

This is a source/verification handoff for the native implementations; it is not whole-wave acceptance. The TypeScript source is `dimabot/src/utils/posthog_events.ts`. Its six exports map as follows:

| TypeScript export | Native counterpart |
|---|---|
| `identifyStreamer` | `StreamerIdentityState::identify` plus `PosthogTracking::identify_streamer`; deduplicates unchanged channel names within the process and creates `$identify` with `$set.channel_name`. |
| `trackCommand` | `posthog_tracking::command` / `PosthogTracking::track_command`; preserves required fields, optional-to-null fields, and JS-falsy user/username fallback. |
| `trackTts` | `posthog_tracking::tts` / `PosthogTracking::track_tts`; maps TTS properties and optional nulls. |
| `trackAiUsageRecorded` | `ai_usage_recorded` / `track_ai_usage_recorded`, and typed `NativeUsageRecorded` for an existing `AiUsageContext`; retains source property names, `$insert_id`, and `billing:${requestId}` fallback. |
| `trackAiOperation` | `ai_operation` / `PosthogTracking::track_ai_operation`; preserves the request/operation/lifecycle insert ID and schema version. |
| `shutdownPosthog` | `PosthogTracking::shutdown_posthog` and `PosthogLosslessTransport::shutdown`; native implementation also exposes an explicit flush barrier. |

The source imports `AiUsageContext` as a type and `AI_USAGE_SCHEMA_VERSION` as a runtime value from `ai_usage_event.ts`; `posthog-node` is its other runtime import. Rust reuses native `AiUsageContext` and the shared version constant in `ai_usage.rs`, with concrete native SDK and lossless HTTP backends. The receipt parser is adjacent data-path work, not another PostHog export: `parse_queued_ai_usage_receipt` parses queued receipt JSON into its normalized 18-field value and concrete BSON projection.

## Implemented native pieces and boundaries

`posthog_tracking.rs` contains all six payload/identity behaviors and supports either the existing `posthog_rs::Client` SDK adapter or the concrete lossless transport. `posthog_lossless.rs` implements a pooled `/batch/` HTTP queue. Its default queue event-count limit is 10,000, matching the installed `posthog-node` wrapper's default. Native transport additionally limits a serialized event to 256 KiB using a conservative six-bytes-per-UTF-16-unit preflight plus 64-level and 16 MiB queued-byte bounds. The event bound is deliberately conservative, not a claim that equivalent SDK behavior was found.

Transport semantics differ from `posthog-node`: the native client disables redirects and proxy use, reads response bodies up to a 64 KiB bound, and has a permanent shutdown state. SDK-style later capture after shutdown is therefore not preserved. Native transport event metadata uses UUIDv4; the SDK's event metadata uses UUIDv7. These are explicit boundaries, not parity claims. The payload builders preserve arbitrary JSON values on the lossless backend; the optional SDK adapter rejects unpaired UTF-16 because Rust strings cannot represent lone surrogate code units.

`ai_usage_receipt_parser.rs` plus `lossless_json_view.rs` add a borrowed, whole-input-validated flat span index for selective reads. Ignored nested fields need not be materialized as a recursive owned JSON tree, removing the owned-tree reader's 128-depth constraint for this selective parser. The network/body reader remains unchanged, and JS/V8 stack-resource parity at depth 16,384 is not claimed. The parser's concrete BSON conversion is the Node BSON writer replacement boundary: BSON UTF-8 conversion replaces unpaired UTF-16 with U+FFFD, including in IDs, so distinct lossless IDs can collide in storage as in the Node behavior; callers must retain the pre-storage ID where needed.

The deployed native worker still uses its existing old parser in `values.rs`, which rejects lone surrogates; it has not adopted the new parser. Its existence does not close that behavior gap. Five opt-in features and four module gates integrate the new components. No crate was added, and the lockfile, Cargo defaults, worker profiles, worker registry, and application callers are unchanged. Caller adoption is separate from dependency completeness; no caller has adopted the new PostHog API or receipt parser, and no worker retirement, push, deployment, or live cutover occurred.

## Verification status

The initial baseline received capped isolated validation. Source tree identity was `0551e2ebdbf792b7989a1f32bac37a670db66b7409b390808ad838b8ecfbf42c`. Source work is locally committed as `cf2bd757` (borrowed JSON view), `f0ec266b` (parser), and `77141415` (PostHog integration). This baseline evidence does not cover the separate ongoing optimization work.

- Isolated formatting and the full target/all-feature check plus strict Clippy passed; minimal and no-default-feature profiles also passed. Final compiler run `compiler-1793264871810743273`: 376.581 seconds total / 367.684 seconds script time, peak private cache 7,988,916,224 bytes, minimum host available memory 9,549,725,696 bytes, with 6 CPU, 4 GiB memory=swap (no swap), 256 PID and two Cargo jobs.
- The run reports 144 final executions: 105 library tests, five ordinary parser tests, five view tests, 20 transport tests, five wrapper tests, two wrapper replays, one UTC parser producer/BSON replay, and one release benchmark. Some executions include dependency tests; this is not 144 unique cases.
- Full five-time-zone source proof `compiler-1793263458419267176` passed 1,362 parser cases in each of five zones but later failed Clippy. Within the parser's 32 bound files, only one replay test's initialization changed; all 31 other bindings stayed unchanged. Final tests also cover the PostHog condition and SDK-layout lint corrections. Final pinned Node run `node-1793265499179357802` passed in 18.266 seconds total / 17.007 seconds script time. It passed all four oracle/benchmark `--check` runs with input SHA unchanged, 1,042 wrapper records, two actual SDK payloads in one case, and 18 lifecycle scenarios. The original source SHA was `b6e1be19385b237964cefc9746f2832f994389843f293fd17a840c9098b55318`; source snapshot SHA is above. The 445 package files were copied for independent hash checks, not all claimed as require-cache dependencies.
- Four prior compiler attempts are retained: 8 GiB cache guard, two library lint findings, one HTTP fixture lint finding, and one parser fixture late-init lint finding. No native business behavior mismatch was found. Baseline files were recovered verbatim from fixtures or by reversing the documented lint changes. Each retained file matches its contemporaneous runtime SHA-256.
- Production readback found 19 containers unchanged; no task-owned containers, networks or volumes remained. No crate was added; the lockfile, defaults and worker profiles stayed unchanged. No caller adoption, retirement, push or deployment occurred.

Evidence: [verification summary](evidence/2026-10-29-posthog-receipt/verification-summary.json), [source binding](evidence/2026-10-29-posthog-receipt/source-binding.json), and [initial benchmark trials](evidence/2026-10-29-posthog-receipt/artifacts/initial-benchmark-comparison.json).

### Initial prepared-payload benchmark

The source-paired synthetic benchmark passed checksum parity for 192 source wires over seven trials, 32 varied inputs per pool, 32,000 warmups, 256,000 operations per regular trial and 32,768 for the large-message pool. Input SHA-256: `0ab05c2240b6af9f930b0a2824f89bb239d5cc4bd5e24cd6b866aa29ac753e4d`. Results are median microseconds per operation:

| Pool | TypeScript | Rust release | Rust change |
|---|---:|---:|---:|
| command | 2.4724 | 2.8084 | 13.6% slower |
| TTS | 3.1488 | 3.8980 | 23.8% slower |
| AI usage | 5.5308 | 10.3777 | 87.6% slower |
| AI operation | 4.5832 | 5.3293 | 16.3% slower |
| TTS Unicode | 4.4724 | 3.9722 | 11.2% faster |
| TTS large | 62.7729 | 10.1350 | 6.194× faster |

The timed region includes payload building, ordered JSON serialization and UTF-8 byte checksum. It excludes input/context setup, SDK metadata, queueing, HTTP and database work. This synthetic microbenchmark makes no CPU, RSS, end-to-end or production-latency claim. The later optimization authored in `JsString`, the lossless writer and PostHog payloads is unverified; no optimized performance result is reported.

## Completion accounting

The six-export local payload and lifecycle source mapping is implemented in native modules, with the boundaries above. This does not establish total migration completeness: broader billing, Polar ingestion, ledger persistence/reporting and their concrete application adapters remain open; the named transport compatibility differences also preclude strict source equivalence. Caller adoption and deployment are reported separately from dependency completeness. Neither new component is adopted by application callers or deployed, and no production release was requested or performed.
