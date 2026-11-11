import { readFollowDefenseSettings, updateFollowDefenseSettingsIfUnchanged, type FollowDefenseSettingsResponse } from '../../../../server/services/follow_defense_settings.service.js';
import { ToolInputError, type AgentTool, type ChangeProposal, type ToolContext } from '../../../types.js';
import { asObject, bool, int } from '../../util.js';
import { assertUnchanged, changedPaths, channelName, conflict, display, pickPaths, requireSomething, routeMessage, tr, type FieldLabel } from './common.js';

/** Follow Defense (Modules → Follow Defense). Route: PATCH /follow-defense/:channelID/settings (`moderation:manage`). */

export const FOLLOW_DEFENSE_PERMISSIONS = ['moderation:manage'] as const;

const LABELS: Record<string, FieldLabel> = {
    enabled: { en: 'Follow Defense on', es: 'Defensa contra follows activada' },
    silentModeEnabled: { en: 'Silent mode', es: 'Modo silencioso' },
    protectionModeEnabled: { en: 'Protection mode', es: 'Modo protección' },
    attackModeEnabled: { en: 'Attack mode', es: 'Modo ataque' },
    resetAttackOnNewRaid: { en: 'Reset attack on new raid', es: 'Reiniciar ataque con un nuevo raid' },
    silentThresholdX: { en: 'Silent: follows in the window', es: 'Silencioso: follows en la ventana' },
    silentWindowYSeconds: { en: 'Burst window (seconds)', es: 'Ventana de ráfaga (segundos)' },
    protectionThresholdB: { en: 'Protection threshold (follows)', es: 'Umbral de protección (follows)' },
    attackThreshold: { en: 'Attack threshold (empty = dynamic)', es: 'Umbral de ataque (vacío = dinámico)' },
    silentDurationSeconds: { en: 'Mode duration (seconds)', es: 'Duración del modo (segundos)' }
};
const FIELDS = Object.keys(LABELS);

export type FollowDefenseInput = Partial<Pick<FollowDefenseSettingsResponse, 'enabled' | 'silentModeEnabled' | 'protectionModeEnabled' | 'attackModeEnabled'
    | 'resetAttackOnNewRaid' | 'silentThresholdX' | 'silentWindowYSeconds' | 'protectionThresholdB' | 'attackThreshold' | 'silentDurationSeconds'>>;

async function load(ctx: Pick<ToolContext, 'channelId'>) {
    const name = await channelName(ctx.channelId);
    return { name, current: await readFollowDefenseSettings(ctx.channelId, name) };
}

/** Compare-and-set PATCH: writes `values` only while every `expected` field still has its value (checked inside the database write). */
async function write(ctx: Pick<ToolContext, 'channelId' | 'can' | 'lang'>, expected: Record<string, unknown>, values: Record<string, unknown>) {
    const name = await channelName(ctx.channelId);
    const result = await updateFollowDefenseSettingsIfUnchanged(ctx.channelId, name, values, expected, () => ctx.can(['moderation:manage']));
    if (result.ok) return result.settings;
    if ('conflict' in result) {
        assertUnchanged(result.current, expected, ctx.lang, tr(ctx.lang, 'Follow Defense', 'La Defensa contra follows'), LABELS);
        conflict(ctx.lang, 'Follow Defense changed while saving. Nothing was changed; ask again for a fresh proposal.',
            'La Defensa contra follows cambió mientras se guardaba. No se cambió nada; vuelve a pedirlo para preparar uno nuevo.');
    }
    throw new Error(routeMessage(result.body, 'Could not save Follow Defense settings'));
}

