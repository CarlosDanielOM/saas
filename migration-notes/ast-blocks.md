# AST blocks Rust core

## Scope and status

`dima_rust::utils::ast_blocks` is a pure, opt-in library port of the command
blocks validation, normalization, compilation, import, and storage-shape
boundary. The `ast-blocks` Cargo feature includes `ast-syntax` and `regex`; it
does not change a worker profile or add a worker. The API uses version 1 stored
blocks (`{ "v": 1, "root": ... }`).

All six approved library improvements and the 7,500 validated-node ceiling are
in scope. The TypeScript ceiling remains 4,000 and its callers remain active.
There is no TypeScript, API, route, service, editor, evaluator, runtime, or
production integration in this change. Callers will be migrated separately.

The final source snapshot passed capped quality verification and the paired
release benchmark. Quality and benchmark receipts report success, and all 136
source hashes recorded in the artifact match the current source snapshot. No
Rust source changed after verification. This remains a pure library release:
there is no caller integration or deployment.

## Source mapping and reuse

The existing syntax core is reused for parsing and template scanning rather
than adding a parallel parser:

- [`ast_syntax`](../dimabot/src/utils/ast_parser/syntax.rs) supplies the
  `SyntaxEngine`, prepared grammar, source segments, parser, and syntax errors.
  `BlocksEngine::default()` explicitly chooses
  `SyntaxProfile::TypeScriptCompatible`; callers can opt into Improved with
  `BlocksEngine::new(profile)`.
- TypeScript behavior is defined by
  [`ast_blocks/index.ts`](../dimabot/src/utils/ast_blocks/index.ts),
  [`types.ts`](../dimabot/src/utils/ast_blocks/types.ts),
  [`validate.ts`](../dimabot/src/utils/ast_blocks/validate.ts),
  [`normalize.ts`](../dimabot/src/utils/ast_blocks/normalize.ts),
  [`to_source.ts`](../dimabot/src/utils/ast_blocks/to_source.ts), and
  [`from_ast.ts`](../dimabot/src/utils/ast_blocks/from_ast.ts). The Rust block
  layer adapts those block-specific validation, normalization, source-writing,
  and AST-conversion behaviors around the reused syntax core.
- The eight Rust `ast_blocks` source files are `mod.rs`, `types.rs`,
  `validate.rs`, `normalize.rs`, `writer.rs`, `from_ast.rs`, `import_plan.rs`,
  and the module-local `tests.rs`. `import_plan.rs` retains source boundaries
  through root-context normalization and eligibility checks.
- Current [`command_blocks.service.ts`](../dimabot/src/server/services/command_blocks.service.ts)
  still validates saves with TypeScript `compileBlocks` and writes
  `storedBlocks(root)`. [`command.route.ts`](../dimabot/src/server/routes/command.route.ts)
  still uses TypeScript `importCommandText` for its existing request path.
  Neither caller is changed or wired to Rust.

## Approved Rust improvements

1. Each public operation has a bounded exact-source syntax cache. Identical
   canonical input can use a fast path without allocating a verification tree,
   generating verification IDs, or comparing the tree to itself. Logical
   syntax work is charged on cache hits as well as misses. Only immutable
   syntax programs and errors are cached; imported nodes and IDs are fresh for
   each import.
2. Structural equality compares block kinds and children while ignoring
   editor IDs and transient provenance. It does not serialize or hash JSON.
3. One bounded UTF-16-aware emitter writes output. Once output exceeds 10,000
   units it stops retaining bytes and only counts units, so errors can report
   total output without keeping an oversized output string.
4. The owned JSON reader moves strings from its input and validates once;
   normalization consumes the validated tree. The borrowed convenience
   reader clones once to share that validation path.
