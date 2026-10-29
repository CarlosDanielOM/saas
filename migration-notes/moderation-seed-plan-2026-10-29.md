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

The original `defaults.test.ts` has four test cases/groups covering the untouched stub, saved/configured documents, plan outcomes, and the disabled empty GET view without an invented document ID. Their behavior is covered by the source/native evidence. The `defaults.test.ts` inventory row itself is unchanged in this review.

## Accepted verification

The frozen candidate is commit `fb642a0c`, source-tree SHA-256 `d8572c21fa330101815337afd904c2481b3c4a7c5a46afdfbf5a004456c9948a`, with 1,350 inputs. The mapped TypeScript source retains baseline SHA-256 `529f7a4e395c2a4181c05be81f73082b7a5b52ef6ee18ea4036f9f66ac86b541`. The source-bound oracle executed the unchanged seed module with the actual channel settings schema and spam module in a disconnected Mongoose 8.24.2 environment and real Node crypto, and checked the strict TypeScript AST/import closure. It matched 110 decision cases and five lossless ordered JSON wires, including UTF-16 edge values; the accepted reference fixture SHA-256 is `09efa8c6312cf99fa60e6f6d9a324d652ab9ba87a70509a5135c039809f6c044`. The ordinary native test checked all six view fields and that separately constructed views own independent rules vectors.

All accepted receipts passed: Node `1793314343442641635`, compiler `1793314343446707321`, and full compiler replay/check phase `1793314472014779107`. The ordinary compiler receipt passed its focused test and scoped formatting/Clippy checks. The full phase passed the ignored source replay, no-feature checks, Mongo/Redis checks, all-features/all-targets checks, and Clippy. The original four TypeScript test behaviors were not treated as a separate feature completion row.

The first Node/compiler launch was refused by the 8 GiB startup headroom guard before resources were created; no available-memory byte reading was captured for that refusal. This was an operational guard, not a source/test failure. The same frozen candidate later resumed under the 4 GiB compiler cap. The accepted compiler phase took 116.49 seconds and the phase-inclusive run took 123.892 seconds; minimum available memory was 7,742,357,504 bytes and build cache was 5,177,495,552 bytes, with six CPUs, no swap, 256 PIDs, and two compiler jobs. These are run conditions, not performance measurements.

Final readback records 19 unchanged production records and no owned resources remaining. No database runtime test was needed for these pure helper functions; no new benchmark, TypeScript retirement, caller adoption, deployment, or push is claimed.

## Caller and migration boundary

The helpers remain unadopted. `defaults.ts` uses `planModerationSeed` inside the broader `seedDefaultModerationSettings` orchestration and re-exports the pure helpers. The moderation route uses the empty view for an in-memory GET response; auth registration calls the broader seed routine. Mongo reads/writes, duplicate-key recovery, cache priming/invalidation, error logging, and registration behavior remain in the surrounding TypeScript modules. This keeps the local pure helper mapping complete while the larger application seeding path remains open.

`MODERATION_SETTINGS_DEFAULTS` is a mutable JavaScript object at runtime, but source references found in the repository read its fields or spread it into a separate object; this fixed-catalog typed mapping does not model arbitrary external mutation of the shared object. This is the same boundary used for the other mapped fixed default constants. The source stays live and unarchived. The overall inventory completion percentage remains null.

Raw source bindings, reference fixture, accepted receipts, and readbacks are indexed in [`evidence/2026-10-29-moderation-seed-plan/`](evidence/2026-10-29-moderation-seed-plan/README.md). See the [seed-plan handoff](moderation-seed-plan-handoff.md) for the type and dependency closure summary.
