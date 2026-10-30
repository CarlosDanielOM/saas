# Timer and chat schema named types — 2026-10-30

**Status: accepted native schema/type mapping and verified TypeScript source retirement.** The named-type feature was first validated at commit `c9caf56d5f58db2f7bce78c74e73dfcb341bd562` (1,488 inputs: 1,478 Git plus 10 reused SDK inputs). A separate post-retirement validation is bound to commit `6ff13fe929c0915f6e424c2f081eb96e3795e0d7`, source-tree SHA-256 `06d19561a1f9a97ce0b4c7a8d442ce6ed841457f68dd0bec8a575941c41ac888`, and 1,491 inputs (1,481 Git plus 10 reused SDK inputs); all hashes match.

The accepted feature fills typed-value coverage for the existing timer and
chat-log model descriptors. The retirement epoch records the later archive
validation separately. Neither epoch claims MongoDB CRUD, benchmarks, caller
adoption, production deployment or whole-migration completion.

## Source contracts and native types

| TypeScript schema | TypeScript exports | Native type and existing model path |
|---|---|---|
| `src/schemas/command_timer.schema.ts` | `ICommandTimer`, `CommandTimerSchema` | `ICommandTimer`, `CommandTimerDate`; existing `command_timer::schema()` / `CommandTimer` |
| `src/schemas/countdown_timer.schema.ts` | `ICountdownTimer`, `CountdownTimerSchema` | `ICountdownTimer`; existing `countdown_timer::schema()` / `CountdownTimer` |
| `src/schemas/countdown_timer_config.schema.ts` | `ICountdownTimerConfig`, `CountdownTimerConfigSchema` | `ICountdownTimerConfig`; existing `countdown_timer_config::schema()` / `CountdownTimerConfig` |
| `src/schemas/custom_timer.schema.ts` | `ICustomTimer`, `CustomTimerSchema` | `ICustomTimer`, `FrequencyUnit`; existing `custom_timer::schema()` / `CustomTimer` |
| `src/schemas/chat_logs.schema.ts` | `IChatLog`, `ChatLogSchema` | `IChatLog`; existing `chat_logs::schema()` / `ChatLog` |

The pinned named-type oracle covers ten exports and 42 interface members. Each
source module imports Mongoose only. The Rust implementation uses the existing
`application-schemas`/`js-strings` capability, native BSON, and shared
`SchemaDefinition` repository behavior; no new crate dependency or
application-specific adapter was required. Existing raw BSON `Document`
aliases and collection/repository paths remain available for callers handling
partially populated records.

`ICustomTimer` uses the existing literal `FREQUENCY_UNITS = ["minutes"]`
catalog. The `FrequencyUnit` type projects its current value without changing
the descriptor's behavior. Timer types use native `DateTime`, `ObjectId`, and
binary64 values where declared. Custom-timer validation remains in the existing
descriptor, including trimming, limits and its integer check.

## BSON and stored-document boundaries

Declared strings use the shared `JsString`, preserving arbitrary UTF-16 units,
including lone surrogates, in the native value layer. Explicit BSON conversion
replaces unpaired units at the UTF-8 BSON boundary, matching the pinned Node
BSON SDK. The oracle covers six string and five numeric BSON cases, including
special numeric values.

Required source fields remain required in the typed values even when normal
Mongoose-created records can omit them. In particular, `resumedAt` and
`pausedAt` stay required on `ICountdownTimer`; callers dealing with partial
stored forms use the raw `Document` model path. Optional fields accept absence
and reject explicit null. Stored partial shapes are distinct from the declared
TypeScript contracts rather than weakening them. The command timer's local
calendar defaults remain on the existing descriptor.

## Verification of the accepted feature

Node run `1793363982448192537` passed in 5.266 seconds total (4.002 seconds of
check work). It checked the actual source exports and member signatures,
versions, BSON string/number boundaries and the existing additional-schema
oracle: 31 models and 194 Mongoose cases. The output's oracle fixture SHA-256
is `d8850aa4974635a3ffb5ba13dcee7269b094de4a44006c08b81972f33f0172a6`.

