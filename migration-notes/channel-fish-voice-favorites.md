# Fish voice favorites: verified typed native feature and alias benchmark

**Status: complete local typed-feature and dependency closure; TypeScript source and test archived and post-retirement verified; caller adoption and deployment remain separate.** The final source-bound tests, schema/oracle checks, and two clean benchmark rounds passed. The TypeScript route and AST voice-resolver callers have not adopted the native API. Grok 4.7 at xhigh completed a read-only review of the exact frozen source with no actionable findings; its scope and supplemental dependency-coverage epoch are recorded separately.

## Initial typed-record baseline

The immutable source snapshot is Git commit `0506c5088af534c07fecd3563c9264589f3af3c0`, with 1,502 bound inputs (1,492 Git inputs and 10 reused SDK inputs) and source tree SHA-256 `9b11ced33a15768bb42fb28268bb92440e5692f21a50976544cd018da656841e`. The corresponding bound capture and source-final map are preserved in the evidence package. The native baseline is associated with commit `5cf74ba0`; the harness is bound to `0506c508`.

The checked scope covers the Fish favorite typed record/schema boundary and the normalization/alias operations used by it. The captured source oracle includes protocol 12, normalization 15, aliases 16, three real-Mongoose cases, nine constructor cases, and eight BSON cases. The native suite contains five tests. Verification used BSON `6.10.4`, Mongoose `8.24.2`, and its resolved MongoDB driver `6.20.0`.

This is typed-record parity, not general Mongoose model or JavaScript object parity. The native implementation rejects malformed stored values and projects unknown favorite fields away at the declared typed interface. It does not claim arbitrary unknown-shape or npm prototype behavior. The isolated Mongo test passed CRUD, concurrent add/rename races, capacity checks, legacy default migration, timestamps, BSON replacement, and malformed-data cases. The forced 21-conflict exhaustion proof uses a separate recording repository; the real Mongo test proves concurrent operations without guaranteeing that particular 21-conflict schedule.

## Verification record

The final Node fixture run (`1793372728187388168`) passed after correcting the captured SDK's nested MongoDB version pin. The final compiler-fixture run (`1793372737318120079`) passed all five Rust tests and the settings checks, including format, scoped Clippy, minimal-feature, and all-feature strict checks. The release benchmark build (`1793372914152563479`) and report checker (`1793373209694818208`) passed. Production readback recorded 18 production records unchanged and zero task-owned resources.

Earlier attempts are retained as historical evidence, not silently replaced: an obsolete BSON test API caused an initial compiler-fixture failure; a later fixture run completed its tests but failed Clippy on `collapsible_if`; and a Node run failed before fixture execution because it pinned nested MongoDB `6.21` instead of the captured `6.20`. The later corrected-pin and final checks passed. The formatter runs and raw logs are indexed alongside those attempts.

## Baseline microbenchmark

The benchmark input SHA-256 is `c4c38e943f0dbe3d37caebe7f3fe0c89bb284c021fae4a840a5663fdc5caf8aa`. It used five pools of 32 cases, 20 complete warmup passes, and seven measured trials per workload. The harness prepared equivalent helper calls and checked scalar checksums derived from output lengths and fixed error fields. Timed JavaScript used normal V8/CommonJS execution, with separate VM-versus-normal-realm validation before timing. Rust used the native release implementation and prevalidated every prepared result before timing. Per-trial samples, checksums, workload inputs, binary binding, and provenance are retained in the evidence package.

| Workload | Node median ns/op (range) | Rust median ns/op (range) | Rust / Node median |
|---|---:|---:|---:|
| Normalize valid | 171.706 (153.584–1,319.270) | 252.444 (242.696–440.158) | 1.47× |
| Normalize invalid | 7,830.693 (7,138.613–8,479.777) | 166.917 (140.735–222.338) | 0.02× |
| Make ASCII alias | 812.173 (724.069–1,307.415) | 850.335 (771.522–978.207) | 1.05× |
| Make Unicode alias | 845.105 (835.236–913.004) | 1,545.860 (1,418.104–1,933.031) | 1.83× |
| Make colliding aliases | 2,139.915 (2,019.740–2,632.713) | 5,913.354 (5,753.403–6,340.193) | 2.76× |

