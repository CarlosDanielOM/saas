# Fish favorites independent review evidence

This is a separate static-review and shared-policy proof epoch. It does not alter or append to the earlier baseline/optimization/benchmark bundle at `evidence/2026-10-30-fish-favorites/`.

Grok 4.7 at xhigh reviewed frozen Fish commit `999c94441cadb586916c512fe59bbb0bf6f4a428`, tree SHA-256 `52fbe671459e76370cc9cf73b05dd94a008fce3f220c25478611e58b61c49380`, 1,504 inputs. The read-only conclusion was no actionable defect; it explicitly rejects confirmation4. The review did not run Cargo, Node, Mongo or containers, and did not independently rehash all 1,504 inputs. The parent had already verified that source binding. The complete raw thread response is preserved in `review/grok-thread-final.json`.

A follow-up proof commit `22aa6056edc390bed5247a2762ee7874816728e4` added `js_compat.rs` as a direct functional-oracle/native binding and added four actual-source NEL normalization cases (U+0085), taking the corpus from 15 to 19 while preserving the original cases, protocol/schema/BSON/error outputs and benchmark inputs. This addresses the direct trim-dependency coverage gap noted by the review. The JavaScript-compatibility unit also confirms U+0085 is excluded from ECMAScript whitespace. Application code was unchanged and no benchmark was retimed.

The supplemental epoch binds all 1,507 inputs to tree SHA-256 `1e72db8b9d30ef74ab314ca87478c9e022f0048a224da3083b03310d9e336d10` (1,497 Git plus ten reused SDK inputs); all hashes were verified. The expanded oracle SHA-256 is `5e38de829d73754dd6f26f2d6b46fa47c0cf05b1bf2ea1e548d1b7604a51ff12`.

| Receipt | Result |
|---|---|
| Format `1793381519859330187` | Passed |
| Node `1793381587248316106` | Passed |
| Compiler `1793381672993887330` | Passed; 98.194 seconds overall, 88.389 seconds compiler phase |

Four ordinary Fish tests, the 19-case source normalization/protocol replay, one shared JavaScript compatibility unit, formatting, scoped Clippy, minimal and all-feature strict checks passed. The follow-up did not rerun the entire six-test Fish suite, real Mongo checks, the large Unicode corpora or benchmark; those remain supported by the separate accepted source epoch, with no Fish application code changed here. The compiler recorded a minimum 12,191,965,184 bytes available and private cache peak 8,323,448,832 bytes under 6 CPU, 4 GiB no-swap, 256 PID and two Cargo job limits. The original quality wrapper records the exact scoped/minimal/all-feature commands and successful exits; the supplemental shell-traced wrapper records argv directly. Production readback found 18 containers unchanged and zero task-owned resources.

The review's race limitation remains explicit: forced 21-miss conflict exhaustion and rename fallthroughs are covered by `ReplayRepo`, not a guaranteed real Mongo schedule. Concrete Mongo coverage is one passing schedule per tested capacity race, same-ID add, distinct-ID alias split and rename collision. Confirmation4 remains rejected without a compiler driver receipt and contributes no metric. No caller adoption, deployment, RSS, end-to-end performance or new benchmark claim is made.

`index.json` lists every payload's original absolute origin, raw/stored SHA-256, byte size and encoding. The original Grok thread JSON and tool references are copied byte-for-byte; logs/receipts and large JSON are gzip-compressed losslessly. Reproduction scripts are inert references, not re-executed here. No binaries, mutable source snapshot or cache is included.
