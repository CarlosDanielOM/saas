import { Types } from 'mongoose';
import type { IChannelAIPersonality } from '../../../../schemas/channel_ai_personality.schema.js';
import {
    getChannelTierInfo,
    getTierLimits,
    personalityRevision,
    readChannelPersonality,
    updateChannelPersonalityIfUnchanged,
    type UpdatePersonalityRequest
} from '../../../../server/services/ai_personality.service.js';
import { ToolInputError, type AgentTool, type ChangeProposal, type Lang, type ToolContext } from '../../../types.js';
import { asObject, bool, str } from '../../util.js';
import { assertUnchanged, conflict, display, sameValue, stringList, tr, type FieldLabel } from './common.js';

/** AI Personality (Modules → AI Personality). Route: PUT /ai-personality/:channelID (`ai:manage`). */

export const AI_PERSONALITY_PERMISSIONS = ['ai:manage'] as const;

const LIMITS = { personality: 4000, name: 80, rule: 300, username: 25, relationship: 100, description: 500 };
const MEMORY_FIELDS = {
    learnFromChat: 'learning:enabled',
    learnAfterEachStream: 'learning:postStreamSummaryEnabled',
    viewerPreferences: 'memory:allowUserPreferenceMemories',
    runningJokes: 'memory:allowRunningJokes',
    sensitiveDetails: 'memory:allowSensitiveMemories'
} as const;

const LABELS: Record<string, FieldLabel> = {
    enabled: { en: 'AI chat (replies to mentions)', es: 'Chat con IA (responde a menciones)' },
    streamSummariesEnabled: { en: 'Stream summaries', es: 'Resúmenes de stream' },
    activeProfileId: { en: 'Personality used in chat', es: 'Personalidad usada en el chat' },
    rules: { en: 'Rules it always follows', es: 'Reglas que siempre sigue' },
    knownUsers: { en: 'Regulars the bot knows', es: 'Regulares que conoce el bot' },
    'learning:enabled': { en: 'Learn from chat', es: 'Aprender del chat' },
    'learning:postStreamSummaryEnabled': { en: 'Learn after each stream', es: 'Aprender después de cada stream' },
    'memory:allowUserPreferenceMemories': { en: 'Viewer likes and dislikes', es: 'Gustos de los espectadores' },
    'memory:allowRunningJokes': { en: 'Running jokes', es: 'Bromas recurrentes' },
    'memory:allowSensitiveMemories': { en: 'Sensitive details', es: 'Detalles sensibles' }
};

interface KnownUserInput { username: string; relationship?: string; description?: string }
export interface AiPersonalityInput {
    aiChatEnabled?: boolean;
    streamSummariesEnabled?: boolean;
    activeProfileId?: string;
    profile?: { profileId?: string; name?: string; personality?: string };
    rules?: string[];
    addKnownUsers?: KnownUserInput[];
    removeKnownUsers?: string[];
    memory?: Partial<Record<keyof typeof MEMORY_FIELDS, boolean>>;
}

type Personality = Pick<IChannelAIPersonality, 'enabled' | 'streamSummariesEnabled' | 'activeProfileId' | 'profiles' | 'rules' | 'knownUsers' | 'learningConfig' | 'memoryPolicy'> & Partial<IChannelAIPersonality>;

const knownUserView = (users: Personality['knownUsers'] | undefined) => (users ?? []).map((user) => ({ username: user.username, relationship: user.relationship ?? '', description: user.description ?? '' }));

