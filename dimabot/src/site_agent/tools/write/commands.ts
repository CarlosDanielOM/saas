/**
 * Command write tools: create, update and delete chat commands (and update/delete keywords).
 * Two-phase: `run` checks everything and returns a proposal (no side effects); `apply` runs after
 * the user approves, re-reads the command and compares it with the proposal's snapshot
 * (compare-and-set), then writes through the same service the commands page uses
 * (`server/services/command_mutations.service.ts`). `undo` restores the previous state only if
 * the command still looks exactly like the assistant left it.
 *
 * A command's repeat ("post it by itself every N minutes", the Repeating tab of the commands page)
 * is part of these tools: it is the timer named like the command (see `repeat.ts`). Creating,
 * renaming, re-wording or deleting a command moves that timer with it in the same change, like the
 * commands page does, so a repeat never ends up without its command. Order of the two writes: the
 * repeat first (one guarded write), then the command; a refused command write moves the repeat back
 * (`changeWithRepeat`), so "Not applied" always means nothing changed.
 *
 * Permissions mirror `server/routes/command.route.ts`: every write needs `commands:manage`.
 */
import { createHash } from 'node:crypto';
import type { AgentTool, ChangeProposal, ChangeRecordInput, Lang, ToolContext } from '../../types.js';
import { ToolConflictError, ToolInputError } from '../../types.js';
import { asObject, bool, int, oneOf, str, stableJson } from '../util.js';
import { describeCommandEffects } from '../effects.js';
import { CommandsSchema } from '../../../schemas/commands.schema.js';
import { getReservedCommandDefinition } from '../../../server/services/command_defaults.service.js';
import { CommandBlocksRequestError } from '../../../server/services/command_blocks.service.js';
import {
    CommandMutationError,
    createChannelCommand,
    deleteChannelCommand,
    restoreDeletedCommand,
    updateChannelCommand,
    type CommandWriteBody,
} from '../../../server/services/command_mutations.service.js';
import { CommandCooldownError } from '../../../utils/command_cooldown_write.js';
import { getMinimumCommandCooldown } from '../../../utils/command_cooldown.js';
import { MAX_COMMAND_TEXT } from '../../../utils/ast_blocks/index.js';
import { normalizeKeyword, validateKeyword } from '../../../utils/keywords.js';
import { inspectExpression, LEGACY_USER_LEVEL_NAMES } from '../../../utils/permissions/index.js';
import {
    assertRepeatAsLeft, assertRepeatLink, canRepeat, checkRepeat, commandRepeat, moveRepeat, readTimer, REPEAT_RULES, RepeatRefused, repeatDiffers, repeatKey,
    repeatLabel, repeatMessage, repeatTarget, timerSnapshot, type RepeatTarget, type TimerSnapshot,
} from './repeat.js';
import {
    ACCESS_LEVELS,
    accessLabel,
    accessLevelFromNumber,
    BUILT_IN_FUNCS,
    escapeRegExp,
    findChannelCommand,
    runsBuiltInCode,
    triggerLabel,
    type AccessLevel,
    type LeanCommand,
} from '../read.js';

const PERMISSIONS = ['commands:manage'] as const;
const AREA = 'commands';
/** The commands page allows 0 (one editable command) or the plan minimum up to 60 seconds. */
const MAX_COOLDOWN = 60;
const MAX_DESCRIPTION = 200;
const TRIGGER_PATTERN = /^[\p{L}\p{N}]{1,30}$/u;

const l = (lang: Lang, en: string, es: string) => (lang === 'es' ? es : en);

/** Shared with the model in every write tool description. */
export const COMMAND_LANGUAGE_BASICS =
    'Command language basics (the reply body): plain text is posted in chat as typed. $(fn args) calls a function, '
    + 'e.g. $(user) = who typed it, $(touser) = the first word typed after the command (or the user), $(random 1-6), '
    + '$(tts $(user) says: &t), $(ban $(user) 60). &p1 &p2 … = words typed after the command, &t = the rest of the '
    + 'message. %(name) reads and %(name value) writes a variable (no prefix: this run only; # cache 24 h; ## cache '
    + 'per viewer; * and ** database, Premium/Pro). *(condition ? yes : no) does logic and math, e.g. '
    + '%(#wins *(%(#wins) + 1)). ^(name) checks a variable exists, #(other) runs another command. Double quotes and '
    + '${ } only work inside a prefix. Look functions up with search_ast_functions and read the docs when unsure. '
    + 'ALWAYS run the body through test_command (as a viewer, with and without an argument) and fix every problem '
    + 'before proposing it. Never write moderation (ban/timeout), raids, VIP/Mod changes or other risky actions '
    + 'into a body unless the user explicitly asked for exactly that.';

// ---------------------------------------------------------------------------
// Snapshots, display fields, errors
// ---------------------------------------------------------------------------

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** Stable state used for compare-and-set (the reply is hashed: block replies are never shown). */
export function commandSnapshot(command: LeanCommand) {
    return {
        id: String(command._id),
        cmd: String(command.cmd ?? ''),
        name: String(command.name ?? ''),
        activation: command.activation === 'keyword' ? 'keyword' : 'command',
        authoring: command.authoring === 'blocks' ? 'blocks' : 'text',
        reply: hash(String(command.message ?? '')),
        cooldown: Number(command.cooldown ?? 0),
        enabled: command.enabled !== false,
        userLevel: Number(command.userLevel ?? 0),
        permissionExpression: command.permissionExpression ?? null,
        description: String(command.description ?? ''),
        reserved: Boolean(command.reserved),
    };
}
type CommandSnapshot = ReturnType<typeof commandSnapshot>;

const SNAPSHOT_FIELDS: Record<keyof CommandSnapshot, [string, string]> = {
    id: ['id', 'id'],
    cmd: ['name', 'nombre'],
    name: ['display name', 'nombre visible'],
    activation: ['type', 'tipo'],
    authoring: ['editor', 'editor'],
    reply: ['reply', 'respuesta'],
    cooldown: ['cooldown', 'tiempo de espera'],
    enabled: ['on/off', 'activado'],
    userLevel: ['who can use it', 'quién puede usarlo'],
    permissionExpression: ['access rule', 'regla de acceso'],
    description: ['description', 'descripción'],
    reserved: ['built-in', 'integrado'],
};

