# Lossless JSON capability feature — 2026-10-30

Status: **verified as an independent optional Rust capability**. The change is commit `35aa783f7d7f5e18ca858ee8f4d640664a9ec02c`, touching only `dimabot/Cargo.toml`, `dimabot/src/utils/mod.rs`, `dimabot/src/utils/lossless_json.rs`, and `dimabot/src/utils/tts/settings.rs`. The final immutable input manifest is source tree `e8b67fafbb727e4b77f34c7fc2e875e73ef968220784a37a1611fe9250e79486`, with 1,474 inputs (1,464 Git paths and ten previously captured `posthog-rs` verification files).

## Feature graph and reuse

The new standalone `lossless-json` feature composes `js-strings`, `serde_json`, and `serde_json/float_roundtrip`. `tts-utilities` now composes `lossless-json` and retains its existing `regex` and `tokio` selections. No new crate was added; Cargo.lock and default features are unchanged. `lossless-json-view` continues to select `tts-utilities` for its settings coercion helpers. Existing Mongo-only, Mongo/Redis, and dashboard worker profiles remain unchanged.

The prior JavaScript truthiness helper moved from `tts::settings` to public `lossless_json::truthy(&JsonValue)` with its exact old body, SHA-256 `30ba3e6117884a580781ba7d4bc59717fa657244aacaa21b24f416eebd431062`. `tts::settings` reexports the helper to preserve the prior path. Missing values remain falsy through `Option::is_some_and(truthy)`. Parent reuse evidence records an unchanged lockfile, worker profiles, and dependency installation state. This refactor moves existing behavior behind an independent feature; it does not port new JavaScript runtime behavior or imply caller retirement/adoption.

The feature unit cases cover absence, null, booleans, positive and negative zero, NaN, infinities, empty and lone-unit UTF-16 strings, and empty arrays and objects. Existing parser tests for compact object output, insertion duplicates, UTF-16 handling, and canonical index ordering remain with the capability.

## Verification

The isolated formatter phase `1793360483014850688` passed and applied zero files. The final capped compiler phase `1793360512907512319` passed with a 100.317-second compiler step and 109.836 seconds total. The actual runner is preserved as `reproduction-tools/lossless_json_quality1.sh`; it ran `cargo fmt --all -- --check`, the standalone JSON tests, the `tts-utilities` library tests, feature-scoped Clippy, minimal all-target check, Mongo/Redis all-target check, all-feature all-target strict Clippy, and the standalone feature dependency tree.

Results: three standalone JSON tests passed; nine TTS utility library tests passed and one existing Node-backed pricing oracle remained ignored by its established requirement. Feature-scoped primitive linting, minimal all-target compilation, Mongo/Redis all-target compilation, all-feature/all-target strict Clippy, and formatting passed. The `cargo tree -e features -i dima-rust` output for `--no-default-features --features lossless-json` shows only `js-strings`, `lossless-json`, and `serde_json`; it does not pull in TTS utilities.

The compiler used the pinned Rust 1.99.1 toolchain image with 6 CPUs, a 4 GiB memory cap and equal memory-swap limit (no swap), 256 PIDs, two Cargo jobs, and the private cache capped below 8 GiB. Minimum observed host available memory was 9,046,740,992 bytes; private cache peak was 8,369,299,456 bytes. The compiler and formatter receipts and logs preserve the exact run output. No Node oracle, network-dependent feature test, benchmark, or deployment was performed or needed for this source-only move.

## Worker and production scope

No worker runtime recheck was warranted: the new feature tag is optional, the truthiness implementation is unchanged, and deployed worker profiles and their selected dependencies are unchanged. No worker registry, binary, service, Compose file, API, dependency version, or caller adoption changed. No performance or dependency-graph reduction claim is made; only the standalone Cargo feature-tree output is reported.

Read-only production readback compared all 18 recorded production services before and after; all remained unchanged and no task-owned containers, networks, or volumes remained. The previously acknowledged Piper removal is part of the recorded baseline, not a feature change. This verification is not a release or deployment authorization, and no caller cutover or source retirement is implied.

## Evidence

The evidence bundle preserves the complete 1,474-path source manifest, commit and SDK capture binding, tested delta, reuse proof, exact runner and standard validator, raw compiler/formatter receipts and logs, and before/after production readbacks. Gzip-compressed artifacts are lossless and the payload index records raw and stored hashes and byte counts. The ten SDK paths are represented by their prior exact tracked-file capture; the SDK source tree is not duplicated.
