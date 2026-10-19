# Analytics tracking checklist

This is the backlog for streamer-facing analytics and product adoption. It is source-audited only: checkmarks mean matching code exists in this checkout, not that events are arriving correctly or production dashboards show them. No production data, dashboards, or live event coverage were audited. `dima-analytics` itself stores application observability and infrastructure telemetry; do not treat its service, queue, database, or resource metrics as streamer behavior ([service scope](README.md#data-flow-and-collection)).

Source review date: 2026-10-19. When work starts on an unchecked item, record `In progress` or `Blocked`, its owner, and issue/link in the item; update status and evidence when resolved.

Status: `[x]` the stated source fact is present; `[ ]` remaining work. A checked source fact does not imply a complete report or verified production data. Partially covered metrics have a checked source fact and separate unchecked gaps. Priorities: P0 core streamer questions, P1 useful follow-up, P2 later/product operations. Evidence links point to source, not live verification.

## Stream activity and engagement

- [x] **STR-01 · P0 · Stream sessions and audience size.** Open/close sessions; record sampled current viewers, average viewers, and peak viewers; expose per-stream history and dashboard totals. Dimensions: channel, stream/session, start date, game/title snapshots. Existing source: [`stream_analytics.ts`](../dimabot/src/utils/stream_analytics.ts) and [`stream_session.schema.ts`](../dimabot/src/schemas/stream_session.schema.ts). Current/history semantics and sampling gaps should be made clear in reports.
- [x] **STR-02 · P0 · Chat message volume.** Count received messages during a live session. Dimensions currently channel/session/time; history stores totals and snapshots. Existing source: [`stream_analytics.ts`](../dimabot/src/utils/stream_analytics.ts), [`message.handler.ts`](../dimabot/src/handlers/message.handler.ts). No offline message totals are implied.
- [x] **STR-03 · P0 · Active chatters and chat rate — source partial.** Timeline records one receipt per chatter per five-minute session bucket and derives messages/minute from snapshot deltas. Dimensions: channel/session and five-minute bucket. Existing source: [`stream_timeline.ts`](../dimabot/src/utils/stream_timeline.ts).
  - [ ] Define unique chatters per stream versus rolling active chatters; surface coverage start, sparse sampling, retention, and truncated/null buckets. Never sum bucket uniques into stream uniques or interpret unknown coverage as zero.
- [x] **STR-04 · P0 · Commands used — collection exists.** Live session command total, private command spans, and external PostHog `command_executed` events exist. Sources: [`stream_analytics.ts`](../dimabot/src/utils/stream_analytics.ts), [`message.handler.ts`](../dimabot/src/handlers/message.handler.ts), [`telemetry.ts`](../dimabot/src/utils/observability/telemetry.ts), [`posthog_events.ts`](../dimabot/src/utils/posthog_events.ts). PostHog is external instrumentation, not the private analytics store.
  - [ ] Build channel-safe command counts/rankings over time and success rate; define timer/custom/built-in treatment and source of truth. Do not include command arguments in a streamer report.
- [x] **STR-05 · P0 · Channel point redemptions — timeline markers exist.** Stores ID-deduplicated reward-title markers. Sources: [`stream_timeline.ts`](../dimabot/src/utils/stream_timeline.ts), [`redemption.handler.ts`](../dimabot/src/handlers/redemption.handler.ts).
  - [ ] Add useful totals/rankings; decide whether cost/completion outcomes are needed. Distinguish reward definitions from redeemed instances and avoid user-entered redemption text.
- [ ] **STR-06 · P0 · Emote usage.** No per-emote usage aggregate was found in the audited analytics path. Count by stable emote ID and provider/platform, with channel/session/time dimensions; define both occurrence count and messages containing an emote, plus how repeated emotes in one message count. Parse emote metadata without retaining chat text.
- [x] **STR-07 · P1 · Stream timeline context — source partial.** Timeline includes viewer snapshots, title/game changes, raids, and redemption markers. Existing source: [`stream_timeline.ts`](../dimabot/src/utils/stream_timeline.ts).
  - [ ] Add clear coverage indicators, event-family counts, and cross-stream comparison; snapshots and event lists are bounded and may be incomplete.

## Growth, support, and modules

- [x] **GRW-01 · P1 · Follows and subscriptions — collection partial.** Session totals are projected from EventSub; subscription ledger stores lifecycle records. Sources: [`stream_analytics.ts`](../dimabot/src/utils/stream_analytics.ts), [`stream_analytics_events.ts`](../dimabot/src/domain_events/stream_analytics_events.ts), [`stream_subscription_ledger.schema.ts`](../dimabot/src/schemas/stream_subscription_ledger.schema.ts).
  - [ ] Define/report net growth, unfollows/churn, resubs/gifts, tier breakdown, and date windows.
- [x] **GRW-02 · P1 · Bits — session total exists.** Source: [`stream_analytics.ts`](../dimabot/src/utils/stream_analytics.ts).
  - [ ] Donation recording helper exists, but no producer calling it was found in source. Wire and verify an authorized source; define provider, currency, and event coverage before claiming donations/revenue are tracked.
- [ ] **GRW-03 · P1 · Returning and first-time chatters.** Define per-stream first visit versus returning chatter, retention windows, and identity coverage. Never infer cross-stream retention from five-minute timeline buckets alone.
- [ ] **GRW-04 · P1 · Moderation activity.** Count moderation actions by action type and outcome, with channel/session/time dimensions; decide whether to distinguish bot, streamer, and moderator initiators. Exclude message contents and review access/privacy before exposing.
- [ ] **MOD-01 · P1 · Module adoption and outcomes.** Define enabled versus used modules and meaningful outcomes (trigger runs, TTS requests, clip queue completions, redemption flows), with channel, module, date, and success/failure dimensions. PostHog covers some TTS/AI operations; no unified adoption report was found. Avoid equating configuration with usage.
- [ ] **MOD-02 · P2 · Feature participation.** Audit polls, predictions, giveaways, games, and loyalty/reward interactions; define participation and outcome counts by feature, channel/session, and time. Do not assume operational state or configuration equals audience use.
- [ ] **MOD-03 · P2 · DimaFX shop.** Define shop views, purchases/redemptions, fulfillment outcomes, and repeat use with extension/channel/time dimensions. Audit event sources and dedupe before adding metrics; no end-to-end streamer analytics coverage was confirmed here.
- [x] **PROD-01 · P2 · Site instrumentation exists.** The site has PostHog pageviews, identity, and a generic capture API; backend PostHog has selected command, TTS, and AI events. Sources: [`analytics.service.ts`](../dimasite/src/app/services/analytics.service.ts), [`posthog_events.ts`](../dimabot/src/utils/posthog_events.ts).
  - [ ] Define adoption funnels (signup/activation, module setup, first successful use, return usage, plan conversion), event ownership, consent/retention, and reporting. Keep private infrastructure charts separate.
- [ ] **PROD-02 · P2 · Reports and exports.** Decide which stream analytics need date-range comparison, saved reports, or export; document supported windows and missing-data behavior before implementing.

## Proposed tier capabilities — discussion only

Draft product direction; final entitlements and history windows remain open. Analytics depth is separate from plan credit allowances. Essential credit balance and spending information remains a baseline. This matrix does not describe current enforcement for stream metrics; existing AI usage gates are noted separately below.

| Area | Free (proposed) | Premium (proposed) | Pro (proposed) |
| --- | --- | --- | --- |
| Commands | Most-used commands by count | Daily breakdowns and trends | More detail; per-user only when attribution exists and access is authorized |
| Emotes | Top emotes by occurrence/message count | Per-day and trend breakdowns | More detail; per-user only with verified attribution |
| Redemptions and chatters | Essential totals and stream view | Per-day, stream, and audience activity trends | More detailed breakdowns; user-level views only when justified and authorized |
| Credit usage | Balance, used/remaining/limit, applicable reset/expiry, spending and adjustment totals/explanations | Daily and category/source analysis | Itemized operation/provider/model detail where recorded; per-user only with attribution |
| Reports | Basic current/history view | Date comparisons and richer breakdowns | Detailed reports and candidate export, subject to privacy/access review |

Treat all cells as options to resolve through TIER tasks. Existing billing source: [`billing.route.ts`](../dimabot/src/server/routes/billing.route.ts) exposes balance/pacing capabilities for all tiers, daily/category summaries for Premium and Pro, and currently gates itemized AI transactions to Pro. AI usage history currently has 30/60/90-day Free/Premium/Pro retention in [`ai_usage_ledger.ts`](../dimabot/src/utils/ai_usage_ledger.ts); that is not a stream analytics retention decision.

## Credit usage and spending transparency

- [x] **CREDIT-01 · Current source facts.** Billing APIs expose a credit snapshot for authorized channel access; AI usage receipts store channel/customer, time, entry kind, category, operation, source, provider/model, quantity/unit, credits, resource references, itemization, and expiry. Existing sources: [`billing.route.ts`](../dimabot/src/server/routes/billing.route.ts), [`ai_usage_receipt.schema.ts`](../dimabot/src/schemas/ai_usage_receipt.schema.ts), [`ai_usage_event.ts`](../dimabot/src/utils/ai_usage_event.ts).
  - [ ] Define an all-tier essential view of balance, used, remaining, limit, applicable reset/expiry, and spending/credit-adjustment totals and explanations. Keep raw billing balances authoritative and distinguish unavailable/pending history from zero. Preserve the existing Pro-only detailed AI transaction access unless a reviewed policy explicitly changes it.
- [x] **CREDIT-02 · Existing tier behavior and source distinctions.** Current flags expose balance/pacing to all tiers, daily/category summary to Premium and Pro, and itemized AI transactions to Pro. Adjustment classifications include `manual_grant`, `monthly_reset`, `subscription_credits`, `purchased_pack`, `gifted_credits`, `native_grant`, `refund`, `correction`, `activation`, and `other`; source classification distinguishes subscription, purchased, and gifted credits only when provider evidence is sufficient. Sources: [`billing.route.ts`](../dimabot/src/server/routes/billing.route.ts), [`ai_usage_classification.ts`](../dimabot/src/utils/ai_usage_classification.ts), [`ai_credit_sources.ts`](../dimabot/src/utils/ai_credit_sources.ts).
  - [ ] Decide source breakdown by tier; report unknown when correlation is ambiguous and preserve source-specific rollover/expiry. Keep billing-cycle totals separate from calendar-day totals and label timezone/window.
- [x] **CREDIT-03 · Existing detail and attribution limit.** Pro itemized AI receipts include operation/provider/model fields when recorded, but [`ai_usage_receipt.schema.ts`](../dimabot/src/schemas/ai_usage_receipt.schema.ts) has no chatter/actor identity field; `customerId` identifies the billing customer, not an individual user.
  - [ ] Gate Premium daily/category/source detail and Pro operation/model/provider detail server-side per the final policy. Do not promise per-user credit usage until actor attribution exists; otherwise retain system/unknown attribution. Exclude prompts, chat text, and command arguments from analytics.
- [ ] **CREDIT-04 · Define accounting semantics.** Document credit usage/debits separately from monetary charges, and grants, resets, purchased/subscription/gift sources, refunds, and corrections. Define net consumed/spent calculations plus billing-cycle versus calendar-day windows so summaries reconcile to the authoritative balance. Existing aggregation source: [`ai_usage_dashboard.ts`](../dimabot/src/utils/ai_usage_dashboard.ts).

## Plan-tier enforcement tasks

- [ ] **TIER-01 · P0 · Resolve entitlements on the server.** Define the final tier matrix and enforce it using the resolved channel owner's `plan_tier` plus existing channel permissions. Never trust a browser-supplied tier, channel, or entitlement; preserve owner/admin permission behavior.
- [ ] **TIER-02 · P0 · Choose granularity and retention.** Set allowed aggregation levels and query windows per metric/tier. Decide whether retention varies by tier independently of report range; do not inherit AI receipt retention for stream analytics without an explicit decision.
- [ ] **TIER-03 · P1 · Define plan transitions.** Specify upgrades and downgrades: when detail/history becomes visible, what retained data remains queryable, and how expiration or re-eligibility works. Avoid accidental deletion or retroactive exposure.
- [ ] **TIER-04 · P0 · Gate queries and exports.** Apply tier checks to every API/query/export path, enforce row/channel scope and bounded ranges server-side, and use the UI only to explain available features. Preserve authorized existing access unless a reviewed policy explicitly changes it.
- [ ] **TIER-05 · P0 · Verify tier and tenant isolation.** Use disposable fixtures for each tier, permitted/denied channel grants, spoofed channel/tier filters, direct API/export access, and upgrade/downgrade transitions. Verify aggregates never leak another channel's or user's rows and unknown identity is not attributed to a chatter.

## Data quality and reporting

- [ ] **DQ-01 · P0 · Coverage and definitions.** For each shipped metric, document source, unit, timezone/window, dedupe rule, attribution, retention, sampling, and known missing periods. Show unknown or partial explicitly; validate counts against disposable fixtures before relying on production figures.
- [ ] **DQ-02 · P1 · Privacy and access.** Review event properties and viewer-facing access for every source, especially externally sent command/TTS properties. Keep chat messages, command arguments, user-entered redemption text, credentials, and request bodies out of private telemetry. Apply channel authorization and retention to new datasets.
- [ ] **DQ-03 · P1 · Reliability and reconciliation.** Measure dropped/late/duplicate events and source coverage for streamer metrics, and provide a way to detect/reconcile gaps. The private service already tracks telemetry buffer/collector health, but that only describes infrastructure. See [operational observability scope](README.md#data-flow-and-collection).

## Completion criteria

A planned row is complete only when its metric definition, minimum tier, granularity, and history window are agreed; the source and authorized channel scope are documented; ingestion is deduplicated and bounded; privacy/retention are explicit; and a relevant report exposes coverage and failure states. Verify behavior with disposable fixtures, including allowed/denied paths, duplicate, late, missing, and out-of-window cases; production validation must be recorded separately. Update this checklist only after inspecting the implementation and reporting path.

## New gaps

Add the next stable ID under the closest section using this template:

- [ ] **AREA-NN · P0/P1/P2 · Short metric name.** Definition and the question it answers. Dimensions: channel/session/time plus relevant bounded labels. Evidence or audit note: `path/to/source` (or “not found”). State the gap, owner/next action, and completion criteria.
