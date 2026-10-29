# PostHog payload performance follow-up — 2026-10-29

Status: **VERIFIED LOCAL FOLLOW-UP**. The payload and number-correction source
is locally committed; all listed candidate checks passed. No TypeScript caller
adoption, deployment or push occurred. This is a scoped local feature
improvement, not completion of the broader Rust migration.

## Shared changes and correction history

The frozen candidate reuses existing shared code across PostHog and its
consumers:

- `JsString` supports borrowed static literal keys and enum text while
  retaining owned behavior for dynamic strings.
- PostHog payload builders use stack arrays and one generic usage assembler for
  plain JSON and typed native sources, avoiding temporary pair vectors and
  cloned intermediate usage/context objects.
- Compact JSON writing skips the reference sort only when it proves every key
  is nonnumeric; the established stable sort remains for canonical array-index
  keys.
- The shared number formatter uses the existing `serde_json` shortest-digit
  seed, plus a guarded exact-integer fast path. This corrects a pre-existing
  Rust `Display` versus JavaScript/V8 decimal tie difference.

The first Rust formatter candidate had 53 differences against the pinned
35,464-input engine corpus (51 ordinary and two scientific). A bounded parent
diagnostic showed that the exact original formatter from commit `77141415`
reproduced the same 53, while changing only the shortest-digit seed to the
existing `serde_json` serializer yielded zero differences on that corpus. The
corrected candidate then passed the reported full replay. It is the corrected
seed, not the first candidate, represented by the current benchmark source.

The first prepared-payload Rust candidate improved five of six pool medians,
but its AI-usage median remained 5.8423 µs/op versus TypeScript at 5.5308
µs/op. The current candidate's measured median for that pool is 4.4275 µs/op.
The separate failed 53-case number-formatting attempt is recorded above; neither
failure is hidden by the current candidate measurements.

## Matched prepared-payload benchmark

The comparison uses six pools of 32 prepared inputs, 32,000 warmups, seven
trials, 256,000 operations per regular pool and 32,768 operations for
`tts-large`. All 192 source payloads/wires and checksums were validated before
timing. The input SHA-256 is
`bd4d96286803589f2771115afce87fcbdc175df69f1c77866c1a7f306ac771f1`.
The original TypeScript 42 trials were reused byte-exactly after an audited
four-native-hash-only rebind; there was no workload or harness change and no
Node timing rerun.

| Pool | TypeScript median µs/op | First Rust median µs/op | Current Rust median µs/op | Current median time vs. TypeScript |
|---|---:|---:|---:|---:|
| command | 2.4724 | 2.8084 | 2.2374 | 9.5% lower |
| tts | 3.1488 | 3.8980 | 2.8337 | 10.0% lower |
| ai-usage | 5.5308 | 10.3777 | 4.4275 | 19.9% lower |
| ai-operation | 4.5832 | 5.3293 | 3.8241 | 16.6% lower |
| tts-unicode | 4.4724 | 3.9722 | 3.0573 | 31.6% lower |
| tts-large | 62.7729 | 10.1350 | 8.7888 | 86.0% lower; 7.142x TS/Rust |

The command trial ranges overlap (TypeScript 2.3773–2.5352, current Rust
2.1681–2.6258 µs/op), so its 9.5% lower median time is descriptive; no
statistical-significance claim is made. The other five current Rust sample
ranges do not overlap the corresponding TypeScript ranges. The large-payload
ratio is 7.142x by median. These results measure prepared builders, ordered
JSON serialization and UTF-8 checksum only. They exclude context/input
preparation, SDK metadata, queueing, HTTP and database work, and provide no CPU,
RSS, end-to-end application or production-latency claim.

