# AI usage classification handoff — 2026-10-29

## Source boundary

The TypeScript source is `dimabot/src/utils/ai_usage_classification.ts` (SHA-256 `00fcd076d0f3460ecea46588904242252a32b9500e43217c67a1a07e1cbe4b36`). Its complete exports are the ten-value `ADJUSTMENT_TYPES` tuple and `classifyAdjustment(input)`. The module has no imports, initialization, or I/O.

Rust adds `ai_usage::classify_adjustment_json(&JsonValue) -> Result<Option<&'static str>, SettingsError>`, available under the existing `ai-usage` and `tts-utilities` feature combination. The legacy `classify_adjustment(&serde_json::Value)` signature and behavior remain for existing callers. Both use the same classification policy, but the legacy serde boundary does not claim full source-equivalent JavaScript coercion/error behavior. The new function is the lossless ordinary-JSON-data mapping.

## Contract and limits

The TypeScript function accepts ordinary JSON-data objects with unknown fields. The Rust API preserves source branch order, early exits, coercion order, JavaScript truthiness and string conversion, UTF-16 strings (including ill-formed sequences), duplicate-key last-value behavior, and errors from non-callable own `toString` fields. A null top-level value produces the generic native `SettingsError`; its message is not claimed to match JavaScript's exact TypeError message. Accessors, functions, custom prototypes, and other executable hooks or invalid JavaScript runtime values are outside the declared data-object boundary.

The API shares existing native utilities: `JsonValue` and `JsString` from lossless JSON/string support, `settings::{truthy, js_string}` and `SettingsError` from TTS settings, plus the existing AI usage type list and classification policy. The existing Cargo feature closure is `ai-usage` plus `tts-utilities`; no crate dependency or Cargo feature was added for this function. `JsonValue` in turn uses the existing lossless string and number formatting utilities. This is a pure classifier: it adds no persistence, receipt production, billing, reporting, or network behavior.

## Verification evidence

The pinned oracle extracts and typechecks the actual complete TypeScript export AST, then executes those exports to derive expected values and errors. Its 100-case corpus covers all explicit types, branch collisions, coercion errors, early exits, nested arrays, duplicate keys, numeric extremes, and ill-formed UTF-16; native unit coverage separately includes NaN and infinities that JSON cannot encode. An independent provenance readback confirms the frozen source, native, toolchain, and oracle hashes. The Rust replay uses the frozen corpus and does not start Node.

Recorded verification for this source snapshot:

- Compiler receipt `1793299987183286077`: formatting, scoped Clippy, and two ordinary plus three existing AI usage library tests passed.
- Node oracle receipt `1793299987184873431`: actual TypeScript oracle generation and check passed for all 100 cases.
- Compiler receipt `1793300124243405961`: ignored native replay passed all 100 cases.
- Node consumer-oracle receipt `1793300276390314123`: producer (338 cases), tier (20), query (3,325 assertions), parser (1,362 cases in each of five time zones), persistence (204), backfill (341), and lock (291) checks passed.
- Final compiler receipt `1793300437308104735`: success in 557.794 seconds of script time (567.155 seconds total), with a 3,584,106,496-byte build cache and 8,608,210,944 bytes minimum available. It passed the 38 consumer ordinary tests (backfill 6, persistence 11, queries 8, producer 4, parser 9), the feature-isolation checks, Mongo/Redis worker-profile all-target check, all-feature all-target check and strict Clippy. Source-specific consumer fixtures covered producer 338, parser 1,362 per time zone, queries 333, persistence 204, and backfill 341 cases.

All reported compiler work used the 6 CPU / 4 GiB memory / 256 PID / two Cargo job cap. The one additional read-only `node_modules` mount was used only by the exact compiler script for byte-hash provenance; the Node binary was hashed but not executed by the compiler. No services were used in these replays. The read-only production comparison found the documented 19 production records unchanged, including `ack api-ee0635765a02`.

Evidence is currently in `/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/ai-classification/attempt1`; the parent task will package it. The classification checks establish semantic parity at this API boundary, not application performance. No classifier benchmark was run. Earlier receipt-helper timings belong to source `22cb791f` and are not evidence about this classifier or the whole application.

## Adoption and migration status

No TypeScript source or caller was retired, no caller adoption was performed, and nothing was deployed or pushed. The unchanged legacy serde API remains used by existing Rust receipt paths; the TypeScript ledger, producer, query, and receipt code still uses the TypeScript function. This completes the isolated classifier implementation and its verified ordinary-JSON-data boundary only. It does not complete the broader `ai_usage_event` feature, billing, ledgers, their application adapters, or total migration.
