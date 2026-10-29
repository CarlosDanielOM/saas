# TTS usage pricing and emote bootstrap — 2026-10-29

## Scope and status

This change adds a shared pure pricing implementation at
`dimabot/src/utils/tts/usage.rs`, re-exported through both
`utils::tts_usage_pricing` and `utils::credit_policy`. It also adds
`TwitchEmoteRuntime` to `utils::twitch_emotes` so callers can request emote
data without first constructing a connected Redis manager. This is a local
library slice. It does not retire a TypeScript source file, complete TTS usage
tracking, or establish dependency-complete migration or caller adoption.

The final source snapshot SHA-256 is
`64984e28f5d64d8b61e99aacc24d868a14c841fa35e0e245d93c1caa7908ad92`. The
emote runtime and shared-pricing commits are `92e1804d6a65b8c5e5cf44076d51d614285de9f3`
and `7ea5904e91eca9314f8c914c60ba3cbf212f555e`; the bounded rounding
optimization is `7dfd1c8637574ba0ec1bc129880b95966cef6923`. Final source,
compiler, Node-oracle, benchmark, and cleanup evidence is indexed in the
[evidence summary](evidence/2026-10-29-pricing-emote-bootstrap/verification-summary.json).
The final manual readback confirmed all 19 production records unchanged and no
task-owned containers, networks, or volumes remaining. No deployment or push
occurred.

## Pricing source and reuse

The prior `credit_policy.rs` already owned `calculate_tts_usage` and its
JavaScript-compatible rounding. The new `tts_usage_pricing` module makes that
same calculation reusable by the TTS utilities; it consolidates the existing
pricing rule rather than porting a newly retired implementation. Its result
retains the four fields `characters`, `creditsConsumed`, `polarshCost`, and
`costUsd`. The provider string remains case-sensitive; recognized providers
retain their existing per-character formulas, prototype-name keys map to zero,
and unknown names use the ordinary fallback. The implementation shares
JavaScript rounding with credit-pack calculations. Conditional Serde support
and the TTS lossless-JSON serializer preserve the appropriate feature-specific
representations.

The source oracle and tests cover pricing cases, including floating-point and
provider edge cases, while the benchmark compares prepared calculation plus a
scalar checksum of all four result fields. The scope excludes JSON encoding,
setup, tracking, and I/O. All 1,738 generated source cases passed the Rust replay under
Node 24.22.1 / V8 13.6.233.17-node.58 / TypeScript 5.9.3.

The baseline benchmark uses six workloads, 32 prebuilt inputs per pool,
262,144 operations per sample, seven samples, and 100 full warm-up passes
(26,214,400 warm-up operations per workload). In the normal Node CommonJS
realm, the same actual TypeScript module is transpiled; unused tracking imports
throw if called. Source parity is compared against an isolated VM outside the
timing loop. The same-realm input SHA-256 is
`83ac085b3541474db906d8808923518168303d6ad1f96f8eea83158af62eddbe`.

The baseline medians in microseconds per operation (TypeScript / Rust) were: Piper
`0.035337 / 0.032805`; Fish `0.029115 / 0.029778`; Kokoro `0.025139 /
0.044152` (Rust 1.7563× slower); unknown provider `0.030647 / 0.031663`;
inherited provider key `0.262403 / 0.019057`; mixed inputs `0.096947 /
0.026842`. The roughly 7% Piper and 2–3% Fish/unknown differences have
overlapping ranges and should be treated as near parity/noise. Keep the Kokoro
regression visible. These are prepared calculation plus scalar checksum
measurements, excluding JSON, setup, tracking, and I/O. They do not establish
full-application latency, CPU/RSS, production throughput, or causality.

The final Rust medians in microseconds per operation (TypeScript / Rust), using
the identical Node timings, harness, workload definitions, and input SHA-256,
were: Piper `0.035337 / 0.034632`; Fish `0.029115 / 0.026358`; Kokoro
`0.025139 / 0.029733`; unknown provider `0.030647 / 0.028256`; inherited key
`0.262403 / 0.019475`; mixed inputs `0.096947 / 0.026688`. Kokoro improved
32.66% against its prior Rust baseline but remains 18.27% slower than TypeScript.
Keep this regression visible. Piper, Fish, and unknown-provider differences
have overlapping seven-sample min/max ranges and remain near-parity/noise; do
not call them general speedups. The mixed pool includes unknown and prototype
keys and does not establish a production traffic distribution. These results
measure only prepared pure pricing plus the four-field scalar checksum, with
no JSON, I/O, billing, CPU/RSS, or full-application behavior. The exact-floor
helper uses bounded integer conversion; no profiler evidence attributes prior
timings to a specific machine instruction or libm call.

The initial isolated-source-VM timing is retained as diagnostic evidence;
paired measurements use the normal Node CommonJS realm. Frozen old source and
fixtures remain preserved in the evidence pack’s
`artifacts/pricing-emote-bootstrap-vm-diagnostic` directory.
No Rust result is reported for that VM setup. The final comparison reused the
same Node fixture, harness, timing method, and input hash; only the changed Rust
helper and its rounding oracle differed from baseline.