/** Flat comparable view (keys never contain dots, so `assertUnchanged` reads them as single keys). */
export function flatView(p: Personality | null): Record<string, unknown> {
    const view: Record<string, unknown> = {
        enabled: p?.enabled ?? true,
        streamSummariesEnabled: p?.streamSummariesEnabled ?? true,
        activeProfileId: p?.activeProfileId || null,
        rules: p?.rules ?? [],
        knownUsers: knownUserView(p?.knownUsers),
        'learning:enabled': p?.learningConfig?.enabled ?? null,
        'learning:postStreamSummaryEnabled': p?.learningConfig?.postStreamSummaryEnabled ?? null,
        'memory:allowUserPreferenceMemories': p?.memoryPolicy?.allowUserPreferenceMemories ?? null,
        'memory:allowRunningJokes': p?.memoryPolicy?.allowRunningJokes ?? null,
        'memory:allowSensitiveMemories': p?.memoryPolicy?.allowSensitiveMemories ?? null
    };
    for (const profile of p?.profiles ?? []) {
        view[`profile:${profile.profileID}:name`] = profile.name;
        view[`profile:${profile.profileID}:personality`] = profile.personality;
    }
    return view;
}

function labelFor(key: string, current: Personality | null): FieldLabel {
    if (LABELS[key]) return LABELS[key];
    const [, id, field] = key.split(':');
    const name = current?.profiles?.find((profile) => profile.profileID === id)?.name ?? id;
    return field === 'name' ? { en: `Personality "${name}": name`, es: `Personalidad "${name}": nombre` }
        : { en: `Personality "${name}": how the bot talks`, es: `Personalidad "${name}": cómo habla el bot` };
}
const labelsFor = (keys: string[], current: Personality | null) => Object.fromEntries(keys.map((key) => [key, labelFor(key, current)]));

/** PUT body applying flat `values` onto the fresh personality, the way the page sends a save. */
export function toBody(current: Personality | null, values: Record<string, unknown>): UpdatePersonalityRequest {
    const body: UpdatePersonalityRequest = {};
    if ('enabled' in values) body.enabled = values.enabled as boolean;
    if ('streamSummariesEnabled' in values) body.streamSummariesEnabled = values.streamSummariesEnabled as boolean;
    const profileKeys = Object.keys(values).filter((key) => key.startsWith('profile:'));
    if (profileKeys.length || 'activeProfileId' in values) {
        let profiles = (current?.profiles ?? []).map((profile) => ({ ...structuredClone(profile) })) as NonNullable<UpdatePersonalityRequest['profiles']>;
        for (const key of profileKeys) {
            const [, id, field] = key.split(':');
            const value = values[key];
            if (value === null) { if (field === 'personality') profiles = profiles.filter((profile) => profile.profileID !== id); continue; }
            let profile = profiles.find((item) => item.profileID === id);
            if (!profile) { profile = { profileID: id, name: 'Default Personality', personality: '' }; profiles.push(profile); }
            (profile as Record<string, unknown>)[field] = value;
        }
        const activeId = ('activeProfileId' in values ? values.activeProfileId : current?.activeProfileId) as string | null;
        body.profiles = profiles;
        body.activeProfileId = activeId ?? '';
        const active = profiles.find((profile) => profile.profileID === activeId) ?? profiles[0];
        if (active) {
            body.personality = active.personality;
            body.personaMode = active.personaMode;
            body.personaReference = active.personaReference;
            body.tonePreset = active.tonePreset;
            body.voiceProfile = active.voiceProfile;
        }
    }
    if ('rules' in values) body.rules = values.rules as string[];
    if ('knownUsers' in values) {
        body.knownUsers = (values.knownUsers as KnownUserInput[]).map((user) => ({
            ...user,
            lastInteraction: current?.knownUsers?.find((item) => item.username === user.username)?.lastInteraction
        }));
    }
    const learning = Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('learning:')).map(([key, value]) => [key.slice(9), value]));
    if (Object.keys(learning).length) body.learningConfig = learning;
    const memory = Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('memory:')).map(([key, value]) => [key.slice(7), value]));
    if (Object.keys(memory).length) body.memoryPolicy = memory;
    return body;
}

function limitOf(value: number | string): number { return typeof value === 'number' ? value : Number.POSITIVE_INFINITY; }

/**
 * Saves `body` (built from `stored`) only if nothing was saved since `stored` was read: its revision
 * (updatedAt/__v) is part of the save's filter. Otherwise nothing is written.
 */
