# TwitchStreamers whole-source behavior parity

Reviewed 2026-10-27. This record expands the earlier 16-case metadata mapping check into a differential source oracle for the current public TypeScript class. It compares the actual TypeScript implementation in a closed VM with mocked MongoDB, Dragonfly, OAuth, logger, and identity providers against the Rust behavior fixture. This is source-level parity evidence for represented scenarios, not exhaustive class parity or production integration.

## Method coverage map

The TypeScript owner is [`TwitchStreamers`](../dimabot/src/classes/twitch_streamers.class.ts). Its seven public behavior methods map to these Rust entrypoints:

| TypeScript method | Rust counterpart(s) | Behavior represented in the differential cases | Parity boundary |
| --- | --- | --- | --- |
| `getTwitchAccountsFromCache()` | `TwitchStreamers::accounts_from_cache()` | Legacy aggregate read, per-hash fallback, empty list, malformed aggregate, orphan exclusion, plan-stale retry, and cache read failure. | Rust validates membership, markers, credential tuples, revision, and plan fences in one bounded snapshot; TypeScript retries twice then returns `[]`. Rust returns typed errors. |
| `getTwitchAccountsFromDB()` | `TwitchStreamers::reconcile()` | Mongo listing, metadata/cache publication, current credential preservation, absent-account cleanup, query failure, and identity requests. | Rust reconciliation is paged, leased, resumable, and reports counts/errors. TypeScript's reload deletes the aggregate then loops all Mongo users; it does not reconcile absent hashes/IDs. This is an approved behavior improvement. |
| `getTwitchAccountById(id)` | `account_by_id()`, `refresh_account()` | Cache hit, cold hydration, missing account, plan-stale hydration, cache failure, Mongo failure, and read after reconcile. | Rust distinguishes missing/stale/busy/failure. TypeScript catches failures and returns `null`. Hydration now uses generation/snapshot publication fences. |
| `getTwitchStreamers()` | `streamer_ids()` | ID enumeration, deterministic comparison, empty index, and cache failure. | Both read the ID index; Rust validates index membership against the observed directory version and returns typed errors. |
| `updateTwitchAccountsInCache()` | `reconcile()` | Delegation to full refresh, success and store failure. | TypeScript returns `undefined` on success and `null` on failure; Rust returns a reconciliation report or typed error. |
| `getAccountTokenById(id, account_type)` | `account_token()` (with `twitch_tokens`) | Twitch/Kick token freshness boundaries (301/300/299 seconds), missing token/expiry, cold usable/expired credentials, permissions, lock owner/waiter/takeover/busy, OAuth transient and revocation outcomes, and persistence/cache failures. | Rust uses the shared token lifecycle and explicit caller context. Its lock/deadline policy intentionally differs from TypeScript's 5-second lease. Kick refresh is unsupported in both paths. |
| `getAccountRefreshTokenById(id, account_type)` | `refresh_token()` | Twitch/Kick stored refresh-token read, cold/partial credential hashes, revocation tombstones, and cache failure. | This API returns the stored refresh credential; it does not rotate OAuth credentials. Rust reports typed errors; TypeScript returns `null` for missing/error cases. |

The Rust API details are in [`twitch_streamers.rs`](../dimabot/src/classes/twitch_streamers.class.rs); credential lifecycle behavior is in [`twitch_tokens.rs`](../dimabot/src/utils/tokens.rs). The differential fixture also invokes selected operations repeatedly to cover identity deduplication/rename and compares observable state, credentials, IDs, OAuth requests, logs, and identity requests. Those extra scenarios support the method mapping but do not establish complete integration compatibility.

## Fixture and evidence scope

The source oracle is [`twitch_streamers_behavior_reference.mjs`](../dimabot/tests/fixtures/twitch_streamers_behavior_reference.mjs), which loads the current TypeScript source files and injects fully mocked providers. [`twitch_streamers_behavior.json`](../dimabot/tests/fixtures/twitch_streamers_behavior.json) records the matched cases and explicit behavioral differences; [`twitch_streamers_behavior.rs`](../dimabot/tests/twitch_streamers_behavior.rs) consumes that fixture from Rust. The reference runs with `TZ=UTC`, a closed import allowlist, and fixture-only credentials. It does not create sockets, load application/environment clients, or call real OAuth/PostHog services.

The corpus contains 66 named scenarios: 31 exact matches and 35 explicit differences. Exact matches use the documented public-value/state normalization; they do not imply identical language-level API types or diagnostic payloads. Those differences include typed API errors, safety extensions, and representation changes; they are not 35 newly user-approved changes. The 66 vectors cover the actual TypeScript class, token lifecycle boundaries, plan-cache interactions, and selected PostHog helpers. One Rust differential test checks all 66 vectors; the full feature suite had 220 successful Rust test executions including doctests, not 220 unique parity cases. The separate static consumer inventory still records 98 call sites; that inventory is a source map, not 98 executed consumer integration cases. Adapter suites use disposable MongoDB/Dragonfly and provide separate evidence for native adapters, but do not turn the source oracle into live-service or cross-process proof. The fixture explicitly excludes real transports, production OAuth, cancellation scheduling, and cross-process Redis atomicity; token transport retries are covered by the separate token lifecycle suite. Do not describe this as exhaustive 100% parity.

### Reproduced regressions and repair status

The source oracle and adapter races exposed three defects that the prior 16 mapping fixtures did not exercise:

