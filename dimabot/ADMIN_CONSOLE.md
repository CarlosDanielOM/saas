# Owner Admin Console

The internal admin console is an owner-only view across channels. The API is mounted under `/admin-site` by `src/server/routes/admin_site.route.ts`; the new routers are in `src/server/routes/admin_site/`. The Angular contracts are in `admin/src/app/services/`. Read the route and service before changing an endpoint.

## Activity log

`src/schemas/activity_log.schema.ts` and `src/utils/activity_log.ts` define a short-lived debug trail for actions not already captured by another store. It is **never the record of truth**: the synchronous `recordActivity` writer cannot throw or wait for Mongo. It buffers up to 2,000 rows, flushes batches of 200 about once a second, and drops rows if full or a write fails. Nothing may depend on a row being present. `ACTIVITY_LOG_ENABLED=false` disables it.

| Kind | Recorded activity |
| --- | --- |
| `command` | Existing chat commands, keywords, timers and referenced commands, including refused attempts. Unknown commands and ordinary chat are not logged. |
| `bot_message` | Chat sends and their outcome, with an origin. |
| `twitch_event` | Selected unjournaled Twitch notifications, redemption outcomes and handler errors. Journaled events come from the domain journal instead. |
| `alert` | Chat alert sent, held, skipped or failed. Its sent text is on the bot message row. |
| `voice` | Synthesis and fallback problems under the provider name; `request` for requests not queued; `playback` for how a synthesized message ended. |
| `system` | EventSub revocations. |

| Outcome | Meaning and current reasons |
| --- | --- |
| `ok` | It happened; reason is empty. |
| `skipped` | Deliberately not done: `cooldown`, `disabled`, `chat_disabled`, `alert_disabled`, `follow_defense`, `empty_message`, `stale`, `song_unsupported`, `subscription_disabled`, `no_credits`, `credit_check_failed`, `empty_text_after_fallback`, `usage`, `empty_text`, `tts_disabled`, `text_rejected`, `queue_full`, `tts_skipped`, `tts_cleared`, `tts_refreshed`, `tts_stopped`, `stream_ended`, `pet_stopped`. |
| `blocked` | Refused: `permission_denied`, `permission_invalid`, `held_for_moderation`. |
| `failed` | An attempt failed: `error`, `handler_error`, `send_failed`, `twitch_rejected`, `no_token`, `exception`, `vip_failed`, `reward_failed`, `synthesis_failed`, `no_voice`, `no_speech_page`, `busy`, `streamer_not_found`, `play_error`, `media_error`, `download_error`, `stalled`, `no_start`, `playback_timeout`, `page_closed`, `page_closed_while_playing`, `not_played`, `queue_error`, `pet_failed`, `pet_expired`; playback can also use a normalized unknown reason. Command failures may also carry the command handler's result type. Revocations use Twitch's subscription status or `revoked`. |

A problem is `failed`, or `blocked` for any reason except `permission_denied`; `skipped` is never a problem. The feed's `outcome=problems` filter and summary counts, Overview daily and top-channel activity counts, and `/users/:channelID/command-stats` `problems` use this rule. The filter keeps the partial `problems_at` index. In the feed, protection and assistant problems equal their failures: skipped reviews and stopped turns are not problems. Overview's daily and top-channel protection problems include failed review statuses or a refused action; its protection feature's failed count uses failed review statuses only.

Command `data.error` holds the command's own error text: a built-in's error and chat reply, a handler failure, a thrown error, or a timer send failure. A built-in reply starting with `Usage: ` is `skipped` with reason `usage` and keeps the reply in `data.error`. Command stats count it in `answered` (ok plus usage replies) and leave it out of the reasons a command did not answer.

Voice `request` rows come from `queue_default_tts.util.ts`. They use the `code` from `POST /speech/:channelID` (`tts_disabled`, `text_rejected`, `no_voice`, `streamer_not_found`) or `queueRequest` (`no_speech_page`, `queue_full`, `busy`); `queueDefaultTts` also uses `empty_text`. Older APIs fall back to status. `empty_text`, `tts_disabled`, `text_rejected` and `queue_full` are skipped; the other codes are failed. Playback cleanup records one `playback` row per synthesized message, with speech ID as `ref` and `speechID:playback` as the dedupe key. Its data can include `heard`, `pages`, `movedBecause`, `everyPage` and `endReason`. The first known end cause wins, including one that arrives while the message is still being made (a page closing, a control, the stream ending).

