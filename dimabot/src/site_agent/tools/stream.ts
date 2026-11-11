import { getChannelInformation, setChannelInformation } from '../../functions/channels/index.js';
import { createPoll } from '../../functions/polls/index.js';
import { createPrediction } from '../../functions/predictions/index.js';
import { searchCategories } from '../../functions/search/index.js';
import { sampleEvent } from '../../overlays/ast.js';
import { bitsRuleFor, publishStudioAlert } from '../../overlays/live.js';
import { ALERT_EVENTS, type AlertEvent } from '../../overlays/model.js';
import { requireOverlayAccount } from '../../overlays/store.js';
import { RedemptionRewardSchema } from '../../schemas/redemption_reward.schema.js';
import { cleanupRewardArtifacts, createRewardWithEventsub, patchTwitchReward } from '../../server/services/reward_creation.service.js';
import { getTwitchStreamerHeaderById } from '../../utils/header.js';
import { getTwitchHelixUrl } from '../../utils/links.js';
import { isTwitchOnlyRewardUpdate, MAX_GLOBAL_COOLDOWN_SECONDS, validateRewardSettings } from '../../utils/twitch_reward_body.util.js';
import { ToolInputError, type AgentTool, type ChangeProposal, type ChangeRecordInput, type Lang } from '../types.js';
import { asObject, bool, int, oneOf, str } from './util.js';
import { assertUnchanged, bodyEffects, conflict, hasFullAccess, needsFullAccessResult, requireChannelOwner, sameValue, stringList, tr } from './write/settings/common.js';

/**
 * Stream-visible and Twitch actions. Each needs approval every time, says that it happens live, and
 * says whether it can be undone (title/category, polls, predictions and test alerts cannot).
 *
 * | Tool                      | Mirrors                                              | Permission         | Also needs |
 * |---------------------------|------------------------------------------------------|--------------------|------------|
 * | send_test_alert           | POST /overlay-studio/:channelID/test-alert (owner)   | owner (exact)      | an open published overlay with the alert |
 * | set_stream_info           | AST set.title / set.game (Helix PATCH channels)      | *                  | full access |
 * | create_poll               | AST start.poll (Helix polls)                         | *                  | full access |
 * | create_prediction         | AST start.prediction (Helix predictions)             | *                  | full access |
 * | create_reward             | POST /rewards/:channelID                             | rewards:manage     | full access |
 * | update_reward             | PATCH /rewards/:channelID/:id                        | rewards:manage     | full access |
 */

export const STREAM_TOOL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
    send_test_alert: ['owner'],
    set_stream_info: ['*'],
    create_poll: ['*'],
    create_prediction: ['*'],
    create_reward: ['rewards:manage'],
    update_reward: ['rewards:manage']
};

const LIVE = (lang: Lang) => tr(lang, 'Happens live on Twitch right away.', 'Pasa en vivo en Twitch de inmediato.');
const NO_UNDO = (lang: Lang) => tr(lang, 'This cannot be undone from the change log.', 'Esto no se puede deshacer desde el historial de cambios.');

function change(proposal: ChangeProposal, undo: Record<string, unknown> | null, after = proposal.after): ChangeRecordInput {
    return { area: proposal.area, target: proposal.target, before: proposal.before, after, undo, summary: proposal.title };
}

// --- Test alert ---------------------------------------------------------------------------------

export interface TestAlertInput { kind: AlertEvent; user?: string; amount?: number; tier?: '1000' | '2000' | '3000' }

/** The sample event the Studio's test button sends (same defaults as the route). */
export function testAlertEvent(input: TestAlertInput): Record<string, unknown> {
    const user = input.user?.trim() ? input.user.trim().slice(0, 80) : 'Luna';
    const amount = Number.isSafeInteger(input.amount) && input.amount! > 0 ? Math.min(1000000000, input.amount!) : 100;
    return sampleEvent(input.kind, user, amount, input.tier ?? '1000');
}

