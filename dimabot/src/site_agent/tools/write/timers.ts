/**
 * Timer write tools: create, update (message, interval, on/off) and delete timers, the messages
 * the bot posts by itself every N minutes while the stream is live. Same two-phase rules as the
 * command tools (proposal → approval → compare-and-set apply → undo when unchanged since), through
 * the functions the timers route uses (`commands/timer_manager.command.ts`).
 *
 * Permissions mirror `server/routes/timer.route.ts`: every write needs `commands:manage`.
 */
import type { AgentTool, ChangeProposal, ChangeRecordInput, Lang, ToolContext } from '../../types.js';
import { ToolConflictError, ToolInputError } from '../../types.js';
import { asObject, bool, int, str, stableJson } from '../util.js';
import { describeCommandEffects } from '../effects.js';
import { CustomTimerSchema } from '../../../schemas/custom_timer.schema.js';
import { createTimer, deleteTimerIfUnchanged, updateTimerIfUnchanged } from '../../../commands/timer_manager.command.js';
import { getTimerIntervalMinutes, validateTimerEditInterval, validateTimerInterval } from '../../../utils/timer_policy.js';
import { COMMAND_LANGUAGE_BASICS } from './commands.js';

const PERMISSIONS = ['commands:manage'] as const;
const AREA = 'timers';
const MAX_NAME = 30;
const MAX_MESSAGE = 350;
/** Enabled timers per plan (timer_manager.command.ts getTierTimerLimit). */
const TIMER_LIMITS: Record<string, number> = { free: 5, premium: 15, pro: 50 };

const l = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);

const PLAN_RULES =
    'Plan rules: Free up to 5 enabled timers at 10, 20, 30, 40, 50 or 60 minutes; Premium up to 15 at 5-180 minutes '
    + 'in steps of 5; Pro up to 50 at 1-180 minutes. The message is at most 350 characters and runs like a command '
    + 'body (functions work; there is no viewer who typed it, so avoid $(user)/&p1). Timers only post while live.';

interface TimerRow { _id?: unknown; name: string; message: string; frequency: number; frequencyUnit?: string; active: boolean }

export function timerSnapshot(timer: TimerRow) {
    return { id: String(timer._id ?? ''), name: timer.name, message: timer.message, minutes: getTimerIntervalMinutes(timer), active: Boolean(timer.active) };
}
type TimerSnapshot = ReturnType<typeof timerSnapshot>;

const FIELD_NAMES: Record<keyof TimerSnapshot, [string, string]> = {
    id: ['id', 'id'], name: ['name', 'nombre'], message: ['message', 'mensaje'], minutes: ['interval', 'intervalo'], active: ['on/off', 'activado'],
};

function changedFields(expected: TimerSnapshot, current: TimerSnapshot, lang: Lang): string[] {
    return (Object.keys(FIELD_NAMES) as Array<keyof TimerSnapshot>)
        .filter((key) => stableJson(expected[key]) !== stableJson(current[key]))
        .map((key) => FIELD_NAMES[key][lang === 'es' ? 1 : 0]);
}

function conflict(label: string, fields: string[], lang: Lang, after = false): ToolConflictError {
    const list = fields.join(', ');
    return new ToolConflictError(after
        ? l(lang, `${label} changed after the assistant's change (${list}), so it was left as it is now.`,
            `${label} cambió después del cambio del asistente (${list}), así que se dejó como está ahora.`)
        : l(lang, `${label} changed since this was proposed (${list}). Nothing was changed; read it again and propose the change again.`,
            `${label} cambió desde que se propuso esto (${list}). No se cambió nada; vuelve a leerlo y propón el cambio otra vez.`));
}

function display(timer: { name: string; minutes: number; message: string; active: boolean }, lang: Lang, only?: Set<string>): Record<string, unknown> {
    const fields: Record<string, unknown> = {
        [l(lang, 'Timer', 'Temporizador')]: timer.name,
        [l(lang, 'Every (minutes)', 'Cada (minutos)')]: timer.minutes,
        [l(lang, 'Message', 'Mensaje')]: timer.message,
        [l(lang, 'On', 'Activo')]: timer.active,
    };
    if (!only) return fields;
    return Object.fromEntries(Object.entries(fields).filter(([key]) => only.has(key)));
}

const label = (name: string) => `"${name}"`;

/**
 * Write filter for compare-and-set: the stored fields the snapshot is made of, exactly as read
 * (`null` = missing). A write with it changes nothing if the timer was edited after that read.
 */
