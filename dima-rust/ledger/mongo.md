# MongoDB contract ledger (`domdimabot`)

Machine-readable source: [`mongo.json`](mongo.json) (keyed by collection). Regenerate with the scripts in `dima-rust/tools/ledger/` (see "How this was produced" at the end).

## Headline counts

| What | Count | How it was verified |
|---|---|---|
| Collections in DB | **110** | `db.getCollectionInfos()` in `mongo_census.js`; every one is a key in `mongo.json` (110 + 2 schema-only = 112 keys) |
| Documents in DB | **1,269,406** | sum of exact `countDocuments({})` per collection (collStats said 1,269,408; the 2-doc gap is stale fast-count metadata) |
| Mongoose models | **104** in **90** files | runtime introspection: every file in `dimabot/src` that calls `model(` and imports mongoose (90 files, no import errors) was imported with tsx; `mongoose.models` then held 104 models. Cross-checked against `grep model(` (77 files in `src/schemas/` incl. 1 test + `dimafx_retention.ts` helper with no model, and 15 files outside it) |
| Collections with a model and data | 102 | |
| Collections in DB with no model | 8 | set difference of the two lists above |
| Models whose collection does not exist | 2 | `channelconfigs` (ChannelConfig), `chat_logs` (Chat_Log); both models are dead code: no reference outside their schema file |
| Model calls mapped to a collection | 1439 | `mongo_code_usage.py` resolves imports/aliases to models and records op + flags per call |
| DB indexes | 398 (110 `_id_`, 4 GridFS, 284 declared) | all 284 declared indexes exist by key; 1 option conflict (below) |

## Collections by size, with schema options matrix

`_id`: type of the top-level `_id`. `ts`: Mongoose timestamps field names. `__v`: versionKey. `min`: `minimize` (Mongoose default true). `idx`: declared/DB non-`_id` indexes. `calls`: model calls in non-test code (`ups` upserts, `lean`, `agg` aggregates, `new/create` = `new Model()`, `create`, `insertMany`). `rust`: already touched by `dima-rust/src`.

