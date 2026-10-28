# Fish voice catalog Rust migration — 2026-10-28

## Status and scope

The Fish voice catalog source exports now have a concrete native Rust implementation: voice-ID resolution, search-query validation and construction, individual voice normalization, search-result normalization, pooled Fish Audio HTTP requests, and parsed-response caching. The implementation is in [`fish_voice_catalog.rs`](../dimabot/src/server/services/tts/fish_voice_catalog.rs), with its shared lossless JSON representation in [`lossless_json.rs`](../dimabot/src/server/services/tts/lossless_json.rs) and Fish SDK protocol/error helpers in [`fish_protocol.rs`](../dimabot/src/server/services/tts/fish_protocol.rs). The TypeScript source and its callers remain in place; this is local Rust feature coverage, not caller adoption or a TypeScript retirement.

The catalog slice builds on the earlier [Fish TTS provider slice](fish-tts-2026-10-28.md) and shared HTTP work in the [Piper/Kokoro provider slice](piper-kokoro-2026-10-28.md). It does not complete the application TTS call graph. The `SpeechPaths` application factory/configuration, provider registration, request callers, queues, Piper/Kokoro integration, emote catalog, and other application adapters remain open. No total migration percentage is claimed. No deployment, caller cutover, TypeScript deletion, or production change is recorded.

## Source behavior and compatibility

- Voice IDs use the source alias table, default for absent/empty input, JavaScript trimming, and 32-hex-character validation; accepted hexadecimal IDs normalize to lowercase. Search validation preserves source order and coercion behavior, including UTF-16 length bounds, string-only filter/page requirements after coercion, and errors when an own non-callable `toString` prevents primitive conversion.
- Search URLs follow `URLSearchParams` form encoding, including spaces as `+` and lone UTF-16 surrogates replaced when converted to a URL USVString. Source-request pagination and upstream query parameters are retained.
- Voice normalization applies the source visibility/type/state/DMCA eligibility rules, then preserves eager tag coercion (including late coercion failures), female-over-male precedence, style-tag filtering/deduplication/cap, language extraction, licensed values, validated cover/sample URLs, UTF-16-safe name/description/sample truncation, and finite nonnegative floored use counts. Search filtering and `has_more`/`total` nullish and JavaScript-number coercion behavior are also preserved.
- The pooled HTTP client has a 12-second total request deadline spanning response headers and body. Header/request failures map to the source `VoiceRequestError` categories; body-read, JSON parse, coercion, and configured-limit errors remain distinct ordinary Rust errors. Successful parsed JSON is cached for 60 seconds in a capacity-100 FIFO. Cache hits do not promote entries; cache lookup precedes key validation; the capacity eviction order preserves the source `Map.delete`-before-`Map.set` quirk for a refreshed expired entry. Cache locks are not held across I/O or normalization, and clones share cached parsed payloads.
- Responses are bounded at 8 MiB by default and JSON nesting at 128. These are explicit accepted resource limits, not compatibility claims for unbounded inputs. The native JSON representation preserves binary64 numbers, object property insertion order and ECMAScript integer-key enumeration, duplicate-key value replacement without moving the original key, and escaped lone UTF-16 units needed by the DTO. It does not emulate arbitrary JavaScript objects, prototypes, getters, or executable hooks.
- Fish SDK error parsing and MessagePack behavior continue to use the shared protocol helper. Protocol parsing retains its bounded error-body semantics; diagnostic text outside the catalog's explicit request-error contract may differ from Node/Rust transport or parser wording.
- No retry, polling loop, or artificial cadence was added to catalog reads. The retained deadline bounds one request and protects the caller from a stalled provider.

## Validation evidence

The baseline source was `26a54cec`, with exact frozen snapshot SHA-256 `b145e6789dd4bab805c4496310d3597de2a2a1f0fbd19484049634e9be10a8e4`. Its capped compiler candidate `1793227228012731753` and Node oracle `1793227081100728697` passed. After the performance follow-up, optimized source `344502ed` was revalidated at exact snapshot SHA-256 `c7686221891ebbee134e8f4399fea7586481057b05760434ec0933eb84206485`; compiler run `1793228464989174096` and Node oracle run `1793228300161265309` passed against that snapshot. The final receipts include a successful source replay and verified production-unchanged/resource-limit records.

The final matrix reported 58 ordinary test executions: 10 library tests (including the new meaningful escaping regression), nine catalog tests, six Kokoro tests, 13 Piper tests, 16 Fish HTTP tests, and four TTS/JS-string regressions. Six explicit fixture executions covered all 126 catalog source scenarios (15 resolve, 28 parse, 59 normalize, 10 get, 12 search, two cache sequences), two cache traces totaling 108 steps, 123 recorded source HTTP calls, two provider oracle replays (34 cases), and three Fish fixtures. The prepared-NaN source case was replayed. All source HTTP calls were controlled fixtures; no external provider was contacted. One release benchmark invocation also ran. The final code checks passed formatting, standalone/all-feature checks, Clippy, and no-default-feature checks.

