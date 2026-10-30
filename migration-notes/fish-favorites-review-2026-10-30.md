# Fish favorites read-only review — 2026-10-30

## Review result

Grok 4.7 at xhigh completed a read-only review of the frozen Fish favorites candidate. It reported no actionable defect and explicitly rejected confirmation4. The reviewed source was commit `999c94441cadb586916c512fe59bbb0bf6f4a428`, tree SHA-256 `52fbe671459e76370cc9cf73b05dd94a008fce3f220c25478611e58b61c49380`, 1,504 bound inputs. The parent had already verified those inputs; the review itself did not rehash them and ran no Cargo, Node, Mongo or container checks.

The review traced the alias policy against the archived source, the shared Unicode/policy helper, bounded collision-set and suffix handling, Mongo update filters, retry bounds, migration order and rename fallthroughs, BSON behavior and stored benchmark samples. It identified no actionable defect. Review-specific validation limits remain: forced 21-miss exhaustion and rename fallthroughs use `ReplayRepo`, not a guaranteed real Mongo schedule; each documented real-Mongo race has one passing schedule. The recorded concrete Mongo behavior remains scoped as written in the main note. Confirmation4 has no compiler driver receipt, was interrupted, and contributes no benchmark metric. The older compiler log does not echo strict-check argv; the preserved original quality wrapper records the exact scoped/minimal/all-feature commands and successful exits, and the supplemental shell-traced wrapper records argv directly.

The full review response and thread metadata are preserved byte-for-byte in the [indexed evidence package](evidence/2026-10-30-fish-review/README.md). Thread: `<t3-thread://v2/158cc4c8-bc36-4d26-adb1-fad91f7e5998/thread:delegated-task:command%3Amcp%3A87b2c663-5cd2-4abf-b55f-932ac93ce7f2%3Adelegate-task%3A282b8eef-03d4-493a-b311-22ed9d8b9621>`.

## Supplemental direct-dependency proof

The review noticed that `js_compat.rs` was a direct trim dependency but absent from the Fish functional-oracle binding, and that the source normalization corpus lacked U+0085 (NEL). The parent closed this evidence gap in follow-up commit `22aa6056edc390bed5247a2762ee7874816728e4`: it added the actual `src/utils/js_compat.rs` source and native dependency to the oracle binding, retained the original 15 normalization cases and added four actual-source NEL cases. Existing protocol, schema, BSON and error outputs stayed unchanged; the benchmark inputs and reports were untouched. The shared compatibility test exercises ECMAScript whitespace exclusion for U+0085. No Fish application code changed.

The separate supplemental epoch binds 1,507 inputs (1,497 Git plus ten reused SDK) to tree SHA-256 `1e72db8b9d30ef74ab314ca87478c9e022f0048a224da3083b03310d9e336d10`; all input hashes were verified. The new fixture SHA-256 is `5e38de829d73754dd6f26f2d6b46fa47c0cf05b1bf2ea1e548d1b7604a51ff12`. Formatting `1793381519859330187`, Node `1793381587248316106`, and compiler `1793381672993887330` passed. The compiler took 98.194 seconds overall / 88.389 seconds in its compiler phase, with minimum available memory 12,191,965,184 bytes and private cache peak 8,323,448,832 bytes under the existing capped policy.

This supplemental pass covered four ordinary Fish tests, the 19-case source replay/protocol, one shared `js_compat` unit test, formatting, scoped Clippy, minimal and all-feature strict checks. It did not rerun all six Fish tests, real Mongo, the full Unicode corpora or either benchmark order. Those remain covered by the separate accepted `999c` source epoch; the supplemental pass is not an all-tests rerun or a new performance result. Production readback found 18 containers unchanged and zero task-owned resources.

## Routing observation

This is one successful, scoped read-only review with a useful evidence-coverage follow-up. It supports Grok 4.7 xhigh for this type of deeper static review at low confidence; it does not establish a broad model ranking, runtime performance, cost or latency. See the concise [routing observation](../orchestrator-notes/2026-10-30-grok-fish-review.md).