These are mixed local helper timings: Rust is slower in four of five workloads. Invalid normalization is not an apples-to-apples error-cost comparison: JavaScript throws and captures an `Error` stack, while Rust returns a result with static error fields. The timings do not establish whole-application speed, memory use, allocation counts, database throughput, or end-to-end latency. No RSS or allocation counter was collected.

## Optimized candidate history

Two immutable development candidates are included as separate evidence epochs. Each candidate is bound to the same 1,502 inputs and Git base commit above plus 12 verified source overrides; these are source snapshots, not Git commits.

**optimized1** has source-tree SHA-256 `c2d012a01591b7569f3be7a6e19fa78af99ca47bd95708a536d5f1b0eb7ca545`. Its Node fixture run (`1793373483199833781`) passed. The fixture compiler run (`1793373561349761824`) failed on a duplicate module declaration after six Fish cases, source/private Mongo checks, full scalar NFKD/NFC and ordinary Unicode checks, and schema replays had passed. The complete run is retained with its failure status. It has workload inputs and provenance but no timing reports, so it contributes no performance claim.

**optimized2** has source-tree SHA-256 `0a60fe6dce0653a374fad1ce568d1073d3a24215162a9721b4c24c39ce33c5c3`. Compared with optimized1, the only change was in the Fish Rust test import, reusing the existing SHA helper; the helper implementation and production code were unchanged. Its eight semantic comparisons matched the source oracle; provenance metadata changed, not semantics. The formatter (`1793373695985173816`), Node fixture run (`1793373734549452444`), strict compiler-fixture run (`1793373768363001817`), release benchmark build (`1793373879749885856`), Node benchmark (`1793374034775877200`), and report checker (`1793374176218908853`) passed. The benchmark used the same input SHA-256 and protocol as the baseline, with Rust measured first and Node second. Production readback again showed 18 records unchanged and zero task-owned resources.

| Workload | Node median ns/op (range) | optimized2 Rust median ns/op (range) | Rust / Node median |
|---|---:|---:|---:|
| Normalize valid | 167.090 (164.430–1,057.295) | 241.317 (204.931–426.995) | 1.44× |
| Normalize invalid | 7,591.962 (7,444.005–8,166.495) | 175.005 (109.902–211.614) | 0.02× |
| Make ASCII alias | 773.688 (721.999–1,305.238) | 481.826 (396.294–715.503) | 0.62× |
| Make Unicode alias | 918.815 (883.465–1,100.854) | 775.715 (745.445–1,167.056) | 0.84× |
| Make colliding aliases | 2,057.278 (2,011.410–2,966.976) | 2,722.945 (2,628.592–2,946.017) | 1.32× |

These measurements remain mixed: optimized2 Rust is slower than Node for valid normalization and colliding aliases, faster for ASCII and Unicode alias construction, and much faster for invalid normalization under the same differing error-stack costs described above. Relative to the original Rust baseline, the ASCII, Unicode, and collision medians improved while valid normalization improved slightly and invalid normalization regressed slightly. The runs do not justify an unconditional performance claim. They are local helper timings, not end-to-end measurements.

## Final source closure and post-retirement verification

The accepted frozen source is commit `999c94441cadb586916c512fe59bbb0bf6f4a428`, bound across 1,504 inputs (1,494 Git plus 10 reused SDK inputs), with tree SHA-256 `52fbe671459e76370cc9cf73b05dd94a008fce3f220c25478611e58b61c49380`; all input hashes match. The two Fish TypeScript files were archived byte-exactly at `archives/dimabot-typescript/2026-10-28/src/schemas/`. They are post-retirement verified. The archive grew from 45 to 47 source snapshots and live baseline TypeScript rows fell from 761 to 759, still including six excluded React Email templates.

The local feature maps all nine runtime exports plus the `FishVoiceFavorite` interface. The actual Mongoose oracle confirmed model and collection name `channel_fish_voice_favorites`, version key `__v`, timestamps disabled, a unique `channelID` index, no generated favorite subdocument `_id`s, and the required `channelID`/`favorites` paths. The private channel record has a 20-favorite limit. The native descriptor and Mongo repository cover this schema and the get/add/remove/rename flows; the `Favorite` struct represents the public interface. The alias helpers cover source trimming, Unicode case conversion, NFKD-based generation, the combining-mark range, collision suffixes, and the reserved built-in aliases.

