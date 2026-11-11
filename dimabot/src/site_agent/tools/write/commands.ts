/**
 * Command write tools: create, update and delete chat commands (and update/delete keywords).
 * Two-phase: `run` checks everything and returns a proposal (no side effects); `apply` runs after
 * the user approves, re-reads the command and compares it with the proposal's snapshot
 * (compare-and-set), then writes through the same service the commands page uses
 * (`server/services/command_mutations.service.ts`). `undo` restores the previous state only if
 * the command still looks exactly like the assistant left it.
 *
 * Permissions mirror `server/routes/command.route.ts`: every write needs `commands:manage`.
 */
import { createHash } from 'node:crypto';
import type { AgentTool, ChangeProposal, ChangeRecordInput, Lang, ToolContext } from '../../types.js';
import { ToolConflictError, ToolInputError } from '../../types.js';
import { asObject, bool, int, oneOf, str, stableJson } from '../util.js';
import { describeCommandEffects } from '../effects.js';
import { CommandsSchema } from '../../../schemas/commands.schema.js';
import { CustomTimerSchema } from '../../../schemas/custom_timer.schema.js';
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

async function timerWarning(ctx: ToolContext, trigger: string): Promise<string | null> {
    const timer = await CustomTimerSchema.exists({ channelID: ctx.channelId, name: trigger.toLowerCase() });
    return timer ? l(ctx.lang, `The timer "${trigger.toLowerCase()}" still posts its own copy of the reply; change it with update_timer if it should match.`,
        `El temporizador "${trigger.toLowerCase()}" sigue publicando su propia copia de la respuesta; cámbialo con update_timer si debe coincidir.`) : null;
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

interface CreateInput { name: string; body: string; access: AccessLevel; cooldown: number; enabled: boolean; description: string }

export const createCommandTool: AgentTool<CreateInput> = {
    name: 'create_command',
    description:
        'Propose a new custom chat command (!name). The user sees a card with the command and what it can do, and '
        + 'nothing happens until they press Apply. name = what viewers type after "!" (letters/numbers only). '
        + 'access = the lowest role that can use it (default everyone). cooldown = seconds between uses (default 10; '
        + '0 or the plan minimum (Free 5, Premium 3, Pro 1) up to 60; only one command per channel may use 0). '
        + 'Fails if the name exists (use update_command) or is a built-in name. ' + COMMAND_LANGUAGE_BASICS,
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', maxLength: 31, description: 'What viewers type after "!", e.g. "dice".' },
            body: { type: 'string', maxLength: MAX_COMMAND_TEXT, description: 'The reply body (command language). Test it with test_command first.' },
            access: { type: 'string', enum: [...ACCESS_LEVELS], description: 'Lowest role that can use it. Default everyone.' },
            cooldown: { type: 'integer', minimum: 0, maximum: MAX_COOLDOWN, description: 'Seconds between uses. Default 10.' },
            enabled: { type: 'boolean', description: 'Default true.' },
            description: { type: 'string', maxLength: MAX_DESCRIPTION, description: 'Short note shown on the Commands page and in !commands.' },
        },
        required: ['name', 'body'],
        additionalProperties: false,
    },
    kind: 'write',
    permissions: PERMISSIONS,
    label: (input, lang) => l(lang, `Preparing !${input.name}…`, `Preparando !${input.name}…`),
    validate(raw) {
        const input = asObject(raw);
        return {
            name: normalizeTrigger(str(input, 'name', { required: true, max: 31 })!),
            body: checkBody(str(input, 'body', { required: true }))!,
            access: oneOf(input, 'access', ACCESS_LEVELS) ?? 'everyone',
            cooldown: int(input, 'cooldown', { min: 0, max: MAX_COOLDOWN }) ?? 10,
            enabled: bool(input, 'enabled') ?? true,
            description: str(input, 'description', { max: MAX_DESCRIPTION }) ?? '',
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
        const preview = { cmd: input.name, message: input.body, userLevel: levelNumber(input.access), cooldown: input.cooldown, enabled: input.enabled, description: input.description, _id: null } as unknown as LeanCommand;
        const proposal: ChangeProposal = {
            tool: 'create_command',
            title: l(ctx.lang, `Create command !${input.name}`, `Crear comando !${input.name}`),
            area: AREA,
            target: { type: 'command', id: null, label: `!${input.name}` },
            before: null,
            after: displayCommand(preview, ctx.lang),
            effects,
            ...(warnings.length ? { warnings } : {}),
            permissions: [...PERMISSIONS],
            payload: { input, expected: null },
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const input = (proposal.payload as { input: CreateInput }).input;
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
        let created;
        try {
            created = await createChannelCommand(ctx.channelId, body);
        } catch (error) {
            throw serviceError(error, label, ctx.lang);
        }
        const stored = created.command.toObject() as unknown as LeanCommand;
        const change: ChangeRecordInput = {
            area: AREA,
            target: { type: 'command', id: String(stored._id), label },
            before: null,
            after: proposal.after,
            undo: { op: 'create', id: String(stored._id), expected: commandSnapshot(stored) },
            summary: `Created ${label}`,
        };
        return { result: { created: true, id: String(stored._id), trigger: label }, change };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; expected: CommandSnapshot } | null;
        if (!data?.id) throw new ToolConflictError('Nothing to undo');
        const label = change.target.label;
        const current = await readById(ctx.channelId, data.id);
        if (!current) throw new ToolConflictError(l(ctx.lang, `${label} was already deleted.`, `${label} ya se había borrado.`));
        const fields = changedFields(data.expected, commandSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label, fields, ctx.lang, true);
        try {
            await deleteChannelCommand(ctx.channelId, data.id, { guard: writeGuard(current) });
        } catch (error) {
            throw serviceError(error, label, ctx.lang);
        }
    },
};