function timerGuard(timer: TimerRow): Record<string, unknown> {
    return { _id: timer._id, message: timer.message, frequency: timer.frequency, frequencyUnit: timer.frequencyUnit ?? null, active: timer.active ?? null };
}

async function readTimer(channelId: string, name: string): Promise<TimerRow | null> {
    return await CustomTimerSchema.findOne({ channelID: channelId, name: name.toLowerCase() }).lean() as unknown as TimerRow | null;
}

function normalizeName(raw: string): string {
    const name = raw.trim().toLowerCase();
    if (!name || name.length > MAX_NAME || !/^\w+$/.test(name)) {
        throw new ToolInputError(`name must be 1-${MAX_NAME} letters, numbers or underscores`);
    }
    return name;
}

function checkMessage(message: string | undefined): string | undefined {
    if (message === undefined) return undefined;
    if (!message.trim()) throw new ToolInputError('message is empty');
    if (message.length > MAX_MESSAGE) throw new ToolInputError(`message is too long (${message.length} of ${MAX_MESSAGE} characters)`);
    return message;
}

async function effectsFor(message: string, ctx: ToolContext) {
    const described = await describeCommandEffects(message, { plan: ctx.plan, lang: ctx.lang });
    return { effects: described.effects, warnings: described.problems.map((problem) => l(ctx.lang, `Test run: ${problem}`, `Prueba: ${problem}`)) };
}

/** timer_manager results → nothing / conflict (target changed) / plain failure. */
function check(result: { error: boolean; status: number; message: string }, name: string, lang: Lang): void {
    if (!result.error) return;
    if (result.status === 404) throw new ToolConflictError(l(lang, `The timer ${label(name)} no longer exists. Nothing was changed.`, `El temporizador ${label(name)} ya no existe. No se cambió nada.`));
    if (result.status === 409) throw new ToolConflictError(l(lang, `${result.message}. Nothing was changed.`, `${result.message}. No se cambió nada.`));
    throw new Error(result.message);
}

/**
 * A guarded write's result. When the guard missed (edited between our read and the write), the
 * conflict names what changed compared with `snapshot`.
 */
async function checkGuarded(result: { error: boolean; status: number; message: string; code?: string }, ctx: { channelId: string; lang: Lang }, name: string, snapshot: TimerSnapshot, after = false): Promise<void> {
    if (result.error && result.code === 'changed') {
        const now = await readTimer(ctx.channelId, name);
        const fields = now ? changedFields(snapshot, timerSnapshot(now), ctx.lang) : [];
        throw conflict(label(name), fields.length ? fields : [l(ctx.lang, 'edited while saving', 'editado mientras se guardaba')], ctx.lang, after);
    }
    check(result, name, ctx.lang);
}

// ---------------------------------------------------------------------------
// create_timer
// ---------------------------------------------------------------------------

interface CreateInput { name: string; minutes: number; message: string }

