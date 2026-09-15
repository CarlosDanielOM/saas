# Domain Event Pipeline

Operational reference for backend module consumers, not browser WebSocket clients. MongoDB owns the journal, dispatch intent, deliveries, checkpoints, retries, and dead letters. Dragonfly PUB/SUB is the preferred low-latency wakeup path, **not Streams and not the durable event queue**. Delivery and external effects remain at-least-once, never a general exact-once guarantee.

The pipeline does not implement configurable goals, the extensible timer, PayPal, Kick, TikTok, a public subscription API, or a common cross-platform contribution payload. SaaS billing is not viewer donations. Navigation remains in [AGENTS.md](./AGENTS.md).

## 1. Producer Acceptance

Sources: [contracts](src/domain_events/domain_event_contracts.ts), [producer registry/ingestion](src/domain_events/domain_event_producers.ts), [journal](src/utils/domain_events.ts).

- Authenticate at the transport boundary using original signed webhook bytes. Normalize, validate, resolve ownership through Mongo, then journal; acknowledge only after successful ingestion. Invalid normalized input is rejected before owner lookup or journal writes. The journal boundary validates again.
- Validation checks envelope identity, source/type/topic/schema agreement, provider fields and timestamps. A bounded JSON walk limits combined payload/metadata to 256 KiB and nesting to 32 levels; it rejects cycles, unsafe properties, accessors, non-JSON values, nonfinite numbers and unsafe integers. This is not a promise that transport body limits are identical.
- [Twitch v1](src/domain_events/twitch_eventsub_events.ts) preserves shipped nested `payload.subscription` and `payload.event`, including provider fields; it does not flatten them. [Polar](src/domain_events/polar_events.ts) preserves the normalized billing contract: `customerId`, applicable order/subscription/product IDs, `paid`, `status`, `cadence`, `periodEnd`, and normalized meter fields. SDK camelCase/`Date` conversion happens in the adapter.
- New producers must supply their own provider `subject`. Retained validation narrowly accepts old persisted Twitch v1 rows with no subject/owner or durable-effect markers and the complete legacy journal/metadata shape; payload validation still applies. This excludes raids and is not an ingestion bypass for new no-subject events.
- `sourceEventId` identifies a provider delivery, not just a resource. `eventKey` combines source, receipt ID and semantic type. Different resource updates need distinct receipts; business effects may additionally deduplicate by order ID.
- Journal inserts request `{ w: 1, j: true }` and include `dispatchPending: true`. Duplicate receipts return the existing event rather than duplicating it. Channel/domain retention defaults and maximums are 90 days, activity 3 days, telemetry 7 days; producers may request shorter retention, not exceed the topic limit. Deliveries inherit journal expiry; existing rows are not rewritten.

### Ownership

Source: [identity resolver](src/domain_events/domain_event_identity.ts) and [envelope types](src/domain_events/domain_event.types.ts).

- `ownerUserId` is internal `users._id`, not a login/provider channel ID; unresolved ownership can be retained. `subject` is `{ provider, kind, id }`, distinguishing streaming/integration accounts, customers and resources. Channel topics require `channelID`; account billing does not fabricate one.
- Streaming identities use `users.accounts` with platform and remote ID in one `$elemMatch`. Separate dotted predicates can match different array elements. The separate `accounts.schema.ts` has no active integration lookup; do not infer ownership from its legacy `channelID`. Persisted enum values do not establish integrations.
- Polar resolves `users.polar_sh_customer_id`, then a provider-verified external internal-user ID. The shipped legacy `twitch_user_id` fallback is guarded against a different customer link. A valid explicit external owner that conflicts or was deleted does not fall through to that fallback.
- A journaled explicit owner remains pinned: if deleted, billing retries that missing owner rather than transferring to another mapping. Resolution never creates users, moves accounts or persists integration links. Unresolved owners require repair, not a guessed map fallback.

### Extension Rules

1. Implement `DomainEventProducer<Input>` with pure `normalize`, provider name and optional `resolveOwner`; `null` explicitly excludes an event. Register it and call `ingestDomainEvent` after transport authentication, without duplicating owned effects inline.
2. Register a stable consumer ID, topics, schema versions, Mongo filter, `adminReplay`, optional `maxEventAgeMs`, and lazy handler in the [consumer registry](src/domain_events/domain_event_consumers.ts). Mongo evaluates filters; always scope provider-specific handlers by source. Propagate required-effect failures instead of logging and returning success.
3. Define history eligibility first. A consumer with no checkpoint scans matching retained history; changing an existing filter does not rewind it. Use a new version and explicit history boundary for controlled rebuilds, without replaying unrelated chat/reward/timer effects.

