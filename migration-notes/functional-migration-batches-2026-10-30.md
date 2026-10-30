# Functional schema migration batch — 2026-10-30

## Nine ordinary schema sources

Commit `bb4bf87f17485d81e9d244cbd59ae9406851ccec` retired nine TypeScript schema files byte-for-byte and added ten concrete native model descriptors: six ordinary models plus `follow_attack_log`, `follow_defense_action`, `follow_defense_control`, and `follow_hate_raid_source`. Native definitions use the existing MongoDB driver and `SchemaDefinition` repository; the feature flags are `ordinary-application-schemas` and `follow-defense-schemas`.

The final source tree is `1cb7019ca495174fc498502c8f3a788cb7d164c521c28007c9d720cb3e708d94`. The 1,540-input binding includes 17 external SDK/hash inputs, not 1,540 Git files. Parent verification compared the source inputs and reviewed the run receipts. The archive grew from 51 to 60 entries; the original 51 entries remain unchanged.

Source Node write/check and resolver-negative checks passed. The compiler-fixtures run passed 11 unique tests, five timezone replay invocations, private Mongo CRUD/index/projection/write-concern checks, formatting, scoped Clippy, minimal profile, and all-feature/all-target strict Clippy. The existing BitsStore source/private-Mongo fixture also passed after retirement. Production readbacks remained unchanged. Performance measurement was deferred.

Raw BSON repository documents and strict typed views remain distinct contracts. This batch verifies local schemas, exports, required native values and their declared persistence behavior; it does not establish application caller adoption, cutover, deployment, or total migration completion. AI constants are a separately verified local library slice whose TypeScript source/test retirement is pending and is not counted here.

The matrix updates exactly these nine application rows: `temporary_moderator`, `vip`, `title_config`, `trigger_file`, `eventsub`, `site_analytics`, `follow_attack_log`, `follow_defense_action`, and `follow_hate_raid_source`. The test source rows were not changed. See [ordinary schema handoff](ordinary-application-schemas-handoff.md), [follow-defense handoff](follow-defense-schemas-handoff.md), [ordinary schema Rust tests](../dimabot/tests/ordinary_application_schemas.rs), and [follow-defense Rust tests](../dimabot/tests/follow_defense_schemas.rs).

## Native API services

Commits `108900d4` (API auth) and `e22dce7d` (embeddings/retry) wire the opt-in `ai-embeddings` and `api-auth` features, which passed a combined source-bound validation at tree `ae5abb14ba18c0e5c4a53c2933c2c5de3defddd08f1dba5d4f2830a6fb0be4f2`. Node source-oracle receipt `1793394887011718516` and compiler-fixtures receipt `1793394908023978034` passed; 30 native tests passed across embedding, retry, auth integration, and auth library behavior. Formatting, strict scoped Clippy, minimal-profile checks, all-feature strict Clippy, and isolated MongoDB/Dragonfly/HTTP fixtures passed. Production readback was unchanged. No benchmark was run. The TypeScript sources remain live; API route/bootstrap adoption, cutover, and deployment are separate. See the [embeddings handoff](ai-embeddings-handoff.md) and [API auth handoff](api-auth-handoff.md).
