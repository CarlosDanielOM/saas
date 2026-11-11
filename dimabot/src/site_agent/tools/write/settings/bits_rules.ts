import { randomBytes } from 'node:crypto';
import { BitsRuleError, MAX_BITS_AMOUNT, MAX_BITS_RULES, MAX_RULE_MESSAGE, MAX_RULE_NAME, parseRule, type BitsRule } from '../../../../bits_rules/model.js';
import { changeBitsRules, loadBitsRules } from '../../../../bits_rules/store.js';
import { ToolConflictError, ToolInputError, type AgentTool, type ChangeProposal, type Lang, type ToolContext } from '../../../types.js';
import { asObject, bool, int, oneOf, str } from '../../util.js';
import { bodyEffects, conflict, sameValue, tr } from './common.js';

/**
 * Shared Bits rules (Chat Events → Cheers card, and Overlay Studio Bits looks). Routes:
 * POST/PATCH/DELETE /bits-rules/:channelID/rules (`eventsubs:manage`). Every plan, up to 50 rules.
 */

export const BITS_RULE_PERMISSIONS = ['eventsubs:manage'] as const;

interface RuleFields { name?: string; enabled?: boolean; min?: number; max?: number | null; chatMode?: 'default' | 'custom' | 'silent'; message?: string; alert?: boolean }
export interface BitsRuleCreateInput extends RuleFields { min: number }
export interface BitsRuleUpdateInput extends RuleFields { id: string }
export interface BitsRuleDeleteInput { id: string }

function fields(input: Record<string, unknown>, requireMin: boolean): RuleFields {
    const value: RuleFields = {
        name: str(input, 'name', { max: MAX_RULE_NAME }),
        enabled: bool(input, 'enabled'),
        min: int(input, 'min', { required: requireMin, min: 1, max: MAX_BITS_AMOUNT }),
        chatMode: oneOf(input, 'chatMode', ['default', 'custom', 'silent'] as const),
        message: str(input, 'message', { max: MAX_RULE_MESSAGE, trim: false }),
        alert: bool(input, 'alert')
    };
    if (Object.hasOwn(input, 'max')) value.max = input.max === null ? null : int(input, 'max', { required: true, min: 1, max: MAX_BITS_AMOUNT })!;
    if ('name' in input && input.name === '') value.name = '';
    return value;
}

/** Route-shaped rule body (the same partial body the page sends). */
function body(input: RuleFields, previous?: BitsRule): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of ['name', 'enabled', 'min', 'max', 'alert'] as const) if (input[key] !== undefined) out[key] = input[key];
    if (input.chatMode !== undefined || input.message !== undefined) {
        const mode = input.chatMode ?? previous?.chat.mode ?? 'default';
        out.chat = { mode, message: input.message ?? previous?.chat.message ?? '' };
    }
    return out;
}

export function ruleView(rule: BitsRule, lang: Lang): Record<string, unknown> {
    const range = rule.max === null ? `${rule.min}+` : rule.max === rule.min ? `${rule.min}` : `${rule.min}–${rule.max}`;
    const chat = rule.chat.mode === 'custom' ? rule.chat.message : rule.chat.mode === 'silent' ? tr(lang, '(says nothing)', '(no dice nada)') : tr(lang, '(default message)', '(mensaje predeterminado)');
    return { name: rule.name, bits: range, enabled: rule.enabled, chat, alert: rule.alert };
}

function parse(raw: Record<string, unknown>, id: string, previous?: BitsRule): BitsRule {
    try { return parseRule(raw, id, previous); }
    catch (error) { if (error instanceof BitsRuleError) throw new ToolInputError(error.message); throw error; }
}

async function mutate(ctx: Pick<ToolContext, 'channelId' | 'requester'>, change: (rules: BitsRule[]) => BitsRule[]): Promise<BitsRule[]> {
    try { return (await changeBitsRules(ctx.channelId, ctx.requester.id, change)).rules; }
    catch (error) {
        if (error instanceof ToolConflictError) throw error;
        if (error instanceof BitsRuleError) throw new Error(error.message);
        throw error;
    }
}

