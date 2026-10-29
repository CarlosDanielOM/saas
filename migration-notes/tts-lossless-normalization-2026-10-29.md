# Lossless TTS normalization and pet speech text — 2026-10-29

## Scope and status

This slice adds JavaScript UTF-16 counterparts for TTS message normalization,
spoken-user composition, and emote-name extraction, then composes those helpers
with the existing expressive-tag filter for the captured pet speech helper. It
extends the existing TTS implementation: valid UTF-8 reuses its existing
normalization path, while arbitrary UTF-16 uses a lossless branch; both retain
the same filtering policy and link-matching rules. The source implementation
is commit `782e036316810290e89e8638516f38f0eb081d4d`; all nine changed source
files were bound to its validation receipt. The allocation refinement compacts
emote tokens, control characters, and whitespace in place on the ill-formed
UTF-16 path and constructs the final `JsString` once.

No application caller was moved, no TypeScript source retired, and no runtime
cutover or deployment is claimed. The pet helper is not the pet runtime
adapter: settings/emote lookup, cancellation and revision behavior, phases,
persistence, billing, and final spoken text remain open obligations.

## Native API and source mapping

| Captured TypeScript export | Rust implementation |
| --- | --- |
| `NormalizeTtsMessageOptions` | `utils::tts::NormalizeTtsMessageOptions` |
| `NormalizeTtsMessageResult` | `NormalizeTtsMessageResult` and lossless `NormalizeTtsMessageResultJs` |
| `normalizeTtsMessage` | Existing `normalize_tts_message`; new `normalize_tts_message_js` |
| `buildSpokenUserMessage` | Existing `build_spoken_user_message`; new `build_spoken_user_message_js` |
| `extractEmoteNames` | Existing `extract_emote_names`; new `extract_emote_names_js` |
| `filterExpressiveTtsTags` re-export | Existing native expressive-tag filtering APIs |
| `filterPetTalkText` | `pet_speech_text::filter_pet_talk_text` |
| `TtsLanguage`, `SpeechSource` unions | Native enums `TtsLanguage`, `SpeechSource` |

`JsString` preserves arbitrary UTF-16 units. `normalize_tts_message_js` sends
valid UTF-8 through the existing implementation and uses its UTF-16 path when
the input contains unpaired surrogates. Its `original_text` is the exact input
to normalization. In the pet composition helper, the input is already
expressive-filtered, so the result's `original_text` is the filtered text.
Spoken-user composition retains malformed user/message units. Emote extraction
keeps first occurrence while following supplied group and entry order.

The captured `filterPetTalkText` calls `filterExpressiveTtsTags(text, { provider,
enabledTags: filters.expressiveTags })`, then passes the resulting text and
spread filter options into `normalizeTtsMessage`. The helper consumes the
`expressiveTags` value supplied in `filters` as-is; it does not normalize it or
insert schema defaults. A caller may legitimately pass raw or already
normalized settings. When the value is raw JSON, only literal `true` enables a
tag. Channel-settings normalization is a separate caller operation, not an
extra step performed inside this helper.

The helper receives the provider after credit-fallback resolution, matching
the captured caller contract. The six pet corpus cases that exercise credit
fallback obtain the effective provider from actual TypeScript fallback code;
they test the helper with that provider. They do not assert that the Rust pet
helper performs credit resolution. The separate 276-case credit-fallback
source fixture remains the evidence for that policy.

## Source coverage and limits

The pinned Node oracle loaded the actual captured TypeScript utilities and pet
helper, along with its actual credit fallback and expressive utility. It also
audited exports, metadata/type fields/unions, and schema defaults from the
source AST. Pure-function imports were allowlisted in the VM. The schema
default was read from its AST; this did not load or execute the Mongoose
application. The captured external `speech_text.ts` SHA-256 is
`9a5c1923ef1ceb3e1c454dab4803a589289c04cf1eb954aa3720ca2c163a6561`.

The new actual-source corpus contains 1,774 cases:

| Operation | Cases |
| --- | ---: |
| Normalization | 1,303 |
| Pet helper composition | 342 |
| Emote extraction | 9 |
| Spoken-user composition | 120 |

The pet corpus's 342 cases comprise 336 settings/provider/text/filter
combinations and six cases using effective providers resolved by the actual
TypeScript credit fallback. Source code coverage includes malformed UTF-16,
JS-compatible whitespace and slicing behavior, unknown/duplicate JSON keys,
raw tag values, ordering, defaults and type contracts. These are source parity
cases, not 1,774 independent features.

The existing expressive source corpus (1,932 cases) and the separate credit
fallback corpus (276 cases) are prior behavior checks and are reported
separately; do not add those counts to claim unique behavior. The new capture
also stays separate from the frozen TypeScript inventory: the accepted pet
change is outside the 806-file baseline. There are 19 TypeScript snapshots in
the dimabot baseline archive (separate from the seven retired worker sources
archived earlier), and 787 current TypeScript files including six excluded
email templates. The two external pet files (`speech_text.ts` and its test)
remain source obligations beyond that baseline. Their pure helper behavior is
covered locally here, but those TypeScript files have not been retired and
callers have not adopted Rust. The captured `runtime.ts` feature delta is a
separate open runtime obligation. These inventory counts are not a migration
percentage.

