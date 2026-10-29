# Channel TTS settings: native local slice — 2026-10-29

## Scope and status

The archived TypeScript module `src/schemas/channel_tts_settings.schema.ts` now has a concrete, opt-in Rust counterpart in `dimabot/src/schemas/channel_tts_settings.schema.rs`, with pure defaults and normalization in `dimabot/src/utils/tts/settings.rs`. The shared lossless JSON representation moved from `server/services/tts/lossless_json.rs` to `utils/lossless_json.rs`; the former location remains a compatibility re-export. The feature is `channel-tts-settings`, which enables `application-schemas` and `tts-utilities`. It adds no dependency or lockfile change and does not change a default or deployed profile. It is not registered among the 42 model definitions.

This closes the local behavior slice for this source module, including its schema definition, concrete caller-supplied MongoDB repository, read and upsert operations, Fish voice targeted update, defaults, and normalizer. It does not migrate the TypeScript callers or complete the TTS application dependency graph. Local feature evidence, total dependency completeness, and caller adoption/deployment remain separate states; no whole-project completion percentage follows from this work.

## Source behavior and reuse

The source defines the `channel_tts_settings` model and unique `channelID` index, timestamp fields, provider/language enums, nested voice/filter/queue defaults, normalizer, read, find/set/save upsert, targeted Fish voice update, and model accessor. The Rust version reuses the existing expressive-tag ordering and selector, Kokoro resolver/default, Piper defaults, JavaScript-number conversion, UTF-16 `JsString`, schema repository/casting and user schema. `get_channel_tts_settings_model` accepts a caller-owned `Database`; constructing it has no connection, environment, index-installation, or startup side effect.

Important source semantics retained include:

- Saved settings take precedence over `users.accounts.$elemMatch` with the exact Twitch account marker. Only a missing saved record consults `tts_default_provider`; only `kokoro` selects Kokoro, with Piper as the fallback. A read returns normalized defaults without inserting them.
- Normalization preserves non-nullish `enabled` and filter flag values for later schema casting, applies JavaScript truthiness/String/Number behavior for ordinary JSON inputs, clamps/truncates numeric settings, resolves Kokoro voices, and normalizes the ordered expressive-tag catalog (75 entries). UTF-16 strings remain lossless in the pure JSON path.
- The existing-record write follows source `findOne` → document `set` → `save` behavior, including save validation and a non-atomic duplicate-key race. `filters` is always dirty because the source nested setter marks it modified, so an otherwise identical upsert still writes it and advances `updatedAt`. Unchanged other values are not overwritten. Unknown top-level stored fields survive.
- `set_channel_fish_voice` uses one targeted Mongo update for `provider`, `voices.cloneDefault`, and `updatedAt`, with defaults-on-insert flattened into `$setOnInsert`; unrelated fields, including concurrent edits, are left untouched. It retains updateOne's lack of save validators, including acceptance of an empty ID.

## Compatibility boundaries

This is ordinary JSON-data parity, not general JavaScript object or full Mongoose/ODM parity. The source shape is typed `Partial<ChannelTtsSettingsData>`; Rust preserves behavior for JSON data rather than accessors, functions, custom prototypes, or executable coercion hooks. An own non-callable `toString` causes the source-compatible `TypeError`. The BSON adapter accepts plain consumed values and promoted int64 values within inclusive ±2^53, with an explicit nesting limit of 128. Consumed dates, ObjectIds, binary values, unpromoted Long values, and other non-plain BSON values return a boundary error rather than being coerced as JavaScript objects. Unknown nested BSON fields are projected away before normalization. At the persistence boundary, lone UTF-16 surrogates become U+FFFD as in Node BSON string encoding; the pure JSON representation remains lossless.

The generic repository still stamps supplied saves without full Mongoose dirty-path tracking; this adapter provides the source-specific plan. Other models require their own reconciliation before retirement. No general ODM parity is claimed. The code deliberately uses the existing schema repository for supported casting/validation and explicitly implements the source-specific dirty-field and Fish update behavior that the generic repository path does not supply.

## Callers and remaining application work

Current TypeScript consumers remain in place, including `server/routes/speech.route.ts`, `server/services/tts/voice_preview.service.ts`, `utils/tts/queue_default_tts.util.ts`, `handlers/tts_queue.handler.ts`, `handlers/dimafx_queue.handler.ts`, `pets/admission.ts`, `overlays/test-playback.ts`, and AST channel functions. They still import or type against the retired TypeScript schema module; they have not adopted the native API. The source model's import-time Mongoose registration and application initialization are not reproduced by the opt-in native module.

Provider factory/configuration, HTTP routes, voice preview and synthesis orchestration, queues, Piper/Kokoro service integration, Fish catalog use, billing/usage behavior, and emote-cache/application effects still require application-level ports and native adapters. A concrete schema repository is present for this slice, but the surrounding TTS callers are not adopted. No deployment or caller cutover was performed or authorized by this evidence.

## Verification and evidence

The verified code and exact source retirement are committed locally as `e4308e57`. Schema replay compares document values and error paths/categories; diagnostic text is represented by typed native errors.

Final post-archive checks passed on source tree SHA-256 `0b8de5bf5986e9a546449eb466f54777bfcc7249fa4ebadb09f722a046f5e3c7`: 114 ordinary Rust test executions, four explicit source-backed fixture executions, and one separate release benchmark invocation. Formatting, standalone/all-feature checks, Clippy with warnings denied, and no-default-feature check passed. The Node oracle passed 308 pure cases, 11 Mongoose schema cases, and isolated Mongo write replay. The exact runs, resource limits, source/archive checks, six workload measurements, and cleanup/production-integrity records are in the [evidence index](evidence/2026-10-29-channel-tts-settings/README.md). Benchmark results are synthetic local measurements; they do not establish production performance or model causality.

The exact archived source hash is `5e943f59906bdf4f63dbb52497ccc8607c6fb069cf8b9af0521a4652245c64c2`. The archive manifest and byte-for-byte archive check are part of the evidence pack. The source row in the [dependency matrix](dimabot-dependency-matrix-2026-10-28.md) now records this bounded source/dependency review; all other rows are unchanged.