function changedFields(expected: CommandSnapshot, current: CommandSnapshot, lang: Lang): string[] {
    return (Object.keys(SNAPSHOT_FIELDS) as Array<keyof CommandSnapshot>)
        .filter((key) => stableJson(expected[key]) !== stableJson(current[key]))
        .map((key) => SNAPSHOT_FIELDS[key][lang === 'es' ? 1 : 0]);
}

function conflict(label: string, fields: string[], lang: Lang, after = false): ToolConflictError {
    const list = fields.join(', ');
    return new ToolConflictError(after
        ? l(lang, `${label} changed after the assistant's change (${list}), so it was left as it is now.`,
            `${label} cambió después del cambio del asistente (${list}), así que se dejó como está ahora.`)
        : l(lang, `${label} changed since this was proposed (${list}). Nothing was changed; read it again and propose the change again.`,
            `${label} cambió desde que se propuso esto (${list}). No se cambió nada; vuelve a leerlo y propón el cambio otra vez.`));
}

/**
 * Equality filter on the write, so nothing changes in between the re-read and the write: every
 * stored field behind the snapshot, exactly as read (`null` = missing), plus the keyword match mode
 * the service writes back. The access rule is compared as the stored object (same key order).
 */
function writeGuard(command: LeanCommand): Record<string, unknown> {
    const stored = command as unknown as Record<string, unknown>;
    const guard: Record<string, unknown> = {};
    for (const key of ['cmd', 'name', 'message', 'cooldown', 'enabled', 'userLevel', 'description', 'activation', 'authoring', 'reserved', 'permissionExpression'] as const) {
        guard[key] = stored[key] ?? null;
    }
    if (command.activation === 'keyword') {
        guard['keywordSettings.matchMode'] = (stored.keywordSettings as { matchMode?: unknown } | null | undefined)?.matchMode ?? null;
    }
    return guard;
}

type Fields = Record<string, unknown>;

function keys(lang: Lang, keyword: boolean) {
    return {
        trigger: keyword ? l(lang, 'Keyword', 'Palabra clave') : l(lang, 'Command', 'Comando'),
        reply: l(lang, 'Reply', 'Respuesta'),
        access: l(lang, 'Who can use it', 'Quién puede usarlo'),
        cooldown: l(lang, 'Cooldown (seconds)', 'Tiempo de espera (segundos)'),
        enabled: l(lang, 'On', 'Activo'),
        description: l(lang, 'Description', 'Descripción'),
        editor: l(lang, 'Editor', 'Editor'),
    };
}

/** Display-safe fields of a stored command for the before → after card. */
function displayCommand(command: LeanCommand, lang: Lang, only?: Set<string>): Fields {
    const k = keys(lang, command.activation === 'keyword');
    const blocks = command.authoring === 'blocks';
    const fields: Fields = {
        [k.trigger]: triggerLabel(command),
        [k.reply]: runsBuiltInCode(command) || command.reserved ? l(lang, '(built-in)', '(integrado)')
            : blocks && !command.message ? l(lang, '(built with blocks)', '(hecho con bloques)') : String(command.message ?? ''),
        // Only worth showing for block commands (or when the editor changes).
        ...(blocks || only?.has(k.editor) ? { [k.editor]: blocks ? l(lang, 'Blocks', 'Bloques') : l(lang, 'Text', 'Texto') } : {}),
        [k.access]: accessLabel(command, lang),
        [k.cooldown]: Number(command.cooldown ?? 0),
        [k.enabled]: command.enabled !== false,
        [k.description]: command.reserved ? '' : String(command.description ?? ''),
    };
    if (!only) return fields;
    const picked: Fields = {};
    for (const [key, value] of Object.entries(fields)) if (only.has(key)) picked[key] = value;
    return picked;
}

function plainMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Service errors → conflict (target changed) or a plain failure the user sees. */
function serviceError(error: unknown, label: string, lang: Lang): Error {
    if (error instanceof ToolConflictError) return error;
    if (error instanceof CommandMutationError && (error.status === 409 || error.status === 404)) {
        return new ToolConflictError(error.status === 404
            ? l(lang, `${label} no longer exists.`, `${label} ya no existe.`)
            : l(lang, `${label}: ${error.message}. Nothing was changed.`, `${label}: ${error.message}. No se cambió nada.`));
    }
    if (error instanceof CommandCooldownError && /0-second|Another command is being saved/.test(error.message)) {
        return new ToolConflictError(error.message);
    }
    if (error instanceof CommandMutationError || error instanceof CommandBlocksRequestError || error instanceof CommandCooldownError) {
        return new Error(error.message);
    }
    return error instanceof Error ? error : new Error(plainMessage(error));
}

async function readById(channelId: string, id: string, withBlocks = false): Promise<LeanCommand | null> {
    const query = CommandsSchema.findOne({ channelID: channelId, _id: id });
    if (withBlocks) query.select('+blocks');
    return await query.lean() as unknown as LeanCommand | null;
}

// ---------------------------------------------------------------------------
// Input checks shared by create and update
// ---------------------------------------------------------------------------

function normalizeTrigger(raw: string): string {
    const trigger = raw.trim().replace(/^!+/, '').toLowerCase();
    if (!TRIGGER_PATTERN.test(trigger)) {
        throw new ToolInputError('name must be what viewers type after "!": 1-30 letters or numbers, no spaces or symbols (e.g. "dice")');
    }
    return trigger;
}

function checkBody(body: string | undefined): string | undefined {
    if (body === undefined) return undefined;
    if (!body.trim()) throw new ToolInputError('body is empty');
    if (body.length > MAX_COMMAND_TEXT) throw new ToolInputError(`body is too long (${body.length} of ${MAX_COMMAND_TEXT} characters)`);
    if (/^\s*!(cc|ec|dc)\s/i.test(body)) throw new ToolInputError('body is only the reply, not a whole !cc/!ec line');
    return body;
}

/** Names the bot keeps for itself: built-in commands and names whose built-in code would run instead of the reply. */
function builtInNameProblem(trigger: string, lang: Lang): { refuse?: string; warn?: string } {
    const definition = getReservedCommandDefinition({ cmd: trigger, func: '' });
    if (definition?.reserved || BUILT_IN_FUNCS.has(trigger)) {
        return { refuse: `!${trigger} is a built-in command name: the bot would run its own code instead of this reply. Pick another name.` };
    }
    if (definition) {
        return { warn: l(lang, `!${trigger} is the name of one of the bot's default commands; this custom command takes its place.`,
            `!${trigger} es el nombre de un comando predeterminado del bot; este comando personalizado ocupa su lugar.`) };
    }
    return {};
}

