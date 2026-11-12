# Review of the `dima-engine` evaluator at `dc411607` (GPT-6.1 Sol, 2026-11-11)

All six findings are taken into E-ENGINE-02b.

1. **SECURITY — `replace` can exhaust process memory before its limit fires.** Starting with `%(x a)`, doubling `x` 18 times using `%(x "${%(x)}${%(x)}")`, then evaluating `$(replace a %(x) %(x))` attempts a 64 GiB result, although both arguments satisfy the 256 KiB limit; allocation happens in [strings.rs:142 crates/engine/src/functions/strings.rs:142], before [run.rs:390 crates/engine/src/eval/run.rs:390] checks the result, following the unbounded reference operation at [string.functions.ts:74 dimabot/src/utils/ast_parser/functions/string.functions.ts:74]. Pass a budget into allocating builtins, calculate replacement size with checked arithmetic before allocation, and bound aggregate argument/list construction as well.

2. **SECURITY — compilation can overflow before reaching the larger-stack retry.** The reported chain of about 130 nested `%(*l[…])` expressions traverses `variable → star → atom → expression → definition → variable` until the 128-level inline ceiling, exhausting the debug caller stack before [syntax/mod.rs:96 crates/engine/src/syntax/mod.rs:96] can retry; see [parser.rs:563 crates/engine/src/syntax/parser.rs:563], [types.rs:645 crates/engine/src/syntax/types.rs:645], and the explicitly reduced coverage at [eval_robustness.rs:452 crates/engine/tests/eval_robustness.rs:452], versus recursive parsing at [registry.ts:490 dimabot/src/utils/ast_parser/registry.ts:490]. Move parsing onto a guaranteed stack before recursive descent or make descent iterative; **the debug crash does not establish the same crash on a default release stack**, but release retains this architectural exposure on smaller or already-consumed stacks, and its safety is unverified.

3. **BUG — the 114 own-`toString` differences change valid stored-data behavior.** With `l` containing `[{"toString":0}]`, `%(l[0]) after` throws during reference rendering, whereas Rust prints `[object Object] after`, because [value.rs:111 crates/engine/src/value.rs:111] always succeeds where [evaluator.ts:1290 dimabot/src/utils/ast_parser/evaluator.ts:1290] calls `String()`; this is ordinary JSON, independent of UTF-16. Make coercion fallible and preserve the reference’s failure and catch boundaries, then remove the exception in [support/mod.rs:1182 crates/engine/tests/support/mod.rs:1182].

4. **BUG — stored JSON rejects values that command authors can create.** `%(l "[1e400]") %(l[0])` produces `Infinity` in TypeScript and empty output in Rust, while a quoted list containing 128 nested arrays similarly becomes empty rather than remaining readable: [value.rs:164 crates/engine/src/value.rs:164] rejects both, versus [evaluator.ts:383 dimabot/src/utils/ast_parser/evaluator.ts:383]. These inputs require no external writer; implement bounded command-language JSON parsing that preserves overflowing doubles and supported nesting, separately from the approved stricter request-body parser.

5. **RISK — the evaluator stack guard measures consumption, not available space.** Resetting the marker for each poll correctly handles task migration, but a future polled on a 256 KiB thread—or beneath substantial caller stack use—can overflow before consuming the allowed 1 MiB: [eval/stack.rs:26 crates/engine/src/eval/stack.rs:26], [run.rs:382 crates/engine/src/eval/run.rs:382]; the reference simply recurses at [evaluator.ts:682 dimabot/src/utils/ast_parser/evaluator.ts:682]. Use an explicit evaluation stack, or require and enforce a runtime stack-size contract with headroom; the current unconditional “no tree can overflow” guarantee is unsupported.