// ---------------------------------------------------------------------------
// update_command
// ---------------------------------------------------------------------------

interface UpdateChanges { body?: string; access?: AccessLevel; cooldown?: number; enabled?: boolean; description?: string; newName?: string; /** Internal: the body replaces a block reply. */ fromBlocks?: boolean }
interface UpdateInput extends UpdateChanges { name: string; kind?: 'command' | 'keyword' }

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
        + 'or off), description, newName (rename the trigger). Send only what changes. The user approves a card '
        + 'showing before → after; nothing changes until then. Built-in commands: only enabled, access, cooldown and '
        + 'newName. Commands made with blocks: get_command shows the text they run; a body replaces the blocks with a text reply (warned on the card, undo restores the blocks). Changing '
        + 'access replaces a custom access rule with a simple level. ' + COMMAND_LANGUAGE_BASICS,
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
        if ([parsed.body, parsed.access, parsed.cooldown, parsed.enabled, parsed.description, parsed.newName].every((value) => value === undefined)) {
            throw new ToolInputError('Nothing to change: send at least one of body, access, cooldown, enabled, description, newName');
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
        if (Object.keys(changes).length === 0) throw new ToolInputError(`${label} already looks like that: nothing to change.`);

        const next = { ...current, ...(changes.newName !== undefined ? { cmd: changes.newName } : {}),
            ...(changes.body !== undefined ? { message: changes.body, ...(changes.fromBlocks ? { authoring: 'text' } : {}) } : {}),
            ...(changes.description !== undefined ? { description: changes.description } : {}),
            ...(changes.cooldown !== undefined ? { cooldown: changes.cooldown } : {}),
            ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
            ...(changes.access !== undefined ? { userLevel: levelNumber(changes.access), permissionExpression: null } : {}) } as LeanCommand;
        const before = displayCommand(current, ctx.lang);
        const after = displayCommand(next, ctx.lang);
        const shown = new Set(Object.keys(before).filter((key) => stableJson(before[key]) !== stableJson(after[key])));
        const k = keys(ctx.lang, keyword);
        shown.add(k.trigger);

        let effects: string[] = [];
        const textBody = (current.authoring !== 'blocks' || changes.fromBlocks === true) && !current.reserved && !runsBuiltInCode(current);
        if (textBody && (changes.body !== undefined || changes.enabled === true)) {
            const described = await effectsFor(String(next.message ?? ''), ctx);
            effects = described.effects;
            warnings.push(...described.warnings);
        }
        if (changes.body !== undefined && !keyword) {
            const timer = await timerWarning(ctx, current.cmd);
            if (timer) warnings.push(timer);
        }

        const title = keyword
            ? l(ctx.lang, `Update keyword ${label}`, `Editar palabra clave ${label}`)
            : l(ctx.lang, `Update command ${label}`, `Editar comando ${label}`);
        const proposal: ChangeProposal = {
            tool: 'update_command',
            title,
            area: AREA,
            target: { type: keyword ? 'keyword' : 'command', id: String(current._id), label },
            before: displayCommand(current, ctx.lang, shown),
            after: displayCommand(next, ctx.lang, shown),
            effects,
            ...(warnings.length ? { warnings } : {}),
            permissions: [...PERMISSIONS],
            payload: { id: String(current._id), changes, expected: commandSnapshot(current) },
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, changes, expected } = proposal.payload as { id: string; changes: UpdateChanges; expected: CommandSnapshot };
        const label = proposal.target.label;
        const current = await readById(ctx.channelId, id, changes.fromBlocks === true);
        if (!current) throw new ToolConflictError(l(ctx.lang, `${label} was deleted in the meantime. Nothing was changed.`, `${label} se borró mientras tanto. No se cambió nada.`));
        const fields = changedFields(expected, commandSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label, fields, ctx.lang);
        let updated;
        try {
            updated = await updateChannelCommand(ctx.channelId, id, updateBody(current, changes), { guard: writeGuard(current), language: ctx.lang });
        } catch (error) {
            throw serviceError(error, label, ctx.lang);
        }
        const stored = updated.command.toObject() as unknown as LeanCommand;
        const newLabel = triggerLabel(stored);
        const change: ChangeRecordInput = {
            area: AREA,
            target: { type: proposal.target.type, id, label: newLabel },
            before: proposal.before,
            after: proposal.after,
            undo: { op: 'update', id, restore: restoreBody(current, changes), expected: commandSnapshot(stored) },
            summary: `Updated ${newLabel}`,
        };
        return { result: { updated: true, id, trigger: newLabel }, change };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; restore: CommandWriteBody; expected: CommandSnapshot } | null;
        if (!data?.id || !data.restore) throw new ToolConflictError('Nothing to undo');
        const label = change.target.label;
        const current = await readById(ctx.channelId, data.id);
        if (!current) throw new ToolConflictError(l(ctx.lang, `${label} was deleted, so there is nothing to restore.`, `${label} se borró, así que no hay nada que restaurar.`));
        const fields = changedFields(data.expected, commandSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label, fields, ctx.lang, true);
        try {
            await updateChannelCommand(ctx.channelId, data.id, data.restore, { guard: writeGuard(current), language: ctx.lang });
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
        + 'A timer with the same name is not deleted.',
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
        if (!keyword) {
            const timer = await CustomTimerSchema.exists({ channelID: ctx.channelId, name: current.cmd.toLowerCase() });
            if (timer) warnings.push(l(ctx.lang, `The timer "${current.cmd.toLowerCase()}" is not deleted and keeps posting.`, `El temporizador "${current.cmd.toLowerCase()}" no se borra y sigue publicando.`));
        }
        const proposal: ChangeProposal = {
            tool: 'delete_command',
            title: keyword ? l(ctx.lang, `Delete keyword ${label}`, `Borrar palabra clave ${label}`) : l(ctx.lang, `Delete command ${label}`, `Borrar comando ${label}`),
            area: AREA,
            target: { type: keyword ? 'keyword' : 'command', id: String(current._id), label },
            before: displayCommand(current, ctx.lang),
            after: null,
            effects: [],
            ...(warnings.length ? { warnings } : {}),
            permissions: [...PERMISSIONS],
            payload: { id: String(current._id), expected: commandSnapshot(current) },
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, expected } = proposal.payload as { id: string; expected: CommandSnapshot };
        const label = proposal.target.label;
        const current = await readById(ctx.channelId, id);
        if (!current) throw new ToolConflictError(l(ctx.lang, `${label} was already deleted.`, `${label} ya se había borrado.`));
        const fields = changedFields(expected, commandSnapshot(current), ctx.lang);
        if (fields.length) throw conflict(label, fields, ctx.lang);
        let deleted;
        try {
            deleted = await deleteChannelCommand(ctx.channelId, id, { guard: writeGuard(current) });
        } catch (error) {
            throw serviceError(error, label, ctx.lang);
        }
        const change: ChangeRecordInput = {
            area: AREA,
            target: proposal.target,
            before: proposal.before,
            after: null,
            undo: { op: 'delete', raw: deleted.raw },
            summary: `Deleted ${label}`,
        };
        return { result: { deleted: true, id, trigger: label }, change };
    },
    async undo(change, ctx) {
        const data = change.undo as { raw: Record<string, unknown> } | null;
        if (!data?.raw) throw new ToolConflictError('Nothing to undo');
        try {
            await restoreDeletedCommand(ctx.channelId, data.raw);
        } catch (error) {
            if (error instanceof CommandMutationError || error instanceof CommandCooldownError) {
                throw new ToolConflictError(l(ctx.lang, `${change.target.label} can't be restored: ${error.message}`, `${change.target.label} no se puede restaurar: ${error.message}`));
            }
            throw error;
        }
    },
};

export const commandTools: AgentTool[] = [createCommandTool, updateCommandTool, deleteCommandTool] as unknown as AgentTool[];