| collection | docs | avg B | model (file) | _id | ts | __v | min | idx | calls | ups | lean | agg | new/create | rust |
|---|--:|--:|---|---|---|---|---|---|--:|--:|--:|--:|--:|---|
| `stream_activities` | 387694 | 363 | `stream_activity` (schemas/stream_activity.schema.ts:20) | String | - | - | true | 6/6 | 9 | 1 | 2 | 0 | 0 | yes |
| `stream_activity_aggregates` | 188889 | 466 | `stream_activity_aggregate` (schemas/stream_activity.schema.ts:38) | String | - | - | true | 4/4 | 8 | 1 | 6 | 0 | 0 | yes |
| `follow_relationship_ledgers` | 153040 | 367 | `follow_relationship_ledger` (schemas/follow_relationship_ledger.schema.ts:103) | ObjectId | created_at/updated_at | __v | true | 10/10 | 28 | 0 | 9 | 0 | 1 | yes |
| `streamviewersnapshots` | 152887 | 327 | `StreamViewerSnapshot` (schemas/stream_viewer_snapshot.schema.ts:35) | ObjectId | created_at/updated_at | __v | true | 6/6 | 7 | 0 | 5 | 0 | 1 | yes |
| `domain_event_deliveries` | 146184 | 565 | `domain_event_delivery` (schemas/domain_event_delivery.schema.ts:72) | ObjectId | createdAt/updatedAt | - | true | 8/8 | 19 | 1 | 4 | 2 | 1 |  |
| `domain_events` | 63194 | 1428 | `domain_event` (schemas/domain_event.schema.ts:55) | ObjectId | - | - | true | 12/12 | 42 | 0 | 12 | 2 | 17 | yes |
| `ai_usage_receipts` | 58770 | 540 | `ai_usage_receipts` (schemas/ai_usage_receipt.schema.ts:61) | ObjectId | created_at/updated_at | __v | true | 9/9 | 9 | 2 | 3 | 2 | 0 | yes |
| `dashboard_activity_dailies` | 29369 | 267 | `dashboard_activity_daily` (schemas/dashboard_activity.schema.ts:12) | String | - | - | true | 2/2 | 2 | 0 | 0 | 1 | 0 | yes |
| `stream_participants` | 22706 | 125 | `stream_participant` (schemas/stream_timeline.schema.ts:13) | ObjectId | - | - | true | 2/2 | 2 | 1 | 1 | 0 | 0 |  |
| `stream_markers` | 11143 | 262 | `stream_marker` (schemas/stream_timeline.schema.ts:29) | ObjectId | - | - | true | 4/4 | 6 | 3 | 2 | 0 | 0 |  |
| `channelstreamsummaries` | 10650 | 3163 | `ChannelStreamSummary` (schemas/channel_stream_summary.schema.ts:135) | ObjectId | created_at/updated_at | __v | true | 9/9 | 5 | 1 | 2 | 0 | 0 |  |
| `streamsessions` | 8669 | 617 | `StreamSession` (schemas/stream_session.schema.ts:72) | ObjectId | created_at/updated_at | __v | true | 9/9 | 45 | 2 | 28 | 0 | 0 | yes |
| `moderation_decisions` | 6302 | 3745 | `moderation_decision` (schemas/moderation_decision.schema.ts:57) | String | - | - | true | 4/4 | 22 | 1 | 6 | 0 | 0 |  |
| `moderation_chatters` | 6183 | 100 | `moderation_chatter` (schemas/moderation_chatter.schema.ts:10) | String | - | - | true | 0/0 | 1 | 1 | 0 | 0 | 0 |  |
| `commands` | 5333 | 480 | `Commands` (schemas/commands.schema.ts:94) | ObjectId | - | __v | true | 1/1 | 64 | 0 | 16 | 1 | 7 |  |
| `channelaimemories` | 5258 | 1420 | `ChannelAIMemory` (schemas/channel_ai_memory.schema.ts:136) | ObjectId | createdAt/updatedAt | __v | true | 6/6 | 24 | 0 | 9 | 0 | 1 |  |
| `stream_subscription_ledgers` | 3217 | 563 | `stream_subscription_ledger` (schemas/stream_subscription_ledger.schema.ts:54) | ObjectId | created_at/updated_at | __v | true | 10/10 | 15 | 0 | 3 | 0 | 2 |  |
| `eventsubs` | 2154 | 615 | `eventsub` (schemas/eventsub.schema.ts:80) | ObjectId | - | __v | true | 2/2 | 59 | 4 | 32 | 1 | 0 |  |
| `ai_usage_dailies` | 1532 | 397 | `ai_usage_daily` (schemas/ai_usage_daily.schema.ts:37) | ObjectId | created_at/updated_at | __v | true | 2/2 | 5 | 0 | 0 | 1 | 1 | yes |
| `raid_analytics_histories` | 1184 | 315 | `raid_analytics_history` (schemas/raid_analytics.schema.ts:14) | String | - | - | true | 5/5 | 6 | 1 | 2 | 2 | 0 | yes |
| `duel_results` | 663 | 149 | `DuelResult` (duel/stats.ts:12) | String | - | - | true | 1/1 | 4 | 0 | 0 | 1 | 1 |  |
| `stream_operations_receipts` | 643 | 444 | `stream_operations_receipt` (schemas/stream_operations_receipt.schema.ts:15) | String | - | - | true | 1/1 | 2 | 1 | 1 | 0 | 0 |  |
| `cron_job_intents` | 603 | 896 | `cron_job_intent` (schemas/cron_job_intent.schema.ts:48) | ObjectId | createdAt/updatedAt | - | true | 5/5 | 0 | 0 | 0 | 0 | 0 |  |
| `oauth_refresh_tokens` | 536 | 189 | `OAuthRefreshToken` (schemas/oauth_refresh_token.schema.ts:12) | ObjectId | createdAt/updatedAt | __v | true | 3/3 | 7 | 0 | 0 | 0 | 2 |  |
| `pet_requests` | 391 | 1111 | `PetRequest` (schemas/pet_runtime.schema.ts:38) | String | - | - | true | 4/4 | 52 | 0 | 38 | 0 | 2 |  |
| `private_assets.chunks` | 330 | 251361 | *none* (schemaless) |  |  |  |  | 0/1 | 0 | 0 | 0 | 0 | 0 |  |
| `mediaassets` | 182 | 997 | `MediaAsset` (schemas/media_asset.schema.ts:90) | ObjectId | createdAt/updatedAt | __v | true | 11/11 | 39 | 0 | 12 | 0 | 3 |  |
| `users` | 168 | 1464 | `users` (schemas/users.schema.ts:126) | ObjectId | created_at/updated_at | __v | true | 0/0 | 159 | 0 | 81 | 8 | 4 | yes |
| `ai_usage_ledger_states` | 167 | 213 | `ai_usage_ledger_states` (schemas/ai_usage_ledger_state.schema.ts:23) | ObjectId | created_at/updated_at | __v | true | 1/1 | 5 | 1 | 2 | 0 | 0 | yes |
| `usermedialibraryitems` | 118 | 320 | `UserMediaLibraryItem` (schemas/user_media_library_item.schema.ts:50) | ObjectId | createdAt/updatedAt | __v | true | 7/7 | 16 | 0 | 2 | 1 | 3 |  |
| `triggers` | 100 | 376 | `Trigger` (schemas/trigger.schema.ts:52) | ObjectId | - | __v | true | 0/0 | 27 | 0 | 7 | 0 | 1 |  |
| `overlay_interactions` | 98 | 889 | `OverlayInteraction` (overlays/interactions.ts:11) | String | - | - | true | 0/0 | 4 | 0 | 2 | 0 | 1 |  |
| `raid_analytics_summaries` | 95 | 1775 | `raid_analytics_summary` (schemas/raid_analytics.schema.ts:22) | String | - | - | true | 1/1 | 8 | 1 | 2 | 0 | 0 | yes |
| `channels` | 85 | 488 | *none* (schemaless) |  |  |  |  | 0/0 | 0 | 0 | 0 | 0 | 0 |  |
| `channelaipersonalities` | 79 | 7309 | `ChannelAIPersonality` (schemas/channel_ai_personality.schema.ts:406) | ObjectId | - | __v | true | 0/0 | 26 | 0 | 10 | 0 | 4 |  |
| `moderation_action_logs` | 77 | 419 | `moderation_action_log` (schemas/moderation_action_log.schema.ts:37) | ObjectId | - | __v | true | 2/2 | 3 | 0 | 1 | 0 | 1 |  |
| `dashboard_activity_summaries` | 76 | 2135 | `dashboard_activity_summary` (schemas/dashboard_activity.schema.ts:19) | String | - | - | true | 1/1 | 8 | 1 | 2 | 0 | 0 | yes |
| `redemptionrewards` | 69 | 431 | `redemptionreward` (schemas/redemption_reward.schema.ts:49) | ObjectId | - | __v | true | 1/1 | 30 | 1 | 8 | 0 | 0 |  |
| `credittransactions` | 62 | 512 | `CreditTransaction` (schemas/credit_transaction.schema.ts:80) | ObjectId | createdAt/updatedAt | __v | true | 5/5 | 17 | 1 | 0 | 3 | 4 |  |
| `raid_sessions` | 48 | 485 | `raid_session` (schemas/raid_session.schema.ts:15) | String | - | - | true | 2/2 | 19 | 1 | 9 | 0 | 0 | yes |
| `channel_tts_settings` | 41 | 1217 | `channel_tts_settings` (schemas/channel_tts_settings.schema.ts:168) | ObjectId | createdAt/updatedAt | __v | true | 1/1 | 9 | 1 | 0 | 0 | 3 |  |
| `cliprecommendations` | 29 | 2628 | `ClipRecommendation` (schemas/clip_recommendation.schema.ts:140) | ObjectId | created_at/updated_at | __v | true | 15/15 | 16 | 0 | 2 | 0 | 4 |  |
| `follow_attack_logs` | 29 | 750 | `follow_attack_log` (schemas/follow_attack_log.schema.ts:80) | ObjectId | createdAt/updatedAt | __v | true | 6/6 | 6 | 0 | 3 | 0 | 1 | yes |
| `channel_moderation_settings` | 28 | 2577 | `channel_moderation_settings` (schemas/channel_moderation_settings.schema.ts:170) | ObjectId | createdAt/updatedAt | __v | true | 1/1 | 15 | 1 | 10 | 0 | 2 |  |
| `channel_fish_voice_favorites` | 27 | 779 | `channel_fish_voice_favorites` (schemas/channel_fish_voice_favorites.schema.ts:47) | ObjectId | - | __v | true | 1/1 | 5 | 1 | 2 | 0 | 0 |  |
| `admins` | 23 | 215 | `Admin` (schemas/admin.schema.ts:33) | ObjectId | - | __v | true | 0/0 | 29 | 0 | 19 | 0 | 1 |  |
| `extensionwallettransactions` | 20 | 329 | `ExtensionWalletTransaction` (schemas/extension_wallet_transaction.schema.ts:63) | ObjectId | createdAt/updatedAt | __v | true | 9/9 | 12 | 0 | 2 | 0 | 5 |  |
| `astvariables` | 19 | 198 | `AstVariables` (schemas/ast_variables.schema.ts:52) | ObjectId | createdAt/updatedAt | __v | true | 3/3 | 4 | 2 | 0 | 0 | 0 |  |
| `duel_widgets` | 18 | 2416 | `DuelWidget` (duel/service.ts:17) | String | - | - | true | 1/1 | 22 | 0 | 6 | 0 | 1 |  |
| `private_assets.files` | 18 | 161 | *none* (schemaless) |  |  |  |  | 0/1 | 0 | 0 | 0 | 0 | 0 |  |
| `custom_timers` | 16 | 348 | `custom_timer` (schemas/custom_timer.schema.ts:66) | ObjectId | created_at/updated_at | __v | true | 2/2 | 19 | 0 | 6 | 0 | 1 |  |
| `domain_event_checkpoints` | 14 | 137 | `domain_event_checkpoint` (schemas/domain_event_checkpoint.schema.ts:23) | ObjectId | createdAt/updatedAt | - | true | 1/1 | 2 | 1 | 1 | 0 | 0 |  |
| `follow_defense_settings` | 13 | 376 | `follow_defense_settings` (schemas/follow_defense_settings.schema.ts:45) | ObjectId | createdAt/updatedAt | __v | true | 1/1 | 11 | 2 | 7 | 0 | 0 | yes |
| `overlay_studios` | 12 | 3381 | `OverlayStudio` (overlays/store.ts:17) | String | - | - | true | 1/1 | 10 | 0 | 8 | 0 | 1 |  |
| `desktop_ai_turns` | 11 | 1230 | `DesktopAiTurn` (desktop_ai/schema.ts:30) | String | - | - | true | 4/4 | 25 | 0 | 15 | 0 | 1 |  |
| `raid_followers` | 11 | 462 | `raid_follower` (schemas/raid_session.schema.ts:28) | String | - | - | true | 4/4 | 14 | 1 | 3 | 1 | 0 | yes |
| `referralcodes` | 11 | 163 | `ReferralCode` (schemas/referral_code.schema.ts:71) | ObjectId | createdAt/updatedAt | __v | true | 3/3 | 9 | 0 | 3 | 0 | 1 |  |
| `triggerfiles` | 10 | 332 | `TriggerFile` (schemas/trigger_file.schema.ts:36) | ObjectId | - | __v | true | 0/0 | 5 | 0 | 2 | 0 | 0 |  |
| `widget_channels` | 10 | 1361 | `WidgetChannel` (widgets/service.ts:18) | String | - | - | true | 1/1 | 15 | 0 | 7 | 0 | 1 |  |
| `stream_operations_reconciliations` | 7 | 71 | `stream_operations_reconciliation` (schemas/stream_operations_receipt.schema.ts:23) | String | - | - | true | 1/1 | 5 | 1 | 1 | 0 | 0 |  |
| `creditgifts` | 6 | 1128 | `CreditGift` (schemas/credit_gift.schema.ts:89) | String | createdAt/updatedAt | __v | true | 2/2 | 11 | 1 | 4 | 0 | 0 |  |
| `events` | 6 | 875 | `Event` (schemas/event.schema.ts:208) | ObjectId | - | __v | true | 0/0 | 13 | 0 | 6 | 0 | 1 |  |
| `ai_usage_dashboards` | 5 | 2650 | `ai_usage_dashboards` (schemas/ai_usage_dashboard.schema.ts:17) | ObjectId | - | __v | true | 4/4 | 7 | 1 | 2 | 0 | 0 | yes |
| `dashboard_insights` | 5 | 6754 | `dashboard_insights` (schemas/dashboard_insights.schema.ts:10) | String | - | - | true | 2/2 | 7 | 1 | 2 | 0 | 0 | yes |
| `oauth_sessions` | 5 | 536 | `OAuthSession` (schemas/oauth_session.schema.ts:19) | ObjectId | createdAt/updatedAt | __v | true | 3/3 | 20 | 0 | 7 | 0 | 1 |  |
| `roulette_channels` | 5 | 26359 | `RouletteChannel` (roulette/service.ts:19) | String | - | - | true | 2/2 | 16 | 0 | 9 | 0 | 1 | yes |
| `site_agent_changes` | 5 | 1183 | `site_agent_changes` (site_agent/changes.schema.ts:85) | ObjectId | - | - | false | 3/3 | 7 | 0 | 4 | 0 | 1 |  |
| `asset_libraries` | 4 | 960 | `AssetLibrary` (assets/library.ts:27) | String | - | - | true | 0/0 | 9 | 1 | 4 | 0 | 0 |  |
| `pet_runtimes` | 4 | 247 | `PetRuntime` (schemas/pet_runtime.schema.ts:58) | String | - | - | true | 2/2 | 47 | 1 | 28 | 0 | 0 |  |
| `titleconfigs` | 4 | 159 | `titleConfig` (schemas/title_config.schema.ts:20) | ObjectId | - | __v | true | 0/0 | 1 | 0 | 0 | 0 | 0 |  |
| `custom_widgets` | 3 | 16443 | `CustomWidget` (custom_widgets/store.ts:44) | String | - | - | false | 1/1 | 18 | 0 | 2 | 0 | 1 |  |
| `moderation_variation_caches` | 3 | 561 | `moderation_variation_cache` (schemas/moderation_variation.schema.ts:6) | String | - | - | true | 1/1 | 2 | 1 | 1 | 0 | 0 |  |
| `oauth_grants` | 3 | 339 | `OAuthGrant` (schemas/oauth_grant.schema.ts:12) | ObjectId | createdAt/updatedAt | __v | true | 2/2 | 8 | 1 | 2 | 0 | 0 |  |
| `pet_settings` | 3 | 1981 | `pet_settings` (schemas/pet_settings.schema.ts:55) | ObjectId | - | - | true | 1/1 | 10 | 0 | 6 | 0 | 1 |  |
| `accounts` | 2 | 1086 | `Account` (schemas/accounts.schema.ts:28) | ObjectId | - | __v | true | 0/0 | 0 | 0 | 0 | 0 | 0 |  |
| `bits_rules` | 2 | 458 | `BitsRules` (bits_rules/store.ts:10) | String | - | - | true | 0/0 | 3 | 0 | 1 | 0 | 1 |  |
| `channelextensionitems` | 2 | 375 | `ChannelExtensionItem` (schemas/channel_extension_item.schema.ts:106) | ObjectId | createdAt/updatedAt | __v | true | 11/11 | 14 | 0 | 4 | 0 | 2 |  |
| `cliprecommendationconfigs` | 2 | 141 | `ClipRecommendationConfig` (schemas/clip_recommendation_config.schema.ts:20) | ObjectId | created_at/updated_at | __v | true | 2/2 | 5 | 2 | 4 | 0 | 0 |  |
| `countdowntimerconfigs` | 2 | 175 | `Countdowntimerconfig` (schemas/countdown_timer_config.schema.ts:30) | ObjectId | - | __v | true | 0/0 | 1 | 0 | 0 | 0 | 0 |  |
| `countdowntimers` | 2 | 160 | `Countdowntimer` (schemas/countdown_timer.schema.ts:26) | ObjectId | - | __v | true | 0/0 | 1 | 0 | 0 | 0 | 0 |  |
| `custom_widget_store` | 2 | 197 | `CustomWidgetStore` (custom_widgets/widget-store.ts:15) | String | - | - | false | 1/1 | 4 | 1 | 2 | 1 | 0 |  |
| `moderation_variation_jobs` | 2 | 1424 | `moderation_variation_job` (schemas/moderation_variation.schema.ts:19) | String | - | - | true | 2/2 | 14 | 0 | 7 | 0 | 1 |  |
| `raid_subscription_preferences` | 2 | 163 | `raid_subscription_preference` (schemas/raid_subscription_preference.schema.ts:10) | String | - | - | true | 1/1 | 7 | 2 | 2 | 0 | 0 |  |
| `stream_activity_states` | 2 | 116 | `stream_activity_state` (schemas/stream_activity.schema.ts:44) | String | - | - | true | 0/0 | 12 | 2 | 2 | 0 | 0 | yes |
| `app_configs` | 1 | 177 | `app_config` (schemas/app_config.schema.ts:24) | ObjectId | - | __v | true | 0/0 | 0 | 0 | 0 | 0 | 0 |  |
| `botinfos` | 1 | 57 | *none* (schemaless) |  |  |  |  | 0/0 | 0 | 0 | 0 | 0 | 0 |  |
| `channel_goals` | 1 | 205 | `ChannelGoals` (goals/service.ts:20) | String | - | - | true | 0/0 | 19 | 0 | 8 | 0 | 2 |  |
| `follow_defense_controls` | 1 | 155 | `follow_defense_control` (schemas/follow_defense_action.schema.ts:53) | String | - | - | true | 1/1 | 11 | 1 | 3 | 0 | 0 | yes |
| `goal_contributions` | 1 | 181 | `GoalContribution` (goals/service.ts:26) | String | - | - | true | 2/2 | 4 | 1 | 1 | 1 | 0 |  |
| `oauth_clients` | 1 | 450 | `OAuthClient` (schemas/oauth_client.schema.ts:12) | ObjectId | createdAt/updatedAt | __v | true | 1/1 | 5 | 1 | 2 | 0 | 0 |  |
| `pet_readiness` | 1 | 83 | `PetReadiness` (pets/readiness.schema.ts:11) | String | - | - | true | 1/1 | 9 | 2 | 2 | 0 | 0 |  |
| `random_user_settings` | 1 | 178 | `random_user_settings` (schemas/randomuser_settings.schema.ts:13) | ObjectId | createdAt/updatedAt | __v | true | 1/1 | 2 | 1 | 1 | 0 | 0 |  |
| `site_analytics` | 1 | 2445 | `site_analytics` (schemas/site_analytics.schema.ts:64) | ObjectId | created_at/updated_at | __v | true | 1/1 | 2 | 1 | 1 | 0 | 0 |  |
| `userextensioninventories` | 1 | 386 | `UserExtensionInventory` (schemas/user_extension_inventory.schema.ts:74) | ObjectId | createdAt/updatedAt | __v | true | 3/3 | 21 | 1 | 13 | 0 | 0 |  |
| `clipdesigns` | 0 | 0 | `ClipDesign` (schemas/clip_design.schema.ts:66) | ObjectId | - | __v | true | 1/1 | 1 | 0 | 0 | 0 | 0 |  |
| `commanduservariables` | 0 | 0 | `CommandUserVariables` (schemas/command_user_variables.schema.ts:39) | ObjectId | createdAt/updatedAt | __v | true | 3/3 | 2 | 0 | 0 | 0 | 0 |  |
| `desktop_ai_conversations` | 0 | 0 | `DesktopAiConversation` (desktop_ai/schema.ts:36) | String | - | - | true | 1/1 | 4 | 0 | 1 | 0 | 1 |  |
| `dimafxplaybacks` | 0 | 0 | `DimafxPlayback` (schemas/dimafx_playback.schema.ts:34) | String | createdAt/updatedAt | __v | true | 2/2 | 14 | 1 | 3 | 0 | 0 |  |
| `duel_moderator_restores` | 0 | 0 | `DuelModeratorRestore` (duel/completion.ts:21) | String | - | - | true | 1/1 | 10 | 0 | 1 | 0 | 1 |  |
| `follow_defense_actions` | 0 | 0 | `follow_defense_action` (schemas/follow_defense_action.schema.ts:37) | String | createdAt/updatedAt | - | true | 5/5 | 16 | 2 | 4 | 3 | 0 | yes |
| `follow_hate_raid_sources` | 0 | 0 | `follow_hate_raid_source` (schemas/follow_hate_raid_source.schema.ts:37) | ObjectId | createdAt/updatedAt | __v | true | 4/4 | 5 | 1 | 1 | 0 | 0 |  |
| `goal_custom_receipts` | 0 | 0 | `GoalCustomReceipt` (goals/service.ts:29) | String | - | - | true | 0/0 | 3 | 1 | 3 | 0 | 0 |  |
| `overlay_deliveries` | 0 | 0 | *none* (schemaless) |  |  |  |  | 0/0 | 0 | 0 | 0 | 0 | 0 |  |
| `overlay_media.chunks` | 0 | 0 | *none* (schemaless) |  |  |  |  | 0/1 | 0 | 0 | 0 | 0 | 0 |  |
| `overlay_media.files` | 0 | 0 | *none* (schemaless) |  |  |  |  | 0/1 | 0 | 0 | 0 | 0 | 0 |  |
| `overlay_source_leases` | 0 | 0 | *none* (schemaless) |  |  |  |  | 0/0 | 0 | 0 | 0 | 0 | 0 |  |
| `raid_moderation_requests` | 0 | 0 | `raid_moderation_request` (schemas/raid_session.schema.ts:42) | String | - | - | true | 2/2 | 17 | 1 | 6 | 0 | 0 | yes |
| `temporary_moderators` | 0 | 0 | `temporary_moderator` (schemas/temporary_moderator.schema.ts:26) | ObjectId | - | __v | true | 4/4 | 3 | 1 | 1 | 0 | 0 |  |
| `timer_commands` | 0 | 0 | `timer_command` (schemas/command_timer.schema.ts:30) | ObjectId | - | __v | true | 0/0 | 1 | 0 | 0 | 0 | 0 |  |
| `vips` | 0 | 0 | `vip` (schemas/vip.schema.ts:46) | ObjectId | - | __v | true | 0/0 | 7 | 1 | 1 | 0 | 2 |  |
| `channelconfigs` | missing |  | `channelconfig` (schemas/channel_config.schema.ts:28) | ObjectId | - | __v | true | 0/- | 0 | 0 | 0 | 0 | 0 |  |
| `chat_logs` | missing |  | `Chat_Log` (schemas/chat_logs.schema.ts:18) | ObjectId | - | __v | true | 0/- | 0 | 0 | 0 | 0 | 0 |  |

