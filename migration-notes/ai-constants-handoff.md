# AI constants Rust handoff (author-only)

Date: 2026-10-30
Owner: DeepSeek V4.1 Flash via OpenCode (implementation sub-agent)
Scope: `dimabot/src/utils/ai/constants.ts` only. No wiring, no retirement,
no deployment, no push.

## Status

Parent integration (2026-10-30): the user now prioritizes functional Rust migration before optimization. Benchmarks are deferred and are not an acceptance gate. The draft Node benchmark uses a VM realm despite its original normal-CommonJS description; it must be reviewed and corrected before any later performance comparison. No timing has been accepted. The parent wires the public `utils::ai_constants` module under the dependency-free `ai-constants` feature; tests exercise that module.

**Authored but UNVERIFIED.** Nothing in this handoff has been compiled, run,
timed, or committed by the author. `cargo fmt`, `cargo check`, `clippy`,
`cargo test`, and every Node invocation are parent-owned. Run formatting
before generating either fixture: both fixtures hash the Rust module, both
Rust tests, and this note, so any later edit (including `cargo fmt`) makes
`--check` fail by design.

* TypeScript source is untouched and still live.
* No `Cargo.toml`, `Cargo.lock`, `src/lib.rs`, `src/utils/mod.rs`, or
  `src/schemas/schema.rs` edit was made.
* No production resource, container, database, credential, or deployment was
  touched.

## Source identity

| Item | Value |
|---|---|
| Source | `dimabot/src/utils/ai/constants.ts` |
| Source SHA-256 | `7505c5481b8681c83ec57c8b89b856250bdd3970586810e900075d06fb5eb0f4` |
| Lines | 93 |
| Top-level statements | 16 (all exported) |
| Imports | none (direct and transitive dependencies are zero) |

Verified at authoring time with `sha256sum`; the oracle re-asserts the same
digest and fails on drift.

## Changed paths (all new)

| Path | Role |
|---|---|
| `dimabot/src/utils/ai/constants.rs` | Zero-dependency native port |
| `dimabot/tests/ai_constants.rs` | Ordinary tests + ignored actual-source replay |
| `dimabot/tests/fixtures/ai_constants_reference.cjs` | Pinned Node/TypeScript oracle |
| `dimabot/tests/fixtures/ai_constants_benchmark.cjs` | Prepared-operation Node benchmark + `--check` |
| `dimabot/tests/ai_constants_benchmark.rs` | Ignored release replay/benchmark |
| `migration-notes/ai-constants-handoff.md` | This document |

The two Rust tests include the module with `#[path]`, so they compile before
the parent decides any `utils/mod.rs` wiring. No existing file is modified.

## Dependency and type mapping

The TypeScript module has no imports and no type-only exports; every export is
a runtime value. Rust equivalents:

| TypeScript export | Native equivalent |
|---|---|
| `MODELS` | `Models` value `MODELS` + `Models::KEYS` / `entries()` |
| `selectChatModel` | `select_chat_model(Option<&str>, bool)` and `select_chat_model_value(PlanTierValue, bool)`; default `SELECT_CHAT_MODEL_DEFAULT_IS_EXHAUSTED = false` |
| `BACKGROUND_MODELS` | `BackgroundModels` value `BACKGROUND_MODELS` |
| `getBackgroundSummaryModel` | `get_background_summary_model(Option<&str>)`, `get_background_summary_model_units(&[u16])` |
| `BACKGROUND_MODEL_FALLBACK` | `BACKGROUND_MODEL_FALLBACK` |
| `MODEL_PROVIDER_RESTRICTIONS` | `MODEL_PROVIDER_RESTRICTIONS: &[(&str, ProviderRestriction)]`, `MODEL_PROVIDER_RESTRICTION_KEYS` |
| `getProviderRestriction` | `get_provider_restriction(&str)`, `get_provider_restriction_units(&[u16])` |
| `TOKEN_LIMITS` | `TokenLimits` value `TOKEN_LIMITS` |
| `CODING_MODELS` | `CodingModels` value `CODING_MODELS` |
| `MINIMAX_MODEL` / `MINIMAX_BASE_URL` | `&'static str` constants |
| `MINIMAX_COST_PER_M_INPUT` / `_OUTPUT` | `f64` constants plus `*_BITS: u64` (`0x3fe3333333333333`, `0x4003333333333333`) |
| `DEFAULT_TIMEOUT_MS` | `u32` constant `8000` |
| `EMBEDDING_MODELS` | `EmbeddingModels` value `EMBEDDING_MODELS` |
| `EMBEDDING_DIMENSIONS` | `EMBEDDING_DIMENSIONS: &[(&str, u32)]` + `embedding_dimensions(&str)` |

