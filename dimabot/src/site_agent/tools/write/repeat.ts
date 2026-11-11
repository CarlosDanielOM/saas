/**
 * A command's "repeat", and the timer helpers the command and timer tools share.
 *
 * The website shows a repeating message as a command with "Repeat every N minutes" (Commands page →
 * Repeating). It is stored as a timer named like the command whose message is a copy of the reply
 * (`#(name)` for a command made with blocks), exactly as the commands page saves it (dimasite
 * `syncCommandTimer`). A timer with no command of that name is "stand-alone": made in chat with
 * `!cct`, it posts fine but the Commands page does not list it. The assistant therefore never creates
 * stand-alone timers: a new repeating message is `create_command` with `repeatMinutes`.
 */
import type { Lang, ToolContext } from '../../types.js';
import { ToolConflictError, ToolInputError } from '../../types.js';
import { stableJson } from '../util.js';
import { CommandsSchema } from '../../../schemas/commands.schema.js';
import { CustomTimerSchema } from '../../../schemas/custom_timer.schema.js';
import { createTimer, deleteTimerIfUnchanged, syncTimerCache, updateTimerIfUnchanged } from '../../../commands/timer_manager.command.js';
import { getTimerIntervalMinutes, validateTimerEditInterval, validateTimerInterval } from '../../../utils/timer_policy.js';

export const MAX_TIMER_NAME = 30;
export const MAX_TIMER_MESSAGE = 350;
/** Enabled timers per plan (timer_manager.command.ts getTierTimerLimit). */
export const TIMER_LIMITS: Record<string, number> = { free: 5, premium: 15, pro: 50 };

export const REPEAT_RULES =
    'Repeat rules by plan: Free up to 5 repeating messages at 10, 20, 30, 40, 50 or 60 minutes; Premium up to 15 '
    + 'at 5-180 minutes in steps of 5; Pro up to 50 at 1-180 minutes. A repeating reply is at most 350 characters, '
    + 'needs a name made of a-z, 0-9 or _, posts only while the stream is live, and has no viewer who typed it '
    + '(avoid $(user)/&p1 in it).';

const l = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);

export interface TimerRow { _id?: unknown; name: string; message: string; frequency: number; frequencyUnit?: string; active: boolean }

export function timerSnapshot(timer: TimerRow) {
    return { id: String(timer._id ?? ''), name: timer.name, message: timer.message, minutes: getTimerIntervalMinutes(timer), active: Boolean(timer.active) };
}
export type TimerSnapshot = ReturnType<typeof timerSnapshot>;

/** What a timer should become (a snapshot without the stored id). */
export interface RepeatTarget { name: string; minutes: number; message: string; active: boolean }

export const repeatTarget = (snapshot: TimerSnapshot): RepeatTarget =>
    ({ name: snapshot.name, minutes: snapshot.minutes, message: snapshot.message, active: snapshot.active });

const FIELD_NAMES: Record<keyof TimerSnapshot, [string, string]> = {
    id: ['id', 'id'], name: ['name', 'nombre'], message: ['message', 'mensaje'], minutes: ['interval', 'intervalo'], active: ['on/off', 'activado'],
};

export function timerChangedFields(expected: TimerSnapshot, current: TimerSnapshot, lang: Lang): string[] {
    return (Object.keys(FIELD_NAMES) as Array<keyof TimerSnapshot>)
        .filter((key) => stableJson(expected[key]) !== stableJson(current[key]))
        .map((key) => FIELD_NAMES[key][lang === 'es' ? 1 : 0]);
}

export function timerConflict(label: string, fields: string[], lang: Lang, after = false): ToolConflictError {
    const list = fields.join(', ');
    return new ToolConflictError(after
        ? l(lang, `${label} changed after the assistant's change (${list}), so it was left as it is now.`,
            `${label} cambió después del cambio del asistente (${list}), así que se dejó como está ahora.`)
        : l(lang, `${label} changed since this was proposed (${list}). Nothing was changed; read it again and propose the change again.`,
            `${label} cambió desde que se propuso esto (${list}). No se cambió nada; vuelve a leerlo y propón el cambio otra vez.`));
}