JSON configuration represents ordinary JSON data. It does not emulate
executable getters, JavaScript prototypes, inherited hooks, or arbitrary
application objects. Exact source UTF-16 results are compared as code units,
not through a lossy Serde `String` projection.

## Verification and performance

Initial Node run `node-1793245222810847343` generated and checked all 1,774
new cases, verified 15 source hashes, and checked the existing 1,932 expressive
and 276 credit-fallback cases. Final Node run `node-1793245647083747340`
checked the new corpus and byte-identical benchmark inputs; the final Rust
compiler run replayed the new and existing source fixtures. The post-run receipt
`node-1793245911101986999` passed validation of both benchmark reports and
exact input bytes. Final source SHA-256 is
`0f6d2b024c6333461e6bd007512f798d64f09fbcb72629c631866bef9ae0dbd4`.
Compiler candidate `compiler-1793245700167727814` passed 129 ordinary, eight
explicit, and one release-benchmark execution (138 total), formatting,
standalone TTS all-target check and strict Clippy, all-features all-target
check and strict Clippy, and no-default-features check. It took 172.817 seconds
for the script and 180.379 seconds total. The private build cache peaked at
7,972,892,672 bytes and minimum available memory was 9,881,964,544 bytes.
The compiler used six CPUs, a 4 GiB memory limit with no swap, 256 PIDs, and
two Cargo jobs.
Formatting run `1793245578220634221` passed and formatted one Rust file; the
final formatting check passed after a mechanical drain fix. The first Node
run and first compiler candidate are retained in the evidence pack for the
before/after comparison.

The initial benchmark source SHA-256 was
`f7fef45ae7e42ce9ff4de21ffe30cbad6b72b5a7a6cca4846a5c7ef9d17e91d4`; final
source SHA-256 is shown above. The prepared ten-workload benchmark input SHA-256
is `0b64cdffa9c43c3e1f0545beed6e64a49727eca2df06ad0d7e4558325d9b895a`.
Node used seven samples and 100 warmups per workload; each timed operation
includes only the prepared function and a checksum over every returned UTF-16
unit. Input generation, JSON, I/O, fixture setup, and provider/network work are
outside the timed section. Rust's TTS feature profile does not include the
optional `sha2` dependency, so the benchmark driver independently verifies
the exact input digest before and after execution. The initial and final
matched-run per-workload elapsed-time medians (microseconds per operation) are
below. Each row is a local fixture result; the table makes no claim about
general workloads or statistical significance. The optimization changed only
the ill-formed UTF-16 normalization branch; UTF-8 code was unchanged, so its
timing variation is not attributed to that change. Links and large UTF-8 are
treated as parity at about 1%, not as wins. No CPU, RSS, provider, Twitch, or
production-performance claim is made here. The earlier expressive-TTS
baseline and optimized comparisons, including the original five filter
regressions and the final three remaining regressions, remain in the
[expressive TTS record](expressive-tts-2026-10-29.md).

| Workload | TypeScript initial | Rust initial | TypeScript final | Rust final | Final interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| ASCII | 1.1376932 | 0.6473096 | 1.3216146 | 0.7501501 | Rust lower elapsed time |
| Unicode | 0.9899544 | 0.7417686 | 1.1144505 | 0.7068071 | Rust lower elapsed time |
| Large UTF-8 | 48.668886 | 44.251883 | 41.252875 | 40.825725 | Parity, about 1% difference |
| Lone surrogate | 0.9002494 | 0.4750479 | 1.2871381 | 0.1945615 | Rust lower elapsed time |
| Emotes | 4.2192975 | 2.4361684 | 3.4236832 | 2.0052573 | Rust lower elapsed time |
| Links | 1.7594198 | 2.1878533 | 2.0189268 | 1.9944820 | Parity, about 1% difference |
| Whitespace controls | 0.6592508 | 0.7298071 | 0.6506938 | 0.4222699 | Rust lower elapsed time |
| Pet, Fish | 6.8591234 | 4.6197738 | 6.7906803 | 4.5323440 | Rust lower elapsed time |
| Pet, Piper | 6.2907368 | 4.1726642 | 5.8770217 | 3.6657787 | Rust lower elapsed time |
| Pet, large | 194.525525 | 84.433801 | 180.610318 | 87.778075 | Rust lower elapsed time |

There are no final median regressions: eight workloads have lower Rust elapsed
time, while large UTF-8 and links are near parity. The initial Links and
Whitespace controls regressions remain in the table. Timing variation between
the initial and final Node samples amplifies or changes some ratios, and no
generalized speedup or significance claim follows.

The reported production read-only fingerprint was
`50903c6a12f924a8fa842db591bb68472fe98c522309d790a03743714add3536`, with
all 19 records unchanged. This work made no production mutation. The evidence
index is at
[`evidence/2026-10-29-tts-lossless-normalization/README.md`](evidence/2026-10-29-tts-lossless-normalization/README.md).

## Migration and adoption status

This closes local native feature coverage for the three lossless utility entry
points and the pure pet text composition helper, with their required local
dependencies. No Cargo manifest/lockfile, dependency, default feature, or
worker profile changed. It does not complete the pet runtime dependency chain:
the application-specific settings/emote lookup, queue, cancellation,
persistence, billing, and runtime integration remain open. The TypeScript
source is still present and callers have not adopted the native helper. This
slice retired no source; no source count change, dependency completeness,
migration percentage, deployment, or push is claimed.