Direct dependency closure is explicit: Mongoose's source model/schema and BSON behavior map to the existing native schema core, MongoDB driver and BSON support; the imported `FISH_VOICES` dependency maps to the four required built-in voice data rows, not to the whole Fish provider; and the existing channel TTS settings model supplies the concrete legacy `cloneDefault` update used during rename. Transitive string, Unicode 17, lossless JSON, and Mongo dependencies already exist. No new Cargo dependency was added. TypeScript callers remain unadopted.

The native boundary is an ordinary typed BSON interface. It preserves UTF-16 strings until BSON encoding, where lone surrogates follow the pinned BSON replacement behavior. Malformed stored records are rejected and undeclared favorite fields are projected away. This does not promise arbitrary Mongoose model behavior, dynamic unknown-field retention, JavaScript prototypes, or JavaScript `Error` stack/subclass identity. The Rust database APIs use a caller-owned database and explicit index installation rather than implicit Mongoose model registration.

Final verification used the pinned Node 24.22.1, TypeScript 5.9.3, Mongoose 8.24.2 and BSON 6.10.4 oracle. All six Fish Rust tests and the full source Mongoose/BSON protocol passed. The ASCII-lower oracle covered 129 classification results across 1,112,064 Unicode scalar values plus 76 mixed cases; NFKD covered all 1,112,064 scalars plus 14 mixed UTF-16 cases; NFC covered all 1,114,112 code points plus 4,116 mixed contexts. Ordinary Unicode, format, scoped, minimal-feature and all-feature strict checks passed. Run receipts: formatter `1793374284730092974`, Node source check `1793374407049965675`, compiler fixtures `1793374519204764792`.

Production readbacks after verification and the interrupted attempt found all 18 records unchanged and zero task-owned containers, networks or volumes. The final local feature result does not indicate application cutover: the TypeScript source consumers remain unadopted, there was no deployment or push, and total repository migration remains incomplete. Grok completed the exact-source static review with no actionable findings; it did not execute or independently rehash the 1,504-input binding. The separate review and supplemental proof epoch are in [the dated review note](fish-favorites-review-2026-10-30.md).

## Independent review and supplemental proof epoch

Grok 4.7 at xhigh reviewed the frozen `999c944` Fish candidate read-only and found no actionable defect. The review rejected confirmation4 and checked alias policy, bounded collision logic, Mongo operations, BSON behavior and stored benchmark samples. It did not run Cargo, Node, Mongo or containers, or rehash all 1,504 inputs; the parent had already verified the source binding. It noted that forced 21-miss exhaustion and rename fallthroughs are `ReplayRepo` proofs, while the real-Mongo race evidence consists of one passing schedule for each tested case. Details and the complete raw response are in the [dated review record](fish-favorites-review-2026-10-30.md) and [separate evidence package](evidence/2026-10-30-fish-review/README.md).

A separate parent follow-up at `22aa6056edc390bed5247a2762ee7874816728e4` added the direct `js_compat.rs` trim dependency to the functional oracle and added four actual-source U+0085/NEL cases, preserving the prior 15 normalization cases and all other protocol/schema/BSON/error outputs. The new fixture was validated under a distinct 1,507-input binding; four ordinary Fish tests, 19-case source replay/protocol, one shared compatibility unit, format and strict checks passed. It did not rerun the full six-test suite, real Mongo, full Unicode corpora or benchmarks. No Fish application code or benchmark input changed; this supplemental proof does not replace or retime the accepted `999c` benchmark epoch.

## Final allocation-candidate benchmark rounds

The input SHA-256 remained `c4c38e943f0dbe3d37caebe7f3fe0c89bb284c021fae4a840a5663fdc5caf8aa`. Each final round used the same five 32-case pools, 20 complete warmup passes and seven measured trials. Round 3 ran Node then Rust (`1793374706318904115`, `1793374770923863947`), followed by the report check (`1793375002794772367`). Confirmation 5 deliberately reversed the order: prepare (`1793377481822704302`), Rust (`1793377544722296443`), Node (`1793377618676267840`), and report check (`1793377794637094567`). The reports and ranges below are kept separate rather than merged.

