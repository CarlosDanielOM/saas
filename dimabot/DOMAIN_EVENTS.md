# Domain Event Pipeline

Transport-specific producers publish to independently delivered backend consumers. MongoDB owns the journal, dispatch intent, deliveries, checkpoints, retries, and dead letters. Dragonfly Streams only wake the worker; polling must work without those hints.

This foundation defines envelope, producer, and consumer contracts. It does not yet implement configurable goals, the extensible timer, PayPal, Kick, TikTok, a public subscription API, or a common cross-platform contribution payload. Twitch v1 payloads retain their shipped EventSub shape.

## Ownership

- `ownerUserId` is the internal `users._id`, not a login or provider channel ID. It may be unresolved at ingestion.
- `users.accounts` contains streaming-platform identities. Match platform and remote ID in one `$elemMatch`; separate dotted predicates can match different array elements.
- The separate `accounts.schema.ts` model is intended for add-ons such as PayPal or Spotify. It currently has no active integration lookup path. Do not invent an ownership link through its legacy `channelID` field.
- Existing enum values, including Spotify in the embedded account enum, remain for persisted-data compatibility; they do not establish an implemented integration.
- `subject` contains `{ provider, kind, id }`. Kinds distinguish streaming accounts, integration accounts, provider customers, and other provider resources.
- `channelID` remains required for channel-topic events. Account-level billing does not fabricate one.
- Polar resolves by `users.polar_sh_customer_id`, then a verified external customer ID referencing an internal user. The shipped `twitch_user_id` metadata fallback remains for legacy customers, guarded against a different Polar customer link. An explicit conflicting/deleted owner does not fall through to that fallback.
- Resolution does not create users, move accounts, or persist new integration links. Supported billing consumers retry unresolved owners and eventually dead-letter them for operator repair/replay.

Contracts: `src/domain_events/domain_event.types.ts`. Current lookups: `src/domain_events/domain_event_identity.ts`.

## Adding A Producer

1. Implement `DomainEventProducer<Input>` with a provider name, pure `normalize(input)`, and optional `resolveOwner(event)`.
2. Authenticate at the transport boundary before ingestion. Verify webhooks using the original signed bytes. Socket/polling adapters use the same ingestion function after their own authentication.
3. Return a validated `JournalDomainEventInput` with stable source identity, a real subject, semantic type, schema version, occurrence time, and minimal payload. Returning `null` explicitly excludes an event.
4. Register in `DOMAIN_EVENT_PRODUCERS` in `src/domain_events/domain_event_producers.ts`.
5. Call `ingestDomainEvent(adapter, input)`. Acknowledge only after ingestion succeeds; do not execute the same business effects inline as well.
6. Test normalization, authentication, duplicate receipts, and journal failures with synthetic inputs, including real installed-SDK transformations where applicable.

`sourceEventId` identifies a provider delivery, not merely its resource. Different resource updates need distinct receipt IDs. Business effects can additionally deduplicate by an order ID across multiple deliveries.

The engine does not interpret tokens, checkout metadata, billing rules, or chat protocols. Owner lookup belongs to the adapter. SaaS billing is distinct from viewer contributions: a Polar plan purchase is not a streamer donation.

## Adding A Consumer

Register a stable ID, topics, supported schema versions, Mongo event filter, and handler in `src/domain_events/domain_event_consumers.ts`. Lazy handler imports keep registry inspection and dry-runs service-free.

```ts
// Illustrative registration; goals are not implemented yet.
{
    consumer: 'goals-v1',
    topics: ['channel'],
    schemaVersions: [1],
    eventFilter: {
        source: 'twitch-eventsub',
        type: { $in: ['channel.bits.received', 'channel.follow.received'] }
    },
    handler: applyGoalEvent
}
```

Mongo evaluates filters, not a partial JavaScript emulation. Explicit source scope prevents Twitch handlers from acting on similarly named events from other providers. Handler failures must propagate; logging and returning falsely completes a delivery.

The worker runs bounded drains sequentially and catches per-consumer infrastructure failures. This is error isolation, not independent CPU/latency isolation.

Define history policy before adding/changing a consumer. A new consumer without a checkpoint scans matching retained history; changing an existing filter does not rewind it. Use a new consumer/version and explicit eligibility boundary for controlled rebuilds. Rebuilding progress must not resend unrelated announcements or repeat timer/reward increments.

## Recovery

1. Each new journal insert includes `dispatchPending: true` and requests journaled acknowledgement.
2. The dispatcher scans the marker independently of checkpoints and creates all matching registered deliveries idempotently.
3. It clears the marker only after those deliveries exist. Partial failure leaves the marker available for another pass.
4. Consumers independently claim pending deliveries, due retries, and expired processing leases. Lease tokens protect completion/failure writes.
5. Checkpoint scans remain for retained-history backfill and older journal rows.