async function checkCooldown(ctx: ToolContext, cooldown: number, current: LeanCommand | null): Promise<void> {
    const keyword = current?.activation === 'keyword';
    const minimum = getMinimumCommandCooldown(ctx.plan);
    if (keyword) {
        if (cooldown < minimum) throw new ToolInputError(`Keyword cooldown must be at least ${minimum} seconds on this plan`);
        return;
    }
    if (cooldown !== 0 && cooldown < minimum) throw new ToolInputError(`cooldown must be 0 or ${minimum}-${MAX_COOLDOWN} seconds on this plan`);
    if (cooldown === 0 && Number(current?.cooldown) !== 0) {
        if (current?.reserved) throw new ToolInputError('Built-in commands can\'t use the 0-second cooldown');
        const taken = await CommandsSchema.exists({ channelID: ctx.channelId, cooldown: 0, reserved: { $ne: true }, ...(current ? { _id: { $ne: current._id } } : {}) });
        if (taken) throw new ToolInputError('Only one editable command per channel can have a 0-second cooldown, and another command already has it');
    }
}

function levelNumber(level: AccessLevel): number {
    return ACCESS_LEVELS.indexOf(level) + 1;
}

/** The repeat part of a change: the stored timer it expects and what it becomes (null = none). */
interface RepeatMove { from: TimerSnapshot | null; to: RepeatTarget | null }

const REPEAT_HELP =
    'repeatMinutes makes the bot also post the reply by itself every N minutes while the stream is live: this is '
    + 'what the Commands page shows under "Repeating", and the way to make any repeating message or timer. ' + REPEAT_RULES;

/** The card's fields plus its "Repeats" row. */
function withRepeat(fields: Fields, repeat: { minutes: number; active: boolean } | null, lang: Lang): Fields {
    return { ...fields, [repeatKey(lang)]: repeatLabel(repeat, lang) };
}

const postsAlone = (minutes: number, lang: Lang) => l(lang,
    `Posts by itself every ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} while you are live`,
    `Se publica solo cada ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} mientras estás en vivo`);

/** A command write the service refused before writing anything (validation, a failed guard, a taken name). */
const refusedWrite = (error: unknown) => error instanceof ToolConflictError || error instanceof CommandMutationError
    || error instanceof CommandCooldownError || error instanceof CommandBlocksRequestError;

/** The command's repeat right after a change, kept in the undo data: undo first checks it is still like this. */
async function repeatAsLeft(ctx: { channelId: string }, command: LeanCommand): Promise<TimerSnapshot | null> {
    const timer = await commandRepeat(ctx.channelId, command);
    return timer ? timerSnapshot(timer) : null;
}

/**
 * Before an undo that deletes, renames or re-words the command: its repeat must still be as this
 * change left it (`left`). Records from before this was stored (`left` undefined) are refused when
 * the command has a repeat now, since nothing says whose it is.
 */
async function assertUndoKeepsRepeat(ctx: { channelId: string; lang: Lang }, command: LeanCommand, left: TimerSnapshot | null | undefined, label: string): Promise<void> {
    if (left !== undefined) return await assertRepeatAsLeft(ctx, command, left, label);
    if (await commandRepeat(ctx.channelId, command)) {
        throw new ToolConflictError(l(ctx.lang, `${label} repeats now, and this older change does not say how to carry that along. Stop the repeat first, then undo.`,
            `${label} ahora se repite, y este cambio anterior no indica cómo llevarlo consigo. Detén primero la repetición y luego deshaz.`));
    }
}

/**
 * The "command write" of a change that only moves the repeat: there is nothing to write, so no
 * write carries a guard. Reading the command again AFTER the repeat was written closes that gap: a
 * command deleted or edited in between is noticed here, and `changeWithRepeat` moves the repeat back.
 */
async function unchangedCommand(ctx: { channelId: string; lang: Lang }, id: string, expected: CommandSnapshot, label: string, after: boolean): Promise<LeanCommand> {
    const fresh = await readById(ctx.channelId, id);
    if (!fresh) throw new ToolConflictError(l(ctx.lang, `${label} was deleted in the meantime. Nothing was changed.`, `${label} se borró mientras tanto. No se cambió nada.`));
    const fields = changedFields(expected, commandSnapshot(fresh), ctx.lang);
    if (fields.length) throw conflict(label, fields, ctx.lang, after);
    return fresh;
}

/**
 * A change with a repeat half. The repeat goes first (one guarded write, see `moveRepeat`): if it is
 * refused, nothing was written and the change stops there. Then the command write: if the service
 * refuses it, the repeat is moved back (guarded: only while it still is what this change made it),
 * so the change stays all or nothing and the refusal is passed on. When the repeat cannot be moved
 * back, or the command write's outcome is unknown, the error is a plain one: the card then reports
 * an unknown outcome instead of claiming nothing changed.
 * `after` = undoing (see `moveRepeat`). Returns the write's result and the repeat as stored afterwards.
 */
async function changeWithRepeat<T>(ctx: { channelId: string; lang: Lang; plan: string }, repeat: RepeatMove | null | undefined, after: boolean, label: string, write: () => Promise<T>): Promise<{ result: T; saved: TimerSnapshot | null }> {
    if (!repeat) return { result: await write(), saved: null };
    let saved: TimerSnapshot | null;
    try {
        saved = await moveRepeat(ctx, repeat.from, repeat.to, after);
    } catch (error) {
        if (!(error instanceof RepeatRefused)) throw error;
        const reason = error.message.replace(/[.\s]+$/, '');
        throw new ToolConflictError(l(ctx.lang, `The repeat of ${label} could not be saved (${reason}), so nothing was changed.`,
            `No se pudo guardar la repetición de ${label} (${reason}), así que no se cambió nada.`));
    }
    try {
        return { result: await write(), saved };
    } catch (error) {
        if (!refusedWrite(error)) throw error;
        try {
            await moveRepeat(ctx, saved, repeat.from ? repeatTarget(repeat.from) : null, true);
        } catch (backError) {
            throw new Error(`${label} was not changed (${plainMessage(error)}), but its repeat already was and could not be put back: ${plainMessage(backError)}`);
        }
        throw error;
    }
}

