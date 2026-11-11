import { randomUUID } from 'node:crypto';
import type { IChannelModerationSettings, IModerationRule } from '../../../../schemas/channel_moderation_settings.schema.js';
import { MAX_RULES_PER_CHANNEL } from '../../../../schemas/channel_moderation_settings.schema.js';
import { ModerationSettingsError, moderationSettingsRevision, prepareModerationSettings, readModerationSettings, saveModerationSettingsIfUnchanged, type PreparedModerationSettings } from '../../../../server/services/moderation_settings.service.js';
import { spamProtectionSettings } from '../../../../utils/moderation/spam.js';
import { SPAM_CATEGORIES, SPAM_EXEMPT_TAGS } from '../../../../utils/moderation/spam_categories.js';
import { VariationError } from '../../../../utils/moderation/variation_jobs.js';
import { ToolInputError, type AgentTool, type ChangeProposal, type Lang, type ToolContext } from '../../../types.js';
import { asObject, bool, int, oneOf, stableJson, str } from '../../util.js';
import { assertUnchanged, channelName, conflict, display, pickPaths, sameValue, stringList, tr, type FieldLabel } from './common.js';

/** Chat Moderation (Modules → Chat Moderation). Route: PUT /moderation/:channelID/settings (`moderation:manage`). */

export const MODERATION_PERMISSIONS = ['moderation:manage'] as const;

const RULE_TYPES = ['caps', 'links', 'emote_spam', 'blacklist'] as const;
const ACTIONS = ['off', 'warn', 'delete', 'timeout', 'ban'] as const;
type RuleType = typeof RULE_TYPES[number];

const TOP_LABELS: Record<string, FieldLabel> = {
    enabled: { en: 'Rule filter on', es: 'Filtro de reglas activado' },
    offenseWindowSeconds: { en: 'Forget warnings after (seconds)', es: 'Olvidar advertencias después de (segundos)' },
    'spamProtection.enabled': { en: 'Chat protection on', es: 'Protección del chat activada' },
    'spamProtection.reviewAllMessages': { en: 'Review subsequent messages', es: 'Revisar mensajes siguientes' },
    'spamProtection.categories': { en: 'What to detect', es: 'Qué detectar' },
    'spamProtection.exemptTags': { en: 'Exempt roles', es: 'Roles exentos' },
    'spamProtection.thresholdPercent': { en: 'Ban confidence (%)', es: 'Confianza para banear (%)' }
};
const TOP_PATHS = Object.keys(TOP_LABELS);
const TYPE_LABELS: Record<RuleType, FieldLabel> = {
    caps: { en: 'Caps', es: 'Mayúsculas' },
    links: { en: 'Links', es: 'Enlaces' },
    emote_spam: { en: 'Emote spam', es: 'Spam de emotes' },
    blacklist: { en: 'Blocked words', es: 'Palabras bloqueadas' }
};

interface StepInput { action: typeof ACTIONS[number]; timeoutSeconds?: number }
export interface RuleInput {
    id?: string;
    type?: RuleType;
    enabled?: boolean;
    reason?: string;
    exemptUserLevel?: number;
    firstTime?: StepInput;
    secondTime?: StepInput;
    everyTimeAfter?: StepInput;
    capsMode?: 'count' | 'percentage';
    minCaps?: number;
    maxCapsPercent?: number;
    minMessageLength?: number;
    allowedDomains?: string[];
    maxEmotes?: number;
    terms?: string[];
}
export interface ModerationInput {
    ruleFilterEnabled?: boolean;
    forgetWarningsAfterMinutes?: number;
    protection?: { enabled?: boolean; reviewAllMessages?: boolean; categories?: string[]; exemptRoles?: string[]; confidencePercent?: number };
    addRules?: RuleInput[];
    updateRules?: RuleInput[];
    removeRuleIds?: string[];
}