## Hooks (user-defined; Mongoose built-ins excluded)

| at | hook | what it does | Rust must |
|---|---|---|---|
| `src/schemas/admin.schema.ts:28` | `pre('save')` | sets updatedAt = new Date() on every save() | set `updatedAt` on every full-document write of `admins` |
| `src/schemas/app_config.schema.ts:19` | `pre('save')` | sets refreshed_at = new Date() on every save() | set `refreshed_at` (model unused today) |
| `src/schemas/channel_ai_personality.schema.ts:342` | `pre('validate')` | pre-validate: ensureProfiles() normalises profiles[] / activeProfileId | run the same `ensureProfiles` normalisation before validating |
| `src/schemas/channel_ai_personality.schema.ts:347` | `pre('save')` | pre-save: ensureProfiles(); loads users by accounts.id=channelID (throws if missing); enforces plan-tier limits on profiles/rules/knownUsers (throws); rewrites profiles[].createdAt (keep)/updatedAt (now); sets contextWindow 35/15/7 by plan_tier | reproduce tier checks + `contextWindow` + per-profile timestamps in the service layer (the hook only runs on `save()`/`create()`, not on `updateOne`) |
| `src/schemas/clip_design.schema.ts:51` | `pre('save')` | sets updatedAt = new Date() on every save() | set `updatedAt` (collection empty) |
| `src/schemas/clip_design.schema.ts:56` | `pre('save')` | if isDefault: updateMany({channelID, _id:{$ne}}, {isDefault:false}) (single-default invariant) | clear other defaults for the channel when `isDefault` is saved |
| `src/schemas/event.schema.ts:203` | `pre('save')` | sets updatedAt = new Date() on every save() | set `updatedAt` on save |
| `src/schemas/referral_code.schema.ts:64` | `pre('save')` | lower-cases code when modified | lower-case `code` before writing (and `findByCode` statics lower-cases on read, referral_code.schema.ts:60) |
| `src/utils/availability/schema.ts:31` | `pre('updateOne|findOneAndUpdate|updateMany')` | query hook on updateOne/findOneAndUpdate/updateMany (commands, redemptionrewards via addAvailabilityFields): unless the query is flagged internalWrite(), strips any availability*/availabilityLease* keys from the update and, if the update sets the enabled field (commands.enabled / redemptionrewards.isEnabled), adds $set.availability = {token: randomUUID(), previousEnabled, restoreAt: null, pending: true, nextAt: now} | on every non-internal update of `commands`/`redemptionrewards` that sets `enabled`/`isEnabled`, write the same `availability` object, and never let callers set `availability*` directly (registered by `commands.schema.ts:92`, `redemption_reward.schema.ts:47`) |
| `src/utils/availability/schema.ts:48` | `pre('save')` | pre-save (same two collections): on a loaded doc whose enabled field changed, sets availability = availabilityState(enabled) | same on full-document saves when the enabled flag changed |

