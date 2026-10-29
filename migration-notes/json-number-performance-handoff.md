# Shared number spelling correction and fast path — 2026-10-29

Status: **PARENT-VERIFIED LOCAL CANDIDATE; BROADER MIGRATION INCOMPLETE**.
This bounded task owns only `dimabot/src/utils/json_number.rs`,
`dimabot/tests/json_number_parity.rs`,
`dimabot/tests/fixtures/json_number_reference.cjs` and this handoff. Static
reads, source/hash readback, reviewed diffs and whitespace checks are the
author's verification scope; the author did not run Cargo, rustfmt, Node,
application, test, benchmark, container, network or production commands.
Parent validation is summarized in the dated update below. The numeric
correction and shared-consumer checks passed and were locally committed. No
push, deployment or TypeScript caller adoption is claimed.

## Parent validation update — 2026-10-29

The parent reports that the corrected shared number formatter passed the
35,464-input pinned engine replay, including the two decimal tie regressions
that exposed the first candidate's pre-existing `Display` mismatch. Parent
receipts: strict all-target/all-feature Clippy and four numeric tests, including
the full replay, passed as `compiler-1793271500335662854`; refreshed source
oracles passed as `node-1793271651768855999`; focused/source and benchmark
checks passed as `compiler-1793271803631923800`. The earlier format receipt is
`format-1793271353735859186`, and the numeric oracle generation/check receipt
is `node-1793271430176465107`.

The broad shared-consumer run
`compiler-fixtures-1793271955861772133` passed against the unchanged frozen
source. Final all-Node `--check` passed as `node-1793272491713187942`, including
the benchmark check, unchanged 35,464-case numeric corpus, source fixtures and
fresh five-timezone Mongoose fixtures. Scoped numeric-consumer checks passed as
`compiler-1793272783195663615`. The numeric correction was committed locally
as `b58fa296`; the four-file payload-performance change was committed as
`beda3aee`. No push, deployment or caller adoption occurred. The detailed
benchmark and source-hash account is in
[`posthog-payload-performance-2026-10-29.md`](posthog-payload-performance-2026-10-29.md).

## Parent context and implementation

The parent reports that the preceding shared-string/writer/PostHog assembler
candidate passed its focused checks, with five of six matched prepared-payload
pool medians lower than TypeScript. Its AI-usage median remained 5.8423 µs/op
versus TypeScript's 5.5308 µs/op (the original Rust baseline was 10.3777 µs/op).
These are parent-supplied prior observations, not results of this patch. The
existing workload, source wires, harness, timing method and baseline artifacts
must remain unchanged when the parent measures this candidate.

Static reuse discovery found that `number_string` is already the common
binary64-to-JavaScript-text boundary. The remaining allocation gap is that
ordinary fixed-point scalars also create a dot-stripped digit string and
formatted normalized output. AI-usage prepared payloads contain eight numeric
fields. This is an optimization hypothesis, not an allocation measurement.

The first candidate returned a guarded fixed-point `abs().to_string()` seed,
preserving the legacy normalization's behavior. The engine oracle exposed a
pre-existing shortest-decimal tie defect in that seed. The parent explicitly
requested the corrective seed change described below; preserving those legacy
mistakes is no longer this candidate's contract.

The corrective candidate handles nonfinite values and signed zero first, then
uses `(n as i64).to_string()` only when `n` is finite, integral and its magnitude
is at most `2^53`. The cast is exact and safe throughout that bounded domain,
and ECMAScript uses ordinary integer notation there. The bound must remain:
the binary64 integer exactly equal to `1000000000000000128` has JavaScript
shortest text `1000000000000000100`, so unbounded integer formatting is wrong.

Every other finite value uses exactly one existing
`serde_json::to_string(&magnitude)` digit seed, without a Value conversion,
JSON parse, second formatting attempt or new crate. For magnitudes in
`[1e-6, 1e21)`, an exponent-free spelling can be returned directly after
removing only an integral `.0` suffix, if present. Removing that suffix preserves
the represented integer. Other fractional trailing zeros still require the
legacy normalization; integer trailing zeros are retained. The exponent and
fractional-zero shape guards remain explicit because the serializer's notation
policy is not the ECMAScript contract.

