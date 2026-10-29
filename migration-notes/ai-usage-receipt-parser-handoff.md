# AI usage receipt parser and borrowed JSON extension handoff — 2026-10-29

## Parent validation update — initial baseline

The final source passed the UTC parser producer/BSON replay and parser/view checks in capped run `compiler-1793264871810743273`. The separate five-zone proof passed all 1,362 cases per zone in `compiler-1793263458419267176` before that run later failed Clippy; final UTC proof and all four source-oracle `--check` runs passed. Only the parser test's late-init style differed in the final replay source; 31 of 32 production source inputs remained unchanged. See the [combined migration note](posthog-receipt-2026-10-29.md) and evidence archive for details. No benchmark result applies to this parser. Existing worker `values.rs` continues using its old parser and rejecting lone surrogates; the new parser is not adopted. Adoption is separate from dependency completeness, and broader ledger, billing, Polar and PostHog adapters remain open.

**Author-time compilation/runtime were unverified; parent baseline validation is recorded above.** This bounded author-only task ran no Cargo, rustfmt, Node, oracle, application/test/benchmark code, Docker, container, network, production or persistence operations. Only static source/package inspection, file authoring, hashes and Git whitespace/status checks were authorized. No commit, push, deployment, source retirement or cache maintenance occurred. Baseline HEAD: `9ed21b6512ae40951d5463dcf0a2cf7d0ff9a1c7`.

## Authored scope and exact limits

Owned additions only:

- `dimabot/src/utils/lossless_json_view.rs`: reusable borrowed document/view, flat spans, strict whole-input validation and iterative array coercion.
- `dimabot/tests/lossless_json_view.rs`: focused shared-view regressions; actual-source replay also runs through the parser replay below.
- `dimabot/src/utils/ai_usage_receipt_parser.rs`: structured lossless parser and concrete `mongodb::bson::Document` normalization adapter.
- `dimabot/tests/ai_usage_receipt_parser.rs`: ordinary focused regressions plus ignored mandatory full source/parser/BSON/provenance replay.
- `dimabot/tests/fixtures/ai_usage_receipt_parser_reference.cjs`: actual-source oracle with five fresh timezone processes, actual installed schema casting and BSON serialization/deserialization.
- This handoff.

The only edit to an existing shared implementation is **three visibility changes** in `tts/settings.rs`: `truthy`, `js_string` and `js_number` are now `pub(crate)`. Their signatures, bodies and error policy are unchanged.

At author time this implementation awaited parent integration and execution; the initial baseline validation is now recorded above. It is **not a claim of complete ledger migration or arbitrary-depth V8 parity**. The original four-file author could not address the shared depth gap. This follow-up authored a separate borrowed path and adapted only parser access/coercion and comparison projection. `lossless_json.rs` and its service guard remain byte-for-byte unchanged. The mandatory `deep-unknown:129`, `deep-unknown:256`, `deep-coercion:129` and `deep-coercion:256` remain in full replay, with deeper ignored array/object cases at 4096 and malformed deep cases added. The source resource probe does not establish native JS/V8 resource parity.

The parser, shared view and BSON adapter are fully authored beyond parent wiring/verification. There is no repository trait, mock storage implementation or placeholder Date/classification algorithm. No existing deployed consumer was changed. Existing dirty root guidance, routing notes, PostHog work and unrelated screenshot files were left alone. Cargo manifests, module wiring, locks, profiles and accepted evidence were not edited.

## Borrowed reader source trace and API

The locally installed, lock-pinned `serde_json` **1.0.154** was inspected statically at `src/de.rs` and `src/read.rs` in the Cargo registry. `deserialize_raw_value` calls `ignore_value`, which maintains enclosing frames in a heap `scratch` vector and uses loops rather than recursive descent. It does **not** call the `remaining_depth` guard used by the ordinary value deserializer. `ignore_integer`/`ignore_decimal`/`ignore_exponent` check JSON number syntax without converting to finite f64; `ignore_str`/`ignore_escape` reject control characters and bad escapes while permitting JSON-valid unpaired `\uXXXX` units. `serde_json::from_str::<&RawValue>` checks the end of the entire input as well. No dependency or parser feature change is needed: `raw_value` is already enabled. This is source inspection, not an executed depth guarantee; parent must validate these properties in the pinned build.