async function effectsFor(body: string, ctx: ToolContext): Promise<{ effects: string[]; warnings: string[] }> {
    const described = await describeCommandEffects(body, { plan: ctx.plan, lang: ctx.lang });
    return {
        effects: described.effects,
        warnings: described.problems.map((problem) => l(ctx.lang, `Test run: ${problem}`, `Prueba: ${problem}`)),
    };
}

// ---------------------------------------------------------------------------
// create_command
// ---------------------------------------------------------------------------

interface CreateInput { name: string; body: string; access: AccessLevel; cooldown: number; enabled: boolean; description: string; repeatMinutes?: number }

export const createCommandTool: AgentTool<CreateInput> = {
    name: 'create_command',
    description:
        'Propose a new custom chat command (!name). The user sees a card with the command and what it can do, and '
        + 'nothing happens until they press Apply. name = what viewers type after "!" (letters/numbers only). '
        + 'access = the lowest role that can use it (default everyone). cooldown = seconds between uses (default 10; '
        + '0 or the plan minimum (Free 5, Premium 3, Pro 1) up to 60; only one command per channel may use 0). '
        + 'Fails if the name exists (use update_command) or is a built-in name. ' + REPEAT_HELP + ' ' + COMMAND_LANGUAGE_BASICS,
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', maxLength: 31, description: 'What viewers type after "!", e.g. "dice".' },
            body: { type: 'string', maxLength: MAX_COMMAND_TEXT, description: 'The reply body (command language). Test it with test_command first.' },
            access: { type: 'string', enum: [...ACCESS_LEVELS], description: 'Lowest role that can use it. Default everyone.' },
            cooldown: { type: 'integer', minimum: 0, maximum: MAX_COOLDOWN, description: 'Seconds between uses. Default 10.' },
            enabled: { type: 'boolean', description: 'Default true.' },
            description: { type: 'string', maxLength: MAX_DESCRIPTION, description: 'Short note shown on the Commands page and in !commands.' },
            repeatMinutes: { type: 'integer', minimum: 1, maximum: 180, description: 'Also post the reply by itself every this many minutes while live (plan rules apply). Leave out for a normal command.' },
        },
        required: ['name', 'body'],
        additionalProperties: false,
    },
    kind: 'write',
    permissions: PERMISSIONS,
    label: (input, lang) => l(lang, `Preparing !${input.name}…`, `Preparando !${input.name}…`),
    validate(raw) {
        const input = asObject(raw);
        const repeatMinutes = int(input, 'repeatMinutes', { min: 1, max: 1440 });
        return {
            name: normalizeTrigger(str(input, 'name', { required: true, max: 31 })!),
            body: checkBody(str(input, 'body', { required: true }))!,
            access: oneOf(input, 'access', ACCESS_LEVELS) ?? 'everyone',
            cooldown: int(input, 'cooldown', { min: 0, max: MAX_COOLDOWN }) ?? 10,
            enabled: bool(input, 'enabled') ?? true,
            description: str(input, 'description', { max: MAX_DESCRIPTION }) ?? '',
            ...(repeatMinutes !== undefined ? { repeatMinutes } : {}),
        };
    },
    async run(input, ctx) {
        const clash = builtInNameProblem(input.name, ctx.lang);
        if (clash.refuse) throw new ToolInputError(clash.refuse);
        const existing = await findChannelCommand(ctx.channelId, input.name, 'command');
        if (existing) throw new ToolInputError(`${triggerLabel(existing)} already exists on this channel. Use update_command to change it.`);
        await checkCooldown(ctx, input.cooldown, null);

        const { effects, warnings } = await effectsFor(input.body, ctx);
        if (clash.warn) warnings.unshift(clash.warn);
        // A timer already named like this command (made in chat) becomes its repeat on the website.
        const timer = await readTimer(ctx.channelId, input.name);
        let repeat: RepeatMove | null = null;
        if (input.repeatMinutes !== undefined) {
            const to: RepeatTarget = { name: input.name.toLowerCase(), minutes: input.repeatMinutes, message: input.body, active: true };
            await checkRepeat(ctx, to, timer);
            repeat = { from: timer ? timerSnapshot(timer) : null, to };
            effects.push(postsAlone(to.minutes, ctx.lang));
        } else if (timer) {
            const minutes = timerSnapshot(timer).minutes;
            warnings.push(l(ctx.lang, `A repeating message "${timer.name}" already exists (every ${minutes} minutes). It will show as this command's repeat and keeps its own text.`,
                `Ya existe un mensaje repetido "${timer.name}" (cada ${minutes} minutos). Se mostrará como la repetición de este comando y conserva su propio texto.`));
        }
        const shownRepeat = repeat?.to ?? (timer ? timerSnapshot(timer) : null);
        const preview = { cmd: input.name, message: input.body, userLevel: levelNumber(input.access), cooldown: input.cooldown, enabled: input.enabled, description: input.description, _id: null } as unknown as LeanCommand;
        const after = displayCommand(preview, ctx.lang);
        const proposal: ChangeProposal = {
            tool: 'create_command',
            title: l(ctx.lang, `Create command !${input.name}`, `Crear comando !${input.name}`),
            area: AREA,
            target: { type: 'command', id: null, label: `!${input.name}` },
            before: null,
            after: shownRepeat ? withRepeat(after, shownRepeat, ctx.lang) : after,
            effects,
            ...(warnings.length ? { warnings } : {}),
            permissions: [...PERMISSIONS],
            payload: { input, expected: null, ...(repeat ? { repeat } : {}) },
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { input, repeat } = proposal.payload as { input: CreateInput; repeat?: RepeatMove };
        const label = `!${input.name}`;
        const existing = await findChannelCommand(ctx.channelId, input.name, 'command');
        if (existing) {
            throw new ToolConflictError(l(ctx.lang, `${label} was created by someone else in the meantime. Nothing was changed.`,
                `Alguien más creó ${label} mientras tanto. No se cambió nada.`));
        }
        const level = levelNumber(input.access);
        const body: CommandWriteBody = {
            name: input.name, cmd: input.name, func: input.name, message: input.body, channel: ctx.channelLogin || ctx.channelId,
            cooldown: input.cooldown, userLevel: level, userLevelName: LEGACY_USER_LEVEL_NAMES[level], enabled: input.enabled,
            description: input.description,
        };
        let outcome;
        try {
            outcome = await changeWithRepeat(ctx, repeat, false, label, () => createChannelCommand(ctx.channelId, body));
        } catch (error) {
            throw serviceError(error, label, ctx.lang);
        }
        const stored = outcome.result.command.toObject() as unknown as LeanCommand;
        const repeatUndo: RepeatMove | null = repeat ? { from: outcome.saved, to: repeat.from ? repeatTarget(repeat.from) : null } : null;
        const change: ChangeRecordInput = {
            area: AREA,
            target: { type: 'command', id: String(stored._id), label },
            before: null,
            after: proposal.after,
            undo: { op: 'create', id: String(stored._id), expected: commandSnapshot(stored), ...(repeatUndo ? { repeat: repeatUndo } : {}), repeatAfter: await repeatAsLeft(ctx, stored) },
            summary: repeat?.to ? `Created ${label} (repeats every ${repeat.to.minutes} min)` : `Created ${label}`,
        };
        return { result: { created: true, id: String(stored._id), trigger: label, ...(repeat?.to ? { repeatsEveryMinutes: repeat.to.minutes } : {}) }, change };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; expected: CommandSnapshot; repeat?: RepeatMove; repeatAfter?: TimerSnapshot | null } | null;
        if (!data?.id) throw new ToolConflictError('Nothing to undo');
        const label = change.target.label;
        const current = await readById(ctx.channelId, data.id);
        if (!current) throw new ToolConflictError(l(ctx.lang, `${label} was already deleted.`, `${label} ya se había borrado.`));
        const fields = changedFields(data.expected, commandSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label, fields, ctx.lang, true);
        // Deleting the command: a repeat it got since (from a later change) would be left posting.
        await assertUndoKeepsRepeat(ctx, current, data.repeatAfter, label);
        try {
            await changeWithRepeat(ctx, data.repeat, true, label, () => deleteChannelCommand(ctx.channelId, data.id, { guard: writeGuard(current) }));
        } catch (error) {
            throw serviceError(error, label, ctx.lang);
        }
    },
};

