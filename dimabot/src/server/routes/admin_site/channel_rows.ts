import { permissionModeFor } from '../../services/command_mutations.service.js';
import { normalizeEventsubResponseType } from '../../services/eventsub_config.service.js';
import { BUILT_IN_FUNCS, runsBuiltInCode } from '../../../site_agent/tools/read.js';

/**
 * How the owner console sees a channel's commands and Twitch event subscriptions. Shared by the lists in
 * `admin_site.route.ts` and the owner edit routes in `channel_edit.route.ts`, so a save returns the same row.
 */

/** Fields to load for `commandRow` (blocks are `select: false` on the schema). */
export const COMMAND_ROW_FIELDS = '_id name cmd func message enabled cooldown cooldownOverride userLevelName userLevel createdAt activation keywordSettings reserved authoring permissionExpression description channel +blocks';

/** Function names whose built-in code runs instead of a stored reply (for the console's "Runs" field). */
export const BUILT_IN_ACTIONS = [...BUILT_IN_FUNCS].sort();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function commandRow(row: any) {
    const permissionMode = permissionModeFor(row);
    const authoring = row.authoring === 'blocks' ? 'blocks' : 'text';
    return {
        id: String(row._id),
        name: row.name || '',
        cmd: row.cmd || '',
        func: row.func || '',
        message: row.message || '',
        enabled: Boolean(row.enabled),
        cooldown: Number(row.cooldown || 0),
        // Set by the owner console: chat uses the cooldown as stored (below a keyword's plan minimum too).
        cooldownOverride: Boolean(row.cooldownOverride),
        userLevelName: row.userLevelName || '',
        userLevel: Number(row.userLevel || 1),
        activation: row.activation === 'keyword' ? 'keyword' : 'command',
        keywordMatch: row.activation === 'keyword' ? (row.keywordSettings?.matchMode ?? 'start') : null,
        reserved: Boolean(row.reserved),
        authoring,
        permissionMode,
        // The bot runs its own code for it (e.g. !promo), so its stored reply is never posted.
        runsBuiltIn: runsBuiltInCode(row),
        // What the owner edits as JSON: the block tree of a block command and a custom permission rule.
        blocks: authoring === 'blocks' ? row.blocks ?? null : null,
        permissionExpression: permissionMode === 'level' ? null : row.permissionExpression ?? null,
        description: row.description || '',
        channel: row.channel || '',
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : undefined
    };
}

/** Stored chat settings of a subscription, by their database names (every config field the schema has). */
export const EVENTSUB_SETTING_TYPES = {
    message: 'string',
    endMessage: 'string',
    endEnabled: 'boolean',
    minViewers: 'number',
    clipEnabled: 'boolean',
    delay: 'number',
    modiversaryMessage: 'string',
    modiversaryEnabled: 'boolean',
    watchStreakEnabled: 'boolean',
    temporalBanMessage: 'string',
    todayFollows: 'boolean',
} as const;
export type EventsubSettingKey = keyof typeof EVENTSUB_SETTING_TYPES;

export const EVENTSUB_ROW_FIELDS = '_id type status version enabled message endMessage endEnabled minViewers clipEnabled delay modiversaryMessage modiversaryEnabled watchStreakEnabled temporalBanMessage todayFollows cheerTiers condition remote_missing_since created_at';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function eventsubRow(row: any) {
    return {
        id: String(row._id),
        // The site's name for it: outgoing raids are `channel.raid.outgoing`, legacy cheers `channel.bits.use`.
        type: normalizeEventsubResponseType({ type: row.type || '', condition: row.condition }).type,
        rawType: row.type || '',
        status: row.status || '',
        version: row.version || '',
        enabled: Boolean(row.enabled),
        message: row.message || '',
        endMessage: row.endMessage || '',
        settings: {
            message: row.message ?? '',
            endMessage: row.endMessage ?? '',
            endEnabled: Boolean(row.endEnabled),
            minViewers: Number(row.minViewers ?? 2),
            clipEnabled: Boolean(row.clipEnabled),
            delay: Number(row.delay ?? 0),
            modiversaryMessage: row.modiversaryMessage ?? '',
            modiversaryEnabled: row.modiversaryEnabled !== false,
            watchStreakEnabled: row.watchStreakEnabled !== false,
            temporalBanMessage: row.temporalBanMessage ?? '',
            todayFollows: Boolean(row.todayFollows)
        },
        cheerTierCount: Array.isArray(row.cheerTiers) ? row.cheerTiers.length : 0,
        remoteMissingSince: row.remote_missing_since ? new Date(row.remote_missing_since).toISOString() : null,
        created_at: row.created_at || ''
    };
}
