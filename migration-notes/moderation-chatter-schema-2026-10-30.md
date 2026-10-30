# Moderation Chatter schema verification — 2026-10-30

**Status: focused schema and first-seen verification passed; TypeScript remains live.** This work adds source-backed test and fixture coverage around the existing native schema and moderation spam primitive. It does not retire the TypeScript schema, complete the broader spam migration, or change production code.

## Bound source and schema contract

The verified source is commit `81f2d07ce7adc09fb27b59199c9715f83ed3bbde`, bound across 1,506 inputs (1,496 Git and 10 reused SDK inputs), with source-tree SHA-256 `d96e31df4e8e7c222bbdd404eeaaa10f5b5e9f202b5c5ff106fc91ade45959fc`. The actual TypeScript module is pinned at `71ec2e9e8047a6d6a8da561c596d1cbacf2dc13ac93ca6ad2878ef95dec9632e`.

The model is `moderation_chatter`, using Mongoose's derived `moderation_chatters` collection. It has required `_id: String` and `firstSeenAt: Date` fields, no declared defaults or custom indexes, and `versionKey: false`; it declares no custom collection option, timestamps, hooks, or save clock. The actual-source oracle compiled the complete TypeScript module with pinned TypeScript and ran it with pinned Mongoose disconnected from any database. It captured 25 constructor, cast, and validation cases, metadata, and a typed BSON wire sample, including replacement of unpaired UTF-16 surrogates at the BSON boundary.

## Verification

The source-matched oracle was written and byte-checked at SHA-256 `42a11d1ed626b0be9fac05e8afce671dce33b442da69f5a53905e4e201394358`. Rust verification passed all seven tests: five ordinary schema/cast/preparation tests, the 25-case actual-Mongoose replay, and a real-Mongo test covering repository CRUD plus `SpamService::claim_first_observed_message` first-seen behavior. The latter checked durable document shape, a fresh service/cache instance with a cache miss not overwriting the timestamp, a warm-cache skip, and an independent chatter marker. The cache endpoint was a loopback RESP fixture; MongoDB was the isolated task-owned disposable fixture.

The same capped compiler job passed formatting, scoped Clippy, the minimal-feature check, and all-feature Clippy with warnings denied. It ran under the six-CPU, 4 GiB, no-swap, 256-PID, two-job limits, reusing the existing task-owned compiler cache through canonical symlinks and a global lock. Test execution took 0.08 seconds; the compiler job took 70.023 seconds total (57.891 seconds for its compiler step). Production readback found 18 records unchanged and zero task-owned containers, networks, or volumes.

Two small harness/test corrections preceded the passing verification. The TypeScript compiler exposed `FirstStatement` as a reverse-enum alias, so the harness now recognizes the declaration structurally with `ts.isVariableStatement`. Static review also corrected an expected error: required `_id` validation occurs before the missing-ID guard. Neither correction changed production logic. The failed Node attempt and original source overrides remain preserved as a separate historical epoch.

## Limits and follow-up

This verifies one schema contract and the tested first-seen path. Duplicate-key fault injection remains covered by the existing protocol fixtures, not forced in this real-Mongo run. The broader spam feature remains partial. TypeScript retirement, caller adoption, deployment, and push are separate and were not performed. No new Cargo dependency, performance benchmark, RSS measurement, or whole-application claim is made.

The updated [handoff](moderation-chatter-schema-handoff.md) preserves the fixture and test design. The [indexed evidence package](evidence/2026-10-30-moderation-chatter-schema/README.md) contains immutable source maps, bindings, oracle, readback, failed overrides, all run receipts/logs, and inert reproduction scripts. For the single-task DeepSeek routing observation, see [the dated routing note](../orchestrator-notes/2026-10-30-deepseek-chatter.md).