// ---------------------------------------------------------------------------
// update_command
// ---------------------------------------------------------------------------

interface UpdateChanges { body?: string; access?: AccessLevel; cooldown?: number; enabled?: boolean; description?: string; newName?: string; /** Internal: the body replaces a block reply. */ fromBlocks?: boolean }
interface UpdateInput extends UpdateChanges { name: string; kind?: 'command' | 'keyword'; /** Repeat interval; 0 stops the repeat. */ repeatMinutes?: number }

/** Service request body that turns `current` into the requested state. */
function updateBody(current: LeanCommand, changes: UpdateChanges): CommandWriteBody {
    const body: CommandWriteBody = {};
    if (changes.newName !== undefined) {
        body.cmd = changes.newName;
        // A display name that just repeated the trigger follows the rename.
        if (!current.name || current.name === current.cmd) body.name = changes.newName;
    }
    if (changes.body !== undefined) body.message = changes.body;
    // A block command becomes a text command (the service drops its blocks).
    if (changes.body !== undefined && changes.fromBlocks) body.authoring = 'text';
    if (changes.description !== undefined) body.description = changes.description;
    if (changes.cooldown !== undefined) body.cooldown = changes.cooldown;
    if (changes.enabled !== undefined) body.enabled = changes.enabled;
    if (changes.access !== undefined) {
        const level = levelNumber(changes.access);
        body.userLevel = level;
        body.userLevelName = LEGACY_USER_LEVEL_NAMES[level];
        if (inspectExpression(current.permissionExpression).mode !== 'level') body.permissionExpression = null;
    }
    return body;
}

/** Service request body that puts back what `updateBody` changed. */
function restoreBody(previous: LeanCommand, changes: UpdateChanges): CommandWriteBody {
    const body: CommandWriteBody = {};
    if (changes.newName !== undefined) {
        body.cmd = previous.cmd;
        if (!previous.name || previous.name === previous.cmd) body.name = previous.name ?? previous.cmd;
    }
    if (changes.body !== undefined && changes.fromBlocks) {
        // Put the blocks back (the service recompiles them into the text the bot runs).
        body.authoring = 'blocks';
        body.blocks = (previous as unknown as { blocks?: unknown }).blocks;
    } else if (changes.body !== undefined) body.message = String(previous.message ?? '');
    if (changes.description !== undefined) body.description = String(previous.description ?? '');
    if (changes.cooldown !== undefined) body.cooldown = Number(previous.cooldown ?? 0);
    if (changes.enabled !== undefined) body.enabled = previous.enabled !== false;
    if (changes.access !== undefined) {
        const mode = inspectExpression(previous.permissionExpression).mode;
        if (mode === 'tags') body.permissionExpression = previous.permissionExpression;
        else {
            const level = Math.min(10, Math.max(1, Number(previous.userLevel) || 1));
            body.userLevel = level;
            body.userLevelName = typeof previous.userLevelName === 'string' && previous.userLevelName ? previous.userLevelName : LEGACY_USER_LEVEL_NAMES[level];
            if (mode !== 'level') body.permissionExpression = null;
        }
    }
    return body;
}

