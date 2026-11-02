# Currency and Monthly Goals

**Status: cron, API, bot, and site were deployed and production-checked; helper cleanup is complete.** This adds estimated currency goals, calendar-month periods, and an explicit custom-item contribution path to the existing goals feature. It does not verify provider payouts, charge viewers, perform currency conversion, or add a sales-provider adapter.

## Currency units and goal configuration

The API stores every currency amount as an integer in the currency's minor unit (cents for the supported currencies). The site parses decimal input directly into minor units and formats it without floating-point division. Supported two-decimal currencies are USD, EUR, GBP, CAD, and AUD. Currency rates are set by the broadcaster and are estimates: bits, subscriptions, and configured custom items contribute according to those rates, not a provider's verified payout amount.

For example, a USD target of `$250.00` is stored as `25000` cents. With a configured rate of one cent per bit and `$1.75` per subscription, 250 bits plus three subscriptions contribute `250 + 3 × 175 = 775` cents (`$7.75`). For a custom item priced at 250 cents gross, a 10% configured fee yields 225 cents net per item; quantity three contributes 675 cents. A 20% fee yields 200 cents per item. The backend uses integer/BigInt arithmetic and rounds once per transaction. Rates and fees are configuration estimates; no FX, actual payout verification, charge, or Streamloots adapter is included.

Currency goals are available when creating goals on Premium or Pro, like Bits goals. Free users cannot create new currency goals, but an existing currency goal remains readable and continues accumulating after a downgrade. A created goal's metric, mode, currency, rates, item list, and time configuration are immutable; the API allows edits to name, target, and completion/failure actions. Existing `total` remains the since-creation count mode. `current` remains a live-ledger view for follows/subscriptions and cannot be selected for Bits or currency.

Goals may use a fixed period with a chosen start/end time or a recurring calendar month in a broadcaster-selected IANA time zone. Monthly mode applies to existing count metrics as well as currency. It resets on the local calendar-month boundary, including daylight-saving changes, rather than after a fixed number of days. Monthly cursors start in the goal's creation month; old retained events are not backfilled into a new goal. The current month has a separate outcome from each closed month.

The monthly worker advances at most one closed month per goal per pass. During catch-up, outcomes older than the immediately previous month are recorded with `actionSuppressed: historical_catchup`, avoiding a burst of old announcements; the previous month can still run its selected action. Late events remain assigned to their occurrence month and do not rerun an already settled outcome. Outcomes are keyed by goal and month, so an older `unknown` action result does not block the next month's transition. Action delivery remains external and at-least-once around acknowledgement loss; a stale running result becomes unknown and is not automatically retried.

## Custom item contributions and trust boundary

The custom-item syntax is `$(goal.add item_name quantity [receipt_id])`. Each currency goal defines up to twenty item keys, gross unit amounts, and fee rates. One accepted item event updates every time-eligible currency goal for that channel whose configuration contains the item, using each goal's own rate. This is a contribution accounting mechanism, not a verified sale or payment flow.

The AST function accepts authority only from opaque context minted at verified Twitch ingress and scoped to a stored command or configured EventSub path. For chat-originated AST, the signed actor must be the broadcaster or a moderator/lead moderator. Configured Twitch event actions carry their stored EventSub configuration scope. Without opaque context, the handler requires an independently authorized moderator chat identity, explicit receipt ID, and command/action scope. Viewer-supplied badges, authored privilege elevation, LLM calls, and simulation do not confer mutation authority; simulation records `goal.add` as a proposed action without journaling it.

Accepted contributions enter Mongo's domain-event journal as `goals-custom` / `goal.item.added` before the producer acknowledges success. The `goal-custom-contributions-v1` consumer projects the event into contribution rows. Event identity includes channel and the scoped origin/receipt identity; per-goal contribution IDs prevent duplicate projection. The permanent `goal_custom_receipts` record survives the journal's 90-day retention and fences receipt reuse with a different item or quantity. Replayed events retain their first occurrence time, and a newly created goal does not receive historical contributions.

For a configured durable EventSub action, a transient failure to journal a required contribution throws `RequiredGoalContributionError`, allowing the announcing event delivery to retry. Invalid input and receipt conflicts are permanent business errors, not automatic retry signals. The event journal, consumer delivery, and an external chat/AST effect are not a cross-system transaction.

## Rollout and rollback boundary

Runtime scope is cron (goal event consumers and monthly settlement), API (goal configuration/snapshot), and bot (the AST custom-contribution producer), plus the public site goal controls. The domain-event registry increases from fourteen to fifteen consumer children; TypeScript worker definitions are unchanged. Roll out cron consumers first, then API and bot producers, then the site controls. The existing API cannot create the new currency/monthly configurations before its update, and new producers must not emit data for a cron consumer that does not understand the new event types.

Do not treat rollback to old cron/API/bot images as unconditionally safe after new currency/monthly goals or custom goal events are accepted. Older code does not understand every new goal mode/configuration or the new consumer. Before rollback, stop new producers and make a read-only assessment of new goal records, monthly outcomes/cursors, journaled custom events, deliveries, and checkpoints. Prepare a reviewed compatibility/handling plan; no automatic data migration makes old-image reads safe.