Additional surface for parity and observability:

* `EXPORTS: [&str; 16]` — the runtime export names in declaration order.
* `to_json_string()` and per-table `write_json`/`to_json_string` — emit the
  source-shaped JSON with declaration-order keys. Numbers use Rust's shortest
  round-trip `Display`, which matches `JSON.stringify` for these finite
  constants; `*_BITS` pins the binary64 pattern separately.
* `PlanTierValue` models absent, string, raw UTF-16, and non-string
  `plan_tier` values so malformed ordinary JSON contexts replay exactly.

Selectors return `&'static str` / `Option<&'static ProviderRestriction>` and
perform no heap allocation for ordinary string inputs. The code-unit paths
compare UTF-16 without allocating.

### Reuse review

* `utils::ai_credit_projection::PlanTier` and
  `get_ai_credit_limit_for_plan` are credit-limit policy behind the
  `ai-credit-projection` feature (which pulls `tts-utilities`, `plan-cache`,
  `sha2`, and Redis); they are not the chat/background model selector and are
  not reusable in a zero-dependency module.
* `utils::qdrant::types::{EMBEDDING_MODEL, EMBEDDING_DIMENSIONS}` hold the same
  `lfm2.5-embedding-350m` / `1024` values but live behind the `qdrant` feature
  (qdrant-client + tokio). Reusing them would add a whole client graph to a
  constants module, so the values are declared locally and the duplication is
  explicit.
* No other native module carries these model IDs, token limits, MiniMax
  scalars, or provider restrictions. `src/utils/ai/minimax/minimax_client.ts`
  duplicates the MiniMax scalars locally and does not import this module.

## Consumer adoption (unchanged)

Live TypeScript consumers at authoring time:

* `src/utils/ai/openrouter/messages.ai.ts` — `MODELS`, `TOKEN_LIMITS`,
  `selectChatModel`
* `src/utils/ai/openrouter/ai.ts` — `MODELS`, `TOKEN_LIMITS`, `selectChatModel`
* `src/utils/ai/openrouter/command.ai.ts` — `MODELS`, `TOKEN_LIMITS` (lazy
  `require`)
* `src/utils/ai/openrouter/embeddings.ai.ts` — `EMBEDDING_DIMENSIONS`
* `src/classes/embedding_batcher.class.ts` — `EMBEDDING_MODELS`
* `src/utils/ai/memory/stream_summary_decider.ts` — `BACKGROUND_MODEL_FALLBACK`,
  `getBackgroundSummaryModel`, `getProviderRestriction`
* `src/utils/ai/memory/stream_memory_runner.ts` — `getBackgroundSummaryModel`
* `src/utils/ai/tools/code_execution.tool.ts` — `CODING_MODELS`
* tests: `src/utils/ai/constants.test.ts`, `src/utils/ai_credit_status.test.ts`,
  `src/utils/ai/openrouter/ai.tools_disabled.test.ts`

`MINIMAX_*` and `DEFAULT_TIMEOUT_MS` currently have no TypeScript importer
(their near-duplicates are local in `minimax_client.ts` and
`sandbox/execute_sandbox.ai.ts`). They are still ported because they are
exports of the source module.

Caller adoption of the Rust module is zero. No TypeScript file was retired.

## Central wiring proposal (parent-owned, not applied)

