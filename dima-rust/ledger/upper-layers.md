# The upper layers: what is left and how it is cut

Plan for the part of `dimabot/src` that no merged package covers, written 2026-11-12 against `rust-v2` at
`7df83e15`. It follows the charter ([`../MIGRATION.md`](../MIGRATION.md)) and continues the tables of
[`packages.md`](packages.md); package ids here start with `P4-`. The lead decides; where this plan departs from
the crate map in `packages.md` it says so in section 7.

**How the numbers were made.** Lines are non-blank lines as `modules.json` counts them (the same counter the
ledger uses everywhere); processes are the `processes` field of `modules.json` (`a` api, `b` bot, `c` cron,
`s` script). Coverage was produced mechanically: every non-test file of `modules.json` was given a state by its
proposed `modules.json` package, then overridden file by file where a merged Rust module names the TypeScript it
ports in its header (`grep` of every `crates/*/src/**/*.rs` and the old `src/`) or where `packages.md` names the
file in a package's scope. By hand I checked every file of the partly covered `modules.json` packages
(`P-core-01`, `P-cmd-core-01`, `P-cmd-mod-01`, `P-model-types-*`, `P-model-rt-01`, `P-ai-*`, `P-billing-*`,
`P-engine-*`, `P-evh-*`, `P-platform-svc-01`) against the module lists of `dima-ai`, `dima-commands`,
`dima-engine`, `dima-twitch`, `dima-billing`, `dima-events`, `dima-stream` and `dima-platform`. Import relations
are from `modules.json` unless a sentence says "read in the code". Where a large file is cut, the cut is by line
range at an export boundary and both halves are counted. Production facts come from read-only queries of the
local copy (`domdimabot`), run on 2026-11-12.

| State | Files | Lines |
|---|---:|---:|
| Merged (ported by a merged package) | 281 | 33,319 |
| Running (`P2-BILLING-02a`; `E-ENGINE-02c` adds no file) | 7 | 1,509 |
| Planned in `packages.md` but not started (`P2-BILLING-02b`, `P2-CRON-01`, `P2-PLATFORM-SVC` part 4, `F-MODEL-07c`) | 10 | 1,851 |
| **Taken by a package of this plan** | **395** | **68,216** |
| Not to port: dead code, entry scripts, the Deno tool, timed VIP, type-only files | 69 | 6,331 |
| **All non-test files** | **762** | **111,226** |

So 405 files and 70,067 lines (63% of the TypeScript) are left: the 395 of this plan plus the 10 the ledger
already holds. By process: api only 181 files / 37,062 lines; loaded by all four entries 96 / 14,158; cron only
33 / 6,712; api+bot 50 / 5,859; api+cron 19 / 3,784; api+bot+cron 16 / 1,389; bot only 3 / 431; scripts 5 / 399;
the rest 2 / 273.

## 1. What is left

Every non-test file that no merged or running package covers, by area (`Proc`: the processes that load it).
The package column names the package of this plan, or the ledger package that already holds the file. A file
cut between two packages shows both halves with their line counts.

| Area | Files | Lines |
|---|---:|---:|
| `server/routes` | 42 | 12,944 |
| `site_agent` | 45 | 10,305 |
| `utils/ai` | 30 | 7,912 |
| `utils (other)` | 40 | 5,501 |
| `handlers` | 19 | 4,937 |
| `workers` | 19 | 3,684 |
| `server/services` | 17 | 3,199 |
| `commands` | 26 | 3,058 |
| `utils/ast_parser` | 24 | 2,898 |
| `pets` | 26 | 2,420 |
| `overlays` | 22 | 2,193 |
| `custom_widgets` | 9 | 1,347 |
| `utils/moderation` | 17 | 1,182 |
| `desktop_ai` | 6 | 1,104 |
| `domain_events` | 6 | 931 |
| `goals` | 7 | 924 |
| `functions` | 8 | 722 |
| `server (app, websocket)` | 3 | 715 |
| `widgets` | 6 | 638 |
| `classes` | 4 | 564 |
| `duel` | 4 | 557 |
| `widget_feed` | 9 | 506 |
| `roulette` | 3 | 459 |
| `scripts` | 4 | 355 |
| `server/oauth` | 2 | 323 |
| `bot` | 2 | 322 |
| `assets` | 2 | 190 |
| `bits_rules` | 2 | 145 |
| `schemas` | 1 | 32 |
| **Total** | **405** | **70,067** |

#### `server/routes` (42 files, 12,944 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `server/routes/admin-tools.route.ts` | 53 | a | P4-API-ADMINS |
| `server/routes/admin.route.ts` | 570 | a | P4-API-ADMINS |
| `server/routes/admin_site.route.ts` | 1006 | a | P4-API-ADMIN-SITE |
| `server/routes/aiPersonality.route.ts` | 185 | a | P4-API-AGENT |
| `server/routes/analytics.route.ts` | 179 | a | P4-API-DATA |
| `server/routes/asset-library.route.ts` | 97 | a | P4-API-MEDIA |
| `server/routes/auth.route.ts` | 1416 | a | P4-API-AUTH-A (1–967: 828), P4-API-AUTH-B (968–end: 588) |
| `server/routes/billing.route.ts` | 603 | a | P4-API-BILLING |
| `server/routes/bits-rules.route.ts` | 80 | a | P4-API-CHANNEL |
| `server/routes/clip-recommendations.route.ts` | 235 | a | P4-API-DATA |
| `server/routes/clip.route.ts` | 94 | a | P4-API-MEDIA |
| `server/routes/command.route.ts` | 311 | a | P4-API-COMMANDS |
| `server/routes/dashboard.route.ts` | 337 | a | P4-API-DATA |
| `server/routes/dimafx.route.ts` | 1201 | a | P4-API-DIMAFX |
| `server/routes/docs-assistant.route.ts` | 136 | a | P4-API-AGENT |
| `server/routes/duel-widget.route.ts` | 21 | a | P4-API-OVERLAYS |
| `server/routes/email-auth.route.ts` | 61 | a | P4-API-USERS |
| `server/routes/email-test.route.ts` | 140 | a | P4-API-USERS |
| `server/routes/eventsub.route.ts` | 340 | a | P4-API-CHANNEL |
| `server/routes/file.route.ts` | 67 | a | P4-API-MEDIA |
| `server/routes/follow_defense.route.ts` | 406 | a | P4-API-COMMANDS |
| `server/routes/goals.route.ts` | 50 | a | P4-API-OVERLAYS |
| `server/routes/media.route.ts` | 51 | a | P4-API-MEDIA |
| `server/routes/memories.route.ts` | 311 | a | P4-API-AGENT |
| `server/routes/moderation.route.ts` | 159 | a | P4-API-COMMANDS |
| `server/routes/observability.route.ts` | 21 | a | P4-API-APP |
| `server/routes/overlay-studio.route.ts` | 257 | a | P4-API-OVERLAYS |
| `server/routes/overlay.route.ts` | 91 | a | P4-API-OVERLAYS |
| `server/routes/pet.route.ts` | 84 | a | P4-API-OVERLAYS |
| `server/routes/referral.route.ts` | 392 | a | P4-API-BILLING |
| `server/routes/reward.route.ts` | 353 | a | P4-API-CHANNEL |
| `server/routes/roulette.route.ts` | 74 | a | P4-API-OVERLAYS |
| `server/routes/site-agent.route.ts` | 306 | a | P4-API-AGENT |
| `server/routes/site.route.ts` | 247 | a | P4-API-CHANNEL |
| `server/routes/speech.route.ts` | 471 | a | P4-API-MEDIA |
| `server/routes/stream-summary.route.ts` | 128 | a | P4-API-DATA |
| `server/routes/stream_timeline.route.ts` | 141 | a | P4-API-DATA |
| `server/routes/timer.route.ts` | 253 | a | P4-API-COMMANDS |
| `server/routes/trigger.route.ts` | 1517 | a | P4-API-TRIGGERS-A (1–1012: 898), P4-API-TRIGGERS-B (1013–end: 619) |
| `server/routes/user.route.ts` | 406 | a | P4-API-USERS |
| `server/routes/webhooks/polarsh.webhook.ts` | 48 | a | P4-API-BILLING |
| `server/routes/widgets.route.ts` | 46 | a | P4-API-OVERLAYS |

#### `site_agent` (45 files, 10,305 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `site_agent/access.ts` | 83 | a | P4-SA-CORE-A |
| `site_agent/changes.schema.ts` | 80 | a | F-MODEL-07c (ledger, planned) |
| `site_agent/changes.ts` | 228 | a | P4-SA-CORE-A |
| `site_agent/cleanup.ts` | 35 | a | P4-SA-CORE-A |
| `site_agent/config.ts` | 72 | a | P4-SA-CORE-A |
| `site_agent/context.ts` | 177 | a | P4-SA-CORE-A |
| `site_agent/docs/index.ts` | 14 | a | P4-SA-DOCS |
| `site_agent/docs/keyword.ts` | 266 | a | P4-SA-DOCS |
| `site_agent/docs/prompt_index.ts` | 106 | a | P4-SA-DOCS |
| `site_agent/docs/read.ts` | 195 | a | P4-SA-DOCS |
| `site_agent/docs/search.ts` | 112 | a | P4-SA-DOCS |
| `site_agent/docs/sections.ts` | 285 | a | P4-SA-DOCS |
| `site_agent/docs/source.ts` | 91 | a | P4-SA-DOCS |
| `site_agent/docs/vectors.ts` | 274 | a | P4-SA-DOCS |
| `site_agent/limits.ts` | 38 | a | P4-SA-CORE-A |
| `site_agent/llm/cost.ts` | 46 | a | P4-SA-CORE-B |
| `site_agent/llm/openrouter.ts` | 538 | a | P4-SA-CORE-B |
| `site_agent/navigation.ts` | 76 | a | P4-SA-CORE-A |
| `site_agent/prefs.ts` | 52 | a | P4-SA-CORE-A |
| `site_agent/prompt.ts` | 82 | a | P4-SA-CORE-A |
| `site_agent/runner.ts` | 910 | a | P4-SA-RUNNER |
| `site_agent/store.ts` | 356 | a | P4-SA-CORE-B |
| `site_agent/tools/effects.ts` | 236 | a | P4-SA-TOOLS-A |
| `site_agent/tools/knowledge.ts` | 215 | a | P4-SA-TOOLS-A |
| `site_agent/tools/read.ts` | 508 | a | P4-SA-TOOLS-A |
| `site_agent/tools/registry.ts` | 63 | a | P4-SA-TOOLS-B |
| `site_agent/tools/settings_read.ts` | 217 | a | P4-SA-TOOLS-B |
| `site_agent/tools/stream.ts` | 417 | a | P4-SA-TOOLS-B |
| `site_agent/tools/ui.ts` | 102 | a | P4-SA-TOOLS-A |
| `site_agent/tools/util.ts` | 64 | a | P4-SA-TOOLS-A |
| `site_agent/tools/write/commands.ts` | 834 | a | P4-SA-WRITE-A |
| `site_agent/tools/write/repeat.ts` | 278 | a | P4-SA-WRITE-A |
| `site_agent/tools/write/settings/ai_personality.ts` | 292 | a | P4-SA-WRITE-B |
| `site_agent/tools/write/settings/bits_rules.ts` | 221 | a | P4-SA-WRITE-B |
| `site_agent/tools/write/settings/chat_events.ts` | 297 | a | P4-SA-WRITE-B |
| `site_agent/tools/write/settings/common.ts` | 127 | a | P4-SA-WRITE-B |
| `site_agent/tools/write/settings/follow_defense.ts` | 138 | a | P4-SA-WRITE-C |
| `site_agent/tools/write/settings/goals.ts` | 257 | a | P4-SA-WRITE-C |
| `site_agent/tools/write/settings/index.ts` | 62 | a | P4-SA-WRITE-C |
| `site_agent/tools/write/settings/moderation.ts` | 412 | a | P4-SA-WRITE-C |
| `site_agent/tools/write/settings/roulettes.ts` | 398 | a | P4-SA-WRITE-C |
| `site_agent/tools/write/settings/tts.ts` | 194 | a | P4-SA-WRITE-C |
| `site_agent/tools/write/timers.ts` | 299 | a | P4-SA-WRITE-B |
| `site_agent/types.ts` | 249 | a | P4-SA-CORE-A |
| `site_agent/usage.ts` | 309 | a | P4-SA-CORE-B |

#### `utils/ai` (30 files, 7,912 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `utils/ai/ast_catalog/build_catalog.ts` | 138 | abcs | P4-ACT-AI-C |
| `utils/ai/ast_catalog/index.ts` | 216 | abcs | P4-ACT-AI-C |
| `utils/ai/clip_recommendations/clip_recommendation_claims.ts` | 29 | c | P4-RECAP-C |
| `utils/ai/clip_recommendations/clip_recommendation_notifications.ts` | 58 | ac | P4-RECAP-C |
| `utils/ai/clip_recommendations/clip_recommendation_previews.ts` | 50 | ac | P4-RECAP-C |
| `utils/ai/clip_recommendations/clip_recommendation_reconciliation.ts` | 76 | c | P4-RECAP-C |
| `utils/ai/clip_recommendations/clip_recommendation_recovery.ts` | 35 | ac | P4-RECAP-C |
| `utils/ai/clip_recommendations/clip_recommendations_prompts.ts` | 89 | ac | P4-RECAP-C |
| `utils/ai/clip_recommendations/openrouter_clip_recommendations.client.ts` | 467 | ac | P4-RECAP-C |
| `utils/ai/clip_recommendations/vod_clip_recommendation_runner.ts` | 829 | ac | P4-RECAP-D |
| `utils/ai/clip_recommendations/vod_clip_recommender_policy.ts` | 43 | c | P4-RECAP-C |
| `utils/ai/docs_assistant/docs_assistant.prompt.ts` | 116 | a | P4-SA-TOOLS-B |
| `utils/ai/docs_assistant/docs_assistant.tools.ts` | 107 | a | P4-SA-TOOLS-B |
| `utils/ai/docs_assistant/docs_assistant.ts` | 199 | a | P4-SA-TOOLS-B |
| `utils/ai/docs_assistant/docs_source.ts` | 82 | a | P4-SA-TOOLS-B |
| `utils/ai/memory/memory.service.ts` | 945 | abcs | P4-AI-MEMORY |
| `utils/ai/memory/stream_memory_apply.ts` | 320 | c | P4-RECAP-B |
| `utils/ai/memory/stream_memory_runner.ts` | 784 | c | P4-RECAP-B |
| `utils/ai/memory/stream_summary_context.ts` | 519 | c | P4-RECAP-A |
| `utils/ai/memory/stream_summary_decider.ts` | 597 | c | P4-RECAP-A |
| `utils/ai/openrouter/ai.ts` | 1245 | abcs | P4-ACT-AI-A (lines 1–763: 684), P4-ACT-AI-B (`chat`, 764–end: 561) |
| `utils/ai/openrouter/command.ai.ts` | 156 | abcs | P4-ACT-AI-A |
| `utils/ai/openrouter/miyuloot.ai.ts` | 23 | ab | P4-ACT-AI-A |
| `utils/ai/tools/ast_docs.tool.ts` | 53 | abcs | P4-ACT-AI-C |
| `utils/ai/tools/ast_parser.tool.ts` | 187 | abcs | P4-ACT-AI-C |
| `utils/ai/tools/chat_summary.tool.ts` | 62 | abcs | P4-ACT-AI-B |
| `utils/ai/tools/create_memory.tool.ts` | 153 | abcs | P4-ACT-AI-B |
| `utils/ai/tools/index.ts` | 137 | abcs | P4-ACT-AI-B |
| `utils/ai/tools/recall_memory.tool.ts` | 149 | abcs | P4-ACT-AI-B |
| `utils/ai/tools/stream_stats.tool.ts` | 48 | abcs | P4-ACT-AI-B |

#### `utils (other)` (40 files, 5,501 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `utils/account_deletion.ts` | 219 | a | P4-SVC-ACCOUNT |
| `utils/ai_credit_display.ts` | 52 | a | P4-SVC-READS |
| `utils/ai_usage_dashboard.ts` | 117 | a | P4-SVC-READS |
| `utils/ai_usage_queries.ts` | 70 | a | P4-SVC-READS |
| `utils/ast_command_delivery.ts` | 49 | abcs | P4-ACT-CORE |
| `utils/ast_timer_runtime.ts` | 165 | abcs | P4-ACT-CORE |
| `utils/ast_variable_migration.ts` | 44 | s | P4-CMD-RUNTIME |
| `utils/availability/service.ts` | 151 | abcs | P4-CMD-RUNTIME |
| `utils/bits_message.ts` | 8 | abc | P4-CHAT-EVENTS |
| `utils/cache.ts` | 65 | ac | P4-CMD-RUNTIME |
| `utils/credit_gift_provider.ts` | 168 | ac | P2-BILLING-02b (ledger, planned) |
| `utils/credit_gifts.ts` | 337 | ac | P2-BILLING-02b (ledger, planned) |
| `utils/dashboard_activity.ts` | 115 | a | P4-SVC-READS |
| `utils/dashboard_insights.ts` | 131 | a | P4-SVC-READS |
| `utils/dev.ts` | 14 | abcs | P4-TW-CHAT |
| `utils/dimafx_data.ts` | 32 | a | P4-RT-CLIP-FX |
| `utils/follow_defense.ts` | 502 | ac | P4-FEAT-DEFENSE-A |
| `utils/follow_defense_actions.ts` | 250 | abcs | P4-FEAT-DEFENSE-B |
| `utils/follow_defense_queue.ts` | 356 | abcs | P4-FEAT-DEFENSE-B |
| `utils/follow_defense_summary.ts` | 159 | abcs | P4-FEAT-DEFENSE-A |
| `utils/fs.ts` | 13 | a | P4-SVC-ACCOUNT |
| `utils/links.ts` | 6 | abcs | P4-TW-CHAT |
| `utils/media_cleanup.ts` | 102 | a | P4-SVC-ACCOUNT |
| `utils/observability/bot_runtime_metrics.ts` | 516 | abcs | P4-BOT-INGRESS |
| `utils/overlay-token.ts` | 53 | abcs | P4-FEAT-OVERLAYS |
| `utils/paid_order_reward.ts` | 113 | acs | P2-BILLING-02b (ledger, planned) |
| `utils/polar_account_cancellation.ts` | 51 | a | P2-BILLING-02b (ledger, planned) |
| `utils/posthog_events.ts` | 177 | abcs | P4-BOT-INGRESS |
| `utils/raid_sessions.ts` | 225 | abcs | P4-FEAT-DEFENSE-A |
| `utils/rate_limit.ts` | 21 | a | P4-SVC-READS |
| `utils/referral.ts` | 366 | abcs | P2-BILLING-02b (ledger, planned) |
| `utils/referral_ledger.ts` | 115 | a | P2-BILLING-02b (ledger, planned) |
| `utils/speech.ts` | 35 | ac | P4-CMD-RUNTIME |
| `utils/temporary_roles_announcements.ts` | 112 | c | P4-CRON-FEATURES |
| `utils/thumbnail_generator.ts` | 160 | as | P2-PLATFORM-SVC-4 (ledger, planned) |
| `utils/timer_cache.ts` | 115 | ac | P4-FEAT-TIMERS |
| `utils/timer_runtime.ts` | 39 | c | P4-FEAT-TIMERS |
| `utils/twitch/chat_message_chunks.ts` | 52 | ab | P4-TW-CHAT |
| `utils/twitch_reward_body.util.ts` | 105 | a | P4-SVC-COMMANDS |
| `utils/video.ts` | 121 | a | P2-PLATFORM-SVC-4 (ledger, planned) |