The only query middleware is the availability hook above; everything else is document `save`/`validate` middleware, which `updateOne`-style writes skip. No `post` hooks, plugins, discriminators, virtuals with setters, or custom getters exist. Statics: `ReferralCode.findByCode` (referral_code.schema.ts:60). Two `save()` helpers live inside `channel_tts_settings.schema.ts:190,193`.

## Index diffs (code vs DB)

- Declared but missing in DB: **none**. In DB but not declared: **none** except GridFS bucket indexes (`private_assets.*`, `overlay_media.*`, created by the driver) and `_id_`.
- **Option conflict** `extensionwallettransactions` key `[['twitchTransactionID', 1]]`: declared `{"unique": true, "partialFilterExpression": {"twitchTransactionID": {"$type": "string"}}}` but DB has `{}` (plain non-unique `twitchTransactionID_1`). Mongoose `autoIndex` cannot fix this (same name, different options → IndexOptionsConflict, logged and ignored), so uniqueness of Twitch transaction IDs is **not enforced** in this copy. Rust must not rely on a duplicate-key error here; decide whether to migrate the index (`extension_wallet_transaction.schema.ts:53-56`).
- `users` declares no index at all; DB has only `_id_`, while code queries `accounts.type`+`accounts.id` constantly (and `dima-analytics/src/channel-names.mjs:35` does `$elemMatch`). Performance note, not a compatibility issue.
- TTL indexes (31, all from code): `expireAfterSeconds: 0` on a per-document date (`expiresAt`, `purgeAt`, `expires_at`) everywhere except `moderation_action_logs.createdAt` (30 d), `extensionwallettransactions.createdAt` and `dimafxplaybacks.createdAt` (365 d). Writers must store real BSON dates in these fields or documents never expire.
- Partial unique indexes whose filter a writer must match exactly: `credittransactions.idempotencyKey` (`$type: string`), `pet_runtimes.tokenHash` (`$type: string`), `follow_relationship_ledgers` and `stream_subscription_ledgers` (`status: "active"`), `streamsessions` (`channelID, ended_at` where `ended_at: null`), `usermedialibraryitems` (`isActive: true`), `domain_events` (`dispatchPending: true`; `metadata.durableChatHandled: true`). Sparse: 8 (see `mongo.json`). No collation or text indexes anywhere.

## Data vs schema diffs

### Fields in data that the schema does not declare

Mongoose (`strict: true` everywhere) ignores these on read and drops them from its own writes; they survive only because updates use `$set`.

| collection | fields | origin |
|---|---|---|
| `channel_tts_settings` | `aiProvider`, `providerSettings`, `providerSettings.openrouter`, `voices.aiDefault`, `voices.aiVoices`, `voices.aiVoicesByProvider` | removed AI-TTS provider feature; legacy |
| `channelaipersonalities` | `knownUsers[]._id` | older documents created before `knownUsers` got `_id: false` |
| `raid_analytics_summaries` | `rustPending`, `rustRefresh`, `rustRefresh.dirtyAt`, `rustRefresh.fingerprint`, `rustRefresh.hasFollowWindows`, `rustRefresh.nextOpenAt`, `rustRefresh.nextRepairAt`, `rustRefresh.nextSourceAt`, `rustRefresh.version` | **written by the Rust raid_analytics worker** (`dima-rust/src/workers/raid_analytics.rs`); TS never sees them, and `dashboard.route.ts:81` returns them to the browser via `.lean()` |

Also: `users.accounts[].access_token` / `refresh_token` are declared as nested `{iv, content}` objects (encrypted, `src/utils/crypto.ts`), present in data as objects.

### Schema fields never seen in the sample (top level exact; depth 2 from up to 300 sampled docs)

These are optional fields the Rust structs must still model as `Option`/default; they appear only in certain states (leases, pending availability, etc.).

