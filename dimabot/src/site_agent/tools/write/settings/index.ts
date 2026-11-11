/**
 * Settings write tools, one file per area. Every tool is two-phase: `run` validates and returns an
 * approval proposal with no side effects; `apply` re-reads the area, compare-and-sets against the
 * proposal and saves through the SAME service the page's route uses; `undo` restores only if the
 * changed values still equal what the change wrote.
 *
 * Permissions and plan gates mirror the routes (ALL listed permissions are required; `*` = owner or a
 * full-access admin, exactly like `getChannelAccessContext(..., '*')`):
 *
 * | Tool(s)                                            | Route the page uses                                   | Permission          | Plan gate (enforced by the shared service) |
 * |----------------------------------------------------|-------------------------------------------------------|---------------------|--------------------------------------------|
 * | update_tts_settings                                | PUT /speech/settings/:channelID                       | tts:manage          | none                                       |
 * | update_moderation_settings                         | PUT /moderation/:channelID/settings                   | moderation:manage   | custom confidence, review-all, regex/contextual/variations: Premium+ |
 * | update_follow_defense_settings                     | PATCH /follow-defense/:channelID/settings             | moderation:manage   | none                                       |
 * | update_ai_personality                              | PUT /ai-personality/:channelID                        | ai:manage           | rules 3/5/∞, regulars 3/10/∞ (page limits) |
 * | create_chat_event / update_chat_event / delete_chat_event | POST / PATCH / DELETE /eventsubs/:channelID[/:id] | eventsubs:manage | catalog plan_tier per event; create needs full access (EventSub) |
 * | create_bits_rule / update_bits_rule / delete_bits_rule | POST / PATCH / DELETE /bits-rules/:channelID/rules[/:id] | eventsubs:manage | none (50 rules)                         |
 * | create_goal / update_goal / delete_goal            | POST / PATCH / DELETE /goals/:channelID[/:id] (If-Match) | *                | 2/3/4 goals; Bits goals Premium+           |
 * | create_roulette / update_roulette / add_roulette_items / update_roulette_item / remove_roulette_item | /roulettes/:channelID/... (If-Match) | * | none (20 roulettes, design copy limits) |
 *
 * Never here: ban/timeout/raid/mod/vip, editors/admins, billing, account deletion, bot on/off.
 */
import type { AgentTool } from '../../../types.js';
import { updateTtsSettings } from './tts.js';
import { updateModerationSettings } from './moderation.js';
import { updateFollowDefenseSettingsTool } from './follow_defense.js';
import { updateAiPersonality } from './ai_personality.js';
import { chatEventTools } from './chat_events.js';
import { goalTools } from './goals.js';
import { bitsRuleTools } from './bits_rules.js';
import { rouletteTools } from './roulettes.js';

export const settingsTools: AgentTool[] = [
    updateTtsSettings,
    updateModerationSettings,
    updateFollowDefenseSettingsTool,
    updateAiPersonality,
    ...chatEventTools,
    ...goalTools,
    ...bitsRuleTools,
    ...rouletteTools
] as unknown as AgentTool[];

/** Route permission per tool (tests compare this with each tool and with the route files). */
export const SETTINGS_TOOL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
    update_tts_settings: ['tts:manage'],
    update_moderation_settings: ['moderation:manage'],
    update_follow_defense_settings: ['moderation:manage'],
    update_ai_personality: ['ai:manage'],
    create_chat_event: ['eventsubs:manage'],
    update_chat_event: ['eventsubs:manage'],
    delete_chat_event: ['eventsubs:manage'],
    create_bits_rule: ['eventsubs:manage'],
    update_bits_rule: ['eventsubs:manage'],
    delete_bits_rule: ['eventsubs:manage'],
    create_goal: ['*'],
    update_goal: ['*'],
    delete_goal: ['*'],
    create_roulette: ['*'],
    update_roulette: ['*'],
    add_roulette_items: ['*'],
    update_roulette_item: ['*'],
    remove_roulette_item: ['*']
};