export const updateFollowDefenseSettingsTool: AgentTool<FollowDefenseInput> = {
    name: 'update_follow_defense_settings',
    kind: 'write',
    permissions: FOLLOW_DEFENSE_PERMISSIONS,
    description: [
        'Change Follow Defense (Modules → Follow Defense), which watches for bursts of follows from follow bots or hate raids.',
        'Modes: Silent starts at silentThresholdX follows within silentWindowYSeconds (default 10 in 5 s) and pauses follow alerts while tracking the wave;',
        'Protection starts at protectionThresholdB follows (default 100), keeps alerts paused and warns chat; Attack PERMANENTLY BANS everyone tracked in the wave and each new follow while active.',
        'attackThreshold: a positive number, or null for dynamic sensitivity (learned from 30 days of follows, never below 500; automatic Attack waits for enough history).',
        'silentDurationSeconds: how long a mode stays on after the last burst (default 60). resetAttackOnNewRaid: a new raid turns an active Attack into Protection (default on).',
        'enabled turns the whole feature on/off; turning off the feature, Attack or Protection also cancels pending defense actions. Only send fields that change.',
        'The user approves first; it can be undone. Recommend keeping defaults unless the user has a reason, and be careful with Attack: bans are permanent.'
    ].join(' '),
    parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
            enabled: { type: 'boolean' },
            silentModeEnabled: { type: 'boolean' },
            protectionModeEnabled: { type: 'boolean' },
            attackModeEnabled: { type: 'boolean' },
            resetAttackOnNewRaid: { type: 'boolean' },
            silentThresholdX: { type: 'integer', minimum: 1, maximum: 100000 },
            silentWindowYSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
            protectionThresholdB: { type: 'integer', minimum: 1, maximum: 1000000 },
            attackThreshold: { type: ['integer', 'null'], minimum: 1, maximum: 1000000 },
            silentDurationSeconds: { type: 'integer', minimum: 1, maximum: 86400 }
        }
    },
    label: (_input, lang) => tr(lang, 'Preparing Follow Defense changes…', 'Preparando cambios de la Defensa contra follows…'),
    validate(raw) {
        const input = asObject(raw);
        const value: FollowDefenseInput = {
            enabled: bool(input, 'enabled'),
            silentModeEnabled: bool(input, 'silentModeEnabled'),
            protectionModeEnabled: bool(input, 'protectionModeEnabled'),
            attackModeEnabled: bool(input, 'attackModeEnabled'),
            resetAttackOnNewRaid: bool(input, 'resetAttackOnNewRaid'),
            silentThresholdX: int(input, 'silentThresholdX', { min: 1, max: 100000 }),
            silentWindowYSeconds: int(input, 'silentWindowYSeconds', { min: 1, max: 3600 }),
            protectionThresholdB: int(input, 'protectionThresholdB', { min: 1, max: 1000000 }),
            silentDurationSeconds: int(input, 'silentDurationSeconds', { min: 1, max: 86400 })
        };
        if (Object.hasOwn(input, 'attackThreshold')) {
            if (input.attackThreshold === null) value.attackThreshold = null;
            else {
                const threshold = int(input, 'attackThreshold', { min: 1, max: 1000000 });
                if (threshold === undefined) throw new ToolInputError('attackThreshold must be a positive integer or null for dynamic sensitivity');
                value.attackThreshold = threshold;
            }
        }
        requireSomething(value, 'Follow Defense setting');
        return value;
    },
    async run(input, ctx) {
        const { current } = await load(ctx);
        const wanted = Object.fromEntries(Object.entries(input).filter(([key, value]) => FIELDS.includes(key) && value !== undefined));
        const paths = changedPaths(current, wanted);
        if (!paths.length) return { type: 'result', result: { unchanged: true, message: 'Follow Defense already has those values. Nothing to change.' }, summary: tr(ctx.lang, 'Already set', 'Ya estaba así') };
        const after = Object.fromEntries(paths.map((path) => [path, wanted[path]]));
        const before = pickPaths(current, paths);
        const warnings: string[] = [];
        if (after.enabled === false || after.attackModeEnabled === false || after.protectionModeEnabled === false) {
            warnings.push(tr(ctx.lang, 'Pending Follow Defense actions (queued bans) are cancelled.', 'Se cancelan las acciones pendientes de la Defensa contra follows (bans en cola).'));
        }
        const attackOn = (after.attackModeEnabled ?? current.attackModeEnabled) && (after.enabled ?? current.enabled);
        if (attackOn && (after.attackModeEnabled === true || after.enabled === true || 'attackThreshold' in after || after.resetAttackOnNewRaid === false)) {
            warnings.push(tr(ctx.lang, 'Attack mode bans tracked followers permanently (not timeouts).', 'El modo ataque banea de forma permanente a los follows rastreados (no son timeouts).'));
        }
        const proposal: ChangeProposal = {
            tool: 'update_follow_defense_settings',
            title: tr(ctx.lang, 'Change Follow Defense settings', 'Cambiar la Defensa contra follows'),
            area: 'follow_defense',
            target: { type: 'follow_defense_settings', id: ctx.channelId, label: tr(ctx.lang, 'Follow Defense', 'Defensa contra follows') },
            before: display(before, LABELS, ctx.lang),
            after: display(after, LABELS, ctx.lang),
            effects: attackOn ? [tr(ctx.lang, 'Can ban followers automatically during an attack', 'Puede banear follows automáticamente durante un ataque')] : [],
            warnings,
            permissions: [...FOLLOW_DEFENSE_PERMISSIONS],
            payload: { before, after, expected: before }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { before, after, expected } = proposal.payload as { before: Record<string, unknown>; after: Record<string, unknown>; expected: Record<string, unknown> };
        // Quick check first so a stale proposal never creates the defaults or reaches the save.
        const { current } = await load(ctx);
        assertUnchanged(current, expected, ctx.lang, tr(ctx.lang, 'Follow Defense', 'La Defensa contra follows'), LABELS);
        const settings = await write(ctx, expected, after);
        return {
            result: { saved: true, settings: pickPaths(settings, Object.keys(after)) },
            change: { area: 'follow_defense', target: proposal.target, before: proposal.before, after: proposal.after, undo: { before, after }, summary: proposal.title }
        };
    },
    async undo(change, ctx) {
        const data = change.undo as { before: Record<string, unknown>; after: Record<string, unknown> };
        const { current } = await load(ctx);
        assertUnchanged(current, data.after, ctx.lang, tr(ctx.lang, 'Follow Defense', 'La Defensa contra follows'), LABELS);
        await write(ctx, data.after, data.before);
    }
};
