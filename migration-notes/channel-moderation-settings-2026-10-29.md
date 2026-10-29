# Channel moderation settings: source parity and isolated persistence (2026-10-29)

This note records the accepted bounded Rust mapping for `channel_moderation_settings.schema.ts` and its required shared schema-core behavior. The final frozen source/build tree has SHA-256 `f630b11bf6ed08984f28de5cc14262c139c6541c581823561c1d53e3d93630fd` across 1,341 inputs. The core changes are commit `956aa9dc`; the channel settings model is commit `3bfbfbd1`. The pinned Node, compiler, and full-fixture receipts passed on this final frozen candidate.

## Source behavior and native mapping

The module exports three string unions (`ModerationRuleType`, `ModerationAction`, `CapsThresholdMode`), three interfaces (`IModerationOffenseStep`, `IModerationRule`, `IChannelModerationSettings`), three defaults objects, six limits, `buildDefaultModerationRules`, and the Mongoose model `ChannelModerationSettingsSchema`. The Rust module maps those enums/structs/defaults/constants and the builder. The Mongoose schema declaration is represented by `schema() -> &'static SchemaDefinition`; `get_channel_moderation_settings_model(&Database)` creates a `SchemaRepository` against a caller-provided database. The repository can explicitly install the unique `channelID` index and perform insert, find, and save operations. Native repository construction does not connect or install indexes implicitly.

The source's runtime imports are the spam category lists/defaults/threshold, Node `crypto.randomUUID`, and Mongoose `Schema`/`model`. `SpamProtection`, `ModerationVariations`, `PermissionExpression`, `ModerationPattern`, and `SemanticPolicy` are type-only imports. Rust uses the existing `SpamCategory`/`SpamProtection` and caps types, existing UUID v4 support, and `JsString`. `PermissionExpressionMixed` is BSON `Mixed`; malformed expressions are preserved because the source schema does not validate them. BSON strings require UTF-8, so lone UTF-16 surrogates become U+FFFD at this storage boundary.

The three offense defaults are distinct: `warn`, `delete`, and `timeout`, each with 60 seconds. The source rule builder shallow-spreads a base object, so its four rules share corresponding offense objects and `allowlistDomains`/`terms` arrays within one call, while separate calls create fresh base values. Rust represents this sharing explicitly with `Arc<Mutex<_>>`; IDs use the existing UUID v4 crate and retain source rule order and reasons. The six limits are `MAX_TIMEOUT_SECONDS`, `MIN_OFFENSE_WINDOW_SECONDS`, `MAX_OFFENSE_WINDOW_SECONDS`, `MAX_RULES_PER_CHANNEL`, `MAX_BLACKLIST_TERMS`, and `MAX_ALLOWLIST_DOMAINS`; all three defaults objects and their numeric values are mapped.

The schema keeps the source model/collection name, required `channelID`, generated Mongo `_id`, version key, timestamps, and unique `channelID` index. It maps `_id: false` nested schemas, channel/rule/spam-protection defaults, category and exempt-tag enum validation, numeric bounds, pattern/semantic subdocuments, and Mixed variations/expression values. `FieldDefault::Value(Bson)` clones nonempty array/object templates per construction. `ArrayElement` casts and validates individual elements, preserving indexed validation errors. `Field::minimize()` recursively prunes empty object properties only for marked Mixed fields.

## Accepted verification

The pinned Node reference executed the complete unchanged TypeScript model and actual spam-category module against a disconnected Mongoose 8.24.2 instance and real Node crypto. It checked source imports and type-only contracts and fingerprinted the Mongoose/BSON implementation helpers used by these cases. Independent readback confirmed all source/native/SDK/runtime fingerprints.

The accepted references and replay covered:

- 97 synthetic schema-core cases and four selected actual-model records.
- 56 full actual-model cases, including full constructed documents/errors, independent defaults and builder sharing behavior.
- Six new ordinary Rust tests, two source replay tests, one isolated Mongo repository test, and one existing application Mongo persistence test. The existing application check completed in 0.85 seconds.
- Eleven existing regression tests: five schema-core, three application-schema, two additional application cases, and one channel-TTS case.
- Strict formatting, no-feature, Mongo/Redis, all-features/all-targets, and Clippy checks.

The task-owned Mongo fixture exercised index creation, insert, read, duplicate rejection, update, and the updated timestamp. It uses a unique owner-named empty database, marker, and endpoint; cleanup removes only the fixture's collections after checking the marker and names. Final readback reports 19 unchanged production records and zero task-owned containers, networks, or volumes. This was isolated validation only.

All three final pinned receipts passed: Node `1793311821006651643`, compiler `1793311821020142484`, and full compiler fixture phase `1793311873934271303`. The full fixture phase took 147.058 seconds and the phase-inclusive run 156.944 seconds under the existing 6 CPU, 4 GiB memory/no-swap, 256-PID, two-job cap. Minimum available memory was 7,823,761,408 bytes and peak cache 4,800,012,288 bytes. These are run conditions, not a performance comparison. No benchmark was measured as part of this acceptance.

## Iteration history and limits

The raw evidence preserves four candidate waves and classifies each failure against its own source hash. The first Node harness had a missing parenthesis; an early compiler fixture used an obsolete BSON v3 test API. Later source comparison exposed a real nested Mixed minimization mismatch, then a real `cloneObject` constructor/`valueOf` branch mismatch. Those behaviors were corrected and the final source replay passed. A separate compiler run hit the Cargo `include_bytes!` source-hash guard because edited inputs retained stale mtimes; the final frozen dependency inputs received fresh mtimes so Cargo rebuilt the included files, with the toolchain unchanged. One fixture run disagreed on normalized cast-error labels; the accepted oracle retains the original `sourceName`/`sourceKind` alongside the normalized kind compared by the native replay. These are distinct harness/API, artifact-guard, and source-parity issues; they should not all be reported as functional regressions.

Coverage is bounded to the typed BSON/ordinary JSON model path and the explicit Mongo repository. It does not establish universal Mongoose or JavaScript object parity for sparse/undefined slots, executable hooks, arbitrary prototypes, or exotic constructor metadata. The TypeScript model, handlers, API, seeding, and moderation workers remain live. The Rust repository requires an explicit `Database`; no application caller has adopted it and no TypeScript retirement occurred. Overall migration remains incomplete. No performance result, deployment, or push is claimed.

The full evidence index, raw receipts, final readbacks, and frozen source fingerprints are in [`evidence/2026-10-29-moderation-schema/`](evidence/2026-10-29-moderation-schema/). See the [schema composite defaults handoff](schema-composite-defaults-handoff.md) and [channel settings handoff](channel-moderation-settings-handoff.md) for the focused API and migration boundaries.
