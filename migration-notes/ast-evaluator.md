# Opt-in Rust AST evaluator

Task date: 2026-10-25. Final-source quality, release benchmark, independent review, and cleanup receipts completed successfully on 2026-10-26 UTC. `acceptanceComplete` is `true` in the final artifact. This utility has no live callers, adapters, worker-profile changes, or deployment.

## Scope and design

The opt-in `ast-evaluator` Cargo feature composes `ast-syntax` with `permissions`; it does not change default features, worker profiles, the TypeScript evaluator, or an existing caller. The Rust module has eight source files and 17 local tests. Its optional context builtins are only `count`, `scount`, `bits`, `break`, and `continue`; the source oracle covers their 117 cases. Twitch functions and other handlers remain caller-owned host callbacks. No bridge into existing TypeScript callers, Twitch actions, or durable timer runtime is included.

The six approved utility improvements are:

1. Reuse immutable compiled plans for exact post-substitution source; callers perform substitutions before compile, and there is no output cache.
2. Use scoped copy-on-write loop frames. `LoopVars` is not a linked history. It avoids copying the whole map per body node; actual copy-on-write detaches on mutation are counted in `loop_map_copies`.
3. Interpret pure nodes synchronously and await only explicit host operations. There are no per-node futures; argument and other source ordering remains sequential.
4. Decode stored arrays within one evaluation, keyed by exact raw string. The memo evicts at 64 entries or 1,048,576 raw UTF-16 units; a value that cannot be retained is evaluated uncached, not refused. Callers get detached mutable arrays and independent parse objects.
5. Inject the host contract for functions, cache, persistence, response saving, scheduling, and randomness. Each run gets fresh request-local state; host operation order stays explicit.
6. Centralize JavaScript-compatible coercion, JSON handling, and UTF-16 strings.

The value and context graph uses `Rc<RefCell<...>>` and local-task `!Send` futures. Immutable `Engine` instances and syntax plans can be reused, but each independent run needs a fresh context and request-local memo. Future HTTP or multithreaded caller adoption requires local evaluator executor/context integration; this work provides no runtime bridge. Do not assume compatibility with an arbitrary Axum future. The explicit UTF-8 identity boundary remains checked. Plain JSON cannot mint the opaque host effect-authority token.

## Source compatibility boundaries

The default syntax profile is TypeScript-compatible. The port makes no array or argument-order semantic changes: preserve the distinct array-access and foreach interpretations, and evaluate function arguments left to right before unknown-function resolution and permission checks. For command references, depth, visited-command, and budget guards run before arguments; a second budget check follows argument evaluation. Timer duration is evaluated with authority removed, its body remains deferred, and scheduling receives a data snapshot. Errors that the source returns as output remain values; ordinary host throws remain errors except at source catch sites. Root joins and template joins remain different.

Typed plain data preserves `undefined`, non-finite numbers, negative zero, and lone-surrogate UTF-16 strings. JavaScript callables, prototypes, and `BigInt` remain outside the API domain; the unknown AST tag is an explicit source-only boundary. Keep source quirks rather than implying fixes.

## Quality verification

The final-source artifact records successful quality and benchmark receipts with verified source hashes and applied resource limits. All 149 project hashes and all 23 TypeScript source/test hashes match the current checkout. Quality checks recorded 188 test executions across profiles and repeats, with invocation counts `[59, 13, 2, 101, 13, 0]`; these are executions, not 188 unique tests. The final 3,563-case corpus contains 3,554 supported cases and nine unchanged named source-only boundaries. Both profiles exercise the same supported case set; repeated profile runs are not additional distinct corpus cases. Thirty-six appended source cases add 23 DB-user cases and 13 event-data spread cases; all 3,527 prior source facts and 16 benchmark definitions remain unchanged. Four worker dependency graphs (`mongo`, `mongo-redis`, `dashboard`, `supervisor`) matched their baselines. The Cargo lockfile was unchanged.

The final oracle pins 23 TypeScript source/test files and retains all nine source-only boundaries by name. Corpus SHA-256: `bd740c545bb9d220bab003130f4955dc58d9db1cce2832b45bc503fd0b569bf5`; structural manifest SHA-256: `23498621d361787d44eb2d07915f370101f80d3395d0827c47738b3812deeb43`.

## Release benchmark

The source side used the TypeScript-compatible profile. The prepared evaluation benchmark used three serial Rust/TypeScript pairs. Each side had 20 warmups and 50 iterations in each of seven batches; reported medians aggregate the three per-run medians, where each per-run median is over seven batch samples. Each timed operation included setup of a fresh context, fake host, and seeded RNG, followed by prepared AST/template evaluation. Source loading/transpilation, parsing/compilation, wire decode, normalization, checksumming, and output serialization were outside the timed operation. The `prepared-render40` TypeScript workload assembles the actual source scanner/parser/evaluator primitives; it is not the unchanged `render.ts` entrypoint. Cold compile/render and full renderer timing are excluded. The synthetic harness used no real storage, network, delays, Twitch handlers, or production traffic.