| collection | fields |
|---|---|
| `app_configs` | `__v`, `refreshed_at` |
| `asset_libraries` | `assets[].purpose` |
| `channel_goals` | `monthlyCursors`, `outcomes`, `twitchActions`, `twitchActions[]` |
| `channelaimemories` | `expiresAt` |
| `channelextensionitems` | `tts`, `tts.language`, `tts.mode`, `tts.text`, `tts.voice` |
| `cliprecommendations` | `notificationPayload`, `notificationPayload.from`, `notificationPayload.html`, `notificationPayload.subject`, `notificationPayload.text`, `notificationPayload.to` |
| `commands` | `availability`, `availability.nextAt`, `availability.pending`, `availability.previousEnabled`, `availability.restoreAt`, `availability.token`, `availabilityLease`, `availabilityLease.token`, `availabilityLease.until`, `keywordSettings.matchMode` |
| `creditgifts` | `announcementStoppedAt`, `leaseToken`, `leaseUntil` |
| `cron_job_intents` | `leaseUntil`, `owner`, `token` |
| `custom_widgets` | `network` |
| `desktop_ai_turns` | `moodText`, `operations[].outcome`, `speech.durationMs`, `speech.mimeType`, `speech.path`, `speech.playbackDeadline`, `speech.privateDir`, `speech.startBefore`, `speech.startClaimed`, `speech.stopConfirmed`, `speech.ticketExpiresAt`, `speech.ticketHash` |
| `events` | `config[].placeholder` |
| `follow_attack_logs` | `trackedFollows[].banMessage`, `trackedFollows[].banStatus` |
| `follow_defense_controls` | `ratePerSecond`, `successStreak` |
| `goal_contributions` | `expiresAt` |
| `overlay_studios` | `controls` |
| `pet_readiness` | `authorizationExpiresAt`, `expiresAt`, `generation`, `peerId`, `sessionId`, `settingsRevision`, `validatedAt` |
| `pet_requests` | `audio.durationMs`, `audio.mimeType`, `audio.path`, `audioFetched`, `deliveryAttempted`, `mood`, `moodText`, `privateDir` |
| `pet_runtimes` | `lease.expiresAt`, `lease.holderPeerId`, `lease.leaseId`, `ttsReservation.expiresAt`, `ttsReservation.speechId`, `ttsReservation.token` |
| `redemptionrewards` | `availability`, `availability.nextAt`, `availability.pending`, `availability.previousEnabled`, `availability.restoreAt`, `availability.token`, `availabilityLease`, `availabilityLease.token`, `availabilityLease.until`, `backgroundColor` |
| `stream_activity_states` | `active.ids`, `active.seq` |
| `stream_operations_reconciliations` | `lastError`, `leaseToken`, `leaseUntil` |
| `userextensioninventories` | `dimafxReceipts`, `dimafxReceipts[]` |
| `users` | `polar_plan_effects_pending` |
| `widget_channels` | `eventReceipts[].at`, `eventReceipts[].key`, `overlayToken` |

Empty collections (no data to compare): `clipdesigns`, `commanduservariables`, `desktop_ai_conversations`, `dimafxplaybacks`, `duel_moderator_restores`, `follow_defense_actions`, `follow_hate_raid_sources`, `goal_custom_receipts`, `overlay_deliveries`, `overlay_media.chunks`, `overlay_media.files`, `overlay_source_leases`, `raid_moderation_requests`, `temporary_moderators`, `timer_commands`, `vips`.

### BSON type variance

No field holds a type that contradicts its schema type (no string-in-Number, no string dates, no string ObjectIds) in the exact top-level census or the deep sample. All variance is numeric width, apart from the `Mixed` field `events.config[].value`:

| collection.field | schema | BSON types seen (count) | source |
|---|---|---|---|
| `channelaimemories.confidence` | Number | int 39, double 5219 | exact |
| `channelaimemories.qdrantPointID` | Number | int 2483, double 2694 | exact |
| `channelstreamsummaries.duration_minutes` | Number | int 1056, double 9594 | exact |
| `channelstreamsummaries.proposed_actions[].confidence` | Number | double 668, int 15 | sample |
| `events.config[].value` | Mixed | string 7, bool 2, array 1, int 1 | sample |
| `extensionwallettransactions.balanceDelta` | Number | int 17, double 3 | exact |
| `moderation_decisions.charge.billableCostUSD` | wildcard | int 251, double 31 | sample |
| `moderation_decisions.cost` | Number | int 1412, double 4890 | exact |
| `stream_activities.offset` | Number | double 387304, int 390 | exact |
| `stream_activity_aggregates.bits` | Number | int 187950, double 939 | exact |
| `stream_activity_aggregates.bucket` | Number | int 22916, long 165973 | exact |
| `stream_activity_aggregates.chatters` | Number | int 170174, double 18715 | exact |
| `stream_activity_aggregates.commands` | Number | int 183439, double 5450 | exact |
| `stream_activity_aggregates.count` | Number | double 61343, int 127546 | exact |
| `stream_activity_aggregates.emoteMessages` | Number | double 19724, int 169165 | exact |
| `stream_activity_aggregates.emotes` | Number | int 169165, double 19724 | exact |
| `stream_activity_aggregates.failures` | Number | int 183325, double 5564 | exact |
| `stream_activity_aggregates.firstSeq` | Number | int 8829, double 84985 | exact |
| `stream_activity_aggregates.follows` | Number | double 941, int 187948 | exact |
| `stream_activity_aggregates.lastSeq` | Number | int 107618, double 81271 | exact |
| `stream_activity_aggregates.messages` | Number | int 113386, double 75503 | exact |
| `stream_activity_aggregates.raids` | Number | int 188382, double 507 | exact |
| `stream_activity_aggregates.redemptions` | Number | int 188396, double 493 | exact |
| `stream_activity_aggregates.subs` | Number | double 444, int 188445 | exact |
| `stream_activity_states.seq` | Number | int 1, double 1 | exact |
| `streamsessions.duration_minutes` | Number | double 7823, int 846 | exact |

`long` values in `stream_activity_aggregates.bucket` (165,973 docs, including small values such as -1) come from the Rust stream_activity worker writing `i64`; Node never writes `long`. Integral `double` values (e.g. `firstSeq: 27724`) come from writers that store `f64`. `stream_activities.offset` is genuinely fractional (387,304 doubles).

## Collections with no Mongoose model

| collection | docs | who reads/writes it |
|---|--:|---|
| `botinfos` | 1 | legacy/unknown: no reader or writer in dimabot/src, dima-rust/src, dima-analytics, dimadb/server, dimafx/server (grep "botinfo") |
| `channels` | 85 | legacy: only read by the one-shot migration dimabot/src/utils/migrations/channels_to_users.ts:7 (pre-users schema) |
| `overlay_deliveries` | 0 | raw driver collection (no Mongoose model): dimabot/src/overlays/delivery-store.ts:18; shape = interface SavedDelivery (delivery-store.ts:15); TTL handled by code deleteMany, no TTL index |
| `overlay_media.chunks` | 0 | GridFS bucket overlay_media (delivery-store.ts:20) |
| `overlay_media.files` | 0 | GridFS bucket overlay_media (delivery-store.ts:20); metadata.expiresAt swept by sweepFiles() |
| `overlay_source_leases` | 0 | raw driver collection (no Mongoose model): dimabot/src/overlays/delivery-store.ts:19; shape = interface SavedPeer (delivery-store.ts:16) |
| `private_assets.chunks` | 330 | GridFS bucket private_assets (dimabot/src/assets/library.ts:42) |
| `private_assets.files` | 18 | GridFS bucket private_assets (dimabot/src/assets/library.ts:42) |

Models without a collection: `channelconfigs` (`src/schemas/channel_config.schema.ts:28`) and `chat_logs` (`src/schemas/chat_logs.schema.ts:18`). Two more models are unused although their collection exists: `Account` → `accounts` (2 docs) and `app_config` → `app_configs` (1 doc). All four can be dropped from the migration scope after the lead confirms.

## Raw driver and non-dimabot access