async function save(ctx: Pick<ToolContext, 'channelId' | 'lang'>, user: NonNullable<Awaited<ReturnType<typeof getChannelTierInfo>>>, stored: Personality | null, body: UpdatePersonalityRequest, undoing = false) {
    const result = await updateChannelPersonalityIfUnchanged(ctx.channelId, user, body, personalityRevision(stored));
    if (result !== 'changed') return result.saved;
    return undoing
        ? conflict(ctx.lang, 'The AI Personality was edited again while undoing, so it was left as it is now.', 'La Personalidad de IA se volvió a editar mientras se deshacía; se dejó como está ahora.')
        : conflict(ctx.lang, 'The AI Personality changed while saving. Nothing was changed; ask again for a fresh proposal.', 'La Personalidad de IA cambió mientras se guardaba. No se cambió nada; vuelve a pedirlo para preparar uno nuevo.');
}

async function load(ctx: Pick<ToolContext, 'channelId'>) {
    const [user, stored] = await Promise.all([getChannelTierInfo(ctx.channelId), readChannelPersonality(ctx.channelId)]);
    if (!user) throw new ToolInputError('Channel not found');
    return { user, stored: stored as Personality | null };
}

function validate(raw: unknown): AiPersonalityInput {
    const input = asObject(raw);
    let profile: AiPersonalityInput['profile'];
    if (input.profile !== undefined && input.profile !== null) {
        const p = asObject(input.profile);
        profile = { profileId: str(p, 'profileId', { max: 64 }), name: str(p, 'name', { max: LIMITS.name }), personality: str(p, 'personality', { max: LIMITS.personality }) };
        if (profile.name === undefined && profile.personality === undefined) throw new ToolInputError('profile needs a name or personality text to change');
    }
    const rules = stringList(input, 'rules', { max: 200, maxLength: LIMITS.rule });
    let addKnownUsers: KnownUserInput[] | undefined;
    if (input.addKnownUsers !== undefined && input.addKnownUsers !== null) {
        if (!Array.isArray(input.addKnownUsers) || input.addKnownUsers.length > 50) throw new ToolInputError('addKnownUsers must be a list of up to 50 users');
        addKnownUsers = input.addKnownUsers.map((item) => {
            const user = asObject(item);
            const username = str(user, 'username', { required: true, max: LIMITS.username })!.replace(/^@/, '').toLowerCase();
            if (!/^[a-z0-9_]{1,25}$/.test(username)) throw new ToolInputError('Each known user needs a Twitch username');
            return { username, relationship: str(user, 'relationship', { max: LIMITS.relationship }) ?? '', description: str(user, 'description', { max: LIMITS.description }) ?? '' };
        });
    }
    let memory: AiPersonalityInput['memory'];
    if (input.memory !== undefined && input.memory !== null) {
        const m = asObject(input.memory);
        memory = Object.fromEntries(Object.keys(MEMORY_FIELDS).map((key) => [key, bool(m, key)]).filter(([, value]) => value !== undefined));
    }
    const value: AiPersonalityInput = {
        aiChatEnabled: bool(input, 'aiChatEnabled'),
        streamSummariesEnabled: bool(input, 'streamSummariesEnabled'),
        activeProfileId: str(input, 'activeProfileId', { max: 64 }),
        profile, rules, addKnownUsers,
        removeKnownUsers: stringList(input, 'removeKnownUsers', { max: 50, maxLength: LIMITS.username })?.map((name) => name.replace(/^@/, '').toLowerCase()),
        memory: memory && Object.keys(memory).length ? memory : undefined
    };
    if (!Object.values(value).some((item) => item !== undefined)) throw new ToolInputError('Give at least one AI Personality setting to change');
    return value;
}

function warningsFor(after: Record<string, unknown>, lang: Lang): string[] {
    const warnings: string[] = [];
    if (after['memory:allowSensitiveMemories'] === true) warnings.push(tr(lang, 'The bot may then remember personal details viewers share.', 'El bot podrá recordar detalles personales que compartan los espectadores.'));
    if (after.enabled === false) warnings.push(tr(lang, 'The bot stops replying to mentions. $(ai) commands keep working.', 'El bot deja de responder menciones. Los comandos $(ai) siguen funcionando.'));
    if (after.knownUsers !== undefined) warnings.push(tr(lang, 'Do not store private or sensitive details about regulars.', 'No guardes detalles privados o sensibles de los regulares.'));
    return warnings;
}

