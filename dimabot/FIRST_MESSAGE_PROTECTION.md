# First-message protection

**Source snapshot:** 2026-11-12. This guide describes the implementation in this checkout. It does not report any channel's live settings, and the asynchronous review path is best-effort rather than a delivery guarantee.

First-message protection is a category-based semantic chat check available on every plan in the moderation module. It runs before the channel's configurable rule filter. Free includes each eligible chatter's first observed message, Premium the first two, and Pro the first three. On eligible messages, it asks a model whether the message shows any selected behavior, and it schedules a permanent ban only for a sufficiently confident violation. Uncertain, unavailable, and allowed outcomes do not create an offense or stop the message in this protection check; enabled ordinary rules can still act afterward.

## What “first message” means

“First” refers to a chatter's first observed **eligible messages in a channel**, according to the bot's `moderation_chatter` marker: one on Free, two on Premium, and three on Pro. It does not mean Twitch account age, first-ever Twitch messages, first messages of a stream, or first messages after the setting is enabled.

The marker key hashes `(channelID, chatter user ID)`, so counting is channel-specific. Its `seen` field counts eligible observed messages up to 4, one past the maximum included on any plan. `claimObservedMessage` returns 1, 2, or 3 for those messages and 0 thereafter. An ineligible or exempt author may be skipped before the count is claimed. The count is claimed before plan and admission decisions, so a message consumes its ordinal even if no review is admitted or it times out. A legacy marker without `seen` is treated as past all included reviews and set to 4 on the next eligible message; previously seen chatters do not receive a second or third included review. See [`spam.ts`](src/utils/moderation/spam.ts) and [`moderation.handler.ts`](src/handlers/moderation.handler.ts).

Chat messages routed to moderation use the broadcaster/channel ID as the moderation channel. Twitch shared-chat receiver copies are filtered before the message handler, so a foreign copy does not create a second first-message marker or decision in the receiving channel. See [`eventsub.handler.ts`](src/handlers/eventsub.handler.ts), and [`shared_chat_origin.ts`](src/utils/shared_chat_origin.ts).

## Settings and defaults

Chat protection has its own settings object, `spamProtection`, alongside the main moderation `enabled` flag and `rules` list.

| Setting | Default | Effect |
| --- | --- | --- |
| `spamProtection.enabled` | `true` | Turns category-based protection on or off. |
| `spamProtection.reviewAllMessages` | `false` | On Premium or Pro, extends review to messages after the plan’s included first messages. It has no effect on Free. |
| `spamProtection.categories` | `spam`, `ads`, `self_promotion` | Categories the classifier checks. An empty list pauses category checks. |
| `spamProtection.thresholdPercent` | `85` | Minimum selected-category score for a violation, subject to the safe-score and overall-score checks below. Persisted/API values are limited to 80–100. |
| `spamProtection.exemptTags` | `mod`, `editor`, `admin` | Role tags that bypass protection. An empty list exempts no role tags. |

The valid categories are `spam`, `ads`, `self_promotion`, `profanity`, and `insults`. Categories are independently scored; the scores are probabilities for separate behaviors and do not sum to 100%. Their behavioral definitions and caveats are in [`spam_categories.ts`](src/utils/moderation/spam_categories.ts).

### What the categories detect

| Category | Enabled by default | Intended violations | Intended exceptions |
| --- | --- | --- | --- |
| `spam` | Yes | Scams, credential theft, fake-viewer/follower sales, or disruptive mass repetition supported by preceding chat. | A lone greeting, bare domain, ordinary enthusiasm, benign repetition, quotes, reports, and scam warnings. Ordinary ads or channel promotion alone do not count as this category. |
| `ads` | Yes | Soliciting purchases of products or paid services, including fake engagement. Disguised domains and sales pitches without links are included. | Free resources, ordinary product discussion, recommendations answering a question, quotes, reports, and warnings. Channel/social promotion alone is separate. |
| `self_promotion` | Yes | Explicit requests to visit, follow, or subscribe to the author's own channel or social account without a qualifying broadcaster invitation. | Encouraging support for the broadcaster of this chat, merely mentioning that one streams, answering a streaming question, quotations, reports, and invited promotion. |
| `profanity` | No | Explicit vulgar swearing used by the speaker, even casually or positively. | Quoting/reporting the word, discussing filter vocabulary, and harmless words containing a similar substring. |
| `insults` | No | Clearly abusive attacks or targeted humiliation of a person or group. | Disagreement, criticism of ideas or gameplay, harmless banter, self-deprecation, and quoted/reported abuse. |

