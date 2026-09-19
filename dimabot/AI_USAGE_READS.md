# AI usage query behavior

The authenticated routes remain `GET /billing/ai-usage/summary` and
`GET /billing/ai-usage/transactions`. Existing owner/delegated dashboard access
checks and Free/Premium/Pro gates apply. Polar credit and cost calculations are
unchanged. Credit balances still come from the billing service; Mongo stores
receipts and derived analytics only.

## Summary and pacing

The summary includes `summaryUpdatedAt`, `ledger`, and `pacingPeriod`.
Custom chart date ranges change analytics, while pacing continues to use the
current subscription cycle or Free account anniversary period.

Pacing adds `confidence` (`low`, `medium`, `high`), `confidenceReasons`,
`recentAverageDailyCredits`, and `recentHistoryDays`. Confidence is a heuristic,
not a probability. Fewer than seven covered days, fewer than three active days,
or a pending backfill yields low confidence. At least 21 days and seven active
days with a coefficient of variation at most one yields high confidence;
other sufficiently covered cases yield medium confidence.

Historical rates use completed UTC days within the plan retention and known
coverage, including zero-spend days. The partial current day is excluded. At
least seven completed days are required for the long-term rate; otherwise the
current cycle rate is used. Recent pace uses at most seven completed days.
Forecasts add already-used cycle credits to the selected rate multiplied by
remaining cycle days. Balance and quota values are never modified by forecasts.

A compact `ai_usage_dashboards` document stores the requested window's daily,
category, adjustment totals and historical rate statistics. The first request
for a window computes Mongo aggregates without downloading all receipts.
Subsequent requests reuse that document. Receipt/backfill writes mark documents
dirty; the receipt worker refreshes up to 20 documents every ten seconds, and a
read refreshes a dirty or more-than-60-second-old document. Documents expire
after one day. Pacing is computed from those statistics and the current balance
at request time so its exhaustion date stays current. A new cycle/date/timezone
or tier gets a new snapshot key; tier changes remove old snapshots.

`ledger.status: pending` identifies incomplete imported history. The API returns
available totals and queues a background backfill; clients should communicate
that those totals are still loading. New producer receipts retain their source;
older receipts without source metadata remain unknown until a Polar backfill
supplies it. No prompts or message contents enter these records.

## Transactions (Pro)

Existing `from`, `to`, `timezone`, `category`, `cursor`, and `limit` remain.
Additional exact-match filters are `source`, `requestId`, `resourceId`,
`entryKind=usage|adjustment`, and `adjustmentType`. Queries sort descending by
timestamp and entry ID and fetch at most `limit + 1` rows (limit 1–100). Cursors
bind to the account, date boundaries and filters. A cursor remains usable after
the previous receipt expires or is removed. Continue with the same filters.

Receipts expose `source` and `adjustmentType`. Adjustment types are
`manual_grant`, `monthly_reset`, `purchased_pack`, `refund`, `correction`,
`activation`, and `other`. Unknown historical adjustments remain `other`.
These names describe metadata; they do not implement pack purchasing or refunds.
Summary `adjustments` groups grants and debits separately from consumption.
Positive adjustment debits appear in `adjustmentDebitedCredits`, and
`netConsumedCredits` includes them. Usage categories, daily consumption and
historical pace exclude adjustments.

## Queue recovery and monitoring

Receipt jobs are FIFO. Failed jobs retry up to three times and then move to
`cron:ai-usage-receipts:queue:dead`; backfills use
`cron:ai-usage-backfills:dead`. Atomic Redis moves retain the original payload.
Processing claims are reclaimed after restart under a worker lease. Receipt
replays rebuild derived daily rows, including after a crash between receipt and
aggregate persistence. Receipt and backfill writers share an account lease.

The receipt worker checks both queues every ten seconds. Health snapshots are
available at `ai-usage:queue-health:receipts:snapshot` and
`ai-usage:queue-health:backfills:snapshot` with a five-minute TTL; absence means
monitoring has stopped reporting. Logs warn about pending age or processing age
above 900 seconds, any dead letters, or at least three new failures per check.
Warnings are throttled to once per queue per five minutes and go through the
existing console/cache logger. No email or Slack messages are sent.

Threshold environment variables: `AI_USAGE_QUEUE_MAX_AGE_SECONDS`,
`AI_USAGE_PROCESSING_MAX_AGE_SECONDS`, `AI_USAGE_QUEUE_FAILURE_THRESHOLD`.
A backfill consumer lease prevents two consumers reclaiming each other's work.
Dead letters require operator investigation before replay; no automatic credit
or billing adjustments are made as a recovery action.