export const createTimerTool: AgentTool<CreateInput> = {
    name: 'create_timer',
    description:
        'Propose a new timer: a message the bot posts every `minutes` while the stream is live. It starts enabled. '
        + 'The user approves a card first. ' + PLAN_RULES + ' Test the message with test_command first. ' + COMMAND_LANGUAGE_BASICS,
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', maxLength: MAX_NAME, description: 'Letters, numbers, underscores (e.g. "discord").' },
            minutes: { type: 'integer', minimum: 1, maximum: 180, description: 'How often it posts, in minutes (plan rules apply).' },
            message: { type: 'string', maxLength: MAX_MESSAGE, description: 'What it posts (command language).' },
        },
        required: ['name', 'minutes', 'message'],
        additionalProperties: false,
    },
    kind: 'write',
    permissions: PERMISSIONS,
    label: (input, lang) => l(lang, `Preparing timer ${input.name}…`, `Preparando el temporizador ${input.name}…`),
    validate(raw) {
        const input = asObject(raw);
        return {
            name: normalizeName(str(input, 'name', { required: true, max: MAX_NAME + 5 })!),
            minutes: int(input, 'minutes', { required: true, min: 1, max: 1440 })!,
            message: checkMessage(str(input, 'message', { required: true }))!,
        };
    },
    async run(input, ctx) {
        const interval = validateTimerInterval(input.minutes, ctx.plan);
        if (!interval.valid) throw new ToolInputError(String(interval.error));
        if (await readTimer(ctx.channelId, input.name)) throw new ToolInputError(`Timer "${input.name}" already exists. Use update_timer to change it.`);
        const limit = TIMER_LIMITS[ctx.plan] ?? 5;
        const enabledCount = await CustomTimerSchema.countDocuments({ channelID: ctx.channelId, active: true });
        if (enabledCount >= limit) throw new ToolInputError(`Timer limit reached (${limit} enabled timers on the ${ctx.plan} plan). Turn one off or delete one first, or upgrade.`);
        const { effects, warnings } = await effectsFor(input.message, ctx);
        const proposal: ChangeProposal = {
            tool: 'create_timer',
            title: l(ctx.lang, `Create timer ${label(input.name)}`, `Crear temporizador ${label(input.name)}`),
            area: AREA,
            target: { type: 'timer', id: null, label: label(input.name) },
            before: null,
            after: display({ ...input, active: true }, ctx.lang),
            effects,
            ...(warnings.length ? { warnings } : {}),
            permissions: [...PERMISSIONS],
            payload: { input, expected: null },
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const input = (proposal.payload as { input: CreateInput }).input;
        if (await readTimer(ctx.channelId, input.name)) {
            throw new ToolConflictError(l(ctx.lang, `A timer ${label(input.name)} was created in the meantime. Nothing was changed.`, `Se creó un temporizador ${label(input.name)} mientras tanto. No se cambió nada.`));
        }
        const result = await createTimer(ctx.channelId, input.name, input.minutes, input.message);
        // The unique (channel, name) index refuses a timer created in between; createTimer reports it as a failure.
        if (result.error && result.status >= 500 && await readTimer(ctx.channelId, input.name)) {
            throw new ToolConflictError(l(ctx.lang, `A timer ${label(input.name)} was created in the meantime. Nothing was changed.`, `Se creó un temporizador ${label(input.name)} mientras tanto. No se cambió nada.`));
        }
        check(result, input.name, ctx.lang);
        const timer = result.timer as TimerRow;
        const change: ChangeRecordInput = {
            area: AREA,
            target: { type: 'timer', id: String(timer._id ?? ''), label: label(timer.name) },
            before: null,
            after: proposal.after,
            undo: { op: 'create', name: timer.name, expected: timerSnapshot(timer) },
            summary: `Created timer ${timer.name}`,
        };
        return { result: { created: true, name: timer.name, message: result.message }, change };
    },
    async undo(change, ctx) {
        const data = change.undo as { name: string; expected: TimerSnapshot } | null;
        if (!data?.name) throw new ToolConflictError('Nothing to undo');
        const current = await readTimer(ctx.channelId, data.name);
        if (!current) throw new ToolConflictError(l(ctx.lang, `The timer ${label(data.name)} was already deleted.`, `El temporizador ${label(data.name)} ya se había borrado.`));
        const fields = changedFields(data.expected, timerSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label(data.name), fields, ctx.lang, true);
        await checkGuarded(await deleteTimerIfUnchanged(ctx.channelId, data.name, timerGuard(current)), ctx, data.name, data.expected, true);
    },
};

// ---------------------------------------------------------------------------
// update_timer
// ---------------------------------------------------------------------------

interface UpdateChanges { minutes?: number; message?: string; enabled?: boolean }
interface UpdateInput extends UpdateChanges { name: string }

/** UpdateChanges → the timer_manager write (interval, message and on/off in one write). */
const writeChanges = (changes: UpdateChanges) => ({ frequency: changes.minutes, message: changes.message, active: changes.enabled });

