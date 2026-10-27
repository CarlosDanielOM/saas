# TwitchStreamers Rust library port

Reviewed 2026-10-27.

## Status and boundary

The Rust directory implementation is present as opt-in library code behind the `twitch-streamers` feature. It has no TypeScript caller, service wiring, worker registration, or production adoption. Construction takes explicit store, cache, credentials, clock, configuration, and optional logger/identity sink; it performs no I/O during construction and installs no background work. This is not a production release or runtime-performance result.

**Original port validation (`7da0a25c`):** accepted opt-in library scope; no production adoption. Frozen source matched its snapshot. Final all-target checks passed with no features, `twitch-tokens`, `twitch-streamers`, and `twitch-streamers-posthog`; Clippy passed with `-D warnings` for `twitch-tokens` and `twitch-streamers-posthog`. Both profile test suites and doctests passed. The directory profile passed 17 new TwitchStreamers unit tests; eight new token-support tests passed in each selected profile. The original library quality log totals 380 successful test executions including repeated profiles and doctests; this is not 380 unique cases. The two disposable adapter suites are additional executions. The original mapping oracle covered 16 metadata cases and inventoried 98 static calls plus six key-owner references; this was not whole-class behavior coverage. The completed follow-up source-oracle and repair evidence is tracked separately in [twitch-streamers-parity.md](twitch-streamers-parity.md). Four existing worker dependency graphs remained byte-identical.

The native adapter suite passed against disposable MongoDB and Dragonfly in 6.43 seconds; the existing token adapter suite passed in 1.22 seconds. Coverage included the counted mock OAuth exchange (40 ms and six-second delay cases), two-service refresh coalescing with exactly one exchange, preflight/no-partial-write behavior, metadata preservation of rotated credentials, membership cleanup, CAS, plan/revocation, NOSCRIPT handling, bounds, and Kick behavior. In the two-service delayed case, the second service arrived 5.2 seconds after the first during a six-second mock exchange; the lease still had about 20–25 seconds remaining and only one exchange occurred. A separate 16-concurrent-call case across two services also used exactly one exchange. No external Twitch HTTP call was made. Source snapshots, test binaries, temporary containers, networks, cache, target, and formatting copy were cleaned; retained state contains the artifacts directory, baseline commit, snapshot, and validator. Receipts are retained under `/root/.local/state/rust-twitch-streamers-20261027-l0jn52dh/artifacts/`: `quality-receipt.json`, `quality-tests.log`, `quality-adapters.log`, and `acceptance.json`. The source manifest is retained at the parent path `../snapshot.json`.

The capped quality run verified 6 CPUs, 4 GiB memory with swap set equal (no swap), 256 PIDs, and two build jobs. Minimum available memory was 10,853,040,128 bytes; private cache peak was 2,765,463,552 bytes, below the 8 GiB cap. Acceptance confirmed all 19 production container IDs, images, start times, restart counts, and health states were unchanged. No service was deployed, and no TypeScript caller or worker profile was changed.

No benchmark or production speedup claim is made. Native Mongo/Redis transport-timeout fault injection was not performed; guard-budget, unknown-outcome, and cancellation behavior was exercised with mocks. External Twitch authorization and service-worker integration remain outside this opt-in library acceptance.

## Source and Rust APIs

The source owner is [`TwitchStreamers`](../dimabot/src/classes/twitch_streamers.class.ts), backed by `UsersSchema`, Dragonfly, the Twitch token helpers, plan-cache Lua fences, logger, and PostHog identity helper. Rust implementation is [`utils::twitch_streamers`](../dima-rust/src/utils/twitch_streamers.rs), with Mongo/Redis/PostHog adapters and the shared metadata mapper in its subdirectory.

| TypeScript behavior | Rust API | Notes |
| --- | --- | --- |
| `getTwitchAccountById` / `hydrateTwitchAccountById` | `account_by_id`, `refresh_account` | Cache read then authoritative Mongo hydration. Hydration is per-key coalesced and fences publication against the observed directory/plan versions. |
| Metadata-only access | `metadata_by_id` | Returns only metadata to the caller, but currently reuses full account lookup/hydration; a cold lookup also loads credentials. It does not avoid credential loading/decryption on that path. |
| `getTwitchAccountsFromDB` / `updateTwitchAccountsInCache` | `reconcile` | Bounded Mongo pages, directory lease, conditional publication, removed-account eviction, and orphan hash sweep. Returns a report or explicit error. |
| `getTwitchAccountsFromCache` | `accounts_from_cache` | Reads indexed accounts in bounded batches and performs one final exact-membership, revision, plan-version, account-marker, and credential-tuple validation. |
| `getTwitchStreamers` | `streamer_ids` | Uses the ID membership index; final validation checks exact set size and every returned ID, catching late membership additions that do not advance the directory revision. |
| Twitch token access | `account_token`, `refresh_token` | `account_token` uses the existing `twitch_tokens` lifecycle and coalesces same-process calls. `refresh_token` returns the stored refresh credential; it does not perform OAuth rotation. Caller context is explicit for diagnostics. Kick supports cached usable credentials only; refresh is unsupported. |
| Reconcile stale cached accounts | `evict_if_absent`, `sweep_orphan_hashes` | Eviction rechecks Mongo absence and compares the observed cache snapshot; orphan sweep is resumable and bounded. |