const stepSchema = { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: [...ACTIONS], description: 'off = just count it, warn, delete the message, timeout, ban (permanent)' },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 1209600 }
} };
const ruleProperties = {
    type: { type: 'string', enum: [...RULE_TYPES] },
    enabled: { type: 'boolean' },
    reason: { type: 'string', maxLength: 500, description: 'Shown in the moderation notice' },
    exemptUserLevel: { type: 'integer', minimum: 1, maximum: 10, description: 'Skip this rule for this level and above: 2 subs, 5 VIPs, 7 mods (usual), 8 editors, 9 admins, 10 only the broadcaster' },
    firstTime: stepSchema, secondTime: stepSchema, everyTimeAfter: stepSchema,
    capsMode: { type: 'string', enum: ['count', 'percentage'] },
    minCaps: { type: 'integer', minimum: 1, maximum: 500 },
    maxCapsPercent: { type: 'integer', minimum: 1, maximum: 100 },
    minMessageLength: { type: 'integer', minimum: 1, maximum: 500 },
    allowedDomains: { type: 'array', items: { type: 'string' }, maxItems: 50 },
    maxEmotes: { type: 'integer', minimum: 1, maximum: 100 },
    terms: { type: 'array', items: { type: 'string' }, maxItems: 200 }
};

function step(raw: unknown, key: string): StepInput | undefined {
    if (raw === undefined || raw === null) return undefined;
    const input = asObject(raw);
    const action = oneOf(input, 'action', ACTIONS, { required: true })!;
    const timeoutSeconds = int(input, 'timeoutSeconds', { min: 1, max: 1209600 });
    if (action === 'timeout' && timeoutSeconds === undefined) throw new ToolInputError(`${key}.timeoutSeconds is required for a timeout`);
    return { action, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}) };
}

function ruleInput(raw: unknown, mode: 'add' | 'update'): RuleInput {
    const input = asObject(raw);
    const rule: RuleInput = {
        id: mode === 'update' ? str(input, 'id', { required: true, max: 64 }) : undefined,
        type: oneOf(input, 'type', RULE_TYPES, { required: mode === 'add' }),
        enabled: bool(input, 'enabled'),
        reason: str(input, 'reason', { max: 500 }),
        exemptUserLevel: int(input, 'exemptUserLevel', { min: 1, max: 10 }),
        firstTime: step(input.firstTime, 'firstTime'),
        secondTime: step(input.secondTime, 'secondTime'),
        everyTimeAfter: step(input.everyTimeAfter, 'everyTimeAfter'),
        capsMode: oneOf(input, 'capsMode', ['count', 'percentage'] as const),
        minCaps: int(input, 'minCaps', { min: 1, max: 500 }),
        maxCapsPercent: int(input, 'maxCapsPercent', { min: 1, max: 100 }),
        minMessageLength: int(input, 'minMessageLength', { min: 1, max: 500 }),
        allowedDomains: stringList(input, 'allowedDomains', { max: 50, maxLength: 100 }),
        maxEmotes: int(input, 'maxEmotes', { min: 1, max: 100 }),
        terms: stringList(input, 'terms', { max: 200, maxLength: 100 })
    };
    if (mode === 'update' && rule.type !== undefined) throw new ToolInputError('A rule type cannot change; remove the rule and add a new one');
    if (mode === 'update' && !Object.entries(rule).some(([key, value]) => key !== 'id' && value !== undefined)) throw new ToolInputError(`updateRules: give at least one field to change for rule ${rule.id}`);
    return rule;
}

/** The stored rule with the page-editable fields from `input` applied (advanced options are kept as saved). */
function applyRuleInput(base: Record<string, unknown>, input: RuleInput): Record<string, unknown> {
    const rule = { ...base };
    const set = (key: string, value: unknown) => { if (value !== undefined) rule[key] = value; };
    set('type', input.type);
    set('enabled', input.enabled);
    set('reason', input.reason);
    set('exemptUserLevel', input.exemptUserLevel);
    if (input.exemptUserLevel !== undefined) rule.exemptExpression = null;
    const stepValue = (value: StepInput | undefined, previous: unknown) => value === undefined ? undefined
        : { action: value.action, timeoutSeconds: value.timeoutSeconds ?? (previous as { timeoutSeconds?: number } | undefined)?.timeoutSeconds ?? 60 };
    set('firstOffense', stepValue(input.firstTime, base.firstOffense));
    set('secondOffense', stepValue(input.secondTime, base.secondOffense));
    set('thirdOffense', stepValue(input.everyTimeAfter, base.thirdOffense));
    set('capsThresholdMode', input.capsMode);
    set('minCapsCount', input.minCaps);
    set('maxCapsPercentage', input.maxCapsPercent);
    set('minMessageLength', input.minMessageLength);
    set('allowlistDomains', input.allowedDomains);
    set('maxEmoteCount', input.maxEmotes);
    set('terms', input.terms);
    return rule;
}