export const timerLabel = (name: string) => `"${name}"`;

/**
 * Write filter for compare-and-set: the stored fields the snapshot is made of, exactly as read
 * (`null` = missing). A write with it changes nothing if the timer was edited after that read.
 */
export function timerGuard(timer: TimerRow): Record<string, unknown> {
    return { _id: timer._id, message: timer.message, frequency: timer.frequency, frequencyUnit: timer.frequencyUnit ?? null, active: timer.active ?? null };
}

export async function readTimer(channelId: string, name: string): Promise<TimerRow | null> {
    return await CustomTimerSchema.findOne({ channelID: channelId, name: name.toLowerCase() }).lean() as unknown as TimerRow | null;
}

type TimerResult = { error: boolean; status: number; message: string; code?: string; timer?: unknown };

/**
 * timer_manager results → nothing / conflict / plain failure. A 4xx is a refusal before any write
 * (gone, name taken, plan rule), so it is a conflict: nothing changed. A 5xx may come after the
 * write landed (the timer is stored, then the live cache fails), so it stays a plain error and the
 * caller reports an unknown outcome.
 */
export function checkTimerResult(result: TimerResult, name: string, lang: Lang): void {
    if (!result.error) return;
    if (result.status === 404) throw new ToolConflictError(l(lang, `The timer ${timerLabel(name)} no longer exists. Nothing was changed.`, `El temporizador ${timerLabel(name)} ya no existe. No se cambió nada.`));
    if (result.status < 500) throw new ToolConflictError(l(lang, `${result.message.replace(/[.\s]+$/, '')}. Nothing was changed.`, `${result.message.replace(/[.\s]+$/, '')}. No se cambió nada.`));
    throw new Error(result.message);
}

/**
 * A guarded write's result. When the guard missed (edited between our read and the write), the
 * conflict names what changed compared with `snapshot`.
 */
export async function checkGuarded(result: TimerResult, ctx: { channelId: string; lang: Lang }, name: string, snapshot: TimerSnapshot, after = false): Promise<void> {
    if (result.error && result.code === 'changed') {
        const now = await readTimer(ctx.channelId, name);
        const fields = now ? timerChangedFields(snapshot, timerSnapshot(now), ctx.lang) : [];
        throw timerConflict(timerLabel(name), fields.length ? fields : [l(ctx.lang, 'edited while saving', 'editado mientras se guardaba')], ctx.lang, after);
    }
    checkTimerResult(result, name, ctx.lang);
}

// ---------------------------------------------------------------------------
// A command's repeat
// ---------------------------------------------------------------------------

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Linkable { _id?: unknown; cmd?: unknown; name?: unknown; activation?: unknown; reserved?: unknown }

/** Custom commands can repeat; keywords and built-in commands cannot (as on the commands page). */
export const canRepeat = (command: Linkable) => command.activation !== 'keyword' && !command.reserved;

const CUSTOM_COMMANDS = { activation: { $ne: 'keyword' }, reserved: { $ne: true } };

/**
 * The timer that is this command's repeat, resolved like the commands page (`resolveTimerName`): the
 * timer named like its trigger, else (older data) the one named like its display name, unless that
 * word is another command's trigger, which then owns the timer.
 */
export async function commandRepeat(channelId: string, command: Linkable): Promise<TimerRow | null> {
    if (!canRepeat(command)) return null;
    const trigger = String(command.cmd ?? '').trim().toLowerCase();
    const byTrigger = trigger ? await readTimer(channelId, trigger) : null;
    if (byTrigger) return byTrigger;
    const name = String(command.name ?? '').trim().toLowerCase();
    if (!name || name === trigger || !/^\w+$/.test(name)) return null;
    const byName = await readTimer(channelId, name);
    if (!byName) return null;
    const owner = await CommandsSchema.exists({ channelID: channelId, ...CUSTOM_COMMANDS, cmd: new RegExp(`^${escapeRegExp(name)}$`, 'i') });
    return owner ? null : byName;
}