## 2. Wakeups And Dispatch

Sources: [wakeup client](src/utils/domain_event_wakeups.ts), [dispatch/drain engine](src/utils/domain_event_consumer.ts), [worker](src/workers/domain_events.worker.ts).

- After Mongo acceptance, a scheduled, asynchronous publisher coalesces hints into one pending bit on `domain-events:wakeup:v1`. Connection creation and publication are outside the producer acknowledgement path; event payloads are not queued in Redis.
- Dedicated hint connections have 500 ms connection/command deadlines, disabled offline queues and no client auto-reconnect. Failure/timeout destroys the connection, flushing pending commands rather than merely racing a promise. Failed hints are dropped; subscriber retries are independent of Mongo.
- Set `DOMAIN_EVENTS_WAKEUPS_ENABLED=false` for polling-only operation. Parent Mongo dispatch polling and each child's Mongo delivery/checkpoint polling remain independent of hints and of each other. Disabling hints must not prevent processing; business handlers that need cache can still retry during a cache outage.
- Dispatch scans `dispatchPending` independently of checkpoints, idempotently creates all matching deliveries, then clears the marker with journaled acknowledgement. Partial fanout leaves it set for recovery.
- A lower ObjectId inserted after checkpoint advancement remains discoverable through dispatch intent/deliveries. ObjectId order is not provider occurrence order; projections need explicit late-event rules. Checkpoint scans also cover older retained rows.

## 3. Isolated Execution

Sources: [execution supervisor](src/utils/domain_event_execution.ts), [worker configuration](src/workers/domain_events.worker.ts), [lease handling](src/utils/domain_event_consumer.ts).