/** Comparable form of a rule (everything that defines it, minus generated variation entries). */
export function ruleKey(rule: unknown): string {
    if (!rule || typeof rule !== 'object') return 'null';
    const { _id: _ignored, variations, ...rest } = rule as Record<string, unknown> & { variations?: Record<string, unknown> };
    const { entries: _entries, ...variationRest } = variations ?? {};
    return stableJson({ ...rest, variations: variationRest });
}

function stepText(value: unknown, lang: Lang): string {
    const s = value as { action?: string; timeoutSeconds?: number } | undefined;
    if (!s?.action) return '-';
    const names: Record<string, FieldLabel> = { off: { en: 'just count', es: 'solo contar' }, warn: { en: 'warn', es: 'advertir' }, delete: { en: 'delete', es: 'borrar' }, timeout: { en: 'timeout', es: 'timeout' }, ban: { en: 'ban', es: 'ban' } };
    return s.action === 'timeout' ? `${names.timeout[lang]} ${s.timeoutSeconds ?? 60} s` : names[s.action]?.[lang] ?? s.action;
}

/** Compact, display-safe view of a rule (proposal cards, change log, get_settings). */
export function ruleSummary(rule: IModerationRule | Record<string, unknown>, lang: Lang): Record<string, unknown> {
    const r = rule as IModerationRule;
    const view: Record<string, unknown> = {
        id: r.id, type: r.type, enabled: r.enabled,
        steps: [stepText(r.firstOffense, lang), stepText(r.secondOffense, lang), stepText(r.thirdOffense, lang)].join(' → '),
        exempt: r.exemptExpression ? 'tags/accounts' : `level ${r.exemptUserLevel}+`,
        reason: r.reason
    };
    if (r.type === 'caps') Object.assign(view, r.capsThresholdMode === 'percentage' ? { maxCapsPercent: r.maxCapsPercentage } : { minCaps: r.minCapsCount }, { minMessageLength: r.minMessageLength });
    if (r.type === 'links') view.allowedDomains = r.allowlistDomains;
    if (r.type === 'emote_spam') view.maxEmotes = r.maxEmoteCount;
    if (r.type === 'blacklist') view.terms = r.terms;
    const advanced = { regexPatterns: r.patterns?.length ?? 0, contextualReview: !!r.semantic?.enabled, wordVariations: r.variations?.mode ?? 'off' };
    if (advanced.regexPatterns || advanced.contextualReview || advanced.wordVariations !== 'off') view.advanced = advanced;
    return view;
}

function validate(raw: unknown): ModerationInput {
    const input = asObject(raw);
    let protection: ModerationInput['protection'];
    if (input.protection !== undefined && input.protection !== null) {
        const p = asObject(input.protection);
        const categories = stringList(p, 'categories', { max: SPAM_CATEGORIES.length });
        if (categories?.some((value) => !(SPAM_CATEGORIES as readonly string[]).includes(value))) throw new ToolInputError(`protection.categories must use: ${SPAM_CATEGORIES.join(', ')}`);
        const exemptRoles = stringList(p, 'exemptRoles', { max: SPAM_EXEMPT_TAGS.length });
        if (exemptRoles?.some((value) => !(SPAM_EXEMPT_TAGS as readonly string[]).includes(value))) throw new ToolInputError(`protection.exemptRoles must use: ${SPAM_EXEMPT_TAGS.join(', ')}`);
        protection = {
            enabled: bool(p, 'enabled'), reviewAllMessages: bool(p, 'reviewAllMessages'),
            categories: categories && [...new Set(categories)], exemptRoles: exemptRoles && [...new Set(exemptRoles)],
            confidencePercent: int(p, 'confidencePercent', { min: 80, max: 100 })
        };
    }
    const list = (key: string, mode: 'add' | 'update') => {
        const value = input[key];
        if (value === undefined || value === null) return undefined;
        if (!Array.isArray(value) || value.length > MAX_RULES_PER_CHANNEL) throw new ToolInputError(`${key} must be a list of up to ${MAX_RULES_PER_CHANNEL} rules`);
        return value.map((item) => ruleInput(item, mode));
    };
    const value: ModerationInput = {
        ruleFilterEnabled: bool(input, 'ruleFilterEnabled'),
        forgetWarningsAfterMinutes: int(input, 'forgetWarningsAfterMinutes', { min: 1, max: 1440 }),
        protection,
        addRules: list('addRules', 'add'),
        updateRules: list('updateRules', 'update'),
        removeRuleIds: stringList(input, 'removeRuleIds', { max: MAX_RULES_PER_CHANNEL, maxLength: 64 })
    };
    const touched = [...(value.updateRules ?? []).map((rule) => rule.id!), ...(value.removeRuleIds ?? [])];
    if (new Set(touched).size !== touched.length) throw new ToolInputError('A rule can only be updated or removed once per change');
    if (value.ruleFilterEnabled === undefined && value.forgetWarningsAfterMinutes === undefined
        && !(protection && Object.values(protection).some((item) => item !== undefined))
        && !value.addRules?.length && !value.updateRules?.length && !value.removeRuleIds?.length) {
        throw new ToolInputError('Give at least one moderation setting or rule to change');
    }
    return value;
}

