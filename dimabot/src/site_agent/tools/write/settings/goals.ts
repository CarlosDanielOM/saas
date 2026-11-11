import { GoalError, goalLimit, newGoal, type Goal, type GoalAction, type GoalActions } from '../../../../goals/model.js';
import { changeGoal, GoalSet } from '../../../../goals/service.js';
import { requestWidgetSessionRefresh } from '../../../../widget_feed/session-refresh.js';
import { ToolConflictError, ToolInputError, type AgentTool, type ChangeProposal, type Lang, type ToolContext } from '../../../types.js';
import { asObject, int, oneOf, str } from '../../util.js';
import { bodyEffects, conflict, mergeEffects, sameValue, tr } from './common.js';

/**
 * Goals (the dashboard Goals card; also OBS goal widgets). Routes: POST/PATCH/DELETE /goals/:channelID
 * need `*` (owner or full-access admin) and an If-Match revision; plan limits 2/3/4 goals, Bits goals Premium+.
 */

export const GOAL_PERMISSIONS = ['*'] as const;

const METRICS = ['follows', 'subs', 'bits'] as const;
const MODES = ['total', 'current', 'fixed', 'rolling', 'monthly'] as const;

interface ActionInput { type: 'message' | 'ast'; text: string }
export interface GoalCreateInput {
    name: string; metric: typeof METRICS[number]; mode: typeof MODES[number]; target: number;
    timeZone?: string; startsAt?: string; endsAt?: string; windowSeconds?: number;
    completionAction?: ActionInput; failureAction?: ActionInput;
}
export interface GoalUpdateInput { id: string; name?: string; target?: number; completionAction?: ActionInput | null; failureAction?: ActionInput | null }
export interface GoalDeleteInput { id: string }

function action(input: Record<string, unknown>, key: string, nullable: boolean): ActionInput | null | undefined {
    const value = input[key];
    if (value === undefined) return undefined;
    if (value === null) { if (nullable) return null; throw new ToolInputError(`${key} cannot be null`); }
    const raw = asObject(value);
    const type = oneOf(raw, 'type', ['message', 'ast'] as const, { required: true })!;
    const text = str(raw, 'text', { required: true, max: type === 'message' ? 500 : 4000 })!;
    return { type, text };
}

function actionsOf(completion: ActionInput | null | undefined, failure: ActionInput | null | undefined): GoalActions | undefined {
    if (completion === undefined && failure === undefined) return undefined;
    return { ...(completion ? { completion } : {}), ...(failure ? { failure } : {}) };
}

/** Plain view of a goal for cards and the change log. */
export function goalView(goal: Goal): Record<string, unknown> {
    return {
        name: goal.name, metric: goal.metric, mode: goal.mode, target: goal.target,
        ...(goal.mode === 'fixed' ? { startsAt: new Date(goal.startsAt).toISOString(), endsAt: new Date(goal.endsAt!).toISOString() } : {}),
        ...(goal.mode === 'rolling' ? { windowSeconds: goal.windowSeconds } : {}),
        ...(goal.mode === 'monthly' ? { timeZone: goal.timeZone } : {}),
        ...(goal.currency ? { currency: goal.currency.code } : {}),
        ...(goal.actions?.completion ? { whenReached: `${goal.actions.completion.type}: ${goal.actions.completion.text}` } : {}),
        ...(goal.actions?.failure ? { whenMissed: `${goal.actions.failure.type}: ${goal.actions.failure.text}` } : {})
    };
}

async function actionEffects(actions: GoalActions | undefined, ctx: Pick<ToolContext, 'plan' | 'lang'>) {
    const parts = await Promise.all((['completion', 'failure'] as const).map(async (key) => {
        const item: GoalAction | undefined = actions?.[key];
        if (!item) return { effects: [], warnings: [] };
        const label = key === 'completion' ? tr(ctx.lang, 'When reached', 'Al alcanzarla') : tr(ctx.lang, 'When missed', 'Si no se alcanza');
        return item.type === 'ast' ? bodyEffects(item.text, ctx, label) : { effects: [`${label}: ${tr(ctx.lang, 'posts a message in chat', 'publica un mensaje en el chat')}`], warnings: [] };
    }));
    return mergeEffects(...parts);
}

async function state(channelId: string) {
    const doc = await GoalSet.findById(channelId).lean();
    return { revision: doc?.revision ?? 0, goals: (doc?.goals ?? []) as Goal[] };
}