The independently read-back [evidence package](evidence/2026-10-29-posthog-payload-performance/README.md)
contains the [verification summary](evidence/2026-10-29-posthog-payload-performance/verification-summary.json),
[comparison and raw medians](evidence/2026-10-29-posthog-payload-performance/artifacts/current-benchmark-comparison.json),
[comparison chart](evidence/2026-10-29-posthog-payload-performance/artifacts/current-payload-comparison.html),
[source binding](evidence/2026-10-29-posthog-payload-performance/source-binding.json),
[prior-candidate bindings](evidence/2026-10-29-posthog-payload-performance/prior-candidate-source-bindings.json),
[numeric corpus immutability proof](evidence/2026-10-29-posthog-payload-performance/artifacts/numeric-corpus-immutability.json)
and [final readback](evidence/2026-10-29-posthog-payload-performance/artifacts/final-readback.json).
The package contains 157 files (14 MiB); 156 indexed blob hashes and 70
decompressed artifact hash/length checks passed. The binding records all 1,269
inputs against source commit
`beda3aee1ea2d7a2d42b4b666c6dcb2c3c2ef403` and ten SDK reference hashes. The
numeric proof confirms all 35,464 raw inputs, group labels and String/JSON
expectations are byte-equivalent; only metadata and native formatter/test
sources changed.

## Validation and scope status

Parent-reported completed checks:

- Formatting receipt `format-1793271353735859186`.
- Numeric oracle generation/check `node-1793271430176465107`.
- Strict all-target/all-feature Clippy and four numeric tests, including the
  35,464-case engine replay: `compiler-1793271500335662854`.
- Refreshed source oracles: `node-1793271651768855999`.
- Focused/source plus benchmark verification: `compiler-1793271803631923800`.
- All five receipt timezone checks; TTS source, settings and pricing checks;
  and real-Redis producer/projection checks.
- Broad shared-consumer suite `compiler-fixtures-1793271955861772133`: 392
  reported executions across 45 result groups (not 392 unique cases), with 228
  library results plus selected ordinary/integration checks, five receipt
  timezone runs, source replays, Redis producer/projection, emote runtime and
  no-default/all-features check plus Clippy. Script time was 502.85 s and phase
  time 514.456 s; peak private cache was 8,127,803,392 bytes, minimum available
  memory 9,385,828,352 bytes, and 19 production records were unchanged.
- Final Node checks `node-1793272491713187942` passed in 63.524 s (64.783 s
  phase), including the official benchmark check, numeric corpus replay,
  refreshed source fixtures and five-timezone Mongoose fixtures. Application
  schema checks covered 11 models/70 cases, then 31 models/194 cases; keyword
  hydration covered 10 pairs.
- Scoped numeric consumer run `compiler-1793272783195663615` passed 19 reported
  executions across ten result groups: five ordinary schema/domain/keyword
  targets plus 80 Mongoose cases × three checks per timezone across five
  timezones. Script time was 13.208 s and phase time 20.696 s; peak cache was
  8,055,070,720 bytes, minimum available memory 10,330,492,928 bytes.

The emote actual-source log recorded `source_replayed=57` and
`source_skipped=9` out of the current 66-case corpus. The earlier corpus had 65
cases before a global-connect case was added. This is not a 66-case replay or
65-case full coverage. Bootstrap runtime checks cover separate cases, while
the skipped/unexecuted cases remain explicit.

## Resource-guard attempts and status

Not every attempt stayed below the private-cache limit. The parent stopped
`compiler-1793272574138954149`, an overly broad all-features runtime compile;
this was a resource-scope stop, not an application test failure. Scoped attempt
`compiler-1793272670378243591` hit the 8 GiB cache guard at 8,591,220,736 bytes,
1,286,144 bytes above the monitoring threshold; no test results passed in that
attempt. The parent removed only 579,760,128 bytes of completed task-private
debug test ELFs, then retried against unchanged source; the scoped run above
passed. Earlier failures and cleanup evidence are retained in the evidence
package.

The numeric correction and four-file payload change were committed locally as
`b58fa296` and `beda3aee`; no push or deployment occurred. This verifies the
local PostHog payload path and its scoped shared consumers. It does not establish
100% feature or whole-migration coverage: local worker/logger/Qdrant/raid
formatter copies were not changed, and deployed worker profiles do not enable
this shared formatter. No TypeScript caller was retired or adopted. Production
readback found all 19 records unchanged and no task-owned containers, networks
or volumes remaining.

Local feature verification, whole-migration completion and deployment status
are separate. The broader Rust migration remains incomplete, and this work
changed no production behavior.