The final capped matrix took 145.912 seconds for the compiler script and 153.739 seconds total, using six CPUs, 4 GiB memory with no swap, 256 PIDs, and two Cargo jobs. Peak Cargo cache was 7,246,712,832 bytes and minimum available memory was 10,573,561,856 bytes; the recorded production-unchanged check was true. The baseline matrix took 157.473 seconds for the compiler script and 165.278 seconds total, with peak Cargo cache 7,245,889,536 bytes and minimum available memory 10,791,972,864 bytes. Both candidates used the stated compiler limits; times/cache/headroom are run observations, not performance or resource-efficiency claims.

The initial paired microbenchmark is preserved as a regression-bearing baseline. It measures prepared TypeScript normalization plus `JSON.stringify`, UTF-8 `Buffer` creation, and a full-byte checksum against prepared Rust normalization plus lossless JSON UTF-8 output and the same checksum. Each workload used 100 warmups and seven samples; the three ordinary cases ran 10,000 iterations per sample and the large case 1,000. Output bytes and checksums matched. Initial Node/Rust medians in microseconds per operation were:

| Workload | Node | Rust | Rust / Node |
|---|---:|---:|---:|
| valid | 2.566394 | 1.6963551 | 0.661× |
| cuts | 10.091748 | 15.1674329 | 1.503× |
| gender | 5.7555384 | 8.1026978 | 1.408× |
| large | 155.67234 | 437.766028 | 2.812× |

The final paired medians in microseconds were valid: Node 2.0500612 / Rust 0.6123702 (0.299×); cuts: 9.8888634 / 9.6632318 (0.977×); gender: 4.9162564 / 1.8951952 (0.385×); large: 134.655906 / 62.157969 (0.462×). Initial and final Rust-over-Node ratios, respectively, were valid 0.661× / 0.299×, cuts 1.503× / 0.977×, gender 1.408× / 0.385×, and large 2.812× / 0.462×. All four final workloads matched exact JSON bytes, byte counts, and full-byte checksums across seven samples. Both benchmark runs used the same prepared-input file (SHA-256 `317abf0b1d4a186a9e172e4ebe7ff6f1270ad17de8ccb98e01c4c0404409caa5`). The final cuts medians differ by about 2.3%; treat that as near parity with no significance or faster claim. Node and Rust medians both moved between runs; sequential pinned-container runs on one shared host are not an interleaved statistical study or isolated causal comparison.

The follow-up changed the borrowed lowercase-ASCII tag path, retained eager tag errors and female-over-male precedence, and replaced intermediate DTO/JSON string construction with one output buffer plus shared UTF-8-span/UTF-16-fallback writing. It made no slice or trim changes. Input parsing, VM setup, I/O, and HTTP are excluded; normalization, JSON/UTF-8 serialization, and a full-byte checksum are included. The initial three Rust regressions remain visible above. Neither result measures network/provider latency, whole-service throughput, CPU, or RSS.

The earlier source-oracle fixture initially had an expected-response mistake for a terminal line feed in `get-id-final-lf`; the TypeScript source rejects that ID before fetch. The oracle expectation was corrected and the preserved first oracle attempt failed before the corrected run passed. A negative-zero oracle input was also corrected before the baseline accepted run because `JSON.stringify(-0)` produces `0`. Neither was a runtime parity defect. Preserve both iterations in the evidence record without presenting them as implementation bugs.

See the [Fish catalog evidence index](evidence/2026-10-28-fish-catalog/README.md) for exact baseline and final receipt identities, compressed raw logs and fixtures, hashes, benchmark inputs/results, and comparison details.

## Migration boundary

This is a complete local port of the source exports listed above, including concrete HTTP, cache, query encoding, normalization/search, and lossless DTO JSON serialization. Application registration and caller adoption remain pending. The broader TTS pipeline still needs native credit/usage services, emote adapters, queue handling, preview orchestration, and their required application dependencies; those gaps prevent whole-pipeline completion. The wider dimabot migration remains in progress; baseline counts and local source coverage do not imply a total percentage. The 14 previously archived leaf helpers remain unchanged, and no TypeScript source was archived by this wave. No Cargo package/version, lockfile, default feature set, or worker-profile graph change is reported.

## Routing observation

Task-specific routing was: an initial asynchronous Terra xhigh draft, bounded foreground Sol xhigh implementation, Terra xhigh test work, Terra high source-oracle/benchmark work, root-led final verification, Luna high source-backed documentation, and a Sol xhigh performance follow-up. The initial asynchronous Terra draft was partial and took roughly 80 seconds; this records one task observation only and does not support a model or throughput conclusion. The optimized final snapshot passed the capped compiler matrix, source replay, and paired prepared-workload benchmark described above. These task results do not establish an inter-model comparison, TPS/cost conclusion, model-tier reorder, broad capability claim, or runtime attribution. The user's stated model tier remains unchanged.

## Related records

- [Full dimabot Rust migration status](full-dimabot-rust-2026-10-28.md)
- [Fish catalog evidence index](evidence/2026-10-28-fish-catalog/README.md)
- [Fish TTS provider slice](fish-tts-2026-10-28.md)
- [Piper/Kokoro provider slice](piper-kokoro-2026-10-28.md)