async function saveGoals(ctx: Pick<ToolContext, 'channelId' | 'lang'>, kind: 'create' | 'edit' | 'delete', body: unknown, revision: number, id?: string): Promise<void> {
    try { await changeGoal(ctx.channelId, kind, body, revision, id); }
    catch (error) {
        if (error instanceof GoalError && error.code === 'conflict') throw new ToolConflictError(tr(ctx.lang, 'Goals changed since this was prepared. Nothing was changed; ask again for a fresh proposal.', 'Las metas cambiaron desde que se preparó este cambio. No se cambió nada; vuelve a pedirlo.'));
        if (error instanceof GoalError) throw new Error(error.message);
        throw error;
    }
    // Same as the route: OBS widgets reading StreamElements "*-goal" values follow the Goals card.
    requestWidgetSessionRefresh(ctx.channelId);
}

const goalTarget = (lang: Lang, goal: { id: string | null; name: string }) => ({ type: 'goal', id: goal.id, label: goal.name || tr(lang, 'Goal', 'Meta') });
const actionSchema = { type: 'object', additionalProperties: false, required: ['type', 'text'], properties: {
    type: { type: 'string', enum: ['message', 'ast'], description: 'message = plain chat text (≤500); ast = a command body with $(...) functions (≤4000)' },
    text: { type: 'string' }
} };

export const createGoal: AgentTool<GoalCreateInput> = {
    name: 'create_goal',
    kind: 'write',
    permissions: GOAL_PERMISSIONS,
    description: [
        'Create a goal (dashboard → Goals; OBS goal widgets show it). metric: follows, subs, or bits (Bits need Premium/Pro). mode: total (counts from now on), current (the channel\'s current follower/sub total; follows and subs only),',
        'fixed (between startsAt and endsAt, ISO dates with a time zone offset), rolling (the last windowSeconds, up to 90 days), monthly (resets each month in timeZone, an IANA zone like America/Mexico_City).',
        'target: the number to reach. completionAction runs once when the goal is reached; failureAction when a fixed, rolling or monthly goal ends unreached (message = chat text, ast = command body).',
        'Plan limits: Free 2 goals, Premium 3, Pro 4. Currency goals and Twitch goal actions are set up on the page. The user approves first; undo deletes the new goal.'
    ].join(' '),
    parameters: {
        type: 'object', additionalProperties: false, required: ['name', 'metric', 'mode', 'target'],
        properties: {
            name: { type: 'string', maxLength: 80 }, metric: { type: 'string', enum: [...METRICS] }, mode: { type: 'string', enum: [...MODES] },
            target: { type: 'integer', minimum: 1, maximum: 1_000_000_000 }, timeZone: { type: 'string' }, startsAt: { type: 'string' }, endsAt: { type: 'string' },
            windowSeconds: { type: 'integer', minimum: 1, maximum: 7_776_000 }, completionAction: actionSchema, failureAction: actionSchema
        }
    },
    label: (_input, lang) => tr(lang, 'Preparing the goal…', 'Preparando la meta…'),
    validate(raw) {
        const input = asObject(raw);
        return {
            name: str(input, 'name', { required: true, max: 80 })!,
            metric: oneOf(input, 'metric', METRICS, { required: true })!,
            mode: oneOf(input, 'mode', MODES, { required: true })!,
            target: int(input, 'target', { required: true, min: 1, max: 1_000_000_000 })!,
            timeZone: str(input, 'timeZone', { max: 64 }),
            startsAt: str(input, 'startsAt', { max: 40 }),
            endsAt: str(input, 'endsAt', { max: 40 }),
            windowSeconds: int(input, 'windowSeconds', { min: 1, max: 7_776_000 }),
            completionAction: action(input, 'completionAction', false) ?? undefined,
            failureAction: action(input, 'failureAction', false) ?? undefined
        };
    },
    async run(input, ctx) {
        const current = await state(ctx.channelId);
        if (current.goals.length >= goalLimit(ctx.plan)) throw new ToolInputError(`The ${ctx.plan} plan allows ${goalLimit(ctx.plan)} goals and the channel has ${current.goals.length}. Delete one first or upgrade.`);
        const body: Record<string, unknown> = { name: input.name, metric: input.metric, mode: input.mode, target: input.target };
        for (const key of ['timeZone', 'startsAt', 'endsAt', 'windowSeconds'] as const) if (input[key] !== undefined) body[key] = input[key];
        const actions = actionsOf(input.completionAction, input.failureAction);
        if (actions) body.actions = actions;
        let preview: Goal;
        try { preview = newGoal(body, ctx.plan, 'preview', Date.now()); }
        catch (error) { if (error instanceof GoalError) throw new ToolInputError(error.message); throw error; }
        const effects = await actionEffects(preview.actions, ctx);
        const proposal: ChangeProposal = {
            tool: 'create_goal',
            title: tr(ctx.lang, `Create the goal "${preview.name}"`, `Crear la meta "${preview.name}"`),
            area: 'goals',
            target: goalTarget(ctx.lang, { id: null, name: preview.name }),
            before: null,
            after: goalView(preview),
            effects: effects.effects,
            warnings: [...effects.warnings, ...(input.mode === 'total' ? [tr(ctx.lang, 'A total goal counts from now on, not past follows or subs.', 'Una meta total cuenta desde ahora, no los follows o subs anteriores.')] : [])],
            permissions: [...GOAL_PERMISSIONS],
            payload: { body, revision: current.revision, knownIds: current.goals.map((goal) => goal.id) }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { body, revision, knownIds } = proposal.payload as { body: Record<string, unknown>; revision: number; knownIds: string[] };
        await saveGoals(ctx, 'create', body, revision);
        const created = (await state(ctx.channelId)).goals.find((goal) => !knownIds.includes(goal.id));
        return {
            result: { created: true, id: created?.id ?? null },
            change: {
                area: 'goals', target: goalTarget(ctx.lang, { id: created?.id ?? null, name: String(body.name) }), before: null, after: proposal.after,
                undo: created ? { id: created.id, after: goalView(created) } : null, summary: proposal.title
            }
        };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; after: Record<string, unknown> };
        const current = await state(ctx.channelId);
        const goal = current.goals.find((item) => item.id === data.id);
        if (!goal) conflict(ctx.lang, 'This goal was already deleted.', 'Esta meta ya se eliminó.');
        if (!sameValue(goalView(goal), data.after)) conflict(ctx.lang, 'This goal was edited after it was created, so it was not deleted.', 'Esta meta se editó después de crearse; no se eliminó.');
        await saveGoals(ctx, 'delete', undefined, current.revision, data.id);
    }
};

