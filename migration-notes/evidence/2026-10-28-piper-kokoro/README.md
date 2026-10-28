# Piper/Kokoro TTS evidence — 2026-10-28

This directory is the repository evidence index for the native Piper/Kokoro provider slice. Final candidate compiler `1793224870529362167` and Node oracle `1793224753883224280` passed with matching source SHA-256 `f6c700acb8757056c099899d234f0be705e190213e917f141d1349e8c02f4042`. The pack preserves immutable receipts, losslessly compressed logs and source fixture, the raw deadline probe, and recorded verifier scripts. `sha256.json` covers its files; `compressed-{logs,fixtures}.json` records uncompressed hashes. These are task-specific test records, not a release command.

## Preserved evidence

The final package preserves, without editing raw receipts:

- The exact `piper-kokoro-reference.json` (stored as `.json.gz`) produced by `dimabot/tests/fixtures/piper_kokoro_reference.mjs`, including provenance and hashes.
- Raw output and machine-readable receipts for the source oracle, compiler/check/Clippy/tests, and `piper-fetch-deadline.json` actual-fetch/source-reader loopback probe.
- The source snapshot manifest and final source hashes covering the Rust providers, shared HTTP helper, shared voice helper, tests, and source oracle.
- Verifier sources/commands and logs sufficient to reproduce each reported count; test totals must distinguish executions from unique tests/cases.
- Cleanup/ownership evidence for any disposable resources used by the parent validation. This documentation task created and used no runtime resources.

## Accepted verification

Compiler candidate `1793224870529362167` passed formatting, standalone/all-feature check and Clippy, no-default check, and 48 ordinary test executions: nine library, six Kokoro, 13 Piper, 16 Fish, and four existing TTS regressions. Five explicit fixture executions also passed: two Piper/Kokoro source replays covering 34 cases, and three Fish fixture checks. No release benchmark ran in this wave.

The final Node oracle `1793224753883224280` completed in 4.196 seconds and passed fixture write/check for 34 provider cases plus three public-path cases, the real-fetch/source-reader deadline probe, and retained Fish SDK/TypeScript oracle checks; its `--check` reported unchanged output. The 34 source cases divide into 14 exact Kokoro cases and 20 Piper comparisons. Nineteen Piper cases matched normalized outcomes, files, argv, and requests exactly; one injected spawn-error category differs in error detail (`ENOENT` natively). Nonblank URL fixtures with surrounding whitespace compare the source's pre-parser fetch argument with native parsed wire semantics.

The actual-fetch deadline probe showed the fetch signal's 150 ms timer aborting the body at 155 ms even though headers arrived at 98 ms; the nested reader's later 150 ms timeout did not extend the total budget. Its control completed at 56 ms, with headers at 27 ms and bytes `01 02 03`. This is one functional probe, not a timing benchmark or a full Piper service check. The separate fake-CLI check confirmed direct-child reaping and no live process-group member remains.

The final source hash is `f6c700acb8757056c099899d234f0be705e190213e917f141d1349e8c02f4042`, matching across compiler and Node snapshots. Compiler script time was 17.776 seconds, 25.409 seconds total, under 6 CPUs / 4 GiB with no swap / 256 PIDs / two Cargo jobs. Peak cache was 7,196,811,264 bytes; minimum available memory was 12,006,780,928 bytes. Production identity remained unchanged. The earlier compiler candidate `1793224324327657932` stopped on one test-helper Clippy lint (`chunks_exact(2)`); the helper was corrected to `as_chunks`. Warm candidate `1793224547853932223` passed focused checks; final candidate passed the full matrix.

## Scope limits

The source oracle uses controlled fetch/spawn behavior and fixture-only paths. It is not a live provider test, engine/model availability check, audio-quality evaluation, or latency benchmark. Piper CLI verification uses a fake executable; it does not validate Piper engine or model availability. Local adapter coverage does not imply application registry/configuration/caller/queue/emote-catalog wiring or total migration completion. No deployment or caller cutover is recorded.

Final receipts: [`compiler-1793224870529362167`](compiler-1793224870529362167-receipt.json) and [`node-1793224753883224280`](node-1793224753883224280-receipt.json). Raw functional probe: [`piper-fetch-deadline.json`](piper-fetch-deadline.json). The source fixture decompresses to its original JSON name in a disposable fixture directory. Recorded commands: [`piper-kokoro.sh`](recorded-verifier/piper-kokoro.sh) and [`piper-kokoro-node.sh`](recorded-verifier/piper-kokoro-node.sh).