#### `handlers` (19 files, 4,937 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `handlers/ad_break.handler.ts` | 63 | ab | P4-CHAT-EVENTS |
| `handlers/ban.handler.ts` | 61 | ab | P4-CHAT-EVENTS |
| `handlers/cheer.handler.ts` | 105 | ab | P4-CHAT-EVENTS |
| `handlers/clip_queue.handler.ts` | 271 | a | P4-RT-CLIP-FX |
| `handlers/commands.handler.ts` | 198 | abcs | P4-ACT-CORE |
| `handlers/dimafx_queue.handler.ts` | 320 | a | P4-RT-CLIP-FX |
| `handlers/eventsub.handler.ts` | 267 | ab | P4-CHAT-EVENTS |
| `handlers/follow.handler.ts` | 82 | ab | P4-CHAT-EVENTS |
| `handlers/keywords.handler.ts` | 25 | ab | P4-CHAT-MESSAGE |
| `handlers/message.handler.ts` | 780 | ab | P4-CHAT-MESSAGE |
| `handlers/moderation.handler.ts` | 317 | ab | P4-MOD-RUN |
| `handlers/raid.handler.ts` | 110 | ab | P4-CHAT-EVENTS |
| `handlers/redemption.handler.ts` | 260 | ab | P4-CHAT-EVENTS |
| `handlers/revocation.handler.ts` | 109 | b | P4-CHAT-EVENTS |
| `handlers/special_parser.handler.ts` | 474 | abcs | P4-ACT-CORE |
| `handlers/special_parser.userlevel.ts` | 40 | abcs | P4-CMD-RUNTIME |
| `handlers/stream_offline.handler.ts` | 54 | ab | P4-CHAT-EVENTS |
| `handlers/stream_online.handler.ts` | 120 | ab | P4-CHAT-EVENTS |
| `handlers/tts_queue.handler.ts` | 1281 | a | P4-RT-TTS-A (1–713: 662), P4-RT-TTS-B (714–end: 619) |

#### `workers` (19 files, 3,684 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `workers/activation-reminder.worker.ts` | 284 | c | P4-CRON-LEDGERS |
| `workers/ai_usage_backfill.worker.ts` | 201 | c | P4-CRON-MONEY |
| `workers/credit_gifts.worker.ts` | 23 | c | P4-CRON-FEATURES |
| `workers/cron.index.ts` | 340 | c | P2-CRON-01 (ledger, planned) |
| `workers/duel.worker.ts` | 18 | c | P4-CRON-FEATURES |
| `workers/eventsub_reconciliation.worker.ts` | 148 | c | P4-CRON-LEDGERS |
| `workers/follow_defense.worker.ts` | 141 | c | P4-CRON-FEATURES |
| `workers/follow_defense_actions.worker.ts` | 35 | c | P4-CRON-FEATURES |
| `workers/follow_ledger.worker.ts` | 353 | c | P4-CRON-LEDGERS |
| `workers/free_credit_reset.worker.ts` | 346 | c | P4-CRON-MONEY |
| `workers/goals.worker.ts` | 16 | c | P4-CRON-FEATURES |
| `workers/roulette-actions.worker.ts` | 18 | c | P4-CRON-FEATURES |
| `workers/semantic_moderation.worker.ts` | 41 | c | P4-MOD-RUN |
| `workers/stream_analytics.worker.ts` | 187 | c | P4-CRON-LEDGERS |
| `workers/stream_memory.worker.ts` | 471 | c | P4-CRON-RECAP |
| `workers/temporary_roles.worker.ts` | 334 | c | P4-CRON-FEATURES |
| `workers/timer.worker.ts` | 291 | c | P4-CRON-FEATURES |
| `workers/vod_clip_recommender.worker.ts` | 421 | c | P4-CRON-RECAP |
| `workers/widgets.worker.ts` | 16 | c | P4-CRON-FEATURES |

#### `server/services` (17 files, 3,199 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `server/services/admin_pet_diagnostics.service.ts` | 63 | a | P4-FEAT-PETS |
| `server/services/ai_personality.service.ts` | 482 | a | P4-SVC-SETTINGS |
| `server/services/command_blocks.service.ts` | 86 | a | P4-SVC-COMMANDS |
| `server/services/command_defaults.service.ts` | 180 | a | P4-SVC-COMMANDS |
| `server/services/command_mutations.service.ts` | 340 | a | P4-SVC-COMMANDS |
| `server/services/dimafx-overlay.service.ts` | 51 | a | P4-RT-SOCKETS |
| `server/services/dimafx.service.ts` | 177 | a | P4-RT-CLIP-FX |
| `server/services/duel-overlay.service.ts` | 79 | a | P4-RT-SOCKETS |
| `server/services/eventsub_config.service.ts` | 419 | a | P4-SVC-SETTINGS |
| `server/services/follow_defense_settings.service.ts` | 216 | a | P4-SVC-SETTINGS |
| `server/services/moderation_settings.service.ts` | 292 | a | P4-SVC-SETTINGS |
| `server/services/pet_settings.service.ts` | 196 | abcs | P4-FEAT-PETS |
| `server/services/reward_creation.service.ts` | 259 | a | P4-SVC-COMMANDS |
| `server/services/roulette-overlay.service.ts` | 51 | a | P4-RT-SOCKETS |
| `server/services/tts/voice_preview.service.ts` | 151 | a | P4-RT-SOCKETS |
| `server/services/tts_settings.service.ts` | 103 | a | P4-SVC-COMMANDS |
| `server/services/widgets-overlay.service.ts` | 54 | a | P4-RT-SOCKETS |

#### `commands` (26 files, 3,058 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `commands/add_moderator.command.ts` | 46 | ab | P4-CHAT-CMDS-A |
| `commands/add_vip.command.ts` | 136 | ab | P4-CHAT-CMDS-A |
| `commands/amor.command.ts` | 54 | ab | P4-CHAT-CMDS-A |
| `commands/command_list.command.ts` | 52 | ab | P4-CHAT-CMDS-A |
| `commands/command_manager.command.ts` | 453 | ab | P4-CHAT-CMDS-B |
| `commands/create_clip.command.ts` | 141 | abcs | P4-ACT-MEDIA |
| `commands/disable_command.command.ts` | 32 | ab | P4-CHAT-CMDS-A |
| `commands/duel.command.ts` | 56 | ab | P4-CHAT-CMDS-B |
| `commands/enable_command.command.ts` | 32 | ab | P4-CHAT-CMDS-A |
| `commands/followage.command.ts` | 113 | ab | P4-CHAT-CMDS-A |
| `commands/game.command.ts` | 107 | ab | P4-CHAT-CMDS-A |
| `commands/index.commands.ts` | 44 | ab | P4-CHAT-CMDS-B |
| `commands/miyuloot.command.ts` | 121 | ab | P4-CHAT-CMDS-B |
| `commands/only_emotes.command.ts` | 88 | ab | P4-CHAT-CMDS-A |
| `commands/poll.command.ts` | 89 | ab | P4-CHAT-CMDS-A |
| `commands/prediction.command.ts` | 141 | ab | P4-CHAT-CMDS-A |
| `commands/promo.command.ts` | 103 | ab | P4-CHAT-CMDS-B |
| `commands/remove_moderator.command.ts` | 49 | ab | P4-CHAT-CMDS-A |
| `commands/remove_vip.command.ts` | 50 | ab | P4-CHAT-CMDS-A |
| `commands/ruletarusa.command.ts` | 138 | ab | P4-CHAT-CMDS-B |
| `commands/shoutout.command.ts` | 168 | ab | P4-CHAT-CMDS-B |
| `commands/sumimetro.command.ts` | 137 | ab | P4-CHAT-CMDS-B |
| `commands/sumimetro_ast_message.ts` | 55 | ab | P4-CHAT-CMDS-B |
| `commands/timer_manager.command.ts` | 497 | ab | P4-FEAT-TIMERS |
| `commands/title.command.ts` | 76 | ab | P4-CHAT-CMDS-A |
| `commands/vanish.command.ts` | 80 | ab | P4-CHAT-CMDS-B |

#### `utils/ast_parser` (24 files, 2,898 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `utils/ast_parser/functions/availability.functions.ts` | 28 | abcs | P4-ACT-CHANNEL |
| `utils/ast_parser/functions/channel.functions.ts` | 383 | abcs | P4-ACT-CHANNEL |
| `utils/ast_parser/functions/chat.functions.ts` | 54 | abcs | P4-ACT-CHANNEL |
| `utils/ast_parser/functions/clip.functions.ts` | 38 | abcs | P4-ACT-MEDIA |
| `utils/ast_parser/functions/defense.functions.ts` | 44 | abcs | P4-ACT-MOD |
| `utils/ast_parser/functions/followage.functions.ts` | 85 | abcs | P4-ACT-CHANNEL |
| `utils/ast_parser/functions/goals.functions.ts` | 61 | abcs | P4-ACT-MEDIA |
| `utils/ast_parser/functions/index.ts` | 59 | abcs | P4-ACT-CORE |
| `utils/ast_parser/functions/moderation.functions.ts` | 660 | abcs | P4-ACT-MOD |
| `utils/ast_parser/functions/moderation.helpers.ts` | 3 | abcs | P4-ACT-MOD |
| `utils/ast_parser/functions/overlay.functions.ts` | 38 | abcs | P4-ACT-MEDIA |
| `utils/ast_parser/functions/pet.functions.ts` | 36 | abcs | P4-ACT-MEDIA |
| `utils/ast_parser/functions/pin.functions.ts` | 238 | abcs | P4-ACT-CHANNEL |
| `utils/ast_parser/functions/roulette.functions.ts` | 53 | abcs | P4-ACT-MEDIA |
| `utils/ast_parser/functions/shoutout_target.ts` | 29 | abcs | P4-ACT-CHANNEL |
| `utils/ast_parser/functions/trigger.functions.ts` | 103 | abcs | P4-ACT-MEDIA |
| `utils/ast_parser/functions/tts.functions.ts` | 243 | abcs | P4-ACT-MEDIA |
| `utils/ast_parser/functions/twitch.functions.ts` | 148 | abcs | P4-ACT-CHANNEL |
| `utils/ast_parser/functions/user.functions.ts` | 171 | abcs | P4-ACT-MEDIA |
| `utils/ast_parser/functions/widget.functions.ts` | 55 | abcs | P4-ACT-MEDIA |
| `utils/ast_parser/index.ts` | 50 | abcs | P4-ACT-CORE |
| `utils/ast_parser/randomuser_settings.ts` | 17 | abcs | P4-CMD-RUNTIME |
| `utils/ast_parser/required_goal_contribution_error.ts` | 7 | abcs | P4-CMD-RUNTIME |
| `utils/ast_parser/simulate.ts` | 295 | a | P4-ACT-CORE |

#### `pets` (26 files, 2,420 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `pets/admission.ts` | 174 | abcs | P4-FEAT-PETS |
| `pets/delivery.ts` | 37 | a | P4-FEAT-PETS |
| `pets/diagnostics.ts` | 47 | abcs | P4-FEAT-PETS |
| `pets/mood_decoration.ts` | 19 | a | P4-FEAT-PETS |
| `pets/mood_warnings.ts` | 23 | abcs | P4-FEAT-PETS |
| `pets/moods.ts` | 89 | abcs | P4-FEAT-PETS |
| `pets/mouth_analysis.ts` | 89 | a | P4-RT-PETS |
| `pets/mouth_curves.ts` | 71 | a | P4-RT-PETS |
| `pets/mouth_curves.worker.ts` | 12 | a | P4-RT-PETS |
| `pets/peers.ts` | 44 | abcs | P4-FEAT-PETS |
| `pets/queue.ts` | 78 | a | P4-FEAT-PETS |
| `pets/queue_limits.ts` | 5 | abcs | P4-FEAT-PETS |
| `pets/read_tts.ts` | 445 | a | P4-RT-TTS-B |
| `pets/readiness.schema.ts` | 11 | abcs | P4-FEAT-PETS |
| `pets/readiness.ts` | 78 | abcs | P4-FEAT-PETS |
| `pets/runtime.ts` | 465 | a | P4-RT-PETS |
| `pets/selection.ts` | 23 | a | P4-FEAT-PETS |
| `pets/socket.ts` | 293 | a | P4-RT-PETS |
| `pets/socket_adapter.ts` | 11 | a | P4-RT-SOCKETS |
| `pets/speech_text.ts` | 15 | a | P4-FEAT-PETS |
| `pets/state.ts` | 109 | abcs | P4-FEAT-PETS |
| `pets/tokens.ts` | 70 | a | P4-FEAT-PETS |
| `pets/tts_bridge.ts` | 57 | abcs | P4-FEAT-PETS |
| `pets/tts_envelope.ts` | 59 | a | P4-RT-PETS |
| `pets/tts_lane.ts` | 44 | abcs | P4-FEAT-PETS |
| `pets/wakeups.ts` | 52 | abcs | P4-FEAT-PETS |

#### `overlays` (22 files, 2,193 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `overlays/ad-schedule.ts` | 53 | a | P4-FEAT-OVERLAYS |
| `overlays/alert-events.ts` | 24 | a | P4-FEAT-OVERLAYS |
| `overlays/assets.ts` | 25 | a | P4-FEAT-OVERLAYS |
| `overlays/ast.ts` | 47 | a | P4-FEAT-OVERLAYS |
| `overlays/bridge.ts` | 38 | a | P4-FEAT-OVERLAYS |
| `overlays/controls.ts` | 10 | abcs | P4-FEAT-OVERLAYS |
| `overlays/delivery-store.ts` | 39 | a | P4-FEAT-OVERLAYS |
| `overlays/interaction-model.ts` | 79 | abcs | P4-FEAT-OVERLAYS |
| `overlays/interaction-subscriptions.ts` | 79 | a | P4-FEAT-OVERLAYS |
| `overlays/interactions.ts` | 137 | abcs | P4-FEAT-OVERLAYS |
| `overlays/keyframes.ts` | 36 | a | P4-FEAT-OVERLAYS |
| `overlays/live-events-model.ts` | 146 | abcs | P4-FEAT-OVERLAYS |
| `overlays/live.ts` | 854 | a | P4-RT-OVERLAY-LIVE |
| `overlays/model.ts` | 91 | a | P4-FEAT-OVERLAYS |
| `overlays/publish.ts` | 46 | a | P4-FEAT-OVERLAYS |
| `overlays/readiness-cache.ts` | 21 | a | P4-FEAT-OVERLAYS |
| `overlays/recover.ts` | 27 | a | P4-FEAT-OVERLAYS |
| `overlays/store.ts` | 178 | a | P4-FEAT-OVERLAYS |
| `overlays/test-playback.ts` | 76 | a | P4-FEAT-OVERLAYS |
| `overlays/widget-contract.ts` | 91 | a | P4-FEAT-OVERLAYS |
| `overlays/widget-state-providers.ts` | 21 | a | P4-FEAT-OVERLAYS |
| `overlays/widget-state.ts` | 75 | a | P4-FEAT-OVERLAYS |

#### `custom_widgets` (9 files, 1,347 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `custom_widgets/files.ts` | 47 | a | P4-FEAT-ASSETS |
| `custom_widgets/format.ts` | 472 | a | P4-FEAT-ASSETS |
| `custom_widgets/goal-source.ts` | 9 | a | P4-FEAT-ASSETS |
| `custom_widgets/history.ts` | 24 | a | P4-FEAT-ASSETS |
| `custom_widgets/media.ts` | 127 | a | P4-FEAT-ASSETS |
| `custom_widgets/session.ts` | 208 | a | P4-FEAT-ASSETS |
| `custom_widgets/state.ts` | 39 | a | P4-FEAT-ASSETS |
| `custom_widgets/store.ts` | 362 | a | P4-RT-OVERLAY-LIVE |
| `custom_widgets/widget-store.ts` | 59 | a | P4-RT-OVERLAY-LIVE |

#### `utils/moderation` (17 files, 1,182 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `utils/moderation/decisions.ts` | 33 | ab | P4-MOD-RULES |
| `utils/moderation/defaults.ts` | 81 | a | P4-MOD-RULES |
| `utils/moderation/normalize.ts` | 13 | abc | P4-MOD-RULES |
| `utils/moderation/offenses.ts` | 39 | ab | P4-MOD-RULES |
| `utils/moderation/permit.ts` | 89 | abcs | P4-MOD-RULES |
| `utils/moderation/rules/blacklist.rule.ts` | 37 | abc | P4-MOD-RULES |
| `utils/moderation/rules/caps.rule.ts` | 53 | ab | P4-MOD-RULES |
| `utils/moderation/rules/emote_spam.rule.ts` | 20 | ab | P4-MOD-RULES |
| `utils/moderation/rules/index.ts` | 57 | ab | P4-MOD-RULES |
| `utils/moderation/rules/links.rule.ts` | 44 | ab | P4-MOD-RULES |
| `utils/moderation/seed_plan.ts` | 35 | a | P4-MOD-RULES |
| `utils/moderation/semantic.ts` | 125 | c | P4-MOD-RUN |
| `utils/moderation/semantic_worker.ts` | 85 | c | P4-MOD-RUN |
| `utils/moderation/spam.ts` | 119 | abc | P4-MOD-RULES |
| `utils/moderation/spam_categories.ts` | 39 | abc | P4-MOD-RULES |
| `utils/moderation/variation_jobs.ts` | 103 | ac | P4-MOD-RUN |
| `utils/moderation/variations.ts` | 210 | abc | P4-MOD-RULES |

