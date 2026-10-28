# Native telemetry, TTS utilities, and Bits rules — 2026-10-28

This note records the native extension wave and its bounded verification. It reports local Rust behavior, dependency adapters, and remaining TypeScript caller adoption separately. It does not establish whole-project migration completion or authorize release.

## Implemented feature boundaries

### Observability and logger adapters

[`observability/mod.rs`](../dimabot/src/utils/observability/mod.rs) provides bounded metrics, sampled spans, task-local trace context, metadata-only logs, and the Redis `observability:v1:inbox` sink. Its inbox Lua write trims and expires the queue, tracks overflow, and keeps the payload on an explicit field allowlist. The [`logger`](../dimabot/src/utils/logger.rs) core has concrete [`RedisCacheSink`](../dimabot/src/utils/logger/redis.rs) and [`OtelLoggerSink`](../dimabot/src/utils/logger/otel.rs) adapters over caller-created clients/providers. Their status describes sink/local SDK acceptance; it does not promise downstream collector delivery.

The Node [`telemetry.ts`](../dimabot/src/utils/observability/telemetry.ts) also measures Node/V8 process and event-loop metrics, instruments global `fetch`, and provides Express HTTP middleware. Those runtime-specific paths remain TypeScript. The Rust modules do not adapt V8 probes, fetch interception, Express request/response lifecycle, or JavaScript panic handling. The Rust logger's concrete sinks do not by themselves wire every existing TypeScript logger call to Rust.

### TTS utility layer

[`tts/mod.rs`](../dimabot/src/utils/tts/mod.rs) ports the pure utility layer: expressive-tag settings/filtering and Fish-tag reinforcement; Kokoro voice validation/defaults; legacy speech-template migration; speech-ID generation; message normalization, spoken-user wording, and supplied emote-range extraction; TTS status parse/format; deadline policy; and bounded audio-stream reading with producer cancellation. Recorded parity is limited to the named utilities and fixtures.

Known boundaries remain: JavaScript can slice a string into a lone UTF-16 surrogate, while Rust reports `SplitSurrogate`; this parity gap is not claimed complete. The Fish HTTP provider adapter and application speech queues are not ported. The channel emote cache, credit fallback selection, Redis session/playback state, and playback-timeout file-duration integration also remain TypeScript.

### Bits rules

[`bits_rules/model.rs`](../dimabot/src/bits_rules/model.rs) ports rule validation, legacy cheer-tier conversion, specificity selection, and chat-message choice. [`bits_rules/store.rs`](../dimabot/src/bits_rules/store.rs) is a concrete MongoDB adapter using the existing `eventsubs` and `bits_rules` collections. It prefers the canonical Bits EventSub type over legacy types, supports legacy tier hydration, preserves additional stored rule fields, writes BSON numeric types through the shared JS-number conversion, and retries insert/CAS conflicts up to four times before returning 409.

The recorded fixture comparison matches numeric JSON after binary64 comparison and matches the named BSON numeric types in the stored snapshots. Legacy UTF-16 truncation that splits a surrogate returns an explicit error; malformed stored revisions/documents are rejected. Neither behavior is presented as byte-for-byte parity with every Mongoose cast or malformed legacy record. The TypeScript [`bits-rules.route.ts`](../dimabot/src/server/routes/bits-rules.route.ts), broader EventSub/chat-event consumers, and overlay/application callers remain TypeScript; native model/store coverage is not route or caller adoption.

## Verification evidence

The preserved [native extensions evidence pack](evidence/2026-10-28-native-extensions/) contains the receipts, compressed logs, recorded verifier, and the paired [`bits_rules_store_ts.json`](evidence/2026-10-28-native-extensions/bits_rules_store_ts.json) / [`bits_rules_store_rust.json`](evidence/2026-10-28-native-extensions/bits_rules_store_rust.json) snapshots.

- Node source-oracle receipt `node-fixtures-1793210630739582927` records telemetry checks, 24 TTS golden cases, 13 Bits model cases, and an actual Mongoose store snapshot. The Rust/native snapshot comparison checked numeric JSON as binary64 and BSON numeric type names. The source hash differs from the combined Rust candidate only for the two native compile fixes in `bits_rules/store.rs` and `tests/bits_rules.rs`; the TypeScript sources and goldens match.
- Combined isolated candidate `compiler-fixtures-1793210841489025291` used source tree SHA-256 `0f873c40c1e246dfe06a8eb0fb7b4dd7bc03d865a120dc830150b507b727e6c3`. The combined log records 164 library tests and 16 ordinary integration tests passing. Four explicitly invoked disposable-store fixtures also passed: one Redis telemetry inbox fixture, one domain-journal fixture, and two Bits MongoDB fixtures. This is 184 successful test executions for the stated scope.
- Seven tests are ignored by default in this candidate: those four store-backed cases plus the keyword-store Mongo/Redis fixture, the Twitch Mongo fixture, and the domain-journal benchmark. The latter three were not run in this wave.
- The later all-feature verification for the same source tree passed all-target `cargo check`, `cargo clippy -D warnings`, and no-default-feature all-target `cargo check`; it took 75.846 seconds. Its resource receipt records the 6 CPU, 4 GiB memory/no-swap, 256 PID, two-job limits, 6,033,182,720-byte peak cache, 11,026,214,912-byte minimum available memory, and `production_unchanged: true`.
- Three additional feature-isolated all-target checks for observability, TTS, and Bits passed in `compiler-1793211107567704287`, on the same source tree. They took 45.921 seconds, with a 6,091,251,712-byte peak cache and 11,786,854,400-byte minimum available memory. No Cargo dependency was added and `Cargo.lock` is unchanged.

The receipts and verifier are in [evidence/2026-10-28-native-extensions](evidence/2026-10-28-native-extensions/). Compiler and Node source snapshots differ only in the two recorded Rust compile-fix files noted above; the accepted combined candidate hash is the one cited here. No live production service or database was used for verification, and no deployment, caller cutover, or TypeScript retirement is included in this wave.

## Scheduling decisions

The retained ten-second telemetry interval waits for the next aggregation/export deadline. Once flushing starts, ready batches send consecutively. The one-second connection limit and 1.8-second overall flush limit bound failures. Missed interval ticks coalesce instead of causing a burst of delayed exports; no per-item pacing sleep was added.

Bits changes make up to four immediate CAS attempts, yielding on MongoDB I/O between attempts. Their wait protects storage concurrency rather than imposing an artificial cadence. TTS deadlines wait for future expiration; the underlying spawned operation continues after a timeout, matching `Promise.race`. The audio reader explicitly signals cancellation on incomplete/error exits. No scheduled-worker loop was migrated in this wave, so this evidence is not a worker backlog acceptance claim.

There is no new comparative timing trial for this wave. Its checks establish behavior and concrete adapters; the [foundation measurements](evidence/2026-10-28-foundations/README.md) remain limited to their recorded workloads and snapshots.

## Migration status

The native observability/Redis inbox/logger adapter core, selected TTS policies, and Bits rule model/Mongo adapter have local implementation and focused behavior evidence. Runtime-specific Node instrumentation and application integrations remain open. TTS service/queue adapters and the Bits route/EventSub/chat/overlay caller chain remain open. The standalone credential/JWT source and caller audit is now complete in [`credential-jwt-callers-2026-10-28.md`](credential-jwt-callers-2026-10-28.md); the 800-file feature/caller/dependency reconciliation is still in progress. No project-wide percentage is claimed.