The domain worker remains under the cron host, but runs **one persistent child process per consumer**, currently eight. A stalled/CPU-bound consumer does not share the event loop of another consumer or the dispatcher. This costs separate Node heaps, imports, Mongo pools and handler-dependent cache connections, not eight free logical tasks.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DOMAIN_EVENTS_POLL_INTERVAL_MS` | 1,000 ms | Parent and independent child fallback polling |
| `DOMAIN_EVENTS_BATCH_SIZE` | 100 | Bounded scans/drains, maximum 500 |
| `DOMAIN_EVENTS_MAX_ATTEMPTS` | 5 | Ordinary failed/interrupted attempt budget |
| `DOMAIN_EVENTS_EXECUTION_TIMEOUT_MS` | 120,000 ms | Parent's absolute claimed-handler deadline, not extended by renewal |
| `DOMAIN_EVENTS_LEASE_MS` | 60,000 ms | Mongo claim lease, renewed about every third of its duration |
| Derived lease safety | 10,000 ms | Parent kills before known lease expiry; `max(500, floor(leaseMs / 6))` |
| `DOMAIN_EVENTS_OPERATION_TIMEOUT_MS` | 60,000 ms | Child startup/non-handler progress watchdog |
| `DOMAIN_EVENTS_SHUTDOWN_GRACE_MS` | 5,000 ms | Graceful child shutdown before hard kill |
| `DOMAIN_EVENTS_RESTART_DELAY_MS` | 1,000 ms | Restart delay after observed exit |

Lease-token and unexpired-lease predicates fence completion/failure writes. Renewal error, expiry or lost ownership hard-terminates the production child immediately; the parent also uses `SIGKILL` on watchdog expiry and waits for exit before replacing a slot. A promise timeout alone would leave effects running. None of this retracts an external request already accepted by Twitch or another service; response/completion loss can still duplicate external effects.

## 4. Recovery And Receipts

Sources: [retry engine](src/utils/domain_event_consumer.ts), [session projection](src/utils/stream_session_event_projection.ts), [offline analytics](src/utils/stream_analytics.ts), [cron queue](src/utils/cron_jobs_queue.ts).

- Ready work includes pending deliveries, due retries and expired processing leases. Ordinary errors use 5 s, 30 s, 5 min and 30 min retry delays before the default fifth-attempt dead letter; interrupted final attempts are explicitly retired.
- `DomainEventPrerequisiteMissingError` retries without spending the ordinary attempt budget. Missing lifecycle sessions and unresolved/deleted Polar owners retry every 30 s for **24 hours after `journaledAt`, capped by `expiresAt`**. Still missing becomes explicitly `dead`; replay does not reset that horizon. Ephemeral age policy can end eligibility earlier.
- Missing metric sessions (`metric-session:` prerequisites) often represent ordinary offline activity. They get a **15-minute grace period** with retries at journal age 30 s, 90 s, 210 s, 450 s, 750 s and 900 s, capped by retention. Remaining gaps become `skipped` with an explicit recovery-window reason, not successful metrics or billing-like dead letters. This bounds retry amplification to seven executions including first receipt, while allowing delayed online events within grace. It does not prove the channel was offline; sessions arriving after grace require an explicit analytics rebuild, not deleting receipts.
- Contract failures become `dead`; missing/removed journal rows are classified `journal_missing`. Do not turn missing prerequisites into successful no-ops or remap a pinned owner to another account.
- Authoritative bits/subs/follows use Mongo session metrics with `applied_domain_event_keys` in the same atomic update. Receipt lookup also checks outside corrected session time bounds. These session keys are no longer truncated at 10,000; retry must not re-increment metrics after an old receipt falls out of a rolling window.
- Offline replay first locates the session by event receipt, even if lifecycle corrections moved its bounds. Closing the session is not proof of downstream completion. Mongo per-step receipts `offline_summary_enqueued_at` and `offline_clips_completed_at` let retries resume missing summary/automatic-clip steps; these record step acceptance/handling, not completed downstream generation.
- A previously unapplied online event can repair the same snapshot-orphaned stream without resetting its metrics, provided no newer/different session or completed offline step conflicts. A genuinely offline session stays closed; already-applied online replays do not reopen it. Offline events still use provider occurrence/time-window matching because Twitch does not supply their stream ID.
- Cron dedupe marker, automatic acceptance key and list push run in one Redis Lua operation, with marker rollback on push error. Automatic `stream_offline` jobs retain `cron:jobs:accepted:<job>:<channel>:<session>` permanently, separately from expiring/deletable ordinary dedupe keys. This covers enqueue response loss before the Mongo step receipt, even after a worker clears ordinary dedupe.
- **Queue durability limit:** Mongo step receipts and permanent Redis acceptance keys do not preserve/reconstruct the Redis queue itself after cache loss. A completed acceptance step can suppress re-enqueue of a now-lost queued job. This is not end-to-end durable downstream job execution.

### Polar Effects

Sources: [signed webhook](src/server/routes/webhooks/polarsh.webhook.ts), [normalizer](src/domain_events/polar_events.ts), [billing consumers](src/domain_events/polar_billing_events.ts).

`POST /polar/webhook` verifies raw bytes with the installed Polar SDK, uses signed `webhook-id` as receipt identity, and journals instead of invoking old inline billing.

| Provider Event | Domain Event | Automatic Effects |
| --- | --- | --- |
| `order.paid` | `billing.order.paid` | Known plan projection and supported paid-plan reward |
| `subscription.updated` | `billing.subscription.updated` | Known plan projection only, no reward |
| `customer.state_changed` | `billing.customer.state.changed` | Credit snapshot/cache |
| Other SDK-validated types | `provider.polar.<type>` | JSON-safe `providerData` retained, no automatic billing effects |

Unmapped events are not failures merely because no consumer subscribes. Unsupported SDK types remain rejected. Refund/reversal policy and additional lifecycle mappings are outside this change. Existing entitlement/cancellation rules, credit calculations, legacy-meter fallback, reward amounts and active-referrer-or-bot selection remain unchanged.

Plan and credit Mongo snapshots use provider time/event-key ordering. Plan caches are invalidated rather than overwritten with stale snapshots. Credits project snapshot, exhaustion flags and ordering version atomically per Twitch account; credit-cache expiry does not erase the version. Billing ownership does not require a Twitch account.

[Paid-order rewards](src/utils/paid_order_reward.ts) need no multi-document transactions: unique `polar:paid-order:<orderId>` reservation freezes amount/recipient, an atomic user update increments `token_balance` with `applied_credit_transaction_ids`, then history is marked applied. All three writes request journaled acknowledgement. A reservation alone is not evidence of credit; response-loss recovery checks the user receipt. Unrecoverable historical `balanceAfter` stays null. Legacy reward rows prevent another reward but do not automatically repair old partial-write ambiguities.

### Storage Limits

Session event keys and user credit receipts grow without a rolling cap; reward records outlive journal TTL. Monitor Mongo's **16 MiB BSON document limit**, especially high-volume sessions and the bot/referrer beneficiary. Permanent automatic acceptance keys and credit-ordering keys also grow Redis/Dragonfly memory. Do not prune permanent receipts, delete/recreate idempotency records, or clear checkpoints to force recovery. Any future compaction needs dedupe-preserving design and in-flight-worker handling; ordinary TTL cleanup is not such a design.

## 5. Defense And Replay Policy

Sources: [consumer registry](src/domain_events/domain_event_consumers.ts), [delivery policy](src/domain_events/domain_event_delivery_policy.ts), [defense adapter](src/domain_events/follow_defense_events.ts), [defense execution](src/utils/follow_defense.ts), [raid marker](src/utils/follow_defense_queue.ts).

| Consumer | Maximum Event Age | Admin Dead-Letter Replay |
| --- | --- | --- |
| `follow-defense-v1` | 5 min, plus stricter handler freshness | No |
| `chat-announcements-v1` | 5 min | No |
| `account-health-notifications-v1` | 5 min | No |
| `stream-analytics-v1` | No age cutoff | Retained eligible events |
| `stream-operations-v1` | No age cutoff; newer-lifecycle guard | Retained eligible events |
| `polar-plan-v1`, `polar-credits-v1`, `polar-rewards-v1` | No age cutoff | Retained eligible events |

- Age policy uses the earlier of occurrence and journal time, so future provider clocks cannot prolong ephemeral effects. It is rechecked before execution. Over-age deliveries are retained as `skipped` with `skipReason`, not counted as succeeded; unsupported schemas are rejected. Policy outcomes do not spend retry budget.
- Defense is opt-in per event through `metadata.durableDefenseHandled: true`, emitted by the production Twitch transport for follows/raids only. Only `twitch-eventsub` marked v1 events enter this consumer. It calls durable defense directly, not the old lossy dequeue-before-processing queue; required errors propagate for delivery retry.
- Follows cannot create a new moderation decision once 60 seconds old. Fresh decisions are journaled into the separate Mongo moderation queue before the consumer completes; already accepted decisions have a fixed one-hour execution deadline. Raid markers expire 5 minutes after occurrence; atomic ordering prevents retries extending expiry or replacing a newer raid. Old retained events must not become actionable after cache loss.
- Threshold/manual defense mode writes and active-channel indexing share an atomic Redis projection. Lower-rank stale transitions cannot overwrite an active attack; expiry/reset compares the exact state version before deleting state or tracked follows. Only a winning transition queues its announcement or wave; retries use stable action identities. Wave admission still checks follow freshness, while Twitch execution is independent of the detector.
- Expiry attack logs use a deterministic state identity and journaled writes. The saved log freezes raid classification; hate-raid source counters increment atomically with permanent per-log receipts, so retries after log/counter/reset response loss do not duplicate durable records. Retain these receipts and monitor their BSON growth too. Cooldown summaries have their own Redis acknowledgement counter and delivery lease; external chat remains at-least-once across a crash between Twitch success and the acknowledgement write. Old duplicate logs are not automatically repaired. Queued moderation outcomes reconcile tracked-follow ban results after logs are created, including actions completed after mode expiry.
- Production ownership markers suppress the matching legacy follow enqueue/raid marker only. [Raid shoutouts](src/handlers/raid.handler.ts) remain immediate. Redemption execution, arbitrary AST/chat/ad/ban actions remain outside this durable migration; manual commands retain their legacy ingress but acknowledge only after durable action acceptance, and cancellation fences old queued commands; it is not a universal action bus.
- `metadata.durableChatHandled: true` gates durable chat/account-health. Unmarked historical announcements are not replayed; authenticated test events retain immediate behavior. [Follow display numbering](src/domain_events/chat_announcement_events.ts) still uses a **48-hour Redis receipt** and is best-effort after cache loss, unlike authoritative Mongo follow metrics. Chat/notification effects can duplicate after external acceptance response loss.
- Super-admin [listing/replay routes](src/server/routes/admin_site.route.ts) are `GET /admin-site/domain-events` and `POST /admin-site/domain-events/:eventKey/replay` with body `{ "consumer": "..." }`. Replay requires a registered replay-enabled consumer, a dead delivery and retained/unexpired journal matching Mongo source/type/topic/history filters, schema and payload validation. Denial returns 409; scheduling returns 202. Repair prerequisites first; neither skipped outcomes nor ephemeral consumers get admin replay.

## Follow defense moderation execution

Detection in `follow-defense-v1` updates Redis windows/modes and records actions through [follow_defense_actions.ts](src/utils/follow_defense_actions.ts). It never waits for Twitch bans, AI generation, or warning delivery. The short-window thresholds also apply to the cumulative count of an active sustained flood: silence starts at 10 follows in 5 seconds and protection at 100 follows in the wave by default; attack uses the configured or dynamic threshold. A continuing rate of at least 10 per 5 seconds refreshes the same wave until 60 seconds after the last high-rate evidence; protection still evaluates attack escalation. Protection tracks and suppresses alerts without banning. Automatic attack uses the saved numeric threshold or a dynamic threshold when the setting is null. Recognized raid sessions cap automatic escalation at protection; chat announcement settings do not gate defense detection. Atomic refresh preserves the state identity and cannot revive reset or expired modes. Follow-alert suppression remains active for the renewed mode; the separate announcement consumer can still race initial detection. Warning messages use deterministic static text queued outside detection. Cooldown acknowledgements run separately in the maintenance worker, across silent/protection/attack modes.

Mongo `follow_defense_actions` stores one idempotent action per channel/event/kind, including follower ID, reason, authorization time, attempts, outcomes, and a fixed one-hour execution deadline. Ban waves use bounded 200-payload batches and bulk upserts. Admission requires a follow younger than 60 seconds; retry cannot extend an existing action deadline. Records expire after seven days; expired decisions never restart from retained journal history. This does not preserve the Redis tracked-wave index after cache loss.

The `follow-defense-actions` child of the existing cron supervisor executes actions separately. Mongo `follow_defense_controls` holds durable cancellation boundaries, channel scheduling, a global lease and rate pauses. Channels are served by oldest service time, starting at 5 requests/second globally and per channel, increasing by 1 after every 20 successful responses with usable rate-limit headers, up to 10. Missing headers cap the target at 5; actual throughput also depends on request latency. Remaining token budget is spread until `Ratelimit-Reset`, reserving 20 points for other bot features. These are conservative application limits, not a guarantee against Twitch limits shared with other bot features. On 429 the affected target rate halves (minimum 1). A 429 with healthy shared remaining budget pauses the affected channel; exhausted or unknown shared budget pauses globally. The worker honors `Ratelimit-Reset` and `Retry-After` with a safety margin and minimum 30-second pause. Low remaining budget pauses proactively; 401 pauses globally, 403 pauses the channel, and transient failures back off. Permanent client errors fail the action; other failures have an eight-failure budget. Rate-limit responses do not consume that budget, but the execution deadline always applies.

The executor reserves pacing before issuing requests, claims work under a 60-second lease, and fences completion. Ban fetches have a 10-second abort signal. The worker hard-exits after a 40-second stalled tick so a late handler cannot outlive its lease; the supervisor restarts it. Lost successful responses may retry; only the precise Twitch already-banned response is accepted as success. No exactly-once external execution is promised.

`POST /follow-defense/:channelID/reset` persists a cancellation boundary before clearing the live mode; a late enqueue or old manual command cannot authorize another ban across that boundary. Disabling defense or a moderation mode cancels existing queued work conservatively, and the executor rechecks current persisted settings. Cancellation cannot retract an already-issued Twitch request. Automatic mode expiry does not cancel previously accepted actions. Controls have no TTL, so old cancellation boundaries survive restarts and cache loss.

Follow announcements with an enabled, nonempty message pass their stable event identity to `shouldSuppressFollowAlerts`. An atomic Redis script suppresses the message and increments a separate per-channel summary only once; 48-hour receipts also prevent a suppressed event being individually announced on retry after cooldown. The acknowledgement counts suppressed announcements, not the detector's tracked followers or the threshold subtracted from a total. Pure status checks do not increment it. Both the global chat consumer and legacy handler use this path; a counter-write failure propagates to durable delivery retry.

The maintenance worker sends one aggregate after cooldown, such as “10 additional follows were received while announcements were paused. Thanks for following!” (English/Spanish, exact readable counts). Renewed modes defer delivery; mode upgrades and automatic tracked-list cleanup preserve the pending count. A per-channel Redis lease excludes concurrent senders; successful delivery subtracts only its snapshot so new arrivals are retained. Failed sends back off 30 seconds and acknowledgements more than five minutes overdue are discarded. Current chat, follow-announcement, and defense settings are checked before sending. Reset cancels the pending acknowledgement. Summary delivery is independent of the moderation queue, so thousands of bans do not delay it. This does not impose ordering between initial detection and chat consumers: the number of initial individual announcements can vary, and the summary reports the actual suppressed count.

`GET /follow-defense/:channelID/status` adds `moderationQueue`, counts of retained ban actions by status (`pending`, `processing`, `succeeded`, `failed`, `cancelled`, `expired`). The existing attack logs are reconciled with final ban outcomes; raid session controls additionally show confirmed outcomes and explicit manual ban requests.

Validation: `ops/checks/follow-defense.mjs` with `ops/checks/follow-defense-fixtures` exercises isolated API/cron candidates using disposable Mongo/Redis and mocked Twitch. It covers real journal delivery during slow moderation, queue persistence/dedupe, full five-minute floods of 1876/2280/11400 follows, continuing suppression and escalation, worker restart, adaptive 5-to-10 pacing/fairness, scoped rate-limit pauses, claim recovery, cancellation, settings, and deadlines. `ops/checks/follow-defense-summary.mjs` additionally verifies real journal/chat delivery, 10 individual announcements plus 10 suppressed events, mode escalation and cooldown, one aggregate, 4900 suppressed events, legacy retry identity, and Reset cancellation. The public event test endpoint still uses legacy ingress and is not a dry-run moderation sandbox.

## Health Endpoint

Source of truth: [health aggregation](src/utils/domain_event_health.ts), exposed by the authenticated super-admin [route](src/server/routes/admin_site.route.ts).

`GET /admin-site/domain-events/health` optionally accepts `?consumer=stream-analytics-v1`. Consumer must be one string matching `[a-zA-Z0-9_-]{1,100}`; invalid input returns 400. Success is `{ error: false, message, status: 200, data }`, with `Cache-Control: no-store`; query failure returns generic 503, not zero/healthy metrics.

| `data` Field | Actual Shape/Meaning |
| --- | --- |
| `asOf`, `consumer`, `scope`, `semantics` | ISO sampling time, filter or null, scope and interpretation strings |
| `limits` | `documentsPerBucket: 10000`, `maxTimeMSPerQuery: 1000`, `approachingExpiryWindowMs: 3600000` |
| `deliveries` | Separate `pending`, `processing`, `retry`, `succeeded`, `skipped`, `dead` buckets |
| Each delivery bucket | `count`, `capped`, `oldestAgeMs`, `oldestReadyAgeMs`, `dueRetries`, `staleProcessing`, `approachingExpiry`, `expired`, `prerequisiteMissing`, `ownerUnresolved`, `subjectUnresolved`, `maxLastAttemptDurationMs` |
| `dispatchPending` | Global `count`, `capped`, `oldestAgeMs`, `oldestReadyAgeMs` (null), `approachingExpiry`, `expired`; not consumer-filtered |

Each status query and the dispatch query is independently capped at 10,000 documents and 1 second, without disk spill. This is **not** a 1-second endpoint-wide deadline or a full collection census. Reads are independent, not a snapshot. At the cap, counts and maximum ages/durations are lower bounds over an unordered sample; large succeeded history cannot crowd retries out of their separate bucket.

Delivery ages use `createdAt`; ready age means age of currently ready work, not time overdue. Dispatch age uses `journaledAt`. Expiry counts apply to active delivery buckets and global pending dispatch; approaching expiry means the next hour. Owner/subject signals reflect the last classified prerequisite failure, not absent journal identity, and do not infer legacy unclassified failures. Only `succeeded` is success; retain and inspect `skipped`, retries and dead letters separately.

## Verification And Rollout

This checkout is on the **production server**, with Docker and live databases available. Follow the root [production workflow](../AGENTS.md#production-host--delivery-workflow): validate changes with isolated test containers/dependencies, clean up, then deploy the affected services and verify production. Do not run fault injection, duplicate consumers, or payment/webhook test traffic against live services. The service-free allowlisted [runner](src/scripts/test_domain_pipeline.script.mjs) covers the pipeline suite using Node module mocks; standalone Lua checks are optional and skip if Lua is unavailable. From the repository root:

```bash
node dimabot/src/scripts/test_domain_pipeline.script.mjs
node dimabot/src/scripts/test_domain_pipeline.script.mjs --test-reporter=dot
```

Do not replace the allowlist with a repository-wide test glob. Mocked queries, response loss, SDK transport and child-process tests do not establish live Mongo/Dragonfly atomicity, query performance, resource sizing or payment behavior. Run failure scenarios below against isolated dependencies and synthetic data; use payment-provider test mode. After deployment, use scoped, non-destructive production health checks. Record which checks were actually performed; this checklist is not evidence that they passed.

### Production Checklist

1. Deploy a matching producer/cron registry before enabling new event types. Avoid overlapping divergent dispatcher registries. Verify the current eight consumer children plus dispatcher, crash restart and shutdown behavior; measure aggregate RSS/CPU, Mongo pool/socket limits and cache connections under backlog, not just idle cost.
2. Verify [journal indexes](src/schemas/domain_event.schema.ts), [delivery uniqueness/ready-work/health/TTL indexes](src/schemas/domain_event_delivery.schema.ts), checkpoint indexes and unique paid-order reservation index. Check actual query plans and health query timeout behavior; definitions in source are not proof indexes exist on the host.
3. Disable wakeups with `DOMAIN_EVENTS_WAKEUPS_ENABLED=false`, then simulate unavailable/hung hint connections. Confirm Mongo acceptance, dispatch and independent child polling still process work, bounded hint destruction, and cache-dependent handler retries without blocking other consumers.
4. Exercise duplicate acceptance, crash/response loss after journal insert, partial fanout, checkpoint races, expired leases, blocked/CPU-bound children, renewal loss and shutdown. Confirm no replacement before exit, no local continuation after lease loss, and explicit final-attempt dead letters; external duplicate risk remains.
5. Test missing stream sessions and Polar mappings appearing during prerequisite retry, plus unresolved/deleted pinned owners reaching the capped horizon without fallback transfer. Verify permitted retained replay and rejection of malformed, expired, filtered-out or ephemeral replay.
6. Inject response loss after offline session mutation, each queue acceptance and each Mongo step receipt, including worker removal of ordinary dedupe keys. Verify recovery without repeated automatic acceptance or authoritative increments. Separately test/document queue-loss recovery limitations; never claim Mongo receipts restore a lost Redis list.
7. Verify duplicate paid orders yield one receipted balance increment, snapshot ordering/cache recovery, follow numbering's cache-loss limitation, 60-second follow/5-minute raid stale safety, and immediate raid shoutouts. Inspect separate skipped/dead health signals and near-expiry backlog.
8. Monitor retained backlog and TTL headroom, unbounded session/beneficiary BSON size below 16 MiB, and permanent Redis key memory growth. Do not prune permanent receipts as routine maintenance. This pipeline is not a replacement for provider accounting records.


### Retained raid sessions and manual moderation

Each real raid starts a separate Mongo `raid_session`, keyed by its journal identity. Follows belong
to the latest raid preceding their occurrence time, up to five quiet minutes, a subsequent raid,
or the session retention deadline. Late raid delivery repairs attribution and backfills journaled
follows in bounded batches. Idempotent follow receipts prevent replay from inflating totals.
Every plan receives 72 hours of dashboard visibility. Logical expiry is enforced by the API; physical cleanup allows an additional hour
for moderation accepted just before expiry. These sessions are temporal groupings; Twitch does not
prove that an individual follower arrived from a particular raider.

The `raid-sessions` cron child admits manual bans in batches of 200. Requests use a client identity
for retries, include an actor, and expire after one hour. Banning an ended session or a session whose
mode is already normal targets only followers recorded at confirmation. When the same session is
still recording with an active defense mode, confirmation activates attack and includes arrivals
only while that request's attack mode remains active. Previously accepted bans can finish after the
mode ends. Reset and disabled settings fence pending work before the Twitch call.

`resetAttackOnNewRaid` defaults to true: a new raid closes the previous session and changes attack
to protection. Its follows cannot enter the previous request. Explicitly disabling the setting
keeps an active attack mode and creates a separate authorized request for the new session. Raid
projection receipts prevent duplicate delivery from reopening a mode after cleanup. Automatic
queued bans recheck raid membership immediately before execution; already-issued requests cannot
be retracted when a raid is delivered late.

The dashboard lists sessions and paginated follower names, provides individual and whole-session
confirmation dialogs, and displays queued/confirmed/failed results. Mutation endpoints require
`moderation:manage` (or owner/global-owner access), plus the channel owner's plan entitlement.
Free can view sessions and names, Premium can ban whole sessions from history, and Pro additionally
can ban individuals. Moderator/admin subscriptions cannot override the channel's plan. All plans
can activate attack through live controls while the same raid's protection is active. A Free live
request fails closed if protection ends before activation; it cannot fall back to historical bans.
Live requests are admitted only after their attack state is published, with restart recovery for
an interrupted activation. Previously accepted requests may finish after a plan downgrade. Chat summaries remain friendly for silent and
protection waves; attack summaries distinguish suppressed announcements from confirmed bans and
pending moderation, rather than claiming every queued ban succeeded.

Verification: `ops/checks/raid-sessions.mjs` with `ops/checks/raid-fixtures` covers isolated API, bot,
and cron runtimes, A=3000/B=2000 follows, active versus historical authorization, both new-raid
settings, late attribution repair, journal backfill, retention, and real worker execution against
mock Twitch. `ops/checks/raid-site.mjs` uses Playwright and axe-core with intercepted API data to
verify confirmation scopes, retries, pagination, settings, and mobile/desktop layouts.

#### Retention extension rollout

The `raid-sessions` worker extends one still-visible legacy session per tick to 72 hours from its
original raid timestamp. It first widens that session's follower TTLs, then its visibility and
physical expiry, using monotonic updates; retries cannot shorten retention. New follower inserts
already use the 73-hour physical deadline. This additive procedure needs no index or infrastructure
change and never deletes data. Expired sessions are excluded to avoid advertising a partially
purged history; deleted records cannot be recovered. Verification exercises extension and repeat
execution against disposable Mongo before the worker is deployed.


### Dynamic follow-defense sensitivity

`attackThreshold: null` (or an empty PATCH field) selects dynamic detection. New settings default to
null; existing numeric settings, including 500, are preserved because legacy data does not identify
whether a number was explicitly chosen. Invalid, zero, negative, fractional, or nonnumeric values
are rejected. A streamer can clear the field to opt in and see the effective threshold on the page.

A dedicated supervised `follow-defense-baseline` worker queries the last 30 complete UTC days from
the follow ledger and completed stream sessions. It excludes days with recorded attack logs and
ignores today's follows/live streams. The threshold is the ceiling of twice the larger of average
daily follows (the larger ledger or stream total divided by eligible calendar days) and average
follows per completed stream, with a minimum of 500. At least seven activity days and three completed
streams are required. These are volume safeguards, not proof that a follower is malicious.

The detector reads only the Redis baseline; it never runs historical aggregates per event. Refreshes
run hourly, one channel at a time, with query deadlines and retry scheduling. Missing data, cache
loss, or a baseline older than 48 hours pauses dynamic automatic attack instead of falling back to
500. Silence, tracking/protection, and manual attack still work. A fresh manual command includes older followers captured in that same active wave; automatic decisions retain their 60-second event-freshness gate. Existing raid protection and
per-session manual authorization continue to apply. Prior automatic protection ban jobs are
cancelled before execution. Twitch pacing still targets 5–10 requests/second and respects retry headers. The minimum interval now starts at request completion so slow token/header lookup cannot compress actual HTTP arrivals.

`ops/checks/dynamic-defense.mjs` validates real aggregation with isolated Mongo/Redis, a 20k/day
baseline and 10,000 non-raid follows, manual/custom activation, null/number API contracts, cache
staleness, worker startup, and legacy protection-job cancellation. Provider calls are mocked.
