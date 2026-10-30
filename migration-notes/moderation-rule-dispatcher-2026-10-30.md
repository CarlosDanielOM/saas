# Moderation rule dispatcher — 2026-10-30

## Scope and dependency review

This opt-in Rust module maps the pure branch dispatcher in `src/utils/moderation/rules/index.ts` to `dimabot/src/utils/moderation/rule_dispatcher.rs`. It directly reuses the existing native caps, links, emote-spam, and blacklist evaluators plus `json_number::number_string`; it adds no mock evaluator or application-service adapter. The `IModerationRule` import is type-only. Rust represents only fields selected by each switch branch, using the source schema's interface fields and union aliases as reference.

The dispatcher reproduces all four branches and the unknown-type fallback. It preserves the source detail strings and edge behavior: finite caps percentages round as JavaScript `toFixed(0)` does on the validated domain; emote numbers use the shared JavaScript-compatible number formatter; link details are assembled as UTF-16 so lone surrogates survive; blacklist details distinguish compiled matches from missing or null patterns.

The dispatcher uses the existing blacklist evaluator, whose native input accepts only patterns from its literal-term compiler. The TypeScript dispatcher accepts arbitrary `RegExp` instances. Current application paths compile blacklist patterns from terms, but the source API difference remains an open dependency; therefore this dispatcher mapping is **partial**, despite the branch behavior being implemented and verified. Wider moderation handler/action migration and caller adoption remain open.

## Verification

Frozen code commit `c90cdd98e431df675fbc905c9e33cd8fae04a07e` was verified against source snapshot `050b65cf06adb805637948c65ab2010b23dde85fc3a263654dc8dd9ca6d62170`, containing 1,369 frozen source inputs. The source oracle transpiled the complete live dispatcher, normalizer, links and blacklist sources plus the archived caps and emote-spam sources. Its 22 cases covered every branch, trigger and no-trigger outcomes, half rounding, exceptional emote numbers, Unicode and lone-surrogate links/blacklist text, missing/null blacklist patterns, and an unknown rule type. The fixture SHA-256 is `bcd9ffc9be201032c500e465f8443ae5f5abc9a57d7b95e9dd62909b924fddc6`; independent metadata readback verified all 18 source/runtime hashes. The oracle used pinned Node 24.22.1, V8 13.6.233.17-node.58, ICU 78.3, Unicode 17.0, and TypeScript 5.9.3. No evaluator was mocked.

The 22-case native replay passed. Nineteen ordinary Rust tests passed: seven blacklist groups, four caps tests, two emote-spam groups, four links tests, one normalization test, and one dispatcher test. Formatting, focused Clippy, no-feature and Mongo/Redis checks, all-feature/all-target strict Clippy passed. Verification run IDs: `node-1793324608846532854`, `compiler-1793324608852932493`, and `compiler-1793324693380466159`. The initial formatting run (`format-1793324584169033656`) predates the frozen source binding and is retained only as historical evidence; it is not part of the final source binding.

This is a correctness-only result. No matched benchmark or performance claim was produced. The read-only production comparison found all 18 inspected records unchanged, and no task-owned resources remained. Verification preserved the documented caps: six CPUs, 4 GiB memory with no swap, two Cargo jobs, 256 PIDs, and an 8 GiB private Cargo cache ceiling. The broad compiler observed a 5,541,797,888-byte cache peak and 9,661,513,728-byte minimum available memory; the 5 GiB startup and 4 GiB in-flight headroom policy remained in force.

## Migration status

The native dispatcher is verified as an opt-in local module. The TypeScript dispatcher and handler remain live; there is no caller adoption, source retirement, deployment, or push. The dependency matrix marks this row partial because arbitrary externally constructed blacklist regexes remain outside the required native contract. See the [evidence package](evidence/2026-10-30-moderation-rule-dispatcher/README.md) and [bounded integration handoff](moderation-rule-dispatcher-handoff.md).
