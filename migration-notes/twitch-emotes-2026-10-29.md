# Native Twitch emote catalogs — 2026-10-29

## Scope and status

This opt-in Rust library slice ports the two TypeScript entry points
`src/utils/twitch_emotes.ts` and `src/utils/tts/emote_names.util.ts` to
`utils::twitch_emotes::TwitchEmoteCatalog`. The native service provides
channel catalog lookup and merged TTS emote names using the existing concrete
Redis token/cache and Twitch HTTP implementations. It is not a trait-only host
boundary: callers supply a connected Redis `ConnectionManager`, an
`Arc<TwitchTokenStorage>`, an HTTP client, client ID, and endpoint configuration.
The opt-in `twitch-emotes` Cargo feature uses existing dependencies; it adds no
crate, lockfile, default-feature, or worker-profile change.

Local source coverage and capped compiler/runtime verification passed against
frozen source snapshot SHA-256
`bd42a52ec305f8d35d0797b75f1d4f9404873b960783cc8516a44cc792fbe503`.
Application callers have not adopted the API, so this does not complete
caller/bootstrap migration, deployment, or total migration completion.

## Source behavior and native boundary

Channel lookup validates decimal channel IDs, reads
`twitch:{channel}:emote-catalog:v1`, validates cached rows, and honors the
source's hour refresh, 24-hour display validity, and one-minute retry windows.
Successful Helix results are cached for 24 hours. On fetch failure, the prior
catalog is retained when possible and retry is delayed; cache write failure
returns the source's early unavailable result. Channel requests never fall
back to global emotes. The global-name cache uses
`twitch:global:tts:emotes`, with one-hour success and one-minute failure TTLs.
Global names precede channel names and duplicates are removed in insertion
order.

The port uses the existing concrete `TwitchTokenStorage::acquire_token`,
`build_headers`, Redis `ConnectionManager`, and `reqwest::Client`; token
acquisition/building headers precedes the three-second HTTP/body deadline, as
in the source. Helix is attempted once. Per-key singleflight shares in-progress
work; leaders continue if a waiter is cancelled, map entries are removed when
work completes, and no I/O lock or ready-work sleep was introduced. Cache TTLs
are retained because they bound future validity and retry timing, not to pace a
worker loop.

`EmoteClock` supplies wall-clock milliseconds because token storage's
whole-second clock is not suitable for catalog age/retry comparisons. The
Gregorian ISO date helper reuses local arithmetic instead of pulling in an
unrelated date-domain feature graph. Ordinary JSON cache values preserve extra
properties; `checkedAt` values such as numeric `0` and array `[2020]` are
accepted when they pass the source's `Date.parse` validation. Date parsing
follows ordinary JavaScript coercion, and wire object key order is preserved.
The native JSON boundary intentionally excludes executable hooks and custom
prototypes. Native safety improvements cap response bodies at 16 MiB
and JSON nesting at 128 levels; these are explicit native resource bounds, not
source limits.

## Source replay and focused verification

The native implementation commit is
`c96ce06ec4f01f2223a632e60710b0372db96e4e`. The actual-source reference is
`tests/fixtures/twitch_emotes_reference.cjs`;
the actual-source and concrete-adapter suite is `tests/twitch_emotes.rs`, gated
by `twitch-emotes`. The fixture corpus is generated from the two TypeScript
sources. It exercises cache acceptance and repair, stale/failure behavior,
global and channel composition, Redis command faults, token/OAuth paths,
HTTP/body failures and deadlines, and concurrent requests. Runtime checks use
the task's disposable Redis/Mongo and loopback HTTP/OAuth fixtures. Candidate
`compiler-fixtures-1793248206114963870` passed 244 ordinary test executions
(115 Twitch-emotes library executions, including six new module tests, and 129
TTS regression executions) plus 11 explicit executions (one concrete emote
integration and ten TTS source fixtures): 255 executions total, not unique
behavior count. Formatting, standalone emotes and TTS all-target check/strict
Clippy, all-features all-target check/strict Clippy, and no-feature all-target
check passed. The candidate took 123.093 seconds for the script and 133.108
seconds total. It used six CPUs, a 4 GiB memory limit with memory-swap also
limited to 4 GiB (no swap), 256 PIDs, and two Cargo jobs; its private cache
peaked at 8,280,543,232 bytes under the 8 GiB cap, with
minimum available memory of 9,206,849,536 bytes. Two intermediate test-only
issues (a Redis argument borrow and redundant closure) were fixed before this
passing candidate.