export const updateCommandTool: AgentTool<UpdateInput> = {
    name: 'update_command',
    description:
        'Propose changes to an existing command or keyword: body (new reply), access, cooldown, enabled (turn it on '
        + 'or off), description, newName (rename the trigger), repeatMinutes (make a command repeat every N minutes, '
        + 'change how often, or 0 to stop repeating). Send only what changes. The user approves a card '
        + 'showing before → after; nothing changes until then. Built-in commands: only enabled, access, cooldown and '
        + 'newName. Commands made with blocks: get_command shows the text they run; a body replaces the blocks with a text reply (warned on the card, undo restores the blocks). Changing '
        + 'access replaces a custom access rule with a simple level. A command\'s repeat follows a new reply or name by '
        + 'itself. ' + REPEAT_HELP + ' ' + COMMAND_LANGUAGE_BASICS,
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', maxLength: 80, description: 'Current trigger ("!dice"), keyword phrase or id.' },
            kind: { type: 'string', enum: ['command', 'keyword'], description: 'Only when a command and a keyword share a name.' },
            body: { type: 'string', maxLength: MAX_COMMAND_TEXT, description: 'New reply body. Test it with test_command first.' },
            access: { type: 'string', enum: [...ACCESS_LEVELS] },
            cooldown: { type: 'integer', minimum: 0, maximum: MAX_COOLDOWN, description: 'Seconds between uses.' },
            enabled: { type: 'boolean' },
            description: { type: 'string', maxLength: MAX_DESCRIPTION },
            newName: { type: 'string', maxLength: 60, description: 'New trigger (commands: letters/numbers; keywords: a word or phrase).' },
            repeatMinutes: { type: 'integer', minimum: 0, maximum: 180, description: 'Custom commands only: post the reply by itself every this many minutes while live; 0 stops the repeat.' },
        },
        required: ['name'],
        additionalProperties: false,
    },
    kind: 'write',
    permissions: PERMISSIONS,
    label: (input, lang) => l(lang, `Preparing changes to ${input.name}…`, `Preparando cambios en ${input.name}…`),
    validate(raw) {
        const input = asObject(raw);
        const parsed: UpdateInput = {
            name: str(input, 'name', { required: true, max: 80 })!,
            kind: oneOf(input, 'kind', ['command', 'keyword'] as const),
            body: checkBody(str(input, 'body')),
            access: oneOf(input, 'access', ACCESS_LEVELS),
            cooldown: int(input, 'cooldown', { min: 0, max: MAX_COOLDOWN }),
            enabled: bool(input, 'enabled'),
            description: typeof input.description === 'string' ? str(input, 'description', { max: MAX_DESCRIPTION }) ?? '' : undefined,
            newName: str(input, 'newName', { max: 60 }),
        };
        const repeatMinutes = int(input, 'repeatMinutes', { min: 0, max: 1440 });
        if (repeatMinutes !== undefined) parsed.repeatMinutes = repeatMinutes;
        if ([parsed.body, parsed.access, parsed.cooldown, parsed.enabled, parsed.description, parsed.newName, parsed.repeatMinutes].every((value) => value === undefined)) {
            throw new ToolInputError('Nothing to change: send at least one of body, access, cooldown, enabled, description, newName, repeatMinutes');
        }
        return parsed;
    },
    async run(input, ctx) {
        const current = await findChannelCommand(ctx.channelId, input.name, input.kind);
        if (!current) throw new ToolInputError(`No command or keyword "${input.name}" on this channel. Use list_commands.`);
        const keyword = current.activation === 'keyword';
        const label = triggerLabel(current);
        const warnings: string[] = [];
        const changes: UpdateChanges = {};

        if (input.body !== undefined) {
            if (current.reserved || runsBuiltInCode(current)) throw new ToolInputError(`${label} is built in: the bot runs its own code, so its reply can't be changed.`);
            if (current.authoring === 'blocks') {
                changes.body = input.body;
                changes.fromBlocks = true;
                warnings.push(l(ctx.lang, `${label} is made with blocks: this text reply replaces its blocks (it becomes a text command). Undo puts the blocks back.`,
                    `${label} está hecho con bloques: esta respuesta de texto reemplaza sus bloques (pasa a ser un comando de texto). Deshacer regresa los bloques.`));
            } else if (input.body !== current.message) changes.body = input.body;
        }
        if (input.description !== undefined) {
            if (current.reserved) throw new ToolInputError(`${label} is built in: its description can't be changed.`);
            if (input.description !== String(current.description ?? '')) changes.description = input.description;
        }
        if (input.newName !== undefined) {
            let next: string;
            if (keyword) {
                try { validateKeyword(input.newName, current.keywordSettings ?? { matchMode: 'start' }); } catch (error) { throw new ToolInputError(plainMessage(error)); }
                next = normalizeKeyword(input.newName);
            } else {
                next = normalizeTrigger(input.newName);
                const clash = builtInNameProblem(next, ctx.lang);
                if (clash.refuse) throw new ToolInputError(clash.refuse);
                if (clash.warn) warnings.push(clash.warn);
            }
            if (next !== current.cmd) {
                const taken = await CommandsSchema.exists({ channelID: ctx.channelId, _id: { $ne: current._id }, cmd: new RegExp(`^${escapeRegExp(next)}$`, 'i'),
                    ...(keyword ? { activation: 'keyword' } : { activation: { $ne: 'keyword' } }) });
                if (taken) throw new ToolInputError(`${keyword ? `"${next}"` : `!${next}`} is already used on this channel`);
                changes.newName = next;
            }
        }
        if (input.cooldown !== undefined && input.cooldown !== Number(current.cooldown ?? 0)) {
            await checkCooldown(ctx, input.cooldown, current);
            changes.cooldown = input.cooldown;
        }
        if (input.enabled !== undefined && input.enabled !== (current.enabled !== false)) changes.enabled = input.enabled;
        if (input.access !== undefined) {
            const mode = inspectExpression(current.permissionExpression).mode;
            if (mode !== 'level' || accessLevelFromNumber(current.userLevel) !== input.access) {
                changes.access = input.access;
                if (mode !== 'level') {
                    warnings.push(l(ctx.lang, 'This replaces the custom access rule set on the Commands page.', 'Esto reemplaza la regla de acceso personalizada de la página de Comandos.'));
                }
            }
        }
        const next = { ...current, ...(changes.newName !== undefined ? { cmd: changes.newName } : {}),
            ...(changes.body !== undefined ? { message: changes.body, ...(changes.fromBlocks ? { authoring: 'text' } : {}) } : {}),
            ...(changes.description !== undefined ? { description: changes.description } : {}),
            ...(changes.cooldown !== undefined ? { cooldown: changes.cooldown } : {}),
            ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
            ...(changes.access !== undefined ? { userLevel: levelNumber(changes.access), permissionExpression: null } : {}) } as LeanCommand;

        // The repeat (the timer named like the command) follows a new name or reply, and repeatMinutes sets it.
        if (input.repeatMinutes !== undefined && !canRepeat(current)) {
            throw new ToolInputError(`${label} can't repeat: only custom commands can (not keywords or built-in commands).`);
        }
        /** What moves (null = the repeat stays as it is). */
        let repeat: RepeatMove | null = null;
        /** What Apply checks: the move, or just "still as it was" when the change depends on the repeat (reply, name). */
        let expectedRepeat: RepeatMove | null = null;
        if (canRepeat(current)) {
            const timer = await commandRepeat(ctx.channelId, current);
            const from = timer ? timerSnapshot(timer) : null;
            const nextName = String(next.cmd).toLowerCase();
            let to: RepeatTarget | null = from ? repeatTarget(from) : null;
            if (input.repeatMinutes === 0) to = null;
            else if (input.repeatMinutes !== undefined) to = { name: nextName, minutes: input.repeatMinutes, message: repeatMessage(next), active: true };
            else if (from && to) {
                const viaBlocks = from.message === `#(${current.cmd})`;
                if (changes.newName !== undefined) {
                    to.name = nextName;
                    if (viaBlocks) to.message = `#(${next.cmd})`;
                }
                if (changes.body !== undefined && !viaBlocks) {
                    if (from.message === String(current.message ?? '')) to.message = repeatMessage(next);
                    else {
                        warnings.push(l(ctx.lang, `The repeat of ${label} posts its own text (not this reply), so it stays as it is.`,
                            `La repetición de ${label} publica su propio texto (no esta respuesta), así que se queda como está.`));
                    }
                }
            }
            if (repeatDiffers(from, to)) {
                if (to) await checkRepeat(ctx, to, timer);
                repeat = { from, to };
            }
            expectedRepeat = repeat ?? (changes.body !== undefined || changes.newName !== undefined ? { from, to } : null);
        }
        if (Object.keys(changes).length === 0 && !repeat) throw new ToolInputError(`${label} already looks like that: nothing to change.`);

        const before = displayCommand(current, ctx.lang);
        const after = displayCommand(next, ctx.lang);
        const shown = new Set(Object.keys(before).filter((key) => stableJson(before[key]) !== stableJson(after[key])));
        const k = keys(ctx.lang, keyword);
        shown.add(k.trigger);
        const repeatShown = repeat !== null && repeatLabel(repeat.from, ctx.lang) !== repeatLabel(repeat.to, ctx.lang);
        const startsRepeating = repeat?.to != null && (!repeat.from || !repeat.from.active || repeat.from.minutes !== repeat.to.minutes);

        let effects: string[] = [];
        const textBody = (current.authoring !== 'blocks' || changes.fromBlocks === true) && !current.reserved && !runsBuiltInCode(current);
        if (textBody && (changes.body !== undefined || changes.enabled === true || startsRepeating)) {
            const described = await effectsFor(String(next.message ?? ''), ctx);
            effects = described.effects;
            warnings.push(...described.warnings);
        }
        if (startsRepeating) effects.push(postsAlone(repeat!.to!.minutes, ctx.lang));

        const onlyRepeat = repeat !== null && Object.keys(changes).length === 0;
        const title = keyword
            ? l(ctx.lang, `Update keyword ${label}`, `Editar palabra clave ${label}`)
            : onlyRepeat && !repeat!.to ? l(ctx.lang, `Stop repeating ${label}`, `Dejar de repetir ${label}`)
            : onlyRepeat && !repeat!.from ? l(ctx.lang, `Repeat ${label} every ${repeat!.to!.minutes} minutes`, `Repetir ${label} cada ${repeat!.to!.minutes} minutos`)
            : onlyRepeat ? l(ctx.lang, `Change the repeat of ${label}`, `Cambiar la repetición de ${label}`)
            : l(ctx.lang, `Update command ${label}`, `Editar comando ${label}`);
        const beforeFields = displayCommand(current, ctx.lang, shown);
        const afterFields = displayCommand(next, ctx.lang, shown);
        const proposal: ChangeProposal = {
            tool: 'update_command',
            title,
            area: AREA,
            target: { type: keyword ? 'keyword' : 'command', id: String(current._id), label },
            before: repeatShown ? withRepeat(beforeFields, repeat!.from, ctx.lang) : beforeFields,
            after: repeatShown ? withRepeat(afterFields, repeat!.to, ctx.lang) : afterFields,
            effects,
            ...(warnings.length ? { warnings } : {}),
            permissions: [...PERMISSIONS],
            payload: { id: String(current._id), changes, expected: commandSnapshot(current), ...(expectedRepeat ? { repeat: expectedRepeat } : {}) },
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, changes, expected, repeat } = proposal.payload as { id: string; changes: UpdateChanges; expected: CommandSnapshot; repeat?: RepeatMove };
        const label = proposal.target.label;
        const current = await readById(ctx.channelId, id, changes.fromBlocks === true);
        if (!current) throw new ToolConflictError(l(ctx.lang, `${label} was deleted in the meantime. Nothing was changed.`, `${label} se borró mientras tanto. No se cambió nada.`));
        const fields = changedFields(expected, commandSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label, fields, ctx.lang);
        // The change counts on the command's repeat being the timer the proposal saw (or on there being none).
        if (repeat) await assertRepeatLink(ctx, current, repeat.from, label);
        const hasChanges = Object.keys(changes).length > 0;
        let outcome;
        try {
            outcome = await changeWithRepeat(ctx, repeat, false, label, async () => hasChanges
                ? (await updateChannelCommand(ctx.channelId, id, updateBody(current, changes), { guard: writeGuard(current), language: ctx.lang })).command.toObject() as unknown as LeanCommand
                : await unchangedCommand(ctx, id, expected, label, false));
        } catch (error) {
            throw serviceError(error, label, ctx.lang);
        }
        const stored = outcome.result;
        const moved = repeat !== undefined && repeatDiffers(repeat.from, repeat.to);
        const repeatUndo: RepeatMove | null = moved ? { from: outcome.saved, to: repeat!.from ? repeatTarget(repeat!.from) : null } : null;
        const newLabel = triggerLabel(stored);
        const change: ChangeRecordInput = {
            area: AREA,
            target: { type: proposal.target.type, id, label: newLabel },
            before: proposal.before,
            after: proposal.after,
            undo: {
                op: 'update', id, restore: hasChanges ? restoreBody(current, changes) : {}, expected: commandSnapshot(stored),
                ...(repeatUndo ? { repeat: repeatUndo } : {}), ...(canRepeat(stored) ? { repeatAfter: await repeatAsLeft(ctx, stored) } : {}),
            },
            summary: `Updated ${newLabel}`,
        };
        return { result: { updated: true, id, trigger: newLabel, ...(moved ? { repeatsEveryMinutes: repeat!.to ? repeat!.to.minutes : null } : {}) }, change };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; restore: CommandWriteBody; expected: CommandSnapshot; repeat?: RepeatMove; repeatAfter?: TimerSnapshot | null } | null;
        if (!data?.id || !data.restore) throw new ToolConflictError('Nothing to undo');
        const label = change.target.label;
        const current = await readById(ctx.channelId, data.id);
        if (!current) throw new ToolConflictError(l(ctx.lang, `${label} was deleted, so there is nothing to restore.`, `${label} se borró, así que no hay nada que restaurar.`));
        const fields = changedFields(data.expected, commandSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label, fields, ctx.lang, true);
        // Putting back a name or a reply (or the repeat itself): the repeat must still be as this change left it.
        // An undo of only the cooldown, access, on/off or description has nothing to do with it.
        const touchesRepeat = data.repeat !== undefined || ['cmd', 'message', 'authoring'].some((key) => key in data.restore);
        if (touchesRepeat && canRepeat(current)) await assertUndoKeepsRepeat(ctx, current, data.repeatAfter, label);
        try {
            await changeWithRepeat(ctx, data.repeat, true, label, async () => {
                if (Object.keys(data.restore).length) await updateChannelCommand(ctx.channelId, data.id, data.restore, { guard: writeGuard(current), language: ctx.lang });
                else await unchangedCommand(ctx, data.id, data.expected, label, true);
            });
        } catch (error) {
            throw serviceError(error, label, ctx.lang);
        }
    },
};