const ALERT_NAMES: Record<AlertEvent, { en: string; es: string }> = {
    sub: { en: 'sub', es: 'sub' }, bits: { en: 'Bits', es: 'Bits' }, follow: { en: 'follow', es: 'follow' }, raid: { en: 'raid', es: 'raid' }
};

export const sendTestAlert: AgentTool<TestAlertInput> = {
    name: 'send_test_alert',
    kind: 'stream',
    permissions: STREAM_TOOL_PERMISSIONS.send_test_alert,
    description: 'Play a test alert (Overlay Studio "Test" button) in the channel\'s published OBS browser sources that have that alert: kind sub, bits, follow or raid, with an optional sample viewer name (default Luna), amount (Bits, months or raid viewers; default 100) and sub tier. IT SHOWS ON STREAM to viewers right away and cannot be undone. Only the channel owner. A Bits rule with alerts off plays nothing for that amount.',
    parameters: {
        type: 'object', additionalProperties: false, required: ['kind'],
        properties: {
            kind: { type: 'string', enum: [...ALERT_EVENTS] }, user: { type: 'string', maxLength: 80 },
            amount: { type: 'integer', minimum: 1, maximum: 1000000000 }, tier: { type: 'string', enum: ['1000', '2000', '3000'] }
        }
    },
    label: (_input, lang) => tr(lang, 'Preparing a test alert…', 'Preparando una alerta de prueba…'),
    validate(raw) {
        const input = asObject(raw);
        return {
            kind: oneOf(input, 'kind', ALERT_EVENTS, { required: true })!,
            user: str(input, 'user', { max: 80 }),
            amount: int(input, 'amount', { min: 1, max: 1000000000 }),
            tier: oneOf(input, 'tier', ['1000', '2000', '3000'] as const)
        };
    },
    async run(input, ctx) {
        requireChannelOwner(ctx);
        const raw = testAlertEvent(input);
        const rule = await bitsRuleFor(ctx.channelId, input.kind, raw);
        if (rule?.alert === false) throw new ToolInputError(`No alert plays for ${raw.bits} Bits: the "${rule.name || 'matching'}" Bits rule has alerts turned off`);
        const proposal: ChangeProposal = {
            tool: 'send_test_alert',
            title: tr(ctx.lang, `Play a test ${ALERT_NAMES[input.kind].en} alert on stream`, `Reproducir una alerta de prueba de ${ALERT_NAMES[input.kind].es} en el stream`),
            area: 'stream',
            target: { type: 'overlay_alert', id: input.kind, label: tr(ctx.lang, 'Overlay alerts', 'Alertas del overlay') },
            before: null,
            after: { alert: input.kind, viewer: raw.user_name, ...(input.kind === 'sub' ? { tier: raw.tier, months: raw.cumulative_months } : input.kind === 'bits' ? { bits: raw.bits } : input.kind === 'raid' ? { viewers: raw.viewers } : {}) },
            effects: [tr(ctx.lang, 'Plays an alert in every open OBS browser source with this alert, visible to viewers', 'Reproduce una alerta en cada fuente de navegador de OBS abierta con esta alerta, visible para los espectadores')],
            warnings: [LIVE(ctx.lang), NO_UNDO(ctx.lang)],
            permissions: [...STREAM_TOOL_PERMISSIONS.send_test_alert],
            payload: { input }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        requireChannelOwner(ctx);
        const { input } = proposal.payload as { input: TestAlertInput };
        await requireOverlayAccount(ctx.channelId);
        const raw = testAlertEvent(input);
        const rule = await bitsRuleFor(ctx.channelId, input.kind, raw);
        if (rule?.alert === false) throw new Error(`No alert plays for ${raw.bits} Bits: the "${rule.name || 'matching'}" Bits rule has alerts turned off`);
        const clients = await publishStudioAlert(ctx.channelId, input.kind, raw, undefined, undefined, 'other');
        if (!clients) throw new Error('Open a published browser source with this alert enabled first');
        return { result: { sent: true, clients }, change: change(proposal, null) };
    }
};

// --- Title and category ----------------------------------------------------------------------------

export interface StreamInfoInput { title?: string; category?: string }

export const setStreamInfo: AgentTool<StreamInfoInput> = {
    name: 'set_stream_info',
    kind: 'stream',
    permissions: STREAM_TOOL_PERMISSIONS.set_stream_info,
    description: 'Change the live stream title and/or category on Twitch (like $(set.title) / $(set.game)). category is searched on Twitch and the best match is shown on the approval card. Viewers see it right away; it cannot be undone from the change log (set it again instead). Needs full access.',
    parameters: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', maxLength: 140 }, category: { type: 'string', maxLength: 100 } } },
    label: (_input, lang) => tr(lang, 'Preparing the stream info…', 'Preparando la información del stream…'),
    validate(raw) {
        const input = asObject(raw);
        const value = { title: str(input, 'title', { max: 140 }), category: str(input, 'category', { max: 100 }) };
        if (!value.title && !value.category) throw new ToolInputError('Give a title and/or a category');
        return value;
    },
    async run(input, ctx) {
        if (!await hasFullAccess(ctx.channelId)) return needsFullAccessResult(ctx.lang);
        let category: { id: string; name: string } | null = null;
        if (input.category) {
            const found = await searchCategories(input.category);
            if (found.error || !found.data?.length) throw new ToolInputError(`No Twitch category found for "${input.category}"`);
            category = found.data.find((item) => item.name.toLowerCase() === input.category!.toLowerCase()) ?? found.data[0];
        }
        const info = await getChannelInformation(ctx.channelId);
        const current = info.error ? null : info.data as { title?: string; game_name?: string } | undefined;
        const after: Record<string, unknown> = { ...(input.title ? { title: input.title } : {}), ...(category ? { category: category.name } : {}) };
        const before: Record<string, unknown> | null = current ? { ...(input.title ? { title: current.title ?? '' } : {}), ...(category ? { category: current.game_name ?? '' } : {}) } : null;
        const proposal: ChangeProposal = {
            tool: 'set_stream_info',
            title: tr(ctx.lang, 'Change the stream title/category', 'Cambiar el título/categoría del stream'),
            area: 'stream',
            target: { type: 'twitch_channel', id: ctx.channelId, label: tr(ctx.lang, 'Twitch stream info', 'Información del stream en Twitch') },
            before, after,
            effects: [tr(ctx.lang, 'Updates the channel on Twitch', 'Actualiza el canal en Twitch')],
            warnings: [LIVE(ctx.lang), NO_UNDO(ctx.lang)],
            permissions: [...STREAM_TOOL_PERMISSIONS.set_stream_info],
            payload: { title: input.title ?? null, gameId: category?.id ?? null }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { title, gameId } = proposal.payload as { title: string | null; gameId: string | null };
        const result = await setChannelInformation(ctx.channelId, { ...(title ? { title } : {}), ...(gameId ? { game_id: gameId } : {}) });
        if (result.error) throw new Error(result.status === 403 ? 'Needs full access: activate the bot on Twitch first' : result.message || 'Twitch rejected the change');
        return { result: { saved: true }, change: change(proposal, null) };
    }
};

// --- Poll and prediction ---------------------------------------------------------------------------

export interface PollInput { title: string; choices: string[]; durationSeconds: number; channelPointsPerVote?: number }

export const createPollTool: AgentTool<PollInput> = {
    name: 'create_poll',
    kind: 'stream',
    permissions: STREAM_TOOL_PERMISSIONS.create_poll,
    description: 'Start a native Twitch poll now (like $(start.poll)): title up to 60 characters, 2–5 choices up to 25 characters each, durationSeconds 15–1800, optional channelPointsPerVote (1–1000000 enables extra votes paid with Channel Points; omit for one free vote). Viewers see it right away; it cannot be undone (end it on Twitch). Needs full access and only one poll can run at a time.',
    parameters: {
        type: 'object', additionalProperties: false, required: ['title', 'choices', 'durationSeconds'],
        properties: {
            title: { type: 'string', maxLength: 60 }, choices: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string', maxLength: 25 } },
            durationSeconds: { type: 'integer', minimum: 15, maximum: 1800 }, channelPointsPerVote: { type: 'integer', minimum: 0, maximum: 1000000 }
        }
    },
    label: (_input, lang) => tr(lang, 'Preparing the poll…', 'Preparando la encuesta…'),
    validate(raw) {
        const input = asObject(raw);
        const choices = stringList(input, 'choices', { required: true, max: 5, maxLength: 25 })!;
        if (choices.length < 2) throw new ToolInputError('A poll needs 2–5 choices');
        return {
            title: str(input, 'title', { required: true, max: 60 })!, choices,
            durationSeconds: int(input, 'durationSeconds', { required: true, min: 15, max: 1800 })!,
            channelPointsPerVote: int(input, 'channelPointsPerVote', { min: 0, max: 1000000 })
        };
    },
    async run(input, ctx) {
        if (!await hasFullAccess(ctx.channelId)) return needsFullAccessResult(ctx.lang);
        const proposal: ChangeProposal = {
            tool: 'create_poll',
            title: tr(ctx.lang, `Start the poll "${input.title}"`, `Iniciar la encuesta "${input.title}"`),
            area: 'stream',
            target: { type: 'twitch_poll', id: null, label: input.title },
            before: null,
            after: { title: input.title, choices: input.choices, seconds: input.durationSeconds, ...(input.channelPointsPerVote ? { channelPointsPerVote: input.channelPointsPerVote } : {}) },
            effects: [tr(ctx.lang, 'Starts a poll on Twitch for viewers', 'Inicia una encuesta en Twitch para los espectadores')],
            warnings: [LIVE(ctx.lang), NO_UNDO(ctx.lang)],
            permissions: [...STREAM_TOOL_PERMISSIONS.create_poll],
            payload: { input }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { input } = proposal.payload as { input: PollInput };
        const result = await createPoll(ctx.channelId, input.title, input.choices.map((title) => ({ title })), input.durationSeconds, false, input.channelPointsPerVote ?? 0);
        if (result.error) throw new Error(result.message || 'Twitch rejected the poll');
        return { result: { started: true, id: result.id ?? null }, change: change(proposal, null) };
    }
};

export interface PredictionInput { title: string; outcomes: string[]; windowSeconds: number }

export const createPredictionTool: AgentTool<PredictionInput> = {
    name: 'create_prediction',
    kind: 'stream',
    permissions: STREAM_TOOL_PERMISSIONS.create_prediction,
    description: 'Start a Channel Points prediction now (like $(start.prediction)): title up to 45 characters, 2–10 outcomes up to 25 characters each, windowSeconds 30–1800 for viewers to bet. Viewers see it right away; it cannot be undone here (resolve or cancel it on Twitch or with chat commands). Needs full access; only one prediction can run at a time.',
    parameters: {
        type: 'object', additionalProperties: false, required: ['title', 'outcomes', 'windowSeconds'],
        properties: {
            title: { type: 'string', maxLength: 45 }, outcomes: { type: 'array', minItems: 2, maxItems: 10, items: { type: 'string', maxLength: 25 } },
            windowSeconds: { type: 'integer', minimum: 30, maximum: 1800 }
        }
    },
    label: (_input, lang) => tr(lang, 'Preparing the prediction…', 'Preparando la predicción…'),
    validate(raw) {
        const input = asObject(raw);
        const outcomes = stringList(input, 'outcomes', { required: true, max: 10, maxLength: 25 })!;
        if (outcomes.length < 2) throw new ToolInputError('A prediction needs 2–10 outcomes');
        return { title: str(input, 'title', { required: true, max: 45 })!, outcomes, windowSeconds: int(input, 'windowSeconds', { required: true, min: 30, max: 1800 })! };
    },
    async run(input, ctx) {
        if (!await hasFullAccess(ctx.channelId)) return needsFullAccessResult(ctx.lang);
        const proposal: ChangeProposal = {
            tool: 'create_prediction',
            title: tr(ctx.lang, `Start the prediction "${input.title}"`, `Iniciar la predicción "${input.title}"`),
            area: 'stream',
            target: { type: 'twitch_prediction', id: null, label: input.title },
            before: null,
            after: { title: input.title, outcomes: input.outcomes, seconds: input.windowSeconds },
            effects: [tr(ctx.lang, 'Starts a Channel Points prediction on Twitch', 'Inicia una predicción con puntos del canal en Twitch')],
            warnings: [LIVE(ctx.lang), NO_UNDO(ctx.lang)],
            permissions: [...STREAM_TOOL_PERMISSIONS.create_prediction],
            payload: { input }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { input } = proposal.payload as { input: PredictionInput };
        const result = await createPrediction(ctx.channelId, input.title, input.outcomes.map((title) => ({ title })), input.windowSeconds);
        if (result.error) throw new Error(result.message || 'Twitch rejected the prediction');
        return { result: { started: true, id: result.id ?? null }, change: change(proposal, null) };
    }
};

// --- Channel point rewards -------------------------------------------------------------------------

const REWARD_FIELDS = ['title', 'prompt', 'cost', 'isEnabled', 'isPaused', 'cooldown', 'maxPerStream', 'maxPerUserPerStream', 'userInput', 'skipQueue', 'background_color', 'message'] as const;
type RewardField = typeof REWARD_FIELDS[number];
export type RewardValues = Partial<Record<RewardField, string | number | boolean>>;

function rewardFields(input: Record<string, unknown>, create: boolean): RewardValues {
    const color = str(input, 'backgroundColor', { max: 7 });
    if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(color)) throw new ToolInputError('backgroundColor must be a hex color like #9147FF');
    const values: RewardValues = {
        title: str(input, 'title', { required: create, max: 45 }),
        prompt: str(input, 'prompt', { max: 200 }),
        cost: int(input, 'cost', { required: create, min: 1, max: 2_147_483_647 }),
        isEnabled: bool(input, 'isEnabled'),
        isPaused: create ? undefined : bool(input, 'isPaused'),
        cooldown: int(input, 'cooldown', { min: 0, max: MAX_GLOBAL_COOLDOWN_SECONDS }),
        maxPerStream: int(input, 'maxPerStream', { min: 0, max: 1_000_000 }),
        maxPerUserPerStream: int(input, 'maxPerUserPerStream', { min: 0, max: 1_000_000 }),
        userInput: bool(input, 'userInput'),
        skipQueue: bool(input, 'skipQueue'),
        background_color: color,
        message: str(input, 'message', { max: 500 })
    };
    const clean = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as RewardValues;
    const settingsError = validateRewardSettings(clean as Record<string, unknown>);
    if (settingsError) throw new ToolInputError(settingsError);
    return clean;
}

const rewardSchema = {
    title: { type: 'string', maxLength: 45 }, prompt: { type: 'string', maxLength: 200, description: 'Description viewers see' },
    cost: { type: 'integer', minimum: 1, description: 'Channel Points' }, isEnabled: { type: 'boolean' },
    cooldown: { type: 'integer', minimum: 0, maximum: MAX_GLOBAL_COOLDOWN_SECONDS, description: 'Seconds between redeems, 0 = none' },
    maxPerStream: { type: 'integer', minimum: 0, description: '0 = no limit' }, maxPerUserPerStream: { type: 'integer', minimum: 0, description: '0 = no limit' },
    userInput: { type: 'boolean', description: 'Viewer must type something' }, skipQueue: { type: 'boolean', description: 'Skip the Twitch request queue' },
    backgroundColor: { type: 'string', description: 'Hex color like #9147FF' },
    message: { type: 'string', maxLength: 500, description: 'What the bot does/says when it is redeemed (can use $(...) functions)' }
};

/** Twitch's live copy of one reward, in our field names (Twitch is the source of truth for limits and pause). */
async function readTwitchReward(channelId: string, rewardId: string): Promise<RewardValues | null> {
    const header = await getTwitchStreamerHeaderById(channelId);
    if (header.error || !header.header) throw new Error('Needs full access: activate the bot on Twitch first');
    const params = new URLSearchParams({ broadcaster_id: channelId, id: rewardId });
    const response = await fetch(getTwitchHelixUrl('channel_points/custom_rewards', params.toString()), { headers: header.header as unknown as Record<string, string> });
    const data = await response.json() as { data?: Array<Record<string, any>>; error?: string };
    if (data.error) throw new Error(`Could not read the reward from Twitch: ${data.error}`);
    const reward = data.data?.[0];
    if (!reward) return null;
    return {
        title: reward.title, prompt: reward.prompt ?? '', cost: reward.cost, isEnabled: reward.is_enabled, isPaused: !!reward.is_paused,
        cooldown: reward.global_cooldown_setting?.is_global_cooldown_enabled || reward.global_cooldown_setting?.is_enabled ? reward.global_cooldown_setting.global_cooldown_seconds : 0,
        maxPerStream: reward.max_per_stream_setting?.is_enabled ? reward.max_per_stream_setting.max_per_stream : 0,
        maxPerUserPerStream: reward.max_per_user_per_stream_setting?.is_enabled ? reward.max_per_user_per_stream_setting.max_per_user_per_stream : 0,
        userInput: !!reward.is_user_input_required, skipQueue: !!reward.should_redemptions_skip_request_queue, background_color: reward.background_color
    };
}

async function currentReward(channelId: string, rewardId: string): Promise<RewardValues | null> {
    const stored = await RedemptionRewardSchema.findOne({ channelID: channelId, rewardID: rewardId }).lean();
    if (!stored) return null;
    const twitch = await readTwitchReward(channelId, rewardId);
    return twitch ? { ...twitch, message: stored.message ?? '' } : null;
}

/** The PATCH route's logic: Twitch first, then our copy unless only Twitch-side settings changed. */
async function patchReward(channelId: string, rewardId: string, values: RewardValues): Promise<void> {
    const body = { ...values } as Record<string, any>;
    const settingsError = validateRewardSettings(body);
    if (settingsError) throw new Error(settingsError);
    const updated = await patchTwitchReward(channelId, body, rewardId);
    if (!updated || updated.error) throw new Error(updated?.message || updated?.error || 'Twitch rejected the reward update');
    if (!isTwitchOnlyRewardUpdate(body)) await RedemptionRewardSchema.findOneAndUpdate({ channelID: channelId, rewardID: rewardId }, body, { new: true });
}

async function resolveReward(channelId: string, reference: string) {
    const rewards = await RedemptionRewardSchema.find({ channelID: channelId }).lean();
    return rewards.find((reward) => reward.rewardID === reference) ?? rewards.find((reward) => reward.title.toLowerCase() === reference.toLowerCase()) ?? null;
}

const rewardView = (values: RewardValues) => Object.fromEntries(REWARD_FIELDS.filter((key) => values[key] !== undefined).map((key) => [key === 'background_color' ? 'backgroundColor' : key, values[key]]));

export interface CreateRewardInput { values: RewardValues }

export const createReward: AgentTool<CreateRewardInput> = {
    name: 'create_reward',
    kind: 'stream',
    permissions: STREAM_TOOL_PERMISSIONS.create_reward,
    description: 'Create a channel point reward on Twitch (Modules → Channel point rewards): title (≤45), cost in Channel Points, optional prompt, cooldown, limits per stream / per viewer, viewer input, skip the request queue, color, and message (what the bot does or says when it is redeemed). Viewers can see and redeem it right away. Needs full access. The user approves first; undo deletes the reward.',
    parameters: { type: 'object', additionalProperties: false, required: ['title', 'cost'], properties: rewardSchema },
    label: (_input, lang) => tr(lang, 'Preparing the reward…', 'Preparando la recompensa…'),
    validate: (raw) => ({ values: rewardFields(asObject(raw), true) }),
    async run(input, ctx) {
        if (!await hasFullAccess(ctx.channelId)) return needsFullAccessResult(ctx.lang);
        const effects = await bodyEffects(input.values.message as string | undefined, ctx, tr(ctx.lang, 'When redeemed', 'Al canjearse'));
        const proposal: ChangeProposal = {
            tool: 'create_reward',
            title: tr(ctx.lang, `Create the reward "${input.values.title}"`, `Crear la recompensa "${input.values.title}"`),
            area: 'rewards',
            target: { type: 'reward', id: null, label: String(input.values.title) },
            before: null,
            after: rewardView({ isEnabled: true, ...input.values }),
            effects: [tr(ctx.lang, 'Creates a channel point reward on Twitch that viewers can redeem', 'Crea una recompensa de puntos del canal en Twitch que los espectadores pueden canjear'), ...effects.effects],
            warnings: [LIVE(ctx.lang), ...effects.warnings],
            permissions: [...STREAM_TOOL_PERMISSIONS.create_reward],
            payload: { body: { type: 'custom', isEnabled: true, ...input.values } }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { body } = proposal.payload as { body: Record<string, any> };
        const result = await createRewardWithEventsub({ channelID: ctx.channelId, body, correlationId: `site-agent-${ctx.turnId}-${ctx.callId}` });
        if (result.error || !result.data) throw new Error(result.message);
        const created = result.data;
        return {
            result: { created: true, rewardId: created.rewardID },
            change: change({ ...proposal, target: { ...proposal.target, id: created.rewardID } }, { rewardId: created.rewardID, eventsubId: created.eventsubID, title: created.title, cost: created.cost })
        };
    },
    async undo(record, ctx) {
        const data = record.undo as { rewardId: string; eventsubId: string; title: string; cost: number };
        const stored = await RedemptionRewardSchema.findOne({ channelID: ctx.channelId, rewardID: data.rewardId }).lean();
        if (!stored) conflict(ctx.lang, 'This reward was already deleted.', 'Esta recompensa ya se eliminó.');
        if (stored.title !== data.title || stored.cost !== data.cost) conflict(ctx.lang, 'This reward was edited after it was created, so it was not deleted.', 'Esta recompensa se editó después de crearse; no se eliminó.');
        await cleanupRewardArtifacts(ctx.channelId, data.rewardId, data.eventsubId);
        if (await RedemptionRewardSchema.exists({ channelID: ctx.channelId, rewardID: data.rewardId })) throw new Error('Could not delete the reward');
    }
};

export interface UpdateRewardInput { reward: string; values: RewardValues }

export const updateReward: AgentTool<UpdateRewardInput> = {
    name: 'update_reward',
    kind: 'stream',
    permissions: STREAM_TOOL_PERMISSIONS.update_reward,
    description: 'Change a channel point reward made with DomDimaBot (Modules → Channel point rewards): reward = its id or exact title; title, prompt, cost, isEnabled (shown to viewers), isPaused (visible but cannot be redeemed), cooldown, limits per stream / per viewer, viewer input, skip queue, color, message (what the bot does when it is redeemed). Viewers see changes right away. Needs full access. The user approves first; it can be undone.',
    parameters: { type: 'object', additionalProperties: false, required: ['reward'], properties: { reward: { type: 'string', description: 'Reward id or exact title' }, ...rewardSchema, isPaused: { type: 'boolean' } } },
    label: (_input, lang) => tr(lang, 'Preparing the reward change…', 'Preparando el cambio de la recompensa…'),
    validate(raw) {
        const input = asObject(raw);
        const values = rewardFields(input, false);
        if (!Object.keys(values).length) throw new ToolInputError('Give at least one reward setting to change');
        return { reward: str(input, 'reward', { required: true, max: 100 })!, values };
    },
    async run(input, ctx) {
        if (!await hasFullAccess(ctx.channelId)) return needsFullAccessResult(ctx.lang);
        const stored = await resolveReward(ctx.channelId, input.reward);
        if (!stored) throw new ToolInputError(`No DomDimaBot reward "${input.reward}". Only rewards created with DomDimaBot can be changed.`);
        const current = await currentReward(ctx.channelId, stored.rewardID);
        if (!current) throw new ToolInputError('This reward no longer exists on Twitch.');
        const keys = (Object.keys(input.values) as RewardField[]).filter((key) => !sameValue(current[key] ?? null, input.values[key]));
        if (!keys.length) return { type: 'result', result: { unchanged: true, message: 'The reward already has those values. Nothing to change.' }, summary: tr(ctx.lang, 'Already set', 'Ya estaba así') };
        const before = Object.fromEntries(keys.map((key) => [key, current[key] ?? null])) as RewardValues;
        const after = Object.fromEntries(keys.map((key) => [key, input.values[key]])) as RewardValues;
        const effects = 'message' in after ? await bodyEffects(after.message as string, ctx, tr(ctx.lang, 'When redeemed', 'Al canjearse')) : { effects: [], warnings: [] };
        const proposal: ChangeProposal = {
            tool: 'update_reward',
            title: tr(ctx.lang, `Change the reward "${stored.title}"`, `Cambiar la recompensa "${stored.title}"`),
            area: 'rewards',
            target: { type: 'reward', id: stored.rewardID, label: stored.title },
            before: rewardView(before), after: rewardView(after),
            effects: [tr(ctx.lang, 'Updates the reward on Twitch', 'Actualiza la recompensa en Twitch'), ...effects.effects],
            warnings: [LIVE(ctx.lang), ...effects.warnings],
            permissions: [...STREAM_TOOL_PERMISSIONS.update_reward],
            payload: { rewardId: stored.rewardID, before, after, expected: before }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { rewardId, before, after, expected } = proposal.payload as { rewardId: string; before: RewardValues; after: RewardValues; expected: RewardValues };
        const current = await currentReward(ctx.channelId, rewardId);
        if (!current) conflict(ctx.lang, 'This reward was deleted in the meantime. Nothing was changed.', 'Esta recompensa se eliminó mientras tanto. No se cambió nada.');
        assertUnchanged(current, expected, ctx.lang, tr(ctx.lang, 'The reward', 'La recompensa'));
        await patchReward(ctx.channelId, rewardId, after);
        return { result: { saved: true, rewardId }, change: change(proposal, { rewardId, before, after }) };
    },
    async undo(record, ctx) {
        const data = record.undo as { rewardId: string; before: RewardValues; after: RewardValues };
        const current = await currentReward(ctx.channelId, data.rewardId);
        if (!current) conflict(ctx.lang, 'This reward was deleted, so the change cannot be undone.', 'Esta recompensa se eliminó; el cambio no se puede deshacer.');
        assertUnchanged(current, data.after, ctx.lang, tr(ctx.lang, 'The reward', 'La recompensa'));
        await patchReward(ctx.channelId, data.rewardId, Object.fromEntries(Object.entries(data.before).filter(([, value]) => value !== null)) as RewardValues);
    }
};

export const streamTools: AgentTool[] = [sendTestAlert, setStreamInfo, createPollTool, createPredictionTool, createReward, updateReward] as unknown as AgentTool[];
