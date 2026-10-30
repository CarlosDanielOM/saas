# Moderation rule dispatcher evidence

This package accompanies the bounded dispatcher review in [`moderation-rule-dispatcher-2026-10-30.md`](../../moderation-rule-dispatcher-2026-10-30.md). Final source commit: `c90cdd98e431df675fbc905c9e33cd8fae04a07e`. Frozen source snapshot SHA-256: `050b65cf06adb805637948c65ab2010b23dde85fc3a263654dc8dd9ca6d62170` (1,369 frozen source inputs). The complete 22-case TypeScript oracle fixture SHA-256 is `bcd9ffc9be201032c500e465f8443ae5f5abc9a57d7b95e9dd62909b924fddc6`.

## Source binding and case coverage

The oracle transpiles and invokes the unmodified live `index.ts`, links and blacklist modules, the normalizer, and archived caps and emote-spam modules. It does not mock evaluator behavior. It pins source imports, runtime exports, type-only imports, the selected `IModerationRule` fields and aliases, compiler/runtime binaries, Unicode/ICU versions, and Rust/test source hashes. The runtime pins are Node 24.22.1, V8 13.6.233.17-node.58, ICU 78.3, Unicode 17.0, and TypeScript 5.9.3. Fixture strings are UTF-16 code units; numeric inputs are represented as binary64 bits. Independent packaging readback verified all 18 source/runtime hashes.

The 22 cases cover every branch, triggered and untriggered outcomes, the caps half-rounding boundary, exceptional emote counts including infinities and negative zero, Unicode and lone-surrogate link/blacklist text, missing and null blacklist patterns, and an unknown rule type. The final fixture replay passed in 0.03 seconds. The native dispatcher directly calls existing caps, links, emote-spam, and blacklist evaluators and reuses `json_number::number_string`; it has no mock or application-service gap. Blacklist patterns remain limited to those created by its literal-term compiler, so arbitrary externally constructed JavaScript `RegExp` behavior remains outside the port and the migration row is partial.

## Accepted verification

Accepted run IDs:

- Node/source replay: `node-1793324608846532854`.
- Focused compiler: `compiler-1793324608852932493`.
- Broad compiler and strict Clippy: `compiler-1793324693380466159`.
- The earlier formatting run `format-1793324584169033656` predates the frozen source binding and is retained as historical evidence only, not as final-bound verification.

The final bounded verification passed 19 ordinary tests: seven blacklist tests, four caps tests, two emote-spam tests, four links tests, one normalization test, and one dispatcher test. It also passed the 22-case source replay, current formatting, scoped feature checks, no-feature and Mongo/Redis checks, all-feature/all-target strict Clippy. No performance benchmark was run; no performance claim is available.

## Reproduction

Use the read-only frozen source snapshot and isolated capped compiler workflow required by `dimabot/RUST_AGENTS.md`. The command forms are documented in [`moderation-rule-dispatcher-handoff.md`](../../moderation-rule-dispatcher-handoff.md). The replay requires an external fixture directory and the SHA-256 above, and checks source and native bindings before comparing outputs. Do not run its Node or Cargo commands directly on the host.

The accepted compiler limits were 6 CPUs, 4 GiB memory with no swap, two Cargo jobs, 256 PIDs, and the private Cargo cache ceiling of 8 GiB. The broad compiler's recorded cache peak was 5,541,797,888 bytes; minimum available memory was 9,661,513,728 bytes. The 5 GiB startup and 4 GiB in-flight headroom thresholds remained in force.

Before/after inspection found all 18 production records unchanged and no remaining task-owned resources. No production service was changed or deployed. No caller adoption, source retirement, or push occurred.