For example, `AI viewers boostchat . net` is defined as a fake-engagement sales pitch even without an explicit “buy” or “sell” verb. A bare domain alone is not enough. These are classifier policy definitions, not a guarantee that every model response will match the intended interpretation.

**Every enabled category uses the same permanent-ban consequence.** Enabling profanity or insults does not select a warning or timeout for those categories. The configurable first/second/third penalties belong to ordinary rules and do not alter this built-in protection.

Defaults also apply to channels without a saved moderation document: the message path uses a version-zero in-memory default that keeps first-message protection enabled. This is not the same object as the settings GET view used by the dashboard. A later settings save increments `settingsVersion`, and a save during an in-flight default review cancels that review before enforcement. See [`spam.ts`](src/utils/moderation/spam.ts), [`moderation.handler.ts`](src/handlers/moderation.handler.ts), and [`moderation.route.ts`](src/server/routes/moderation.route.ts).

### Main moderation switch versus protection switch

The main `enabled` property controls ordinary configured moderation rules. The protection switch is `spamProtection.enabled`.

- Turning the main rule filter off does **not** disable first-message protection. The moderation gate still runs it when protection is enabled and at least one category is selected.
- Turning protection off disables this category check, including first-message and paid continuous review. It does not turn off ordinary rules if the main rule filter remains on.
- Selecting no categories pauses this check, even if its switch is on. Ordinary rules still run when their own main switch is on.
- Both checks pass through the same moderation gate. A rule action can stop the chat pipeline before later stages, and scheduling a protection ban does too.

The independent gate and early return conditions are implemented in [`moderation.handler.ts`](src/handlers/moderation.handler.ts). The dashboard presents the switches separately in [`moderation-page.component.html`](../dimasite/src/app/features/moderation/moderation-page.component.html).

## Free and paid review scope

The channel owner's `plan_tier`, not the author's plan, determines included scope: Free reviews the first eligible message, Premium the first two, and Pro the first three. These decisions use `reviewSource: first_message` and store `messageOrdinal` 1, 2, or 3. Later messages are reviewed only on Premium or Pro with `reviewAllMessages` enabled; these decisions use `spam_continuous` without an ordinal. The handler reads the owner's plan when needed for a second or third message, a later message with the opt-in enabled, or a custom confidence threshold.

The model route is selected for each queued decision:

| Review type and credit state | Spam classifier model | Billing behavior |
| --- | --- | --- |
| Included review on any plan | `openai/gpt-6-luna-decisions` (GPT-6 Luna Decisions) | No AI credits charged; the worker does not read the credit balance. |
| Later-message review on Premium/Pro, verified available credits | `openai/gpt-6-luna-decisions` | Successful complete or uncertain inference can consume credits, including an allowed or uncertain result. |
| Later-message review on Premium/Pro, credits exhausted/unavailable or balance cannot be verified | `respan/span-01-lite` | Lite fallback; no AI credits are charged. |

Around 2026-10-25, the provider began returning the same scores for `respan/span-01` and `respan/span-01-lite`: all 471 replayed requests matched on 2026-11-12. Those scores stopped reaching the ban threshold on real viewer-selling spam: the last ban on a Free channel was on 2026-10-20, and no channel on any plan received one after 2026-10-27. On 89 distinct real campaign requests, Luna banned 78 and Jev 63, with no more false bans than Jev on the labelled benchmark (13 of 248 versus 17 of 248) and the same two on a 40-case held-out set.

Included reviews use Luna regardless of credit balance and are never charged, including first messages on paid plans. Later-message reviews retain the paid credit and Lite fallback rules. Model selection is in [`semantic.ts`](src/utils/moderation/semantic.ts); plan, balance, fallback, and billing decisions are in [`semantic_worker.ts`](src/utils/moderation/semantic_worker.ts).

