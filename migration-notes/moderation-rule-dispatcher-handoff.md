# Moderation rule dispatcher handoff (2026-10-30)

## Accepted bounded status

The opt-in Rust dispatcher in `dimabot/src/utils/moderation/rule_dispatcher.rs` was verified at source commit `c90cdd98e431df675fbc905c9e33cd8fae04a07e` against frozen source snapshot `050b65cf06adb805637948c65ab2010b23dde85fc3a263654dc8dd9ca6d62170`. The 22-case actual-TypeScript oracle, 19 ordinary tests, formatting, feature-profile checks, strict all-feature/all-target Clippy and profile checks passed. Detailed receipts and retained provenance are indexed in [the evidence package](evidence/2026-10-30-moderation-rule-dispatcher/README.md); the scoped feature status is in [the migration note](moderation-rule-dispatcher-2026-10-30.md).

The module directly dispatches to existing caps, links, emote-spam, and blacklist evaluators and uses the shared JavaScript-compatible number formatter. Schema fields are selected from a type-only `IModerationRule` contract. No mock evaluator or application-service boundary substitutes for behavior. The current integration is still a partial mapping because the blacklist adapter accepts only patterns built by its native literal-term compiler, while the TypeScript interface accepts arbitrary `RegExp` values. Reviewed application callers compile patterns from terms. TypeScript callers remain active and have not adopted the native dispatcher; no source retirement, deployment, or push occurred. No benchmark or performance claim was made.

## Reproduction command forms

Use an immutable read-only source snapshot and the task-owned, capped compiler environment described in `dimabot/RUST_AGENTS.md`. The actual accepted fixture was independently hash-pinned as `bcd9ffc9be201032c500e465f8443ae5f5abc9a57d7b95e9dd62909b924fddc6`. These command forms explain how to replay the evidence; they are not permission to run Cargo or Node directly on the host.

```sh
DIMA_RULE_SOURCE_ROOT=/snapshot node /snapshot/dimabot/tests/fixtures/moderation_rule_dispatcher_reference.cjs --check /artifacts/dispatcher-fixture

cargo fmt --all -- --check
cargo test --locked --no-default-features --features moderation-rules --test moderation_rule_dispatcher
DIMA_RULE_DISPATCHER_FIXTURE_DIR=/artifacts/dispatcher-fixture \
DIMA_RULE_DISPATCHER_FIXTURE_SHA256=bcd9ffc9be201032c500e465f8443ae5f5abc9a57d7b95e9dd62909b924fddc6 \
cargo test --locked --no-default-features --features moderation-rules --test moderation_rule_dispatcher -- --ignored replay_actual_dispatcher
cargo check --locked --no-default-features --all-targets
cargo check --locked --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --all-features --all-targets -- -D warnings
```

The 22-case oracle exercises the complete source branch contract and uses no evaluator mocks. Its metadata pins source imports, runtime exports, schema fields and aliases, native module/test sources, Node and TypeScript binaries, and runtime/Unicode versions. Fixture text uses UTF-16 code units and floating-point values use binary64 bit patterns. The Rust replay checks the independently supplied fixture digest and source/native hashes before comparing outputs.

This handoff describes the accepted local candidate only. It does not authorize production access, service changes, deployment, caller cutover, or a push.
