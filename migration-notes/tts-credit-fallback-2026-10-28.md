# TTS credit fallback native helper — 2026-10-28

## Status and scope

The archived pure helper `src/utils/tts/tts_credit_fallback.util.ts` now has a native Rust implementation in `dimabot/src/utils/tts/credit_fallback.rs`. Its source test is archived beside it, with Rust behavior coverage in `dimabot/tests/tts_credit_fallback.rs`. This is verified local helper behavior only. It does not complete the application credit lookup, queue processing, pet runtime, provider selection/registration, synthesis, or caller migration; total `dimabot/` dependency completeness remains open.

The source snapshots are preserved at [`archives/dimabot-typescript/2026-10-28/src/utils/tts/tts_credit_fallback.util.ts`](../archives/dimabot-typescript/2026-10-28/src/utils/tts/tts_credit_fallback.util.ts) (SHA-256 `1e67d7b9368ed7835339e6df2e33a2d1a94e590d288a034532a18915f8c0f2de`) and [`archives/dimabot-typescript/2026-10-28/src/handlers/tts_credit_fallback.test.ts`](../archives/dimabot-typescript/2026-10-28/src/handlers/tts_credit_fallback.test.ts) (SHA-256 `ebae79d15263f866cf69661a9f964cb41645a1ca383b53dd8ebb0f0a48885669`). Both exact archive hashes were checked against their baseline snapshots. The 806-row baseline inventory is unchanged; 790 TypeScript files remain in `dimabot/` (618 application files, 166 tests, and six excluded React Email templates).

## Contract and reuse

`resolve_tts_for_credit_status` returns a borrowed `Cow` for already-Piper requests and available credit, preserving the original request without a copy. Otherwise it switches exhausted premium/pro requests to Kokoro and sends all other exhausted/unavailable cases to Piper. It changes clone mode to speak, clears the model and clone name, applies the existing expressive-tag filter, resolves Kokoro voices through the existing resolver, and uses the language-specific Kokoro defaults. Piper fallback voice selection preserves JavaScript truthiness, including a whitespace-only override. Other caller fields are carried in the generic `extra` value; that value is cloned when fallback requires an owned request, and a caller may use `Arc` when its context needs shared identity.

The helper reuses the existing `expressive_tag_regex`, valid-UTF-8 expressive filter, `JsString` UTF-16 storage, and native Kokoro resolver. Its valid-UTF-8 path uses the existing filter directly; its UTF-16 shadow mapping keeps original code units around regex matches so lone surrogates survive. The billing status union is represented by native `Available`, `Exhausted`, and `Unavailable` enum variants, and provider/mode/language contracts use existing native enums. These are local helper dependencies, not a port of the billing implementation or runtime services.

`PIPER_VOICE_EN` (`en_US-ryan-medium`) and `PIPER_VOICE_ES` (`es_MX-ald-medium`) were extracted from the actual `DEFAULT_TTS_SETTINGS` initializer in `src/schemas/channel_tts_settings.schema.ts`. The source oracle selects that initializer from the schema AST and evaluates it with only its actual pure TTS filter and voice modules. This does not migrate the channel TTS schema, its normalization or Mongoose model, or its read/upsert adapter.

The Rust helper accepts its typed request contract. It does not emulate arbitrary malformed JavaScript object shapes, reflective own-property presence when a field is `undefined`, or executable object hooks. These boundaries are outside the source's typed request contract and remain explicit.

Application adoption is pending: `src/handlers/tts_queue.handler.ts` and `src/pets/runtime.ts` still contain TypeScript imports of the retired helper. The TypeScript queue handler, credit billing behavior, usage accounting, emote handling, queue and preview paths, and pet runtime remain outside this local helper port. Archive permission allows the TypeScript source retirement in the migration checkout; those imports do not constitute Rust caller adoption.

## Verification evidence

Local source commit `70dc6f6c` preserves the verified helper and exact archive. The final source snapshot was `0a7ab31bac53f28254243d81805eeda933c856f85839f9ee9f76f1682c50b3e8`. The pinned Node 24.22.1 / V8 13.6.233.17-node.58 / TypeScript 5.9.3 source oracle used the archived helper, live filter and voice modules, and selected schema initializer. It passed 276 byte-exact scenarios: 270 generated matrix scenarios and six explicit UTF-16/fallback cases. The replay checked split UTF-16 code units and unchanged-request identity.

The final compiler run, `1793231264957253198`, used the same source snapshot and passed formatting, standalone TTS check and Clippy, all-feature check and Clippy, and no-default-feature check. Its test matrix reported 53 ordinary executions (3 library, 1 `JsString`, 2 credit fallback, 3 TTS, 9 catalog, 6 Kokoro, 13 Piper, and 16 Fish) plus one separately invoked explicit credit fallback replay. The separate replay is not included in the ordinary count. Compiler script time was 11.024 seconds and total time 18.451 seconds with a warm cache; peak cache usage was 7,253,487,616 bytes and minimum available memory was 11,828,461,568 bytes. The required caps were verified: 6 CPUs, 4 GiB memory with no swap, 256 PIDs, and two Cargo jobs. These are run observations, not a code-speed measurement.

The Node oracle run `1793231232336395230` passed the exact-source 276-scenario write/check in 2.002 seconds of script time and 3.208 seconds total. The final source/archive checks verified 16 exact archived hashes, the two newly retired paths against their source snapshots, and the 790 remaining TypeScript files. Production identity/configuration checks reported unchanged. No Cargo package, version, or lockfile change was made. No benchmark was run, so no latency or throughput improvement is claimed.

Raw receipts, logs, compressed oracle output, hashes, fixture snapshots, verifier scripts, and cleanup evidence are indexed in [`evidence/2026-10-28-tts-credit-fallback/README.md`](evidence/2026-10-28-tts-credit-fallback/README.md). This record does not authorize deployment or caller cutover.

## Routing observation

GPT-6.1 Terra at xhigh authored an initial implementation draft that remained unverified. GPT-6.1 Sol at xhigh reviewed and integrated the fieldwise constructor and UTF-8 fast path. GPT-6.1 Terra performed the mechanical TypeScript retirement, and GPT-6 Luna at high reconciled the documentation. The final checks establish this bounded task outcome only; no inter-model comparison, cost/TPS/runtime attribution, or tier change is supported.

## Related records

- [Full dimabot Rust migration status](full-dimabot-rust-2026-10-28.md)
- [Source dependency inventory](dimabot-dependency-matrix-2026-10-28.md)
- [Archived source manifest](../archives/dimabot-typescript/2026-10-28/manifest.json)
