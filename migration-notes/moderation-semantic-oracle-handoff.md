# Semantic actual-source oracle authoring handoff — 2026-10-30

Status: final accepted source and quality runs passed on code commit `1375d89066b3a135268584fb9f6ac5beadd22a3b`, tree `181f1e43ed91244e637428d10be65f34e709bef74f46486d5ef5a981cb72c282` (1,421 Git inputs plus ten reused SDK inputs). Node `node-1793342383176037556` checked fixture 4, SHA-256 `8980dda8ebd881b38fe85da52bf4ac92a5771f510bc768290099171e1260dfc8`; compiler `compiler-1793342466130881764` passed all-source replay and strict verification. The final replay visited 1,071 pure and 65 evaluator records, with three pure boundary records and ten explicitly labeled evaluator adaptations. The final compiler phase completed in 149.384 seconds total, minimum available memory was 8,993,722,368 bytes and peak cache was 7,639,011,328 bytes. All 18 production records were unchanged and no task-owned resources remained. Full run receipts, logs, four oracle attempts, source comparison, readback and reproduction tools are retained in the evidence package. Earlier failures remain labeled as failures; the earlier compiler phase that failed Clippy is not overwritten by later success. The frozen Spam paired benchmark does not include these semantic files.

## Reuse and ownership

The bounded files are `src/utils/moderation/semantic.rs`, `tests/fixtures/moderation_semantic_source.cjs`, `tests/fixtures/moderation_semantic_reference.cjs`, `tests/moderation_semantic_source.rs`, `tests/support/moderation_semantic.rs`, the focused ordinary/provider tests, and this note. Raw request/evaluate adapters, clock resampling behavior and request parsing are part of the current implementation. The focused functional test result above is retained with its failed overall compiler phase.

The loader reuses the unchanged existing Advanced and Spam actual-source loaders. Thus `paidModeration` and `SPAM_RULE_ID` execute their actual application sources; the complete actual `spam_categories.ts` produces category questions. No copied JavaScript policy, parsing or pricing algorithm generates expected outputs. The unchanged complete `semantic.ts` and OpenRouter attribution module are transpiled in memory using pinned TypeScript. Imports, mixed type/value bindings, exported declarations and both semantic type declarations are audited. Schema modules keep the real Date constructor; clock injection occurs only in the semantic function module. Mongoose remains disconnected.

The missing path was a whole-file semantic oracle and concrete native replay. The new reader emits source values and actual fetch-call observations. Pure exports and the async evaluator are crosschecked between normal CommonJS and VM execution before emission. Unique IDs are checked when records are added. Tagged values retain binary64 bits, UTF-16 units, undefined properties, sparse holes and Dates.

Rust helpers reuse `JsonValue`, `JsonValueRef`, `JsString` and `tests/support/sha256.rs`. The replay exercises the production `SemanticProvider` and reqwest through task-owned ephemeral loopback TCP endpoints. It compares the source URL, HTTP method/path, attribution/authorization/content-type headers and exact source JSON body bytes. It does not substitute callback business logic for the application adapter. No Mongo, Redis, remote service, real key or application boot is needed.

## Authored coverage

The exact runtime surface is three constants and seven functions: `SEMANTIC_USD_PER_MILLION_INPUT_TOKENS`, `SEMANTIC_PRICING_VERSION`, `FREE_MODERATION_MODEL`, `semanticPrice`, `moderationModelForAccount`, `fallbackResult`, `parseSemanticResponse`, `parseSpamResponse`, `semanticRequest`, and `evaluateSemanticDecision`. `SemanticResult` is the exported interface; `SemanticState` is a private type alias. The loader asserts the exact runtime names and type declarations.

The matrix includes pricing NaN/infinities/signed zero/subnormal/extreme inputs and adjacent binary64 values around round/ceil boundaries; free/paid/unknown plans and credit flags; arbitrary UTF-16 fallback status; score and threshold neighbors/defaults/invalid precedence; safe-integer token limits around 2^53, negative zero, invalid token/cost types; all 32 category subsets, duplicate categories, empty categories, safe veto/ties/low confidence; missing/null/array/malformed responses and answers; metadata defaults and 150/100/200 UTF-16 truncation including split pairs/lone surrogates.