The application-level `trackTtsUsage` path remains TypeScript. Its sequential
Redis `HINCR`/`EXPIRE`, logging, local 30-day date behavior, durable Polar or
ledger writes, and PostHog dependency are not implemented by this pure
calculator. Therefore neither `tts_usage.ts` nor the whole TTS usage feature
is migrated.

## Emote runtime bootstrap boundary

`TwitchEmoteRuntime` accepts the existing concrete Redis client, HTTP client,
Twitch token storage, client ID, and endpoint configuration. Construction does
not read environment variables or perform I/O. On first valid request it
lazily obtains a Redis `ConnectionManager`, sends `PING` under a five-second
initialization bound, and caches only successful initialization in a
`OnceCell`. A failed initialization can be retried; shared initialization work
continues if its waiter is cancelled. The separate three-second HTTP/body
bound starts after cache initialization and token/header preparation. The
existing catalog remains responsible for channel/global catalog behavior.

The source fixture adds the global connection-failure case, expanding the
pricing/emote work's source corpus from 65 to 66 cases; the earlier 65-case
corpus remains intact. Runtime replay covers channel connection failure and
global connection failure independently. The existing concrete replay of 57
cases with nine skipped remains a separate accounting set; its integration
checks exercise additional concrete faults and request behavior rather than
making all source cases direct runtime replays.

The runtime provides the missing concrete cache-initialization adapter, but
callers still need to construct the existing token storage and supply
bootstrap, logging, and telemetry integration. No application caller or
runtime selector was changed in this wave. See
[`twitch-emotes-2026-10-29.md`](twitch-emotes-2026-10-29.md) for the catalog's
separate source behavior and prior concrete-adapter evidence.

## Migration accounting

No TypeScript file was retired in this wave. The source inventory remains 21
archived TypeScript files and 785 current TypeScript files, including six email
files (806 total in that accounting). The pricing calculation's earlier
presence in `credit_policy.rs` means this work adds shared exposure and
verification, not a newly retired source feature. Local Rust feature coverage
must be reported separately from total migration completion. TTS usage
tracking and caller/bootstrap dependencies remain open; total migration is
incomplete. No deployment or production cutover is recorded here.

## Verification and operations receipts

Node 24.22.1 / V8 13.6.233.17-node.58 / TypeScript 5.9.3 generated and checked
1,738 pricing cases against raw binary64 fields and serialized wire output.
The 66-case emote source fixture and separate runtime results for channel and
global connection failure passed. The exact-rounding oracle replayed 4,157
`Math.round` raw-bit cases in each standalone credit-policy and TTS-utilities
profile. Both Serde `51.0` and JavaScript wire `51` contracts are preserved.
An initial compiler attempt (`compiler-fixtures-1793250544101522700`) stopped at a test
that incorrectly expected Serde `51.0` to equal JavaScript `51`; the test was
corrected, and the stopped attempt is not counted as a pass.

The verified pre-optimization baseline is preserved: source
`277908b8410485a1363ea8498a1f747f5deb1280ecc65d38980ec3eacd59bcee`, 251
ordinary test executions (overlapping), three explicit fixture executions,
one release benchmark, and its source and benchmark artifacts. For final source
`64984e28f5d64d8b61e99aacc24d868a14c841fa35e0e245d93c1caa7908ad92`, compiler
candidate `compiler-fixtures-1793251319915932834` succeeded in 236.737 seconds
(247.584 seconds total); pre-Node `node-1793251293953198140` succeeded in 4.002
seconds (5.322 total), and post-Node `node-1793251602692898500` succeeded in
4.503 seconds (5.800 total). The compiler passed 254 ordinary test executions
(overlapping, not unique), five explicit fixture executions (catalog and lazy-runtime fixtures,
pricing replay, and rounding replay in each standalone feature),
and one release benchmark. Formatting, standalone credit/emote/TTS all-target
check and strict Clippy, all-features all-target check and strict Clippy, and
no-feature all-target check passed. Both Node passes validated source fixtures;
the post-Node pass additionally checked both benchmark reports. The five explicit fixture executions were: the emote
57-of-66 replay; one lazy-runtime fixture checking channel and global failure
results separately; the 1,738-case pricing oracle; and one 4,157-case
rounding-oracle execution in each standalone credit and TTS profile.

The compiler used six CPUs, 4 GiB memory with no swap, 256 PIDs, and two Cargo
jobs. Final peak private cache was 8,262,352,896 bytes under the 8 GiB cap;
minimum available memory was 9,390,419,968 bytes. Ten stale library test
executables (120,446,976 bytes) in the task-private cache were removed with a
hash journal; this was not a shared-cache cleanup. Final cleanup receipt
[`cleanup.json`](evidence/2026-10-29-pricing-emote-bootstrap/artifacts/pricing-emote-bootstrap/cleanup.json)
confirms all 19 production IDs, images, start times, mounts, commands, and
Compose ownership unchanged; no task-owned containers, networks, or volumes
remain. The acknowledged fingerprint was
`50903c6a12f924a8fa842db591bb68472fe98c522309d790a03743714add3536`. No
deployment or push occurred. The private cache is retained by the parent.
