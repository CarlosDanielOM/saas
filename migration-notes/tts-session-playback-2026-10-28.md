# TTS session and playback helper migration — 2026-10-28

This audit covers only two archived utility files: `src/utils/tts/tts_session.util.ts` and `src/utils/tts/tts_playback_timeout.util.ts`. Both exact source snapshots appear in the [14-file archive manifest](../archives/dimabot-typescript/2026-10-28/manifest.json). They are among 14 source rows archived from the 806-row baseline; the six React Email rows remain a separate explicit exclusion in the matrix. Their matching Rust helper implementations and test evidence establish local feature coverage and helper dependency closure. Existing TTS pipeline callers remain TypeScript, so caller adoption and whole-project migration remain incomplete.

## `tts_session.util.ts`

The archived source exports `enqueueTtsSession`, `popTtsSession`, and `resetTtsSession`. Its sole import is `import type { RedisClientType } from 'redis'`: this is a compile-time type only, not a JavaScript runtime import. Native [`TtsSession`](../dimabot/src/utils/tts/session.rs) replaces that boundary with an owned `redis::aio::ConnectionManager` and implements the Lua-backed enqueue, ordered compare-and-pop, session reset, stale-payload cleanup, and declared-key discipline directly. `redis` remains the runtime dependency, through the native Rust crate; `std::collections::HashSet` replaces the source's set use.

This helper has no opaque host callback or missing application adapter inside its audited feature boundary. The Redis connection manager is concrete. Its callers still use the TypeScript helper today, so this is not native TTS pipeline adoption.

Pop makes up to eight immediate peek/CAS attempts; each Redis operation is awaited, yielding for real I/O. Reset cleanup processes payloads in bounded 128-key Lua chunks. There are no artificial sleeps or new worker scheduling changes in these helpers.

## `tts_playback_timeout.util.ts`

The archived source exports `getAudioFileDurationMs` and `getTtsPlaybackTimeoutMs`. Its runtime imports are `node:fs/promises`, `node:module`, `node:path`, and the nested `createRequire(... )('mp3-duration')`. The first three provide filesystem access, CommonJS package loading, and path extension handling. The path import is a default import; the other two are named imports. `mp3-duration` is a runtime npm dependency that the original top-level import inventory did not capture.

Native [`playback_timeout.rs`](../dimabot/src/utils/tts/playback_timeout.rs) uses standard-library file/path APIs for WAV and MP3 duration scanning, implementing the relevant `mp3-duration` 1.1 behavior instead of requiring npm at runtime. The asynchronous entrypoint uses Tokio `spawn_blocking` and a semaphore with four permits; cancellation does not release a permit until the blocking file scan exits. This closes the helper's direct dependency chain with concrete Rust implementations. No host callback is left outstanding inside these helper APIs.

The compatibility fixtures exposed two source-package quirks that the Rust scanner now preserves: bitrate indexes 0 and 15 can count padding-only frames, and the package's string-versus-number Layer I padding comparison never enables the four-byte padding branch. An initial sync-word interpretation differed; the parser was corrected and all 52 source-corpus cases, including the two real npm CBR/VBR files in the task-owned fixture, matched. These behaviors are kept for compatibility with the source package, not asserted as ideal MP3 parsing rules.

The timeout policy retains the 60-second minimum and adds 30 seconds beyond a longer file duration. These are future playback acknowledgement/recovery deadlines, not pacing waits. The corpus check is not a comparative I/O benchmark; the separate UTF-16 normalization timings do not measure file scanning.

## Current runtime callers

Static import tracing found these direct TypeScript consumers:

- [`tts_lane.ts`](../dimabot/src/pets/tts_lane.ts) dynamically imports `enqueueTtsSession`.
- [`tts_queue.handler.ts`](../dimabot/src/handlers/tts_queue.handler.ts) imports enqueue/pop and uses the playback timeout while awaiting overlay playback acknowledgement.
- [`dimafx_queue.handler.ts`](../dimabot/src/handlers/dimafx_queue.handler.ts) imports the audio-duration helper.
- [`speech.ts`](../dimabot/src/utils/speech.ts) imports `resetTtsSession` for session cleanup.

The route through these callers, TTS provider requests, speech queues, playback state, and application orchestration has not been migrated or adopted through these helpers. Other TTS utility gaps remain, including Fish provider/service integration, emote cache, credit fallback, and broader playback/session coordination. No new worker, service, or scheduling tier is introduced here.

## Verification evidence

Pre-archive checks covered formatting, the TTS/Redis feature, strict Clippy, three explicit disposable fixtures, and 52 audio-source cases through synchronous and asynchronous duration/timeout entrypoints. Two real disposable Dragonfly tests exercised Lua behavior, CAS/reset races, bounded cleanup, and chunk handling; four TTS/`JsString` regression tests also passed. The all-feature/all-target check, strict Clippy, and no-default-feature/all-target check passed for that snapshot. Receipt `compiler-fixtures-1793214023189423553` records source tree SHA-256 `39c812975fc383e0b2e425babe5e3ed9fc8847c710202e70abac7cdbdf63c52a`.

After moving both exact TypeScript files into the archive, the source-fallback Node oracle `node-fixtures-1793214245796828517` and full Rust verification `compiler-fixtures-1793214246963446939` passed against source tree SHA-256 `6e7a339922b2251a5a8606c0da51e832096cc61345c27a10ccc6c432fcf6e57b`. A sequential fixture recheck (`compiler-fixtures-1793214383238224143`) passed all three store/file tests and verified the 51 existing audio-file hashes before and after the tests; the 52nd case is a missing file. The Node oracle reads the archived source when the live source path is absent.

Final source review added an empty-identifier regression: TypeScript leaves an empty queue head untouched. The native test failed before adding the matching guard. The extended archived-source oracle passed in `node-fixtures-1793215087449805709`; the corrected implementation passed seven scoped executions, all 52 audio cases, strict focused/all-feature checks and no-default checks in `compiler-fixtures-1793215411648027574`, source tree SHA-256 `a49cac91f06745d15357830ae2996a64072e5d85d9425fe7377972ec8773564c`. Implementation commits are `adb84b16` and `6be26656`. [Preserved evidence](evidence/2026-10-28-tts-io/README.md) includes the earlier failed compatibility probes and the passing results.

The compiler runs used 6 CPUs, a 4 GiB memory cap with no swap, two Cargo jobs, a 256 PID cap, and an 8 GiB cache ceiling. The final receipt records a 6,290,665,472-byte peak cache, 10,854,731,776-byte minimum available memory, and `production_unchanged: true`. No Cargo dependency was added or installed. Application tests used task-owned resources; production inspection was read-only. This work includes no deployment or push.