- `channels`: dimabot/src/utils/migrations/channels_to_users.ts:7 (legacy one-shot migration read)
- `commands`: dimabot/src/utils/migrations/migrate_ast_function_syntax.js:198 (legacy migration)
- `domain_events`: dimabot/src/utils/domain_events.ts:124 (DomainEventSchema.collection.insertOne(doc.toObject()) - bypasses Mongoose insert, defaults come from toObject())
- `eventsubs`: dimabot/src/utils/migrations/migrate_ast_function_syntax.js:246 (legacy migration)
- `overlay_deliveries`: dimabot/src/overlays/delivery-store.ts:18 (collection<SavedDelivery>)
- `overlay_deliveries`: dimabot/src/overlays/live.ts:343,344,358(replaceOne upsert),380,503,746
- `overlay_media.chunks`: dimabot/src/overlays/delivery-store.ts:20 (GridFSBucket overlay_media)
- `overlay_media.chunks`: dimabot/src/overlays/delivery-store.ts:35 (distinct/deleteMany files_id)
- `overlay_media.files`: dimabot/src/overlays/delivery-store.ts:20 (GridFSBucket overlay_media)
- `overlay_media.files`: dimabot/src/overlays/delivery-store.ts:34 (find metadata.expiresAt)
- `overlay_source_leases`: dimabot/src/overlays/delivery-store.ts:19 (collection<SavedPeer>)
- `overlay_source_leases`: dimabot/src/overlays/live.ts:336,354(replaceOne upsert),387,747
- `private_assets.chunks`: dimabot/src/assets/library.ts:42 (GridFSBucket private_assets)
- `private_assets.chunks`: dimabot/src/assets/library.ts:65 (deleteMany)
- `private_assets.files`: dimabot/src/assets/library.ts:42 (GridFSBucket private_assets)
- `private_assets.files`: dimabot/src/assets/library.ts:66 (deleteOne)
- `site_agent_changes`: dimabot/src/site_agent/cleanup.ts:35 (mongoose.connection.collection().deleteMany)
- `users`: dima-analytics/src/channel-names.mjs:35 (find accounts.$elemMatch {type,id}; projection accounts.type/id/name)
- any collection: dimadb/server/mongo.mjs:59-119 (generic DB console: find/findOne/replaceOne/insertOne/deleteOne on any collection, EJSON round-trip)
- any collection: dimabot/src/scripts/backup_full_database.script.ts:98 (reads every collection)
- `dimafx/server/src`: no MongoDB access (verified by grep for `mongo`).
- Existing Rust (`dima-rust/src`) touches: `ai_usage_dailies`, `ai_usage_dashboards`, `ai_usage_ledger_states`, `ai_usage_receipts`, `dashboard_activity_dailies`, `dashboard_activity_summaries`, `dashboard_insights`, `domain_events`, `follow_attack_logs`, `follow_defense_actions`, `follow_defense_controls`, `follow_defense_settings`, `follow_relationship_ledgers`, `raid_analytics_histories`, `raid_analytics_summaries`, `raid_followers`, `raid_moderation_requests`, `raid_sessions`, `roulette_channels`, `stream_activities`, `stream_activity_aggregates`, `stream_activity_states`, `streamsessions`, `streamviewersnapshots`, `users` (file:line per collection in `mongo.json` → `rustUsage`).

## Usage patterns that need a Rust equivalent

Full file:line lists are in `mongo.json` → `_meta.globalPatterns` (tests excluded) and per collection in `codeUsage` (with flags `upsert`, `setOnInsert`, `lean`, `session`, `arrayFilters`, `updatePipeline`, `returnNew`, `select`, …).

| pattern | count | where |
|---|--:|---|
| Transactions / sessions | 2 | `utils/follow_ledger.ts`×2 |
| Aggregation pipelines | 34 | `server/routes/admin_site.route.ts`×4, `scripts/invalidate_all_user_permissions.script.ts`×3, `utils/follow_defense_baseline.ts`×3, `utils/referral.ts`×3, `server/routes/follow_defense.route.ts`×2, `utils/ai_usage_ledger.ts`×2, `utils/domain_event_health.ts`×2, `utils/raid_analytics.ts`×2, `utils/referral_ledger.ts`×2, `custom_widgets/session.ts`×1, `custom_widgets/widget-store.ts`×1, `duel/stats.ts`×1 |
| `bulkWrite` | 10 | `utils/migrations/migrate_ast_function_syntax.js`×2, `utils/stream_activity.ts`×2, `scripts/migrate_event_plan_tier.script.ts`×1, `scripts/migrate_timer_frequency_minutes.script.ts`×1, `utils/ai_usage_ledger.ts`×1, `utils/dashboard_activity.ts`×1, `utils/follow_defense_actions.ts`×1, `utils/follow_ledger.ts`×1 |
| Upserts (`upsert: true`) | 74 | `utils/stream_activity.ts`×4, `utils/ai_usage_ledger.ts`×3, `utils/dashboard_activity.ts`×3, `utils/follow_defense_actions.ts`×3, `utils/raid_sessions.ts`×3, `utils/stream_timeline.ts`×3, `domain_events/stream_operations_events.ts`×2, `goals/service.ts`×2, `handlers/special_parser.handler.ts`×2, `overlays/live.ts`×2, `pets/readiness.ts`×2, `server/oauth/service.ts`×2 |
| `$setOnInsert` | 54 | `utils/stream_activity.ts`×4, `utils/ai_usage_ledger.ts`×3, `utils/dashboard_activity.ts`×3, `utils/raid_sessions.ts`×3, `utils/stream_timeline.ts`×3, `goals/service.ts`×2, `handlers/special_parser.handler.ts`×2, `utils/ast_parser/functions/moderation.functions.ts`×2, `utils/domain_event_consumer.ts`×2, `utils/follow_defense_actions.ts`×2, `utils/follow_ledger.ts`×2, `utils/raid_analytics.ts`×2 |
| `.save()` on documents (dirty tracking) | 51 | `utils/ai/clip_recommendations/vod_clip_recommendation_runner.ts`×11, `server/routes/trigger.route.ts`×5, `utils/ai/memory/memory.service.ts`×4, `server/routes/dimafx.route.ts`×3, `server/services/command_defaults.service.ts`×3, `utils/ai/clip_recommendations/clip_recommendation_notifications.ts`×3, `utils/overlay-token.ts`×3, `utils/stream_analytics.ts`×3, `commands/timer_manager.command.ts`×2, `schemas/channel_tts_settings.schema.ts`×2, `server/routes/admin.route.ts`×2, `server/services/command_mutations.service.ts`×2 |
| `.lean()` | 610 | `pets/runtime.ts`×24, `server/routes/dimafx.route.ts`×21, `utils/raid_sessions.ts`×20, `utils/stream_analytics.ts`×20, `desktop_ai/service.ts`×13, `utils/credit_gifts.ts`×13, `goals/service.ts`×11, `custom_widgets/store.ts`×10, `pets/admission.ts`×10, `server/routes/trigger.route.ts`×10, `scripts/reconcile_stream_offline.script.ts`×9, `utils/stream_activity.ts`×9 |
| `.lean()` result sent to HTTP (heuristic) | 84 | `server/routes/dimafx.route.ts`×10, `server/routes/trigger.route.ts`×10, `server/routes/admin.route.ts`×6, `server/routes/admin_site.route.ts`×6, `server/routes/clip-recommendations.route.ts`×6, `server/routes/follow_defense.route.ts`×6, `server/routes/moderation.route.ts`×5, `server/oauth/routes.ts`×4, `server/routes/dashboard.route.ts`×4, `server/routes/stream_timeline.route.ts`×4, `server/routes/user.route.ts`×4, `server/routes/eventsub.route.ts`×3 |
| `findById*` | 142 | `pets/runtime.ts`×12, `utils/credit_gifts.ts`×9, `goals/service.ts`×8, `pets/socket.ts`×6, `pets/read_tts.ts`×5, `utils/raid_sessions.ts`×5, `pets/state.ts`×4, `server/routes/trigger.route.ts`×4, `utils/moderation/variation_jobs.ts`×4, `assets/library.ts`×3, `domain_events/polar_billing_events.ts`×3, `duel/service.ts`×3 |
| explicit ObjectId construct/validate | 53 | `server/routes/dimafx.route.ts`×5, `assets/library.ts`×4, `server/routes/clip-recommendations.route.ts`×4, `server/routes/memories.route.ts`×4, `overlays/delivery-store.ts`×2, `schemas/channel_ai_personality.schema.ts`×2, `scripts/reconcile_stream_offline.script.ts`×2, `server/oauth/routes.ts`×2, `server/routes/stream-summary.route.ts`×2, `site_agent/changes.ts`×2, `utils/ai/memory/memory.service.ts`×2, `custom_widgets/store.ts`×1 |
| `toObject()/toJSON()` | 44 | `server/routes/trigger.route.ts`×13, `commands/timer_manager.command.ts`×12, `server/routes/dimafx.route.ts`×3, `pets/read_tts.ts`×2, `server/services/follow_defense_settings.service.ts`×2, `site_agent/tools/write/commands.ts`×2, `utils/moderation/defaults.ts`×2, `server/routes/aiPersonality.route.ts`×1, `server/routes/moderation.route.ts`×1, `server/routes/site.route.ts`×1, `server/services/ai_personality.service.ts`×1, `server/services/command_blocks.service.ts`×1 |
| Native `Model.collection.*` writes (bypass casting/defaults/timestamps) | 6 | `scripts/migrate_bits_canonical.script.ts`×1, `scripts/migrate_event_plan_tier.script.ts`×1, `scripts/migrate_shoutout_defaults.script.ts`×1, `scripts/migrate_speech_ast.script.ts`×1, `scripts/migrate_timer_frequency_minutes.script.ts`×1, `utils/domain_events.ts`×1 |
| Raw `connection.db` / `MongoClient` / GridFS | 33 | `scripts/migrate_speech_ast.script.ts`×5, `assets/library.ts`×4, `scripts/migrate_bits_canonical.script.ts`×4, `overlays/delivery-store.ts`×3, `scripts/migrate_ast_variables_global.script.ts`×2, `scripts/migrate_event_plan_tier.script.ts`×2, `scripts/migrate_shoutout_defaults.script.ts`×2, `scripts/migrate_timer_frequency_minutes.script.ts`×2, `utils/ai/minimax/minimax_client.ts`×2, `utils/migrations/migrate_ast_function_syntax.js`×2, `scripts/backup_full_database.script.ts`×1, `site_agent/cleanup.ts`×1 |
| `$where` | 1 | `server/services/ai_personality.service.ts`×1 |
| `Decimal128` / `Long` / `Int32` / `BigInt` | 0 | none in code; `long` only appears in data written by Rust |
| `populate`, change streams, `$text`, discriminators, `markModified`, `timestamps:false` / `strict:false` query options | 0 | none |