5. Import checks candidates in their final root context. Root normalization
   can dequote literals or spread template fragments, so eligibility, depth,
   and emitted-size checks apply to those normalized root fragments. Only
   eligible fragments remain editable. Unsupported, invalid, too-deep,
   over-budget, or non-round-tripping expressions become raw blocks with their
   exact original source piece. Source, token, aggregate-work, or whole-input
   exhaustion remains an operation error, not a raw fallback. Import planning
   repairs joined-literal escape boundaries and retries output once when a
   root-context join pushes output over the cap. Empty text and unavoidable
   literal backslash behavior can produce diagnostics rather than pretending
   every returned root can be saved.
6. Errors carry a structured code, message, optional `blockId`, and RFC 6901
   JSON pointer. Transient provenance survives normalization and merged text
   so errors can point to the originating block and field. Provenance is not
   serialized.

## API and validation boundary

Public entry points include borrowed and owned `read_block_root` and
`compile_blocks`, consuming `normalize_root` and `normalize_value`,
`structural_eq` and `structural_eq_root`, `import_command_text`, and
`stored_blocks`. `BlocksEngine` provides matching methods and import variants
that accept an explicit namespace or ID factory. `CompiledBlocks` returns the
normalized root, command text, and deterministic work statistics.

Serde is a wire-format convenience, not an untrusted-input validator.
`read_block_root` validates arbitrary JSON and discards unknown fields.
`stored_blocks(root)` accepts an already typed `BlockRoot`; callers handling
untrusted stored JSON must read and validate it first. Do not pass
unvalidated TypeScript input through a typed stored-data path.

Usage shape (illustrative; this README snippet is not part of the Cargo
doctests):

```rust,ignore
use dima_rust::utils::ast_blocks::{compile_blocks, stored_blocks};
use serde_json::json;

let compiled = compile_blocks(&json!({
    "id": "root-1",
    "type": "root",
    "children": [{ "id": "text-1", "type": "literal", "value": "Hello" }]
}))?;
let stored = stored_blocks(compiled.root);
assert_eq!(stored.v, 1);
```

## Profiles and resource bounds

The default block engine selects TypeScript-compatible syntax rules. Improved
syntax is an explicit profile choice. Both profiles use the block operation's
own syntax limits and the fixed block limits below. A syntax parse-node ceiling
is reconciled separately from `ast_syntax`'s default 4,000-node limit so that
the 4,000-node parser default does not prematurely reject a valid block tree.

| Resource | Block limit and accounting |
| --- | --- |
| Validated blocks | 7,500; root and accessor wrapper objects are excluded, synthesized empty ternary branches count. |
| Block depth | 48; root children start at depth 1. |
| Individual strings, imported source, emitted output | 10,000 JavaScript UTF-16 code units. Astral Unicode scalars count as two units. |
| Per-operation syntax source work | 320,000 UTF-16 units, aggregate across cache hits and misses. |
| Per-operation syntax nodes | 240,000 logical nodes, aggregate across cache hits and misses. |
| Per-operation syntax tokens | 480,000 logical tokens, aggregate across cache hits and misses. |
| One syntax program | 30,002 syntax nodes, 40,000 tokens, 10,000 source units, nesting 128. Block conversion separately enforces depth 48. |
| Retained emitted output | At most 10,000 UTF-16 units; `output_units` can report the larger rejected total. |

The default `SyntaxEngine` is held as immutable configuration in a process-wide
`OnceLock`. The mutable exact-source result cache and work counters belong to
one `Operation`; they are not global or shared between requests. A cache hit
avoids parsing, but its source, syntax node, and token costs still count toward
the operation's logical work caps. Syntax nesting is 128 and a single syntax
program has at most 30,002 nodes; root wrappers and discarded syntax nodes are
why this separate parse budget is larger than the block node quota. Final
materialization still checks the 7,500 block nodes and depth 48.

The emitter begins with an empty `String`. Before each retained append it
grows requested capacity with `reserve_exact`, capped at 30,000 bytes, the
maximum UTF-8 storage needed for 10,000 retained UTF-16 units. After the
10,000-unit output limit is crossed, it counts but does not retain further
output. This bounds requested output allocation; it is not a speed claim.