Add a row at the decision or delivery point where the real outcome is known. Command mappings and safe wrappers are in `src/utils/activity_command.ts`: chat and keyword handlers, `src/utils/ast_command_delivery.ts` and `src/workers/timer.worker.ts` use them. `src/functions/chats/send_message.chat.ts` accepts a delivery `origin` and records sends; pass the correct origin and actor. Twitch mappings and wrappers live in `src/utils/activity_events.ts`, called from `src/bot/eventsub.twitch.ts`, event, follow, redemption, revocation, ban and ad-break handlers, and `src/domain_events/chat_announcement_events.ts`. Voice paths are in `src/utils/tts/tts_activity.ts`, `src/utils/tts/queue_default_tts.util.ts`, `src/handlers/tts_queue.handler.ts`, `src/handlers/dimafx_queue.handler.ts` and `src/overlays/test-playback.ts`.

On the chat path, build and record synchronously: no awaits, database lookups or operations that can throw into the caller. Use the existing guarded wrappers or guard your own row construction as well as calling `recordActivity`. Give a stable `dedupeKey` for anything Twitch can redeliver, distinguishing separate actions or retry outcomes where appropriate. The writer clips text to 300 characters and data strings to 200, keeps at most 12 flat data fields, and scrubs text before buffering. `src/utils/scrub_text.ts` masks recognizable credentials, token shapes, webhook secrets and email addresses; this is best effort, not a guarantee. Do not deliberately place secrets in a row. Before writing each batch, the writer drops channel rows whose Twitch channel no longer has an account; channel-less system rows can pass. Never bypass this by writing the model directly.

## Stores, retention and privacy

| Store | Retention and contents |
| --- | --- |
| Activity log | Mongo `activity_logs`, 30 days, short scrubbed previews and flat facts. |
| Assistant turn log | Mongo `site_agent_turn_logs`, numbers for 90 days, conversation and tool text for 3 days. See [SITE_AGENT.md](SITE_AGENT.md) and `src/site_agent/turn_log.ts` for limits, clearing and exclusions. |
| MCP call log | Mongo `mcp_call_logs`, 90 days; tool, app, person, outcome and charge, with scrubbed refusal/error text, never arguments or results. See [MCP.md](MCP.md). |
| Usage receipts | Mongo `ai_usage_receipts`: free 30 days, premium 60 days, pro 90 days. See `src/utils/ai_usage_ledger.ts`. |
| Protection decisions | Mongo `moderation_decisions`, 180 days. |
| Docs assistant answers | Dragonfly `docs_assistant:answer:<id>` hashes, 30 days; the bounded `docs_assistant:recent` index has no expiry and stale IDs are skipped. |
| Gifted credits | Mongo `creditgifts` (`CreditGift` model): permanent purchase and delivery receipts, including checkout reservations; do not TTL them. |

AI chats are private from other people on a channel, not from the operator. Owner-only assistant pages can show what was asked and answered; the dashboard tells streamers “Chats are kept for 3 days”. Turn text is cleared after that period while the numbers remain. Do not include policy text, approval payloads, secrets or other excluded data in turn logs. Account deletion removes channel activity through `purgeChannelActivity`, moderation decisions and site-agent data including the channel’s turns and MCP call rows and the deleted person’s turns and MCP call rows on other channels; it also performs the other cleanup in `src/utils/account_deletion.ts`. Site-agent cleanup is best effort in that flow. The activity purge includes a delayed sweep, and the writer checks account existence before later batches. A row that slips through the deletion race still expires under its 30-day TTL. Turn text clearing runs on a maintenance timer, and Mongo TTL deletion is asynchronous. Do not claim this deletes other stores without tracing their deletion paths.

Gift processing is in `src/utils/credit_gifts.ts` and `src/schemas/credit_gift.schema.ts`. An unpaid gift becomes `expired` with `expiredAt` when Polar's 24-hour checkout expires or a reservation has no checkout after 48 hours; the worker stops checking it. Before payment, open checkouts are checked every 30 seconds for 30 minutes, then every 5 minutes. If no order exists, `checkoutClosedUnpaid` checks the checkout status; confirmed or succeeded checkouts keep being checked while an order may be created. `needs_support` is set only after payment. The expiry write rechecks that no payment was recorded (and, for a reservation, that no checkout appeared), because the paid-order webhook records `paidAt` without the worker lease; expiry cannot overwrite a payment. `createCreditGiftCheckout` rejects an expired gift with 409 and asks the buyer to start a new gift; a paid order arriving afterward moves it to `payment_received` for delivery. The admin labels unpaid legacy `needs_support` rows or gifts with 5+ failed checks “Payment not confirmed”; “Never paid” means `expired`.