6. **RISK — the default work budget rejects permitted two-loop commands.** Two Pro loops of 100 iterations with 25 `$(scount)` statements in the inner body exceed 200,000 steps despite producing no loop output, and storage operations hit the 2,000-host-call ceiling much sooner: [limits.rs:32 crates/engine/src/eval/limits.rs:32], versus the reference’s plan-bounded execution at [evaluator.ts:1199 dimabot/src/utils/ast_parser/evaluator.ts:1199]. **Judgement call:** establish an explicit supported workload and calibrate both limits against it; the existing ordinary-command check covers single loops, not this case.

Checked and found sound by inspection:

- Arguments and binary operands evaluate left to right; ternary branches remain lazy.
- Frame switching preserves the reference’s unusual counter visibility around loops, discarded indexes, and deletes.
- Variable scope keys, database read memoization, write visibility, and plan restrictions follow the reference.
- Command references retain a shared atomic budget, depth/cycle guards, and deferred execution.
- Timer bodies remain lazy; snapshots capture scheduling-time state, and schedule failures become timer text.
- Random selection uses one draw for nonempty arrays and none for empty arrays; `replace` uses literal matching, with no attacker-controlled regex compilation.
- Host futures explicitly require `Send`; random-user state and effect authority have dedicated contract fields.
- No shipped host handler needs arbitrary variable writes. The 19 fixture-write exclusions reflect an interface restriction, not an impossibility in Rust; non-text names/arguments are outside their declared contracts, but `variables` is explicitly `Map<string, unknown>` in TypeScript, so that portion of the 110 exclusions still needs caller-level justification.
- Registry structure preserves registration order, aliases, metadata, and replacement semantics; no additional discrepancy identified.
## Re-check at `30f8a536`, after E-ENGINE-02b and 02c (GPT-6.1 Sol, 2026-11-12)

Findings 2 to 6 are closed (2 and 5 under the declared stack contract, proven in a debug
build). Finding 1 is partly closed: `replace` is checked before it allocates, but the response
list and stored-list reads still escape. Three new points, all reproduced; the lead's decision
follows each. The fixes are package E-ENGINE-02d.

**R1, SECURITY. Writing a response by index bypasses the aggregate and kept-memory limits.**
`%(x a)`, seventeen times `%(x "${%(x)}${%(x)}")`, a loop of 100 `%(responses[] "")`, then a
loop of 100 `%(responses[#i] %(x))`: 13,107,200 bytes of responses with 131,073 charged, 1,596
steps, no error. More slots take it toward exhausting the process. `run.rs:894`.
*Decision: taken.* The resulting aggregate is checked and its memory reserved before a slot is
replaced.

**R2, SECURITY. Empty response entries cost nothing.** With `l` stored as a list holding a list
of 1,024 empty strings, a loop of 100 `%(responses[] %(*l[0]))` makes 102,400 entries in 2,005
steps with 3,076 bytes charged, and each append scans all earlier entries. `run.rs:884`.
*Decision: taken.* Every entry is charged its overhead and its serialised size before the list
grows, from counters kept as it grows (no rescans), and the number of entries has a limit.

**R3, RISK. Stored JSON is expanded before its size is checked.** With `l` stored as an array of
300,000 empty arrays (900,001 bytes), `%(*l.length)` answers 300000 in 3,518 steps although a
value may be 256 KiB; cache reads have no ceiling of their own. `storage.rs:190`.
*Decision: taken.* A stored value over the limit is refused before it is parsed, and the nodes
and containers of a value are charged to the memory budget while it is built.

For the bot that embeds the engine (recorded with the binaries' obligations): register each
runtime thread's real stack size; implement `Host::alarm` so that it always wakes, and make host
futures yield and stop when dropped; use a clock that cannot go back for the deadline; send
every reference through the shared-budget entry points with the owning channel's plan; bound
what a host function returns; and limit messages per channel and evaluations in flight overall,
since a budget per message does not stop a channel from sending expensive messages one after
another. *Also taken into 02d:* parsing on an unregistered thread starts one thread per caller
with no cap; a cap on those threads belongs in the engine.