For an included review that completed or returned uncertain with a positive recorded provider cost and an owner Polar customer ID, the worker sets a pending charge with zero credits. Maintenance reports that pending zero-credit charge regardless of consequence status, even if the bot stops before writing an outcome, through an idempotent `ai_usage` event with the decision's stored provider cost in USD, `chargeCredits: false`, and `credits: 0`; the AI-credits meter sums credits, and the local balance is untouched. Charged later reviews report billable cost and credits only once the consequence is `allowed`, `allowed_fallback`, `scheduled`, or `executed`. Maintenance retries pending accounting; failed or late reviews are not charged. See [`semantic_worker.ts`](src/utils/moderation/semantic_worker.ts) and [`polarsh.ts`](src/utils/polarsh.ts). A visible credit count is shown in the dashboard decision entry when present.

## Who is skipped

Protection checks do not run for:

- The broadcaster or the bot account.
- Service bots whose Twitch login is in `SERVICE_BOT_LOGINS`: `streamlootsbot`, `soundalerts`, `streamelements`, `nightbot`, `tangiabot`, `blerp`, `streamlabs`, `moobot`, `fossabot`, `wizebot`, `botrixoficial`, `kofistreambot`, `pokemoncommunitygame`, `sery_bot`, `restreambot`, and `pretzelrocks`.
- A chatter with an active user-level or channel-wide moderation permit.
- A role exempted by `spamProtection.exemptTags`.
- Messages without a Twitch message ID, because the review needs an idempotent decision key.
- Any message when protection is disabled or the selected category list is empty.

The broadcaster and bot are skipped before settings and permit checks. Service-bot matching uses the unique Twitch login, not the display name, and happens before claiming the observed-message count. It skips only built-in protection; ordinary configured rules still apply. This protects service posts such as a streamer’s own Streamloots link, for which StreamlootsBot was banned in two channels in October 2026. `restreambot` also relays messages written by viewers on other platforms, so an ad relayed under that exempt account is not reviewed by this protection. It remains exempt to avoid permanently banning the streamer’s relay bot for a third person’s message. A permit is then checked before duplicate receipt handling. Role exemptions use the resolved additive role tags, so a chatter with any selected tag is exempt; unselected tags do not exempt them. The default exemption is moderator, editor, and channel admin. `vip`, `sub`, and `founder` are available choices but not selected by default. See [`moderation.handler.ts`](src/handlers/moderation.handler.ts), [`spam.ts`](src/utils/moderation/spam.ts), [`permissions/index.ts`](src/utils/permissions/index.ts), and [`spam.test.ts`](src/utils/moderation/spam.test.ts).

A broadcaster invitation can permit channel/social promotion for the self-promotion category when the preceding context contains a qualifying broadcaster message. It does not permit other selected behaviors. Only a message identified as broadcaster-authored counts, and negated invitations do not grant the exception. See [`spam.ts`](src/utils/moderation/spam.ts) and the prompt construction in [`semantic.ts`](src/utils/moderation/semantic.ts).

## Review flow

Every Twitch chat message that reaches the channel's `messageHandler` is added to chat history and then passes through `runChatModeration` before keyword and command/timer processing. If moderation returns `actionTaken: true`, the rest of the message pipeline stops. See [`eventsub.handler.ts`](src/handlers/eventsub.handler.ts) and [`message.handler.ts`](src/handlers/message.handler.ts).

For the category-based check, the gate performs these steps:

1. **Check the author and load policy.** Missing chatter IDs, the broadcaster, and the bot exit before loading settings. Channel settings are read from Dragonfly when cached, otherwise MongoDB. Both real settings and the “no saved settings” sentinel expire after five minutes. Saving settings invalidates the cache; compiled blacklist patterns are also invalidated. See [`moderation.handler.ts`](src/handlers/moderation.handler.ts).
2. **Apply early exits and duplicate receipt fencing.** Broadcaster/bot, permits, and duplicate message deliveries are skipped. A Twitch message ID gets a per-channel receipt with a 24-hour TTL. A duplicate receipt is treated as already handled and stops duplicate processing.
3. **Claim an observed-message ordinal.** Protection must be enabled with at least one category, the author must not be a listed service bot or have a selected exempt role, and a message ID must be present. The code checks Dragonfly's one-day finished-count cache, then atomically increments or initializes the durable `moderation_chatter` row using the channel/chatter hash, capped at 4. Duplicate-key handling retries a concurrent insert. Legacy rows without `seen` become 4. The cache is written only once the count is finished. This marker is independent of decision-history retention and stores no username or chat text. See [`spam.ts`](src/utils/moderation/spam.ts) and [`moderation_chatter.schema.ts`](src/schemas/moderation_chatter.schema.ts).
4. **Choose review scope and apply admission limits.** An ordinal within the owner's plan allowance gets `first_message`; a message beyond it gets `spam_continuous` only if the channel is paid and opted in. Otherwise this check ends. Before queueing model work, an atomic Dragonfly script caps spam reviews at 30 per channel per minute and 300 across all channels per minute. These are fixed calendar-minute windows using Dragonfly's clock, not rolling 60-second limits. Both scopes share these budgets. The counters expire after 120 seconds. The count is claimed before scope and budget checks, so a rejected review still consumes that ordinal. See [`spam.ts`](src/utils/moderation/spam.ts).
5. **Build the review input.** The target message is evaluated against the selected categories. Up to seven prior messages, at most 60 seconds old, are included as separate context; the target itself is excluded. The history query always reads up to 30 recent entries. For a second or third included message, it also reads the newest one or up to two earlier decisions respectively for the same channel, exact chatter ID, and built-in spam rule, created within the preceding 24 hours (`SPAM_OWN_CONTEXT_WINDOW_MS`). It adds their stored message text unless the message ID is already present in recent history. This reaches earlier lines that busy chat may have pushed out of the limited history, avoids confusing look-alike or renamed accounts, and uses decisions to establish a strict order. An earlier line older than 24 hours is not added from decisions, and a review never admitted, for example because the review budget was full, has no decision to supply its text. Decisions already retain message text for 180 days; the chatter marker stores none. The combined context is sent as ordinary lines in chronological order, without a special marker or prompt change, with each text limited to 500 characters and each username to 100. This helps detect an ad after a greeting or a pitch split across messages. In a pre-release replay of 1,660 real second and third messages on Luna, none produced a ban without earlier messages; with them, one did: a streamer's second account writing "follow me on my twitch", a wanted ban. Chat text is treated as evidence, never as instructions. The handler stores the chat event’s `broadcaster_user_login` on the decision as `rule.semantic.broadcasterLogin`; the semantic request uses it first, falling back to the channel owner’s stored Twitch account name loaded by the worker only when the event login is absent or empty. The event login avoids stale stored names after a Twitch rename, since the stored name is refreshed at sign-in. The chosen name is lowercased and used only if it contains 1–25 characters of `a-z`, `0-9`, or underscore; an invalid name adds no note and is not stripped or truncated. When the name is valid and no verified broadcaster invitation is active, only the self-promotion question receives ` The author of the final message is not the broadcaster. The broadcaster of this chat is "<login>".` The spam, ads, and overall questions do not receive this note: adding it there made reports and complaints about ads score as ads. The self-promotion definition excludes encouraging support for this broadcaster; it covers the author’s own channel or social account, not promotion of a third channel. The classifier cannot distinguish a third channel from a nickname or a second account of the broadcaster. The spam prompt is defined in [`spam_categories.ts`](src/utils/moderation/spam_categories.ts) and assembled in [`semantic.ts`](src/utils/moderation/semantic.ts).
6. **Create or reuse a durable decision.** The decision ID is a hash of channel, message, and built-in spam rule ID. It records the settings version, `reviewSource` (`first_message` or `spam_continuous`), and `messageOrdinal` for included reviews and expires after 180 days. Duplicate event deliveries cannot create a second decision for the same message/rule. See [`decisions.ts`](src/utils/moderation/decisions.ts) and [`moderation_decision.schema.ts`](src/schemas/moderation_decision.schema.ts).
7. **Wait up to four seconds for a worker decision.** The handler waits until the record is completed or its deadline passes. An independent `semantic-moderation` worker claims pending, unexpired decisions atomically, processes at most four concurrently, and polls every 250 ms. It runs maintenance about once per second, marking expired work uncertain and retrying pending usage accounting. See [`advanced.ts`](src/utils/moderation/advanced.ts), [`decisions.ts`](src/utils/moderation/decisions.ts), and [`semantic_moderation.worker.ts`](src/workers/semantic_moderation.worker.ts).