#### `desktop_ai` (6 files, 1,104 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `desktop_ai/activity.ts` | 326 | abcs | P4-RT-DESKTOP |
| `desktop_ai/execution.ts` | 215 | a | P4-RT-DESKTOP |
| `desktop_ai/input.ts` | 31 | a | P4-FEAT-ASSETS |
| `desktop_ai/schema.ts` | 34 | abcs | P4-FEAT-ASSETS |
| `desktop_ai/service.ts` | 427 | a | P4-RT-DESKTOP |
| `desktop_ai/updates.ts` | 71 | abcs | P4-FEAT-ASSETS |

#### `domain_events` (6 files, 931 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `domain_events/chat_announcement_events.ts` | 288 | ac | P4-EVH |
| `domain_events/credit_gift_events.ts` | 10 | ac | P4-EVH |
| `domain_events/domain_event_consumers.ts` | 129 | ac | P4-EVH |
| `domain_events/follow_defense_events.ts` | 67 | ac | P4-EVH |
| `domain_events/stream_analytics_events.ts` | 171 | ac | P4-EVH |
| `domain_events/stream_operations_events.ts` | 266 | ac | P4-EVH |

#### `goals` (7 files, 924 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `goals/completion.ts` | 126 | c | P4-FEAT-GOALS |
| `goals/currency.ts` | 49 | abcs | P4-FEAT-GOALS |
| `goals/model.ts` | 122 | abcs | P4-FEAT-GOALS |
| `goals/monthly.ts` | 57 | abcs | P4-FEAT-GOALS |
| `goals/service.ts` | 244 | abcs | P4-FEAT-GOALS |
| `goals/twitch-store.ts` | 105 | abcs | P4-FEAT-GOALS |
| `goals/twitch.ts` | 221 | abcs | P4-FEAT-GOALS |

#### `functions` (8 files, 722 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `functions/chats/index.ts` | 24 | abcs | P4-ACT-CORE |
| `functions/chats/send_message.chat.ts` | 159 | abcs | P4-TW-CHAT |
| `functions/clips/index.ts` | 11 | abcs | P4-ACT-MEDIA |
| `functions/clips/show_clip.clip.ts` | 258 | abcs | P4-ACT-MEDIA |
| `functions/moderation/execute_action.moderation.ts` | 126 | abcs | P4-MOD-RUN |
| `functions/moderation/index.ts` | 5 | abcs | P4-MOD-RUN |
| `functions/promo/chat.promo.ts` | 138 | ab | P4-CHAT-MESSAGE |
| `functions/promo/index.ts` | 1 | a | P4-CHAT-MESSAGE |

#### `server (app, websocket)` (3 files, 715 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `server/index.ts` | 123 | a | P4-BIN-API |
| `server/server.ts` | 223 | a | P4-API-APP |
| `server/websocket.ts` | 369 | a | P4-RT-SOCKETS |

#### `widgets` (6 files, 638 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `widgets/catalog.ts` | 10 | abc | P4-FEAT-WIDGETS |
| `widgets/event-adapters.ts` | 10 | abc | P4-FEAT-WIDGETS |
| `widgets/event-model.ts` | 134 | abc | P4-FEAT-WIDGETS |
| `widgets/events.ts` | 52 | abc | P4-FEAT-WIDGETS |
| `widgets/model.ts` | 226 | abc | P4-FEAT-WIDGETS |
| `widgets/service.ts` | 206 | abc | P4-FEAT-WIDGETS |

#### `classes` (4 files, 564 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `classes/chat_history.ts` | 69 | abcs | P4-CMD-RUNTIME |
| `classes/command.class.ts` | 361 | abcs | P4-CMD-RUNTIME |
| `classes/cooldown.class.ts` | 27 | ab | P4-CMD-RUNTIME |
| `classes/pubsub_manager.class.ts` | 107 | abcs | P4-BOT-INGRESS |

#### `duel` (4 files, 557 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `duel/completion.ts` | 123 | c | P4-FEAT-GAMES |
| `duel/model.ts` | 254 | abcs | P4-FEAT-GAMES |
| `duel/service.ts` | 139 | abc | P4-FEAT-GAMES |
| `duel/stats.ts` | 41 | abc | P4-FEAT-GAMES |

#### `widget_feed` (9 files, 506 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `widget_feed/badges.ts` | 64 | ab | P4-FEAT-WIDGETS |
| `widget_feed/bot-events.ts` | 20 | abcs | P4-FEAT-WIDGETS |
| `widget_feed/chat-normalize.ts` | 83 | ab | P4-FEAT-WIDGETS |
| `widget_feed/chat-replay.ts` | 25 | a | P4-FEAT-WIDGETS |
| `widget_feed/publisher.ts` | 65 | ab | P4-FEAT-WIDGETS |
| `widget_feed/session-refresh.ts` | 19 | abcs | P4-FEAT-WIDGETS |
| `widget_feed/signals.ts` | 82 | abcs | P4-FEAT-WIDGETS |
| `widget_feed/subscriptions.ts` | 101 | a | P4-FEAT-WIDGETS |
| `widget_feed/types.ts` | 47 | abcs | P4-FEAT-WIDGETS |

#### `roulette` (3 files, 459 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `roulette/actions.ts` | 50 | c | P4-FEAT-GAMES |
| `roulette/model.ts` | 236 | abcs | P4-FEAT-GAMES |
| `roulette/service.ts` | 173 | abcs | P4-FEAT-GAMES |

#### `scripts` (4 files, 355 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `scripts/invalidate_all_user_permissions.script.ts` | 143 | s | P4-OPS-CLI |
| `scripts/reconcile_polar_plan.script.ts` | 37 | s | P4-OPS-CLI |
| `scripts/reconcile_stream_offline.script.ts` | 119 | s | P4-OPS-CLI |
| `scripts/resync_ai_memories.script.ts` | 56 | s | P4-OPS-CLI |

#### `server/oauth` (2 files, 323 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `server/oauth/desktop-websocket.ts` | 79 | a | P4-RT-SOCKETS |
| `server/oauth/routes.ts` | 244 | a | P4-API-APP |

#### `bot` (2 files, 322 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `bot/eventsub.twitch.ts` | 278 | b | P4-BOT-INGRESS |
| `bot/index.ts` | 44 | b | P4-BIN-BOT |

#### `assets` (2 files, 190 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `assets/http.ts` | 34 | a | P4-FEAT-ASSETS |
| `assets/library.ts` | 156 | abcs | P4-FEAT-ASSETS |

#### `bits_rules` (2 files, 145 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `bits_rules/model.ts` | 97 | abc | P4-FEAT-GAMES |
| `bits_rules/store.ts` | 48 | abc | P4-FEAT-GAMES |

#### `schemas` (1 files, 32 lines)

| File | Lines | Proc | Package |
|---|---:|---|---|
| `schemas/dimafx_playback.schema.ts` | 32 | a | P4-RT-CLIP-FX |

### Not to port

69 files, 6,331 lines. "Imported by" counts non-test importers in `modules.json`; an entry script is imported by
nothing and is run by hand or by an `ops/checks` script. Migration states were read from the local copy with
each script's own selection filter.

| File | Lines | Why | Evidence |
|---|---:|---|---|
| `functions/redemptions/unvipexpired.redemption.ts` | 56 | dropped by the owner | Owner dropped timed VIP (2026-11-12); its Rust copy `crates/twitch/src/functions/redemptions/unvipexpired.rs` and the timed branch of `vip.rs` are removed by P4-CHAT-EVENTS; `vips` holds 0 documents |
| `utils/ai/sandbox/execute_sandbox.ai.ts` | 176 | dropped by the owner | The Deno sandbox (charter §2); imported only by `code_execution.tool.ts` and the dead `sandbox/index.ts` |
| `utils/ai/tools/code_execution.tool.ts` | 456 | dropped by the owner | Owner dropped AI code execution (charter §2). Six files import it: the tool index and `ai.ts` for the tool, and four tools and `ai.ts` only for the shared types it exports (`IStreamerData` and others, read in the code); those types move to `dima_actions::ai` with P4-ACT-AI-A |
| `classes/index.ts` | 3 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `functions/redemptions/index.ts` | 4 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `functions/s3/triggers.s3.ts` | 21 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `handlers/cheers.handler.ts` | 29 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `middleware/index.ts` | 12 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `middleware/optional.middleware.ts` | 14 | not needed | No route uses it (`http.md` item 18); `dima-platform` has `optional_user` should one need it |
| `schemas/accounts.schema.ts` | 25 | not needed | Unused schema (F-MODEL-c: not initialised at start-up); the collection holds 2 documents from 2024-05 |
| `schemas/app_config.schema.ts` | 20 | not needed | Unused schema; 1 document from 2024-01 |
| `schemas/channel_config.schema.ts` | 25 | not needed | Unused schema whose collection production never had (F-MODEL-02) |
| `schemas/chat_logs.schema.ts` | 15 | not needed | Unused schema (F-MODEL-06b modelled it for decoding only) |
| `scripts/ast_lookup.script.ts` | 61 | not needed | Entry script, imported by nothing. Developer tool (`npm run ast:lookup`) over the TypeScript registry |
| `scripts/backup_full_database.script.ts` | 123 | not needed | Entry script, imported by nothing. Wraps `mongodump`; an ops task that needs no backend code (run `mongodump` directly) |
| `scripts/check_ast_metadata.script.ts` | 38 | not needed | Entry script, imported by nothing. Developer check of the TypeScript registry; `dima-engine` checks its registry in its tests |
| `scripts/cleanup_invalid_legacy_trigger_files.script.ts` | 139 | not needed | Entry script, imported by nothing. One-off cleanup (`npm run cleanup:invalid-trigger-files`) |
| `scripts/cleanup_orphaned_clip_recommendations.script.ts` | 49 | not needed | Entry script, imported by nothing. **Not finished on the copy**: 19 clip recommendations still match its filter; see section 7 |
| `scripts/generate_ast_catalog.script.ts` | 76 | not needed | Entry script, imported by nothing. Developer tool (`npm run gen:ast-docs`); the runtime catalog is built by P4-ACT-AI-C |
| `scripts/migrate_ai_feature_flags.script.ts` | 50 | not needed | Entry script, imported by nothing. Ran: 0 personalities lack either flag |
| `scripts/migrate_ast_variables_global.script.ts` | 37 | not needed | Entry script, imported by nothing. **Not finished on the copy**: 9 `astvariables` rows still match its filter (8 `command`, 1 `redemption`); see section 7 |
| `scripts/migrate_bits_canonical.script.ts` | 222 | not needed | Entry script, imported by nothing. One-off (`npm run migrate:bits-canonical`) |
| `scripts/migrate_dimafx_category.script.ts` | 74 | not needed | Entry script, imported by nothing. Ran: 0 items left in category `gifs` |
| `scripts/migrate_dimafx_thumbnails.script.ts` | 157 | not needed | Entry script, imported by nothing. One-off (`npm run migrate:dimafx-thumbnails`) |
| `scripts/migrate_event_plan_tier.script.ts` | 129 | not needed | Entry script, imported by nothing. Ran: 0 events lack `plan_tier` |
| `scripts/migrate_legacy_trigger_rewards.script.ts` | 235 | not needed | Entry script, imported by nothing. One-off (`npm run migrate:legacy-trigger-rewards`) |
| `scripts/migrate_shoutout_defaults.lib.ts` | 10 | not needed | Entry script, imported by nothing. Helper of the script above |
| `scripts/migrate_shoutout_defaults.script.ts` | 28 | not needed | Entry script, imported by nothing. One-off; used by `ops/checks/shoutout-ast.mjs` |
| `scripts/migrate_speech_ast.script.ts` | 89 | not needed | Entry script, imported by nothing. One-off with a prepare/apply procedure (`ops/migrations/speech-ast.md`); not checkable by a count |
| `scripts/migrate_timer_frequency_minutes.script.ts` | 83 | not needed | Entry script, imported by nothing. Ran: 0 timers with a unit other than minutes |
| `scripts/migrate_trigger_media.script.ts` | 270 | not needed | Entry script, imported by nothing. Ran: 10 of 10 trigger files have a media asset |
| `scripts/run_test_lua.script.mjs` | 15 | not needed | Entry script, imported by nothing. Developer tool |
| `scripts/smoke_test_lfm2_embeddings.script.ts` | 84 | not needed | Entry script, imported by nothing. Manual smoke test of the embeddings sidecar |
| `scripts/test_ai_memory_context.script.ts` | 178 | not needed | Entry script, imported by nothing. Test script (`npm run test:ai-memory`, `ops/checks/ai-chat.mjs`) |
| `scripts/test_domain_pipeline.script.mjs` | 63 | not needed | Entry script, imported by nothing. Test script (`ops/checks/downstream-queue-durability.mjs`) |
| `server/routes/public/dimafx-player.js` | 50 | not needed | Browser code served as a static file; it stays a file (charter §2), not ported |
| `server/routes/twitch.route.ts` | 70 | not needed | Router nothing mounts (`http.md`, unmounted routers) |
| `server/routes/validation.route.ts` | 86 | not needed | Router nothing mounts (`http.md`, unmounted routers) |
| `site_agent/tools/write/fake_store.testutil.ts` | 248 | not needed | Test helper; imported by 6 tests only |
| `utils/ai/memory/index.ts` | 55 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `utils/ai/memory/memory_extractor.ts` | 149 | not needed | Unreachable; its pure rules were ported anyway by P3-AI-LLM (`dima_ai::memory::extract_memory_candidate`) |
| `utils/ai/memory/stream_summary_decider.run.ts` | 153 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `utils/ai/memory/stream_summary_decider.simulate.ts` | 201 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `utils/ai/memory/stream_summary_schema.specs.ts` | 265 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `utils/ai/openrouter/index.ts` | 22 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `utils/ai/openrouter/messages.ai.ts` | 371 | not needed | unreachable: imported by 1 non-test file(s), reached from no entry |
| `utils/ai/sandbox/index.ts` | 16 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `utils/ai/threading/thread_types.ts` | 1 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `utils/email/templates/index.ts` | 6 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `utils/env.ts` | 0 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `utils/migrations/channels_to_users.ts` | 48 | not needed | One-off migration from the old `channels` collection; nothing imports it |
| `utils/migrations/migrate_ast_function_syntax.js` | 336 | not needed | One-off migration of stored command text; nothing imports it; all 2,217 stored texts compile with the new parser (E-ENGINE-01b) |
| `utils/notifications.ts` | 5 | not needed | `notifyDevelopers` is a 5-line stub; its one caller logs instead |
| `utils/observability/native_worker_metrics.ts` | 284 | not needed | Imported only by its test and by `ops/checks/dashboard-activity-rust.mjs`; the old supervisor it measured is retired |
| `utils/performance/index.ts` | 1 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `utils/performance/metrics.ts` | 159 | not needed | unreachable: imported by 1 non-test file(s), reached from no entry |
| `utils/permissions/fake_role_cache.ts` | 93 | not needed | Test helper; imported by 2 tests only |
| `utils/pollyfills.ts` | 6 | not needed | `getDirname(import.meta.url)`: a Node module-path helper with no Rust meaning |
| `utils/qdrant/functions/chat_logs/retrieve_chat_window.qdrant.ts` | 156 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `utils/qdrant/functions/index.ts` | 1 | not needed | unreachable: imported by 0 non-test file(s), reached from no entry |
| `workers/cron_native_bridge.ts` | 137 | not needed | Spawns the old Rust `cron_index`; one `dima-cron` process replaces both (P2-CRON-01) |
| `interfaces/cache/twitch_account.cache.interface.ts` | 13 | types only | Type-only module: reached only through type imports (2 importers); its types go with the packages that use them |
| `interfaces/cache/users.cache.interface.ts` | 5 | types only | Type-only module: reached only through type imports (2 importers); its types go with the packages that use them |
| `interfaces/commands/command.response.interface.ts` | 37 | types only | Type-only module: reached only through type imports (1 importers); its types go with the packages that use them |
| `interfaces/qdrant/collections.interface.ts` | 25 | types only | Type-only module: reached only through type imports (3 importers); its types go with the packages that use them |
| `interfaces/tbd/return.interface.ts` | 8 | types only | Type-only module: reached only through type imports (2 importers); its types go with the packages that use them |
| `interfaces/twitch/eventsub.interface.ts` | 211 | types only | Type-only module: reached only through type imports (25 importers); its types go with the packages that use them |
| `roulette/action-model.ts` | 7 | types only | Type-only module: reached only through type imports (3 importers); its types go with the packages that use them |
| `utils/ai/ast_catalog/types.ts` | 40 | types only | Type-only module: reached only through type imports (5 importers); its types go with the packages that use them |

## 2. The crates

### 2.1 The cycle, read in the code

`modules.json` cycle C01 has 61 files and 11,956 lines. Reading its internal edges, it is not one knot but six
kinds of edge, and each has a different cure:

| Edge in the TypeScript | What it does | How Rust breaks it |
|---|---|---|
| `ast_parser/functions/*.ts` → `evaluator.ts` (24 files) | Each function file registers itself in the evaluator's registry | Gone already: `dima-engine` is pure and calls `Host::call(HostFunction, …)`; nothing in the engine knows the implementations |
| `functions/chats/send_message.chat.ts` → `handlers/special_parser.handler.ts`, `utils/ast_command_delivery.ts` → `handlers/commands.handler.ts` | Sending chat *with a context* renders the command language first, then sends, then runs the command references the text produced | Sending is split in two. The plain send (Helix `POST /chat/messages`, the 450 splitter, replies) goes to `dima-twitch` and evaluates nothing. Rendering-then-sending is the trait **`ChatOut`**, declared in `dima-twitch::chat` and implemented by `dima-actions::delivery::ChatDelivery` |
| `follow_defense_actions.ts`, `follow_defense_summary.ts`, `duel/completion.ts`, `temporary_roles_announcements.ts`, `credit_gifts.ts`, `execute_action.moderation.ts`, `domain_events/chat_announcement_events.ts` → `send_message.chat.ts` | Features that post templated chat | They take an `Arc<dyn ChatOut>`. Read in the code: `follow_defense_*` pass `{channelID}` as context, so their messages are rendered; `duel/completion.ts` and the temporary roles announcer pass none (plain) |
| `roulette/service.ts` → `ast_parser/parser.ts` | Validates roulette actions by parsing them | `dima-features` depends on `dima-engine` (lower, pure) |
| `channel.functions.ts` → `openrouter/command.ai.ts` → `ai.ts` → `tools/index.ts` → `code_execution.tool.ts` → `send_message.chat.ts`; `tools/ast_parser.tool.ts` → `ast_command_delivery.ts` | `$(ai)` calls the AI chat, whose tools post chat and run commands | AI chat lives in `dima-actions::ai` next to the host; its tools get `&dyn ChatOut` and a `CommandRunner` handle, not the host module. The code-execution tool is dropped (owner), which removes the longest path |
| `ast_timer_runtime.ts` → `special_parser.handler.ts`; `utils/raid_sessions.ts` ↔ `follow_defense_queue.ts` ↔ `follow_defense_actions.ts` | Timers re-enter the renderer; raid sessions and follow defense call each other | Timers are a module of `dima-actions`. Follow defense and the raid-session producers are one module of `dima-features` (one crate, so the mutual calls are module calls) |