async function chatEffects(rule: BitsRule, ctx: Pick<ToolContext, 'plan' | 'lang'>) {
    return rule.chat.mode === 'custom' ? bodyEffects(rule.chat.message, ctx, tr(ctx.lang, 'Chat message', 'Mensaje en el chat')) : { effects: [], warnings: [] };
}

const ruleParameters = {
    name: { type: 'string', maxLength: MAX_RULE_NAME },
    enabled: { type: 'boolean' },
    min: { type: 'integer', minimum: 1, maximum: MAX_BITS_AMOUNT, description: 'Lowest amount of Bits' },
    max: { type: ['integer', 'null'], minimum: 1, maximum: MAX_BITS_AMOUNT, description: 'Highest amount; null = "or more"; same as min = an exact amount' },
    chatMode: { type: 'string', enum: ['default', 'custom', 'silent'], description: 'default = the Cheers default message, custom = message, silent = say nothing' },
    message: { type: 'string', maxLength: MAX_RULE_MESSAGE, description: 'Chat message for custom mode; can use $(user), $(cheer.amount), $(cheer.message)' },
    alert: { type: 'boolean', description: 'Whether the overlay alert plays for these cheers' }
};
const WHAT = 'Bits rules: one cheer uses one rule, the most specific enabled one (an exact amount beats a range, a narrower range beats a wider one); a cheer that matches none gets the default message and alert. Rules are shared with Overlay Studio (Bits looks) and save right away.';

export const createBitsRule: AgentTool<BitsRuleCreateInput> = {
    name: 'create_bits_rule',
    kind: 'write',
    permissions: BITS_RULE_PERMISSIONS,
    description: `Add a Bits rule (Chat Events → Cheers → Bits rules): what the bot says and whether the overlay alert plays for cheers in an amount range. ${WHAT} Up to ${MAX_BITS_RULES} rules on every plan. The user approves first; undo deletes the rule.`,
    parameters: { type: 'object', additionalProperties: false, required: ['min'], properties: ruleParameters },
    label: (_input, lang) => tr(lang, 'Preparing the Bits rule…', 'Preparando la regla de Bits…'),
    validate: (raw) => fields(asObject(raw), true) as BitsRuleCreateInput,
    async run(input, ctx) {
        const current = await loadBitsRules(ctx.channelId);
        if (current.rules.length >= MAX_BITS_RULES) throw new ToolInputError(`The channel already has ${MAX_BITS_RULES} Bits rules`);
        const id = `rule-${randomBytes(6).toString('hex')}`;
        const raw = body(input);
        const rule = parse(raw, id);
        const effects = await chatEffects(rule, ctx);
        const proposal: ChangeProposal = {
            tool: 'create_bits_rule',
            title: tr(ctx.lang, `Add a Bits rule for ${ruleView(rule, ctx.lang).bits} Bits`, `Agregar una regla de Bits para ${ruleView(rule, ctx.lang).bits} Bits`),
            area: 'bits_rules',
            target: { type: 'bits_rule', id, label: rule.name || `${ruleView(rule, ctx.lang).bits} Bits` },
            before: null,
            after: ruleView(rule, ctx.lang),
            effects: effects.effects,
            warnings: effects.warnings,
            permissions: [...BITS_RULE_PERMISSIONS],
            payload: { id, raw }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, raw } = proposal.payload as { id: string; raw: Record<string, unknown> };
        const rules = await mutate(ctx, (list) => {
            if (list.some((rule) => rule.id === id)) throw new ToolConflictError(tr(ctx.lang, 'This rule was already added.', 'Esta regla ya se agregó.'));
            if (list.length >= MAX_BITS_RULES) throw new ToolConflictError(tr(ctx.lang, `The channel reached ${MAX_BITS_RULES} Bits rules in the meantime.`, `El canal llegó a ${MAX_BITS_RULES} reglas de Bits mientras tanto.`));
            return [...list, parseRule(raw, id)];
        });
        const saved = rules.find((rule) => rule.id === id)!;
        return { result: { created: true, id }, change: { area: 'bits_rules', target: proposal.target, before: null, after: proposal.after, undo: { id, after: saved }, summary: proposal.title } };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; after: BitsRule };
        await mutate(ctx, (list) => {
            const rule = list.find((item) => item.id === data.id);
            if (!rule) conflict(ctx.lang, 'This Bits rule was already deleted.', 'Esta regla de Bits ya se eliminó.');
            if (!sameValue(rule, data.after)) conflict(ctx.lang, 'This Bits rule was edited after it was added, so it was not deleted.', 'Esta regla de Bits se editó después de agregarse; no se eliminó.');
            return list.filter((item) => item.id !== data.id);
        });
    }
};