export const updateTimerTool: AgentTool<UpdateInput> = {
    name: 'update_timer',
    description:
        'Propose changes to a timer: minutes (interval), message, enabled (turn it on or off). Send only what '
        + 'changes; the user approves a card first. ' + PLAN_RULES + ' A timer whose interval no longer fits the plan '
        + 'keeps running but needs a valid interval before any other edit.',
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', maxLength: MAX_NAME, description: 'Timer name from list_timers.' },
            minutes: { type: 'integer', minimum: 1, maximum: 180 },
            message: { type: 'string', maxLength: MAX_MESSAGE },
            enabled: { type: 'boolean' },
        },
        required: ['name'],
        additionalProperties: false,
    },
    kind: 'write',
    permissions: PERMISSIONS,
    label: (input, lang) => l(lang, `Preparing changes to timer ${input.name}…`, `Preparando cambios en el temporizador ${input.name}…`),
    validate(raw) {
        const input = asObject(raw);
        const parsed: UpdateInput = {
            name: normalizeName(str(input, 'name', { required: true, max: MAX_NAME + 5 })!),
            minutes: int(input, 'minutes', { min: 1, max: 1440 }),
            message: checkMessage(str(input, 'message')),
            enabled: bool(input, 'enabled'),
        };
        if (parsed.minutes === undefined && parsed.message === undefined && parsed.enabled === undefined) {
            throw new ToolInputError('Nothing to change: send at least one of minutes, message, enabled');
        }
        return parsed;
    },
    async run(input, ctx) {
        const current = await readTimer(ctx.channelId, input.name);
        if (!current) throw new ToolInputError(`No timer "${input.name}". Use list_timers.`);
        const before = timerSnapshot(current);
        const changes: UpdateChanges = {};
        if (input.minutes !== undefined && input.minutes !== before.minutes) changes.minutes = input.minutes;
        if (input.message !== undefined && input.message !== before.message) changes.message = input.message;
        if (input.enabled !== undefined && input.enabled !== before.active) changes.enabled = input.enabled;
        if (!Object.keys(changes).length) throw new ToolInputError(`Timer "${input.name}" already looks like that: nothing to change.`);

        if (changes.minutes !== undefined || changes.message !== undefined) {
            const interval = validateTimerEditInterval(current, changes.minutes, ctx.plan);
            if (!interval.valid) {
                throw new ToolInputError(changes.minutes === undefined
                    ? `This timer runs every ${before.minutes} minutes, which the current plan no longer allows; it can keep running, but set a valid interval (minutes) together with any other change. ${interval.error}`
                    : String(interval.error));
            }
        }

        const after = { name: before.name, minutes: changes.minutes ?? before.minutes, message: changes.message ?? before.message, active: changes.enabled ?? before.active };
        const beforeFields = display({ ...before }, ctx.lang);
        const afterFields = display(after, ctx.lang);
        const shown = new Set(Object.keys(beforeFields).filter((key) => stableJson(beforeFields[key]) !== stableJson(afterFields[key])));
        shown.add(l(ctx.lang, 'Timer', 'Temporizador'));

        let effects: string[] = [];
        const warnings: string[] = [];
        if (changes.message !== undefined || changes.enabled === true) {
            const described = await effectsFor(after.message, ctx);
            effects = described.effects;
            warnings.push(...described.warnings);
        }
        const proposal: ChangeProposal = {
            tool: 'update_timer',
            title: changes.enabled !== undefined && Object.keys(changes).length === 1
                ? (changes.enabled ? l(ctx.lang, `Turn on timer ${label(before.name)}`, `Activar temporizador ${label(before.name)}`)
                    : l(ctx.lang, `Turn off timer ${label(before.name)}`, `Desactivar temporizador ${label(before.name)}`))
                : l(ctx.lang, `Update timer ${label(before.name)}`, `Editar temporizador ${label(before.name)}`),
            area: AREA,
            target: { type: 'timer', id: before.id, label: label(before.name) },
            before: display({ ...before }, ctx.lang, shown),
            after: display(after, ctx.lang, shown),
            effects,
            ...(warnings.length ? { warnings } : {}),
            permissions: [...PERMISSIONS],
            payload: { name: before.name, changes, expected: before },
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { name, changes, expected } = proposal.payload as { name: string; changes: UpdateChanges; expected: TimerSnapshot };
        const current = await readTimer(ctx.channelId, name);
        if (!current) throw new ToolConflictError(l(ctx.lang, `The timer ${label(name)} was deleted in the meantime. Nothing was changed.`, `El temporizador ${label(name)} se borró mientras tanto. No se cambió nada.`));
        const fields = changedFields(expected, timerSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label(name), fields, ctx.lang);
        const result = await updateTimerIfUnchanged(ctx.channelId, name, timerGuard(current), writeChanges(changes));
        await checkGuarded(result, ctx, name, expected);
        const updated = result.timer as TimerRow | undefined;
        const restore: UpdateChanges = {
            ...(changes.minutes !== undefined ? { minutes: expected.minutes } : {}),
            ...(changes.message !== undefined ? { message: expected.message } : {}),
            ...(changes.enabled !== undefined ? { enabled: expected.active } : {}),
        };
        const change: ChangeRecordInput = {
            area: AREA,
            target: proposal.target,
            before: proposal.before,
            after: proposal.after,
            undo: { op: 'update', name, restore, expected: updated ? timerSnapshot(updated) : null },
            summary: `Updated timer ${name}`,
        };
        return { result: { updated: true, name }, change };
    },
    async undo(change, ctx) {
        const data = change.undo as { name: string; restore: UpdateChanges; expected: TimerSnapshot | null } | null;
        if (!data?.name || !data.restore || !data.expected) throw new ToolConflictError('Nothing to undo');
        const current = await readTimer(ctx.channelId, data.name);
        if (!current) throw new ToolConflictError(l(ctx.lang, `The timer ${label(data.name)} was deleted, so there is nothing to restore.`, `El temporizador ${label(data.name)} se borró, así que no hay nada que restaurar.`));
        const fields = changedFields(data.expected, timerSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label(data.name), fields, ctx.lang, true);
        await checkGuarded(await updateTimerIfUnchanged(ctx.channelId, data.name, timerGuard(current), writeChanges(data.restore)), ctx, data.name, data.expected, true);
    },
};