Cycle C02 (15 files: `server/websocket.ts`, the TTS, clip and DimaFX queue handlers, `overlays/live.ts`, the pet
runtime, `dimafx.route.ts`) exists because the queues import the Socket.IO server and the server imports the
queues to wire their events. In Rust the API binary builds the `dima_socketio` server, each realtime module
registers its own namespaces and receives a namespace handle, and no queue imports the server.
`dimafx-overlay.service.ts` → `dimafx.route.ts` is one helper (purchase recovery) that moves into
`dima-realtime::dimafx`. The other twelve cycles of `modules.json` are inside one future crate each and need no
decision.

The second seam is the **request surface to the API process**: speech, TTS control and status, the Overlay Studio
queue, trigger sends and clip requests. The bot reaches them today by internal HTTP (`INTERNAL_API_URL`, read in
`control_tts.chat.ts`, `speech.chat.ts`, `overlay.functions.ts`) and Dragonfly pub/sub
(`twitch:<id>:clip:request`). `dima-twitch` already declares the two traits for this (`BackendApi`,
`ClipPublisher`, P2-TWITCH-03). `dima-actions` implements them over internal HTTP and pub/sub for the bot and the
cron; `dima-realtime` implements them in process for the API, so an evaluation that runs in the API (simulation,
the site agent, the EventSub test route) does not call itself over HTTP.

### 2.2 The engine's host

`dima-actions::host::DimaHost` implements `dima_engine::host::Host`. Its storage methods (cache variables,
channel and viewer variables, responses, `schedule_timer`, `fork_effect`, `sleep`) and the `call` dispatch are in
P4-ACT-CORE. The `match` on `HostFunction` forwards to one module per group, and each group is one package:

| Group (module of `dima_actions::host`) | Functions | Count | TypeScript | Package |
|---|---|---:|---|---|
| `moderation` | `warn`, `vip`, `add.vip`, `channel.add.vip`, `twitch.add.vip`, `unvip`, `ban`, `ban.self`, `ban.mod`, `mod`, `add.mod`, `channel.add.mod`, `twitch.add.mod`, `unmod`, `permit`, `clear.chat`, `emoteonly`, `bot.mode` | 18 | `moderation.functions.ts` 660, `defense.functions.ts` 44, `moderation.helpers.ts` 3 | P4-ACT-MOD |
| `channel` | `twitch.live/subs/title/game/viewers/follows/channel/login`; `raid`, `unraid`, `set.title`, `set.game`, `set.voice`; `start/get/lock/end/cancel.prediction`; `start/get/end/cancel.poll`; `followage`; `announce`, `announcement`, `shoutout`, `chat.announcement`, `chat.send`; `pin`, `pin.create/update/del/delete`; `enable/disable.command`, `enable/disable.redemption` | 37 | `channel.functions.ts` (less `ai`), `twitch.functions.ts`, `followage.functions.ts`, `chat.functions.ts`, `shoutout_target.ts`, `pin.functions.ts`, `availability.functions.ts` | P4-ACT-CHANNEL |
| `media` | `overlay.{skip,pause,resume,clear}[.twitch/.kick]` (12); `roulette.*` (9); `randomuser`; `show.clip`, `create.clip`; `tts.*` and `tts` (13); `pet.talk`, `pet.ask`; `widget.signal`, `widget.signal.to`; `goal.add`; `trigger.send` | 43 | `overlay/roulette/user/clip/tts/pet/widget/goals/trigger.functions.ts`, `show_clip.clip.ts`, `create_clip.command.ts` | P4-ACT-MEDIA |
| `ai` | `ai` | 1 | `channel.functions.ts` (`ai`), `command.ai.ts`, `ai.ts` | P4-ACT-AI-A |

18 + 37 + 43 + 1 = 99, the variants of `HostFunction::ALL`. The 37 built-ins of `dima-engine` (strings, user,
count, delay and timer, random, the EventSub readers) are merged; their TypeScript files are counted as merged.

### 2.3 The crate map for the upper layers

Lower layers as merged. New crates, from the bottom up (`→` means "depends on"; every arrow points down):

| Layer | Crate | Holds | Depends on |
|---|---|---|---|
| 4 | `dima-twitch` (existing) | + plain chat send, the 450 splitter, the `ChatOut` trait | as today |
| 5 | `dima-commands` (existing) | + `runtime`: command lookup and its cache, availability service, chat history, the admin role cache loader | as today |
| 5 | `dima-ai` (existing) | + `memory_store`: channel memories in MongoDB and Qdrant | as today |
| 6 | `dima-moderation` (new) | Chat moderation rules, permits, offenses, decisions, semantic review, variation jobs, the moderation handler and action executor | `dima-commands`, `dima-ai`, `dima-twitch`, `dima-billing`, `dima-model`, `dima-store` |
| 6 | `dima-features` (new) | The channel features as libraries, without sockets: goals, roulette, duel, bits rules, widgets and the widget feed, pets (admission, state, readiness), Overlay Studio's model and store, custom widget format and sessions, the asset library, the desktop AI model, follow defense with raid sessions, custom timers | `dima-engine` (syntax, and evaluation with no host for overlay text), `dima-twitch`, `dima-events`, `dima-stream`, `dima-tts`, `dima-billing`, `dima-platform`, `dima-model`, `dima-store` |
| 7 | `dima-actions` (decided) | `DimaHost`; chat delivery (`ChatOut` implementation, command references); command execution; AST timers; simulation; AI chat and its tools; the AST catalog | `dima-engine`, `dima-commands`, `dima-moderation`, `dima-features`, `dima-ai`, `dima-tts`, `dima-twitch`, `dima-billing`, `dima-stream`, `dima-events` |
| 8 | `dima-chat` (decided) | The bot's EventSub handlers, the message handler, built-in chat commands, the EventSub webhook ingress (port 3333), bot runtime metrics, product events | `dima-actions` and below |
| 8 | `dima-realtime` (decided) | API only: Socket.IO namespaces and the raw desktop WebSocket, TTS/clip/DimaFX queues, the Overlay Studio live loop, pet and desktop AI runtimes; in-process `BackendApi`/`ClipPublisher` | `dima-features`, `dima-actions`, `dima-socketio`, `dima-web`, `dima-tts`, `dima-platform` |
| 8 | `dima-services` (decided) | API services: command mutations and defaults, reward creation, settings services, dashboard and usage reads, account deletion | `dima-actions` and below |
| 8 | `dima-event-handlers` (decided) | The domain-event consumers' handlers and their registry | `dima-events`, `dima-features`, `dima-stream`, `dima-billing`, `dima-twitch` (handlers take `ChatOut`; no dependency on `dima-actions`) |
| 8 | `dima-recap` (new) | Cron-side AI jobs over finished streams: stream summaries and stream memory, VOD clip recommendations | `dima-ai`, `dima-stream`, `dima-billing`, `dima-email`, `dima-platform`, `dima-events` |
| 9 | `dima-site-agent` (decided) | The site agent and the docs assistant | `dima-services`, `dima-actions` and below |
| 9 | `dima-routes` (new) | Every HTTP router of the API, mounted in the reference's order | `dima-site-agent`, `dima-realtime`, `dima-services`, `dima-recap` (clip recommendation reads), `dima-chat` (one route, see 7.3) |
| 10 | `api/`, `bot/`, `cron/` | Wiring only | see below |

Binaries, each depending only on what it runs:

- `bot/` → `dima-chat` (and through it `dima-actions`, `dima-moderation`, `dima-features`). Not `dima-realtime`,
  `dima-services`, `dima-routes`, `dima-site-agent`, `dima-recap`, `dima-event-handlers`.
- `cron/` → `dima-event-handlers`, `dima-recap`, `dima-actions` (timers, follow defense, temporary roles and
  chat announcements need `ChatDelivery`), `dima-moderation` (semantic review). Not `dima-chat`, `dima-realtime`,
  `dima-routes`, `dima-site-agent`, `dima-services`. The worker loops are modules of `cron/` as P2-CRON-01 plans;
  each is a loop around a library call.
- `api/` → `dima-routes` (which brings in everything the API serves).

Cross-process rules every package follows: Rust pub/sub channel names differ from the TypeScript ones and the
Rust processes use Dragonfly database 1 (charter §3); any key family a package ports is labelled rebuilt,
drained or carried in its report; *carried* families in this plan are `ast:timers:*` (P4-ACT-CORE) and
`twitch:moderation:banmod:restore:*` (P4-ACT-MOD), both need a fixture of the TypeScript format.

## 3. The packages