export const updateBitsRule: AgentTool<BitsRuleUpdateInput> = {
    name: 'update_bits_rule',
    kind: 'write',
    permissions: BITS_RULE_PERMISSIONS,
    description: `Edit a Bits rule (Chat Events → Cheers → Bits rules): its amounts, chat message mode, overlay alert, name or on/off. Only the fields you send change. Rule ids come from get_settings area "bits_rules". ${WHAT} The user approves first; it can be undone.`,
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' }, ...ruleParameters } },
    label: (_input, lang) => tr(lang, 'Preparing the Bits rule change…', 'Preparando el cambio de la regla de Bits…'),
    validate(raw) {
        const input = asObject(raw);
        const value = { id: str(input, 'id', { required: true, max: 64 })!, ...fields(input, false) };
        if (!Object.entries(value).some(([key, item]) => key !== 'id' && item !== undefined)) throw new ToolInputError('Give at least one rule field to change');
        return value;
    },
    async run(input, ctx) {
        const current = await loadBitsRules(ctx.channelId);
        const previous = current.rules.find((rule) => rule.id === input.id);
        if (!previous) throw new ToolInputError(`No Bits rule with id ${input.id}. Use get_settings area "bits_rules".`);
        const raw = body(input, previous);
        const next = parse(raw, previous.id, previous);
        if (sameValue(next, previous)) return { type: 'result', result: { unchanged: true, message: 'The rule already has those values. Nothing to change.' }, summary: tr(ctx.lang, 'Already set', 'Ya estaba así') };
        const effects = await chatEffects(next, ctx);
        const proposal: ChangeProposal = {
            tool: 'update_bits_rule',
            title: tr(ctx.lang, `Edit the Bits rule ${previous.name || ruleView(previous, ctx.lang).bits}`, `Editar la regla de Bits ${previous.name || ruleView(previous, ctx.lang).bits}`),
            area: 'bits_rules',
            target: { type: 'bits_rule', id: previous.id, label: previous.name || `${ruleView(previous, ctx.lang).bits} Bits` },
            before: ruleView(previous, ctx.lang),
            after: ruleView(next, ctx.lang),
            effects: effects.effects,
            warnings: effects.warnings,
            permissions: [...BITS_RULE_PERMISSIONS],
            payload: { id: previous.id, raw, expected: previous }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, raw, expected } = proposal.payload as { id: string; raw: Record<string, unknown>; expected: BitsRule };
        const rules = await mutate(ctx, (list) => {
            const index = list.findIndex((rule) => rule.id === id);
            if (index < 0) conflict(ctx.lang, 'This Bits rule was deleted in the meantime. Nothing was changed.', 'Esta regla de Bits se eliminó mientras tanto. No se cambió nada.');
            if (!sameValue(list[index], expected)) conflict(ctx.lang, 'This Bits rule changed since this was prepared. Nothing was changed; ask again for a fresh proposal.', 'Esta regla de Bits cambió desde que se preparó este cambio. No se cambió nada; vuelve a pedirlo.');
            list[index] = parseRule(raw, id, list[index]);
            return list;
        });
        const saved = rules.find((rule) => rule.id === id)!;
        return { result: { saved: true, id }, change: { area: 'bits_rules', target: proposal.target, before: proposal.before, after: proposal.after, undo: { id, before: expected, after: saved }, summary: proposal.title } };
    },
    async undo(change, ctx) {
        const data = change.undo as { id: string; before: BitsRule; after: BitsRule };
        await mutate(ctx, (list) => {
            const index = list.findIndex((rule) => rule.id === data.id);
            if (index < 0) conflict(ctx.lang, 'This Bits rule was deleted, so the change cannot be undone.', 'Esta regla de Bits se eliminó; el cambio no se puede deshacer.');
            if (!sameValue(list[index], data.after)) conflict(ctx.lang, 'This Bits rule was edited again after this change, so it was not undone.', 'Esta regla de Bits se volvió a editar después de este cambio; no se deshizo.');
            list[index] = data.before;
            return list;
        });
    }
};

