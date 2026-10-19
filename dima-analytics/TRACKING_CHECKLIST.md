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

## Data quality and reporting

- [ ] **DQ-01 · P0 · Coverage and definitions.** For each shipped metric, document source, unit, timezone/window, dedupe rule, attribution, retention, sampling, and known missing periods. Show unknown or partial explicitly; validate counts against disposable fixtures before relying on production figures.
- [ ] **DQ-02 · P1 · Privacy and access.** Review event properties and viewer-facing access for every source, especially externally sent command/TTS properties. Keep chat messages, command arguments, user-entered redemption text, credentials, and request bodies out of private telemetry. Apply channel authorization and retention to new datasets.
- [ ] **DQ-03 · P1 · Reliability and reconciliation.** Measure dropped/late/duplicate events and source coverage for streamer metrics, and provide a way to detect/reconcile gaps. The private service already tracks telemetry buffer/collector health, but that only describes infrastructure. See [operational observability scope](README.md#data-flow-and-collection).

## Completion criteria

A planned row is complete only when its metric definition and dimensions are agreed, the source and authorized channel scope are documented, ingestion is deduplicated and bounded, privacy/retention are explicit, and a relevant report exposes coverage and failure states. Verify behavior with disposable fixtures (including duplicate, late, missing, and out-of-window cases); production validation must be recorded separately. Update this checklist only after inspecting the implementation and reporting path.

## New gaps

Add the next stable ID under the closest section using this template:

- [ ] **AREA-NN · P0/P1/P2 · Short metric name.** Definition and the question it answers. Dimensions: channel/session/time plus relevant bounded labels. Evidence or audit note: `path/to/source` (or “not found”). State the gap, owner/next action, and completion criteria.
