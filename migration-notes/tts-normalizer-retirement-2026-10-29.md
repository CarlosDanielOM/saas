# TTS normalizer TypeScript retirement — 2026-10-29

## Scope and retirement record

This bounded retirement removes
`src/utils/tts/normalize_tts_message.util.ts` and its test from the application
source tree and preserves their exact bytes in
[`archives/dimabot-typescript/2026-10-28/src/utils/tts/`](../archives/dimabot-typescript/2026-10-28/src/utils/tts/).
The source-retirement and fixture integration commit is
`6878a148fac19dcd7e12c5f5aebb04990d6902fe`.
The TypeScript source SHA-256 is
`6e8030f033e9e32c357c669d8b0d09cbc91a30c814cd5ea3c6a0109ccdb88adc`; the
test SHA-256 is
`5f36c7346ecd23130ff9b035b8c3f8561dd094fba6a7b16a696e30ccaefe1d39`. The
archive now contains 21 baseline snapshots; the previous 19 remain unchanged.
The frozen source baseline is 806 TypeScript files, separate from the seven
earlier archived worker entrypoints. The current source inventory is 785
TypeScript files, including six excluded email templates. These counts describe
inventory and are not a migration percentage.

The native normalizer and equivalent lossless UTF-16 APIs were already
implemented and recorded in [lossless TTS normalization](tts-lossless-normalization-2026-10-29.md).
This retirement records the final source archive and fixture maintenance; it
does not wire application callers to Rust. Queue/routes, pet/billing runtime,
and caller adoption remain open obligations.

## Oracle, fixtures, and verification status

The fixture resolver permits only the live module or its archived snapshot and
uses strict filesystem checks, including `lstat` rejection of symlinks. The
source-backed resolver scenarios cover all three retired utility modules.
Fixture readers now load archived source snapshots for TTS utility provenance,
and the generated embedded golden corpus records that provenance. The actual
TypeScript bytes remain unchanged. Parent checks confirmed all 21 archive
hashes against their frozen source, with the prior 19 byte-identical.

Fresh source-derived fixtures and snapshots were produced by Node first-stage
run `node-1793247281804529311` (`22.509` seconds for the script, `23.808`
seconds total) and final-stage run `node-1793247645904868658` (`4.003` seconds
for the script, `5.337` seconds total). The first stage compared ten prior and
fresh semantic outputs exactly, ignoring only private artifact-directory
strings, and verified 15 lossless-source and eight emote-source hashes. It
regenerated or checked 1,774 lossless, 1,932 expressive, 276 credit,
308 settings plus 11 schema, 11 Fish plus three path, 34 Piper/Kokoro plus
three path, 13 runtime configuration, five context, and seven dynamic-source
cases. These are separate source corpora, not additive unique features. The
final Node stage passed the default golden, 65-emote, 1,774-lossless, and
provenance checks. A later exact-frozen-source compiler run replayed the
lossless, expressive, credit, pure-settings, schema, Fish, Piper, Kokoro, and
two runtime fixtures. All 21 archive resolver checks passed (seven scenarios
for each of the three retired modules). Final source-frozen Node run
`node-1793248118632837471` passed in 4.003 seconds for the script and 5.327
seconds total against frozen source snapshot SHA-256
`bd42a52ec305f8d35d0797b75f1d4f9404873b960783cc8516a44cc792fbe503`; it
passed the default golden, 65-emote, 1,774-lossless, and provenance checks.
All 15 retained source files were bound to the successful receipt. The 27
embedded TTS golden cases retained their source hashes and gained archive
provenance.

Compiler candidate `compiler-fixtures-1793248206114963870` passed 244 ordinary
executions and 11 explicit fixture executions (255 total, not unique behavior
count), formatting, standalone emotes and TTS all-target check/strict Clippy,
all-features all-target check/strict Clippy, and no-feature all-target check.
It used six CPUs, a 4 GiB memory limit with memory-swap also limited to 4 GiB
(no swap), 256 PIDs, and two Cargo jobs; the
private cache peaked at 8,280,543,232 bytes and minimum available memory was
9,206,849,536 bytes. The frozen source snapshot SHA-256 was
`bd42a52ec305f8d35d0797b75f1d4f9404873b960783cc8516a44cc792fbe503`. The
emote adapter integration coverage and limits are detailed in the
[Twitch emote migration record](twitch-emotes-2026-10-29.md).

The lossless benchmark harness ran only as a Node smoke check over ten
workloads. Its prepared input SHA-256 is
`838d13b6a5ee3ab079907f7e19d377a179e00df9d0e4112bcfe94ca7a225f100`; the
workloads match the prior final input, but provenance/source paths changed.
There is no new paired performance result and no basis to revise or restate
the prior benchmark figures.

The normalizer-retirement artifacts are under
`/root/.local/state/rust-full-migration-20261028-lu443ytp/artifacts/emotes-normalizer-retirement`.
The combined source, compiler, and cleanup evidence index is
[`evidence/2026-10-29-emotes-normalizer-retirement/README.md`](evidence/2026-10-29-emotes-normalizer-retirement/README.md).

## Migration boundary

This retirement records source preservation and fixture redirection only. The
native normalizer's local source fixtures and compiler regressions passed, but
all TTS application behavior is not thereby migrated: queue/routes, pet/billing
behavior, and caller adoption remain outside this retirement. External pet
helper/runtime obligations remain separately tracked. No source count change
is treated as a coverage score. The acknowledged read-only production
fingerprint `50903c6a12f924a8fa842db591bb68472fe98c522309d790a03743714add3536`
was unchanged across the 19-record checks; no deployment, production mutation,
or push is claimed.
