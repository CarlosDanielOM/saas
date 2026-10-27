# TwitchStreamers pre-port review

Reviewed on 2026-10-27.

Status: the opt-in Rust `TwitchStreamers` directory implementation is present, and its capped source/candidate checks and disposable MongoDB/Dragonfly fixtures passed; see [twitch-streamers.md](twitch-streamers.md). The utility still has no TypeScript caller, worker/service wiring, or production adoption. Mixed legacy writer coordination remains a prerequisite for adoption; library acceptance is not production runtime verification or a performance result.

## Current ownership and reusable work

The TypeScript owner is [`TwitchStreamers`](../dimabot/src/classes/twitch_streamers.class.ts). It reads and writes Twitch account metadata and credentials across MongoDB and Dragonfly, maintains `twitch:accounts` and `streamers:by:id`, hydrates accounts, refreshes OAuth credentials, and identifies streamers in PostHog. The production cached-account-list caller is the stale-connection cleanup loop in [`websocket.ts`](../dimabot/src/server/websocket.ts); it consumes only account IDs. Account deletion calls `updateTwitchAccountsInCache()` after deleting the Mongo user in [`account_deletion.ts`](../dimabot/src/utils/account_deletion.ts).

Reusable Rust library code is present but not adopted by this class:

- [`twitch_tokens.rs`](../dima-rust/src/utils/twitch_tokens.rs) and its [`adapters.rs`](../dima-rust/src/utils/twitch_tokens/adapters.rs) provide opt-in credential lifecycle logic, encrypted-refresh-token compare-and-swap for Mongo writes, conditional cache publication/invalidation, atomic compare-and-delete lock release, and cold-cache reuse of a valid persisted access token.
- [`credential_crypto.rs`](../dima-rust/src/utils/credential_crypto.rs) covers the legacy stored-credential format.
- [`mongo.rs`](../dima-rust/src/utils/mongo.rs) and [`redis.rs`](../dima-rust/src/utils/redis.rs) contain shared connection helpers; callers still supply handles to the token adapters.
- [`posthog.rs`](../dima-rust/src/utils/posthog.rs) includes `StreamerIdentities` deduplication.
- [`otel.rs`](../dima-rust/src/utils/otel.rs) provides a Rust log export pipeline, but not the full TypeScript shared-logger contract.

The plan-cache utility ports the three scripts in [`plan_cache_fence.ts`](../dimabot/src/utils/plan_cache_fence.ts) and two scripts in [`polar_billing_events.ts`](../dimabot/src/domain_events/polar_billing_events.ts); capped source parity and disposable Dragonfly verification passed. It is not connected to this class or any TypeScript caller. See [plan-cache-fence.md](plan-cache-fence.md) for its API, accepted evidence, and limits. The Rust shared logger core and optional Redis/OTEL adapters are also accepted library utilities, not adopted by this class; see [shared-logger.md](shared-logger.md). The token utility itself does not install logger/debug-cache or refresh-all paths. Streamer metadata selection, mapping, query behavior, consumer inventory, and mixed credential-writer coordination remain separate class-port work; the credential utility is not a complete account repository.

See the separate [cache and logger pre-port review](cache-logger-pre-port-review.md) for the wider billing-script protocol, logger sink findings, and optional utility recommendations. The logger and plan-cache selections are now implemented; other cache suggestions remain optional.

## Source-level risks and approved improvements

The following behaviors were reproduced in a prior session using untracked, in-memory transpiled-current-source fixtures with stubbed imports and no network. These are mocked source-level reproductions, not adapter, live-service, or production-runtime proof:

1. A Mongo snapshot can race a cached credential rotation: stale access/refresh tokens can overwrite newer credentials while the newer cached `expires_at` remains.
2. Full DB reload adds account hashes and `streamers:by:id` members but does not evict entries for accounts absent from Mongo. Account deletion relies on that reload.
3. Direct credential revocation updates the account hash but leaves the aggregate `twitch:accounts` permissions stale.
4. Refresh-lock release performs separate GET and DEL operations, so it can delete a replacement owner's lock after the lease changes.
5. A rejected per-instance `cachePromise` remains rejected and is reused instead of retrying client acquisition.

Approved improvements for a future implementation:

