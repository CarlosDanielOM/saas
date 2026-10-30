# Moderation variation job type closure — 2026-10-30

## Scope and result

This is a bounded type-closure update to `src/schemas/moderation_variation.schema.ts`, not retirement of the schema or migration of the variation-jobs service. Native `VariationJob.providerUsage` now uses `Vec<Document>`, matching the declared TypeScript type `Array<Record<string, unknown>>`; owned conversion paths move those documents while existing borrowed conversions remain available. The type change is an API change for Rust callers that construct or access the field.

The independent source epoch binds all 1,507 inputs to commit `60e0fe66e2399f435cf194bd880c3965e82d39b3` (1,497 Git plus ten reused SDK inputs), tree SHA-256 `513090602980dc8099dd9f1a2570b64e2528284d84dd007eff28dd14351310c1`. All hashes were independently verified. Its candidate oracle retains the original 42 constructor cases, collection/index facts and full BSON wire bytes, and adds six `providerUsage` cases. The semantic comparison confirms the original 42 cases and metadata are unchanged; the final fixture SHA-256 is `2d446d970060e76f3a0ef37e3fe71d9d135b57bc30eed68a0213f3422c2ba4a7`.

## Verification

Formatting `1793380335736540210`, Node source/oracle check `1793380394923545442`, and corrected compiler-fixtures run `1793380495938913604` passed. The compiler run covered all five variation-schema tests, 42 source constructor cases, six added usage-shape constructor cases, real Mongo CRUD/index behavior, formatting, scoped Clippy, minimal profile and all-feature strict checks. It took 106.553 seconds overall and 94.152 seconds in the compiler phase; the recorded minimum available memory was 12,748,046,336 bytes and cache peak 8,321,159,168 bytes, under the 6 CPU, 4 GiB no-swap, two Cargo job, 256 PID limits.

An earlier compiler-fixtures wrapper (`1793380423836253022`) omitted three required private Mongo fixture variables. Four tests passed before the database test could run; this was a harness configuration failure, not a product or model-quality failure. The source did not change, and the corrected wrapper passed the full five-test suite. Both attempts and the correction record are preserved.

## Boundaries

This verifies the source-declared `providerUsage` type in the native DTO and its construction/conversion paths. Raw BSON preserves missing, null and other permitted Mixed storage values; strict typed views reject incomplete or incompatible records. The existing variation-jobs service remains separate, and TypeScript model callers remain live. This work makes no source-retirement, caller-adoption, deployment, benchmark, RSS, allocation-count or application-performance claim. Production readback found 18 containers unchanged and zero task-owned resources.

See the updated [schema handoff](moderation-variation-schema-handoff.md) and [evidence package](evidence/2026-10-30-variation-job-type/README.md). The prior 42-case Mongoose schema evidence remains in [the original schema package](evidence/2026-10-30-variation-schema/README.md); this package preserves the separate type-closure epoch and its added oracle cases.