If the worker is late, unavailable, rate-limited, times out, returns an invalid response, has no API key, or otherwise cannot produce a valid result, the effective outcome is fail-open: the decision is uncertain/allowed fallback and no ban is scheduled. Late model scores may be retained for audit, but the late result does not replace the fallback verdict or cause a charge or offense. See [`semantic.ts`](src/utils/moderation/semantic.ts) and [`semantic_worker.ts`](src/utils/moderation/semantic_worker.ts).

The four-second decision deadline starts at `receivedAt` in the message handler, so earlier identity/history work and waiting behind another message from the same chatter consume that time too. It is a deadline for accepting a classifier result, not a hard upper bound on database/network operations or total message-handler duration. The handler polls the decision about every 80 ms; the provider request uses the remaining deadline as its timeout.

Messages from the same channel/chatter are serialized by the moderation gate, while other chatters can progress independently. The semantic worker runs under the existing TypeScript cron supervisor in `dima-cron`; the bot runs the gate and schedules the action. There is no queue admission guarantee: per-channel/global limits and worker capacity may result in a fail-open decision. A claimed review is not retried by this worker after a crash; pending/processing work that reaches its deadline is expired to fallback.

## Scoring and enforcement

The classifier returns one score for each selected category and a score for `unsafe`, meaning any selected behavior. The implementation derives `safe = 1 - unsafe` and finds the highest selected-category score. A decision is a **violation only when** the highest category score meets or exceeds the configured threshold **and is strictly greater than the safe score**, and `unsafe` is at least `SPAM_MIN_OVERALL_SCORE` (0.3), equivalent to safe being at most 70%. If safe is higher, the result is allow. Otherwise, a tie, a category score below threshold, or an overall score below 30% produces uncertain (allowed and logged). This overall check prevents a contradictory result, such as a 0.99 category score with 0.04 overall, from causing a ban. This protection path does not use the generic semantic allow threshold. See [`parseSpamResponse`](src/utils/moderation/semantic.ts) and the tie/threshold cases in [`spam.test.ts`](src/utils/moderation/spam.test.ts).

At the default 85% threshold:

| Highest selected score | Safe score | Verdict | Protection outcome |
| --- | --- | --- | --- |
| 95% | 3% | `violation` | Recheck policy, then schedule a ban if still valid. |
| 85% | 10% | `violation` | Exactly meeting the threshold qualifies. |
| 84% | 1% | `uncertain` | Allow fallback. |
| 95% | 96% | `allow` | Safe score wins, even though the category meets threshold. |
| 95% | 95% | `uncertain` | A tie never schedules a ban. |
| 99% | 96% | `uncertain` | Overall score is 4%, below the minimum. |
| 99% | 71% | `uncertain` | Overall score is 29%, below the minimum. |
| 99% | 70% | `violation` | Overall score is exactly 30%. |

Missing, non-finite, out-of-range, or incorrectly typed required scores cause `invalid_response`. Provider usage fields are validated too. The parser does not normalize category scores into an exclusive distribution. Unselected categories cannot trigger this check.

On a violation, the handler re-reads current settings and, when applicable, the channel plan. It cancels the decision if the review deadline passed, the spam policy/settings version changed, paid eligibility is no longer valid for that review, or the chatter acquired an active permit. For a second or third included review, it re-reads the owner’s plan and cancels the ban if that ordinal is no longer included; a first message remains included on every plan, though other policy checks still apply. Cancellation clears the charge only when credits were charged; an included review's pending zero-credit cost report is kept for Polar. If the decision remains valid, the handler atomically claims the consequence to prevent duplicate actions and schedules a ban. The built-in spam rule's first, second, and third offense actions are all permanent bans; it does not use the configurable ordinary-rule escalation ladder. See [`moderation.handler.ts`](src/handlers/moderation.handler.ts) and [`spam.ts`](src/utils/moderation/spam.ts).