Import has two distinct failure policies. Per-expression parse/conversion,
depth, node, representability, or round-trip failures preserve that exact
expression as a top-level raw block and increment `advanced_count`. Source,
token, aggregate logical-work, or whole-input size exhaustion fails the
operation with a structured error. If the resulting text-only root is empty,
or contains a literal that cannot be saved without changing its meaning,
import returns the root with diagnostics where possible. These diagnostics
describe unavoidable source/empty-root limitations; they do not claim that
every returned tree can be saved.

## Source-oracle fixture and verification

The frozen TypeScript oracle contains 467 cases across read (281), normalize
(28), compile (96), import (39), stored (7), and structural equality (16).
Its corpus hash is
`15753dca4773e836e4bc49bed453c1087d834c49938a4c8cfd3ede5f4be0bb91`; the
fixture JSON SHA-256 is exactly
`6efd58734bd63d1c53acad063e30f7e5dc862a65b36c088507c339410a8bc34a`. It
records 448 source-parity cases, 11 approved node-limit
cases, two provenance cases, four invariant cases, and two import-fallback
cases. The 11 TypeScript source hashes and 14 benchmark definitions are
unchanged from the prior frozen source record. The 12 legacy test names and 40
assertions remain recorded. The evaluator is stubbed and must not be invoked.

The fixture records TypeScript's 4,000-node limit separately from Rust's
approved 7,500 limit. Rust boundary expectations accept 4,000, 4,001, 5,000,
7,499, and 7,500 nodes and reject 7,501. Root and accessor wrapper objects do
not count; synthesized empty ternary children do. Depth 48 is accepted and 49
rejected. The 10,000 UTF-16-unit string/source/output constraints remain
unchanged.

The source has 25 module-local block tests across `tests.rs` and `writer.rs`,
plus 12 integration tests. The final capped pipeline passed 163 test
executions across its invocations: 53 library tests (25 AST blocks, 27 AST
syntax, one JavaScript-compatibility test), 12 integration tests, and two doc
tests in the `ast-blocks` profile; 84 library tests and 12 integration tests
in the combined profile; and zero tests in the no-feature profile. These are
repeated executions, not 163 unique tests. All 467 oracle cases passed in
both tested profiles; this is the same 467-case corpus run twice, not 934
distinct cases.

The added regressions passed for root-normalized output expansion (9,605 to
12,000 units, which falls back), an expression-derived backslash literal
before a neighboring function, a transient quoted leaf at final block depth
48, and merged output overflow attributed to the actual child including
astral UTF-16 accounting. The root-template import depth regression was
confirmed red then green; eligibility is now applied to normalized root
fragments. The ordinary reader still validates before normalization, and
syntax nesting 128 / single-program 30,002-node limits remain separate. The
lazy output-capacity regression passed as well.

Formatting, all-target checks for no features, `ast-blocks`, and the combined
`permissions,bot-utils` profile, and Clippy with `-D warnings` for both tested
profiles passed. The TypeScript source-oracle `--check`, JavaScript syntax
checks and emitter, and all six timed runner invocations' pre/post semantic
checks passed with matching request and result checksums. Four worker dependency graphs
(`mongo`, `mongo-redis`, `dashboard`, and `supervisor`) match their baselines
after path normalization; `Cargo.lock` is unchanged.

The candidate and benchmark used 3 CPUs, a 4 GiB memory cap with no swap, 256
PIDs, two Cargo jobs, and an 8 GiB private cache. Applied limits were verified.
Minimum available memory was 11,522,506,752 bytes during quality verification
and 11,869,696,000 bytes during benchmarking; peak private-cache use was
544,280,576 and 543,309,824 bytes respectively. The quality receipt reports
27 monitor samples; the benchmark receipt reports 20. Both receipts report
success with no cleanup errors.

The implementation exposes deterministic stats including parse calls, cache
hits, structural comparisons, retained/total output units, syntax work, and
validated nodes. These counters are evidence fields, not timing or performance
claims. The final receipts and raw logs are retained under
`/root/.local/state/rust-ast-blocks-20261025-_kooo13r/artifacts/`; the tracked
benchmark artifact contains the frozen source hashes, test-execution totals,
paired measurements, cleanup state, and production comparison summary.

