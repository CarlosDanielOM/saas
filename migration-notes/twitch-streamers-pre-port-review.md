# TwitchStreamers pre-port review

Reviewed on 2026-10-27.

Status: approved source improvements recorded; both the plan-cache fence and shared logger are accepted as opt-in Rust library utilities, but neither is connected to this class or TypeScript callers. The Rust `TwitchStreamers` class port remains a separate task pending its consumer inventory and mixed credential-writer review. Do not describe this review as a class port, production runtime verification, or production performance result.

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

The existing pacing has coordination and recovery purposes. The Rust token utility currently uses a 5,000 ms refresh-lock lease, 150 ms waiter polling, and a 4,500 ms wait timeout. The TypeScript OAuth utility uses 400 ms and 900 ms retry backoffs. Preserve these purposes during review: waiters poll for another owner's usable token, stop when the lock disappears or the timeout expires, and retries back off after transient OAuth failures. Do not simply remove the waits as a speed optimization. Confirm lease safety against request/retry bounds, and change timings only with tests covering owner progress, waiter recovery, lock expiry, and retry outcomes.

## Resume checklist

The class port is a separate task. Its remaining review work includes:

- [x] Plan-cache utility source parity and disposable Dragonfly verification passed. Before class/caller adoption, review mixed-writer compatibility and credential CAS ownership; the utility is not a credential-CAS protocol.
- [x] Verify and accept the opt-in shared logger core/adapters as library code; caller adoption remains separate. Keep OAuth diagnostic wiring usable without exposing credentials.
- [ ] Inventory every TypeScript writer of Twitch account credentials, permissions, metadata, `twitch:accounts`, and `streamers:by:id`; coordinate mixed-writer compatibility before rollout.
- [ ] Map current class methods and all callers. Keep metadata queries/mapping and plan-cache behavior in scope; use `StreamerIdentities` where its semantics match.
- [ ] Add deterministic tests for stale Mongo snapshot vs. token rotation, revocation vs. aggregate cache, removed-account eviction, concurrent refresh coalescing, replacement-lock ownership, lease expiry during slow OAuth/retry, invalid/missing credentials, client acquisition retry, and mapper/error behavior.
- [ ] Test the websocket ID-only cleanup path and account deletion reconciliation. Verify parity for plan tiers, permission flags, encrypted credential envelopes, expiry handling, and PostHog rename deduplication.
- [ ] Run exact-candidate checks with disposable fixtures and no production data or external OAuth calls. Report runtime/performance evidence separately; this review makes no production speedup claim.

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
