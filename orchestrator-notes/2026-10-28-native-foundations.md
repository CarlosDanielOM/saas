# Native foundations migration routing evidence — 2026-10-28

This is one bounded migration batch, not a general model benchmark or a reason to reorder the user's baseline model tiers.

## Work observed

- GPT-6.1 Sol at xhigh handled bounded native foundation ports. In lead review, the batch surfaced and corrected three BSON feature-selection errors, application mapping mismatches, false parity reports caused by cross-VM Mongoose realm checks, a partial-save/hidden-field leak, avoidable shared JSON reserialization, and AST performance regressions. The lead reviewed the source changes and associated disposable-fixture evidence; this is evidence for routing a similar scoped port to Sol xhigh, not a broad Rust capability claim.
- GPT-6 Luna at high updated the progress note and archive README from raw artifacts. The documentation pass corrected the test-source status, separated serialization-inclusive and core timings, kept dependency and caller gaps explicit, and added source-to-native archive mapping. The bounded result supports Luna high for similar documentation reconciliation, not a general implementation comparison.

The migration remains incomplete. The [JWT caller audit](../migration-notes/credential-jwt-callers-2026-10-28.md) is complete for its primitive scope; broader file/caller/dependency reconciliation, application adapters and other TypeScript areas remain open. No total migration percentage is claimed. The first AST foundation commit is `a3893131`; subsequent migration commits are owned by the lead. No deployment or push is included in this evidence.

## Measurement boundaries

The benchmark raw samples are [preserved in the repository](../migration-notes/evidence/2026-10-28-foundations/README.md), with originals under `/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/`. The compiler matrix receipt is `compiler-1793207656819371013-receipt.json` (source tree SHA-256 `addf636590911176d33e1881a79f65f57c1f1608ff4230af7cd19cf821295bf7`); its all-feature all-target checks and Clippy, no-default-feature all-target check, and task-owned resource/production-unchanged safeguards passed. The standalone credential-activation log records 3 passed, 0 failed, 2 ignored. The ignored child-environment probe is launched by the facade test in a fresh subprocess; the other ignored item is an explicitly separate benchmark. Do not combine child cases into the test-harness test total. `Cargo.lock` is unchanged and no dependency was added.

The pure-helper benchmark has mixed outcomes: core-only native execution is slower, while the serialization-inclusive native workload is faster with the same fixture checksums. AST and other benchmark details, workload limits, and regression disclosures are in the [migration record](../migration-notes/full-dimabot-rust-2026-10-28.md). A potential advantage from fewer ODM document allocations, using direct compiled crypto, sharing pooled clients, or avoiding repeated JSON serialization is an implementation-based inference, not an isolated causal measurement. The TypeScript benchmark setup compiles once; its measured worker loops run compiled JavaScript.

Confidence is low for model-wide routing: there is one bounded batch and no matched-model comparison, no runtime benchmark of model generation, and no TPS/cost comparison. Use the task fit and observed evidence to route similar work; retain the established baseline and validate model availability/options from the live catalog before dispatch.

## Native extension follow-up — 2026-10-28

- GPT-6.1 Terra at high implemented the observability/logger, TTS utility, and Bits model/store additions. GPT-6.1 Sol at xhigh led source review and corrected integration details: a BSON API rename, a `Send` closure fix for the Mongo CAS fixture, exact numeric comparison in fixtures, a Mongoose cross-VM realm issue, and a fixture coordination deadlock. The combined Rust snapshot and Node source-oracle/store evidence are recorded in [native-telemetry-tts-bits-2026-10-28.md](../migration-notes/native-telemetry-tts-bits-2026-10-28.md) and [evidence/2026-10-28-native-extensions](../migration-notes/evidence/2026-10-28-native-extensions/).
- This adds one bounded Terra implementation observation and one Sol review/fix observation. It is low-confidence task-fit evidence only: no matched-model comparison, no model TPS/cost measurement, and no reason to reorder the user's model tiers. Keep the baseline unchanged and qualify routing by task and current catalog availability.