`JsonDocument::parse(&str)` borrows the validated trimmed span and builds a flat `Vec<Span>` in a second linear indexing pass. Each container records its subtree's end and next sibling index; unknown descendants are never decoded, materialized as owned containers, cloned or stringified. Destruction drops only flat vectors. Memory is O(token count + depth), not constant; allocation failure and available memory remain resource limits. Object lookup scans direct keys (decoded by the existing scalar reader), skips descendants by index, and returns the last matching decoded UTF-16 name. Repeated receipt lookups have a fixed field count; neither indexing nor joining reparses each nested subtree. No object-enumeration/writer framework is introduced.

The small public API is `JsonDocument::{parse,root}`, copyable `JsonView::{raw,scalar,as_string,as_bool,is_null,get,get_key,array,truthy,js_string}`, `ArrayIter`, and `lossless_json_view::js_number(Option<JsonView>)`. Only `scalar` can produce owned `JsonValue`; it refuses containers. `get`/`get_key` represent missing with `None` and present null with a view. This is a plain **own-property** API, not arbitrary boxed primitive/prototype property access; all parser field names are non-index names absent from JSON scalar prototypes.

Scalar decoding reuses `lossless_json::parse_json`, preserving its `JsString` decoder and Rust binary64 policy. Truthiness delegates to settings (container placeholders remain truthy before conversion). String/Number use the existing settings helpers for actual scalar values and shallow ordinary object projections; an own `toString` becomes a non-callable null marker, without inspecting its potentially deep value. Array String uses a heap stack of iterators and one UTF-16 output buffer. It appends each array's separators directly, skips null element text and preserves nested empty arrays. Array Number feeds the resulting `JsString` back into settings `js_number`, retaining existing whitespace/radix/rounding/nonfinite/error behavior. It does not copy number formatting, whitespace rules, Date parsing or classification algorithms.

No recursive owned array is passed to the settings helpers, DTO writers or BSON adapter. DTO output remains scalar-only (18 normalized fields, 20 BSON projection fields). Category/enums/nullable strings inspect only actual string leaves, never coerced arrays/objects. Array input can be truthy even when its String result is empty. Missing Number input still follows undefined/NaN; null follows zero.

The source oracle separately records a **16,384-level** Array String/Number resource probe: direct V8 error names/messages and actual source parser acceptance. Native replay validates JSON acceptance and requires the pinned recorded resource errors to be `RangeError`, without asserting native String/Number equivalence at that depth. This is an unexecuted probe, **not a measured first-failing depth**, and no arbitrary-depth JS coercion parity is claimed. Parent execution must report its actual result; a changed resource observation fails replay and needs review. Ordinary coercion TypeErrors and all 129/256 ordinary cases retain strict full comparison.

## Reuse/source trace

`ai_usage_ledger.ts::parseQueuedAiUsageReceipt` does `JSON.parse`, `String(parsed.occurredAt || '')`, `new Date`, finite credits conversion and truthiness checks on the three identity inputs. The returned literal has **18 fields** in source order. `receiptDocument` maps that normalized receipt to **20 fields**, including `entryId` instead of `id`, Date values and retention fields. `persistAiUsageReceipt` wraps that document in a real Mongoose `$setOnInsert` upsert, dirties dashboards and rebuilds aggregates under `withAiUsageLock`. Those persistence effects remain out of scope.

The current producer is already lossless: `ai_usage_producer::QueuedAiUsageReceipt` emits valid JSON with escaped lone UTF-16 units and source order. It represents producer inputs (including optional/missing fields), so it is not reused as a normalized parser DTO. The new `ParsedAiUsageReceipt` has private typed fields and named identity/date/amount accessors, `get`, `ordered_fields`, `as_value`, exact JSON wire, and an ordinary `try_utf8_fields` convenience path. That path refuses ill-formed UTF-16 instead of replacing it; its vector preserves order and raw finite binary64 values including signed zero. It creates no connections and samples no clock.