/** The command a timer is the repeat of (the inverse of `commandRepeat`), or null for a stand-alone timer. */
export async function timerCommand(channelId: string, timerName: string): Promise<{ cmd: string } | null> {
    const pattern = new RegExp(`^${escapeRegExp(timerName)}$`, 'i');
    const byTrigger = await CommandsSchema.findOne({ channelID: channelId, ...CUSTOM_COMMANDS, cmd: pattern }).select('cmd').lean() as unknown as { cmd: string } | null;
    if (byTrigger) return byTrigger;
    // By display name only if that command really resolves to this timer (it may have one under its own trigger).
    const named = await CommandsSchema.find({ channelID: channelId, ...CUSTOM_COMMANDS, name: pattern }).select('cmd name activation reserved').lean() as unknown as Array<Linkable & { cmd: string }>;
    for (const command of named) {
        if ((await commandRepeat(channelId, command))?.name === timerName.toLowerCase()) return command;
    }
    return null;
}

/** The message a command's repeat posts: the reply itself, or `#(name)` for a command made with blocks (like the commands page). */
export function repeatMessage(command: { cmd?: unknown; authoring?: unknown; message?: unknown }): string {
    return command.authoring === 'blocks' ? `#(${String(command.cmd ?? '')})` : String(command.message ?? '');
}

/** "Every 17 minutes" / "No" for the before → after card. */
export function repeatLabel(repeat: { minutes: number; active: boolean } | null, lang: Lang): string {
    if (!repeat) return 'No';
    const every = l(lang, `Every ${repeat.minutes} ${repeat.minutes === 1 ? 'minute' : 'minutes'}`, `Cada ${repeat.minutes} ${repeat.minutes === 1 ? 'minuto' : 'minutos'}`);
    return repeat.active ? every : l(lang, `${every} (paused)`, `${every} (en pausa)`);
}

export const repeatKey = (lang: Lang) => l(lang, 'Repeats', 'Se repite');

/** True when the move would change something stored. */
export function repeatDiffers(from: TimerSnapshot | null, to: RepeatTarget | null): boolean {
    return stableJson(from ? repeatTarget(from) : null) !== stableJson(to);
}

/**
 * Undo: the command's repeat is still as the assistant's change left it: the same timer with the
 * same content, or still none. A repeat added (or changed) by a later change is not this change's
 * to move, and undoing a create or a rename under it would leave it posting without its command.
 */
export async function assertRepeatAsLeft(ctx: { channelId: string; lang: Lang }, command: Linkable, left: TimerSnapshot | null, label: string): Promise<void> {
    const row = await commandRepeat(ctx.channelId, command);
    const now = row ? repeatTarget(timerSnapshot(row)) : null;
    if (stableJson(now) === stableJson(left ? repeatTarget(left) : null)) return;
    throw new ToolConflictError(l(ctx.lang, `The repeat of ${label} changed after the assistant's change, so it was left as it is now. Undo the newer change (or stop the repeat) first.`,
        `La repetición de ${label} cambió después del cambio del asistente, así que se dejó como está ahora. Deshaz primero el cambio más reciente (o detén la repetición).`));
}

type MoveContext = { channelId: string; lang: Lang; plan: string };

/** `moveRepeat` was refused for a reason the timer rules give (plan limit, interval, name): a conflict whose message is that bare reason. */
export class RepeatRefused extends ToolConflictError {}

/** A timer that is switched on (new, or resumed) needs room under the plan's limit of enabled timers. */
async function hasRoom(ctx: MoveContext): Promise<{ ok: boolean; limit: number }> {
    const limit = TIMER_LIMITS[ctx.plan] ?? 5;
    return { ok: await CustomTimerSchema.countDocuments({ channelID: ctx.channelId, active: true }) < limit, limit };
}

/**
 * Checks a repeat before it is proposed (model-readable errors). `current` is the stored timer it
 * replaces or edits, if any.
 */