| Round 3, Node → Rust | Node median ns/op (range) | Rust median ns/op (range) | Rust / Node |
|---|---:|---:|---:|
| Normalize valid | 158.646 (145.426–1,033.660) | 80.618 (78.582–147.959) | 0.51× |
| Normalize invalid | 7,652.427 (7,383.915–9,106.101) | 89.043 (78.204–102.324) | 0.01× |
| Make ASCII alias | 866.684 (700.755–1,217.641) | 458.555 (385.529–705.946) | 0.53× |
| Make Unicode alias | 883.250 (860.074–890.392) | 835.661 (768.377–981.689) | 0.95× |
| Make colliding aliases | 2,081.605 (2,021.225–2,263.896) | 2,150.153 (1,975.529–2,218.486) | 1.03× |

| Confirmation 5, Rust → Node | Node median ns/op (range) | Rust median ns/op (range) | Rust / Node |
|---|---:|---:|---:|
| Normalize valid | 170.281 (155.228–980.486) | 83.459 (78.258–90.137) | 0.49× |
| Normalize invalid | 7,916.066 (7,580.333–8,655.286) | 111.337 (82.144–164.805) | 0.01× |
| Make ASCII alias | 741.428 (711.834–1,369.711) | 385.949 (380.161–445.538) | 0.52× |
| Make Unicode alias | 937.013 (888.643–1,010.829) | 788.886 (743.545–1,088.798) | 0.84× |
| Make colliding aliases | 2,196.812 (2,101.438–2,607.420) | 2,080.770 (2,018.838–2,574.520) | 0.95× |

Valid normalization and ASCII alias construction had roughly two-times-lower Rust medians in both orders. Their ranges overlap in round 3; neither result is a universal timing guarantee. Unicode and collision ranges overlap in both rounds; the collision median winner flips between rounds. Invalid normalization is not a comparable error-cost workload: Node throws and captures a JavaScript `Error` stack, while native returns a `Result` with static error fields. These are local helper timings, not an end-to-end or whole-application speed claim.

The candidate changes include a bounded lowercase ASCII projection over the pinned table, borrowed used-alias views with capacity reservation, a reusable suffix buffer, moving owned BSON results, and an assigned-UTF-8 NFKD quick path. These are source-level allocation changes, not an instrumented allocation count. No RSS or allocation counter was collected; no formal statistical inference is claimed.

Compiler confirmation 4 was user-interrupted and produced no driver receipt. Its raw log, interruption record, production readback and partial Rust report are preserved, but its report contributes no benchmark metric. Confirmation 5 completed the Rust→Node benchmark and report check; its final production readback again found 18 records unchanged and zero task-owned resources. The [interactive chart](../artifacts/fish-alias-benchmarks.html) is the already-rendered confirmation-5 view; it shows that round's Node comparison alongside earlier Rust history, not both final rounds. Do not treat it as a substitute for the two full tables above.

At the Fish acceptance epoch, the matrix recorded 34 locally complete mappings, 25 partial rows, 47 archived snapshots and 759 live baseline TypeScript files. The later permission retirement moved the current rollup to 35 complete, 25 partial, 49 archived and 757 live files across 806 rows; total completion remains `null`. Caller adoption and deployment remain separate.

The evidence package retains the original 158 baseline/optimized1/optimized2 payload entries unchanged, then appends optimized3 and confirmation4/5 captures, round receipts/logs, chart metadata and 39 final reproduction-tool captures. Across the package there are 68 reproduction-tool payloads: the 29 original copies remain preserved alongside those 39 final captures. The confirmation4 partial report is marked as interrupted and excluded from metrics. The scripts are archival references requiring their original task-owned state; the package does not authorize replaying them against historical production run IDs.

## Evidence package

The indexed evidence is in [`evidence/2026-10-30-fish-favorites/`](evidence/2026-10-30-fish-favorites/README.md). Its `artifact-index.json` gives each payload's immutable origin, raw SHA-256 and size, stored SHA-256 and size, and compression encoding. Gzip members decode losslessly to their recorded raw hashes. The package preserves source-final maps, source overrides from failed attempts, oracle and benchmark inputs/reports, binary and toolchain bindings, scoped cache audits, production readbacks, and run receipts/logs. It excludes mutable snapshots, compiler target trees, and toolchain binaries.