The deployed `ai_usage_receipts/values.rs::parse_receipt` still deserializes into `serde_json::Value`, rejecting source-valid escaped lone surrogates before parsing fields. It also uses its own date/text/classification/document conversion. It is private to its existing worker and is not a safe reusable pure lossless parser. The new opt-in parser does **not** establish that the deployed worker handles those producer messages. Existing `mongo,redis` worker graphs remain untouched. Prior accepted producer evidence: [ai-credit-receipt-2026-10-29.md](ai-credit-receipt-2026-10-29.md).

| Source/dependency/type | Native mapping and boundary |
| --- | --- |
| `QueuedAiUsageReceipt extends AiUsageTransaction` | `ParsedAiUsageReceipt`; explicit nullable values after parsing; no schema/repository abstraction |
| `channelID`, `customerId`, `id` | Truthiness before shared fallible `String()` conversion; `JsString` retains UTF-16, including empty strings produced from truthy arrays |
| `nullableString` | Existing `JsString::trim()` then `slice(0,128)` in UTF-16 units; nullable metadata and operation/provider fallback strings |
| `finiteNumber` | Existing `tts::settings::js_number` calls shared `json_number::string_number`; missing→NaN→null/rejection, null→0, arrays/objects and non-callable own `toString` retain source behavior |
| Binary64 boundaries | Lossless `JsonValue::Number(f64)`; parser finite filtering, signed-zero bits, JSON.stringify zero/nonfinite boundary and shared `bson_compat::js_number` |
| `new Date(String(...))` | Existing `js_date::{parse_date,parse_date_utf16}` (V8 grammar, NUL, legacy/ISO/local-time handling), then `credit_policy::JsDate` TimeClip and full UTC ISO |
| `classifyAdjustment` | Existing `ai_usage::classify_adjustment`; source/operation coercion adapted **before** trimming; explicit valid adjustment short-circuit preserved; strict reason comparison; negative credits override entry kind |
| Classification projection | Non-Unicode strings cannot match any ASCII policy token; project an empty comparison-only token, without applying UTF-8 replacement to stored receipt metadata |
| Category | Exact source eight-category allowlist including `uncategorized`; other inputs normalize to that fallback |
| Entry/unit/resource enums | Existing `EntryKind`, `UsageUnit`, `ResourceType`; unknown unit/resource→null; `itemized` requires strict boolean true |
| Retention | Explicit `RetentionTier::{Free,Premium,Pro}` with source 30/60/90-day expiry; strict `from_value`; avoids Redis dependency from the producer module solely for a three-value mapping |
| `receiptDocument` + schema fields | `to_bson_document`: exact 20-field order; nullable values, BSON dates, source number representation, explicit positive-TimeClip expiry failure |
| `String`→BSON UTF-8 | `JsString::to_utf8_lossy()` only in the concrete BSON adapter, never at parsing/trim/ID conversion |

The source parser performs no rounding of credits or quantities. Reusing the existing numeric coercion and BSON encoder preserves that behavior; adding `Math.round` would be incorrect.

The completed minimal coercion visibility edit is only:

```rust
// dimabot/src/utils/tts/settings.rs; retain bodies/signatures/error policy
pub(crate) fn truthy(value: &JsonValue) -> bool;
pub(crate) fn js_string(value: &JsonValue) -> Result<JsString, SettingsError>;
pub(crate) fn js_number(value: Option<&JsonValue>) -> Result<f64, SettingsError>;
```

The new view imports these helpers; the parser imports the view. `json_number::{number_string,string_number}` are reused transitively. No new Unicode representation, Date parser or adjustment decision tree is introduced.

## Concrete BSON normalization and source proof

Static installed-package source inspected:

- `mongoose` **8.24.2**, `lib/query.js::_castUpdate` → `lib/helpers/query/castUpdate.js` and schema field casts.
- `lib/cast/number.js` preserves existing finite Number values, including negative zero. Required/enum validators are not automatically run by the source `updateOne` call; the oracle uses update casting, not document `validate()`/`save()`.
- `lib/cast/date.js` rejects an invalid Date object. An accepted occurredAt at the positive TimeClip edge can produce an invalid retention expiry. The Rust adapter returns `InvalidReceiptExpiry`; it must not invent a BSON date outside the source Date range.
- Node `bson` **6.10.4**, `src/parser/serializer.ts::serializeString` calls `ByteUtils.encodeUTF8Into`; `src/utils/node_byte_utils.ts` falls through to `Buffer.write(...,'utf8')`. The serializer selects Int32 for integral in-range Numbers except negative zero; other finite Numbers stay Double. Existing `bson_compat::js_number` supplies that exact policy.

The oracle loads the entire actual receipt schema module against an isolated installed Mongoose instance, with auto-create/index/buffering disabled; it does not import application database initialization. The schema's field definition, timestamps declaration and indexes remain real source. It calls the real query `_castUpdate` on the real source `receiptDocument` projection, then the driver's installed BSON serializer and deserializer with promotion disabled. It records exact pre-BSON field types/UTF-16 units/binary64 bits, encoded BSON bytes, decoded BSON types and UTF-8 bytes. Native replay compares both raw normalization and BSON projection, down to bytes and field order.

`Model.updateOne` ordinarily decorates its update with `__v`; timestamps/defaults/IDs belong to broader persistence behavior. The oracle creates a disconnected real query, then supplies the source-only `$setOnInsert` projection **directly** to `_castUpdate`, rather than serializing `query.getUpdate()` or deleting fields from cast results. The Rust adapter intentionally covers receiptDocument's fields, not a complete insert/update wire command. Do not claim full Mongoose middleware, persistence or database parity from this projection.

Node BSON cannot preserve a lone UTF-16 code unit in UTF-8. Replacement occurs at the explicit BSON boundary. It can make two distinct lossless IDs collide after storage encoding (for example a lone unit and U+FFFD). This is exposed in the adapter documentation and ordinary regression, and the DTO remains unchanged. Future queue/lock/dedup/lookup adoption must decide protocol boundaries consistently; do not silently pre-replace IDs in Redis or pretend BSON can round-trip the original units.

The final UTC source/BSON replay passed in the parent baseline run; the complete five-zone proof and its limitations are summarized above and in the combined migration note. This confirms the recorded fixtures and implementation for those cases, not the full persistence/ledger adapter.

## Parent-only feature/module integration proposal

Use a separate opt-in feature composed entirely from existing dependencies:

```toml
lossless-json-view = ["tts-utilities"]
ai-usage-receipt-parser = ["ai-usage", "credit-policy", "lossless-json-view", "js-date", "mongo"]
```

Add these module gates in `src/utils/mod.rs`:

```rust
#[cfg(feature = "lossless-json-view")]
pub mod lossless_json_view;

#[cfg(feature = "ai-usage-receipt-parser")]
pub mod ai_usage_receipt_parser;
```

Existing feature gates already expose `js_compat`, `json_number`, `js_string`, `lossless_json`, `tts::settings`, `credit_policy`, `js_date` and `bson_compat` through these dependencies. The concrete adapter needs the existing optional MongoDB crate solely for BSON; it does not call a Mongo client. No new package, lock update, Redis requirement, default feature, worker profile, binary, registry or live configuration is required. Keep both features out of default and deployed worker graphs. Both integration tests are file-gated and do not require new explicit Cargo test entries. The view can be tested alone without Mongo/Redis; its reuse of settings intentionally requires the existing `tts-utilities` dependency graph.

## Oracle and replay contract

Strict executable pins: Node **24.22.1**, V8 **13.6.233.17-node.58**, TypeScript **5.9.3**. Installed Mongoose/BSON versions and lock entries are checked. Metadata binds the source/package/lock/native reader files; exact extracted declarations and signature/export/private-helper AST evidence; every loaded installed dependency module; package entries/manifests; the Node executable; and ICU/tzdata identifiers. Rust replay rehashes actual files (including dependency implementations), rather than merely checking that digest strings look valid.

