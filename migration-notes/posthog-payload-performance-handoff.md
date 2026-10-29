# PostHog prepared-payload allocation handoff — 2026-10-29

Status: **PARENT-VERIFIED LOCAL FOLLOW-UP**. The historical author scope below was
static source reads, diff review, a baseline input SHA-256 readback and
`git diff --check`; no Cargo, rustfmt, Node, application, test, benchmark,
container, network or production command was run by the author. Parent
verification is summarized below. The source commits are local only; no push,
deployment or TypeScript caller adoption occurred. The broader Rust migration
remains incomplete.

## Parent validation update — 2026-10-29

The parent reports frozen source-tree hash
`d7032bf6e592fba5ab32915a47d6877ad7c546ecb9e345d0fbacdd3d9bce2056`, 1269
benchmark inputs and 192 prevalidated source payloads/wires. Formatting passed
(`format-1793271353735859186`); strict all-target/all-feature Clippy and four
numeric tests, including the 35,464-case engine replay, passed
(`compiler-1793271500335662854`); refreshed source oracles passed
(`node-1793271651768855999`); and focused/source plus benchmark verification
passed (`compiler-1793271803631923800`).

The broad shared-consumer run `compiler-fixtures-1793271955861772133` passed
against unchanged source hash `d7032bf6e592fba5ab32915a47d6877ad7c546ecb9e345d0fbacdd3d9bce2056`.
The parent reports 392 executions (not unique cases) across 45 result groups,
covering 228 library and ordinary checks, all five receipt timezone parser
checks, source replays, real-Redis producer/projection, emote runtime, and
no-default/all-features check plus Clippy. The script took 502.85 seconds and
the full phase 514.456 seconds; peak private cache was 8,127,803,392 bytes
(below 8 GiB), minimum available memory was 9,385,828,352 bytes, and all 19
production records were unchanged.

The emote actual-source log reported `source_replayed=57` and `source_skipped=9`
out of the current 66-case corpus (the old corpus had 65 cases before a
global-connect case was added). Do not describe this as a 66-case replay or
65-case full coverage. Bootstrap runtime checks cover a separate set;
skipped/unexecuted cases remain explicit. Final all-Node checks passed as
`node-1793272491713187942`, including five-timezone Mongoose fixtures. Schema,
domain and keyword-hydration checks passed as
`compiler-1793272783195663615`. Local commits are `b58fa296` for the numeric
correction and `beda3aee` for the four-file payload-performance change. The
evidence package is present at
[`evidence/2026-10-29-posthog-payload-performance/README.md`](evidence/2026-10-29-posthog-payload-performance/README.md)
and was independently read back: 157 files, 156 indexed blob hashes and 70
decompressed artifact hash/length checks passed. No push, deployment or caller
adoption occurred.
See the [dated performance follow-up](posthog-payload-performance-2026-10-29.md).

## Baseline and hypothesis

The parent verified and locally committed the starting implementations in
`cf2bd757` (JSON view), `f0ec266b` (receipt parser) and `77141415` (PostHog).
The preserved matched reports are in
`/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/posthog-receipt/attempt4/benchmark/`.
Their `input.json` SHA-256, independently read back by this author, is
`0ab05c2240b6af9f930b0a2824f89bb239d5cc4bd5e24cd6b866aa29ac753e4d`.
`node-report.json` and `native-report.json` retain all seven trials for each
32-input pool. The parent reported matched checksums and all 192 source wires.

| Pool | TypeScript median µs/op | Rust baseline median µs/op |
|---|---:|---:|
| command | 2.4724 | 2.8084 |
| tts | 3.1488 | 3.8980 |
| ai-usage | 5.5308 | 10.3777 |
| ai-operation | 4.5832 | 5.3293 |
| tts-unicode | 4.4724 | 3.9722 |
| tts-large | 62.7729 | 10.1350 |

These baseline measurements cover prepared builders, ordered JSON
serialization and a UTF-8 byte checksum. They exclude context/input
preparation, SDK metadata, queues, HTTP, CPU utilization and RSS. They do not
establish production latency. At handoff authoring time there was no candidate
timing result; see the dated parent update and linked comparison.