The action call is asynchronous. A scheduled ban may still fail at Twitch/API execution time. The executor records `executed`, action, success, and error details on the decision and writes an action-log row; public notice attempts after successful actions are throttled to once per user per channel per 60 seconds, but the moderation action itself is not throttled. See [`execute_action.moderation.ts`](src/functions/moderation/execute_action.moderation.ts).

A clear violation does not synchronously wait for Helix to finish. The chat pipeline is stopped once the consequence is scheduled, not once Twitch confirms it. This is why the decision history distinguishes a pending action from a successful or failed action.

The ban uses the bot account's token and moderator ID. Its duration is `null`, meaning a permanent channel ban; the rule object's `timeoutSeconds: 60` field is not used for a `ban` action. The reason is `Selected unwanted chat behavior`. Twitch authorization or rate-limit errors can still prevent execution. This path makes one ban attempt and does not provide a durable action retry queue. See [`ban.moderation.ts`](src/functions/moderation/ban.moderation.ts).

## Dashboard and API

The dashboard's **Protection** card contains the `Chat protection` switch, category selection, role exemptions, and paid-only controls for subsequent-message review and ban confidence. The main **Rule filter** switch is separately shown under Rules. Changes are saved with the page's Save changes action. Dashboard controls and labels are in [`moderation-page.component.html`](../dimasite/src/app/features/moderation/moderation-page.component.html), state normalization and updates are in [`moderation-page.component.ts`](../dimasite/src/app/features/moderation/moderation-page.component.ts), and English wording is in [`en.json`](../dimasite/src/assets/i18n/en.json).

