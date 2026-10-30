# Moderation chatter schema retirement — 2026-10-30

## Accepted source epoch

The verified retirement is commit `a2a0b3ab9d5398fee8ee9551a34fa4e7d6022f02`, tree SHA-256 `6d3e0f96d8cab8e6b261462c6644573a453f679d4ac79daf79a43169cc804d3c`, across 1,507 independently bound inputs (1,497 Git and ten reused SDK). The original source SHA-256 is `71ec2e9e8047a6d6a8da561c596d1cbacf2dc13ac93ca6ad2878ef95dec9632e`; it is byte-exact in the 2026-10-28 archive manifest as entry 50. The previous 49 manifest entries are unchanged. Shared source pins grew from 17 to 18 while preserving the previous 17 order.

The local feature closure is the declared `ModerationChatter` schema model and its required Mongo/BSON/date representation. It maps the model `moderation_chatter`, derived collection `moderation_chatters`, required string `_id`, required Date `firstSeenAt`, no `__v`, no custom indexes/timestamps/defaults/hooks/save clock. Existing `SpamService::claim_first_observed_message` supplies the concrete `$setOnInsert` application adapter for first-seen markers. Arbitrary Mongoose/runtime behavior and the wider spam module are not included in this single-model closure.

## Archive reader and semantic verification

The shared JS/Rust archive source readers now validate chatter's archive bytes/hash, unique manifest entry and resolver pin. The focused Chatter Mongoose oracle and Rust replay read the archived bytes under the original logical/virtual path. Spam source readers for the TypeScript oracle, reference and benchmark now use the same archive-aware source. The Node and Rust guards check chatter provenance and preserve previous source-pin order and leaf provenances.

Eight corpora compared behavior-identical; only specifically enumerated source/archive/resolver/script-hash metadata changed. The Chatter oracle retained all 25 model cases and schema/BSON output. Spam retained all 1,636 pure records and 37 source claims. The 160 prepared benchmark inputs remained byte-identical (SHA-256 `9f54153d86b2f91417733343c744d4f8e17d0a1a6bf744df1779ea3bcad6086b`). Its Node write/check validated inputs only; it was not timed.

## Verification

| Check | Receipt | Result |
|---|---:|---|
| Formatting | `1793382552323881451` | Passed |
| Node source/oracle checks | `1793382649824905659` | Passed |
| Capped compiler-fixtures | `1793382865007741746` | Passed |

The compiler job passed 37 selected checks, including seven Chatter tests, 25 actual-Mongoose cases, real-Mongo CRUD and atomic first-seen behavior, 1,636 Spam pure records, six affected schema oracle/replay groups and ordinary regressions. Formatting, scoped Clippy, minimal and all-feature strict checks passed. Compiler step: 85.336 s; overall: 98.536 s; minimum available memory: 12,663,513,088 bytes; peak private cache: 8,550,195,200 bytes. Limits were 6 CPU, 4 GiB no-swap, 256 PIDs and two Cargo jobs. Production readback found 18 records unchanged and zero owned resources.

Native full asynchronous Spam claim tests were not rerun; Node confirmed all 37 source claims unchanged and the concrete Chatter first-seen Mongo primitive was tested. This is not evidence that the full native Spam suite ran. No benchmark timings, deployment, caller adoption or performance/RSS claim were added.

## Scope after retirement

The larger Spam TypeScript helper, handlers, route and semantic worker remain live. Native `SpamService` exists, while adoption by the surrounding application remains separate. Their existing TypeScript schema import may now be broken by the authorized source deletion. The archive integration does not complete the broader Spam feature or total migration; the overall migration remains incomplete.

The [retirement handoff](moderation-chatter-retirement-handoff.md) contains the source/dependency map and the [evidence package](evidence/2026-10-30-moderation-chatter-retirement/README.md) indexes immutable fixtures, semantic comparisons, bindings, receipts, logs and inert tools. The prior [schema verification note](moderation-chatter-schema-2026-10-30.md) remains the separate pre-retirement epoch.