The legacy decimal/scientific normalization after that branch is unchanged,
now consuming Serde's seed rather than Display's. `-0` still becomes `0`, String
NaN/infinities retain their JavaScript spellings, and lossless JSON emits `null`
for nonfinite values. The `1e-6` threshold is inclusive; `1e21` is exclusive.
No rounding adjustment, handwritten formatter, dependency, unsafe code or
coercion change was introduced. `to_number`, `string_number` and radix policy
are untouched. At handoff authoring time corrective parity was unverified; the
parent's completed replay and corpus-immutability evidence are recorded above
and in the linked dated note.

The pre-edit `json_number.rs` SHA-256 read by this author was
`002c39884ee1aa624cb200af77f8a6ddb694d31efd51b5ec318ebf9286845192`.
The parent's four preceding candidate files were read back without editing:

| File | SHA-256 at task start |
|---|---|
| `dimabot/src/utils/js_string.rs` | `17b3e6a6bcd0d92210851eca25da44bbcdb2c2d9e196feb5dab58d06b75d4aed` |
| `dimabot/src/utils/lossless_json.rs` | `ec527f127bc44725a25be2624033cac077bc62e5bf1e06333924ba5aff16fe6a` |
| `dimabot/src/utils/posthog_tracking.rs` | `e9e5a3170b420771c3688c52c2128828acf0e8fa810881c405fbfd62c1db7c10` |
| `dimabot/tests/posthog_tracking.rs` | `02d167ca49bd117a6bd1d74a2211c650631318eacd4f22a296566b47f33ea786` |

## Parent failure and root-cause diagnostic

The parent generated and replayed the complete pinned **35,464-case** engine
corpus in an isolated capped environment. Strict Clippy and the two first
candidate ordinary tests passed, but the ignored engine replay failed **53
cases: 51 ordinary and two scientific**. That candidate was not accepted.
Parent evidence identifies compiler run `1793270379734265688` and frozen
source digest
`adc148dd923e4d1f8de7958f59cc761cfeb8019380fd4fd7c28c18b705b8322d`.

| Raw binary64 bits | Display/legacy text | Pinned engine text |
|---|---|---|
| `430c6bf526340002` | `1000000000000000.3` | `1000000000000000.2` |
| `c30c6bf526340002` | `-1000000000000000.3` | `-1000000000000000.2` |
| `3e60000000000000` | `2.9802322387695313e-8` | `2.9802322387695312e-8` |
| `be60000000000000` | `-2.9802322387695313e-8` | `-2.9802322387695312e-8` |

The parent's bounded diagnostic reproduced all **53** String differences with
the exact original `number_string` body from commit `77141415`, whose file
hash is the pre-edit hash above. Changing only the shortest digit seed to
`serde_json::to_string(&n.abs())`, while retaining legacy normalization,
produced **zero String differences across the same 35,464 inputs**. This
isolates a pre-existing Display/V8 tie-breaking difference. It is a diagnostic
of a seed substitution, not verification of this corrective fast-path code,
the native JSON writer or performance.

Public diagnostic artifacts are under
`/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/posthog-payload-performance/number-diagnostic/`:

| Artifact | SHA-256 read by this author |
|---|---|
| `probe.rs` | `123db3fcdb22ffa5ea44220628c22dbec6f6510e9de09091ece45b083483bd14` |
| `source-proof.json` | `ed22a2a509717597bfea043302ef46c2a72cbd97c7c6f774ba9794ffa4ace83a` |
| `report.json` | `e3214da9dbca639829cf98e3da31355639aa17cbee2f6ae42064895715fe18a1` |

The read-only tool source
`/tmp/dimabot-full-migration-tools/number_tie_probe.rs` had the same hash as
`probe.rs`. The author inspected the complete diagnostic source, source proof,
report and affected raw-bit engine fixture records without executing them.
The parent's formatting changes to the existing parity reader were preserved.

## Engine oracle and replay