export async function checkRepeat(ctx: ToolContext, to: RepeatTarget, current: TimerRow | null): Promise<void> {
    if (to.name.length > MAX_TIMER_NAME || !/^\w+$/.test(to.name)) {
        throw new ToolInputError(`A command that repeats needs a name made only of a-z, 0-9 or _ (up to ${MAX_TIMER_NAME}); "${to.name}" can't repeat. Use another name, or leave the repeat off.`);
    }
    if (!to.message.trim()) throw new ToolInputError('A repeating message needs a reply to post.');
    if (to.message.length > MAX_TIMER_MESSAGE) {
        throw new ToolInputError(`A repeating message is at most ${MAX_TIMER_MESSAGE} characters and this reply has ${to.message.length}. Shorten the reply, or leave the repeat off (repeatMinutes 0 stops an existing one).`);
    }
    const before = current ? timerSnapshot(current) : null;
    if (!before) {
        const interval = validateTimerInterval(to.minutes, ctx.plan);
        if (!interval.valid) throw new ToolInputError(String(interval.error));
    } else if (before.minutes !== to.minutes || before.message !== to.message) {
        // An edit: an interval the plan no longer offers may stay only while nothing else about the timer changes.
        const interval = validateTimerEditInterval(current!, before.minutes !== to.minutes ? to.minutes : undefined, ctx.plan);
        if (!interval.valid) {
            throw new ToolInputError(before.minutes !== to.minutes ? String(interval.error)
                : `This repeats every ${before.minutes} minutes, which the ${ctx.plan} plan no longer allows; set a valid interval (repeatMinutes) together with this change. ${interval.error}`);
        }
    }
    if (to.active && !(before?.active)) {
        const room = await hasRoom(ctx);
        if (!room.ok) throw new ToolInputError(`Repeating message limit reached (${room.limit} enabled on the ${ctx.plan} plan). Turn one off or delete one first, or upgrade.`);
    }
}

/**
 * Read-only half of `moveRepeat`: the stored timer still equals `from` (and, when the move puts a
 * timer under a new name, that name is still free). Compared by content, not by stored id: undoing
 * a removal re-creates the timer under a new id, and an older change must still be undoable after
 * that. The write itself is guarded by the row read here.
 */
export async function assertRepeatUnchanged(ctx: { channelId: string; lang: Lang }, from: TimerSnapshot | null, to: RepeatTarget | null, after = false): Promise<TimerRow | null> {
    const current = from ? await readTimer(ctx.channelId, from.name) : null;
    if (from) {
        if (!current) {
            throw new ToolConflictError(after
                ? l(ctx.lang, `The repeat ${timerLabel(from.name)} was removed after the assistant's change, so it was left as it is now.`, `La repetición ${timerLabel(from.name)} se quitó después del cambio del asistente, así que se dejó como está ahora.`)
                : l(ctx.lang, `The repeat ${timerLabel(from.name)} was removed in the meantime. Nothing was changed; read it again and propose the change again.`, `La repetición ${timerLabel(from.name)} se quitó mientras tanto. No se cambió nada; vuelve a leerla y propón el cambio otra vez.`));
        }
        const fields = timerChangedFields({ ...from, id: '' }, { ...timerSnapshot(current), id: '' }, ctx.lang);
        if (fields.length) throw timerConflict(l(ctx.lang, `The repeat ${timerLabel(from.name)}`, `La repetición ${timerLabel(from.name)}`), fields, ctx.lang, after);
    }
    if (to && to.name !== from?.name && await readTimer(ctx.channelId, to.name)) {
        throw new ToolConflictError(after
            ? l(ctx.lang, `A repeating message ${timerLabel(to.name)} exists again, so this was left as it is now.`, `Ya existe otra vez un mensaje repetido ${timerLabel(to.name)}, así que esto se dejó como está ahora.`)
            : l(ctx.lang, `A repeating message ${timerLabel(to.name)} was created in the meantime. Nothing was changed.`, `Se creó un mensaje repetido ${timerLabel(to.name)} mientras tanto. No se cambió nada.`));
    }
    return current;
}

/**
 * The timer that is this command's repeat is still the one the proposal saw, or there is still none.
 * `assertRepeatUnchanged` only looks at that one timer: a repeat added since, or another timer that
 * now is the command's repeat, would be missed and left posting.
 */
