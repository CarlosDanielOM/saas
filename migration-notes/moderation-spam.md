# Moderation spam migration — 2026-10-30

**Status:** The borrowed read-view implementation passed source-bound correctness and strict checks, both matched benchmark rounds are retained, and the final readback confirmed isolation. This note distinguishes the local feature mapping, measured helper workloads, caller adoption, and total dependency migration; it makes no end-to-end or production performance claim.

## Scope and reuse

The source scope is exactly `src/utils/moderation/spam.ts` and `src/schemas/moderation_chatter.schema.ts`. The native module reuses the existing spam-category catalog, channel moderation settings schema, advanced paid-moderation policy, JavaScript-compatible Unicode/whitespace helpers, lossless `JsString`, and shared application Redis runtime. Its MongoDB and Dragonfly adapters are concrete and use the existing client ownership; no second application cache or new crate was introduced. The schema uses the existing Mongoose collection name `moderation_chatters`, string key, and required `firstSeenAt` field.

The source path also depends on permission/settings/decision types, the actual advanced moderation dependency, `node:crypto`, and the application database/cache services. The oracle records the complete source import/export surface and distinguishes type-only views from runtime imports. Existing semantic moderation worker and route consumers remain TypeScript; caller adoption and deployment are not included in this work.

## Correctness and source binding

Node source check `node-1793340868529956618` passed `--write` and `--check` on tree `1628f8c23147e68073ca16eb33683452fba0532e544662348fee381ccffe2694`; it retained the generated fixture bytes with SHA-256 `f6f59d6c0a021ce609ac507ed88af22960eb2cf683c31d19ec3c146a2aebc222`. The fixture covers 1,636 pure records and 37 async records across all 14 runtime exports. Nine async records use explicit synthetic boundary adapters; they are not native wire replays. The actual 707-file Mongoose package manifest is pinned to `63200fe45fbe04c23f601aaa191eb08934ea6795a4442d22ca5a5ba9b679b722`.

Final isolated correctness/strict phase `compiler-fixtures-1793340894915777003` passed on the same tree, code commit `16159856fd21044d42658c9a02eb56be1f313e89`, and 1,424 inputs: 1,414 Git-bound files and ten unchanged verified PostHog SDK inputs. It passed all eight feature units, all 1,636 pure and 37 async source records, two private Mongo/Dragonfly storage checks, online/offline bootstrap, EVAL and SET response-loss checks, telemetry and lookup hit/miss checks, minimal and Mongo/Redis checks, and all-feature strict Clippy. The phase took 120.583 seconds (134.521 seconds total run), with 8,285,888,512 minimum available bytes and 7,565,172,736 peak cache bytes; 18 production records were unchanged. This iteration did not rerun the 38 unchanged variation-job cases because the optimization did not change their shared proxy or storage paths; those cases passed in the earlier spam verification phase. Nine async oracle records remain synthetic adapters, not native wire replays.

Preserve historical failures as failures: phase `compiler-fixtures-1793339134095509298` reached its functional cases but failed later strict compilation due to an unused `Read` import in the shared proxy. Parent harness attempts `1793340817778932980` and `1793340838447815158` failed setup because of a missing parent and a missing empty reference directory; neither was an application behavior failure. They remain in the retained attempt history.

## Representation and benchmark boundary

The new settings/context APIs expose read-only borrowed views. They retain static defaults and ordinary array inputs, preserve lossless unknown values, UTF-16 and threshold values, and materialize owned JSON only when projection is requested. The invitation fast path uses compiled byte regexes for ASCII input and retains the existing Unicode 17 fold path for non-ASCII and lone-surrogate strings. The borrowed benchmark retains typed results through warmup and timing, then projects/checksums them outside the measured interval. Its configured Rust representation is `borrowed-read-view`.

The original owned-JSON compatibility baseline completed seven alternating pairs for each of five prepared workloads, with all 70 actor records and checksums independently verified. Rust median time was slower than Node on invitation (1,017.194125 vs 737.366125 ns/op), settings (1,452.002375 vs 218.98025), rule context (17,490.364 vs 1,012.705625), and review policy (1,072.346125 vs 278.07225); it was faster on the chatter marker workload (690.4245 vs 3,650.955125). Preserve each regression. The exact borrowed release-target compile `compiler-1793341038713795888` passed on the same frozen tree; the exported 4,061,472-byte test binary contains both benchmark actors, so this is not an application binary-size claim. Borrowed config SHA-256 is `9f18b49ade942ad67fe4eadbe708222a17b7870129e9bbfcdd89d967e5436596`.

The borrowed run `node-1793341268777902038` passed seven alternating pairs per workload. Its independent readback verified all 70 actor records and checksums, alternating order, matching input hashes, and before/after file hashes. Median time in ns/op:

| Workload | Node, initial round | Rust, owned JSON | Node, borrowed round | Rust, borrowed view |
| --- | ---: | ---: | ---: | ---: |
| Invitation | 737.366 | 1,017.194 | 888.926 | 785.627 |
| Settings | 218.980 | 1,452.002 | 177.409 | 51.147 |
| Rule context | 1,012.706 | 17,490.364 | 1,047.343 | 1,015.557 |
| Review policy | 278.072 | 1,072.346 | 190.841 | 87.382 |
| Chatter marker | 3,650.955 | 690.425 | 3,734.076 | 612.524 |

The borrowed Rust medians are lower than Node in all five workloads. The observed minimum/maximum ranges do not overlap for settings, review policy and marker; invitation and rule context ranges overlap, so no clear repeatable advantage is claimed for those two. This is not a statistical-significance analysis. These are prepared helper timings. Node returns JavaScript objects/arrays, while the owned baseline constructs deep owned JSON; the borrowed API exposes read-only views, and projection, output checksums, serialization and destruction are excluded from the borrowed timed interval. Callers that request `to_owned_json` still pay for materialization. These results do not establish end-to-end caller speedup, production CPU/RSS/throughput, or production latency.

## Boundaries and remaining status

Ordinary JSON adapters preserve JSON values but not executable prototypes/hooks, `undefined`, sparse-array identity, or `Date` identity. Borrowed template/view paths preserve shared native references; the semantic-policy owned vector does not preserve arbitrary mutable JavaScript example identity. Native driver error text is not claimed identical to Mongoose/Node diagnostics. Source console connection logging remains a shared application dependency boundary.

The TypeScript source, moderation handler and route, and semantic moderation worker remain active and unadopted. There has been no TypeScript retirement, production deployment, or push. Final readback confirmed all 18 production records unchanged and zero task-owned containers, networks or volumes remaining. Local feature mapping remains partial because the documented boundaries and source/application integration remain. Total migration completion remains unscored; deployment and caller adoption are reported separately. The indexed evidence bundle retains both benchmark rounds, all failed attempts, exact source bindings, readbacks, and tool hashes.

See the [native handoff](moderation-spam-native-handoff.md), [source-oracle handoff](moderation-spam-oracle-handoff.md), [bootstrap handoff](moderation-spam-bootstrap-handoff.md), [benchmark coordinator handoff](moderation-spam-benchmark-coordinator-handoff.md), and [borrowed read-view handoff](moderation-spam-borrowed-handoff.md). The indexed [evidence bundle](evidence/2026-10-30-moderation-spam/README.md) retains both benchmark rounds, source bindings, all 29 run receipts/logs in the retained interval, readbacks and tool hashes; see its [verification summary](evidence/2026-10-30-moderation-spam/verification-summary.json).