The new oracle requires exactly Node `v24.22.1`, V8
`13.6.233.17-node.58` and TypeScript `5.9.3`. TypeScript transpiles a complete
two-function reference whose bodies directly call the real engine's
`String(value)` and `JSON.stringify(value)`. There is no copied native
formatter, mathematical decimal reimplementation or application-module load.
Every fixture input is a 16-digit raw binary64 hex string; both expected wires
are retained as strings, including nonfinite JSON `null` and signed-zero
normalization. The generator uses no `Math.random`, environment configuration,
secrets, network or services.

The deterministic corpus includes signed zeros, quiet NaN payloads,
infinities, min/max subnormal and min-normal/max-finite values; both signs of
the four bit neighbors on each side of `1e-6` and `1e21`; ordinary scalars;
known integer/shortest-fraction stress cases; decimal powers from `1e-323`
through `1e308` and binary powers from `2^-1074` through `2^1023`, with bit
neighbors; 8192 seeded finite patterns across the full exponent range; and
8192 seeded fixed-point patterns. Inputs are deduplicated with group membership
retained. The parent observed 35,464 cases; the unchanged broad-corpus guard
still requires more than 30,000. **The oracle, generator, cases, coverage and
wire expectations have not been edited or filtered in this corrective turn.**
Its source SHA-256 remains
`90668e6f1fb62f8ddc4b156df35e61baa2982028cd78fdbeb072f02bd89f3912`.

`--write` requires a precreated task-owned directory and exclusively creates
`json-number-reference.json` with `wx`; it cannot replace prior evidence.
`--check` regenerates and compares the entire nonempty artifact byte-for-byte.
The fixture embeds full source bytes plus SHA-256 hashes for the manifest,
Rust/npm locks, package, toolchain pin, library/module wiring, shared number,
string and JSON sources, native reader/test and oracle itself. It also records
the actual Node executable path/hash, TypeScript package source/hash and
compiler hash, complete reference TypeScript/emitted JavaScript and their
hashes. The native reader compares all 13 repository source files against its
compile-time snapshot and checks the seven native hash entries. No hashing
dependency is added to `tts-utilities`; the parent's Node `--check` authenticates
the recorded digests/toolchain against the current pinned reference environment.

The new test file is gated by existing `tts-utilities`, which already exposes
both modules; Cargo discovers the integration test without manifest or central
wiring edits. The original two ordinary tests cover known fixed/scientific
boundaries, negative forms, signed zero and separate String/JSON nonfinite
policies. A new explicit regression test uses the two parent-observed tie bit
patterns above for both signs, plus `2^53-1`, `2^53`, the next representable
integer above `2^53`, and the `1000000000000000128` integer example for both
signs. It checks both String and lossless JSON against the unchanged pinned
engine artifact's exact wires. These new regressions have not run.
The ignored `replay_every_binary64_engine_wire` requires the explicit fixture
directory and fails for absent, empty, truncated or stale source fixtures.
It compares every oracle String result with `number_string`, every JSON result
with `JsonValue::Number::to_json_string`, and checks scalar pretty/append
consistency. It verifies unique raw bits, group counts and all signed notation
threshold neighbors. Mismatch diagnostics retain raw bits, both actual/expected
wires, ordinary/fallback counts and up to twelve examples from each interval.

The full unchanged oracle must pass for the corrected shared formatter,
including all scientific/subnormal and negative controls. If any discrepancy
remains, preserve and report it rather than adding tolerances, rounding,
filtered cases or weaker expectations. Source metadata must be regenerated
after the final source freeze because the native formatter and reader changed;
the parent must independently prove every raw input, coverage label and exact
String/JSON wire is unchanged from the first 35,464-case artifact.

## Affected consumers and unchanged production profiles

Reuse tracing found direct shared consumers in the AST evaluator, application
schemas/BSON conversion, TTS settings and fish voice catalog, domain-event
contracts/delivery checks, and lossless JSON. Credit/reward normalization uses
the same module; lossless JSON extends this formatting boundary to PostHog,
borrowed JSON views/receipt parsing, usage production/credit projection and
other TTS consumers. Existing broader source oracles must be refreshed for the
changed number-source hash without changing their accepted wire behavior.