The reader extracts the actual parser, builder, private normalizers, retention helpers, classifier and type declarations. It loads the actual event/classifier modules. It never substitutes an expected parser or a hand-written BSON transform. Unused application imports are poison proxies. Network/Mongoose connection methods are fail-fast guarded before evaluation, and a violation list is asserted empty so the source catch block cannot mask an attempted side effect.

The corpus exceeds 250 cases by construction (exact count is emitted only on execution): null/missing/malformed/unknown fields; every category/unit/resource and itemized value; full source/operation/classification precedence and explicit adjustment matrix; raw numeric overflow/underflow/signed zero/Int32/2^53/radix rounding boundaries; object/array coercion and own non-callable `toString`; all JS trim spaces plus non-trim lookalikes; truncation adjacent to astral/lone units; duplicate/integer/`__proto__` keys; malformed and valid legacy/ISO/NUL/timeclip dates; and actual producer-generated event and lossless receipts. All original case recipes remain. Deep guards now exercise the separate borrowed reader rather than changing the owned service reader.

Fixture **format 2** adds shared-view records derived directly from `JSON.parse`, `Boolean`, `String` and `Number`, including error names/messages, binary64 bits, UTF-16 values/names, missing/null, duplicates, joins, strict malformed deep syntax and whole-input rejection. These observations contain only shallow scalar summaries, never recursively serialized parsed input. The same five subprocesses generate them. Native replay iterates **every** view and receipt record, rejects missing/empty/partial collections, checks mandatory deep IDs/source acceptance, and compares all original BSON/normalization data. Provenance now requires all **32** source/helper/manifest/lock/test hashes, including the new view and its tests, along with the original installed dependency and AST bindings. The V8 resource probe is a separate explicitly labeled observation, not a silently skipped receipt fixture.

Five **fresh Node processes** cover `UTC`, `America/New_York`, `Europe/Berlin`, `Australia/Lord_Howe` and `Pacific/Apia`. The reader never mutates its process-global TZ. `--write DIR` requires an existing parent-owned directory and uses `wx`; `--check DIR` regenerates everything and compares every output byte including provenance. Neither mode opens a connection. Both are parent execution only.

The ignored Rust replay requires a nonempty complete fixture, validates provenance, and replays every record in the selected timezone, including raw normalization and all three retention-tier BSON projections. It checks source wire, string units, amount bits, ordered fields, exact BSON bytes and decoded types/UTF-8. With `ai-usage-producer` also enabled, it additionally rebuilds every producer recipe through the current native producer and checks its wire. Run the ignored test in **five fresh native processes**; never change TZ inside a test. Node uses bundled ICU data; the native local-time helper uses libc/zoneinfo. Matching timezone data remains a parent runtime requirement.

## Parent verification commands (NOT RUN)

Perform parent review and module/feature integration first. The bounded borrowed-reader extension is authored here but unexecuted. Format/fix source before freezing the hash-bound fixture. The commands below are **container interiors only**, using a read-only final source snapshot and pinned installed dependencies, writable task-owned output/target directories, 6 CPU / 4 GiB memory=swap (no swap) / 256 PID / two Cargo jobs / 8 GiB private-cache cap and existing host reserve checks. Never run them on this host directly. The pure parser and oracle need no MongoDB/Redis server or credential. Broader future persistence tests need disposable services, not live ones.