Requests include all category subsets with invitation on/off, regular policy and examples, explicit/default/empty models, unknown fields, empty/absent/undefined/null context and matches, malformed construction inputs and sparse context evidence. Evaluator records include missing/empty keys, expired/invalid deadlines, invalid channel types, 429/non-OK/204, malformed wire JSON, transport throws, real AbortSignal validation, provider ID/model behavior, spam parsing, configuration thresholds, construction-before-preflight ordering and deadline/channel/key ordering. Forward/backward wall-clock changes, success after a synthetic logical deadline and TimeoutError identity are captured.

Native raw request APIs share the typed request core. `semantic_request_value` preserves absent fields versus explicit null for ordinary JSON; `semantic_request_ref` exposes `None` versus `Some(JsonValueRef::Null)`. Spam missing/null context fails at the map boundary. Unknown fields and lossless input values remain available to JSON serialization. `evaluate_value[_at|_with_clock]` and the existing typed evaluator share the same reqwest transport, response parser and policies. Raw deadline numbers are the explicit native replacement for Date.getTime().

`SemanticClock` samples wall time after request construction and again on catches. The initial remaining duration fixes monotonic I/O cancellation. Non-OK responses return their fallback directly; they do not become caught exceptions when the wall clock advances. Other transport/JSON failures compare the newly sampled wall clock to the deadline. Independent reqwest client/connect timeout errors do not acquire JavaScript TimeoutError identity. Outer Tokio timeout maps to TimeoutError regardless of wall-clock movement. A private HTTP test separately authors independent client-timeout checks with stable/backwards/forward clock values and real deadline cancellation after a backwards jump.

AbortSignal range handling uses the real Node implementation in the source fixture. NaN, infinities, negatives, fractional values and values above uint32 are separately captured as rejected range inputs. Normal valid signal arguments are captured too, and a real Node overflow signal is awaited to prove its TimeoutError behavior. The native implementation validates the same range and models Node timer overflow above INT32_MAX as a 1ms timer; a delayed private HTTP check exercises that native overflow path. Normal source deadlines use real Date objects, whose fractional milliseconds are clipped by Date before subtraction.

## Explicit boundaries and adaptations

All source records are visited. The replay prints exact boundary/adaptation entries, rather than counting them as unrestricted JavaScript parity:

- `SpamCategory` is exactly `spam|ads|self_promotion|profanity|insults`. Two unchecked unknown-category records retain source evidence and prove the native enum rejects the value. They are not valid-category native passes, and no category is fabricated.
- Owned ordinary JSON cannot represent undefined property identity, holes, Date identity, getters/proxies/prototypes, symbols, functions, BigInt or cycles. Undefined object properties are omitted on the native JSON boundary. Sparse map holes differ from explicit null: the sparse case removes the same tagged hole positions from source input/output and replays every defined element. A separate explicit-null context element exercises ordinary JSON semantics. Original hole evidence remains in the fixture.
- Raw evaluator deadlines are explicit getTime() milliseconds; missing/null deadlines preserve construction failure, and NaN represents Invalid Date. This is a host Date boundary, not a port of the Mongoose model.
- Native `RequestError` is compared to source construction TypeError semantics, while source engine-specific English diagnostics remain evidence. Status/model strings and outputs preserve UTF-16.
- Source injected fetch throws have no network bytes. Non-timeout throws are reproduced by an actual HTTP disconnect. Injected TimeoutError is reproduced by actual delayed HTTP and native deadline cancellation; its 2000ms budget is shortened to 50ms without changing the request wire. Clock advancement on transport/JSON failure uses the exact source clock sequence through `SemanticClock` and needs no elapsed-time approximation.
- The source synchronous mock can complete under a 1ms deadline without TCP scheduling. That success record uses a 2000ms native budget and compares the same wire bytes. Real expiry is exercised by delayed HTTP. The exact source 1ms signal argument remains evidence.
- A synthetic null `process.env` entry cannot occur in real Node's string-or-absent environment. That record maps to absent native credentials and reports the adaptation. No real environment key is read by the source oracle.
- URL origin is replaced with a private loopback endpoint; the source fixed URL is asserted and its path, method, headers and JSON body compare exactly. AbortSignal identity does not cross HTTP; source signal state, exact timeout argument, real Node validation and concrete native cancellation are separate evidence.

These files alone establish no verified feature-coverage percentage, total dependency completion or caller adoption. `semantic_worker`, billing/Polar, moderation consequences and application model migration are outside this task. No deployment or caller cutover is implied.

## Pinned environment and parent commands