- Missing optional expiry caused two observable failures: full-cache validation incorrectly returned `Stale`, and metadata refresh could remove the completion marker and leave subsequent point reads returning `Busy`. Missing expiry is now normalized consistently while remaining optional.
- A partial cached refresh-token hash needs the TypeScript Mongo fallback. The Rust read-only fallback now rechecks cache/generation and returns the persisted secret without overwriting newer access-token state, unknown expiry, or permission flags. Cold cache still seeds credential state.
- Native cold credential publication could bypass directory tombstones, allowing a delayed credential write to restore deleted credentials or membership after native Mongo deletion and cache eviction. Native credential writes and invalidation now use generation-fenced cache operations. Directory metadata publication was already generation-guarded; the defect was in the credential path.

The expanded 66-scenario source oracle passed both generators' deterministic `--check` modes. The capped final Rust quality suite passed all requested profiles, format/check/Clippy/test/doctest steps; the native MongoDB/Dragonfly suite passed in 6.48 seconds and the token adapter suite in 1.25 seconds. Adapter regressions covered missing-expiry reads and metadata refresh, partial-secret read-only fallback, and paused valid and revoked Mongo snapshots racing native delete/evict followed by resumed load publication; neither hash nor index was restored. Six named token lifecycle tests were added, with getter and generation-race variants. Four worker dependency graphs remained byte-identical. The final production fingerprint confirmed all 19 containers unchanged; no deployment or caller adoption occurred. Temporary test resources were cleaned.

Receipts are retained under `/root/.local/state/rust-streamer-parity-20261027-ltnm_3pz/artifacts/`: `quality-receipt.json`, `quality-tests.log`, `quality-adapters.log`, and `acceptance.json`; `snapshot.json` is in the parent state directory. Negative reproductions are `repro-deletion-repro.log`, `parity-repro-behavior-repro.log`, and `native-repro-adapters.log`. The final quality run used 6 CPUs, 4 GiB memory with swap equal to memory (no swap), 256 PIDs, two build jobs, and an 8 GiB private cache cap; minimum available memory was 12,323,217,408 bytes and cache peak was 2,116,947,968 bytes. The 30.215-second warm-cache quality duration is not a benchmark or model-speed result.

## Preserved outcomes, approved changes, and remaining differences

Preserved source outcomes represented by the cases include the free-tier default; UTC English date formatting; Twitch account selection by `(type,id)` within one user; string-valued boolean cache fields; plan-cache version compatibility; valid cached token use and expiry-skew boundaries; Twitch refresh-token fallback semantics; Kick's no-refresh behavior; OAuth transient failure preserving stored credentials; revocation clearing credentials; and identity request behavior for initial load, repeated load, rename, and empty name.

The following changes were approved in the [pre-port review](twitch-streamers-pre-port-review.md):

- Separate metadata and credential owners, so a stale metadata snapshot does not rewrite rotated credentials or permission fields.
- Full reconciliation removes accounts absent from Mongo; point refresh is available for one account.
- ID-only consumers use the membership index, with explicit validation, instead of parsing a serialized full-account aggregate.
- Cache publication, hydration, and destructive eviction use snapshot/generation comparisons; OAuth lock release uses atomic ownership checks through the shared token lifecycle.
- Rust returns explicit typed errors and reconciliation reports instead of mapping cache/database failures to `null`, `[]`, or successful empty results.
- Valid persisted access credentials can be reused on cold cache, avoiding an OAuth exchange and metadata-identity lookup that TypeScript may perform unnecessarily.

Known remaining differences/limits matter for any later caller adoption:

- Rust typed errors and reports require caller-side mapping to the TypeScript `null`/empty/undefined conventions.
- Metadata-only lookup currently delegates through full account lookup/hydration and can load credentials. A metadata reconcile can retain credentialless ID memberships; full account listing may return `Busy` until credentials hydrate. The existing differential case records this behavior and this is not a drop-in bootstrap replacement. Truly partial hashes missing required credential or permission fields likewise remain incomplete until the credential owner repairs them; read-only refresh-secret recovery does not complete that cached tuple.
- Rust DTOs expose known string fields; TypeScript hashes can carry unknown raw fields. Source hydration omits null/zero persisted expiry, while native hydration represents null as empty text and preserves zero as `"0"`; both are treated as unknown or expired by the token freshness check.
- Native bulk operations cover all Twitch accounts for a user, while TypeScript selects the first matching Twitch account in some paths.
- Bounds, deadlines, logging actions, and token lease timings intentionally differ. Optional logger/PostHog integration and the actual application service lifetime are not exercised by the closed VM.
- The 98-call consumer inventory is not integration coverage. No current TypeScript caller adopts the Rust API; mixed metadata, credential, permissions, billing, membership, and deletion writers must coordinate before adoption.
- Custom `TokenCache` implementations default to no generation information; an adapter must implement the generation-fenced credential operations to obtain the native delete/tombstone guarantee. The native Redis adapter provides that guard.

## References

- [Original opt-in library record](twitch-streamers.md)
- [Pre-port review and approved changes](twitch-streamers-pre-port-review.md)
- [TypeScript source](../dimabot/src/classes/twitch_streamers.class.ts)
- [Rust source](../dimabot/src/classes/twitch_streamers.class.rs)
- [Behavior source oracle](../dimabot/tests/fixtures/twitch_streamers_behavior_reference.mjs)
- [Behavior fixture](../dimabot/tests/fixtures/twitch_streamers_behavior.json)
- [Rust fixture consumer](../dimabot/tests/twitch_streamers_behavior.rs)
- [Accepted quality and adapter receipts](/root/.local/state/rust-streamer-parity-20261027-ltnm_3pz/artifacts/acceptance.json)