The module is std-only and needs no Cargo feature. Suggested minimal wiring:

1. Create `dimabot/src/utils/ai/mod.rs` with `pub mod constants;` (or, if the
   parent prefers no new `ai` module yet, add
   `pub mod ai;` to `src/utils/mod.rs` and expose `utils::ai::constants`).
2. If a dedicated feature is preferred, add a zero-dependency feature:

   ```toml
   ai-constants = []
   ```

   and gate the module plus tests on it. Until then the tests use
   `#![cfg(feature = "ai-usage")]` only because they need `serde_json` for the
   external fixture; the production module itself requires no feature.
3. Replace the two `#[path]` includes with `use dima_rust::utils::ai::constants`
   once wired, and drop the temporary include lines. Keeping `#[path]` also
   works and avoids a duplicated crate export surface.

No other file needs editing for the module to compile.

## Exact invocations (parent executes)

All directories are external, task-owned, canonical, and empty for `--write`.
`DIMA_AI_CONSTANTS_SOURCE_ROOT` is optional and must point at the `dimabot`
project root when used (default: the fixture's frozen `../..`, and
`CARGO_MANIFEST_DIR` for Rust).

Reference oracle (no cargo):

```sh
export DIMA_AI_CONSTANTS_REFERENCE_DIR=/tmp/opencode/ai-constants-ref   # empty, external
node dimabot/tests/fixtures/ai_constants_reference.cjs --write "$DIMA_AI_CONSTANTS_REFERENCE_DIR"
node dimabot/tests/fixtures/ai_constants_reference.cjs --check "$DIMA_AI_CONSTANTS_REFERENCE_DIR"
DIMA_AI_CONSTANTS_REFERENCE_DIR="$DIMA_AI_CONSTANTS_REFERENCE_DIR" \
DIMA_AI_CONSTANTS_SOURCE_ROOT=/root/saas-rust/dimabot \
  cargo test --locked --features ai-usage --test ai_constants -- --ignored --nocapture
```

Ordinary tests (no fixture, no Node):

```sh
cargo test --locked --features ai-usage --test ai_constants \
  -- --skip replay_actual_source_oracle
```

Benchmark:

```sh
export DIMA_AI_CONSTANTS_BENCH_DIR=/tmp/opencode/ai-constants-bench      # empty, external
node dimabot/tests/fixtures/ai_constants_benchmark.cjs --write "$DIMA_AI_CONSTANTS_BENCH_DIR"
# capture inputSha256 from that output, then:
DIMA_AI_CONSTANTS_BENCH_DIR="$DIMA_AI_CONSTANTS_BENCH_DIR" \
DIMA_AI_CONSTANTS_BENCH_INPUT_SHA256=<inputSha256> \
DIMA_AI_CONSTANTS_BENCH_RUSTC_VERSION="$(rustc --version)" \
DIMA_AI_CONSTANTS_SOURCE_ROOT=/root/saas-rust/dimabot \
  cargo test --release --locked --features ai-usage \
  --test ai_constants_benchmark -- --ignored --nocapture
DIMA_AI_CONSTANTS_BENCH_INPUT_SHA256=<inputSha256> \
  node dimabot/tests/fixtures/ai_constants_benchmark.cjs --check "$DIMA_AI_CONSTANTS_BENCH_DIR"
```

Optional independent artifact pins for either Rust test (checked only when
set): `DIMA_AI_CONSTANTS_NODE_BINARY`,
`DIMA_AI_CONSTANTS_TYPESCRIPT_IMPLEMENTATION`,
`DIMA_AI_CONSTANTS_TYPESCRIPT_PACKAGE`.

Capped-compiler rule still applies: use the isolated `saas-ops` compiler
container, not host `cargo`.

Pinned runtime: Node `24.22.1`, V8 `13.6.233.17-node.58`, ICU `78.3`,
Unicode `17.0`, TypeScript `5.9.3`; Node binary SHA-256
`569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`,
TypeScript implementation
`3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675`,
TypeScript package
`822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6`,
`package.json`
`cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef`,
`package-lock.json`
`abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7`,
`rust-toolchain.toml`
`b9c8d2d59f6f46474c0cfa0b8b77bea21d94fc73a30ad93d5bf6385c422197d2`.