## Feed and extension

`src/server/services/admin_feed/index.ts` registers one adapter per store in `src/server/services/admin_feed/sources/`: activity, journaled events, protection decisions, usage receipts, assistant turns, docs answers and MCP calls. The service merges them at read time in newest-first order. The cursor continues that merged order; `partial` names kinds omitted because a source failed, timed out or cannot honor a viewer filter. Summary counts use the same scope. MCP calls appear as kind `mcp` (“AI apps”), with the problems filter and data keys `app`, `appId`, `toolKind`, `role`, `changeId` and `late`. The feed contains a question preview for assistant turns, not the full answer or tool data; the owner can open the assistant detail separately.

For a new source or kind, implement and register an adapter, update the backend contract in `src/server/services/admin_feed/types.ts` and matching frontend contract in `admin/src/app/services/feed-api.service.ts`, put all row wording in `admin/src/app/shared/feed/feed-format.ts`, and extend the fixture, API and browser checks. Verify ordering, pagination, filters, partial results and safe output. Reuse existing stores instead of copying their records to the activity log.

## Owner API and money

Register new owner-only endpoints with `ownerGet`, `ownerPut`, `ownerPost`, `ownerPatch` or `ownerDelete` in `src/server/routes/admin_site/shared.ts`. They enforce sign-in and owner access, set `Cache-Control: no-store`, shape responses and conceal unexpected errors. Use the shared strict parsers and cursor helpers, bound windows and limits, and use `maxTimeMS` for Mongo queries. Never put a user value in a regex or expression. Return only explicitly selected safe data: no secrets, customer IDs or policy text. The owner-only API may expose assistant conversation text as described above.

100,000 AI credits equal 1 USD; 1,000 credits equal 1 cent. Always show the channel's credits and their dollar value separately from provider cost. Provider cost is shown only where recorded, never estimated. Receipt actor, provider cost, voice, model and more-specific source are receipt-only enrichment; preserve the existing Polar and PostHog event bytes. `src/utils/polarsh.ts` centralizes `providerReportedCostUsd` and `receiptCostUsd`; explicit unknown provider cost stays unknown. See `src/utils/ai_usage_event.ts` and `src/utils/ai_usage_ledger.ts`.

### New endpoints

All paths below have the `/admin-site` prefix and use GET unless stated otherwise.

| Path | Purpose |
| --- | --- |
| `/overview` | Cross-channel overview; `gifts_need_support` counts paid gifts only. |
| `/gifts` | Gift list and counts by `needs_support`, `in_progress`, `awaiting_payment`, `delivered`, `expired` or `all`; filter by channel ID or login, with cursor and limit up to 50. Unpaid legacy `needs_support` rows count as awaiting payment. |
| `/gifts/:id` | One gift and its delivery details. |
| `POST /gifts/:id/retry` | Make a paid, undelivered gift due now if it is not being processed. The worker rechecks payment and does not deliver twice. |
| `/feed` | Merged, filtered activity page. |
| `/feed/summary` | Counts by feed kind. |
| `/events/:eventKey` | Journal event, deliveries and steps. |
| `/decisions` | Filtered protection decisions. |
| `/decisions/summary` | Protection counts. |
| `/decisions/:id` | One decision and its detail. |
| `PUT /decisions/:id/feedback` | Save or clear an owner verdict. |
| `/usage/summary` | Cross-channel credit and provider-cost breakdowns. |
| `/usage/transactions` | Filtered usage receipts. |
| `/assistant/summary` | Dima assistant usage and outcomes. |
| `/assistant/turns` | Filtered assistant turn list. |
| `/assistant/turns/:id` | One assistant exchange and tool results. |
| `/docs-assistant/summary` | Docs assistant totals. |
| `/docs-assistant/answers` | Docs questions, answers and feedback. |
| `/users/:channelID/logs` | Channel bot log. |
| `/users/:channelID/commands` | Channel commands, including `userLevel`, `activation`, `keywordMatch`, `reserved`, `runsBuiltIn`, `authoring`, `permissionMode`, `description` and `channel`. |
| `POST /users/:channelID/commands` | Create a command or keyword through the owner write service. |
| `PUT /users/:channelID/commands/:commandID` | Edit a command or keyword. |
| `DELETE /users/:channelID/commands/:commandID` | Delete a command, including a built-in. |
| `/users/:channelID/eventsubs` | Channel subscriptions with normalized `type` (outgoing raids as `channel.raid.outgoing`, legacy cheers as `channel.bits.use`), `rawType`, editable chat `settings`, `cheerTierCount` and `remoteMissingSince`. |
| `PATCH /users/:channelID/eventsubs/:id` | Edit typed stored settings or enabled state, not Twitch identity fields. |
| `/users/:channelID/referrals` | Inviter, codes, sign-ups and conversions, and cursor-paged invited people and credits. |
| `PUT /users/:channelID/referrer` | Set, move or remove the channel’s referrer. |
| `/users/:channelID/command-stats` | Channel command outcomes. |
| `/users/:channelID/eventsub-activity` | Channel Twitch event and alert activity. |