Notable specifics:
- **Transaction**: `src/utils/follow_ledger.ts:379-381` (`startSession` + `withTransaction` on `follow_relationship_ledgers`), with a non-transactional fallback when the server is not a replica set (`follow_ledger.ts:388`). The local copy is a standalone `mongod` 8.2.6, so the fallback path is what runs here.
- **Optimistic concurrency via `doc.$where`**: `src/server/services/ai_personality.service.ts:414` sets `$where = {updatedAt, __v}` so the following `save()` only matches an unchanged document. Rust equivalent: `update_one({_id, updatedAt, __v}, …)` and treat `matched_count == 0` as a conflict.
- **Native insert**: `src/utils/domain_events.ts:124` validates a Mongoose doc, then `DomainEventSchema.collection.insertOne(doc.toObject(), {writeConcern: {w: 1, j: true}})`; duplicate key on `eventKey` is the idempotency signal (`domain_events.ts:132`).
- **Number-typed epoch-millisecond times** (not BSON dates): `duel_moderator_restores.dueAt/leaseUntil`, `roulette_channels.dueAt/actionDueAt`, `widget_channels.dueAt`, queried with `Date.now()` (`src/duel/completion.ts:109,111`, `src/roulette/service.ts:173`, `src/roulette/actions.ts:40`, `src/widgets/service.ts:182`). Keep them numbers.
- **`select: false` fields** (18) must be excluded from default reads and from HTTP payloads (Mongoose drops them unless a query asks for `+field`): `cliprecommendations.notificationPayload`, `commands.blocks`, `commands.availability`, `commands.availabilityLease`, `creditgifts.checkoutUrl`, `duel_widgets.overlayToken`, `follow_hate_raid_sources.appliedLogIDs`, `oauth_sessions.current_refresh_hash`, `redemptionrewards.availability`, `redemptionrewards.availabilityLease`, `roulette_channels.overlayToken`, `site_agent_changes.undo`, `site_agent_changes.undoLockUntil`, `stream_subscription_ledgers.applied_event_keys`, `streamsessions.applied_domain_event_keys`, `users.polar_credit_snapshot`, `users.applied_credit_transaction_ids`, `widget_channels.overlayToken`.
- **Map fields** (4, keys may not contain `.` or start with `$`): `astvariables.variables`, `commands.variables`, `commanduservariables.variables`, `stream_operations_receipts.steps`. **Mixed fields**: 60 (list in `mongo.json`; search `"instance": "Mixed"`).
- **Array sub-documents that get an auto `_id`**: `cliprecommendations.candidates[]`, `events.config[]`, `users.accounts[]`. The other 54 sub-document paths are declared `_id: false`.
- **Computed defaults** (83) such as `Date.now`, `() => new Date(0)` for lease fields, `() => ({})`: listed with source in `mongo.json` (`default.computed`). `trim` setters: 18 paths (`events.*`, `custom_timers.name/message`, `channelextensionitems.*`). Custom validators: `custom_timers.frequency`, `events.config[].showIf`, `referralcodes.code`. Enums: 112 paths; `required`: 488 paths.

## Rules a Rust data layer must follow to stay compatible

> **Superseded where they differ.** These rules were written from reading Mongoose's source. The
> `dima_store::mongo` helpers were later derived from recordings of Mongoose itself (209 write cases and
> 105 filters in `crates/store/tests/mongo_golden`), which corrected several of them: every update on a
> timestamped schema carries `$setOnInsert.createdAt`; `create`, `insertMany` and bulk inserts treat
> `updatedAt` and `__v` differently; immutable paths have their own rules; filters are cast (use
> `prepare_filter` / `prepare_id_filter` instead of parsing ObjectIds by hand, rule 3). Where a rule
> below and the helpers disagree, the helpers are right.

Mongoose version in use: 8.24.3 with driver 6.21.0 (`dimabot/node_modules`). The connection is opened once in `dimabot/src/utils/databases/mongodb.database.ts:30` as `mongoose.connect(MONGO_URI, { monitorCommands: true })` with no global `mongoose.set(...)` and no plugins, so every Mongoose default applies (`autoIndex: true`, `autoCreate: true`, `strictQuery: false`, `setDefaultsOnInsert: true`, `bufferCommands: true`). Only `src/scripts/reconcile_stream_offline.script.ts:37-38` turns `autoIndex`/`autoCreate` off.

### Collection names and ids
1. Use the exact collection names in the table above. They come from Mongoose's legacy pluraliser (`Countdowntimer` → `countdowntimers`, `ai_usage_daily` → `ai_usage_dailies`, `pet_readiness` stays `pet_readiness`, `ChannelAIMemory` → `channelaimemories`); only `oauth_*` and `site_agent_changes` pass an explicit name. Never derive names in Rust.
2. `_id` type is per collection: 41 collections use **string** `_id` (column `_id`), the rest use **ObjectId**. A Rust struct must use `String` or `ObjectId` accordingly; mixing them breaks `findById` lookups silently (no match, no error).
3. Mongoose casts filter values to the schema type. TS code relies on this in 35 `findById*` calls on ObjectId collections (string from a route param or Redis → ObjectId, e.g. `src/server/routes/site.route.ts:245`, `src/utils/timer_cache.ts:91`, `src/utils/domain_event_consumer.ts:530`) and in `{_id: string}` / `{$in: [strings]}` filters. Rust must parse to `ObjectId` before querying and decide what an invalid hex string does (Mongoose throws `CastError`; the HTTP layer usually turns that into 400/500).
4. Sub-documents in arrays get their own ObjectId `_id` only in `users.accounts[]`, `events.config[]` and `cliprecommendations.candidates[]`; Rust must generate one when it appends to these arrays. Every other sub-document is `_id: false` (but old `channelaipersonalities.knownUsers[]` items still carry an `_id`: tolerate it on read).

### Timestamps (`ts` column)
5. Mongoose maintains timestamps on: `create`/`save` of a new doc (both fields = now); `save()` of a loaded doc **only if something changed** (updatedAt = now); every `updateOne`/`updateMany`/`findOneAndUpdate`/`replaceOne`/`bulkWrite` update op (adds `$set: {updatedAt: now}` even if nothing else changes; for a pipeline update it appends a `{$set: {updatedAt}}` stage) — `mongoose/lib/helpers/update/applyTimestampsToUpdate.js:44-74`.
6. On upserts the creation field goes in `$setOnInsert: {createdAt: now}`; a `createdAt` that the caller put in `$set` or at top level is **deleted** from the update (same file, lines 82-121), because the timestamp path is `immutable`. Rust must do the same: never overwrite the creation field of an existing doc.
7. Field names differ per collection: `created_at`/`updated_at` (13 collections), `createdAt`/`updatedAt` (others). Several collections without the option keep **hand-written** time fields instead: `createdAt` with `default: Date.now` and an `updatedAt` set by a `pre('save')` hook (`admins`, `events`, `clipdesigns`), or nothing at all. Those hand-written `updatedAt` fields are **not** touched by `updateOne`; match TS behaviour per call site, not per collection.
8. No call site disables timestamps (`timestamps: false` appears 0 times), so every TS update bumps `updatedAt`; Rust updates on timestamped collections must too, or TS code that sorts or polls by `updatedAt`/`updated_at` will miss Rust's writes.