A lower ObjectId whose insert finishes after a checkpoint advances is still discoverable through its dispatch marker/delivery. ObjectId order is not provider occurrence order; projections must define their own late-event rules.

Delivery remains at-least-once. Database effects must be idempotent. Twitch chat can duplicate if a message is accepted but its response or completion acknowledgement is lost.

New Twitch production events carry `metadata.durableChatHandled: true`; only marked events enter durable chat/account-health consumers. Unmarked historical announcements are not replayed. Authenticated test events retain immediate behavior. Follow numbering uses a 48-hour Dragonfly receipt, not permanent deduplication or protection after cache loss.

## Polar

`POST /polar/webhook` verifies raw bytes with the Polar SDK, then journals rather than calling the old inline handler. Receipt identity is the signed `webhook-id` header. CamelCase SDK fields and `Date` instances are normalized once into billing payloads.

| Provider Event | Domain Event | Consumers |
| --- | --- | --- |
| `order.paid` | `billing.order.paid` | Plan, paid-order reward |
| `subscription.updated` | `billing.subscription.updated` | Plan only |
| `customer.state_changed` | `billing.customer.state.changed` | Credit snapshot/cache |
| Other SDK-validated types | `provider.polar.<type>` | Retained, no automatic billing effects |

Unmapped SDK-validated types retain JSON-safe provider data for future subscribers. They are not failed deliveries merely because nobody subscribes. Types the installed SDK cannot validate are still rejected at ingestion. Refund/reversal policy and additional subscription-lifecycle mappings are separate work, not automatically enabled by retaining those events.

- `polar-plan-v1` updates known plan products on the internal user without requiring Twitch. Provider time and event-key tie breaking guard the Mongo snapshot. Twitch account caches are invalidated rather than overwritten with stale event snapshots. Existing cancellation/entitlement policy is not redesigned here.
- `polar-credits-v1` persists the latest normalized meter snapshot. One Lua operation projects credits, exhaustion flags, and an ordering version to each linked Twitch account. Credit-cache expiry does not erase the version. Existing credit calculations and legacy-meter fallback remain.
- `polar-rewards-v1` rewards confirmed paid orders of supported paid plans only. Subscription status changes do not issue rewards. Amounts and active-referrer-or-bot recipient selection remain unchanged.

### Standalone Reward Safety

`src/utils/paid_order_reward.ts` uses no multi-document transactions:

1. A unique `CreditTransaction` reservation, `polar:paid-order:<orderId>`, freezes amount and recipient.
2. One atomic user update increments `token_balance` and adds the transaction ID to `applied_credit_transaction_ids`.
3. The history row is marked applied. A retry after response loss checks the user receipt and finishes history without incrementing again.

All three writes request journaled acknowledgement. A reserved history row alone is not proof that credit was applied. If recovery cannot reconstruct the original post-credit balance, `balanceAfter` stays null rather than reporting a made-up historical balance.

Receipt IDs are hidden from default user projections and retained permanently. Do not prune receipts or delete/recreate idempotency records during normal operation. This trades storage growth for standalone safety: monitor high-volume beneficiary document sizes before Mongo's document-size limit is approached. Future compaction must preserve deduplication and account for in-flight workers.

Legacy paid-order reward rows prevent another credit for an already handled old order. Their historical partial-write ambiguities are not automatically repaired. Channel/domain journal retention defaults to 90 days; reward records are not TTL-expired with the journal. This operational pipeline is not a replacement for provider accounting records.

## Rollout And Verification

This workstation is development-only. No Docker, databases, production webhooks, or live payment tests may run here.

- Deploy the matching cron registry before enabling a new producer on the production host. Avoid overlapping dispatcher registries while changing subscriptions: dispatch prepares deliveries for its current registry, not hypothetical future consumers.
- Confirm journal/dispatch indexes and the unique paid-order reservation index on the production host. No local database migration or index creation has been run.
- Verify customer mappings, recovery after cache failure, and one reward across duplicate paid-order deliveries on the production host using an appropriate test setup.
- Existing super-admin listing/replay endpoints live under `/admin-site/domain-events`. Repair missing ownership before replay. Do not delete checkpoints or receipt markers to force recovery.
- Local mocks cover query predicates, update shapes, response-loss recovery, and signed SDK transport. They do not establish live Mongo/Dragonfly atomicity, index performance, or production payment behavior.

Local commands, from `dimabot/`:

```bash
npm run build
npx tsx --test 'src/**/*.test.ts'
npx tsx src/workers/domain_events.worker.ts --dry-run
```