export async function assertRepeatLink(ctx: { channelId: string; lang: Lang }, command: Linkable, expected: TimerSnapshot | null, label: string): Promise<void> {
    const now = await commandRepeat(ctx.channelId, command);
    if ((now?.name ?? null) === (expected?.name ?? null)) return;
    throw new ToolConflictError(l(ctx.lang, `The repeat of ${label} changed since this was proposed. Nothing was changed; read it again and propose the change again.`,
        `La repetición de ${label} cambió desde que se propuso esto. No se cambió nada; vuelve a leerlo y propón el cambio otra vez.`));
}

/**
 * Takes the stored timer from `from` to `to` (null = no timer) with ONE guarded write: create (in
 * its final on/off state), edit in place (interval, message, on/off and name together) or delete.
 *
 * Errors tell the caller what it may claim: a ToolConflictError means this call wrote nothing (the
 * timer no longer equals `from`, the name is taken, the plan refuses); any other error means the
 * outcome is unknown. A write that reports a failure after landing (stored, then the live cache
 * failed) is recognised by reading the timer back; it counts as done once the cache is repaired.
 *
 * `after` = this puts an earlier state back (undo): conflict texts say so, and a timer that is
 * re-created keeps its interval even if the plan no longer offers it.
 */
export async function moveRepeat(ctx: MoveContext, from: TimerSnapshot | null, to: RepeatTarget | null, after = false): Promise<TimerSnapshot | null> {
    const current = await assertRepeatUnchanged(ctx, from, to, after);
    if (!repeatDiffers(from, to)) return from;

    let result: TimerResult;
    if (current && from && to) {
        // Switching it on needs room at write time too (the proposal may be minutes old).
        if (to.active && !from.active && !(await hasRoom(ctx)).ok) {
            throw new RepeatRefused(l(ctx.lang, 'the limit of enabled repeating messages was reached in the meantime', 'se alcanzó el límite de mensajes repetidos activos mientras tanto'));
        }
        result = await updateTimerIfUnchanged(ctx.channelId, from.name, timerGuard(current), {
            name: to.name !== from.name ? to.name : undefined,
            frequency: to.minutes !== from.minutes ? to.minutes : undefined,
            message: to.message !== from.message ? to.message : undefined,
            active: to.active !== from.active ? to.active : undefined,
        });
    } else if (current && from) {
        result = await deleteTimerIfUnchanged(ctx.channelId, from.name, timerGuard(current));
    } else {
        result = await createTimer(ctx.channelId, to!.name, to!.minutes, to!.message, { active: to!.active, restore: after });
    }
    if (!result.error) return to ? timerSnapshot(result.timer as TimerRow) : null;

    if (result.status < 500) {
        // Refused before writing.
        if (result.code === 'changed' && from) await checkGuarded(result, ctx, from.name, from, after);
        throw new RepeatRefused(result.message.replace(/[.\s]+$/, ''));
    }
    // A 5xx can come after the write landed: read back what is stored and decide from that.
    const stored = async (name: string) => { const row = await readTimer(ctx.channelId, name); return row ? timerSnapshot(row) : null; };
    const atNew = to ? await stored(to.name) : null;
    const atOld = from && from.name !== to?.name ? await stored(from.name) : atNew;
    const same = (snapshot: TimerSnapshot | null, target: RepeatTarget | null) => stableJson(snapshot ? repeatTarget(snapshot) : null) === stableJson(target);
    const landed = to ? same(atNew, to) && (!from || from.name === to.name || atOld === null) : atOld === null;
    if (landed) {
        // Stored, but the live-cache step failed. The worker reads only that cache while live, so bring
        // it in line now; if the cache still cannot be reached this throws and the outcome stays unknown.
        for (const id of new Set([current ? String(current._id ?? '') : '', atNew?.id ?? ''])) if (id) await syncTimerCache(ctx.channelId, id);
        return atNew;
    }
    const untouched = from ? same(atOld, repeatTarget(from)) && (!to || to.name === from.name || atNew === null) : atNew === null;
    if (untouched) throw new RepeatRefused(result.message.replace(/[.\s]+$/, ''));
    throw new Error(`The repeat ${timerLabel((to ?? from)!.name)} may be half saved: ${result.message}`);
}