The source replay directly covered 57 of the 65 generated emote cases. The
eight cases not directly replayed comprise seven injected failures (fetch,
header, Redis GET/SET, connection acquisition, global Redis GET/SET) and the
source Promise-identity case. Separate concrete checks covered Redis GET/SET
faults, OAuth 400/header handling, a real loopback TCP close during fetch, 12
concurrent followers sharing one catalog/provider HTTP request after the first
waiter was cancelled, two pooled requests on one connection, 300 ms token
acquisition ahead of a 150 ms HTTP/body timeout budget, the 16 MiB body and
depth-128 limits, and the 60-second retry clock. Source wire output, SET bytes,
and TTLs were checked. Singleflight map cleanup was covered by the sixth
native module test and future-clock retry; Promise identity itself was not
asserted. Connection acquisition remains outside the catalog constructor
because the caller supplies the connected manager.

The library API obtains a connected cache handle from its caller before the
catalog constructor is called. Consequently, cache connection acquisition
failure handling belongs to the caller/bootstrap path; the catalog itself
handles Redis command failures according to the source behavior. Source callers
still have to adopt this concrete initialization path; the native module does
not recreate a TypeScript fallback. No production cache, credential, queue, or
service is part of these checks.

The combined source, compiler, and cleanup evidence pack is indexed at
[`evidence/2026-10-29-emotes-normalizer-retirement/README.md`](evidence/2026-10-29-emotes-normalizer-retirement/README.md).

## Migration and adoption boundary

This closes local native feature implementation and tested concrete
Redis/token/header/HTTP adapter behavior for the channel catalog and
global/channel TTS emote-name composition. No runtime selector or application
caller was changed. Source callers still use the TypeScript utilities until
separately integrated, including bootstrap/cache-connection acquisition. This
does not establish caller adoption, full application dependency-chain
completion, production cutover, or a migration percentage. No benchmark was run
for this API, and no matched HTTP performance claim is made; prior TTS
benchmark figures are unchanged and are not repeated here. The acknowledged
read-only production fingerprint
`50903c6a12f924a8fa842db591bb68472fe98c522309d790a03743714add3536` was
unchanged across the 19-record checks; this work made no production mutation.
The task-owned candidate containers and private fixture network were removed.

## Follow-up shared-runtime bootstrap

The 2026-10-29 pricing/emote wave adds a separate lazy concrete Redis
initialization wrapper around this catalog: it accepts an unconnected Redis
client, connects and pings on first valid request under a five-second bound,
and caches only successful initialization. The paired source oracle now has
66 emote cases, including a global connection-failure case; the baseline
candidate replayed the existing concrete 57-of-66 catalog corpus separately
from the two runtime initialization failure-result checks. This wrapper fills
the cache initialization boundary while caller-owned token-storage
construction, bootstrap, logging, telemetry, and application adoption remain
open. See [TTS pricing and emote bootstrap](tts-pricing-emote-bootstrap-2026-10-29.md)
for final pricing/emote source, compiler and cleanup receipts. Final source
`64984e28f5d64d8b61e99aacc24d868a14c841fa35e0e245d93c1caa7908ad92` passed
the actual-source and runtime fixtures, and the final cleanup receipt confirms
19 unchanged production records and removal of all task-owned containers,
networks, and volumes. The pricing benchmark does not measure emote API or HTTP
performance. Application caller adoption remains open.
