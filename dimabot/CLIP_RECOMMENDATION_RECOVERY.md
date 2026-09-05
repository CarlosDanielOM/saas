# Clip Recommendation Recovery

The VOD clip worker uses its dedicated Dragonfly queue, not a new domain-event consumer. Analysis, billing, notification, and failed-preview cleanup have separate persisted recovery state on `ClipRecommendation` records.

## Recovery Rules

- Completed analysis is reused when billing or notification fails. Recovery jobs cannot recreate a deleted record or start a new paid analysis.
- The original queue-job ID remains the billing identity. Polar ingestion receives the same `externalId` on retries; provider-side deduplication remains part of this guarantee.
- Reconciliation includes completed analyses with either pending or failed billing, charged analyses with outstanding notifications, and failed uncharged analyses with pending preview cleanup.
- Recovery jobs use `source: recovery` and retain `originalSource`. They do not reuse the permanent stream-offline acceptance marker; the original automatic trigger remains one-shot.
- Reconciliation rotates queued records out of its limited scan using conditional retry-date updates. It must not overwrite a newer deadline written by the running workflow.
- Queue acknowledgement, requeue, dead-letter, and startup recovery scripts check worker-lock ownership. Requeue/dead-letter writes happen before removing the processing claim, so a failed destination write does not lose the claim.
- The workflow checks ownership before destructive/provider operations and phase writes. This does not make Redis leases atomic with Mongo or external APIs; retain the single-worker deployment model.

## Email And Preview Safety

The complete email payload (recipient, sender, subject, HTML, and text) is persisted before sending. Retries reuse that payload and the same Resend idempotency key even if user settings or templates change. The payload is excluded from default database projections; the worker explicitly loads it for recovery.

An absent email address is `not_required`, not `sent`. Provider idempotency has a bounded retention window, so an uncertain send retried after that window can still duplicate. Do not describe this as exactly-once email delivery.

Preview deletion validates every object key against the recommendation's own channel/record prefix before deleting anything. If upload succeeded before saving its key, cleanup reconstructs the deterministic key from the persisted candidate ID. Failed cleanup retains an error and retry deadline. A failed or ambiguous final-analysis save must not cause a completed/charged recommendation's previews to be removed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLIP_RECOMMENDATIONS_RECONCILIATION_INTERVAL_MS` | 900000 | Periodic recovery scan interval |
| `CLIP_RECOMMENDATIONS_RECONCILIATION_BATCH_SIZE` | 25 | Records examined per scan; query capped at 500 |
| `CLIP_RECOMMENDATION_BILLING_RETRY_DELAY_MS` | 21600000 | Billing-failure deadline for later reconciliation |
| `CLIP_RECOMMENDATION_NOTIFICATION_RETRY_DELAY_MS` | 3600000 | Notification and failed-preview-cleanup retry delay |
| `CLIP_RECOMMENDATION_ORPHAN_STALE_HOURS` | 24 | Legacy unkeyed-record cleanup age |

Normal bounded queue retries can occur before the next reconciliation scan; these deadlines do not change the queue's existing attempt policy.

## Legacy Orphans

The maintenance command reports stale, uncharged pending/processing records without a queue-job ID. With `--execute`, it marks matching records failed. It does not charge users, rerun analysis, or delete S3 objects.

Both modes connect to MongoDB. Run them only on the production host, not this development workstation:

```bash
npm run cleanup:orphaned-clip-recommendations
npm run cleanup:orphaned-clip-recommendations -- --execute
```

## Local Verification

From `dimabot/`, without database or provider connections:

```bash
npm run build
node --experimental-test-module-mocks --import tsx --test 'src/utils/ai/clip_recommendations/*.test.ts'
npx tsx src/workers/vod_clip_recommender.worker.ts --dry-run
```

Queue-script tests execute the actual Lua with mocked Redis commands when a standalone Lua interpreter is installed. This is not a live Dragonfly integration test. Production verification of queue recovery, billing deduplication, email delivery, and S3 deletion remains separate.