The channel workspace uses the owner command and EventSub write routes above. They call the shared write services with `override`: the owner can change built-in triggers, replies and descriptions, delete built-ins, switch command/keyword activation and match mode, and bypass plan limits on blocks and cooldowns, the one zero-second command limit, the raid field list, EventSub disable restrictions, plan gates and tier limits. Duplicate triggers still return 409; blocks must compile, permissions and levels must be valid, keywords must have valid format, and command triggers must contain only letters and numbers because chat stops at the first symbol. EventSub writes accept typed settings, never identity fields.

`channel_rows.ts` returns stored blocks as `{ v, root }` (writes accept that shape or the root), `permissionExpression` and `runsBuiltIn`; the list also supplies `meta.builtInActions`. `runsBuiltIn` means the bot runs built-in code instead of the stored reply. The Commands editor exposes the Runs/`func` choice, blocks and permission rule JSON, keyword matching and activation type. Owner cooldown writes set `cooldownOverride`, so chat uses the stored keyword cooldown even below the plan minimum; a site cooldown edit clears it. Default seeding recognizes a default by its stable `_id` even after owner edits, avoiding duplicates or errors. A basic built-in deleted on a channel without full access can be seeded again by the site.

Twitch events uses the chat-event catalog (`GET /site/events`) and exposes all stored settings, including unused duplicate rows. For duplicate type/version rows, the current type name takes precedence (for example `channel.bits.use` before old `channel.cheer`), otherwise the first; unused rows appear under Other subscriptions. Bits rules are edited through the site's `/bits-rules/:channelID` API. Command and event edits take effect in chat immediately, without notifying the streamer.

### Referrals

The Referrals tab at `/channels/:channelID/referrals` uses `admin/src/app/services/referrals-api.service.ts`. Its GET includes the inviter's reward and discount facts, the channel's codes with sign-ups and conversions from completed reward receipts, and cursor-paged invited people with earned credits. The PUT accepts a referrer by channel ID or login, an optional code, `replace` and `expectedReferrer` (the inviter user ID shown on the page, or `null` for nobody). The admin always sends `expectedReferrer`; if it no longer matches, nothing is written and the API returns 409 “Who invited them changed since this page loaded. Reload and try again.” Every set, move or remove write is compare-and-set on the inviter read by the API. Moving an existing referral to another inviter returns 409 unless `replace: true`, and `referrer: null` removes it. With no code supplied, the inviter's oldest active code is used; if none exists, the referral is stored without a code and earns the inviter no rewards. Already paid rewards stay where they were. Rewards require the code to remain an active code owned by the inviter.

`users.referralSource` records `manual` for owner-added referrals and `referralSetAt` records when they were set. `utils/billing.ts` makes code sign-ups eligible for the 10% first-subscription referral discount, subject to checkout eligibility; manual referrals do not get it, even with a code. `utils/referral_ledger.ts` includes manually added people with or without a code in the inviter's dashboard.

## Checks and rollout

The following commands are for future implementation releases, not a request to deploy this documentation. Replace `<run-id>` with the generated run ID. API checks use disposable Mongo, Redis and fixture providers. The bot activity check uses the same fixture directory and dependencies; the keyword cooldown check uses its own fixtures. The alert check uses its own fixtures, and the timer check reuses them.