76 new packages (`P4-…`) plus nine ledger packages they rely on (two running, seven planned). In dependency order by wave
(section 6). "Owns" is the directory the package writes; two packages of the same wave never own the same
directory, and the shared entry points (the host's `match`, the router mount table, the cron registration) are
written once by the package named in their row with an explicit "not ported yet" arm per group, so later
packages only fill their own module. "Record" says what the package captures from the real TypeScript to prove
itself; every outside service is the rig's mock unless said otherwise, stores are the local MongoDB and
Dragonfly, synthetic mode unless "real-data". Implementer: **O** = Opus (stronger: money, tokens, moderation,
data integrity, concurrency), **S** = Sol or another mechanical implementer (wide but well specified). Effort in
brackets.

### 3.1 Ledger packages this plan relies on (unchanged ids)

| Id | State | Why it matters here |
|---|---|---|
| E-ENGINE-02c | running | One budget per chat message; P4-ACT-CORE builds on it |
| P2-BILLING-02a | running | Usage ledger, receipts, flush; AI chat, TTS, site agent and the money workers charge through it |
| P2-BILLING-02b | planned | Credit gifts, referrals, paid-order rewards, Polar cancellation (6 files, 1,150 lines); needed by the billing routes, the credit gift worker, account deletion and the event handlers |
| P2-CRON-01 | planned | The `cron/` binary and supervisor (`workers/cron.index.ts`, 340) and four native workers; every cron package of this plan registers on it |
| P2-CRON-02 | planned | The three other native workers; also takes the remainder of P2-SMALL (audio durations, deleting the old crate's replaced modules) |
| P2-PLATFORM-SVC part 4 | planned (here called P2-PLATFORM-SVC-4) | `utils/video.ts` 121, `utils/thumbnail_generator.ts` 160: yt-dlp and ffmpeg without a shell; the clip queue and the trigger uploads need it |
| F-MODEL-07c | planned | `site_agent/changes.schema.ts` 80, desktop AI collections, the schemaless collections and GridFS buckets the overlay, asset and site-agent packages read |
| F-MODEL-NATIVE | planned | Native-only fields of raid summaries; P2-CRON-02 needs it |
| RIG-02e | planned | Start-up state once per target; the whole-binary comparisons need it |

### 3.2 New packages

| Id | W | TypeScript (lines) | Lands in / owns | Depends on | Record from the TypeScript | Risk | Impl |
|---|---|---|---|---|---|---|---|
| P4-SKEL | 0 | none | Creates `dima-moderation`, `dima-features`, `dima-actions`, `dima-chat`, `dima-realtime`, `dima-services`, `dima-event-handlers`, `dima-recap`, `dima-site-agent`, `dima-routes`, `api/`, `bot/`; declares `dima_twitch::chat::{ChatOut, RenderScope}`, the `DimaHost` dispatch with one arm per group, the empty router mount table | merged | — | Fixes the interfaces of everything after it | lead |
| P4-CMD-RUNTIME | 0 | `classes/command.class.ts` 361, `classes/cooldown.class.ts` 27, `classes/chat_history.ts` 69, `utils/availability/service.ts` 151, `utils/ast_variable_migration.ts` 44, `utils/speech.ts` 35, `handlers/special_parser.userlevel.ts` 40, `utils/ast_parser/randomuser_settings.ts` 17, `utils/ast_parser/required_goal_contribution_error.ts` 7, `utils/cache.ts` 65 (816) | `dima-commands::runtime` | P2-COMMANDS-b, F-MODEL | Command lookup and its cache keys, availability writes (commands and rewards, through the availability hook; Twitch reward toggles on the mock), chat history lists, the admin cache load on stream online/offline | Cache invalidation across three processes (the API writes, the bot reads); a reward toggle reaches Twitch | O (high) |
| P4-AI-MEMORY | 0 | `utils/ai/memory/memory.service.ts` 945 | `dima-ai::memory_store` | P3-AI-QDRANT, P3-AI-LLM, F-MODEL, P2-BILLING-01c | Create, update, recall, delete and list of channel memories with the Qdrant sync (local Qdrant), per-plan limits; real-data decode of `channelaimemories` (5,258) | MongoDB and Qdrant kept consistent; delete without id skips the owner check (reference bug, kept) | O (high) |
| P4-TW-CHAT | 1 | `functions/chats/send_message.chat.ts` 159 (the send; its render branch is P4-ACT-CORE's), `utils/twitch/chat_message_chunks.ts` 52, `utils/links.ts` 6, `utils/dev.ts` 14 (231); plus P2-TWITCH-04b's leftover trailing `?` on four poll and prediction calls | `dima-twitch::functions::chats::send`, `dima-twitch::chat` | P4-SKEL | Helix `POST /chat/messages` bodies for plain, long (splitter), emoji, astral, reply and shared-chat cases; splitter vectors from Node | The 450 budget with astral characters counted 2 (charter decision) | S (high) |
| P4-BOT-INGRESS | 1 | `bot/eventsub.twitch.ts` 278, `utils/observability/bot_runtime_metrics.ts` 516, `classes/pubsub_manager.class.ts` 107, `utils/posthog_events.ts` 177 (1,078) | `dima-chat::ingress`, `dima-chat::metrics` | P2-EVENTS-02, F-WEB-04, F-TELEMETRY-b | Signed webhook deliveries: valid, wrong signature, non-JSON body, non-ASCII signature, replayed message id, challenge, revocation, an event that can never be valid; journal writes; `metrics:bot:*` keys | Signature check (constant time); the two reference crashes are fixed (`packages.md`); the 503 answer that makes Twitch redeliver for ever needs a decision (section 7) | O (xhigh) |
| P4-MOD-RULES | 1 | `utils/moderation/` `decisions` 33, `defaults` 81, `normalize` 13, `offenses` 39, `permit` 89, `rules/blacklist` 37, `rules/caps` 53, `rules/emote_spam` 20, `rules/index` 57, `rules/links` 44, `seed_plan` 35, `spam` 119, `spam_categories` 39, `variations` 210 (869) | `dima-moderation::rules` | P4-SKEL, P2-COMMANDS-b | A corpus of chat messages × moderation settings (the 28 stored settings and synthetic ones) → verdict, generated by Node; offense and permit keys | User patterns on every message (compiled once, bounded by `dima-commands`); a false positive bans a viewer | O (high) |
| P4-FEAT-GOALS | 1 | `goals/` `currency` 49, `model` 122, `monthly` 57, `twitch` 221, `service` 244, `completion` 126, `twitch-store` 105 (924) | `dima-features::goals` | P4-SKEL, F-MODEL-07a, P2-EVENTS-02 | Contributions and completions from journaled sub, bits and follow events into `channel_goals`, `goal_contributions`, `goal_custom_receipts`; the 5 s settle loop | Counts applied exactly once (custom receipts are the idempotency key) | O (high) |
| P4-FEAT-GAMES | 1 | `roulette/model` 236, `roulette/service` 173, `roulette/actions` 50, `duel/model` 254, `duel/service` 139, `duel/stats` 41, `duel/completion` 123, `bits_rules/model` 97, `bits_rules/store` 48 (1,161) | `dima-features::{roulette, duel, bits_rules}` | P4-SKEL, F-MODEL-07a/b, P2-TWITCH-04 | Roulette revisions and due actions, duel settle and leaderboard (663 results real-data), bits rule matching; duel timeouts on the Twitch mock | Revision compare-and-set raced by the native roulette completion worker; duel loser timeouts are moderation actions | O (high) |
| P4-FEAT-WIDGETS | 1 | `widgets/` 6 files 638, `widget_feed/` 9 files 506 (1,144) | `dima-features::{widgets, widget_feed}` | P4-SKEL, F-MODEL-07a, F-STORE-DF-c | Widget settle (1 s), widget-feed messages for chat, events and bot events compared by meaning | The `widget-feed` channel reports a gap instead of dropping (F-STORE-DF-b) | S (high) |
| P4-FEAT-OVERLAYS | 1 | `overlays/` 21 files (all but `live.ts`) 1,339, `utils/overlay-token.ts` 53 (1,392) | `dima-features::overlays` | P4-SKEL, F-MODEL-07b/c, F-CORE | Overlay Studio documents and revisions, interactions from events, alert events, readiness; the test-playback yt-dlp argument list | yt-dlp on a user URL (host allow-list, no shell, 100 MB cap); tokens stored as hashes | O (high) |
| P4-FEAT-PETS | 1 | `pets/` 18 domain files 975, `server/services/pet_settings.service.ts` 196, `server/services/admin_pet_diagnostics.service.ts` 63 (1,234) | `dima-features::pets` | P4-SKEL, F-MODEL-04, P3-TTS | Admission of `pet.talk`/`pet.ask` with plan and queue limits, readiness proofs (15 s), settings writes, wakeups | Per-user caps; capability tokens | S (high) |
| P4-FEAT-DEFENSE-A | 1 | `utils/follow_defense.ts` 502, `utils/follow_defense_summary.ts` 159, `utils/raid_sessions.ts` 225 (886) | `dima-features::defense` | P4-SKEL, P3-STREAM-FOLLOW, F-MODEL-03 | Detection decisions on synthetic follow bursts against the stored baselines, the summary chat text, raid session writes that the native raid sessions worker then reads | A false positive starts mass bans downstream; shared documents with a native worker | O (high) |
| P4-FEAT-TIMERS | 1 | `commands/timer_manager.command.ts` 497, `utils/timer_cache.ts` 115, `utils/timer_runtime.ts` 39 (651) | `dima-features::timers` | P4-SKEL, P2-COMMANDS (timer policy) | Timer create, edit, toggle, delete from chat, routes and site agent (one service), with `runValidators` updates; cache keys | Update validators (recorded in F-MODEL-c) | S (high) |
| P4-FEAT-ASSETS | 1 | `assets/library` 156, `assets/http` 34, `custom_widgets/` `format` 472, `files` 47, `goal-source` 9, `history` 24, `state` 39, `session` 208, `media` 127, `desktop_ai/` `schema` 34, `updates` 71, `input` 31 (1,252) | `dima-features::{assets, custom_widgets, desktop}` | P4-SKEL, F-MODEL-07b/c, P2-S3, P2-PLATFORM-SVC | Asset upload probes (ffprobe arguments), quotas, the custom widget bundle validation on stored and synthetic bundles, media copy, GridFS reads | User files given to ffprobe; user-written widget code validated here and served later; GridFS sizes; S3 `public-read` on every upload (`packages.md`, P2-S3) | O (high) |
| P4-RECAP-C | 1 | `utils/ai/clip_recommendations/` 8 files (847) | `dima-recap::clips` | P4-SKEL, P3-AI-LLM, P3-STREAM-SITE, P-EMAIL | OpenRouter request bodies (golden), claim scripts, notification emails, reconciliation | Usage is money (through P2-BILLING-02a) | S (high) |
| P4-RECAP-A | 1 | `utils/ai/memory/stream_summary_context.ts` 519, `stream_summary_decider.ts` 597 (1,116) | `dima-recap::summary` | P4-AI-MEMORY, P3-STREAM-SESSIONS | Context texts (golden) and decider decisions over real sessions (real-data) | — | S (high) |
| P4-SVC-READS | 1 | `utils/ai_credit_display` 52, `ai_usage_dashboard` 117, `ai_usage_queries` 70, `dashboard_activity` 115, `dashboard_insights` 131, `rate_limit` 21 (506) | `dima-services::reads` | P4-SKEL, P2-BILLING-02a | Read answers over real channels (real-data) | — | S (high) |
| P4-SVC-COMMANDS | 1 | `server/services/command_mutations` 340, `command_blocks` 86, `command_defaults` 180, `tts_settings` 103, `reward_creation` 259, `utils/twitch_reward_body.util.ts` 105 (1,073) | `dima-services::commands` | P4-CMD-RUNTIME, E-ENGINE-01b, P2-TWITCH-02/04 | Create, update, delete of commands (field allow-list), defaults for a new channel, reward creation with its EventSub subscription | Owns the zero-cooldown lease write (fence it), the 10,000-character source limit and an upper bound on cooldowns (`packages.md`); a reward created on Twitch without its document | O (high) |
| P4-SA-CORE-A | 1 | `site_agent/` `changes` 228, `cleanup` 35, `config` 72, `limits` 38, `navigation` 76, `prompt` 82, `types` 249, `access` 83, `prefs` 52, `context` 177 (1,092) | `dima-site-agent::core` | P4-SKEL, F-MODEL-07c, P2-PLATFORM-AUTH-b | Access decisions, change records, context snapshots | Who may drive the agent on a channel | O (high) |
| P4-SA-DOCS | 1 | `site_agent/docs/` 8 files (1,343) | `dima-site-agent::docs` | P4-SKEL, P3-AI-LLM, P3-AI-QDRANT | Section split, keyword and vector search answers over the docs content | — | S (high) |
| P4-API-APP | 1 | `server/server.ts` 223, `server/oauth/routes.ts` 244, `server/routes/observability.route.ts` 21 (488) | `dima-routes::app`, mount table | P4-SKEL, F-WEB-04, P2-PLATFORM-AUTH-b, P3-STREAM-SITE | Middleware order, body limits per prefix, CORS coverage, static files, the 404 shapes, OAuth routes (`browserUser` still needs its recording), the site analytics SSE, the analytics proxy | OAuth rate limit keyed by the address the proxy reports; the proxy forwards credentials | O (high) |
| P4-CRON-LEDGERS | 1 | `workers/stream_analytics.worker.ts` 187, `follow_ledger.worker.ts` 353, `eventsub_reconciliation.worker.ts` 148, `activation-reminder.worker.ts` 284 (972) | `cron/src/workers/` | P2-CRON-01 | Each worker's schedule, locks and effects (`--once` runs compared) | Leases between restarts | S (high) |
| P4-CRON-MONEY | 1 | `workers/free_credit_reset.worker.ts` 346, `ai_usage_backfill.worker.ts` 201 (547) | `cron/src/workers/` | P2-CRON-01, P2-BILLING-02a | Hourly reset decisions and backfill claims with Polar mocked; the periodic usage flush | Money | O (xhigh) |
| P4-OPS-CLI | 1 | `scripts/` `reconcile_polar_plan` 37, `reconcile_stream_offline` 119, `resync_ai_memories` 56, `invalidate_all_user_permissions` 143 (355) | `cron/src/ops/` (subcommands of `dima-cron`) | P2-CRON-01, P4-AI-MEMORY | Each command's effects; plus the Twitch recovery commands P2-TWITCH-01d asks for and the declared-versus-stored index comparison | Operator tools that write | S (high) |
| P4-ACT-CORE | 2 | `handlers/special_parser.handler.ts` 474, `handlers/commands.handler.ts` 198, `utils/ast_command_delivery.ts` 49, `utils/ast_timer_runtime.ts` 165, `utils/ast_parser/index.ts` 50, `utils/ast_parser/functions/index.ts` 59, `functions/chats/index.ts` 24, `utils/ast_parser/simulate.ts` 295 (1,314) | `dima-actions::{host (storage), delivery, runner, timers, simulate}` | E-ENGINE-02c, P4-TW-CHAT, P4-CMD-RUNTIME | The 2,217 stored command texts run against seeded channels: chat output, variable writes in Dragonfly and MongoDB, command-reference order; timer scheduling; editor simulation answers | Carried `ast:timers:*` (TypeScript fixture); at-most-once timer claim; the per-message budget; every runtime thread registers its stack | O (xhigh) |
| P4-MOD-RUN | 2 | `handlers/moderation.handler.ts` 317, `functions/moderation/execute_action.moderation.ts` 126, `index` 5, `utils/moderation/semantic` 125, `semantic_worker` 85, `variation_jobs` 103, `workers/semantic_moderation.worker.ts` 41 (802) | `dima-moderation::{handler, actions, semantic}` | P4-MOD-RULES, P4-TW-CHAT, P3-AI-LLM | Per message: delete, timeout, ban, warn on the Twitch mock; semantic decision claims and maintenance with the model mocked | Moderation actions; model-driven decisions; four reviews at once | O (xhigh) |
| P4-FEAT-DEFENSE-B | 2 | `utils/follow_defense_queue.ts` 356, `utils/follow_defense_actions.ts` 250 (606) | `dima-features::defense::actions` | P4-FEAT-DEFENSE-A, P2-TWITCH-04 | Action claims and leases, adaptive pacing (5 to 10 requests a second) against a mock answering 429, audit reconciliation | Mass bans; a late Twitch call after the 60 s lease (the reference exits the process after 40 s: abort and join, then exit after the grace) | O (xhigh) |
| P4-SVC-SETTINGS | 2 | `server/services/eventsub_config` 419, `ai_personality` 482, `follow_defense_settings` 216, `moderation_settings` 292 (1,409) | `dima-services::settings` | P4-MOD-RULES, P2-TWITCH-02, P2-BILLING-01c | Every settings write, with the scenario that shows the reference's pass-through PATCH | The pass-through PATCH is closed (typed fields only, owner decision); AI personality save hook matches type and id on one account (intended difference) | O (high) |
| P4-SVC-ACCOUNT | 2 | `utils/account_deletion.ts` 219, `utils/media_cleanup.ts` 102, `utils/fs.ts` 13 (334) | `dima-services::account` | P2-BILLING-02b, P2-PLATFORM-AUTH-b, P2-S3 | Deletion of a seeded account across every collection it touches; S3 deletes on the mock; restart in the middle | Destructive and irreversible; `forget_user` must not fail silently | O (xhigh) |
| P4-RECAP-B | 2 | `utils/ai/memory/stream_memory_runner.ts` 784, `stream_memory_apply.ts` 320 (1,104) | `dima-recap::memory` | P4-RECAP-A, P2-BILLING-02a, P2-EVENTS-01 | The whole workflow per finished stream with the models mocked: summary, memories, email, usage events, durable job states | Money (usage); durable job leases; memory writes | O (high) |
| P4-RECAP-D | 2 | `utils/ai/clip_recommendations/vod_clip_recommendation_runner.ts` 829 | `dima-recap::clips::runner` | P4-RECAP-C, P2-PLATFORM-SVC-4 | yt-dlp and ffmpeg argument lists, S3 uploads, usage, job states | Child programs on a VOD URL; three-hour download; disk use; `public-read` uploads | O (high) |
| P4-RT-SOCKETS | 2 | `server/websocket.ts` 369, `server/oauth/desktop-websocket.ts` 79, `server/services/` `roulette-overlay` 51, `widgets-overlay` 54, `duel-overlay` 79, `dimafx-overlay` 51, `tts/voice_preview` 151, `pets/socket_adapter.ts` 11 (845) | `dima-realtime::{server, overlays, preview, desktop_ws}` | P4-FEAT-GAMES, P4-FEAT-WIDGETS, P4-FEAT-PETS, F-SOCKETIO-c | Handshakes and emissions of every namespace (RIG-02b steps), recovery opt-outs, the raw desktop WebSocket | Token checks at the handshake; namespace owners for recovery quotas (`Namespace::owner`) | O (high) |
| P4-SA-CORE-B | 2 | `site_agent/store.ts` 356, `usage.ts` 309, `llm/cost.ts` 46, `llm/openrouter.ts` 538 (1,249) | `dima-site-agent::{store, usage, llm}` | P4-SA-CORE-A, P2-BILLING-02a | Turn store in Dragonfly streams, usage and cost per turn, OpenRouter requests (golden) | Money | O (xhigh) |
| P4-SA-TOOLS-A | 2 | `site_agent/tools/` `effects` 236, `knowledge` 215, `read` 508, `ui` 102, `util` 64 (1,125) | `dima-site-agent::tools` | P4-SA-CORE-A, P4-SVC-READS | Tool answers for seeded channels | Reads across the channel only | S (high) |
| P4-SA-TOOLS-B | 2 | `site_agent/tools/registry` 63, `settings_read` 217, `stream` 417; `utils/ai/docs_assistant/` 4 files 504 (1,201) | `dima-site-agent::{tools, docs_assistant}` | P4-SA-CORE-A, P4-SA-DOCS | Tool answers; docs assistant answers with the model mocked | The docs assistant is a public LLM endpoint limited per address | S (high) |
| P4-API-AUTH-A | 2 | `server/routes/auth.route.ts` lines 1–967 (828): `authorize`, `register`, `reauthenticate`, `exchange-code`, `session`, `access/:channelID` | `dima-routes::auth` | P4-API-APP, P2-TWITCH-01d | Twitch sign-in flows on the mock, `store_sign_in` writes, session answers | Tokens; sign-in writes credentials | O (xhigh) |
| P4-API-USERS | 2 | `user.route.ts` 406, `email-auth.route.ts` 61, `email-test.route.ts` 140 (607) | `dima-routes::users` | P4-API-APP, P-EMAIL | Every route | `POST /users/premium` passes body values into a query (section 4) | S (high) |
| P4-API-ADMINS | 2 | `admin.route.ts` 570, `admin-tools.route.ts` 53 (623) | `dima-routes::admins` | P4-API-APP, P2-PLATFORM-AUTH-b | Admin grants with the creator rules | Grants permissions; `/admin/read-file` path check (section 4) | O (high) |
| P4-API-ADMIN-SITE | 2 | `admin_site.route.ts` 1,006 | `dima-routes::admin_site` | P4-API-APP, P4-FEAT-PETS, P2-BILLING-02b | Every route as a global admin | Credit grants (on a verified balance), domain-event replay | O (xhigh) |
| P4-API-BILLING | 2 | `billing.route.ts` 603, `referral.route.ts` 392, `webhooks/polarsh.webhook.ts` 48 (1,043) | `dima-routes::billing` | P4-API-APP, P2-BILLING-02b | Checkout, portal, packs, gifts, referral codes; Polar webhook deliveries (valid, bad signature, replay) | Money; webhook signature; `dima-billing` parses the webhook body | O (xhigh) |
| P4-API-DATA | 2 | `analytics.route.ts` 179, `stream_timeline.route.ts` 141, `dashboard.route.ts` 337, `stream-summary.route.ts` 128, `clip-recommendations.route.ts` 235 (1,020) | `dima-routes::data` | P4-SVC-READS, P4-RECAP-C | Read routes over real channels (real-data) | — | S (high) |
| P4-API-TRIGGERS-A | 2 | `trigger.route.ts` lines 1–1012 (898): helpers, public assets, the media library routes and the upload | `dima-routes::triggers::library` | P4-API-APP, P2-PLATFORM-SVC-4 | Library listing, upload (multipart, plan size limits, silent type drop), scope changes, deletes | Uploads; stored file names (latin1 decision, `packages.md`); `public-read` | O (high) |
| P4-ACT-CHANNEL | 3 | the 7 `channel` group files (965) | `dima-actions::host::channel` | P4-ACT-CORE | Answer, Helix calls and writes of each of the 37 functions | — (wide, mechanical over merged wrappers) | S (high) |
| P4-ACT-MOD | 3 | `moderation.functions.ts` 660, `defense.functions.ts` 44, `moderation.helpers.ts` 3 (707) | `dima-actions::host::moderation` | P4-ACT-CORE, P4-MOD-RUN | The 18 functions on the Twitch mock; temporary moderators; the restore queue | Moderation; carried `twitch:moderation:banmod:restore:*` (TypeScript fixture); where the 2 s restore loop runs (section 7) | O (xhigh) |
| P4-ACT-MEDIA | 3 | the 12 `media` group files (1,208) | `dima-actions::host::media`, the bot-side `BackendApi`/`ClipPublisher` | P4-ACT-CORE, P4-FEAT-GOALS/GAMES/WIDGETS/PETS/OVERLAYS | Each of the 43 functions: the internal requests it makes (speech, overlay queue, clip request, trigger) and its writes | Clip creation; TTS money is charged later in the API queue | S (high) |
| P4-ACT-AI-A | 3 | `utils/ai/openrouter/ai.ts` lines 1–763 (684): personality, the OpenRouter call, DSML recovery, usage tracking, `generateStandaloneText`; `command.ai.ts` 156, `miyuloot.ai.ts` 23 (863) | `dima-actions::ai` | P4-ACT-CORE, P2-BILLING-02a | OpenRouter requests (golden), usage events, credit checks, personality resolution | Money | O (xhigh) |
| P4-ACT-AI-C | 3 | `utils/ai/ast_catalog/index` 216, `build_catalog` 138, `tools/ast_docs.tool` 53, `tools/ast_parser.tool` 187 (594) | `dima-actions::ai::catalog` | P4-ACT-CORE | Catalog text and vectors (local Qdrant), tool answers | — | S (high) |
| P4-CHAT-MESSAGE | 3 | `handlers/message.handler.ts` 780, `handlers/keywords.handler.ts` 25, `functions/promo/chat.promo.ts` 138, `promo/index.ts` 1 (944) | `dima-chat::message` | P4-ACT-CORE, P4-BOT-INGRESS (moderation and AI reply are called through the `dima-moderation` and `dima-actions::ai` entry points, whose bodies land with P4-MOD-RUN and P4-ACT-AI-B) | Per chat message: command, keyword, moderation, AI reply, analytics recorders, embedding enqueue | The hot path; the per-message budget | O (xhigh) |
| P4-CHAT-EVENTS | 3 | `handlers/` `eventsub` 267, `redemption` 260, `cheer` 105, `follow` 82, `raid` 110, `ban` 61, `ad_break` 63, `stream_online` 120, `stream_offline` 54, `revocation` 109; `utils/bits_message.ts` 8 (1,239). Removes the timed VIP code (owner decision) | `dima-chat::events` | P4-ACT-CORE, P4-FEAT-GOALS/WIDGETS/OVERLAYS, P4-BOT-INGRESS | Each EventSub type's effects | Channel-point redemptions (VIP, refunds); revocation disables an account | O (high) |
| P4-CHAT-CMDS-A | 3 | 14 built-in commands: `amor`, `command_list`, `disable_command`, `enable_command`, `followage`, `poll`, `prediction`, `add_moderator`, `add_vip`, `remove_moderator`, `remove_vip`, `title`, `game`, `only_emotes` (1,065) | `dima-chat::commands` | P4-ACT-CORE | Replies and Helix calls per command | — | S (high) |
| P4-EVH | 3 | `domain_events/` `chat_announcement_events` 288, `stream_analytics_events` 171, `stream_operations_events` 266, `follow_defense_events` 67, `credit_gift_events` 10, `domain_event_consumers` 129 (931) | `dima-event-handlers` | P4-FEAT-GOALS/WIDGETS/OVERLAYS, P4-FEAT-DEFENSE-A, P2-BILLING-02b, P4-ACT-CORE (its `ChatDelivery` in tests) | Each consumer's effects for journaled events of the copy, replayed in synthetic mode | Effects exactly once under redelivery (handlers idempotent) | O (high) |
| P4-RT-TTS-A | 3 | `handlers/tts_queue.handler.ts` lines 1–713 (662): types, init, status, `queueRequest`, `processNext` | `dima-realtime::tts` | P4-RT-SOCKETS, P3-TTS, P2-PLATFORM-SVC, P2-BILLING-02a | Synthesis requests (Fish, Kokoro, Piper mocked), the credit fallback, `speech` emissions, usage records, files under `public/speech` | Money (Fish is charged); files on disk | O (xhigh) |
| P4-RT-CLIP-FX | 3 | `handlers/clip_queue.handler.ts` 271, `handlers/dimafx_queue.handler.ts` 320, `server/services/dimafx.service.ts` 177, `schemas/dimafx_playback.schema.ts` 32, `utils/dimafx_data.ts` 32 (832) | `dima-realtime::{clips, dimafx}` | P4-RT-SOCKETS, P2-PLATFORM-SVC-4 | Clip queue with the download, DimaFX playback leases (5 s renewal) and redelivery over sockets | DimaFX items are paid with Bits: delivered once | O (high) |
| P4-RT-OVERLAY-LIVE | 3 | `overlays/live.ts` 854, `custom_widgets/store.ts` 362, `widget-store.ts` 59 (1,275) | `dima-realtime::overlay_live` | P4-RT-SOCKETS, P4-FEAT-OVERLAYS, P4-FEAT-ASSETS | Overlay Studio socket sessions (12 events), widget RPC acknowledgements, delivery leases, the 1 s loop and the 15 s GridFS sweep | Leases; GridFS deletes; user widget RPC | O (high) |
| P4-SA-RUNNER | 3 | `site_agent/runner.ts` 910 | `dima-site-agent::runner` | P4-SA-CORE-B, P4-SA-TOOLS-A/B | Turns end to end with the model mocked: leases (15 s heartbeat), recovery (10 s), drain and Polar retries (30 s) | Money; lease loss | O (xhigh) |
| P4-SA-WRITE-A | 3 | `site_agent/tools/write/commands.ts` 834, `repeat.ts` 278 (1,112) | `dima-site-agent::tools::write` | P4-SA-CORE-A, P4-SVC-COMMANDS, P4-ACT-CORE | Command and repeat writes with approvals | Writes a streamer's commands | O (high) |
| P4-SA-WRITE-B | 3 | `write/timers.ts` 299, `write/settings/` `common` 127, `ai_personality` 292, `bits_rules` 221, `chat_events` 297 (1,236) | `dima-site-agent::tools::write::settings` | P4-SA-CORE-A, P4-FEAT-TIMERS, P4-SVC-SETTINGS, P4-FEAT-GAMES | Writes with approvals | Writes settings | O (high) |
| P4-SA-WRITE-C | 3 | `write/settings/` `follow_defense` 138, `goals` 257, `moderation` 412, `index` 62, `roulettes` 398, `tts` 194 (1,461) | `dima-site-agent::tools::write::settings` (other files) | P4-SA-CORE-A, P4-SVC-SETTINGS, P4-FEAT-GOALS/GAMES | Writes with approvals | Writes moderation and defense settings | O (high) |
| P4-API-AUTH-B | 3 | `auth.route.ts` lines 968–end (588): `login`, `mock-login`, `mock-register`, `repair`, `factory-reset`, `DELETE /account` | `dima-routes::auth::account` | P4-API-AUTH-A, P4-SVC-ACCOUNT, P4-SVC-COMMANDS | Every route, with the fault scenarios of account deletion | `POST /auth/login` trusts the body id; mock routes gated; factory reset and deletion are destructive | O (xhigh) |
| P4-API-COMMANDS | 3 | `command.route.ts` 311, `timer.route.ts` 253, `moderation.route.ts` 159, `follow_defense.route.ts` 406 (1,129) | `dima-routes::commands` | P4-SVC-COMMANDS, P4-SVC-SETTINGS, P4-FEAT-TIMERS, P4-ACT-CORE | Every route (the 1 MB body limit on `/commands`) | — | S (high) |
| P4-API-TRIGGERS-B | 3 | `trigger.route.ts` lines 1013–end (619): trigger CRUD, send, legacy file routes | `dima-routes::triggers` | P4-API-TRIGGERS-A, P4-SVC-COMMANDS, P4-RT-SOCKETS | Every route; the `trigger` broadcast | Query values reach filters (section 4) | S (high) |
| P4-CRON-RECAP | 3 | `workers/stream_memory.worker.ts` 471, `vod_clip_recommender.worker.ts` 421 (892) | `cron/src/workers/` | P2-CRON-01, P4-RECAP-B, P4-RECAP-D | Durable job claims, renewals, requeues | Money; long child programs under deadlines | O (high) |
| P4-ACT-AI-B | 4 | `ai.ts` lines 764–end (561, `chat`), `tools/index` 137, `recall_memory` 149, `create_memory` 153, `stream_stats` 48, `chat_summary` 62 (1,110) | `dima-actions::ai::chat` | P4-ACT-AI-A, P4-AI-MEMORY | Tool loops with scripted model answers: memory writes, summaries, replies | Model-directed writes; tool budget; code execution not offered | O (high) |
| P4-CHAT-CMDS-B | 4 | `command_manager` 453, `duel` 56, `index.commands` 44, `miyuloot` 121, `ruletarusa` 138, `shoutout` 168, `sumimetro` 137, `sumimetro_ast_message` 55, `vanish` 80, `promo` 103 (1,355) | `dima-chat::commands` (other files) | P4-ACT-CORE, P4-FEAT-GAMES, P4-ACT-AI-A | Replies and calls per command | `ruletarusa` times out, `vanish` deletes: moderation actions | S (high), with the two moderation commands reviewed as O |
| P4-RT-TTS-B | 4 | `tts_queue.handler.ts` lines 714–end (619): pet and read heads, capacity, playback reports, end, control, recovery, cleanup; `pets/read_tts.ts` 445 (1,064) | `dima-realtime::tts::playback` | P4-RT-TTS-A, P4-FEAT-PETS | Playback and end reports from overlay sockets, skip, clear, refresh, recovery after a restart | Races between overlay sockets; processing locks | O (high) |
| P4-API-CHANNEL | 4 | `reward.route.ts` 353, `bits-rules.route.ts` 80, `eventsub.route.ts` 340, `site.route.ts` 247 (1,020) | `dima-routes::channel` | P4-SVC-COMMANDS, P4-SVC-SETTINGS, P4-FEAT-GAMES, P4-CHAT-EVENTS | Every route, with the scenarios that show the reference's pass-through PATCH and the open `/site/events` writes | The known body pass-through and missing admin check (closed) | O (high) |
| P4-API-DIMAFX | 4 | `dimafx.route.ts` 1,201 (internal routes with the service token 920, owner routes 281) | `dima-routes::dimafx` | P4-RT-CLIP-FX, P2-PLATFORM-SVC | Purchase, use-credit, redeem: once, twice at the same moment, after an internal failure (the extension server's retry) | Bits money; duplicate key means "already fulfilled"; service token compared in constant time | O (xhigh) |
| P4-API-AGENT | 4 | `site-agent.route.ts` 306, `docs-assistant.route.ts` 136, `memories.route.ts` 311, `aiPersonality.route.ts` 185 (938) | `dima-routes::agent` | P4-SA-RUNNER, P4-SA-WRITE-A/B/C, P4-AI-MEMORY, P4-SVC-SETTINGS | Every route; the two SSE streams (resync, `Last-Event-ID` ignored) | SSE replay; the docs assistant's own CORS list and per-address limit | O (high) |
| P4-CRON-FEATURES | 4 | `workers/` `goals` 16, `duel` 18, `widgets` 16, `roulette-actions` 18, `credit_gifts` 23, `follow_defense` 141, `follow_defense_actions` 35, `temporary_roles` 334, `timer` 291; `utils/temporary_roles_announcements.ts` 112 (1,004) | `cron/src/workers/` | P2-CRON-01, P4-ACT-MOD, P4-FEAT-DEFENSE-B, P4-FEAT-TIMERS/GOALS/GAMES/WIDGETS, P2-BILLING-02b | Each worker's loop and effects | Watchdogs become deadlines; temporary role removal is a moderation action | O (high) |
| P4-RT-PETS | 5 | `pets/runtime.ts` 465, `pets/socket.ts` 293, `mouth_analysis` 89, `mouth_curves` 71, `mouth_curves.worker` 12, `tts_envelope` 59 (989) | `dima-realtime::pets` | P4-RT-TTS-B, P4-ACT-AI-B | Pet socket flows with acknowledgements, mouth curves from PCM vectors computed by Node, ffmpeg and ffprobe argument lists | Child programs on audio; the worker thread becomes `spawn_blocking` with the same limits (2 active, 8 queued, 5 s) | O (high) |
| P4-RT-DESKTOP | 5 | `desktop_ai/activity.ts` 326, `execution.ts` 215, `service.ts` 427 (968) | `dima-realtime::desktop_ai` | P4-RT-SOCKETS, P4-FEAT-ASSETS, P4-ACT-AI-B | Turns with 15 s leases, `speech:prepare` with a 2 s acknowledgement | Money (AI); leases | O (high) |
| P4-API-MEDIA | 5 | `file.route.ts` 67, `media.route.ts` 51, `asset-library.route.ts` 97, `clip.route.ts` 94, `speech.route.ts` 471 (780) | `dima-routes::media` | P4-RT-TTS-B, P4-RT-CLIP-FX, P4-FEAT-ASSETS | Every route, the three hand-written Range answers, the 301 of a speech directory | The open `POST /speech/:channelID` (section 4); upload concurrency caps | O (high) |
| P4-BIN-BOT | 5 | `bot/index.ts` 44 | `bot/` | everything the bot runs (section 5) | Start-up and shutdown against the rig; first the slice wiring (section 6) | Start order; shutdown budget | lead |
| P4-BIN-CRON | 5 | none (`cron.index.ts` is P2-CRON-01's) | `cron/` registration | every cron package | All workers in one process against the rig | Supervision | lead |
| P4-API-OVERLAYS | 6 | `overlay.route.ts` 91, `overlay-studio.route.ts` 257, `pet.route.ts` 84, `roulette.route.ts` 74, `widgets.route.ts` 46, `duel-widget.route.ts` 21, `goals.route.ts` 50 (623) | `dima-routes::overlays` | P4-RT-OVERLAY-LIVE, P4-RT-PETS, P4-FEAT-GOALS | Every route, public capability routes included | Capability URLs; strict owner checks (section 4) | S (high) |
| P4-BIN-API | 7 | `server/index.ts` 123 | `api/` | every API package | Start-up and shutdown against the rig | Start order | lead |

Rows are in wave order (column W, section 6). Every package also ports its TypeScript tests (`ledger/tests.md`) and adds
emoji, combining-mark and right-to-left cases wherever it handles text (charter §8).

## 4. The routes

`ledger/http.md` counts 321 routes: 320 on the API and the EventSub webhook in the bot (P4-BOT-INGRESS). The
route packages below take them by router file; the counts add up to 320. Guards are the ones `dima-platform`
exports: `require_user`, `optional_user`, `require_workspace_owner`, `require_admin`, `require_global_admin`,
`ChannelGuard::owner()`, `ChannelGuard::permission(..)` (with `.param(..)` when the channel is not
`:channelID`). The TypeScript checks access inside handlers or in a router-level `use('/:channelID')`; the Rust
route mounts the guard that check corresponds to.

| Package | Routers (routes) | Guards | Calls |
|---|---|---|---|
| P4-API-APP | `server.ts` (4, none), `oauth/routes.ts` (26: 16 OAuth access token, 5 `browserUser`, 5 none), `observability.route.ts` (terminal proxy) | OAuth access tokens through `dima-platform::oauth`; `browserUser` = `require_user` with a fresh `Twitch::user_by_token`; proxy passes the caller's `Authorization` to `dima-analytics` | merged `dima-platform`, `dima-stream` |
| P4-API-AUTH-A / -B | `auth.route.ts` (12: 6 and 6) | none or the OAuth code for the sign-in steps; `require_user` for `session`, `repair`, `factory-reset`, `DELETE /account`; `access/:channelID` asks for decisions (`dashboard:view`) like `getChannelAccessDecisions`; mock routes behind `MOCK_LOGIN_TOKEN` | `dima-twitch::store_sign_in`, P4-SVC-ACCOUNT, P4-SVC-COMMANDS |
| P4-API-USERS | `user.route.ts` (7: 2 bearer, 5 none), `email-auth.route.ts` (1, activation JWT), `email-test.route.ts` (1) | `require_user` + `ChannelGuard::owner()` for `active` and `chat`; `require_workspace_owner` for the email test | `dima-email`, `dima-stream` |
| P4-API-ADMINS | `admin.route.ts` (7), `admin-tools.route.ts` (1) | `require_user` + `ChannelGuard::permission("admins:view"/"admins:manage")` with the creator rules; `require_workspace_owner` for `read-file` | `dima-platform::access` |
| P4-API-ADMIN-SITE | `admin_site.route.ts` (12) | `require_global_admin` (replaces the check by login, `packages.md`) | `dima-events`, `dima-billing`, P4-FEAT-PETS, `dima-email` |
| P4-API-BILLING | `billing.route.ts` (13), `referral.route.ts` (7: 6 bearer, 1 none), `webhooks/polarsh.webhook.ts` (1, signed) | `require_user`, then the channel from `?channelID` (or the body for referrals) checked with `ChannelGuard::permission("billing:view"/"referrals:view")…param` semantics in the handler, as the reference does; raw body and Standard Webhooks signature | `dima-billing` (01c, 02b), `dima-events::producers::polar` |
| P4-API-CHANNEL | `reward.route.ts` (5), `bits-rules.route.ts` (4), `eventsub.route.ts` (6: 5 bearer, 1 none), `site.route.ts` (5) | `ChannelGuard::permission("rewards:*")`, `("eventsubs:manage")`; `require_user` for `/site` reads; **`require_global_admin` for `POST /site/events` and `PATCH /site/events/:id`** (owner decision) | P4-SVC-COMMANDS, P4-SVC-SETTINGS, P4-FEAT-GAMES, P4-CHAT-EVENTS (test route) |
| P4-API-COMMANDS | `command.route.ts` (8: 6 bearer, 2 none), `timer.route.ts` (6), `moderation.route.ts` (6), `follow_defense.route.ts` (10) | `ChannelGuard::permission("commands:*")`, `("moderation:*")`; the two public command lists stay public | P4-SVC-COMMANDS, P4-SVC-SETTINGS, P4-FEAT-TIMERS, P4-ACT-CORE (simulation) |
| P4-API-TRIGGERS-A / -B | `trigger.route.ts` (15: 7 and 8) | `ChannelGuard::permission("triggers:view/edit/delete")` (the reference's `ensureTriggerPermission`, which adds `triggers:all`) | `dima-platform::media_library`, P2-PLATFORM-SVC-4, P4-RT-SOCKETS |
| P4-API-MEDIA | `file.route.ts` (1, none), `media.route.ts` (1, none), `asset-library.route.ts` (5: 4 bearer, 1 capability), `clip.route.ts` (2: 1 bearer, 1 none), `speech.route.ts` (13: 10 bearer, 3 none) | Asset library: `require_user` + strict self check (see below); `ChannelGuard::permission("clips:manage")`, `("tts:view"/"tts:manage")` | P4-RT-TTS-A/B, P4-RT-CLIP-FX, P4-FEAT-ASSETS |
| P4-API-DATA | `analytics.route.ts` (1) with `stream_timeline.route.ts` (8), `dashboard.route.ts` (6), `stream-summary.route.ts` (2), `clip-recommendations.route.ts` (6) | `ChannelGuard::permission("analytics:view"/"dashboard:view"/"summaries:view"/"clips:*")`; the timeline router asks for `analytics:view` and reads `billing:view` as a decision | `dima-stream`, P4-SVC-READS, P4-RECAP-C |
| P4-API-OVERLAYS | `overlay.route.ts` (5: 4 none, 1 capability), `overlay-studio.route.ts` (35: 29 bearer, 6 capability), `pet.route.ts` (9: 6 bearer, 3 capability), `roulette.route.ts` (12), `widgets.route.ts` (7), `duel-widget.route.ts` (5), `goals.route.ts` (5) | Roulette, widgets, duel: `ChannelGuard::permission("*")`; goals: `dashboard:view` for GET, `*` otherwise; Overlay Studio and pets: strict self check; capability URLs check their token | P4-FEAT-*, P4-RT-OVERLAY-LIVE, P4-RT-PETS |
| P4-API-DIMAFX | `dimafx.route.ts` (14: 6 bearer, 8 service token) | `ChannelGuard::permission("dimafx:view/edit/delete")`; a constant-time `DIMAFX_SERVICE_TOKEN` check for `/internal/*` (a small guard in `dima-routes`) | P4-RT-CLIP-FX, `dima-platform::extension_fulfilment` |
| P4-API-AGENT | `site-agent.route.ts` (16), `docs-assistant.route.ts` (2, none, own CORS list), `memories.route.ts` (5), `aiPersonality.route.ts` (3) | Site agent: `require_user` + its own access resolution (`resolveAccess`, rate limit first, as the reference); `ChannelGuard::permission("memories:*"/"ai:*")` | P4-SA-RUNNER, P4-AI-MEMORY, P4-SVC-SETTINGS |

**Strict self checks.** `overlay-studio.route.ts:84`, `asset-library.route.ts:37` and `pet.route.ts` (`owner()`)
admit only `req.user.id === channelID`; `ChannelGuard::owner()` also admits global owners
(`hasGlobalChannelOwnerAccess`). Keeping the reference needs a guard variant that admits the channel itself only
(question 7.6).

### Routes that pass a body into a write or trust what the client sends

Found by reading every handler the mechanical search flagged (a search for request bodies or query values
reaching a MongoDB call, and for `:channelID` routes without an access call in the handler or its router
`use`; 65 hits, all read). The two known ones first.

| Route | Where | What happens | Rust (package) |
|---|---|---|---|
| `POST /site/events`, `PATCH /site/events/:id` | `site.route.ts:66`, `:226`, `:245` | Any signed-in user writes the global event templates; the PATCH writes the body as given | Admin check and typed fields (owner decision; P4-API-CHANNEL) |
| `PATCH` EventSub settings, events, rewards | `eventsub_config.service.ts:477`, `site.route.ts:245`, `reward.route.ts:363` | Body written as given under `{_id, channelID}`: identity fields and update operators reach the write | Typed fields only (owner decision; P4-SVC-SETTINGS, P4-API-CHANNEL) |
| **`POST /speech/:channelID`** | `speech.route.ts:423` | No authentication at all. Anyone who knows a channel id whose TTS is on can queue speech on that stream with their own text, provider, voice and clone name; read in the code, `queueRequest` then checks and spends the channel's AI credits for Fish synthesis. Its only caller is the bot (`functions/chats/speech.chat.ts`, over `INTERNAL_API_URL`) | Section 7.1 (P4-API-MEDIA, P4-ACT-MEDIA) |
| **`POST /overlays/furry/:channelID`** | `overlay.route.ts:64` | No authentication; puts `username` and `value` from the body on the channel's furry overlay. No TypeScript caller exists in the repository (searched); 11 stored commands use the `furrometro` function, so a streamer's own setup may call it | Kept public (it is a contract for whoever calls it); listed for the owner (7.1) |
| **`POST /users/premium`** | `user.route.ts:142` | No authentication; `channel` and `channelID` from the body go straight into `findOne({'accounts.name': channel, 'accounts.id': channelID})`, so `{"$ne": null}` answers the plan tier of an arbitrary user | Strings only; anything else is the reference's "Channel not found" 400 (P4-API-USERS) |
| `GET /admin/read-file` | `admin-tools.route.ts:12` | Workspace owner only. The allowed-prefix check runs on the raw path, so `/home/cdom/saas/dimabot/../../../etc/passwd` passes; the allowed bases do not exist in the container | Canonicalise, then check the prefix (P4-API-ADMINS) |
| Query values as filters in the caller's own channel | `trigger.route.ts:1017` (`id`, `name`), `:314` and `:395` (library filters), `reward.route.ts:92` (`type`) | `qs` turns `?type[$ne]=x` into an operator; the filter still holds `channelID`, so nothing outside the channel is reached | Query values typed as strings (P4-API-TRIGGERS-A/B, P4-API-CHANNEL) |
| `PUT /users/active/:channelID`, `POST /users/chat/:channelID` | `user.route.ts:240` and the chat route | The update filters on `accounts.id` without `accounts.type`, the same pattern as the AI personality hook | Match type and id on one account, as already decided for the hook (P4-API-USERS) |
| `GET /users?username=` | `user.route.ts:26` | No authentication; a Helix user lookup with the app token for any caller | Kept (public contract); noted for a rate limit |

Checked and fine: every route that reads a channel id from the query or body (`billing.route.ts:90`, `:480`;
`referral.route.ts:35` and its five callers; `clip.route.ts:44`) checks access to that channel before use.
`duel-widget.route.ts` sits under the `widgets` router's owner check, `stream_timeline.route.ts` under its own
`use('/streams/:channelID')` check, the site-agent routes under `context()` plus `ownTurn()`, the DimaFX owner
routes under `ensureDimafxPermission`.

## 5. The binaries and the workers

### 5.1 Obligations already collected in `packages.md`, placed

| Obligation (source) | Package |
|---|---|
| Every runtime thread registers its stack (`dima_engine::stack::register_thread` in `on_thread_start`), or every evaluation fails (E-ENGINE-02b) | P4-BIN-API, P4-BIN-BOT, P2-CRON-01 (the cron evaluates: timers, follow defense messages, chat announcements) |
| `Twitch::start_recovery` once per binary at start, holding the start at most 3 s (P2-TWITCH-01c) | P4-BIN-API, P4-BIN-BOT, P2-CRON-01 |
| `Twitch::reconcile_recovery` every five minutes (P2-TWITCH-01c) | P4-CRON-LEDGERS |
| Operator commands to run the reconciliation and list and settle records with the services stopped (P2-TWITCH-01d) | P4-OPS-CLI |
| Shutdown budget `Timings::shutdown_budget()` 17 s; `stop_grace_period` 25 s for all three (P2-TWITCH-01b/c, phase 7) | each P4-BIN-*; the compose change is phase 7 |
| Stream sessions: load Twitch's directory, start-up reconciliation once, then the tick at once and every five minutes (P3-STREAM-SESSIONS-b) | P4-CRON-LEDGERS (`stream_analytics.worker.ts`) |
| Site analytics board refresh every 15 s and the snapshot hourly (P3-STREAM-SITE) | P4-BIN-API (the reference starts them in `server/index.ts:51`) |
| Periodic usage flush for channels gone quiet (P2-BILLING-02a) | P4-CRON-MONEY |
| The cron implements `Report` with `dima-telemetry` (P2-EVENTS-02) | P2-CRON-01 |
| EventSub reconciliation lease `worker:eventsub-reconciliation:lock`, `RunControl`, `RaidPreferences`, `GlobalOwnerAccess` (P2-TWITCH-02) | P4-CRON-LEDGERS |
| What the EventSub ingress answers for an event that can never be valid (P2-EVENTS-01) | P4-BOT-INGRESS |
| `BackendApi` and `ClipPublisher` wired (P2-TWITCH-03); `ModeratorUserLookup`, `RewardApi` wired (P2-TWITCH-04b) | P4-ACT-MEDIA (bot and cron), P4-RT-SOCKETS/P4-RT-CLIP-FX (API); P4-ACT-MOD, P4-SVC-COMMANDS |
| Timed VIP code removed (owner, 2026-11-12) | P4-CHAT-EVENTS |
| Reclaim scripts with an explicit iteration cap (F-STORE-DF-c) | P2-BILLING-02a, P4-CRON-MONEY |
| The reverse proxy limits per address; Socket.IO has none of its own (phase 7) | phase 7; P4-RT-SOCKETS documents it |

### 5.2 `api` (`dima-server`, port 3000)

Start-up, in the reference's order (`server/index.ts:34-137`, `runtime.md` §5.1): telemetry; Dragonfly; MongoDB;
OAuth; Qdrant; Polar; pub/sub subscriber; product events; Qdrant collections; the streamer directory; site
analytics with recovery; clip queue; TTS queue, the `tts:session-ended` subscription and stale TTS locks; the
router (`dima-routes`, mounted as `server.ts` does); the Socket.IO server with every namespace (pets, overlays,
desktop); the desktop AI runtime; the site agent runtime; listen. Rust adds `start_recovery` and stack
registration before the first route. A failure in the router or Socket.IO set-up exits non-zero, as today.

Owns: the 30 s stale-connection sweep, the per-socket dashboard status timer, the 500 ms overlay polls of
roulette, widgets and duel, the 2 s DimaFX poll, the DimaFX lease renewal (5 s) and redelivery, the Overlay
Studio 1 s loop and 15 s sweep, the pet readiness (5 s), pet recovery and peer validation (15 s), the desktop AI
recovery (5 s) and heartbeats (15 s), the site agent recovery (10 s) and drain (30 s), the voice preview lock
(30 s), speech file deletion (120 s), the board refresh (15 s) and snapshot (1 h), telemetry (10 s), the OAuth
and docs-assistant rate limits, the upload caps. Shutdown: stop accepting, close sockets through `dima-web`'s
upgrade contract, release TTS, DimaFX, overlay and turn leases, flush telemetry, park token rotations, all inside
the 17 s budget. Assembled by P4-BIN-API from P4-API-APP and every `P4-API-*`, `P4-RT-*`, `P4-SA-*` package.

### 5.3 `bot` (`dima-bot`, port 3333)

Start-up (`bot/index.ts:24-54`): telemetry; Dragonfly; MongoDB; Qdrant; Polar; product events; the bot metrics
loop; pub/sub; the keyword cache subscription; the streamer directory; the AST timer scheduler; the EventSub
listener on 3333; the AST catalog vectors in the background. Rust adds `start_recovery` and stack registration.
Owns: the AST timer scheduler (2 s reconcile plus one timer per due job, the carried `ast:timers:*` family), the
embedding batcher (350 ms, 500 per batch, 3 retries), domain-event wakeups, the metrics flush
(`BOT_METRICS_INTERVAL_MS`, default 30 s). Shutdown: the reference's SIGTERM listener only flushes metrics and
then waits for SIGKILL; Rust stops the listener, drains in-flight webhooks, flushes metrics and exits within the
budget (intended difference). Assembled by P4-BIN-BOT from P4-BOT-INGRESS and the `P4-CHAT-*` packages.

### 5.4 `cron` (`dima-cron`)

One process with the supervisor of P2-CRON-01: each worker a supervised task, restarted alone with backoff,
every unit of work under a deadline with abort and join, a stuck task ends the process after the grace (charter
§6). The reference's watchdogs (`credit_gifts.worker.ts:14`, 90 s; `follow_defense_actions.worker.ts:22`, 40 s)
become those deadlines. Assembled by P4-BIN-CRON. The reference's 19 TypeScript workers (`workers/cron.index.ts:39-127`)
and the native index:

| Worker | Schedule in the reference | Calls | Native today | Ported by |
|---|---|---|---|---|
| goals | `settleGoals` then sleep 5 s | goal completion, fixed deadlines, rolling failures | no | P4-FEAT-GOALS (logic), P4-CRON-FEATURES (loop) |
| duel | `settleDuels` every 500 ms; flushes widget publishes on stop | duel completion (timeouts, results) | no | P4-FEAT-GAMES, P4-CRON-FEATURES |
| widgets | `settleDue` every 1 s | widget settle | no | P4-FEAT-WIDGETS, P4-CRON-FEATURES |
| credit-gifts | `processCreditGift` every 1 s, 90 s watchdog | credit gift delivery | no | P2-BILLING-02b, P4-CRON-FEATURES |
| semantic-moderation | 250 ms loop, up to 4 reviews at once, maintenance every 1 s, one variation job every 1 s | semantic review and variation generation | no | P4-MOD-RUN (loop included) |
| roulette-actions | `runDueActions` every 1 s | roulette due actions | no (the completion is: `roulette_completion`) | P4-FEAT-GAMES, P4-CRON-FEATURES |
| follow-defense-actions | one action, then 20 ms if busy or the adaptive delay; audit every 1 s; 40 s watchdog | ban queue at 5 to 10 requests a second | no | P4-FEAT-DEFENSE-B, P4-CRON-FEATURES |
| follow-defense | every 1 s (`FOLLOW_DEFENSE_WORKER_INTERVAL_MS`), lock retry 5 s | detection | baseline only (`follow_defense_baseline`) | P4-FEAT-DEFENSE-A, P4-CRON-FEATURES; baseline in P2-CRON-01 |
| follow-ledger | queue consumer, 1 s between Twitch requests per direction | follow ledger reconciliation | no | P3-STREAM-FOLLOW (merged), P4-CRON-LEDGERS |
| stream-analytics | every 5 min (minimum 60 s), lock retry 10 s | session tick, reconciliation | no | P3-STREAM-SESSIONS (merged), P4-CRON-LEDGERS |
| domain-events | poll 1 s, lease 60 s, one child process per consumer | event consumers | no | P2-EVENTS-02 (merged runtime), P4-EVH (handlers); one task per consumer in P4-BIN-CRON |
| eventsub-reconciliation | every 6 h (minimum 1 h), 250 ms between requests; off unless `EVENTSUB_RECONCILIATION_ENABLED` (off in production) | subscription reconciliation | no | P2-TWITCH-02 (merged), P4-CRON-LEDGERS |
| free-credit-reset | hourly (minimum 60 s), if `FREE_CREDIT_RESET_ENABLED` | free plan credit reset | no | P2-BILLING-01 (merged rules), P4-CRON-MONEY |
| ai-usage-backfill | queue, at least 250 ms (default 1 s) between Polar requests, if `AI_USAGE_BACKFILL_ENABLED` | usage backfill | no | P2-BILLING-02a, P4-CRON-MONEY |
| stream-memory | durable job consumer, requeue 2.5 s, lock retry 10 s | stream summary and memory workflow | no | P4-RECAP-A/B, P4-CRON-RECAP |
| temporary-roles | every 60 s (minimum 30 s) | expire temporary moderators (and VIPs: dropped) | no | P4-CRON-FEATURES |
| timer | every 60 s, recovery every 2 s | custom timers posted through `deliverAstMessage` | no | P4-FEAT-TIMERS, P4-CRON-FEATURES |
| activation-reminder | daily at UTC midnight, lock retry 10 s | activation emails | no | P4-CRON-LEDGERS |
| vod-clip-recommender | durable job consumer, requeue 5 s, reconciliation every 15 min | VOD clip recommendations | no | P4-RECAP-C/D, P4-CRON-RECAP |
| native `cron_index` | seven workers in their own processes | stream activity, raid analytics, follow defense baseline, roulette completion, AI usage receipts, raid sessions, dashboard activity | **yes** | P2-CRON-01 (first four), P2-CRON-02 (last three) |

Two loops run outside `workers/` today and need a home: the restore-moderator loop (`moderation.functions.ts:196`,
2 s, started lazily in whichever process evaluates a command first, so in both the bot and the API) and the AST
timer scheduler (bot). The timer scheduler stays in the bot; the restore loop moves to the cron (question 7.4).

## 6. The order

Waves are the longest chain of dependencies in section 3 (computed, not judged). A package starts when its
dependencies are merged; within a wave everything can run at once, subject to the pace rules of `packages.md`.

| Wave | Packages | Starts when |
|---|---|---|
| 0 | **P4-SKEL** (lead), **P4-CMD-RUNTIME** (O), **P4-AI-MEMORY** (O); ledger: P2-CRON-01 (O), P2-PLATFORM-SVC-4 (S), F-MODEL-07c (S), F-MODEL-NATIVE (S), RIG-02e (S); running: E-ENGINE-02c, P2-BILLING-02a | now |
| 1 | P4-TW-CHAT (S), P4-BOT-INGRESS (O), P4-MOD-RULES (O), P4-FEAT-GOALS (O), P4-FEAT-GAMES (O), P4-FEAT-WIDGETS (S), P4-FEAT-OVERLAYS (O), P4-FEAT-PETS (S), P4-FEAT-DEFENSE-A (O), P4-FEAT-TIMERS (S), P4-FEAT-ASSETS (O), P4-RECAP-A (S), P4-RECAP-C (S), P4-SVC-READS (S), P4-SVC-COMMANDS (O), P4-SA-CORE-A (O), P4-SA-DOCS (S), P4-API-APP (O), P4-CRON-LEDGERS (S), P4-CRON-MONEY (O), P4-OPS-CLI (S); ledger: P2-BILLING-02b (O), P2-CRON-02 (O) | P4-SKEL is merged (most of the wave), or P2-CRON-01 / P2-BILLING-02a / P4-AI-MEMORY for the rest |
| 2 | P4-ACT-CORE (O), P4-MOD-RUN (O), P4-FEAT-DEFENSE-B (O), P4-SVC-SETTINGS (O), P4-SVC-ACCOUNT (O), P4-RECAP-B (O), P4-RECAP-D (O), P4-RT-SOCKETS (O), P4-SA-CORE-B (O), P4-SA-TOOLS-A (S), P4-SA-TOOLS-B (S), P4-API-AUTH-A (O), P4-API-USERS (S), P4-API-ADMINS (O), P4-API-ADMIN-SITE (O), P4-API-BILLING (O), P4-API-DATA (S), P4-API-TRIGGERS-A (O) | wave 1 |
| 3 | P4-ACT-CHANNEL (S), P4-ACT-MOD (O), P4-ACT-MEDIA (S), P4-ACT-AI-A (O), P4-ACT-AI-C (S), P4-CHAT-MESSAGE (O), P4-CHAT-EVENTS (O), P4-CHAT-CMDS-A (S), P4-EVH (O), P4-RT-TTS-A (O), P4-RT-CLIP-FX (O), P4-RT-OVERLAY-LIVE (O), P4-SA-RUNNER (O), P4-SA-WRITE-A/B/C (O), P4-API-AUTH-B (O), P4-API-COMMANDS (S), P4-API-TRIGGERS-B (S), P4-CRON-RECAP (O) | P4-ACT-CORE for most |
| 4 | P4-ACT-AI-B (O), P4-CHAT-CMDS-B (S), P4-RT-TTS-B (O), P4-API-CHANNEL (O), P4-API-DIMAFX (O), P4-API-AGENT (O), P4-CRON-FEATURES (O) | wave 3 |
| 5 | P4-RT-PETS (O), P4-RT-DESKTOP (O), P4-API-MEDIA (O), **P4-BIN-BOT** (lead), **P4-BIN-CRON** (lead) | wave 4 |
| 6 | P4-API-OVERLAYS (S) | P4-RT-PETS |
| 7 | **P4-BIN-API** (lead) | everything |

By implementer: 50 packages suit the stronger implementer (O), 22 a mechanical one (S), 4 are the lead's.

**Can start today, in parallel, touching different files:** P4-CMD-RUNTIME (O, `crates/commands/src/runtime/`),
P4-AI-MEMORY (O, `crates/ai/src/memory_store.rs`), P2-CRON-01 (O, `cron/`), P2-PLATFORM-SVC-4 (S,
`crates/platform/src/media/`), F-MODEL-07c and F-MODEL-NATIVE (S, `crates/model/`, one after the other since
they share the crate's registry), RIG-02e (S, `rig/`). P4-SKEL is the lead's first job; once it is merged, the
twelve wave-1 packages that need nothing else start at once, each in its own module directory of a new crate; three more wait for F-MODEL-07c and one for P2-BILLING-02a.

**Critical path to three running binaries compared by the rig.** Two chains of the same length end in
P4-BIN-API: P4-SKEL → P4-TW-CHAT → P4-ACT-CORE (also waits for E-ENGINE-02c) → P4-ACT-AI-A → P4-ACT-AI-B →
P4-RT-PETS → P4-API-OVERLAYS → P4-BIN-API, and P4-SKEL → P4-FEAT-GAMES → P4-RT-SOCKETS → P4-RT-TTS-A →
P4-RT-TTS-B → P4-RT-PETS → P4-API-OVERLAYS → P4-BIN-API. Counted in TypeScript lines the heaviest path is
P4-CMD-RUNTIME → P4-ACT-CORE → P4-ACT-AI-A → P4-ACT-AI-B → P4-RT-PETS → P4-API-OVERLAYS → P4-BIN-API (5,838
lines, all O). The bot's longest chain is P4-SKEL → P4-TW-CHAT → P4-ACT-CORE → P4-ACT-AI-A → P4-ACT-AI-B →
P4-BIN-BOT; the cron's is P4-SKEL → P4-TW-CHAT → P4-ACT-CORE → P4-ACT-MOD → P4-CRON-FEATURES → P4-BIN-CRON. So
P4-ACT-CORE, the AI chat and the TTS queue decide the date; they get Opus first. The rig needs RIG-02e before
whole-binary captures, and each P4-BIN package adds its Rust target beside `dimabot-api`, `dimabot-bot`,
`dimabot-cron`.

### The first vertical slice: a custom command answered by the bot

**Slice 1** = P4-SKEL, P4-TW-CHAT, P4-CMD-RUNTIME, E-ENGINE-02c (running), P4-ACT-CORE, P4-BOT-INGRESS,
P4-CHAT-MESSAGE, and part 1 of P4-BIN-BOT (the bot started with only these). It is ready after four steps
(P4-SKEL, P4-TW-CHAT with P4-CMD-RUNTIME beside it, P4-ACT-CORE, P4-CHAT-MESSAGE with P4-BOT-INGRESS beside it).
P4-CHAT-MESSAGE calls moderation and the AI reply through their crates' entry points; until P4-MOD-RUN and
P4-ACT-AI-B land those answer "not enabled", which is exactly what the reference does for a channel whose
moderation and AI are off, so the slice scenario uses such a channel and the comparison is honest.

The scenario, on target `dimabot-bot` against the Rust bot: seed a channel with a custom command
`!hola` = `Hola $(user), van $(count) saludos` (a variable write and a counter), send a signed
`channel.chat.message` webhook `!hola`, and compare the webhook answer, the journal document, the Helix
`POST /chat/messages` body on the mock, the variable and cooldown writes in MongoDB and Dragonfly, the stream
recorders' writes (merged `dima-stream`) and the absence of anything else. A second message inside the cooldown
must produce no Helix call. This exercises ingress, signature, journaling, command lookup, permissions,
cooldowns, the engine with a real host, delivery, the splitter and the outbound call: every layer of the bot.

## 7. Open questions for the lead

Each with a recommendation. Those marked **owner** need the owner's word.

1. **owner. The open speech route.** `POST /speech/:channelID` has no authentication and spends the channel's
   AI credits (section 4). Its only caller is the bot, which will be Rust too. Recommendation: Rust requires a
   service credential on it (a header the bot sends, compared in constant time, like `DIMAFX_SERVICE_TOKEN`);
   the OBS pages are untouched. Whether to patch the running TypeScript first is the owner's call, as for the
   earlier findings. Same question, lower stakes, for `POST /overlays/furry/:channelID` (open, no caller in the
   repository): keep it open unless the owner says nothing uses it, then drop it.
2. **The crate map changes.** `packages.md` decided `dima-realtime` at layer 8, above `dima-actions`. The host
   functions call goals, roulette, duel, widgets, pets and Overlay Studio, so a realtime crate above the host
   recreates the cycle. Recommendation: split it as in section 2 (`dima-features` below the host, socket-owning
   `dima-realtime` above it) and add `dima-moderation`, `dima-recap` and `dima-routes`. The alternative, one
   realtime crate below `dima-actions`, would make the bot and the cron link the Socket.IO server and the queue
   handlers; rejected for that reason. `dima-routes` is needed because the route files hold logic (13,000 lines)
   and the charter keeps binaries to wiring.
3. **The EventSub test route runs the bot's handler inside the API** (`eventsub.route.ts:149`), so the API links
   `dima-chat`. Recommendation: keep it (the behaviour is "the handler runs now, in this process"); forwarding to
   the bot through a queue would change what the caller sees when the bot is down.
4. **Where the restore-moderator loop runs.** Today it starts in whichever process first evaluates a command, so
   the bot and the API both poll `twitch:moderation:banmod:restore:queue` every 2 s (the claim is atomic, so
   nothing runs twice). Recommendation: the cron runs it (P4-CRON-FEATURES), alone; the family stays *carried*
   at the cutover with a fixture of the TypeScript format.
5. **What the EventSub ingress answers for an event that can never be valid** (left open by P2-EVENTS-01). The
   reference answers 503 and Twitch redelivers for ever. Recommendation: answer 2xx and keep the delivery in a
   dead-letter record, so a malformed event cannot occupy Twitch's retries; the rig's allow-list carries the
   difference.
6. **Strict self checks.** Overlay Studio, the asset library and the pet routes admit the channel itself only;
   `ChannelGuard::owner()` also admits global owners. Recommendation: add a `ChannelGuard::self_only()` to
   `dima-platform` (a few lines, by the lead with P4-SKEL) and keep the reference; widening is a product change.
7. **owner. Features that look unused in production** (local copy, newest data 2026-11-11; counts are documents):
   - Temporary roles: `temporary_moderators` 0 and `vips` 0 (timed VIP is dropped), so the temporary-roles
     worker has had nothing to do; `duel_moderator_restores` 0, `raid_moderation_requests` 0,
     `follow_defense_actions` 0, `follow_hate_raid_sources` 0.
   - DimaFX extension: `dimafxplaybacks` 0, `channelextensionitems` 2 (one channel, last change 2026-07-17),
     `extensionwallettransactions` 20 (one channel, last 2026-06-22), `userextensioninventories` 1.
   - Desktop AI: `desktop_ai_conversations` 0, `desktop_ai_turns` 11, all from one channel.
   - Overlay Studio delivery: `overlay_deliveries` 0, `overlay_media.*` 0, `overlay_source_leases` 0, while
     `overlay_studios` holds 12 and `overlay_interactions` 98.
   - Goals: `channel_goals` 1, `goal_contributions` 1, `goal_custom_receipts` 0. Custom widgets 3, the widget
     store 2, asset libraries 4, bits rules 2. Pets are used: 386 requests, 4 runtimes.
   - Legacy collections that only account deletion still reads: `countdowntimers` 2 and `countdowntimerconfigs`
     2 (2024), `titleconfigs` 4, `timer_commands` 0, `commanduservariables` 0, `clipdesigns` 0.
   Recommendation: port everything that has an outside client (the extension, the desktop app, Overlay Studio,
   OBS overlays), late as section 6 already places it; keep the legacy collections in account deletion only. Ask
   the owner whether temporary moderators (the `$(mod)` duration path) and the DimaFX extension are still wanted;
   dropping them removes about 450 lines (the worker and its announcements) and 1,800 lines (route, queue, services) respectively.
8. **owner. Two one-off scripts are not finished on the copy.** `migrate_ast_variables_global` still matches 9
   rows and `cleanup_orphaned_clip_recommendations` 19. Recommendation: the owner checks production (the copy is
   stale) and runs them there before the cutover; they are not ported. The other checked migrations show as run.
9. **Bot to API calls stay HTTP in the first cut.** Speech, TTS control and status (sent with the streamer's own
   Twitch token, `control_tts.chat.ts`), the Overlay Studio queue and trigger sends go through `BackendApi` as
   today. Replacing them with Dragonfly requests is internal and can come after the rig is green.
10. **owner. `GET /admin/read-file`.** It reads files under `/home/cdom/saas/…`, which do not exist in the
    production containers (the checkout is `/root/saas` and the image holds `/app`), so it can only fail today;
    the admin site has a page for it. Recommendation: drop it in Rust (the Rust image has no source files to
    read), or keep it with a canonicalised path check if the owner still uses the page.
11. **Bot shutdown.** The reference's bot ignores SIGTERM until killed. Rust drains and exits within its budget;
    recorded as an intended difference (P4-BIN-BOT).

## After P4-SKEL

The names later briefs cite, where they differ from or add to the plan above (P4-SKEL, 2026-11-12). Every
module's documentation names its package, the TypeScript it ports and the reference's exports other packages
call.

**Crates and binaries.** Directories are the crate name without `dima-`: `crates/moderation`, `features`,
`actions`, `chat`, `realtime`, `services`, `event-handlers`, `recap`, `site-agent`, `routes`. The binaries are the
packages `dima-server` (`api/`) and `dima-bot` (`bot/`); `cron/` stays P2-CRON-01's, and its package name
`dima-cron` is already in the layer test.

**`dima_twitch::chat`** (section 2.1):

- `ChatOut` has two methods. `send(&RenderScope, text) -> Result<Sent, ChatError>` is `sendTwitchChatMessage`,
  plain or rendered. `deliver(channel_id, Option<&Rendering>, text) -> Result<(), ChatError>` is
  `parseSpecialCommands` then `deliverAstMessage`, which the goal and roulette actions and the cron's timer loop
  need (they let a rendering failure through, trim, and never reply).
- `RenderScope { channel_id, reply_to, render: Option<Rendering> }` (`RenderScope::plain`, `::rendered`,
  `.replying_to`). `Rendering` is the reference's render context (`event_data`, `eventsub_data`, `argument`,
  `literal_arguments`, `variables`, `user_plan: Option<dima_model::users::PlanTier>`, `user_level`,
  `extra_context`, `scope_type`, `scope_name`, `scope_aliases`, `effect: Option<EffectGrant>`). `EffectGrant`
  describes a Twitch event's authority; `ChatDelivery` mints the engine's `Effect` from it (the crate is below the
  engine, so no engine type crosses).
- `Sent::{Posted { message_id }, Nothing}` and `ChatError::{Rejected, HeldForModeration, NoAppToken, Failed,
  RequiredGoalContribution, Render}` with `message()`, `kind()` (the reference's `type`) and `status()`.
  `RequiredGoalContribution` is the error the reference rethrows out of a send so the domain event is retried.
- The plain send lives at **`dima_twitch::chat::send`** (the plan said `functions::chats::send`); P4-TW-CHAT owns
  `crates/twitch/src/chat/send.rs`.

**`dima_actions`** (section 2.2):

- `host::DimaHost::new(Arc<HostDeps>)`. `HostDeps` holds `mongo`, `dragonfly`, `twitch`, `clock`, `random` and
  one struct per group, `host::{moderation, channel, media, ai}::Deps`, which each group package fills (only
  `media::Deps` has fields yet: `backend: Arc<dyn BackendApi>`, `clips: Arc<dyn ClipPublisher>`).
- `host::Group::of(HostFunction) -> Option<Group>` is the `match` over every variant (`None` for `Custom`); each
  group module's entry is `call(&mut DimaHost, HostCall) -> Result<Value, HostError>`.
- "Not yet ported" is `host::ActionError::NotYetPorted(HostFunction)` (also `StorageNotYetPorted(&str)`,
  `Unregistered(String)`), turned into `dima_engine::host::HostError`, the engine's only failure kind for a host
  (a thrown error: the evaluation stops). Until P4-ACT-CORE: storage methods answer `StorageNotYetPorted`,
  `fork_effect` answers `None`, `sleep` waits on tokio time, `alarm` keeps the engine's default.
- `delivery::ChatDelivery::new(Arc<HostDeps>, Arc<Engine>)`, the future `ChatOut` implementer.
- `runner::CommandRunner::run_program(&str, Context) -> Result<Value, runner::RunError>` (the `ast_parser` tool's
  `parseAndEvaluate` then reference delivery); `RunError::{Parse(Diagnostic), Eval(EvalError)}`.
- `backend` (new path): the bot and cron `BackendApi` and `ClipPublisher`, P4-ACT-MEDIA's.

**`dima_realtime`**: `registry::RealtimeModule` (`const NAME`, `type Handle`, `register(self, &mut Sockets) ->
Result<Handle, RegisterError>`), `registry::Sockets::{namespace, family, fail}`, `registry::Registry::{new(Builder),
register, declared, build}`, `registry::Declared`. `backend` (new path) is the in-process `BackendApi` and
`ClipPublisher` (P4-RT-SOCKETS, with P4-RT-CLIP-FX's publisher).

**`dima_event_handlers`**: `registry::Registry<D = registry::Deps>` with `register(consumer, |deps| Arc<handler>)`,
`missing()` and `into_consumers()` for `dima_events::consumer::Runtime::new`. It is keyed by **consumer name**
(the reference's `DOMAIN_EVENT_CONSUMERS`), not by event type as section 2.3 put it: `dima-events` dispatches by
consumer. `registry::Deps` holds `mongo`, `dragonfly`, `twitch`, `chat: Arc<dyn ChatOut>`, `clock`, `random`. The
handlers are `handlers` (P4-EVH).

**`dima_platform::access`**: `ChannelGuard::self_only()` with the new `Need::SelfOnly` (question 7.6).

**`dima_routes`**: `mounts::MOUNTS` (54 lines of `server.ts`: 42 routers, 8 middleware, 3 inline routes and the
OAuth metadata route), `mounts::build::<S>()`, `mounts::{Mount, What, RouterFile, Middleware, Route, Guard}`;
`state::RouteState` is the bound every router takes. Each router file is a function of its package's module,
named in `RouterFile::router` (for example `users::user_router`, `media::speech_router`). `auth::router` mounts
`auth::account::router` after its own routes; `triggers::router` mounts `triggers::library::router` before its
own. P4-API-APP owns `mounts` after P4-SKEL and fills the middleware and inline routes in `build`. The speech
route's service credential (question 7.1) is the `Guard::Undecided` of `/speech`.

**Module paths added to the plan's.** `dima_site_agent::tools` and `tools::write::settings` have one submodule per
TypeScript file, because P4-SA-TOOLS-A/B (wave 2) and P4-SA-WRITE-B/C (wave 3) fill them at the same time;
`tools::write::timers` is P4-SA-WRITE-B's; `tools::write::settings` (its `mod.rs`) is P4-SA-WRITE-C's.
`dima_features::desktop` holds the desktop AI model (P4-FEAT-ASSETS).

**Binaries.** `THREAD_STACK_BYTES` = 2 MiB (registered in `on_thread_start`), `SHUTDOWN_BUDGET` = 17 s, typed
configuration in `api/src/config.rs` and `bot/src/config.rs`. **`api/tests/layers.rs`** reads `cargo metadata`
and enforces the layers: a new crate must add its layer there, and the crate map's two same-layer edges
(`dima-features` → `dima-engine`, `dima-routes` → `dima-site-agent`) are the only ones allowed.

**Decided by the lead at the merge.** `pubsub_manager.class.ts`, `bot_runtime_metrics.ts` and `posthog_events.ts`
are loaded by the cron as well as the bot, so they land in `dima-actions` (modules `pubsub`, `metrics`,
`product_events`), which all three binaries link, not in `dima-chat`. A credit gift's chat announcement stays the
callback `dima-billing` already takes (`GiftEffects`); the cron worker implements it with `ChatOut`. How a route
module reaches its services (`RouteState`) is P4-API-APP's to settle.

## Status of the packages

Kept by the lead; a package not listed has not started.

| Package | Status |
|---|---|
| P4-SKEL | merged |
| P4-CMD-RUNTIME | merged (98 tests in the crate). Later packages: every write to `commands` goes through `CommandCache::write` (P4-SVC-COMMANDS ports create and edit; account deletion calls `invalidate_channel`); the cron calls `Availability::recover` every 2 s. Reference bug kept for now, to fix with P4-SVC-COMMANDS: `availability/service.ts:48` and `:81` read rewards without the schema default of `createdFor`, so 26 of the 69 stored rewards are refused with "Only Twitch redemptions are supported" when a command tries to enable or disable them |
| P4-TW-CHAT | merged (196 tests in the crate). For P4-ACT-CORE: `Sent` and `ChatError` cannot carry Twitch's drop reason, the ids of parts already delivered, or a missing `is_sent`; the reference's AI caller (`message.handler.ts:333`) carries on after a failed part |
| P4-BOT-INGRESS | merged (dima-chat 29 tests, dima-actions 22). Hand-over: the trait `ingress::EventsubHandler` (`handle` after the answer, `revoke` before it), implemented by P4-CHAT-EVENTS and P4-CHAT-MESSAGE. Wanted: an accessor for the EventSub secret in `dima-twitch` (the ingress reads `TWITCH_EVENTSUB_SECRET` itself); a bounded body reader in `dima-web` (its parser reads up to 64 MiB of a refused body). Kept from the reference: chat messages and redemptions are processed at most once; the dead-letter list is in Dragonfly |
| P4-ACT-CORE | merged (67 tests; all 2,217 stored texts match the TypeScript). For later packages: `ChatDelivery::new` returns an `Arc`; the message handler calls `command_handler`, `execute_custom_command`, `deliver_message` and mints authority with `host::effects`; a group function gets `HostCall` and the `DimaHost` accessors; the bot runs `TimerScheduler::tick`; the cutover runs `timers::carry` once. Wanted: an increment by id and a store-backed `KeywordStorage` in `dima-commands` (with P4-CHAT-MESSAGE); an error kind on the engine's `HostError`. Reference bug: `saveResponses` is never set, so responses written with `%(responses[] …)` are never saved (`evaluator.ts:1326`) |
| P4-CHAT-MESSAGE | merged at the pause, after the lead's gate (156 tests with `dima-commands` and both binaries). The worker was stopped before its final report: the order of effects, the limits and the traits for moderation, the AI reply and the built-in commands are in the module docs only; not reviewed. Its rig scenario for the first vertical slice is `rig/scenarios/dimabot-bot/` |
| P4-AI-MEMORY | merged. `MemoryStore::repair` restores a point missing after a failure: the cron calls it per channel with the stream-memory work (P4-CRON-RECAP), the operator CLI offers it (P4-OPS-CLI). Seen in the production copy: 769 confirmed `known_user_fact` memories about the channel itself, which current code would refuse to create; no confirmed viewer fact carries a user id, so viewer-fact recall is always empty |
| P2-CRON-01 | merged (see `packages.md`) |
| P4-MOD-RULES | merged (58 tests; 106,510 recorded verdicts, all 47,955 over the stored settings match). For P4-MOD-RUN: compile through `CompiledSettingsCache::get_or_compile` on the blocking pool (the largest settings take about 6 s in a debug build), implement `SettingsCacheHook`, add the model call `generateMuseVariations`, and decide a limit on what one settings document may compile to (worst case 20 × 32 MiB today; over it, the rule is refused at save time and skipped with telemetry at run time). `parseAdvancedRule` (save-time validation) goes with the settings service. Kept from the reference: the links rule is bypassed by a spaced or bracketed dot, an IP address or a full-width dot |
| P4-ACT-AI-A | **stopped unfinished at the pause.** Branch `t3/rust-ai-openrouter-billing` (local only), commit `2249a38a`: six new files under `crates/actions/src/ai/` (1,571 lines), never compiled as a whole, no tests, no gate |
| P4-FEAT-WIDGETS | merged, all parts (the pure model, `WidgetService`, the widget feed). For later packages: the ingress and event handlers call `FeedPublisher::chat`; realtime sessions use `FeedSubscriptions` and get `Event::Gap` when messages were missed (reset transient displays, refresh state); the cron calls `WidgetService::settle_due` every second; the command host supplies `WidgetPolls`. A failed publish is `PublishResult::Failed` and never fails the chat path |
| P4-FEAT-PETS | **stopped unfinished at the pause.** Branch `t3/port-pet-features` (local only), commit `29260755`: a first cut of `crates/features/src/pets/` with a recorder and a fixture (1,730 lines), not gated |
| P4-FEAT-GAMES | merged (36 tests). Traits for later packages: `ChannelOwners`, `WinnerActionRunner`, `OverlayPresence`, `DuelEvents`, `DuelModeration`, `EditorCheck`, `LegacyTiers`; the cron calls `RouletteService::run_due_actions` every second and `DuelCompletion::tick` every 500 ms (P4-CRON-FEATURES), and the roulette completion worker moves in with P2-CRON-02. Not yet run against the Twitch mock: `TwitchDuelModeration` itself (compared at the wrapper level) |
| P4-API-APP | merged (18 tests in the crate; 175 recorded rows, 8 differ on purpose). The rule for a route package is at the top of `crates/routes/src/state.rs`. For P4-BIN-API: build `AppState`, call `oauth.initialize()`, register services and check `Services::missing`, serve `app::application(...)`; settings `TRUSTED_PROXIES` (address ranges of the reverse proxy; without it the peer address is used and every client behind the proxy shares a rate-limit bucket), `CLIENT_IP_HEADER` (default `x-forwarded-for`), `PUBLIC_DIR`. `browserUser` keeps the reference's fresh validation and OAuth error answers. Wanted in `dima-web`: stop draining a refused body (up to 64 MiB today) |
| P4-SVC-COMMANDS | **stopped at the pause before anything was written**; start it again from its brief |