// ---------------------------------------------------------------------------
// delete_command
// ---------------------------------------------------------------------------

export const deleteCommandTool: AgentTool<{ name: string; kind?: 'command' | 'keyword' }> = {
    name: 'delete_command',
    description:
        'Propose deleting a custom command or keyword. The user approves a card first; it can be undone from the '
        + 'Changes list. Built-in commands can\'t be deleted (turn them off with update_command enabled=false). '
        + 'A command\'s repeat is removed with it (to stop only the repeating, use update_command repeatMinutes 0).',
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', maxLength: 80, description: 'Trigger ("!dice"), keyword phrase or id.' },
            kind: { type: 'string', enum: ['command', 'keyword'], description: 'Only when a command and a keyword share a name.' },
        },
        required: ['name'],
        additionalProperties: false,
    },
    kind: 'write',
    permissions: PERMISSIONS,
    label: (input, lang) => l(lang, `Preparing to delete ${input.name}…`, `Preparando el borrado de ${input.name}…`),
    validate(raw) {
        const input = asObject(raw);
        return { name: str(input, 'name', { required: true, max: 80 })!, kind: oneOf(input, 'kind', ['command', 'keyword'] as const) };
    },
    async run(input, ctx) {
        const current = await findChannelCommand(ctx.channelId, input.name, input.kind);
        if (!current) throw new ToolInputError(`No command or keyword "${input.name}" on this channel. Use list_commands.`);
        const label = triggerLabel(current);
        if (current.reserved) throw new ToolInputError(`${label} is built in and can't be deleted. Turn it off with update_command enabled=false instead.`);
        const keyword = current.activation === 'keyword';
        const warnings: string[] = [];
        // Like the commands page: the command's repeat goes with it, so nothing keeps posting unseen.
        const timer = await commandRepeat(ctx.channelId, current);
        const repeat: RepeatMove | null = timer ? { from: timerSnapshot(timer), to: null } : null;
        if (repeat) warnings.push(l(ctx.lang, `Its repeat (${repeatLabel(repeat.from, ctx.lang).toLowerCase()}) is removed too.`, `Su repetición (${repeatLabel(repeat.from, ctx.lang).toLowerCase()}) también se quita.`));
        const before = displayCommand(current, ctx.lang);
        const proposal: ChangeProposal = {
            tool: 'delete_command',
            title: keyword ? l(ctx.lang, `Delete keyword ${label}`, `Borrar palabra clave ${label}`) : l(ctx.lang, `Delete command ${label}`, `Borrar comando ${label}`),
            area: AREA,
            target: { type: keyword ? 'keyword' : 'command', id: String(current._id), label },
            before: repeat ? withRepeat(before, repeat.from, ctx.lang) : before,
            after: null,
            effects: [],
            ...(warnings.length ? { warnings } : {}),
            permissions: [...PERMISSIONS],
            payload: { id: String(current._id), expected: commandSnapshot(current), repeat: repeat ?? { from: null, to: null } },
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, expected, repeat } = proposal.payload as { id: string; expected: CommandSnapshot; repeat?: RepeatMove };
        const label = proposal.target.label;
        const current = await readById(ctx.channelId, id);
        if (!current) throw new ToolConflictError(l(ctx.lang, `${label} was already deleted.`, `${label} ya se había borrado.`));
        const fields = changedFields(expected, commandSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label, fields, ctx.lang);
        // The card promised "no repeat is left posting": the command's repeat must still be the one it showed (or none).
        await assertRepeatLink(ctx, current, repeat?.from ?? null, label);
        let deleted;
        try {
            deleted = (await changeWithRepeat(ctx, repeat?.from ? { from: repeat.from, to: null } : null, false, label, () => deleteChannelCommand(ctx.channelId, id, { guard: writeGuard(current) }))).result;
        } catch (error) {
            throw serviceError(error, label, ctx.lang);
        }
        const repeatUndo: RepeatMove | null = repeat?.from ? { from: null, to: repeatTarget(repeat.from) } : null;
        const change: ChangeRecordInput = {
            area: AREA,
            target: proposal.target,
            before: proposal.before,
            after: null,
            undo: { op: 'delete', raw: deleted.raw, ...(repeatUndo ? { repeat: repeatUndo } : {}) },
            summary: `Deleted ${label}`,
        };
        return { result: { deleted: true, id, trigger: label }, change };
    },
    async undo(change, ctx) {
        const data = change.undo as { raw: Record<string, unknown>; repeat?: RepeatMove } | null;
        if (!data?.raw) throw new ToolConflictError('Nothing to undo');
        try {
            await changeWithRepeat(ctx, data.repeat?.to ? { from: null, to: data.repeat.to } : null, true, change.target.label, () => restoreDeletedCommand(ctx.channelId, data.raw));
        } catch (error) {
            if (error instanceof CommandMutationError || error instanceof CommandCooldownError) {
                throw new ToolConflictError(l(ctx.lang, `${change.target.label} can't be restored: ${error.message}`, `${change.target.label} no se puede restaurar: ${error.message}`));
            }
            throw error;
        }
    },
};

export const commandTools: AgentTool[] = [createCommandTool, updateCommandTool, deleteCommandTool] as unknown as AgentTool[];