The authenticated API endpoints are:

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /moderation/:channelID/settings` | `moderation:view` | Returns current settings with normalized `spamProtection` values. |
| `PUT /moderation/:channelID/settings` | `moderation:manage` | Saves moderation settings and increments `settingsVersion`. |
| `GET /moderation/:channelID/decisions?limit=&skip=` | `moderation:view` | Lists recent model decisions, including review source, message ordinal, scores, consequence, and credit count. |
| `GET /moderation/:channelID/logs?limit=&skip=` | `moderation:view` | Lists executed moderation actions. |

See [`moderation.route.ts`](src/server/routes/moderation.route.ts) for settings validation and history endpoints. The route requires authentication, channel existence, and the stated channel permission. PUT validates category/tag membership and uniqueness, requires numeric confidence from 80 through 100, and restricts enabling paid continuous review or changing confidence to Premium/Pro.

PUT is a settings save, not a partial patch for the `rules` array: if `rules` is omitted, the route treats it as an empty list. When updating protection programmatically, send the full intended `rules` array as well as the `spamProtection` object. Missing optional `spamProtection` fields are filled from current normalized settings. Saving increments the settings version, invalidates the settings cache, and can cancel pending semantic moderation reviews.

The default protection object is:

```json
{
  "enabled": true,
  "reviewAllMessages": false,
  "categories": ["spam", "ads", "self_promotion"],
  "thresholdPercent": 85,
  "exemptTags": ["mod", "editor", "admin"]
}
```

This is the value of `spamProtection`, not a complete PUT request. When including that object in a save, both `enabled` and `reviewAllMessages` must be booleans. Category and exemption lists can be empty but cannot contain duplicate or unknown values. Decimal confidence values in 80–100 are accepted. The built-in ID `builtin-spam-protection` is reserved and cannot be submitted as a user-configured rule.

On a downgrade, previously saved paid options may remain stored so the channel can edit other settings without losing its configuration. Runtime checks still disable subsequent-message review on Free and use the default 85% threshold for new first-message decisions. Credit exhaustion on a still-paid channel instead changes later-message reviews to Lite; it does not by itself disable continuous review or a paid confidence setting.

The decisions page requests paginated history and displays the source (`First-message protection`, `Second-message protection`, `Third-message protection`, or `Continuous chat protection`), model scores, action outcome, status, and any AI credits used. Its API response intentionally does not include the stored prompt/context or provider metadata. The dashboard states that decisions are visible for 30 days; decision documents are retained internally for 180 days before TTL deletion. See [`moderation-page.component.html`](../dimasite/src/app/features/moderation/moderation-page.component.html), [`moderation.route.ts`](src/server/routes/moderation.route.ts), and [`moderation_decision.schema.ts`](src/schemas/moderation_decision.schema.ts).

### Stored state and retention

| Record/cache | Purpose | Lifetime |
| --- | --- | --- |
| MongoDB `moderation_chatter` marker | Stores the channel/chatter pair's hashed ID, first-seen timestamp, and observed-message count capped at 4; no username or chat text. | No TTL is defined. |
| Dragonfly `moderation:seen:<hash>` | Avoids database lookups after the observed-message count reaches 4. | 24 hours; expiry does not reset the MongoDB marker. |
| Dragonfly `moderation:<channelID>:message:<messageID>` | Fences duplicate deliveries at the moderation gate. | 24 hours. |
| MongoDB decision | Stores target text, context, policy snapshot, scores, usage, and consequence; recent earlier decisions can supply the same chatter's context for a second or third included review. | Expiry scheduled at 180 days; API visibility limited to 30 days. |
| MongoDB moderation action log | Stores attempted action, a 200-character message excerpt, success, and error. | 30-day TTL and 30-day API visibility. |

A decision’s stored provider `cost` includes `usage.cost` plus a valid positive `usage.cost_details.upstream_inference_cost`; models using the service’s own key can report zero in `usage.cost`. Channel credit charges are unaffected and are computed from input tokens.

MongoDB TTL removal is asynchronous. An `executed` consequence means the executor recorded its result; check `success` and `errorMessage` to know whether Twitch accepted the action. It does not mean success by itself. Source: [`moderation_action_log.schema.ts`](src/schemas/moderation_action_log.schema.ts) and [`execute_action.moderation.ts`](src/functions/moderation/execute_action.moderation.ts).

## Examples

- **Free channel, new chatter, selected default categories:** the first eligible message is reviewed by `openai/gpt-6-luna-decisions`. An ad score at or above 85%, strictly above the safe score, and an overall score of at least 30% schedules a ban. Later messages from that chatter are not reviewed by this feature.
- **Free channel, a moderator's first message:** the default `mod` exemption skips protection before the count is claimed. If a mod role is removed and a later message arrives, that message may then become the first observed eligible one.
- **Free channel, first eligible message arrives after the channel budget is full:** the marker is still claimed before the budget check. No model review is admitted and later messages will not receive free first-message review.
- **Premium/Pro with continuous review on:** the first two/three eligible messages respectively are included `first_message` reviews without credit charges; subsequent messages are `spam_continuous` and use credits when verified credits are available, otherwise Lite without a charge. Both use the same categories, confidence, role exemptions, admission limits, and fail-open behavior. A second or third included message also receives the chatter's available earlier reviewed messages from the previous 24 hours as context, unless already present in recent history.
- **Only “insults” selected:** an insult can trigger the built-in ban, but a commercial ad or self-promotion alone is outside the selected categories and cannot trigger this protection.
- **Broadcaster invited channel links:** when recent context contains a qualifying broadcaster invitation, the classifier treats related channel/social promotion as permitted for self-promotion. A sale, scam, profanity, or insult still can violate another selected category.
- **Safe and category scores tie:** a message with a selected category at threshold but exactly tied with `safe` is uncertain and allowed; enforcement requires category score strictly greater than safe.

Luna has a known miss: it bans a viewer who reposts an ad word for word when asked to quote it; Jev, the paid model until 2026-11-12, did not in the two cases recorded as `KNOWN_MISSES` in [`spam-protection-provider.mjs`](../ops/checks/spam-protection-provider.mjs). The suite defaults to the production model; `SPAM_EVAL_MODEL` selects another model.

## Troubleshooting

| Symptom | Source-level checks |
| --- | --- |
| A chatter's second message is not checked | Confirm the owner is Premium or Pro and the message was eligible and admitted. A legacy marker without `seen` is treated as past all included reviews; the next eligible message sets it to 4. Check `moderation_chatter` using a safe read-only investigation; the feature has no user-facing reset. Free includes only the first eligible message. |
| An earlier line is missing from a second or third included review's context | Check the 24-hour window and whether the earlier review was admitted and has a decision for the same channel, chatter ID, and built-in spam rule. Recent chat history can also supply a line, but busy chat can push it out. |
| Messages beyond the plan's included count are not checked | Confirm continuous review is on and the channel owner is Premium/Pro; check eligibility and admission limits. |
| An expected first message has no decision | Check protection is enabled and categories are nonempty; inspect whether the chatter had an exempt role, a permit, a missing message ID, or a duplicate message receipt. Then consider channel/global review limits (30/channel/minute, 300/global/minute) and worker/API status. |
| A message is reviewed but not banned | Check the selected categories, both category and safe scores, threshold, status, and whether policy version/permit/plan changed during review. A category above threshold with a safe score above 70% cannot produce a ban. `uncertain`, `allowed_fallback`, and `cancelled` are fail-open outcomes. |
| A decision says review unavailable, timed out, rate-limited, or invalid response | The semantic worker or OpenRouter request did not produce a valid decision within the four-second deadline. Check the `semantic-moderation` worker logs, OpenRouter/API-key availability, and model/provider response status. The message proceeds without this ban. |
| Dashboard says channel protection active while Rule filter is off | This is expected: the protection categories and regular rules have independent switches. |
| Decision shows a ban but action failed | Review the consequence's execution error and Recent Actions log. The model decision and scheduling step are separate from Twitch Helix execution. |
| No decision appears in the dashboard | The API only returns the latest 30 days, pages in descending creation order, and only decisions for that channel. Confirm the user has `moderation:view` access and refresh the Decisions panel. |

A first-seen marker is durable and does not expire with the 180-day decision record. Support investigations should not treat missing decision history as evidence that a chatter has never been seen: the original review could have been rejected before decision creation, or the decision could have aged out while the marker remains.

## Source map

- Message ingress and processing order: [`eventsub.handler.ts`](src/handlers/eventsub.handler.ts), [`message.handler.ts`](src/handlers/message.handler.ts).
- Protection gates, context from recent history and earlier decisions, cache, limits, policy checks, and consequence scheduling: [`moderation.handler.ts`](src/handlers/moderation.handler.ts).
- Defaults, service-bot logins, category policies, overall-score minimum, observed-message count, included review scope, and admission budget: [`spam.ts`](src/utils/moderation/spam.ts), [`spam_categories.ts`](src/utils/moderation/spam_categories.ts).
- Classifier request, model selection, response scoring, timeout handling: [`semantic.ts`](src/utils/moderation/semantic.ts).
- Queue worker, broadcaster login and fallback lookup, plan/credit check, fallback, and accounting: [`moderation.handler.ts`](src/handlers/moderation.handler.ts), [`semantic_worker.ts`](src/utils/moderation/semantic_worker.ts), [`semantic_moderation.worker.ts`](src/workers/semantic_moderation.worker.ts).
- Polar zero-credit usage reporting: [`polarsh.ts`](src/utils/polarsh.ts).
- Data shapes and retention: [`channel_moderation_settings.schema.ts`](src/schemas/channel_moderation_settings.schema.ts), [`moderation_chatter.schema.ts`](src/schemas/moderation_chatter.schema.ts), [`moderation_decision.schema.ts`](src/schemas/moderation_decision.schema.ts).
- API configuration and history: [`moderation.route.ts`](src/server/routes/moderation.route.ts).
- Dashboard controls and decision presentation: [`moderation-page.component.html`](../dimasite/src/app/features/moderation/moderation-page.component.html), [`moderation-page.component.ts`](../dimasite/src/app/features/moderation/moderation-page.component.ts).
- Regression examples: [`spam.test.ts`](src/utils/moderation/spam.test.ts), [`spam-protection.mjs`](../ops/checks/spam-protection.mjs), and [`spam-protection-provider.mjs`](../ops/checks/spam-protection-provider.mjs).