- Separate metadata and credential persistence. Use conditional writes against the observed credential version/snapshot so a stale Mongo hydration cannot replace rotated credentials; preserve current plan-fence compatibility.
- Reconcile membership explicitly: remove absent account hashes and IDs, and coordinate invalidation of account-list aggregates with account changes and revocation.
- Use an atomic compare-and-delete unlock. Review the five-second lease against the longest OAuth request, retries, and persistence path; do not retain an unbounded operation under a shorter lease.
- Read access token and expiry together with `HMGET` (or an equivalent atomic snapshot).
- Coalesce same-process refreshes and retain a distributed lock across processes.
- Refresh only the affected account after one account changes, instead of reloading all accounts. Keep work in bounded bulk pipelines.
- Reuse the reconciled ID list for the websocket cleanup caller, which does not need full account objects.
- Extract a shared account mapper and return explicit error results so callers can distinguish missing, stale, and failed reads.
- Sample success logs or make their detail configurable while preserving errors. Write diagnostic records with `SET ... EX` to avoid separate set/expiry calls.

## Waits and retry behavior to preserve or review

The existing pacing has coordination and recovery purposes. Existing `twitch_tokens` callers retain the 5,000 ms refresh-lock default, 150 ms waiter polling, and 4,500 ms waiter timeout; the new directory adapter opts into a 30-second lease with a 25-second under-lock budget plus a 5-second buffer. Waiters attempt one takeover after their wait, and may still return `Busy` while the owner remains active. The TypeScript OAuth utility uses 400 ms and 900 ms retry backoffs. Preserve these purposes during review: waiters poll for another owner's usable token, stop when the lock disappears or the timeout expires, and retries back off after transient OAuth failures. Do not simply remove the waits as a speed optimization. Confirm lease safety against request/retry bounds, and change timings only with tests covering owner progress, waiter recovery, lock expiry, and retry outcomes. The directory's 28-second default operation deadline may cancel the outer wait earlier; cancellation leaves a distributed lease to expire naturally.

## Resume checklist

The library implementation is complete as opt-in source; adoption and validation follow-up remain:

- [x] Plan-cache utility source parity and disposable Dragonfly verification passed. Before class/caller adoption, review mixed-writer compatibility and credential CAS ownership; the utility is not a credential-CAS protocol.
- [x] Verify and accept the opt-in shared logger core/adapters as library code; caller adoption remains separate. Keep OAuth diagnostic wiring usable without exposing credentials.
- [x] Map current class methods and callers; record the fixture's inventory limits, metadata queries, plan-cache reuse, and ID-only websocket consumer in [twitch-streamers.md](twitch-streamers.md).
- [x] Implement the opt-in directory/metadata APIs and reuse `StreamerIdentities` where semantics match; see the new migration record.
- [x] Complete capped exact-source/candidate checks, parity/race cases, disposable MongoDB/Dragonfly adapter fixtures, and cleanup. See [twitch-streamers.md](twitch-streamers.md) and retained acceptance artifacts; no deployment or caller adoption occurred.
- [x] Exercise ID-list late membership, aggregate revocation/rotation, 16 independent cold point reads, completed-flight replacement, guarded refresh takeover, and bounded orphan scanning. Native adapter fixtures also confirmed matching non-hash cache keys remain untouched.
- [ ] Coordinate all mixed TypeScript/Rust writers for credentials, permissions, metadata, billing plan fences, account membership, and deletion before any caller adoption. MongoDB and Redis mutations are not a transaction; legacy writers do not participate in Rust CAS.
- [ ] Integrate explicit error mapping for callers; cover websocket ID-only cleanup and deletion reconciliation, then decide caller/service wiring separately.
- [x] Keep production adoption and performance reporting separate from library validation; acceptance changed no callers/services and supports no runtime speedup claim.

## Source references

- [`TwitchStreamers` class](../dimabot/src/classes/twitch_streamers.class.ts)
- [`plan_cache_fence.ts`](../dimabot/src/utils/plan_cache_fence.ts)
- [`logger.ts`](../dimabot/src/utils/logger.ts)
- [`tokens.ts`](../dimabot/src/utils/tokens.ts)
- [`account_deletion.ts`](../dimabot/src/utils/account_deletion.ts)
- [`websocket.ts`](../dimabot/src/server/websocket.ts)
- [`Rust Twitch token utility`](../dima-rust/src/utils/twitch_tokens.rs)
- [`Rust token adapters`](../dima-rust/src/utils/twitch_tokens/adapters.rs)
- [`Rust credential codec`](../dima-rust/src/utils/credential_crypto.rs)
- [`Rust PostHog helper`](../dima-rust/src/utils/posthog.rs)