## Verification status

The reviewed service-free domain-event source suite passed 542/542 tests with zero skips. Each cron, API, and bot exact candidate passed [`currency-goals.mjs`](../ops/checks/currency-goals.mjs) with 62/62 focused tests, using private disposable MongoDB/Redis; the runtime source was identical across all three. The cron check used the actual supervisor and goal consumers. It covered the `$7.75` Bits/subscription example, fee arithmetic, 32 concurrent duplicate invocations, durable receipt replay after journal expiry, the no-backfill fence for newly created goals, and monthly outcomes, compare-and-set, DST/year boundaries, and fixed-period end handling. The API candidate also exercised actual API permission and currency-configuration validation against the isolated candidate, not production.

The final cron candidate additionally passed the existing [`goals.mjs`](../ops/checks/goals.mjs) compatibility check with 59 compiled tests covering prior runtime scenarios, actions, and held/unknown outcomes. The composite service-free pipeline verification exited successfully and asserted zero failures and skips; the separate 542-test source count above was independently reviewed. Candidate checks caught a Mongoose minimization issue that removed empty event `metadata` at both envelope boundaries. The fix was applied at both boundaries and covered by a red/green regression. The isolated site dev preview passed [`currency-goals-browser.mjs`](../ops/checks/currency-goals-browser.mjs) across seven contexts: 320, 390, and 1280 pixel viewports in dark and light themes, plus 390 pixel Spanish dark mode.

### Deployment and production acceptance

The exact checked runs were deployed in this order:

| Target | Run / image or bundle | Production start or publish |
| --- | --- | --- |
| Cron | `cron-e1e4a0e11c56` / `sha256:d7ace20fbfe6b9721ee80af20f4610deecafe8f02edeb3bdc4f8c257b1084a13` | 2026-11-02 03:52:02.731397392 UTC |
| API | `api-b01f0f61e59b` / `sha256:320eca69a0cd57f3e6df318b9714ea7c2bab518c019f6713182ad0990c619cb5` | 2026-11-02 03:52:21.818483121 UTC |
| Bot | `bot-09feb128e7e0` / `sha256:d745ff094ee2bff9676379ece5b579ff91b295cab74a1ac5a04eac1983f47725` | 2026-11-02 03:52:41.344637411 UTC |
| Site | `site-a8608c2425bf` | Published after bot |

The site candidate browser check passed all seven contexts against the exact production bundle, matching the isolated preview. All 227 published files matched the tested bundle byte-for-byte. Among 18 production containers, only `dima-cron`, `dima-server`, and `dima-bot` changed; the site container remained unchanged. Readback showed 18 TypeScript workers, 15 domain-event consumers, seven native workers, and one native index. Process IDs remained stable across samples, with no application/container restarts. Native health readback reported eight healthy RSS samplers, three successful health queries, and seven healthy batch workers with idle or successful results, with zero errors, exits, or restarts.

Scoped production checks returned 200 from the public goals route and API configuration endpoint, 401 for anonymous access to the private goals route, and 403 for an unsigned bot request. Mongo readback confirmed the unique `goal_custom_receipts._id` index. The collection still had zero receipts, and the pre-existing follow goal remained present. No synthetic production goal or sale was inserted; feature completion scenarios were exercised only against isolated dependencies, and no natural custom-goal completion occurred during the watch. Helper cleanup is complete for all four delivered runs; run receipts and rollback artifacts remain retained. The superseded cron run `cron-32fb6b1b5716` was also cleaned up. No helper verification containers or networks remain, and the loopback site preview on port 4202 was stopped.

## Source references

- [Goal model and validation](../dimabot/src/goals/model.ts), [currency arithmetic](../dimabot/src/goals/currency.ts), and [calendar-month boundaries](../dimabot/src/goals/monthly.ts)
- [Goal API and contribution projection](../dimabot/src/goals/service.ts), [monthly settlement](../dimabot/src/goals/completion.ts), [goals route](../dimabot/src/server/routes/goals.route.ts), and [worker](../dimabot/src/workers/goals.worker.ts)
- [Custom goal producer](../dimabot/src/domain_events/goal_custom_events.ts), [consumer registry](../dimabot/src/domain_events/domain_event_consumers.ts), [AST goal function](../dimabot/src/utils/ast_parser/functions/goals.functions.ts), [opaque AST effect scope](../dimabot/src/utils/ast_parser/effects.ts), and [required delivery error](../dimabot/src/utils/ast_parser/required_goal_contribution_error.ts)
- [Goal dashboard controls](../dimasite/src/app/features/dashboard/components/goals/goals.component.ts), [goal form](../dimasite/src/app/features/dashboard/components/goals/goals.component.html), and [minor-unit parsing/formatting](../dimasite/src/app/features/dashboard/components/goals/goal-amounts.ts)
- [Currency/monthly tests](../dimabot/src/goals/currency_monthly.test.ts), [monthly settlement tests](../dimabot/src/goals/service_monthly.test.ts), [AST authority tests](../dimabot/src/utils/ast_parser/goal_contribution.test.ts), [exact-candidate check](../ops/checks/currency-goals.mjs), and [isolated browser check](../ops/checks/currency-goals-browser.mjs)