// ---------------------------------------------------------------------------
// delete_timer
// ---------------------------------------------------------------------------

export const deleteTimerTool: AgentTool<{ name: string }> = {
    name: 'delete_timer',
    description: 'Propose deleting a timer. The user approves a card first; it can be undone from the Changes list. To pause it instead, use update_timer enabled=false.',
    parameters: {
        type: 'object',
        properties: { name: { type: 'string', maxLength: MAX_NAME, description: 'Timer name from list_timers.' } },
        required: ['name'],
        additionalProperties: false,
    },
    kind: 'write',
    permissions: PERMISSIONS,
    label: (input, lang) => l(lang, `Preparing to delete timer ${input.name}…`, `Preparando el borrado del temporizador ${input.name}…`),
    validate(raw) {
        return { name: normalizeName(str(asObject(raw), 'name', { required: true, max: MAX_NAME + 5 })!) };
    },
    async run(input, ctx) {
        const current = await readTimer(ctx.channelId, input.name);
        if (!current) throw new ToolInputError(`No timer "${input.name}". Use list_timers.`);
        const snapshot = timerSnapshot(current);
        const proposal: ChangeProposal = {
            tool: 'delete_timer',
            title: l(ctx.lang, `Delete timer ${label(snapshot.name)}`, `Borrar temporizador ${label(snapshot.name)}`),
            area: AREA,
            target: { type: 'timer', id: snapshot.id, label: label(snapshot.name) },
            before: display(snapshot, ctx.lang),
            after: null,
            effects: [],
            permissions: [...PERMISSIONS],
            payload: { name: snapshot.name, expected: snapshot },
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { name, expected } = proposal.payload as { name: string; expected: TimerSnapshot };
        const current = await readTimer(ctx.channelId, name);
        if (!current) throw new ToolConflictError(l(ctx.lang, `The timer ${label(name)} was already deleted.`, `El temporizador ${label(name)} ya se había borrado.`));
        const fields = changedFields(expected, timerSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label(name), fields, ctx.lang);
        await checkGuarded(await deleteTimerIfUnchanged(ctx.channelId, name, timerGuard(current)), ctx, name, expected);
        const change: ChangeRecordInput = {
            area: AREA,
            target: proposal.target,
            before: proposal.before,
            after: null,
            undo: { op: 'delete', timer: expected },
            summary: `Deleted timer ${name}`,
        };
        return { result: { deleted: true, name }, change };
    },
    async undo(change, ctx) {
        const data = change.undo as { timer: TimerSnapshot } | null;
        if (!data?.timer) throw new ToolConflictError('Nothing to undo');
        const { name, minutes, message, active } = data.timer;
        if (await readTimer(ctx.channelId, name)) {
            throw new ToolConflictError(l(ctx.lang, `A timer ${label(name)} exists again, so the deleted one was not restored.`, `Ya existe otra vez un temporizador ${label(name)}, así que no se restauró el borrado.`));
        }
        const created = await createTimer(ctx.channelId, name, minutes, message);
        if (created.error) {
            throw new ToolConflictError(l(ctx.lang, `The timer ${label(name)} can't be restored: ${created.message}`, `El temporizador ${label(name)} no se puede restaurar: ${created.message}`));
        }
        // Turn it off only if nobody touched the timer we just created.
        const row = created.timer as TimerRow;
        if (!active) await checkGuarded(await updateTimerIfUnchanged(ctx.channelId, name, timerGuard(row), { active: false }), ctx, name, timerSnapshot(row), true);
    },
};

export const timerTools: AgentTool[] = [createTimerTool, updateTimerTool, deleteTimerTool] as unknown as AgentTool[];
