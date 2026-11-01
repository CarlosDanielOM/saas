# Event Pipeline Recovery: Lifecycle, Authorization, and Offline Sessions

**Status: deployed and production-checked; task cleanup complete.** The recovery paths below were built and checked against exact candidates before the targeted cron, API, and bot releases. The scoped historical offline repair was executed and read back. Rollback artifacts were retained; task-owned temporary resources and the baseline snapshot were removed.

## Reused sources and remaining gaps

The implementation extends the existing domain-event journal and consumer delivery model rather than adding another stream-event queue. `stream-operations-v1` remains the owner of lifecycle-triggered timer, editor, admin, VIP, reward, cache, speech, and history operations. Stream state and downstream offline work continue to use the existing `streamsessions` collection, Mongo event receipts, and existing `stream_analytics` worker.

The recovery gaps addressed are distinct:

- Lifecycle consumers previously had no durable receipt per side-effect step, so a retry could repeat successful earlier steps without showing which operations had completed, been skipped, or failed.
- OAuth could persist new credentials without a durable current-state reconciliation request for channel operations skipped while authorization was absent. Replaying old online/offline transitions would be unsafe because the stream may have changed since those events.
- A Twitch 401 followed by an unavailable or unchanged credential refresh did not provide a distinct outcome to callers. A rejected credential must not be treated as proof that authorization was revoked.
- Offline notifications have no Twitch stream ID. Time matching against session history can identify a bounded snapshot closure, but cannot safely infer a match across superseded, already closed, or competing sessions. Some historical dead deliveries therefore need an explicitly selected repair path rather than broader automatic matching.

## Implemented behavior

### Lifecycle operation receipts

`stream_operations_receipt` stores per-event `steps` with `completed`, `skipped`, or `failed` status, a timestamp, and an optional reason. The lifecycle handler resumes only steps that are not already completed or skipped; failed steps remain eligible for retry. It checks for a newer lifecycle event before starting and between side effects. Receipt-write failures propagate to durable delivery retry. External effects remain at-least-once if an effect succeeds but its receipt acknowledgement is lost.

Successful authorization also upserts `stream_operations_reconciliation` by channel, increments its durable revision, and marks it pending. The existing `stream_analytics` worker calls the recovery function on each tick. Recovery claims requests with a lease, evaluates current authorization and current Twitch stream state, and acknowledges only when channel revision and lease token still match and the lease remains valid. Failures are retried after one minute. Reconciliation step receipts are keyed by channel and revision and do not replay old lifecycle events.

The Twitch streamer Helix retry path passes the rejected access token to the shared token refresh path, which uses a per-account Dragonfly lock so concurrent callers can wait for one refresh result. If refresh cannot provide a distinct credential, the helper reports `refreshUnavailable` and status 503. That result is not an authorization-revocation decision.

### Offline session matching and explicit repair

Session closure records `closure_source` as `snapshot`, `superseded`, or `eventsub`. Automatic offline processing can close a live session using the event occurrence time. Among previously closed sessions, it may match only a unique snapshot orphan within the 60-second `SNAPSHOT_OFFLINE_MATCH_WINDOW_MS`; it does not reinterpret superseded or already EventSub-closed sessions as candidates. Competing sessions make an identity-free match ambiguous and leave the event unresolved. The selected-document compare-and-set prevents overwriting a session that changed after it was read, but it cannot atomically fence insertion of a competing historical record in another document.

The offline reconciliation script requires all of `--channel`, `--event-key`, and `--session-id`; it defaults to dry-run. It validates the retained event, dead `stream-analytics-v1` prerequisite delivery, selected session, bounded historical match, competing sessions/events, and summary acceptance evidence. For a legacy row without an explicit closure source, the operator must select the exact session ID and it must meet the snapshot-orphan constraints. An absent summary marker is not proof that a legacy job was never accepted, so the script refuses that potentially duplicate enqueue. Execution uses the existing analytics path, then reads back the selected session and both downstream step receipts. It does not change the dead delivery or checkpoint.

The source-level behaviors are in [the operation consumer](../dimabot/src/domain_events/stream_operations_events.ts), [the receipt schemas](../dimabot/src/schemas/stream_operations_receipt.schema.ts), [the Helix retry helper](../dimabot/src/utils/twitch_helix_retry.ts), [the session analytics path](../dimabot/src/utils/stream_analytics.ts), and [the explicit offline repair script](../dimabot/src/scripts/reconcile_stream_offline.script.ts). The domain-event reference is [DOMAIN_EVENTS.md](../dimabot/DOMAIN_EVENTS.md).

## Investigated retained-failure baseline