interface Ops {
    top: Record<string, unknown>;
    add: Record<string, unknown>[];
    update: { id: string; input: RuleInput }[];
    remove: string[];
}

/** Full PUT body: the fresh stored settings with the ops applied (other rules stay as saved). */
function buildBody(current: IChannelModerationSettings, ops: Ops, lang: Lang): Record<string, unknown> {
    let rules = (current.rules ?? []).map((rule) => structuredClone(rule) as unknown as Record<string, unknown>);
    for (const id of ops.remove) {
        if (!rules.some((rule) => rule.id === id)) conflict(lang, `Rule ${id} no longer exists.`, `La regla ${id} ya no existe.`);
        rules = rules.filter((rule) => rule.id !== id);
    }
    for (const { id, input } of ops.update) {
        const index = rules.findIndex((rule) => rule.id === id);
        if (index < 0) conflict(lang, `Rule ${id} no longer exists.`, `La regla ${id} ya no existe.`);
        rules[index] = applyRuleInput(rules[index], input);
    }
    rules.push(...ops.add.map((rule) => structuredClone(rule)));
    const spam = { ...spamProtectionSettings(current) } as Record<string, unknown>;
    for (const [path, value] of Object.entries(ops.top)) if (path.startsWith('spamProtection.')) spam[path.slice(15)] = value;
    return {
        enabled: 'enabled' in ops.top ? ops.top.enabled : current.enabled,
        offenseWindowSeconds: 'offenseWindowSeconds' in ops.top ? ops.top.offenseWindowSeconds : current.offenseWindowSeconds,
        rules,
        spamProtection: spam
    };
}

function topValues(settings: IChannelModerationSettings | PreparedModerationSettings): Record<string, unknown> {
    return pickPaths({ ...settings, spamProtection: spamProtectionSettings(settings as IChannelModerationSettings) }, TOP_PATHS);
}

function ruleLabel(rule: { type?: string; id?: string }, lang: Lang): string {
    return `${tr(lang, 'Rule', 'Regla')} ${TYPE_LABELS[rule.type as RuleType]?.[lang] ?? rule.type} (${rule.id})`;
}

async function prepare(ctx: Pick<ToolContext, 'channelId' | 'lang'>, name: string, body: Record<string, unknown>): Promise<PreparedModerationSettings> {
    try { return await prepareModerationSettings(ctx.channelId, name, body); }
    catch (error) {
        if (error instanceof ModerationSettingsError || error instanceof VariationError) throw new ToolInputError(error.message);
        throw error;
    }
}

/**
 * Saves the full body built from `current`, compare-and-set on its revision (settingsVersion +
 * updatedAt inside the database write): if anything was saved since `current` was read, nothing is written.
 */
async function save(ctx: Pick<ToolContext, 'channelId' | 'lang'>, name: string, current: IChannelModerationSettings, body: Record<string, unknown>): Promise<void> {
    let saved;
    try { saved = await saveModerationSettingsIfUnchanged(ctx.channelId, name, body, moderationSettingsRevision(current)); }
    catch (error) {
        if (error instanceof ModerationSettingsError || error instanceof VariationError) throw new Error(error.message);
        throw error;
    }
    if (!saved) {
        conflict(ctx.lang, 'Chat moderation changed while saving. Nothing was changed; ask again for a fresh proposal.',
            'La moderación del chat cambió mientras se guardaba. No se cambió nada; vuelve a pedirlo para preparar uno nuevo.');
    }
}

interface Payload {
    ops: Ops;
    expected: { top: Record<string, unknown>; rules: Record<string, string> };
    undo: { topBefore: Record<string, unknown>; topAfter: Record<string, unknown>; added: string[]; updated: { id: string; before: Record<string, unknown> }[]; removed: Record<string, unknown>[] };
}