| Check | Command |
| --- | --- |
| feed API | `scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-feed-api.mjs` |
| overview API | `scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-overview-api.mjs` |
| decisions API | `scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-decisions-api.mjs` |
| usage API | `scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-usage-api.mjs` |
| assistants API | `scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-assistants-api.mjs` |
| Gifts API | `scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis --test-env ops/checks/credit-gifts-fixtures/test-env.json --fixtures ops/checks/credit-gifts-fixtures --check ops/checks/admin-console-gifts-api.mjs` |
| Gifts API on cron | `scripts/saas-ops verify cron-<run-id> --dependency mongo --dependency redis --test-env ops/checks/credit-gifts-fixtures/test-env-cron.json --fixtures ops/checks/credit-gifts-fixtures --check ops/checks/admin-console-gifts-api.mjs` |
| Gift worker on cron | `scripts/saas-ops verify cron-<run-id> --dependency mongo --dependency redis --test-env ops/checks/credit-gifts-fixtures/test-env-cron.json --fixtures ops/checks/credit-gifts-fixtures --check ops/checks/credit-gifts.mjs` |
| owner edits API | `scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-owner-edits-api.mjs` |
| Bot activity | `scripts/saas-ops verify bot-<run-id> --dependency mongo --dependency redis --test-env ops/checks/admin-console-fixtures/test-env.json --fixtures ops/checks/admin-console-fixtures --check ops/checks/admin-console-bot-activity.mjs` |
| TTS activity | `scripts/saas-ops verify api-<run-id> --dependency mongo --dependency redis --fixtures ops/checks/fish-fixtures --test-env ops/checks/fish-fixtures/test-env.json --check ops/checks/admin-console-tts-activity-api.mjs` |
| Keyword cooldown override | `scripts/saas-ops verify bot-<run-id> --dependency mongo --dependency redis --test-env ops/checks/keywords-fixtures/test-env.json --fixtures ops/checks/keywords-fixtures --check ops/checks/keyword-cooldown-override-bot.mjs` |
| Alert activity | `scripts/saas-ops verify cron-<run-id> --check ops/checks/admin-console-alert-activity.mjs --dependency mongo --dependency redis --test-env ops/checks/admin-console-alert-activity-fixtures/test-env.json --fixtures ops/checks/admin-console-alert-activity-fixtures` |
| Timer activity | `scripts/saas-ops verify cron-<run-id> --check ops/checks/admin-console-timer-activity.mjs --dependency mongo --dependency redis --test-env ops/checks/admin-console-alert-activity-fixtures/test-env.json --fixtures ops/checks/admin-console-alert-activity-fixtures` |
| activity browser | `scripts/saas-ops verify admin-<run-id> --check ops/checks/admin-console-activity-browser.mjs` |
| ai browser | `scripts/saas-ops verify admin-<run-id> --check ops/checks/admin-console-ai-browser.mjs` |
| assistants browser | `scripts/saas-ops verify admin-<run-id> --check ops/checks/admin-console-assistants-browser.mjs` |
| channel browser | `scripts/saas-ops verify admin-<run-id> --check ops/checks/admin-console-channel-browser.mjs` |
| gifts browser | `scripts/saas-ops verify admin-<run-id> --check ops/checks/admin-console-gifts-browser.mjs` |
| referrals browser | `scripts/saas-ops verify admin-<run-id> --check ops/checks/admin-console-referrals-browser.mjs` |
| command editing browser | `scripts/saas-ops verify admin-<run-id> --check ops/checks/admin-console-command-editing-browser.mjs` |
| EventSub editing browser | `scripts/saas-ops verify admin-<run-id> --check ops/checks/admin-console-eventsub-editing-browser.mjs` |
| decisions browser | `scripts/saas-ops verify admin-<run-id> --check ops/checks/admin-console-decisions-browser.mjs` |
| overview browser | `scripts/saas-ops verify admin-<run-id> --check ops/checks/admin-console-overview-browser.mjs` |
| Admin regression | `scripts/saas-ops verify admin-<run-id> --check ops/checks/admin-ui.mjs` |

The cron gift fixture runs only the gift worker and the `polar-gifts-v1` consumer so the candidate fits the 3 GB test container. Browser checks mock API calls and cover mobile and desktop. They require the browser dependencies described in their headers. Run the page-specific check as well as the regression check. The bot activity check covers built-in error text, usage replies and refused voice requests using a fake speech service on `127.0.0.1:3000` inside the bot candidate. The activity browser check covers the new row wording. The keyword cooldown check verifies that keywords wait the plan minimum without `cooldownOverride`, and that chat uses the stored value with it, including 0.

These activity changes need verified api, bot and cron releases (shared timer rows, reference rows and redemption voice requests), plus admin.

For a change that touches usage recording, deploy verified candidates in order: cron, then api, then bot. The voice request classification compatibility comments in `src/handlers/tts_queue.handler.ts` and `src/utils/tts/queue_default_tts.util.ts` explain why an old API with a new bot could label reward voice requests differently in Polar and PostHog.