The investigated dead-letter baseline was 792 `stream-operations` deliveries across 37 channels: 782 associated with permissions disabled and 10 with invalid OAuth. There were four retained `stream-analytics` dead deliveries. One historical candidate was a snapshot orphan for channel `674940737`: the retained offline event occurred at `2026-10-23T19:48:35.909Z`, and the session ended at `2026-10-23T19:48:33.252Z`, a difference of about 2.7 seconds and within the 60-second bound.

The other three analytics deliveries were ambiguous for channels `1375721752`, `402836694`, and `692885244`. Their session statuses and end times were unchanged; the available history did not identify one safe session.

## Candidate verification and deployment

All three candidates were built, then passed their exact-runtime feature checks and 140 mocked regression checks per target, with zero skipped checks. Deployment times below are UTC on 2026-11-01:

| Target | Run / image | Deployed (UTC) |
| --- | --- | --- |
| Cron | `cron-49eb82a84e9c` / `sha256:339339bf74788ce4ad1b4d0c4171d1cf3327fe991c97c577c78083724411d63d` | 2026-11-01 23:36:42.878 |
| API | `api-94a91197d31d` / `sha256:82954d9c6d439043285f6514b3da54f7e761ae48c50142a12b0a5894e4b45ec3` | 2026-11-01 23:37:04.391 |
| Bot | `bot-4938ffc9e6b0` / `sha256:6d634e60274e04dfef2fb8cf39ba7403eb2196e9ae641034c00275d56d72c47e` | 2026-11-01 23:37:23.887 |

The native cron candidate was built with a 3 CPU / 4 GiB cap in 1,650.955 seconds from a cold cache. All four profile dependency-graph digests matched those from the prior live cron run `cron-67c85cf5cb26`. No worker, relevant dependency, or shared native runtime changed, so native-worker functional retests were scoped out. Post-deploy startup checks covered all seven native workers, 18 TypeScript workers, and 14 domain-event consumers.

Only the three selected target containers changed, out of 18 production containers. Readiness checks showed zero restarts and no fatal or worker-exit signals. Scoped HTTP checks returned 200 for configuration, 401 for anonymous goals access, and 403 for unsigned bot access. A production lifecycle receipt at 2026-11-01 23:36:46 UTC also showed `timers` and `admins` completed and `editors` and `vips` skipped because the channel was deactivated.

Broader test runs reported three unrelated failures. The same three were reproduced against unchanged `HEAD` using a git-archive baseline: 25 tests, 22 passed, 3 failed. Other broad-run failures were due to missing Lua. Separately, 129 source-targeted checks passed, and the token/speech suite reported 77 passes; these targeted counts overlap and are not additive. TypeScript `noEmit` and `git diff --check` passed.

## Historical offline repair and production readback

For channel `674940737`, the script was run first in dry-run and then execute mode at 2026-11-01 23:38:00 UTC for session `6adba50fcfe7a3a6b8378576`. Readback showed `ended_at=2026-10-23T19:48:35.909Z`, `status=offline`, and `closure_source=eventsub`. The summary receipt was recorded at `23:38:00.051Z`; the clip receipt recorded the current opt-out at `23:38:00.055Z`. The preexisting permanent summary acceptance marker remained present (`1`); no clip acceptance marker was created (`0`).

Session metrics were unchanged, and the original dead delivery content was unchanged on readback. No checkpoint reset or replay was performed. The other three ambiguous sessions were left as found. Production evidence is retained under `/root/.local/state/saas-ops/649a957c15888e53/cron-49eb82a84e9c/`: `historical-repair-before.json`, `historical-repair-dry-run.log`, `historical-repair-execute.log`, and `production-readback.json`.

The pre-release retry created at `2026-11-01T23:07:49Z`, next due at `2026-11-01T23:43:24Z`, ran naturally at `23:43:24.988Z` and succeeded at `23:43:25.203Z` on attempt 5 under the new code. Its receipt recorded `timers` and `admins` completed and `editors` and `vips` skipped for `account_deactivated`; `lastError` was empty and `nextAttemptAt` was null. At `23:43:40.269Z`, the active unexpired pending, processing, and retry delivery count was zero.

## Remaining limitations and housekeeping

The selected-session compare-and-set does not atomically fence a concurrent historical insertion in another document. External side effects remain at-least-once when an effect succeeds but its receipt acknowledgement is lost. Durable queue acceptance evidence does not reconstruct a lost Redis queue. The unrelated baseline test failures remain unresolved and were not attributed to this change. Cleanup receipts and rollback artifacts for all three runs were retained, and the task-owned baseline snapshot was removed; run logs remain in the cron run archive.