Capped compiler run `1793364010422445658` passed in 131.279 seconds total
(121.379 seconds of compiler work), with six CPUs, 4 GiB memory/no swap, two
Cargo jobs and a 256 PID cap. Minimum available memory was 9,187,057,664 bytes;
the private cache peak was 8,248,705,024 bytes. It passed two ordinary
named-type tests, two ordinary additional-schema tests, the ignored exact
source replay, formatting, scoped Clippy, minimal profile, Mongo+Redis profile
and all-feature strict checks. Format run `1793363948570042801` passed. Final
readback found 18 production records unchanged and zero task-owned resources.

This source-only schema/type validation did not run Mongo CRUD. The one
additional-schema integration test requiring a disposable MongoDB fixture
remained ignored. No benchmark or speed claim is made.

The frozen snapshot excluded the separate unverified JSON-core drafts
`dimabot/src/utils/lossless_json_document.rs`,
`dimabot/tests/lossless_json_document.rs`, and
`dimabot/tests/fixtures/lossless_json_document_reference.cjs`. It restored
`dimabot/src/utils/lossless_json_view.rs` only inside the frozen input to
preserve concurrent author edits; that file is not an accepted change of this
feature.

The full indexed source bindings, fixture, receipts/logs and reproduction
scripts are in the [evidence package](evidence/2026-10-30-timer-chat-schema-types/README.md).

## Verified TypeScript source retirement

The five TypeScript schema modules were removed from the application source tree and archived byte-for-byte under `archives/dimabot-typescript/2026-10-28/src/schemas/`. The source binding and archive proof are in the retirement epoch of the [indexed evidence package](evidence/2026-10-30-timer-chat-schema-types/README.md). The source commit is `6ff13fe929c0915f6e424c2f081eb96e3795e0d7`, tree SHA-256 is `06d19561a1f9a97ce0b4c7a8d442ce6ed841457f68dd0bec8a575941c41ac888`, and all 1,491 inputs (1,481 Git plus 10 reused SDK inputs) match.

The archive count advanced from 40 to 45. All 45 archive hashes match; the previous 40 entries and archive metadata are unchanged. Each of the five archived files matches the source hash in the accepted named-type snapshot. Five semantic comparisons matched, including the timer/chat type oracle and the embedded Mongoose regression corpora. The moderation action-log comparison records only provenance changes in `Cargo.toml`, the source resolver, and its guard; its behavior fixture matched.

Final Node run `1793366711705641175` passed; format run `1793366593205430608` passed. Final capped compiler run `1793367075031965693` passed in 19.977 seconds total (9.560 seconds of compiler-step time), with minimum available memory of 14,263,578,624 bytes and a private cache peak of 8,479,768,576 bytes. The prior compiler attempt `1793366759535595789` was interrupted and emitted no driver receipt; its raw log and interrupted-state record are retained as incomplete evidence and are not counted as a pass. Final production readback found 18 production records unchanged and zero task-owned resources.

No new benchmark or MongoDB runtime/CRUD check was performed for this retirement. The existing native model/type dependencies were already accepted in the named-type feature. The archive and matrix update do not establish TypeScript caller adoption, production deployment, or whole-migration completion. The central matrix now records 32 locally complete mappings and 25 partial rows among 806 baseline rows, with 45 archived snapshots and 761 live baseline TypeScript files (including six excluded React Email templates); total completion remains `null`.

The retirement evidence package keeps the named-type acceptance and this retirement as separate epochs. It includes the immutable source map, archive proof, semantic comparisons, final receipts/logs, and the interrupted attempt. Large files use lossless gzip and every payload is indexed by original path, raw/stored SHA-256, and byte length. It intentionally omits mutable `snapshot.json` state and does not duplicate Node or SDK binaries.