Both fixtures record `nativeHashes` for the TypeScript source, the Rust
module, both Rust tests, both Node fixtures, `tests/support/sha256.rs`, this
note, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `package.json`, and
`package-lock.json`. Regenerate the fixtures after any edit to those files;
`--check` fails on drift by design.

## Oracle and benchmark scope

The reference oracle:

* pins Node/V8/ICU/Unicode/TypeScript and every source/toolchain/package hash;
* parses the whole file, asserts 16 export statements in declaration order, no
  imports/`require`, typechecks it with strict settings, and records the
  signature and declared type text for every export;
* compiles the complete unmodified source to normal CommonJS in a `vm`
  context and executes it — no copied policy;
* records table key order and values, scalar values, binary64 bits, function
  arities, 72 `selectChatModel` cases (24 plan values × default/false/true),
  14 `getBackgroundSummaryModel` cases, and 29 `getProviderRestriction` cases;
* records explicit boundary records instead of asserting universal JS-object
  parity.

Benchmark comparison is a prepared-operation comparison: 4 workloads × 32
records, 20 warmup passes, 7 timed trials of 32 768 operations each, a full
source-golden preflight, and scalar (UTF-16 length) checksums. Node runs the
real compiled source in the timed region; Rust mirrors the same inputs with
`black_box`. Decoded arguments, pool JSON, and golden wires are prepared
outside the timed region. Harness dispatch (`name`-based branches in Node,
`workload` match in Rust) is included symmetrically and is not attributed to
either implementation.

## Recorded boundaries (not hidden)

1. **Prototype-chain provider lookup.** `MODEL_PROVIDER_RESTRICTIONS` is a
   plain object literal. `getProviderRestriction("__proto__")` returns
   `Object.prototype`; `"constructor"`, `"toString"`, `"hasOwnProperty"`,
   `"valueOf"`, `"isPrototypeOf"`, `"propertyIsEnumerable"`,
   `"toLocaleString"`, `"__defineGetter__"`, `"__lookupGetter__"`,
   `"__defineSetter__"`, `"__lookupSetter__"` return inherited functions. None
   satisfies `{ only: readonly string[] } | undefined`. The typed Rust API has
   own-entry semantics and returns `None`; the oracle records the raw source
   kind (`function`/`object`) and `Object.hasOwn === false` for exactly these
   keys. The parent decides whether this divergence is accepted.
2. **Runtime mutability.** `as const` and `Readonly<Record<...>>` are
   compile-time only; the runtime tables are mutable (`Object.isFrozen` false,
   recorded in the fixture). No source path mutates them; the native port
   exposes immutable statics. Mutation is outside the migrated contract.
3. **Non-boolean `isExhausted`.** Declared `boolean`. JavaScript truthiness for
   non-boolean arguments is outside the typed contract and is not replayed.
4. **Lone surrogate strings.** Not representable as Rust `&str`; they are
   replayed as UTF-16 code units. Such a string can never equal an ASCII
   table key or a plan-tier literal, so the source behavior (fallback/undefined)
   is reproduced exactly rather than approximated.
5. **`null` plan tier.** `getBackgroundSummaryModel` declares
   `string | undefined`; `null` is outside the declared type and maps to the
   same free fallback, so the native `Option<&str>` representation is
   behaviorally exact.

## Remaining closure gaps for this file

Local feature coverage is complete for the module's own contract: all 16
exports, all tables and selectors, exact binary64 values, key order, and the
documented serialization surface. Full migration closure for this file still
needs the parent to (a) wire the module, (b) execute the oracle and both Rust
tests, (c) accept or reject the prototype-chain boundary, and (d) adopt the
module in the nine live TypeScript callers or retire them under the project's
retirement policy. This handoff does **not** claim total `dimabot` migration
completion.