export const deleteBitsRule: AgentTool<BitsRuleDeleteInput> = {
    name: 'delete_bits_rule',
    kind: 'write',
    permissions: BITS_RULE_PERMISSIONS,
    description: `Delete a Bits rule (Chat Events → Cheers → Bits rules). Cheers in its range then use another matching rule, or the default message and alert. Its Overlay Studio Bits look stops being used. Rule ids come from get_settings area "bits_rules". The user approves first; undo adds it back with the same id.`,
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    label: (_input, lang) => tr(lang, 'Preparing to delete the Bits rule…', 'Preparando la eliminación de la regla de Bits…'),
    validate: (raw) => ({ id: str(asObject(raw), 'id', { required: true, max: 64 })! }),
    async run(input, ctx) {
        const current = await loadBitsRules(ctx.channelId);
        const rule = current.rules.find((item) => item.id === input.id);
        if (!rule) throw new ToolInputError(`No Bits rule with id ${input.id}. Use get_settings area "bits_rules".`);
        const proposal: ChangeProposal = {
            tool: 'delete_bits_rule',
            title: tr(ctx.lang, `Delete the Bits rule ${rule.name || ruleView(rule, ctx.lang).bits}`, `Eliminar la regla de Bits ${rule.name || ruleView(rule, ctx.lang).bits}`),
            area: 'bits_rules',
            target: { type: 'bits_rule', id: rule.id, label: rule.name || `${ruleView(rule, ctx.lang).bits} Bits` },
            before: ruleView(rule, ctx.lang),
            after: null,
            effects: [],
            warnings: [],
            permissions: [...BITS_RULE_PERMISSIONS],
            payload: { id: rule.id, expected: rule }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { id, expected } = proposal.payload as { id: string; expected: BitsRule };
        await mutate(ctx, (list) => {
            const rule = list.find((item) => item.id === id);
            if (!rule) conflict(ctx.lang, 'This Bits rule was already deleted.', 'Esta regla de Bits ya se eliminó.');
            if (!sameValue(rule, expected)) conflict(ctx.lang, 'This Bits rule changed since this was prepared. Nothing was changed; ask again for a fresh proposal.', 'Esta regla de Bits cambió desde que se preparó este cambio. No se cambió nada; vuelve a pedirlo.');
            return list.filter((item) => item.id !== id);
        });
        return { result: { deleted: true, id }, change: { area: 'bits_rules', target: proposal.target, before: proposal.before, after: null, undo: { rule: expected }, summary: proposal.title } };
    },
    async undo(change, ctx) {
        const data = change.undo as { rule: BitsRule };
        await mutate(ctx, (list) => {
            if (list.some((item) => item.id === data.rule.id)) conflict(ctx.lang, 'This Bits rule is back already.', 'Esta regla de Bits ya volvió.');
            if (list.length >= MAX_BITS_RULES) conflict(ctx.lang, `The channel already has ${MAX_BITS_RULES} Bits rules.`, `El canal ya tiene ${MAX_BITS_RULES} reglas de Bits.`);
            return [...list, data.rule];
        });
    }
};

export const bitsRuleTools: AgentTool[] = [createBitsRule, updateBitsRule, deleteBitsRule] as unknown as AgentTool[];