export const updateGoal: AgentTool<GoalUpdateInput> = {
    name: 'update_goal',
    kind: 'write',
    permissions: GOAL_PERMISSIONS,
    description: 'Edit a goal (dashboard → Goals): its name, target, and the actions when it is reached (completionAction) or missed (failureAction; fixed, rolling and monthly goals only). Pass null to remove an action. Metric and counting mode cannot change: delete and create a new goal instead. Goal ids come from get_settings area "goals". The user approves first; it can be undone.',
    parameters: {
        type: 'object', additionalProperties: false, required: ['id'],
        properties: {
            id: { type: 'string' }, name: { type: 'string', maxLength: 80 }, target: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
            completionAction: { anyOf: [actionSchema, { type: 'null' }] }, failureAction: { anyOf: [actionSchema, { type: 'null' }] }
        }
    },
    label: (_input, lang) => tr(lang, 'Preparing the goal change…', 'Preparando el cambio de la meta…'),
    validate(raw) {
        const input = asObject(raw);
        const value: GoalUpdateInput = {
            id: str(input, 'id', { required: true, max: 64 })!,
            name: str(input, 'name', { max: 80 }),
            target: int(input, 'target', { min: 1, max: 1_000_000_000 }),
            completionAction: action(input, 'completionAction', true),
            failureAction: action(input, 'failureAction', true)
        };
        if (value.name === undefined && value.target === undefined && value.completionAction === undefined && value.failureAction === undefined) throw new ToolInputError('Give a name, target or action to change');
        return value;
    },
    async run(input, ctx) {
        const current = await state(ctx.channelId);
        const goal = current.goals.find((item) => item.id === input.id);
        if (!goal) throw new ToolInputError(`No goal with id ${input.id}. Use get_settings area "goals".`);
        const touchesActions = input.completionAction !== undefined || input.failureAction !== undefined;
        const actions = touchesActions ? actionsOf(
            input.completionAction === undefined ? goal.actions?.completion : input.completionAction,
            input.failureAction === undefined ? goal.actions?.failure : input.failureAction) ?? {} : undefined;
        const body: Record<string, unknown> = { name: input.name ?? goal.name, target: input.target ?? goal.target, ...(actions ? { actions } : {}) };
        const next: Goal = { ...goal, name: body.name as string, target: body.target as number, ...(actions ? { actions } : {}) };
        if (actions?.failure && !['fixed', 'rolling', 'monthly'].includes(goal.mode)) throw new ToolInputError('Failure actions require a fixed, rolling or monthly goal');
        if (sameValue(goalView(goal), goalView(next))) return { type: 'result', result: { unchanged: true, message: 'The goal already has those values. Nothing to change.' }, summary: tr(ctx.lang, 'Already set', 'Ya estaba así') };
        const effects = touchesActions ? await actionEffects(actions, ctx) : { effects: [], warnings: [] };
        const proposal: ChangeProposal = {
            tool: 'update_goal',
            title: tr(ctx.lang, `Edit the goal "${goal.name}"`, `Editar la meta "${goal.name}"`),
            area: 'goals',
            target: goalTarget(ctx.lang, goal),
            before: goalView(goal),
            after: goalView(next),
            effects: effects.effects,
            warnings: [...effects.warnings, ...(touchesActions ? [tr(ctx.lang, 'A changed action only runs if the goal has not been reached yet.', 'Una acción cambiada solo corre si la meta aún no se alcanza.')] : [])],
            permissions: [...GOAL_PERMISSIONS],
            payload: { id: goal.id, body, revision: current.revision, before: { name: goal.name, target: goal.target, actions: goal.actions ?? {} } }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, body, revision, before } = proposal.payload as { id: string; body: Record<string, unknown>; revision: number; before: Record<string, unknown> };
        await saveGoals(ctx, 'edit', body, revision, id);
        const saved = (await state(ctx.channelId)).goals.find((goal) => goal.id === id);
        return {
            result: { saved: true, id },
            change: { area: 'goals', target: proposal.target, before: proposal.before, after: proposal.after, undo: saved ? { id, before, after: goalView(saved) } : null, summary: proposal.title }
        };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; before: Record<string, unknown>; after: Record<string, unknown> };
        const current = await state(ctx.channelId);
        const goal = current.goals.find((item) => item.id === data.id);
        if (!goal) conflict(ctx.lang, 'This goal was deleted, so the change cannot be undone.', 'Esta meta se eliminó; el cambio no se puede deshacer.');
        if (!sameValue(goalView(goal), data.after)) conflict(ctx.lang, 'This goal was edited again after this change, so it was not undone.', 'Esta meta se volvió a editar después de este cambio; no se deshizo.');
        await saveGoals(ctx, 'edit', data.before, current.revision, data.id);
    }
};

