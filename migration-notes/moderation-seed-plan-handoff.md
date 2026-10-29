# Moderation seed-plan handoff

## Accepted local mapping (2026-10-29)

The accepted native module is commit `fb642a0c`, source-tree SHA-256 `d8572c21fa330101815337afd904c2481b3c4a7c5a46afdfbf5a004456c9948a`, over 1,350 inputs. The pure planner maps all three source functions—`isUntouchedLazyStub`, `planModerationSeed`, and `existingChannelModerationView`—and the exported `ModerationSeedPlan` union. Source/runtime dependencies are also mapped: the `MODERATION_SETTINGS_DEFAULTS` runtime constant comes from the existing native channel-settings schema, while the `IChannelModerationSettings['rules']` type-only contract maps to the existing `Vec<IModerationRule>` representation. `JsString` and the shared JavaScript-compatible number formatter supply the native string/number behavior used by the view.

The candidate projection is read-only: `enabled: Option<bool>`, `rules_len: Option<usize>`, and `settings_version: Option<f64>` preserve the source's missing/null defaults, the rules-array length test, strict `enabled === false`, and strict version `=== 1` after nullish defaulting. It does not copy or interpret rule elements because the TypeScript predicate only reads `rules.length`. The source decision order maps to `Create`, `ReplaceStub`, and `Keep`.

`ExistingChannelModerationView` exposes all six source fields: borrowed UTF-16 `channelID` and `channel`, `enabled`, `offense_window_seconds`, a fresh owned `Vec<IModerationRule>`, and `settings_version`. Each constructor call creates an independent empty rules vector. The additional JSON helper constructs and encodes a fresh view to verify ordered wire output; it is not a serializer for a caller-mutated view. The native helper itself has no database write or other application side effect.

## Boundary

The source helpers are used by TypeScript orchestration: `defaults.ts` uses the planner and re-exports the helpers, while the moderation route uses the empty view for GET responses; auth registration invokes the broader `seedDefaultModerationSettings` routine. Mongo create/update, race handling, logger behavior, cache priming/invalidation, registration, and application caller adoption remain in that surrounding TypeScript path. These are not dependencies of the pure planner's own contract and do not make the bounded local source/type mapping partial. The wider seeding/application path remains unmigrated and unadopted.

The source default object is mutable JavaScript at runtime, but in-repository uses found for this constant read its values or spread them into another object; this fixed-catalog typed mapping does not emulate arbitrary external mutation of the shared object, consistent with the other mapped default constants. Candidate values are typed rather than arbitrary runtime JavaScript objects; prototype behavior, invalid casts, and non-number coercion hooks are outside the contract.

See the [dated verification record](moderation-seed-plan-2026-10-29.md) and [evidence package](evidence/2026-10-29-moderation-seed-plan/README.md) for frozen-source bindings, cases, accepted receipts, and run/resource readback. This row adds no application integration, TypeScript retirement, benchmark, deployment, push, or overall completion percentage.