export const updateModerationSettings: AgentTool<ModerationInput> = {
    name: 'update_moderation_settings',
    kind: 'write',
    permissions: MODERATION_PERMISSIONS,
    description: [
        'Change Chat Moderation (Modules → Chat Moderation). Two parts:',
        '(1) protection = chat protection, an AI check of each chatter\'s FIRST message that BANS on a match: categories spam, ads, self_promotion (on by default), profanity, insults; exemptRoles (mod, editor, admin by default; also vip, sub, founder);',
        'confidencePercent (score needed to ban, default 85; 80–100 needs Premium/Pro); reviewAllMessages (Premium/Pro: check every message, uses AI credits).',
        '(2) rules: ruleFilterEnabled turns the rules on/off (not chat protection); up to 20 rules of type caps (minCaps capitals or maxCapsPercent, minMessageLength letters), links (blocks links except allowedDomains; a new links rule blocks every link until you add domains),',
        'emote_spam (maxEmotes), blacklist (blocked words/phrases in terms, whole words, ignores capitals and accents). Each rule has steps firstTime, secondTime, everyTimeAfter: off (just count), warn, delete, timeout (timeoutSeconds), ban (permanent);',
        'defaults warn → delete → 60 s timeout. exemptUserLevel: skip the rule for this level and above (7 = mods, the usual choice). forgetWarningsAfterMinutes (1–1440, default 60) resets the steps.',
        'Use updateRules with the rule id from get_settings (only the fields you send change; regex, contextual review and word variations stay as saved: edit those on the page) and removeRuleIds to delete rules.',
        'The user approves first; it can be undone. Rules and protection can time out or ban viewers automatically: say so.'
    ].join(' '),
    parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
            ruleFilterEnabled: { type: 'boolean' },
            forgetWarningsAfterMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
            protection: { type: 'object', additionalProperties: false, properties: {
                enabled: { type: 'boolean' },
                reviewAllMessages: { type: 'boolean' },
                categories: { type: 'array', items: { type: 'string', enum: [...SPAM_CATEGORIES] } },
                exemptRoles: { type: 'array', items: { type: 'string', enum: [...SPAM_EXEMPT_TAGS] } },
                confidencePercent: { type: 'integer', minimum: 80, maximum: 100 }
            } },
            addRules: { type: 'array', maxItems: MAX_RULES_PER_CHANNEL, items: { type: 'object', additionalProperties: false, required: ['type'], properties: ruleProperties } },
            updateRules: { type: 'array', maxItems: MAX_RULES_PER_CHANNEL, items: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' }, ...ruleProperties } } },
            removeRuleIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_RULES_PER_CHANNEL }
        }
    },
    label: (_input, lang) => tr(lang, 'Preparing moderation changes…', 'Preparando cambios de moderación…'),
    validate,
    async run(input, ctx) {
        const name = await channelName(ctx.channelId);
        const current = await readModerationSettings(ctx.channelId, name);
        const existing = new Map((current.rules ?? []).map((rule) => [rule.id, rule]));
        for (const id of [...(input.updateRules ?? []).map((rule) => rule.id!), ...(input.removeRuleIds ?? [])]) {
            if (!existing.has(id)) throw new ToolInputError(`No moderation rule with id ${id}. Use get_settings area "moderation" for the ids.`);
        }
        const top: Record<string, unknown> = {};
        if (input.ruleFilterEnabled !== undefined) top.enabled = input.ruleFilterEnabled;
        if (input.forgetWarningsAfterMinutes !== undefined) top.offenseWindowSeconds = input.forgetWarningsAfterMinutes * 60;
        const p = input.protection;
        if (p?.enabled !== undefined) top['spamProtection.enabled'] = p.enabled;
        if (p?.reviewAllMessages !== undefined) top['spamProtection.reviewAllMessages'] = p.reviewAllMessages;
        if (p?.categories !== undefined) top['spamProtection.categories'] = p.categories;
        if (p?.exemptRoles !== undefined) top['spamProtection.exemptTags'] = p.exemptRoles;
        if (p?.confidencePercent !== undefined) top['spamProtection.thresholdPercent'] = p.confidencePercent;
        const ops: Ops = {
            top,
            add: (input.addRules ?? []).map((rule) => applyRuleInput({ id: randomUUID(), enabled: true }, rule)),
            update: (input.updateRules ?? []).map((rule) => ({ id: rule.id!, input: rule })),
            remove: input.removeRuleIds ?? []
        };
        const prepared = await prepare(ctx, name, buildBody(current, ops, ctx.lang));

        const beforeTop = topValues(current), afterTop = topValues(prepared);
        const topChanged = TOP_PATHS.filter((path) => !sameValue(beforeTop[path], afterTop[path]));
        const preparedById = new Map(prepared.rules.map((rule) => [rule.id, rule]));
        const updated = ops.update.filter(({ id }) => ruleKey(existing.get(id)) !== ruleKey(preparedById.get(id)));
        const added = ops.add.map((rule) => preparedById.get(rule.id as string)!).filter(Boolean);
        if (!topChanged.length && !updated.length && !added.length && !ops.remove.length) {
            return { type: 'result', result: { unchanged: true, message: 'Moderation already has those values. Nothing to change.' }, summary: tr(ctx.lang, 'Already set', 'Ya estaba así') };
        }

        const before: Record<string, unknown> = display(Object.fromEntries(topChanged.map((path) => [path, beforeTop[path]])), TOP_LABELS, ctx.lang);
        const after: Record<string, unknown> = display(Object.fromEntries(topChanged.map((path) => [path, afterTop[path]])), TOP_LABELS, ctx.lang);
        for (const { id } of updated) {
            before[ruleLabel(existing.get(id)!, ctx.lang)] = ruleSummary(existing.get(id)!, ctx.lang);
            after[ruleLabel(existing.get(id)!, ctx.lang)] = ruleSummary(preparedById.get(id)!, ctx.lang);
        }
        for (const rule of added) { before[ruleLabel(rule, ctx.lang)] = null; after[ruleLabel(rule, ctx.lang)] = ruleSummary(rule, ctx.lang); }
        for (const id of ops.remove) { before[ruleLabel(existing.get(id)!, ctx.lang)] = ruleSummary(existing.get(id)!, ctx.lang); after[ruleLabel(existing.get(id)!, ctx.lang)] = null; }

        const finalRules = prepared.rules;
        const punishes = (action: string) => finalRules.some((rule) => rule.enabled && [rule.firstOffense, rule.secondOffense, rule.thirdOffense].some((s) => s?.action === action));
        const effects: string[] = [];
        if ((afterTop.enabled as boolean) && punishes('timeout')) effects.push(tr(ctx.lang, 'Can time out viewers automatically', 'Puede dar timeout a espectadores automáticamente'));
        if ((afterTop.enabled as boolean) && punishes('ban')) effects.push(tr(ctx.lang, 'Can ban viewers automatically', 'Puede banear espectadores automáticamente'));
        if (afterTop['spamProtection.enabled'] && (afterTop['spamProtection.categories'] as string[]).length) effects.push(tr(ctx.lang, 'Chat protection bans chatters whose first message matches', 'La protección del chat banea a quien coincida en su primer mensaje'));
        const warnings: string[] = [];
        if (added.some((rule) => rule.type === 'links' && !rule.allowlistDomains.length)) warnings.push(tr(ctx.lang, 'A links rule with no allowed domains blocks every link.', 'Una regla de enlaces sin dominios permitidos bloquea todos los enlaces.'));
        if (afterTop['spamProtection.reviewAllMessages'] && !beforeTop['spamProtection.reviewAllMessages']) warnings.push(tr(ctx.lang, 'Reviewing every message uses AI credits.', 'Revisar cada mensaje usa créditos de IA.'));
        if (ops.remove.length) warnings.push(tr(ctx.lang, 'Removed rules stop acting right away.', 'Las reglas eliminadas dejan de actuar de inmediato.'));

        const payload: Payload = {
            ops,
            expected: {
                top: Object.fromEntries(topChanged.map((path) => [path, beforeTop[path]])),
                rules: Object.fromEntries([...updated.map(({ id }) => id), ...ops.remove].map((id) => [id, ruleKey(existing.get(id))]))
            },
            undo: {
                topBefore: Object.fromEntries(topChanged.map((path) => [path, beforeTop[path]])),
                topAfter: Object.fromEntries(topChanged.map((path) => [path, afterTop[path]])),
                added: added.map((rule) => rule.id),
                updated: updated.map(({ id }) => ({ id, before: structuredClone(existing.get(id)) as unknown as Record<string, unknown> })),
                removed: ops.remove.map((id) => structuredClone(existing.get(id)) as unknown as Record<string, unknown>)
            }
        };
        const proposal: ChangeProposal = {
            tool: 'update_moderation_settings',
            title: tr(ctx.lang, 'Change chat moderation', 'Cambiar la moderación del chat'),
            area: 'moderation',
            target: { type: 'moderation_settings', id: ctx.channelId, label: tr(ctx.lang, 'Chat Moderation', 'Moderación del chat') },
            before, after, effects, warnings,
            permissions: [...MODERATION_PERMISSIONS],
            payload: payload as unknown as Record<string, unknown>
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { ops, expected, undo } = proposal.payload as unknown as Payload;
        const name = await channelName(ctx.channelId);
        const current = await readModerationSettings(ctx.channelId, name);
        assertUnchanged(topValues(current), expected.top, ctx.lang, tr(ctx.lang, 'Chat moderation', 'La moderación del chat'), TOP_LABELS);
        for (const [id, key] of Object.entries(expected.rules)) {
            if (ruleKey(current.rules?.find((rule) => rule.id === id)) !== key) conflict(ctx.lang, `Moderation rule ${id} changed since this was prepared. Nothing was changed; ask again for a fresh proposal.`,
                `La regla de moderación ${id} cambió desde que se preparó este cambio. No se cambió nada; vuelve a pedirlo.`);
        }
        if (ops.add.some((rule) => current.rules?.some((item) => item.id === rule.id))) conflict(ctx.lang, 'This change was already applied.', 'Este cambio ya se aplicó.');
        await save(ctx, name, current, buildBody(current, ops, ctx.lang));
        const saved = await readModerationSettings(ctx.channelId, name);
        const savedRules = Object.fromEntries((saved.rules ?? []).map((rule) => [rule.id, ruleKey(rule)]));
        return {
            result: { saved: true, rules: (saved.rules ?? []).length, ruleFilterEnabled: saved.enabled },
            change: {
                area: 'moderation', target: proposal.target, before: proposal.before, after: proposal.after,
                undo: { ...undo, afterKeys: Object.fromEntries([...undo.added, ...undo.updated.map(({ id }) => id)].map((id) => [id, savedRules[id] ?? 'null'])) },
                summary: proposal.title
            }
        };
    },
    async undo(change, ctx) {
        const data = change.undo as Payload['undo'] & { afterKeys: Record<string, string> };
        const name = await channelName(ctx.channelId);
        const current = await readModerationSettings(ctx.channelId, name);
        const what = tr(ctx.lang, 'Chat moderation', 'La moderación del chat');
        assertUnchanged(topValues(current), data.topAfter, ctx.lang, what, TOP_LABELS);
        for (const [id, key] of Object.entries(data.afterKeys)) {
            if (ruleKey(current.rules?.find((rule) => rule.id === id)) !== key) conflict(ctx.lang, `Moderation rule ${id} was edited after this change, so it can't be undone.`, `La regla de moderación ${id} se editó después de este cambio; no se puede deshacer.`);
        }
        if (data.removed.some((rule) => current.rules?.some((item) => item.id === rule.id))) conflict(ctx.lang, 'A removed rule is back already.', 'Una regla eliminada ya volvió.');
        let rules = (current.rules ?? []).map((rule) => structuredClone(rule) as unknown as Record<string, unknown>).filter((rule) => !data.added.includes(rule.id as string));
        rules = rules.map((rule) => data.updated.find(({ id }) => id === rule.id)?.before ?? rule);
        rules.push(...data.removed);
        if (rules.length > MAX_RULES_PER_CHANNEL) conflict(ctx.lang, `Undo would make more than ${MAX_RULES_PER_CHANNEL} rules.`, `Deshacer dejaría más de ${MAX_RULES_PER_CHANNEL} reglas.`);
        const spam = { ...spamProtectionSettings(current) } as Record<string, unknown>;
        for (const [path, value] of Object.entries(data.topBefore)) if (path.startsWith('spamProtection.')) spam[path.slice(15)] = value;
        await save(ctx, name, current, {
            enabled: 'enabled' in data.topBefore ? data.topBefore.enabled : current.enabled,
            offenseWindowSeconds: 'offenseWindowSeconds' in data.topBefore ? data.topBefore.offenseWindowSeconds : current.offenseWindowSeconds,
            rules, spamProtection: spam
        });
    }
};