export const updateAiPersonality: AgentTool<AiPersonalityInput> = {
    name: 'update_ai_personality',
    kind: 'write',
    permissions: AI_PERSONALITY_PERMISSIONS,
    description: [
        'Change how the chat AI talks (Modules → AI Personality). aiChatEnabled: the bot replies to direct mentions (does not affect $(ai) commands). streamSummariesEnabled: post-stream summaries.',
        'profile: edit a personality (profileId from get_settings; default = the one used in chat): name and personality = "How the bot talks", the text that guides every reply. activeProfileId: which personality is used in chat (one at a time).',
        'rules: the FULL list of "Rules it always follows" (replaces the list). addKnownUsers (adds or replaces by username: relationship = who they are, description = what the bot should know) / removeKnownUsers: "Regulars the bot knows".',
        'memory: learnFromChat, learnAfterEachStream, viewerPreferences, runningJokes, sensitiveDetails (off by default; personal details viewers share).',
        'Plan limits: Free 3 rules and 3 regulars, Premium 5 and 10, Pro unlimited. Persona mode, tone, catchphrases and other style details are not used by chat replies; change those on the page.',
        'Only send what changes. The user approves first; it can be undone.'
    ].join(' '),
    parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
            aiChatEnabled: { type: 'boolean' },
            streamSummariesEnabled: { type: 'boolean' },
            activeProfileId: { type: 'string' },
            profile: { type: 'object', additionalProperties: false, properties: {
                profileId: { type: 'string' }, name: { type: 'string', maxLength: LIMITS.name }, personality: { type: 'string', maxLength: LIMITS.personality }
            } },
            rules: { type: 'array', items: { type: 'string', maxLength: LIMITS.rule } },
            addKnownUsers: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['username'], properties: {
                username: { type: 'string' }, relationship: { type: 'string', maxLength: LIMITS.relationship }, description: { type: 'string', maxLength: LIMITS.description }
            } } },
            removeKnownUsers: { type: 'array', items: { type: 'string' }, maxItems: 50 },
            memory: { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.keys(MEMORY_FIELDS).map((key) => [key, { type: 'boolean' }])) }
        }
    },
    label: (_input, lang) => tr(lang, 'Preparing AI Personality changes…', 'Preparando cambios de la Personalidad de IA…'),
    validate,
    async run(input, ctx) {
        const { stored } = await load(ctx);
        const current = flatView(stored);
        const limits = getTierLimits(ctx.plan).limits;
        const wanted: Record<string, unknown> = {};
        if (input.aiChatEnabled !== undefined) wanted.enabled = input.aiChatEnabled;
        if (input.streamSummariesEnabled !== undefined) wanted.streamSummariesEnabled = input.streamSummariesEnabled;
        const profiles = stored?.profiles ?? [];
        if (input.activeProfileId !== undefined) {
            if (!profiles.some((profile) => profile.profileID === input.activeProfileId)) throw new ToolInputError(`No personality with id ${input.activeProfileId}. Use get_settings area "ai_personality".`);
            wanted.activeProfileId = input.activeProfileId;
        }
        if (input.profile) {
            let id = input.profile.profileId ?? stored?.activeProfileId ?? profiles[0]?.profileID;
            if (input.profile.profileId && !profiles.some((profile) => profile.profileID === input.profile!.profileId)) throw new ToolInputError(`No personality with id ${input.profile.profileId}.`);
            if (!id || !profiles.some((profile) => profile.profileID === id)) {
                // No personality saved yet: create the first one and use it, like the page's first save.
                if (!input.profile.personality) throw new ToolInputError('The channel has no personality yet: give the personality text to create one');
                id = new Types.ObjectId().toString();
                wanted[`profile:${id}:name`] = input.profile.name ?? 'Default Personality';
                wanted.activeProfileId = id;
            }
            if (input.profile.name !== undefined) wanted[`profile:${id}:name`] = input.profile.name;
            if (input.profile.personality !== undefined) wanted[`profile:${id}:personality`] = input.profile.personality;
        }
        if (input.rules !== undefined) {
            if (input.rules.length > limitOf(limits.rules)) throw new ToolInputError(`The ${ctx.plan} plan allows ${limits.rules} rules`);
            wanted.rules = input.rules;
        }
        if (input.addKnownUsers || input.removeKnownUsers) {
            let users = (current.knownUsers as KnownUserInput[]).filter((user) => !input.removeKnownUsers?.includes(user.username.toLowerCase()));
            for (const user of input.addKnownUsers ?? []) {
                const index = users.findIndex((item) => item.username.toLowerCase() === user.username);
                if (index >= 0) users[index] = user; else users = [...users, user];
            }
            if (users.length > limitOf(limits.knownUsers) && users.length > (current.knownUsers as unknown[]).length) {
                throw new ToolInputError(`The ${ctx.plan} plan allows ${limits.knownUsers} regulars`);
            }
            wanted.knownUsers = users;
        }
        for (const [key, value] of Object.entries(input.memory ?? {})) wanted[MEMORY_FIELDS[key as keyof typeof MEMORY_FIELDS]] = value;

        const keys = Object.keys(wanted).filter((key) => !sameValue(current[key] ?? null, wanted[key]));
        if (!keys.length) return { type: 'result', result: { unchanged: true, message: 'AI Personality already has those values. Nothing to change.' }, summary: tr(ctx.lang, 'Already set', 'Ya estaba así') };
        const before = Object.fromEntries(keys.map((key) => [key, current[key] ?? null]));
        const after = Object.fromEntries(keys.map((key) => [key, wanted[key]]));
        const labels = labelsFor(keys, stored);
        const profileName = (id: unknown) => profiles.find((profile) => profile.profileID === id)?.name ?? id;
        const shown = (values: Record<string, unknown>) => display('activeProfileId' in values ? { ...values, activeProfileId: profileName(values.activeProfileId) } : values, labels, ctx.lang);
        const proposal: ChangeProposal = {
            tool: 'update_ai_personality',
            title: tr(ctx.lang, 'Change AI Personality', 'Cambiar la Personalidad de IA'),
            area: 'ai_personality',
            target: { type: 'ai_personality', id: ctx.channelId, label: tr(ctx.lang, 'AI Personality', 'Personalidad de IA') },
            before: shown(before), after: shown(after),
            effects: [],
            warnings: warningsFor(after, ctx.lang),
            permissions: [...AI_PERSONALITY_PERMISSIONS],
            payload: { before, after, expected: before }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { before, after, expected } = proposal.payload as { before: Record<string, unknown>; after: Record<string, unknown>; expected: Record<string, unknown> };
        const { user, stored } = await load(ctx);
        assertUnchanged(flatView(stored), expected, ctx.lang, tr(ctx.lang, 'AI Personality', 'La Personalidad de IA'), labelsFor(Object.keys(expected), stored));
        const saved = await save(ctx, user, stored, toBody(stored, after));
        const savedView = flatView(saved as unknown as Personality);
        return {
            result: { saved: true },
            change: {
                area: 'ai_personality', target: proposal.target, before: proposal.before, after: proposal.after,
                undo: { before, after: Object.fromEntries(Object.keys(after).map((key) => [key, savedView[key] ?? null])) },
                summary: proposal.title
            }
        };
    },
    async undo(change, ctx) {
        const data = change.undo as { before: Record<string, unknown>; after: Record<string, unknown> };
        const { user, stored } = await load(ctx);
        if (!stored) conflict(ctx.lang, 'The AI Personality no longer exists.', 'La Personalidad de IA ya no existe.');
        assertUnchanged(flatView(stored), data.after, ctx.lang, tr(ctx.lang, 'AI Personality', 'La Personalidad de IA'), labelsFor(Object.keys(data.after), stored));
        await save(ctx, user, stored, toBody(stored, data.before), true);
    }
};
