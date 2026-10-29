# TTS runtime factory evidence — 2026-10-29

This pack records source, compiler, and isolated runtime verification for the [TTS runtime factory note](../../tts-runtime-2026-10-29.md). Final candidate identity is source commit `bc48e32f3de0f864c8f8eaa7211ca6f35931698a`, source-tree SHA-256 `80846b66199103deea86f9225a69796516c6243930fede9b5da3a7f6b805c6a8`. Receipt counts, reused fixture hashes, task cleanup, and artifact hashes are summarized in [`verification-summary.json`](verification-summary.json), [`reused-fixture-provenance.json`](reused-fixture-provenance.json), [`cleanup.json`](cleanup.json), and the [`sha256.json`](sha256.json) inventory.

## Source oracle

- Final Node oracle `1793235471833078624` passed in 4.002 seconds of script time and 5.217 seconds total: [receipt](node-1793235471833078624-receipt.json), [compressed log](node-1793235471833078624.log.gz), [configuration/path results](tts_runtime_reference.json.gz), and [dynamic source results](tts_runtime_dynamic_reference.json.gz).
- It exercised 13 source-selected configuration cases, five module-directory contexts, and seven actual-TypeScript dynamic scenarios. The source fixtures are [`tts_runtime_reference.mjs`](../../../dimabot/tests/fixtures/tts_runtime_reference.mjs) and [`tts_runtime_dynamic_reference.mjs`](../../../dimabot/tests/fixtures/tts_runtime_dynamic_reference.mjs).
- Initial Node run `1793235049534538894` passed against earlier source SHA-256 `50fd86981f501ef8d45cf480b36f36dd686f7880d651c82c1d6113c227e8fca6`: [receipt](node-1793235049534538894-receipt.json) and [compressed log](node-1793235049534538894.log.gz). It is iteration history; the final receipt above is source-matched to the accepted compiler candidate.

## Compiler and native fixtures

Compiler candidate `1793235519923031551` passed formatting, standalone `tts-services` all-target check and strict Clippy, all-feature all-target check and strict Clippy, and no-default-feature all-target check. It passed 64 ordinary test executions (10 library, nine Fish catalog, one JS string, six Kokoro, 13 Piper, 16 Fish, six runtime, three TTS utilities) and eight explicit fixture executions (two runtime, two Fish SDK, one Fish service, one each Piper, Kokoro, and catalog): [receipt](compiler-1793235519923031551-receipt.json), [compressed log](compiler-1793235519923031551.log.gz).

Earlier compiler candidate `1793235095096260896` passed runtime tests and two explicit replays before stopping only on a Clippy test-style lint (`get().is_none()`); the mechanical `contains_key` correction is in the final source. Preserve this as iteration history rather than a behavioral failure: [receipt](compiler-1793235095096260896-receipt.json) and [compressed log](compiler-1793235095096260896.log.gz).

The compiler script took 107.969 seconds and the full run 115.256 seconds. Limits were verified at six CPUs, 4 GiB memory with no swap, 256 PIDs, and two Cargo jobs. Peak cache was 7,539,949,568 bytes; minimum available memory was 10,700,804,096 bytes. The compiler receipt records production unchanged. Fixture files were hash-checked before and after: [before](tts-runtime-fixtures-before.sha256), [after](tts-runtime-fixtures-after.sha256).

One loopback server observed a single keep-alive TCP connection for eight sequential same-origin requests across Piper, Kokoro, Fish primary/direct paths, and Fish catalog. This is functional connection-reuse evidence for one origin, not latency or cross-origin production-pool evidence.

## Reused source fixtures and OS environment probe

Four existing source fixtures were hash-checked against the final source snapshot: [`fish-sdk-protocol.json.gz`](fish-sdk-protocol.json.gz) (95 entries), [`fish-tts-reference.json.gz`](fish-tts-reference.json.gz) (12), [`piper-kokoro-reference.json.gz`](piper-kokoro-reference.json.gz) (10), and [`fish-catalog-reference.json.gz`](fish-catalog-reference.json.gz) (8, including the Node executable). These counts are entries across fixtures, not unique files. The Node oracles were not regenerated in this wave; the stored fixture hashes matched and their native replay tests were freshly executed. The combined compressed fixture bundle is [`compressed-fixtures.json`](compressed-fixtures.json).

Independent Node probe `1793234525524297207` confirmed that a raw `0xFF` OS environment byte becomes U+FFFD. It used earlier settings source SHA-256 `0b8de5bf5986e9a546449eb466f54777bfcc7249fa4ebadb09f722a046f5e3c7` and is separate from the final runtime candidate. The native child test used `env_clear` and a raw `OsString`, without mutating its parent environment. Evidence: [probe receipt](node-1793234525524297207-receipt.json), [compressed log](node-1793234525524297207.log.gz), [source proof](env-bytes-source-proof.json), and [probe script](recorded-verifier/tts_runtime_env_bytes_probe.mjs).

## Cleanup and scope

The [cleanup record](cleanup.json) reports 19 production containers unchanged across ID, image, start time, mounts, configured image, entrypoint, command, and Compose fields. No task-owned container, network, or volume remained. No deployment or push occurred. The [format receipt](format-1793234986143935981-receipt.json) and [format log](format-1793234986143935981.log.gz) are retained with the [recorded verifiers](recorded-verifier/).

No factory benchmark was run. Production providers, Twitch APIs, and cdom201 were not contacted. The runtime wave archived no TypeScript source and made no caller cutover. Detailed boundaries and remaining TTS application work are in the [migration note](../../tts-runtime-2026-10-29.md).