Use the parent's established read-only source snapshot/private Node environment and a single capped compiler workflow. These commands are **inside isolated containers**, from `/source/dimabot`, not host-run instructions. Preserve all production before/after identity checks and Rust memory/CPU/no-swap/build-lock rules. Formatting and wiring must finish before freezing the source receipt and generating the reference, because metadata includes the native implementation/replay hashes.

Required pins:

- Node `24.22.1`, V8 `13.6.233.17-node.58`, ICU `78.3`, Unicode `17.0`, ABI `137`; executable SHA-256 `569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108`.
- TypeScript `5.9.3`; Mongoose `8.24.2`; complete 707-file Mongoose manifest `63200fe45fbe04c23f601aaa191eb08934ea6795a4442d22ca5a5ba9b679b722`.
- Private RE2 binary `94064b17d6110cd5e36fb0bee49fa267144155300e03160758478b3917e5ffbb`, source manifest `e33073a155ce1180ee2cc52dc8ae548d3a0d24d5c81c2fbd8082834638c15664`, build provenance `4efad596bf97c83c92a825c0bb2452b182051066174951eb2644e8a6bda9ad4c`.
- Actual `semantic.ts` `8e14987048727194d8e55b48f5c0890a0984c3fd1fa4634488c8758d1a835e25`; attribution source `0073e0b48172fc7ccc449fb6c47e1bcd4ffe39549d6641d32b1d0718a6e01c0c`.
- Reused Spam loader `24173a6f2eb5979c89aa27cf5804c4c2c9f92df02daf7a66d9479e5e52cb7b8a`.

Set `DIMA_ADVANCED_SOURCE_ROOT=/source/dimabot`, `DIMA_ADVANCED_RE2_FIXTURE_ROOT=/artifacts/moderation-advanced/re2-node24/re2` and the three existing `DIMA_ADVANCED_RE2_FIXTURE_*_SHA256` values above. Independently supply `DIMA_SPAM_LOADER_SHA256`, `DIMA_SEMANTIC_LOADER_SHA256`, and `DIMA_SEMANTIC_READER_SHA256` from the frozen source receipt. Do not derive a fixture's trusted hash from its own output during replay.

```sh
node --check tests/fixtures/moderation_semantic_source.cjs
node --check tests/fixtures/moderation_semantic_reference.cjs
node tests/fixtures/moderation_semantic_reference.cjs --write /artifacts/moderation-semantic/reference
node tests/fixtures/moderation_semantic_reference.cjs --check /artifacts/moderation-semantic/reference
```

`--write` requires an absolute canonical directory outside the workspace, already empty, and creates `moderation-semantic-reference.json` exclusively. `--check` requires exactly that file and checks regenerated bytes exactly. The metadata contains source/transpiled hashes, full SDK manifests/loaded-module hashes, reader/loader hashes, native implementation/replay hashes and type/import/export audits.

After parent feature wiring, formatting and scoped strict checks, compile in the capped compiler:

```sh
cargo test --locked --no-default-features --features moderation-semantic --test moderation_semantic --test moderation_semantic_provider --test moderation_semantic_source --no-run
```

Set `DIMA_SEMANTIC_REFERENCE=/artifacts/moderation-semantic/reference/moderation-semantic-reference.json` and independently pinned `DIMA_SEMANTIC_REFERENCE_SHA256` in the isolated runtime. Keep `DIMA_SEMANTIC_LOADER_SHA256`, `DIMA_SEMANTIC_READER_SHA256` and `DIMA_SPAM_LOADER_SHA256` available there. Run the exact compiled binaries; source replay needs no Mongo/Redis service or production configuration:

```sh
/path/to/exact/moderation_semantic_source all_pure_source_records --ignored --exact --nocapture
/path/to/exact/moderation_semantic_source every_evaluate_record_through_concrete_provider --ignored --exact --nocapture
/path/to/exact/moderation_semantic_source independent_client_timeout_resamples_wall_clock --exact --nocapture
/path/to/exact/moderation_semantic
/path/to/exact/moderation_semantic_provider
```

The final fixture and full exact-source quality run are accepted for the bounded native contract. The oracle still documents three pure boundaries and ten evaluator seam adaptations rather than claiming unrestricted JavaScript parity. No semantic benchmark is required by this bounded handoff; current Spam measurements belong to the parent and must retain their original frozen tree. See the [migration note](moderation-semantic.md) and [indexed evidence bundle](evidence/2026-10-30-moderation-semantic/README.md).