Static tracing identifies allocation work concentrated in the regressed small
payloads. `NativeUsageRecorded::prepare` built an owned context JSON object,
then an owned parameter JSON object; `ai_usage_recorded` cloned those values
again into the final 23-property payload. Each builder also built a temporary
vector of string/value pairs before collecting the final object, and converted
each literal output key into a heap-owned `JsString`. Finally the compact
writer allocated and sorted a reference vector for every object, even when all
its keys were nonnumeric and ECMAScript requires unchanged insertion order.
These are source-backed optimization targets, not allocation-profile or timing
measurements. The parent must test whether their removal fixes the regressions.

## Bounded implementation and reuse

Only these existing files and this new handoff are authored:

- `dimabot/src/utils/js_string.rs`: retain the private UTF-8 representation and
  ASCII cache, replacing its `String` with `Cow<'static, str>`. The additive
  `JsString::from_static` constructor borrows literal text. Ordinary `From<&str>`
  still owns its copy; `From<String>`, `from_units`, all slicing and trimming
  remain owned where they previously were. Static and owned strings use the
  same representation variant and content-derived equality/hash. No dynamic
  interning, global cache, new dependency or unsafe code is introduced.
- `dimabot/src/utils/posthog_tracking.rs`: literal keys use `from_static`, and
  the private object helper accepts arrays or iterators. Command, TTS, AI
  operation and identity builders use stack arrays. The existing usage mapping
  becomes one generic assembler; the plain source reads existing JSON values,
  while the typed source reads `AiUsageContext` and native parameters directly.
  Known enum text can also borrow static strings. There is one output mapping
  for both sources, and both still use the normal owned `JsonValue` and shared
  writer. Public `native_context` retains its API, field order, optional
  absence and direct raw numeric conversion.
- `dimabot/src/utils/lossless_json.rs`: compact object writing visits original
  fields directly only after proving no canonical array-index key exists.
  If any index key exists, it uses the original stable reference sort with
  exactly the original index classifier. Both branches call one object writer.
  Parsing, duplicate replacement, `get`, pretty output, number formatting and
  string escaping algorithms are unchanged.
- `dimabot/tests/posthog_tracking.rs`: focused tests for the two source access
  paths, including a full ordered golden payload/context and raw DTO values.

The plain API still rejects missing required fields and nonstring IDs/template
components in the same evaluation order. Optional absence/null, falsy channels,
empty text, non-declaration JSON casts, billing fallback, all source fields,
unpaired UTF-16 and raw binary64 bits are retained. SDK normalization/rejection,
queue/lifecycle behavior and concrete transport behavior are outside this
change. The numeric fallback preserves stable order for duplicate keys in
manually constructed objects; the nonnumeric path preserves every such pair
in insertion order. This does not collapse keys or switch to Serde values.

Authored unit invariants cover explicit static/owned/code-unit hash equality,
both HashMap lookup directions, HashSet identity, borrowing only static text,
Unicode trim and slicing, split-surrogate JSON and UTF-8 boundaries, append
semantics, empty objects, nonnumeric duplicate keys and canonical index limits.
Usage tests cover all 23 output keys/order, native-context optional absence,
raw schema/text, absent/empty/nonempty channels, -0, a NaN payload, infinities,
subnormal/max numbers, cast values and required-field error precedence. Existing
source-oracle and runtime suites remain the independent broader compatibility
checks. All new tests are unexecuted.

## Shared consumers and regression scope

The change to `JsString` affects every existing user of
`utils::js_string`, including code that continues to construct only owned
strings. The compact writer change affects every compact `JsonValue` object.
The applicable opt-in consumers are:

- PostHog payloads and lossless transport (`posthog-tracking`,
  `posthog-lossless`), including nested property values and transport metadata.
- The borrowed JSON view and AI usage receipt parser (`lossless-json-view`,
  `ai-usage-receipt-parser`), including key equality and lossless output/BSON
  boundaries. Their parser algorithms were not changed.
- AI receipt production and credit projection (`ai-usage-producer`,
  `ai-credit-projection`), which reuse these owned strings and JSON values.
- TTS normalization, tag types, settings, usage, credit fallback and pet speech
  composition (`tts-utilities`), channel TTS schema/settings
  (`channel-tts-settings`), and provider/catalog/runtime code (`tts-services`)
  through the service re-export of shared lossless JSON.