The plan-cache fence is reused for the billing plan version in `StreamerMetadata`; the directory generation is a separate per-account concurrency fence. Point publication compares the observed account generation and plan fence, but skips the global directory revision so an unrelated account mutation does not force a cold point lookup to retry. Full reconciliation additionally compares the global revision while processing its pages. `twitch_tokens` owns credential reads/refreshes and encrypted-refresh-token CAS. `NativeCredentials::new` configures `TwitchTokenStorage::with_refresh_guard` with a 30-second lease, 25-second under-lock budget, and 5-second buffer. The pre-existing 5-second default in `twitch_tokens` remains unchanged for its other callers. `credential_crypto` handles the legacy stored envelope. Optional `PosthogStreamerIdentities` uses the existing identity deduplicator. The Rust code is not a parallel account source and does not replace billing or credential writers.

## Consumer inventory and integration checklist

The fixture's `consumerInventory` records the static default-import and deferred-import references found in `dimabot/src`. It covers boot-time full refreshes; server and worker refreshes; account/profile and plan reads across commands, handlers, routes, websocket, overlays, and AI memory; token reads in Twitch actions; ID-only enumeration in live/channel and analytics paths; and deletion-triggered refresh. Reflective calls are outside that inventory, so review actual call shapes before wiring. The production stale-connection cleanup in `server/websocket.ts` needs IDs only and should use `streamer_ids`.

Before any caller adopts the Rust service:

1. Define the Rust service lifetime and initialize it only after the application's MongoDB, Dragonfly, Tokio runtime, and Twitch OAuth dependencies are ready. Keep TypeScript as owner until all selected call paths have explicit error handling and parity coverage.
2. Adapt each TypeScript return contract: Rust uses `Result` and distinguishes missing, stale, busy, invalid, and unavailable states; TypeScript commonly catches failures and returns `null`, `[]`, or `null` from refresh. Do not turn a cache/database failure into authoritative absence.
3. Route ID-only consumers to `streamer_ids`; route metadata-only reads to `metadata_by_id`; retain privileged full-account/token access only where needed.
4. Coordinate every writer before mixed-runtime operation. Inventory includes account authorization/token writers in `server/routes/auth.route.ts` and `utils/tokens.ts`; user/account mutations and deletion in `server/routes/user.route.ts` and `utils/account_deletion.ts`; plan-cache mutation/invalidation in `domain_events/polar_billing_events.ts`; and the permission reset script `scripts/invalidate_all_user_permissions.script.ts`. Re-scan for account-array and `accounts:twitch:*:data`, `twitch:accounts`, `streamers:by:id`, refresh-lock, and plan-fence writes at integration time. Key references alone do not prove mutation behavior.
5. Make all credential writers participate in refresh CAS/locking and all metadata, permission, billing, account deletion, and cache writers participate in directory/plan fencing or invalidate/refresh through one agreed protocol. Legacy Mongo/Redis writes are not transactional and do not honor Rust CAS; they can race publication and leave cache state stale. Specifically cover auth/token rotation and revocation, plan changes, permissions, account add/remove, and deletion before enabling mixed callers. The independent global directory revision catches concurrent directory mutations; it does not make MongoDB and Redis a transaction.
6. Exercise websocket ID-only cleanup and account deletion reconciliation with disposable data. Prove concurrent writer races and recovery paths before rollout; the utility's internal guards cannot make uncoordinated writers safe.

## Original mapping contract and deliberate differences

[`twitch_streamers_parity.json`](../dima-rust/tests/fixtures/twitch_streamers_parity.json) contains the TypeScript source hashes, UTC setting, metadata mapping cases, expected string fields, plan version values, consumer inventory, cache-key references, inventory limits, and intentional differences. Its original check covered 16 metadata mapping cases, 98 static call-site inventory entries, and six key-owner references. These counts are not whole-class behavior coverage. The source-backed public-method comparison and its scenario limits are documented in [twitch-streamers-parity.md](twitch-streamers-parity.md).

Preserved mapping behavior includes free as the missing plan default, English UTC `Date#toDateString` formatting, legacy encrypted credential envelope decoding in the token adapter, stringified boolean cache fields, Twitch selection by `(type,id)` in the same account, cache key families, and plan-cache version compatibility. Metadata is explicitly validated, and account objects redact their full contents from Debug output.

