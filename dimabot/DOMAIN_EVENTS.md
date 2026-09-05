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
- Follows cannot initiate moderation once 60 seconds old; freshness is rechecked around delayed effects and tracked-wave bans. Raid markers expire 5 minutes after occurrence; atomic ordering prevents retries extending expiry or replacing a newer raid. Old retained events must not become actionable after cache loss.
- Threshold/manual defense mode writes and active-channel indexing share an atomic Redis projection. Lower-rank stale transitions cannot overwrite an active attack; expiry/reset compares the exact state version before deleting state or tracked follows. Only a winning transition announces or initiates its wave. A long ban wave intentionally stops acting on aged-out follows; do not widen moderation freshness to compensate for throughput.
- Expiry attack logs use a deterministic state identity and journaled writes. The saved log freezes raid classification; hate-raid source counters increment atomically with permanent per-log receipts, so retries after log/counter/reset response loss do not duplicate durable records. Retain these receipts and monitor their BSON growth too. External silent-summary chat remains at-least-once; old duplicate logs are not automatically repaired.
- Production ownership markers suppress the matching legacy follow enqueue/raid marker only. [Raid shoutouts](src/handlers/raid.handler.ts) remain immediate. Redemption execution, arbitrary AST/chat/ad/ban actions and the manual-attack queue are unchanged and outside this durable migration; it is not a universal action bus.
- `metadata.durableChatHandled: true` gates durable chat/account-health. Unmarked historical announcements are not replayed; authenticated test events retain immediate behavior. [Follow display numbering](src/domain_events/chat_announcement_events.ts) still uses a **48-hour Redis receipt** and is best-effort after cache loss, unlike authoritative Mongo follow metrics. Chat/notification effects can duplicate after external acceptance response loss.
- Super-admin [listing/replay routes](src/server/routes/admin_site.route.ts) are `GET /admin-site/domain-events` and `POST /admin-site/domain-events/:eventKey/replay` with body `{ "consumer": "..." }`. Replay requires a registered replay-enabled consumer, a dead delivery and retained/unexpired journal matching Mongo source/type/topic/history filters, schema and payload validation. Denial returns 409; scheduling returns 202. Repair prerequisites first; neither skipped outcomes nor ephemeral consumers get admin replay.

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

This workstation is development-only: **no Docker, databases, production webhooks, deploys or live payment checks here**. The service-free allowlisted [runner](src/scripts/test_domain_pipeline.script.mjs) covers the pipeline suite using Node module mocks; standalone Lua checks are optional and skip if Lua is unavailable. From the repository root:

```bash
node dimabot/src/scripts/test_domain_pipeline.script.mjs
node dimabot/src/scripts/test_domain_pipeline.script.mjs --test-reporter=dot
```

Do not replace the allowlist with a repository-wide test glob. Mocked queries, response loss, SDK transport and child-process tests do not establish live Mongo/Dragonfly atomicity, query performance, resource sizing or payment behavior. Production checks below must run on the production host in an appropriate controlled test setup; they have not been performed here.

### Production Checklist

1. Deploy a matching producer/cron registry before enabling new event types. Avoid overlapping divergent dispatcher registries. Verify the current eight consumer children plus dispatcher, crash restart and shutdown behavior; measure aggregate RSS/CPU, Mongo pool/socket limits and cache connections under backlog, not just idle cost.
2. Verify [journal indexes](src/schemas/domain_event.schema.ts), [delivery uniqueness/ready-work/health/TTL indexes](src/schemas/domain_event_delivery.schema.ts), checkpoint indexes and unique paid-order reservation index. Check actual query plans and health query timeout behavior; definitions in source are not proof indexes exist on the host.
3. Disable wakeups with `DOMAIN_EVENTS_WAKEUPS_ENABLED=false`, then simulate unavailable/hung hint connections. Confirm Mongo acceptance, dispatch and independent child polling still process work, bounded hint destruction, and cache-dependent handler retries without blocking other consumers.
4. Exercise duplicate acceptance, crash/response loss after journal insert, partial fanout, checkpoint races, expired leases, blocked/CPU-bound children, renewal loss and shutdown. Confirm no replacement before exit, no local continuation after lease loss, and explicit final-attempt dead letters; external duplicate risk remains.
5. Test missing stream sessions and Polar mappings appearing during prerequisite retry, plus unresolved/deleted pinned owners reaching the capped horizon without fallback transfer. Verify permitted retained replay and rejection of malformed, expired, filtered-out or ephemeral replay.
6. Inject response loss after offline session mutation, each queue acceptance and each Mongo step receipt, including worker removal of ordinary dedupe keys. Verify recovery without repeated automatic acceptance or authoritative increments. Separately test/document queue-loss recovery limitations; never claim Mongo receipts restore a lost Redis list.
7. Verify duplicate paid orders yield one receipted balance increment, snapshot ordering/cache recovery, follow numbering's cache-loss limitation, 60-second follow/5-minute raid stale safety, and immediate raid shoutouts. Inspect separate skipped/dead health signals and near-expiry backlog.
8. Monitor retained backlog and TTL headroom, unbounded session/beneficiary BSON size below 16 MiB, and permanent Redis key memory growth. Do not prune permanent receipts as routine maintenance. This pipeline is not a replacement for provider accounting records.