## Paired release benchmark

The [tracked benchmark artifact](../dimabot/benchmarks/ast-blocks-2026-10-25.json)
records 21 paired operation medians: ten text fixtures each have separate
public import and borrowed compile operations, plus one empty-ternary compile.
Three verification-only definitions are excluded. Rust used release mode
(rustc 1.99.1, `x86_64-unknown-linux-musl`); TypeScript used Node 24.22.1 and
TypeScript 5.9.3. Both used the TypeScript-compatible profile, identical
requests, 50 iterations, 20 warmups, seven batches, and three serial
Rust-then-TypeScript rounds. Each median is the median of 21 batch means.

Compile JSON inputs were prepared before timing, but the borrowed compile API's
input clone is timed. Each operation includes allocation, validation,
normalization, emission, cache construction/teardown, natural import IDs,
output destruction, and runtime GC. Request parsing, transpilation/loading,
shape conversion, semantic checks, checksums, and JSON output are outside the
timed region. Import and compile are independent operations; do not sum their
medians into a chained-workflow result.

Rust had the lower median in 19 of 21 operations. The two slower Rust medians
were plain import (6.40 vs 6.22 µs, about 3% slower) and `array-looking text`
import (6.00 vs 4.84 µs, about 24% slower). The fixture named `array` is bare
`%[...]` chat text outside an expression introducer, so the scanner treats it
as a literal. That row measures literal handling, not array-block conversion;
array blocks are covered by parity and unit tests.

| Fixture | Import Rust µs | Import TS µs | TS/Rust | Compile Rust µs | Compile TS µs | TS/Rust |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `typical-mixed` | 26.35 | 74.97 | 2.85× | 13.50 | 89.95 | 6.66× |
| `plain` | 6.40 | 6.22 | 0.97× | 3.72 | 11.49 | 3.09× |
| `dense100` | 639.48 | 1,908.87 | 2.99× | 525.47 | 1,550.10 | 2.95× |
| `dense500` | 2,892.15 | 9,069.03 | 3.14× | 3,003.75 | 7,272.62 | 2.42× |
| `unique-expressions` | 33.61 | 134.88 | 4.01× | 25.78 | 118.41 | 4.59× |
| `canonical-quotes` | 16.32 | 80.48 | 4.93× | 9.79 | 33.48 | 3.42× |
| `noncanonical-quotes` | 27.33 | 39.08 | 1.43× | 10.36 | 33.64 | 3.25× |
| `loop` | 19.47 | 132.36 | 6.80× | 30.84 | 115.97 | 3.76× |
| `array-looking text` | 6.00 | 4.84 | 0.81× | 3.58 | 8.40 | 2.35× |
| `deep40` | 141.96 | 320.02 | 2.25× | 173.52 | 275.29 | 1.59× |
| `empty-ternaries` | — | — | — | 9.43 | 42.52 | 4.51× |

These are local synthetic measurements on a shared production host with fixed
runner order and different allocators and garbage collectors. They do not
establish production latency, cover every block type, or isolate the effect of
any one optimization. The switch from eager output allocation to capped lazy
`reserve_exact` growth is a benchmark hypothesis, not a sole-cause result; no
isolated A/B comparison was run.

## Cleanup and production comparison

Cleanup succeeded for all 12 task snapshot states. Task-owned compiler
containers are gone; no Cargo, target, or format-copy caches remain. No images
were created, the pinned toolchain image was retained, and frozen source
snapshots, baselines, logs, and receipts remain available. The final
production comparison found all 19 containers unchanged in IDs, images,
start times, restart counts, mounts, and Compose ownership. No deployment,
runtime caller adoption, or production behavior change occurred.

The TypeScript 4,000-node limit and existing API/UI behavior stay active until
a separately reviewed caller migration. This library task has no runtime
integration or production deployment.