ID-list validation atomically checks the directory revision, exact set cardinality (`SCARD`), and membership of every returned ID (`SISMEMBER`). Thus a token adapter's late `SADD` of a new ID, which intentionally does not change the metadata revision, makes the result `Stale`. Full-account aggregate validation additionally checks exact membership cardinality, all memberships, plan fences, the account ID marker, and four mandatory credential fields (`access_token`, `refresh_token`, `has_permissions`, and `up_to_date_permissions`). `expires_at` is also compared, with an absent value normalized to empty text; its storage presence is optional. A credential rotation or revocation during a multi-batch read therefore returns `Stale` instead of a mixed snapshot. Eviction retains tombstones so delayed metadata hydration and generation-fenced native credential publication cannot republish against an old observation.

Intentional behavior changes include:

- Metadata and credentials have separate owners; metadata publication preserves credentials and permission fields rather than rewriting them from a Mongo snapshot.
- Expiry remains paired with its persisted token rather than borrowing an existing cached expiry for an older Mongo token.
- Full reconciliation evicts accounts absent from Mongo, and per-account refresh is available.
- ID-only reads use the membership index instead of parsing the serialized `twitch:accounts` aggregate.
- Errors are returned explicitly rather than being reported as successful empty/missing values.
- Stale hydration, cache publication, and destructive eviction use snapshot/generation comparisons; legacy writers do not join these comparisons automatically.

## Waits, bounds, and coordination rationale

There is no periodic polling worker. The service uses bounded pages and batches and yields between pages/passes to let other tasks run. Same-key hydration and token calls share in-flight futures; a bounded in-flight map returns `Busy` at capacity. Completed flight entries are removed by pointer identity after a waiter receives its result, so a fresh request starts new work even if another waiter still holds an unpolled copy of the completed result. Each API operation has a configurable deadline (default 28 seconds, maximum 30 seconds). This outer deadline can cancel a caller while it is waiting for token refresh; cancellation drops that future, while an owned distributed refresh lease expires naturally if its owner is cancelled. The directory adapter's guarded refresh allows a 25-second under-lock budget inside a 30-second lease with a 5-second buffer. Existing `twitch_tokens` callers retain their 5-second lease default.

Token waiters poll every 150 ms for up to 4.5 seconds, then attempt one takeover. They can still receive `Busy` when the owner remains active and has not produced a usable token; the wait is not a guarantee that every caller refreshes successfully. OAuth transient retries retain their 400/900 ms backoffs. These waits serve ownership/retry coordination, not artificial cadence. Review lease and deadline bounds whenever request, retry, or persistence behavior changes.

Reconciliation has a 20-second default timeout under a 30-second lease (lease maximum 60 seconds). Its orphan sweep is capped at 64 `SCAN` pages per pass, using a `COUNT` hint of 64. Since `COUNT` is a hint, a returned page may contain more entries; the adapter caps it at 4,096 IDs and batches native type checks into at most 64 keys. A nonzero cursor returns `ReconciliationIncomplete` and is explicit continuation state; resume with `sweep_orphan_hashes(cursor, page_budget)` without repeating Mongo metadata reload. If the timeout interrupts a pass, the error reports the last cursor with zero operation counts rather than claiming partial counts or false completion. A 16-ID point-hydration regression fixture confirms distinct cold IDs each require only one Mongo account read; this guards against cross-account global-revision retries.

The `CachedStreamer` enum intentionally keeps its 336-byte `Present` record inline: account reads are bounded to 64 accounts per batch, and inline records avoid a separate allocation per cache hit. The specific `clippy::large_enum_variant` allowance documents that tradeoff. During implementation review, BSON 3 `Result` comparison compile errors were corrected using `.ok() == Some(...)`, and Clippy's `collapsible_if` findings were addressed with let chains. These are source-rework details, not evidence of runtime performance.

Adapter review also found that Dragonfly forbids `SCAN` plus `TYPE` dynamic key access from Lua because the scanned keys are undeclared script keys. The orphan sweep now uses bounded name-pattern `SCAN` pages followed by explicit native `TYPE` pipelines of at most 64 keys under one deadline; matching non-hash keys are left untouched. The disposable adapter fixture covers this behavior. This correction is included in the passing adapter receipt above.

## Evidence references

- [Pre-port review](twitch-streamers-pre-port-review.md)
- [Rust API](../dima-rust/src/utils/twitch_streamers.rs)
- [Token lifecycle API](../dima-rust/src/utils/twitch_tokens.rs)
- [Parity fixture](../dima-rust/tests/fixtures/twitch_streamers_parity.json)
- [Plan-cache fence utility](plan-cache-fence.md)
- [Shared logger utility](shared-logger.md)
- [Whole-source behavior parity follow-up](twitch-streamers-parity.md)