- Twitch emote text/slicing (`twitch-emotes`).

The AST evaluator has its own distinct UTF-16 `JsString` implementation; this
patch does not change that representation. No worker profiles, registry,
features, manifests, lockfiles, callers, benchmark inputs/harnesses or source
oracles were edited. Unrelated lock/parser-benchmark drafts remain untouched.

## Parent validation and matched benchmark

Every command below is a workload for the parent's already-authorized isolated,
capped compiler/Node snapshots, **never a host execution instruction**. Keep the
Rust guide's source isolation, CPU/memory/no-swap/headroom/cache limits and
production identity comparisons. Apply formatting to the four owned Rust/test
files in the isolated formatting workflow first; then freeze source hashes and
regenerate provenance-bound fixtures. Existing baseline evidence must remain
byte-exact. Changed shared-file hashes invalidate the old source fixtures even
where source behavior should be identical.

Focused compile/lint and ordinary tests, from the frozen repository root:

```sh
cargo fmt --manifest-path dimabot/Cargo.toml --all -- --check
cargo check --manifest-path dimabot/Cargo.toml --locked --no-default-features --features posthog-benchmark,ai-usage-receipt-parser,ai-usage-producer --all-targets
cargo clippy --manifest-path dimabot/Cargo.toml --locked --no-default-features --features posthog-benchmark,ai-usage-receipt-parser,ai-usage-producer --all-targets -- -D warnings
cargo test --manifest-path dimabot/Cargo.toml --locked --no-default-features --features posthog-tracking --lib utils::js_string::tests
cargo test --manifest-path dimabot/Cargo.toml --locked --no-default-features --features posthog-tracking --lib utils::lossless_json::tests
cargo test --manifest-path dimabot/Cargo.toml --locked --no-default-features --features posthog-tracking --test posthog_tracking
cargo test --manifest-path dimabot/Cargo.toml --locked --no-default-features --features ai-usage-receipt-parser,ai-usage-producer --test lossless_json_view --test ai_usage_receipt_parser --test ai_usage_producer
```

Refresh/replay all existing wrapper source cases and concrete lossless wrapper
replay with `POSTHOG_TRACKING_FIXTURES` set to the new exact-source directory;
refresh/replay the installed SDK/lossless fixture with
`POSTHOG_LOSSLESS_REFERENCE_DIR` set. Regenerate the receipt parser oracle and
run `replay_actual_source_parser_and_bson` in fresh processes for UTC,
America/New_York, Europe/Berlin, Australia/Lord_Howe and Pacific/Apia with
`DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR` set. The corresponding `--write` and
`--check` entrypoints remain unchanged in the existing fixtures. Run each final
Node `--check` again after Rust execution to guard artifacts/provenance.

Broaden shared-core regression checks to the relevant existing `js_string`,
`tts_utilities`, `tts_usage_pricing`, `tts_credit_fallback`, channel-settings,
provider/runtime, AI credit-projection and emote text suites in their existing
opt-in profiles. Use only their disposable fixture paths; do not acquire
default production runtimes. No source change here justifies running unrelated
workers or adopting any new native caller.

Use a fresh benchmark destination and independently obtain its new input SHA:

```sh
node dimabot/tests/fixtures/posthog_tracking_benchmark.cjs --write "$TASK_BENCH_DIR"
sha256sum "$TASK_BENCH_DIR/input.json"
POSTHOG_BENCH_DIR="$TASK_BENCH_DIR" POSTHOG_BENCH_INPUT_SHA256="<independent-new-sha256>" cargo test --manifest-path dimabot/Cargo.toml --release --locked --no-default-features --features posthog-benchmark --test posthog_tracking_benchmark -- --ignored --exact prepared_payload_benchmark --nocapture
sha256sum "$TASK_BENCH_DIR/input.json"
node dimabot/tests/fixtures/posthog_tracking_benchmark.cjs --check "$TASK_BENCH_DIR"
```

Keep the same six 32-input pools, warmups, operation counts, seven trials,
complete ordered source wires and UTF-8 checksums. New hashes must reflect the
new source; do not alter workload or harness to improve the result. Compare
each small pool and both Unicode/large controls with the preserved baseline;
retain raw trials and limitations before stating any result. The parent owns
verification, evidence reconciliation and any coherent verified local commit.