Fourteen of the 15 prepared workloads had lower Rust medians. The ratio is TypeScript median divided by Rust median. Times use microseconds (µs) below 1 ms and milliseconds (ms) at or above 1 ms. `array-write-invalidate` is the exception: Rust measured 186.715 µs versus TypeScript at 172.356 µs, about 8.3% higher elapsed time for Rust on this fixture.

| Workload | Operation | TypeScript median | Rust median | TS/Rust |
| --- | --- | ---: | ---: | ---: |
| `literals100` | evaluate | 155.665 µs | 47.525 µs | 3.28× |
| `arithmetic100` | evaluate | 507.467 µs | 180.146 µs | 2.82× |
| `arithmetic500` | evaluate | 1.844 ms | 1.032 ms | 1.79× |
| `template100` | evaluate | 451.183 µs | 146.909 µs | 3.07× |
| `prepared-render40` | preparedRender | 246.615 µs | 81.835 µs | 3.01× |
| `loop-small` | evaluate | 100.698 µs | 38.812 µs | 2.59× |
| `loop-nested` | evaluate | 192.704 µs | 120.170 µs | 1.60× |
| `loop-seeded100-manybody` | evaluate | 1.430 ms | 254.438 µs | 5.62× |
| `array-memory-length100` | evaluate | 275.000 µs | 126.019 µs | 2.18× |
| `array-memory-index100` | evaluate | 359.173 µs | 181.219 µs | 1.98× |
| `array-db-length100` | evaluate | 250.552 µs | 106.294 µs | 2.36× |
| `array-db-index100` | evaluate | 246.146 µs | 198.634 µs | 1.24× |
| `sequential-handlers50` | evaluate | 217.667 µs | 159.693 µs | 1.36× |
| `array-write-invalidate` | evaluate | 172.356 µs | 186.715 µs | 0.92× |
| `foreach10` | evaluate | 99.953 µs | 59.956 µs | 1.67× |

The scoped source review found two actual compatibility failures: a DB-user memo key containing a lone surrogate failed at `to_utf8`, and command-reference event data did not match JavaScript enumerable-property spread. The exact two-case red probe failed on both; both corresponding final regressions are green. The DB-user memo now uses `OrderedMap<T, K = String>` / `SharedMap<T, K = String>`, with only `user_command_variables` keyed by `JsString`; native identity fields keep their checked UTF-8 boundary. Queued `eventData` now spreads enumerable object properties, array indices, and individual UTF-16 string units, shallowly, then overlays chatter fields while preserving property position. `Engine::with_syntax` explicitly selects an Improved/custom syntax engine; default/new retain the TypeScript-compatible syntax guard and defaults. These are source-backed fixes, not performance findings. The prepared medians remain synthetic: they do not establish production latency or throughput, do not isolate the contribution of any one improvement, and do not establish production resource use. Measurement date is 2026-10-26 UTC; the task-date filename remains `ast-evaluator-2026-10-25.json`.

## Acceptance and adoption

The [final quality, benchmark, review, and cleanup artifact](../dimabot/benchmarks/ast-evaluator-2026-10-25.json) records `acceptanceComplete: true`; all 149 project hashes and 23 TypeScript source/test hashes match the final source. The bounded independent R2 recheck covered UTF-16 memo keys, enumerable event-data spread, and explicit syntax selection, found zero actionable findings, and is not a broad audit. Its source-traced report is archived at `/root/.local/state/rust-ast-evaluator-20261025-r_q7syyi/artifacts/ast-evaluator-safety-review-r2.md` (SHA-256 `18323fe155c098c4901be3d808a524f0ae492b9ea09c7aad04298b53c309bfce`). The earlier R1 review found two source-backed defects; the exact two-case red probe failed before fixes, and both final regressions are green.

Cleanup completed across 10 task states: 17 Cargo/target/format-copy directories and seven duplicate temporary benchmark/fixture copies were removed, zero evaluator task containers remain, and the task Cargo target cache and format-copy bytes are both zero. Source snapshots and receipts were retained; review/contract evidence is archived under the accepted state’s `artifacts/handoffs`. No task image, network, or named volume was created, and the shared compiler image was retained. The 19 original production containers remained unchanged and no evaluator deployment occurred. Three unrelated temporary API test containers (`/saas-ops-api-3105c1e7b20c-{app,redis,mongo}`) were observed intermittently during verification; read-only ownership labels identified run `api-3105c1e7b20c`. Their independent lifecycle was not managed by this evaluator task, which neither created nor removed them. No evaluator task containers remained and no external resources were changed.

See the [Rust project guide](../dimabot/RUST.md#opt-in-ast-evaluator), [migration index](README.md), and [task-specific routing observation](../orchestrator-notes/2026-10-25-ast-evaluator.md). Caller adoption remains a later scope.
