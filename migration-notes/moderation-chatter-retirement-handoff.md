# Moderation chatter schema retirement handoff

**Status: source retirement and post-retirement verification passed.** Commit `a2a0b3ab9d5398fee8ee9551a34fa4e7d6022f02` binds 1,507 verified inputs to tree SHA-256 `6d3e0f96d8cab8e6b261462c6644573a453f679d4ac79daf79a43169cc804d3c` (1,497 Git and ten reused SDK inputs). The archived source is byte-exact at SHA-256 `71ec2e9e8047a6d6a8da561c596d1cbacf2dc13ac93ca6ad2878ef95dec9632e`; archive entry 50 was added with all previous 49 entries unchanged.

## Local model and dependency closure

The source module has one runtime export, `ModerationChatter = model('moderation_chatter', schema)`. The native descriptor and model factory preserve the declared model/collection contract: model `moderation_chatter`, Mongo collection `moderation_chatters`, required string `_id`, required Date `firstSeenAt`, `versionKey: false`, no custom indexes, defaults, timestamps, hooks or save clock. The concrete Mongo dependency is the existing MongoDB/BSON/date core. This is a complete local mapping for the declared schema model, not general Mongoose/npm runtime parity. Arbitrary JavaScript prototypes, executable hooks, getters, or other unmodeled behavior are excluded.

The actual application-specific first-seen operation is already present in `SpamService::claim_first_observed_message`. It performs the `$setOnInsert` upsert and interprets `upserted_id` / duplicate key for first-seen state. Its isolated Mongo behavior passed as part of the schema verification. The broader spam feature and service callers remain separate migration work.

## Archive-aware source readers

Retirement extended the existing shared schema source resolver from 17 to 18 pins, retaining the previous 17 positions unchanged. The focused Chatter oracle and Rust source replay now resolve the canonical archived file, verify its bytes, manifest entry, resolver pin and provenance, and keep the original logical/virtual TypeScript path for type-checking. The existing Spam source loader and reference/benchmark readers now consume the same archived Chatter source and expose its provenance; native guards validate those bindings and keep prior leaf-source provenance unchanged. No parallel source reader was added.

Eight regenerated corpora compared behavior-identical; only the enumerated source-location, resolver, manifest and script-hash provenance changed. The 160 prepared Spam benchmark inputs remain byte-identical at SHA-256 `9f54153d86b2f91417733343c744d4f8e17d0a1a6bf744df1779ea3bcad6086b`. Node write/check was run, but no benchmark timing was collected.

## Verification and limits

Formatting `1793382552323881451`, Node `1793382649824905659` and compiler-fixtures `1793382865007741746` passed. The capped compiler job passed 37 selected checks, including all seven Chatter tests, the 25-case actual-source Mongoose replay, real-Mongo CRUD and atomic first-seen behavior, 1,636 Spam pure records, six affected schema oracle/replay suites and existing regressions, plus formatting, scoped Clippy, minimal and all-feature strict checks. It took 98.536 seconds overall / 85.336 seconds for the compiler step, with minimum available memory 12,663,513,088 bytes and private cache peak 8,550,195,200 bytes under 6 CPU, 4 GiB no-swap, 256 PID and two Cargo job caps.

Node compared all 37 source Spam claims unchanged. The native full asynchronous Spam claim suite was not rerun because application code was unchanged; the Chatter Mongo primitive itself was tested against the disposable Mongo fixture. No performance timing was repeated. Production readback found all 18 records unchanged and zero task-owned resources.

The TypeScript Chatter schema is archived and its TypeScript source consumers have not adopted the native model; an existing `spam.ts` model import may now be unresolved. This migration checkout permits retiring a verified source even when callers/builds remain broken. Caller cutover, broader spam completion, deployment and push remain separate. This does not complete total migration.

See the [dated retirement note](moderation-chatter-retirement-2026-10-30.md), the [pre-retirement schema handoff](moderation-chatter-schema-handoff.md), and the [indexed evidence](evidence/2026-10-30-moderation-chatter-retirement/README.md).
