/**
 * Timer write tools: change (interval, on/off, message of a stand-alone timer) and delete timers, the
 * messages the bot posts by itself every N minutes while the stream is live. Same two-phase rules as
 * the command tools (proposal → approval → compare-and-set apply → undo when unchanged since),
 * through the functions the timers route uses (`commands/timer_manager.command.ts`).
 *
 * There is no create tool on purpose: the website lists a repeating message only as a command with
 * a repeat (see `repeat.ts`), so a new one is `create_command` / `update_command` with
 * `repeatMinutes`. These tools cover what is left: pausing or re-timing a repeat, and editing or
 * removing stand-alone timers made in chat with `!cct`.
 *
 * Permissions mirror `server/routes/timer.route.ts`: every write needs `commands:manage`.
 */
import type { AgentTool, ChangeProposal, ChangeRecordInput, Lang, ToolContext } from '../../types.js';
import { ToolConflictError, ToolInputError } from '../../types.js';
import { asObject, bool, int, str, stableJson } from '../util.js';
import { describeCommandEffects } from '../effects.js';
import { deleteTimerIfUnchanged, updateTimerIfUnchanged } from '../../../commands/timer_manager.command.js';
import { validateTimerEditInterval } from '../../../utils/timer_policy.js';
import {
    checkGuarded, MAX_TIMER_MESSAGE, MAX_TIMER_NAME, moveRepeat, readTimer, REPEAT_RULES, RepeatRefused, timerChangedFields, timerCommand,
    timerConflict, timerGuard, timerLabel as label, timerSnapshot, type TimerRow, type TimerSnapshot,
} from './repeat.js';

export { timerSnapshot } from './repeat.js';

const PERMISSIONS = ['commands:manage'] as const;
const AREA = 'timers';
const MAX_NAME = MAX_TIMER_NAME;
const MAX_MESSAGE = MAX_TIMER_MESSAGE;

const l = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);
const changedFields = timerChangedFields;
const conflict = timerConflict;

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

function normalizeName(raw: string): string {
    const name = raw.trim().toLowerCase().replace(/^!/, '');
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

/** The command this timer is the repeat of (as the commands page links them), or null for a stand-alone timer. */
async function linkedCommand(ctx: ToolContext, name: string): Promise<string | null> {
    const command = await timerCommand(ctx.channelId, name);
    return command ? `!${command.cmd}` : null;
}

const standAloneNote = (lang: Lang) => l(lang,
    'This timer was made in chat and has no command, so the Commands page does not list it.',
    'Este temporizador se hizo en el chat y no tiene comando, así que la página de Comandos no lo muestra.');

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
        'Propose changes to a timer from list_timers: minutes (interval), enabled (pause or resume it), and message '
        + '(stand-alone timers only: a command\'s repeat posts the command\'s reply, so change that with update_command). '
        + 'Send only what changes; the user approves a card first. To start or stop a command\'s repeat use '
        + 'update_command repeatMinutes; this tool cannot create timers. ' + REPEAT_RULES + ' A timer whose interval no '
        + 'longer fits the plan keeps running but needs a valid interval before any other edit.',
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
        if (!current) throw new ToolInputError(`No timer "${input.name}". Use list_timers. To make a command repeat, use update_command (or create_command) with repeatMinutes.`);
        const before = timerSnapshot(current);
        const command = await linkedCommand(ctx, before.name);
        if (command && input.message !== undefined && input.message !== before.message) {
            throw new ToolInputError(`"${before.name}" is the repeat of ${command}: it posts that command's reply. Change the reply with update_command (the repeat follows it).`);
        }
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
        const warnings: string[] = command ? [] : [standAloneNote(ctx.lang)];
        if (changes.message !== undefined || changes.enabled === true) {
            const described = await effectsFor(after.message, ctx);
            effects = described.effects;
            warnings.push(...described.warnings);
        }
        const onlyOnOff = changes.enabled !== undefined && Object.keys(changes).length === 1;
        const title = command
            ? (onlyOnOff ? (changes.enabled ? l(ctx.lang, `Resume the repeat of ${command}`, `Reanudar la repetición de ${command}`)
                : l(ctx.lang, `Pause the repeat of ${command}`, `Pausar la repetición de ${command}`))
                : l(ctx.lang, `Change the repeat of ${command}`, `Cambiar la repetición de ${command}`))
            : (onlyOnOff ? (changes.enabled ? l(ctx.lang, `Turn on timer ${label(before.name)}`, `Activar temporizador ${label(before.name)}`)
                : l(ctx.lang, `Turn off timer ${label(before.name)}`, `Desactivar temporizador ${label(before.name)}`))
                : l(ctx.lang, `Update timer ${label(before.name)}`, `Editar temporizador ${label(before.name)}`));
        const proposal: ChangeProposal = {
            tool: 'update_timer',
            title,
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
    description: 'Propose deleting a timer from list_timers (for a command\'s repeat this stops the repeating and keeps the command). '
        + 'The user approves a card first; it can be undone from the Changes list. To pause it instead, use update_timer enabled=false.',
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
        const command = await linkedCommand(ctx, snapshot.name);
        const proposal: ChangeProposal = {
            tool: 'delete_timer',
            title: command ? l(ctx.lang, `Stop repeating ${command}`, `Dejar de repetir ${command}`)
                : l(ctx.lang, `Delete timer ${label(snapshot.name)}`, `Borrar temporizador ${label(snapshot.name)}`),
            area: AREA,
            target: { type: 'timer', id: snapshot.id, label: label(snapshot.name) },
            before: display(snapshot, ctx.lang),
            after: null,
            effects: [],
            warnings: [command ? l(ctx.lang, `${command} itself stays; it just stops posting by itself.`, `${command} se queda; solo deja de publicarse solo.`) : standAloneNote(ctx.lang)],
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
        // One write, already on or off as it was (and with its old interval even if the plan no longer offers it).
        try {
            await moveRepeat(ctx, null, { name, minutes, message, active }, true);
        } catch (error) {
            if (!(error instanceof RepeatRefused)) throw error;
            throw new ToolConflictError(l(ctx.lang, `The timer ${label(name)} can't be restored: ${error.message}`, `El temporizador ${label(name)} no se puede restaurar: ${error.message}`));
        }
    },
};

export const timerTools: AgentTool[] = [updateTimerTool, deleteTimerTool] as unknown as AgentTool[];

// ---------------------------------------------------------------------------
// create_timer (retired)
// ---------------------------------------------------------------------------

const RETIRED = 'create_timer was retired: make a repeating message with create_command (or update_command) and repeatMinutes.';

/**
 * Retired 2026-11-11: it made timers without a command, which the Commands page does not list. The
 * model is never offered it and it proposes nothing; it stays only so the changes it already made
 * can be undone from the Changes list (`registry.getUndoTool`).
 */
export const retiredCreateTimerTool: AgentTool<Record<string, never>> = {
    name: 'create_timer',
    description: 'Retired. Use create_command with repeatMinutes.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    kind: 'write',
    permissions: PERMISSIONS,
    label: (_input, lang) => l(lang, 'Preparing…', 'Preparando…'),
    validate() { throw new ToolInputError(RETIRED); },
    async run() { throw new ToolInputError(RETIRED); },
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

export const retiredTimerTools: AgentTool[] = [retiredCreateTimerTool] as unknown as AgentTool[];