```sh
# Node interior; /fixture-out is a fresh parent-created writable directory.
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --write /fixture-out
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check /fixture-out

# Rust interior, from the snapshot's dimabot root; set TZ before startup.
export CARGO_BUILD_JOBS=2
export TZ=UTC
cargo fmt --all -- --check
cargo check --locked --no-default-features --features lossless-json-view --all-targets
cargo test --locked --no-default-features --features lossless-json-view --test lossless_json_view
cargo check --locked --no-default-features --features ai-usage-receipt-parser --all-targets
cargo clippy --locked --no-default-features --features ai-usage-receipt-parser --all-targets -- -D warnings
cargo test --locked --no-default-features --features ai-usage-receipt-parser --test ai_usage_receipt_parser

# Mandatory ignored replay; these paths are read-only mounts from the same
# pinned oracle snapshot and executable that produced the fixture.
export DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR=/fixture-out
export DIMA_AI_RECEIPT_NODE_ROOT=/pinned-node-snapshot/dimabot
export DIMA_AI_RECEIPT_NODE_BINARY=/pinned-node/bin/node
# Parent launches each independently with a fixed TZ from the five-zone list:
cargo test --locked --no-default-features --features ai-usage-receipt-parser,ai-usage-producer --test ai_usage_receipt_parser replay_actual_source_parser_and_bson -- --ignored --exact
```

Repeat the final command under each of the five TZ values in a fresh process (including UTC). Check both standalone parser and combined producer feature profiles. The final reader `--check` and native replay must bind the final source after visibility/module/format/depth changes. Include the relevant shared-reader/coercion regressions if the parent changes their implementation. Baseline worker tests should be scoped to concrete shared-code impacts; this proposal does not change or adopt any worker.

No parser benchmark was authored, and no parser performance claim is made. Parent-generated fixture evidence is in the task evidence archive. Missing/empty fixtures intentionally fail.

## Static source binding at author baseline

These SHA-256 values were read with the shell hash utility at the original author baseline, before the borrowed extension; they are **not** a successful oracle binding. The settings row below is therefore historical. After the three visibility changes its hash is `e49542fb02eadaedfd28099c829f6b0bd43302af72d725147e3112b188f34fa9`. A follow-up static hash read confirmed the protected lossless reader, producer, deployed values and credit projection still match the table. Parent integration/formatting will change further hashes; regenerate runtime provenance after final source freeze.

| File | SHA-256 |
| --- | --- |
| `src/utils/ai_usage_ledger.ts` | `3519b440d3d03a9415323f75f113f81627c6b07369ef43903a7b07116df5d4f5` |
| `src/utils/ai_usage_classification.ts` | `00fcd076d0f3460ecea46588904242252a32b9500e43217c67a1a07e1cbe4b36` |
| `src/schemas/ai_usage_receipt.schema.ts` | `87f132f55c47cf082f37dabadc0d42f790e8324d1925f6990a3794f46d845b92` |
| protected `src/utils/ai_usage_producer.rs` | `d46bf5dde697d8084c33a77dd9f860c7312f4d4b4428c109d6253fbd453e58e8` |
| protected `src/utils/ai_usage_receipts/values.rs` | `f58895dc46dc1f51f416b96dd0e853f4a53412622cd1d674a2dabf3b0d6f29d0` |
| protected `src/utils/ai_credit_projection.rs` | `0a48df01b89d153d6205e74d9d339b859cc2abe76e9a7dbb9f72fb97f46efb98` |
| `src/utils/tts/settings.rs` | `58fae32f1ae93f50a53414bba73fa1acec187e985c04b1cf506b3d6cfb15b41f` |
| `src/utils/lossless_json.rs` | `33ba6503aead76bec9d9be9f48f208da99aac81154c0f1fda8a49c265e6e4010` |
| `package.json` | `cc4939f6416a91d4bfaa5bcdd3d448d2f74103a88bb269e0a8e393615cf32cef` |
| `package-lock.json` | `abdf5aa71a8272423ebb9358d7aaa87edd7e65f6605c325fe231a4bcef70eeb7` |

## Outstanding migration/adoption work

The parser and borrowed reader passed the initial capped checks/replays documented above. Arbitrary-depth V8 resource parity remains outside the claim. This is not migration of the whole ledger module. Remaining dependencies include consistent lossless/UTF-8 ID and dedup boundaries, actual ledger Mongo upserts/timestamps/index/TTL behavior, locking/leases, dashboard/daily/state rebuilds, expiry policy at runtime, Polar and PostHog paths and recovery/retry semantics. Existing worker adoption and broader caller adoption remain separate and have not happened; no deployment occurred. Keep all TypeScript source and current accepted worker evidence intact.