The seven deployed worker binaries use the existing `mongo`, `mongo,redis` or
dashboard `mongo,redis,http-client,unicode-collation` profiles. None enables a
`json_number` feature gate. The cron index's `cron-supervisor` profile also
does not enable it. In particular,
`src/utils/ai_usage_receipts/values.rs` has its own local formatter and
`src/utils/raid_sessions/values.rs` has a separate `js_number` using Display.
Both remain untouched. They may have the same pre-existing decimal tie issue;
this shared-formatter correction does not fix or runtime-test those worker
copies. Separate Display-based helpers also remain in logger, permissions and
Qdrant. This is a bounded scope limitation, not evidence of a production
incident or authority to edit worker files. There is no worker migration,
pacing, profile, registry, deployment or production-behavior change in this
patch. No other candidate files,
features/defaults, Cargo/npm manifests/locks, benchmark files or harnesses were
edited.

Static author checks: the tracked formatter diff passed `git diff --check`;
a whitespace scan across all four authored files exited zero with no trailing
blank or carriage-return matches. New-file `git diff --no-index --check`
readbacks produced no whitespace diagnostics. Final readback confirmed the
four preceding candidate hashes above were unchanged. These checks do not
establish corrective Rust/CJS syntax, compilation, runtime parity or speed.

## Parent verification commands

The following are workloads for the parent's existing isolated, capped,
read-only source snapshot and pinned Node environment, **never instructions
for host Cargo/Node execution or production-container execution**. Preserve
the Rust guide's CPU, memory/no-swap, headroom, disk/cache and production
identity checks. Apply any formatting only to the owned Rust files in the
isolated workflow, then freeze source identity before generating fixtures.

From the frozen repository root, in the capped compiler:

```sh
cargo fmt --manifest-path dimabot/Cargo.toml --all -- --check
cargo check --manifest-path dimabot/Cargo.toml --locked --no-default-features --features tts-utilities --test json_number_parity
cargo clippy --manifest-path dimabot/Cargo.toml --locked --no-default-features --features tts-utilities --test json_number_parity -- -D warnings
cargo test --manifest-path dimabot/Cargo.toml --locked --no-default-features --features tts-utilities --test json_number_parity
```

This now runs three ordinary tests, including the new tie/integer-boundary
regressions. A prior first-candidate ordinary/Clippy pass does not validate
the corrective candidate. The parent can run the new regression against its
preserved rejected snapshot to confirm failure before the corrected run.

The parent precreates a fresh owned `TASK_NUMBER_ORACLE_DIR`, then in the
pinned reference environment runs:

```sh
node dimabot/tests/fixtures/json_number_reference.cjs --write "$TASK_NUMBER_ORACLE_DIR"
node dimabot/tests/fixtures/json_number_reference.cjs --check "$TASK_NUMBER_ORACLE_DIR"
sha256sum "$TASK_NUMBER_ORACLE_DIR/json-number-reference.json"
```

Mount that exact public fixture read-only into the capped native environment
and set `DIMA_JSON_NUMBER_REFERENCE_DIR` to its in-environment path:

```sh
cargo test --manifest-path dimabot/Cargo.toml --locked --no-default-features --features tts-utilities --test json_number_parity -- --ignored --exact replay_every_binary64_engine_wire --nocapture
```

Rerun Node `--check` and fixture SHA-256 afterward. Record the exact source
snapshot, toolchain and native test-binary identity with the existing parent
verification evidence. Missing-fixture and stale-fixture negative controls
should use disposable copied artifacts and separate processes, preserving the
original artifact. An ordinary test pass does not execute the ignored oracle.

The parent also owns its planned broader regressions: existing AST evaluator,
schema contracts, domain contracts, TTS utility/settings/catalog/provider,
PostHog/lossless JSON and dependent receipt/credit paths in their existing
opt-in profiles. Do not expand this to unrelated deployed workers. Regenerate
and check source-bound fixtures after the final format/source freeze.

For performance, use the parent's existing matched benchmark and audited
native-only hash rebind, preserving the same input bytes, all expected ordered
wires, six pools, operation counts, warmups and seven trials. Do not replace
or edit the benchmark input/harness or infer a gain from this static change.
Compare all pools and controls, retain raw trials and report any remaining
AI-usage regression. The parent owns all runtime checks, review, source freeze
and any subsequently authorized verified local commit; this author has made
none.