export const deleteGoal: AgentTool<GoalDeleteInput> = {
    name: 'delete_goal',
    kind: 'write',
    permissions: GOAL_PERMISSIONS,
    description: 'Delete a goal (dashboard → Goals) and its progress. OBS goal widgets stop showing it. This cannot be undone. Goal ids come from get_settings area "goals". The user approves first.',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    label: (_input, lang) => tr(lang, 'Preparing to delete the goal…', 'Preparando la eliminación de la meta…'),
    validate: (raw) => ({ id: str(asObject(raw), 'id', { required: true, max: 64 })! }),
    async run(input, ctx) {
        const current = await state(ctx.channelId);
        const goal = current.goals.find((item) => item.id === input.id);
        if (!goal) throw new ToolInputError(`No goal with id ${input.id}. Use get_settings area "goals".`);
        const proposal: ChangeProposal = {
            tool: 'delete_goal',
            title: tr(ctx.lang, `Delete the goal "${goal.name}"`, `Eliminar la meta "${goal.name}"`),
            area: 'goals',
            target: goalTarget(ctx.lang, goal),
            before: goalView(goal),
            after: null,
            effects: [],
            warnings: [tr(ctx.lang, 'This cannot be undone: the goal and its progress are deleted.', 'Esto no se puede deshacer: se eliminan la meta y su progreso.')],
            permissions: [...GOAL_PERMISSIONS],
            payload: { id: goal.id, revision: current.revision }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, revision } = proposal.payload as { id: string; revision: number };
        await saveGoals(ctx, 'delete', undefined, revision, id);
        return { result: { deleted: true, id }, change: { area: 'goals', target: proposal.target, before: proposal.before, after: null, undo: null, summary: proposal.title } };
    }
};

export const goalTools: AgentTool[] = [createGoal, updateGoal, deleteGoal] as unknown as AgentTool[];
