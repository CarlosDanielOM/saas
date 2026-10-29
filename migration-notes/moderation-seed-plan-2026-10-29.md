# Moderation seed-plan — 2026-10-29

## Scope and mapping

This accepted bounded port covers the pure policy module `src/utils/moderation/seed_plan.ts`: `isUntouchedLazyStub`, `planModerationSeed`, `existingChannelModerationView`, and exported `ModerationSeedPlan`. The native module is opt-in behind `moderation-seed-plan`, which depends on the already-mapped `channel-moderation-settings` feature.

The source imports `MODERATION_SETTINGS_DEFAULTS` at runtime and imports `IChannelModerationSettings` only as a type. The native implementation reuses the existing native settings constant (`offense_window_seconds` and `settings_version`) and existing `IModerationRule` type. Shared `JsString` and JavaScript-compatible number formatting cover the data representation needed by the view. Thus the direct source and type-only dependency closure for these pure exports is mapped; database, cache, and registration services are not part of this module's functions.

The TypeScript candidate type is projected into `Candidate { enabled: Option<bool>, rules_len: Option<usize>, settings_version: Option<f64> }`. This is sufficient because the predicate only reads the rules value's length: nullish/missing rules and an empty array take the same empty-rules branch, while a nonempty array does not. `Option` represents missing/nullish values for version and enabled; the native comparisons retain strict `false` and strict `=== 1` semantics after nullish version defaulting. Source cases include null/undefined, missing/null rules, changed versions, fractions, NaN, and infinities. The decision mapping is:

| Source plan | Native value |
|---|---|
| `create` | `ModerationSeedPlan::Create` |
| `replace-stub` | `ModerationSeedPlan::ReplaceStub` |
| `keep` | `ModerationSeedPlan::Keep` |

The native view contains all six source fields: borrowed `channelID` and `channel`, disabled state, the two existing default values, and a fresh owned `Vec<IModerationRule>`. Each call owns a separate rules vector. The separate JSON helper preserves ordered UTF-16-safe wire output for a newly constructed view; it is not a serializer for externally mutated views. The pure helpers do not create or update Mongo records.

The original `defaults.test.ts` has four test cases/groups covering the untouched stub, saved/configured documents, plan outcomes, and the disabled empty GET view without an invented document ID. Their behavior is covered by the source/native evidence and the post-retirement source replay. Retiring this test row records preserved test behavior; it does not add a feature completion mapping.

## Accepted verification

The frozen post-retirement candidate is source commit `9968e4af`, source-tree SHA-256 `4f263a49502e028ad92c966ba8ceeaa8981c8591698b39ac0be2fc8a24a30828`, with 1,350 inputs. The archived TypeScript source retains baseline SHA-256 `529f7a4e395c2a4181c05be81f73082b7a5b52ef6ee18ea4036f9f66ac86b541`. The disconnected source-bound oracle executed the unchanged archived seed module with the actual channel settings schema and spam module, real Mongoose 8.24.2 and Node crypto, and checked the strict TypeScript AST/import closure. It matched 110 decision cases and five lossless ordered JSON wires, including UTF-16 edge values; the accepted reference fixture SHA-256 is `09efa8c6312cf99fa60e6f6d9a324d652ab9ba87a70509a5135c039809f6c044`. The ordinary native test checked all six view fields and that separately constructed views own independent rules vectors.

The post-retirement acceptance receipts passed: Node resolver/oracle run `1793316521093725052`, ordinary compiler run `1793316521091443097`, formatting run `1793316475251053756`, and full source replay/check run `1793316937008591281`. Resolver tests passed for seed, caps, and emote spam. The regenerated cases matched their accepted pre-retirement objects: 110 seed decisions and five wires, 5,348 caps cases, and 360 emote-spam cases. All three native source replays passed. Relevant ordinary tests, formatting, all three feature profiles, all-targets/all-features checks, and Clippy passed. The four original TypeScript test behaviors remain represented by feature evidence; retirement does not change the feature-completion counter.

The first Node/compiler launch was refused by the 8 GiB startup headroom guard before resources were created; no available-memory byte reading was captured for that refusal. This was an operational guard, not a source/test failure. The same frozen candidate later resumed under the 4 GiB compiler cap. The accepted compiler phase took 116.49 seconds and the phase-inclusive run took 123.892 seconds; minimum available memory was 7,742,357,504 bytes and build cache was 5,177,495,552 bytes, with six CPUs, no swap, 256 PIDs, and two compiler jobs. These are run conditions, not performance measurements.

Final readback records 19 unchanged production records and no task-owned containers, networks, or volumes remaining. No database runtime test was needed for these pure helper functions. The source and test are now retired and archived; caller adoption, deployment, and push are not claimed. No new benchmark or performance result is claimed.

## Caller and migration boundary

The helpers remain unadopted. `defaults.ts` uses `planModerationSeed` inside the broader `seedDefaultModerationSettings` orchestration and re-exports the pure helpers. The moderation route uses the empty view for an in-memory GET response; auth registration calls the broader seed routine. Mongo reads/writes, duplicate-key recovery, cache priming/invalidation, error logging, and registration behavior remain in the surrounding TypeScript modules. This keeps the local pure helper mapping complete while the larger application seeding path remains open.

`MODERATION_SETTINGS_DEFAULTS` is a mutable JavaScript object at runtime, but source references found in the repository read its fields or spread it into a separate object; this fixed-catalog typed mapping does not model arbitrary external mutation of the shared object. This is the same boundary used for the other mapped fixed default constants. The source and its four-group test are retired and preserved byte-for-byte in the archive. `defaults.ts` and the moderation handler still import the removed helper; Mongo, cache, and registration orchestration and caller adoption remain open. The frozen inventory remains 806 rows, with 17 locally complete and nine partial feature mappings; the overall completion percentage remains null. See the [retirement handoff](moderation-seed-plan-retirement-handoff.md) for post-retirement evidence and archive status.

Raw source bindings, reference fixture, accepted receipts, and readbacks are indexed in [`evidence/2026-10-29-moderation-seed-plan/`](evidence/2026-10-29-moderation-seed-plan/README.md). See the [seed-plan handoff](moderation-seed-plan-handoff.md) for the type and dependency closure summary.
