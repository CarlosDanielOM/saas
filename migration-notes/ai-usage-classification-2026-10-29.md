# AI usage classification — 2026-10-29

## Scope and source mapping

The migrated feature is the pure module `dimabot/src/utils/ai_usage_classification.ts`, SHA-256 `00fcd076d0f3460ecea46588904242252a32b9500e43217c67a1a07e1cbe4b36`. It exports exactly:

- `ADJUSTMENT_TYPES`: the ordered tuple `manual_grant`, `monthly_reset`, `subscription_credits`, `purchased_pack`, `gifted_credits`, `native_grant`, `refund`, `correction`, `activation`, `other`.
- `classifyAdjustment(input)`: classifies a declared object with optional `entryKind`, `operation`, `source`, `reason`, and `adjustmentType` fields, each typed `unknown`; it returns one of the known strings or `null`.

There are no TypeScript imports, module initialization side effects, or I/O in this source. The Rust counterpart is `ai_usage::classify_adjustment_json(&JsonValue) -> Result<Option<&'static str>, SettingsError>`, gated by the already-existing `tts-utilities` module gate and usable when both existing `ai-usage` and `tts-utilities` features are enabled. The existing ten-value `ADJUSTMENT_TYPES` and shared `adjustment_policy` remain in `ai_usage.rs`; the new entrypoint reuses that policy instead of creating a second rule set.

## Native dependency closure

The new boundary is built from existing native components; it introduced no Cargo crate dependency and no feature declaration:

- Existing feature closure: `ai-usage` and `tts-utilities`. The former already brings optional `serde`, `serde_json`, and `uuid`; the latter already brings optional `regex`, `serde_json`, and `tokio` (with existing `serde_json/float_roundtrip` activation). These are pre-existing feature dependencies, not new classifier requirements or additions.
- The classifier directly uses the crate's existing `lossless_json::JsonValue`, `js_string::JsString`, `tts::settings::{truthy, js_string, SettingsError}`, `ADJUSTMENT_TYPES`, `explicit_adjustment`, and `adjustment_policy`.
- The transitive native implementation relies on existing `JsString` representation and conversion, `JsonValue` parsing/access, and `json_number` support used by lossless JSON. The settings conversion uses those same `JsonValue` and `JsString` types. The classifier makes no network, database, cache, billing, telemetry, or persistence calls.

This is the direct/transitive closure for the classifier boundary, not a claim that the broader AI usage application dependency graph has been ported.

## Exactness boundary

The new API maps the TypeScript implementation for ordinary JSON-data objects, including arbitrary unknown-valued fields. It retains:

- Exact branch precedence and returned label values.
- Early return when `entryKind` is not `adjustment`; explicit known `adjustmentType` wins before fallback coercion.
- JavaScript truthiness and string-conversion semantics for fallback `source` and `operation`, including the source evaluation order where both conversions happen before classification branches.
- UTF-16 code units, including unpaired surrogates, without lossy normalization.
- JSON duplicate-property semantics: the final value wins.
- The JSON-data coercion error when an object has a non-callable own `toString`, including error timing relative to the fallback path.

The generic Rust `SettingsError` denotes the source TypeError condition, but does not reproduce the exact JavaScript error message for top-level null (the TypeError name is preserved). Accessors, callable values, custom prototypes, user-defined coercion hooks, and invalid values reachable only through JavaScript runtime casts are outside the declared ordinary JSON-data object contract. The legacy `classify_adjustment(&serde_json::Value) -> Option<_>` remains source-compatible for existing callers, but its historical coercion is intentionally weaker (notably object/number conversion and inability to express TypeError). It must not be described as satisfying the new exact boundary.

No performance benchmark was run for this pure function. Prior receipt-helper timing records were generated against a different source snapshot (`22cb791f`) and are not attributable to this classifier or the whole app.

## Evidence and checks

Code is committed locally as `e5fad37a`. The [indexed repository evidence](evidence/2026-10-29-ai-classification/README.md) retains source/native bindings, full fixtures, raw receipts/logs and reproduction tools. All 52 indexed file hashes and compressed raw payloads were independently checked. Final readback found 19 unchanged production records and zero owned containers, networks or volumes. The independent readback records these important hashes:

- TypeScript source: `00fcd076d0f3460ecea46588904242252a32b9500e43217c67a1a07e1cbe4b36`.
- Native `src/utils/ai_usage.rs`: `a4d9b103569b5bce80150091ff028dbe09f90bdada0b7572525705e46a0431b5`.
- Native `src/utils/tts/settings.rs`: `e49542fb02eadaedfd28099c829f6b0bd43302af72d725147e3112b188f34fa9`.
- Native `src/utils/lossless_json.rs`: `81655862a29d68c01ab49a79027788c569d688bc1f7c9e55cbea20816dc7f2a6`.
- Native `src/utils/js_string.rs`: `17b3e6a6bcd0d92210851eca25da44bbcdb2c2d9e196feb5dab58d06b75d4aed`.
- Native `src/utils/json_number.rs`: `f463c65a55bcd611ed9bad2444e50acff697969bb910b7b4c17371d0af21f419`.
- Native focused test: `fc056bb734bb6a50a30488472f47aed01602ebaa0f2f34c200eb2191a9617699`.

The oracle extracts and typechecks the full actual TypeScript export AST, pins Node 24.22.1 / V8 13.6.233.17-node.58 and TypeScript 5.9.3, and generates expectations by running those exports. Node receipt `1793299987184873431` passed write/check for all 100 unique cases. Compiler receipt `1793299987183286077` passed format, scoped Clippy, two ordinary tests, and three existing AI usage library tests. Compiler receipt `1793300124243405961` passed the ignored native replay over all 100 oracle cases. The independent readback verified every recorded source, native, toolchain and oracle hash and confirmed all 100 unique cases.

The same snapshot's consumer oracles passed under Node receipt `1793300276390314123`: producer 338 plus 20 tier cases and 3,325 producer assertions, queries 333, parser 1,362 cases in each of five time zones, persistence 204, backfill 341, and lock 291. Final compiler receipt `1793300437308104735` succeeded in 557.794 seconds script / 567.155 seconds total, with a 3,584,106,496-byte cache and minimum available host memory 8,608,210,944 bytes. It passed 38 ordinary consumer tests (6 backfill, 11 persistence, 8 queries, 4 producer, 9 parser), feature-isolation checks, Mongo/Redis worker-profile all-target checks, all-feature all-target checks, and strict Clippy. Source producer/parser/query/persistence/backfill fixture counts were 338 / 1,362 per time zone / 333 / 204 / 341.

The compiler ran within 6 CPUs, 4 GiB memory with an equal memory-swap limit (no swap), 256 PIDs, and two Cargo jobs. For byte-hash provenance, the exact compiler script received one additional read-only `node_modules` mount; it hashed but did not execute the Node binary. No services were used in these replays. The recorded read-only production check found all 19 production records unchanged, including `ack api-ee0635765a02`. These records are reported from the supplied run receipts; this documentation-only work did not rerun them.

## Coverage and remaining work

Local feature coverage is the full pure classification module at the documented ordinary JSON-data boundary, including a TypeScript-executed oracle and native replay. Total AI usage migration coverage remains incomplete: this note does not port `ai_usage_event`, receipt production, billing, persistence, read APIs, queue processing, or any required application-specific adapter as a whole. The existing Rust receipt paths continue using the legacy serde API. No TypeScript source or caller was removed, no caller was switched to the new JSON boundary, and deployment/push were not performed. Caller adoption and deployment status are separate from this isolated feature's local coverage.