### Version key `__v`
9. Collections with `__v` in the matrix get `__v: 0` on create **and on every upsert** (`$setOnInsert: {__v: 0}` added by `mongoose/lib/helpers/update/decorateUpdateWithVersionKey.js:8-26`, called from `model.js:2417,4172`). Plain updates never touch `__v`. `save()` increments it only after array modifications (versioned saves). The existing Rust worker already writes `"__v": 0` on insert (`dima-rust/src/workers/ai_usage_receipts/ledger.rs:116,160`); follow that. Data today: `__v` missing in only 12 docs total (`astvariables` 8, `credittransactions` 2, `titleconfigs` 1, `app_configs` 1).
10. `ai_personality.service.ts:414` uses `__v` + `updatedAt` as an optimistic-concurrency guard, so Rust writers of `channelaipersonalities` must keep `__v` stable on unrelated updates and bump `updatedAt`.
11. The 47 collections with `versionKey: false` (39 of the 41 `_id: String` collections — not `creditgifts` and `dimafxplaybacks`, which keep `__v` — plus `domain_events`, `domain_event_checkpoints`, `domain_event_deliveries`, `cron_job_intents`, `pet_settings`, `site_agent_changes`, `stream_markers`, `stream_participants`) must **not** receive `__v`. Note `follow_defense_settings` and `moderation_action_logs` do keep `__v`.

### Defaults, `minimize` and missing fields
12. `create`/`new` writes every schema default (including computed ones such as `Date.now`, `() => new Date(0)` lease fields, nested defaults) into the document. Upserts write defaults for every path that is not in the filter or update, through `$setOnInsert` (`setDefaultsOnInsert` is on by default: `mongoose/lib/helpers/setDefaultsOnInsert.js:18-24`). A Rust insert or upsert must produce the same fields, or later TS `lean()` readers (which apply no defaults) see `undefined`.
13. Hydrated (non-lean) reads fill missing paths with their defaults in memory, and a later `save()` of that doc **persists** those defaults (`document.js:3633-3650`, gh-2558). So a Rust-written document missing defaulted fields will gain them the next time TS saves it. Rust readers must accept both shapes (`#[serde(default = …)]` with the same default value).
14. `minimize: true` (default; off only for `custom_widgets`, `custom_widget_store`, `site_agent_changes`) removes empty objects when a document is created or saved, and turns an empty object in a `save()` delta into `$unset` (`model.js:421-437`). Empty objects written through `updateOne` are stored as `{}`. Result: e.g. `commands.permissions` (default `{}`) is missing in 5,328 of 5,333 docs. Treat "missing" and `{}` as equal on read; empty arrays are always stored (`[]`).
15. `required`/`enum`/`min`/`max`/custom validators run on `create`/`save` and **not** on `updateOne`/`findOneAndUpdate` (no call site sets `runValidators`). Rust may validate more strictly on new writes but must accept every value those update paths could have stored.
16. `trim` setters (events, custom timers, extension items) apply on Mongoose writes, including `$set` casts. Rust must trim the same fields before writing.

### Unknown fields and strictness
17. Every schema is `strict: true`: Mongoose silently drops paths it does not know from `create`, `save` and update operators. A field written only by Rust (today `raid_analytics_summaries.rustPending` / `rustRefresh`) is invisible to hydrated TS reads, returned verbatim by `.lean()` reads, kept by `$set` updates and lost only if TS replaces the whole document. Add new fields to the Mongoose schema first if TS must keep or read them.
18. `strictQuery: false`: filters on undeclared paths are sent as-is, so TS queries on fields that are not in the schema still work. Rust needs no special handling.
19. Rust structs must **ignore unknown fields** (no `deny_unknown_fields`) because data carries legacy fields (`channel_tts_settings.aiProvider` …, see diffs) and other writers add fields.

### Numbers, dates and BSON types
20. Mongoose `Number` maps to whatever the Node driver produced: `int32` for integers that fit, `double` otherwise; Rust writers have also stored `int64` and integral doubles. **Every `Number` field must deserialize from int32, int64 and double** (see the type-variance table: 26 field paths already mixed). For writes, reuse the existing `js_number` helper (`dima-rust/src/utils/bson_compat.rs`, tested in `dima-rust/src/workers/dashboard_insights.rs:608`: integral values in i32 range → `Int32`, otherwise `Double`) to match Node. Values above 2^53 must not be written as `int64` if TS reads them (Node promotes `long` to a JS number and loses precision).
21. `Date` paths are always BSON dates in data (no string dates found). Mongoose casts numbers or ISO strings to dates in filters and updates; Rust must convert explicitly. Epoch-millisecond fields declared as `Number` (`dueAt`, `leaseUntil`, `actionDueAt` in duel/roulette/widget collections) must stay numbers.
22. TTL indexes only expire BSON dates: always write `expiresAt` / `purgeAt` / `expires_at` / TTL `createdAt` as dates.
23. No `Decimal128`, `Long`, `Int32` or `BigInt` types are used by TS code. `Buffer`/binary only appears in GridFS chunks.

### Reads returned to HTTP clients
24. About 84 `.lean()` reads in `src/server/**` feed `res.json` directly (heuristic list in `mongo.json`, `lean_near_http_response`). Express serialises ObjectId as a 24-hex **string**, dates as `toISOString()` (`2026-11-11T10:00:00.000Z`, millisecond precision, `Z`), and keeps `_id` and `__v` in the payload. No schema sets `toJSON`/`toObject` transforms or virtuals, and the `id` virtual is not serialised. Rust HTTP responses must not emit extended JSON (`{"$oid": …}`, `{"$date": …}`).
25. `select: false` fields are omitted by default from hydrated and lean reads alike; Rust must exclude them explicitly (most are secrets: `overlayToken`, `current_refresh_hash`, `checkoutUrl`, `polar_credit_snapshot`, …).

### Writes, atomicity and indexes
26. Index creation: on first use of each model Mongoose builds the declared indexes (`autoIndex`), and some code calls `Model.init()` explicitly before relying on unique indexes (`src/server/oauth/service.ts:27`, `src/utils/domain_events.ts:123`, `src/utils/domain_event_consumer.ts:474`, `src/utils/durable_cron_jobs.ts:93,146`, `src/utils/paid_order_reward.ts:22`, `src/pets/runtime.ts:411`, `src/pets/state.ts:18`, `src/desktop_ai/service.ts:83,323`, `src/server/services/pet_settings.service.ts:184`). No `syncIndexes`, so indexes are never dropped. Once Rust owns a collection it must create the same indexes (keys + unique/sparse/partial/TTL options from `declaredIndexes`) itself, or keep a TS process that still calls `init()`.
27. Many idempotency paths depend on a duplicate-key error (E11000) from a unique index (`domain_events.eventKey`, `credittransactions.idempotencyKey`, ledgers, receipts). Rust must map error code 11000 to the same "already done" outcome. The `extensionwallettransactions.twitchTransactionID` index is not unique in data (see index diffs).
28. The one multi-document transaction (`follow_ledger.ts:379`) needs a replica set; keep the non-transactional fallback because standalone servers reject sessions.
29. `findOneAndUpdate` defaults to returning the **pre-update** document unless `new: true` / `returnDocument: 'after'` (flag `returnNew` in `codeUsage`). The Rust driver also defaults to `Before`; set `ReturnDocument::After` only where TS does.
30. `Model.collection.*` (native) calls bypass casting, defaults and timestamps: `domain_events.ts:124` (insert of a pre-validated `toObject()`) and the one-shot scripts in `src/scripts/` (`migrate_*`). These are already raw-driver shaped.

## How this was produced

All inputs are reproducible from the repo plus the local read-only `mongodb` container:

```sh
cd dimabot   # model list = files that call model( and import mongoose
grep -rlE "\bmodel(<[^>]*>)?\(|mongoose\.model\(" src --include='*.ts' | xargs grep -lE "from ['\"]mongoose['\"]" | grep -v test | sort > /tmp/model_files.txt
MONGO_URI= REDIS_URL= SECRET_KEY=x npx tsx ../dima-rust/tools/ledger/mongo_schemas.mts /tmp/schemas.json /tmp/model_files.txt   # no DB connection; autoIndex/autoCreate/buffering off
# mongosh --eval "$(cat dima-rust/tools/ledger/mongo_census.js)"  > census.json   (read-only; exact level-1 census + $sample 300 for depth 2)
# collection stats + indexes: $collStats storageStats and getIndexes() per collection > colls.json
python3 dima-rust/tools/ledger/mongo_code_usage.py . schemas.json usage.json
python3 dima-rust/tools/ledger/mongo_ledger.py . <dir with the four json files>
python3 dima-rust/tools/ledger/mongo_md.py .
```

Limits: depth-2 paths come from a sample of up to 300 documents per collection (all documents where the collection is smaller), so rare variants deeper than the top level may be missing; top-level types and missing/null counts are exact. Usage attribution is regex-based: calls through a variable (`durable_cron_jobs.ts:78` `model = dependencies.model || CronJobIntentSchema`) or a generic `this.constructor` are listed in `globalPatterns` but not under a collection. The DB is a stale copy of production, so index and data observations describe that snapshot.

