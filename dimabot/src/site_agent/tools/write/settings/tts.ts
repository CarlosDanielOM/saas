import { getChannelTtsSettings, type ChannelTtsSettingsData } from '../../../../schemas/channel_tts_settings.schema.js';
import { getFishVoiceFavorites } from '../../../../schemas/channel_fish_voice_favorites.schema.js';
import { updateChannelTtsSettingsIfUnchanged } from '../../../../server/services/tts_settings.service.js';
import { FISH_VOICES } from '../../../../server/services/tts/fish_tts.service.js';
import { KOKORO_VOICES, resolveKokoroVoice } from '../../../../utils/tts/kokoro_voices.util.js';
import { EXPRESSIVE_TTS_TAGS } from '../../../../utils/tts/expressive_tts_tags.util.js';
import { ToolInputError, type AgentTool, type ChangeProposal, type ToolContext } from '../../../types.js';
import { asObject, bool, int, oneOf, str } from '../../util.js';
import { assertUnchanged, changedPaths, channelName, conflict, display, pickPaths, requireSomething, routeMessage, tr, type FieldLabel } from './common.js';

/** Text to Speech settings (Modules → Text to Speech). Route: PUT /speech/settings/:channelID (`tts:manage`). */

export const TTS_PERMISSIONS = ['tts:manage'] as const;

const LABELS: Record<string, FieldLabel> = {
    enabled: { en: 'Channel TTS on', es: 'TTS del canal activado' },
    provider: { en: 'Voice engine', es: 'Motor de voz' },
    defaultLanguage: { en: 'Default language', es: 'Idioma predeterminado' },
    'voices.kokoroDefault': { en: 'Kokoro voice', es: 'Voz de Kokoro' },
    'voices.cloneDefault': { en: 'Fish Audio voice', es: 'Voz de Fish Audio' },
    'filters.skipEmotes': { en: 'Skip emotes', es: 'Omitir emotes' },
    'filters.stripLinks': { en: 'Links become [link]', es: 'Los enlaces se leen como [link]' },
    'filters.normalizeWhitespace': { en: 'Tidy extra spaces', es: 'Quitar espacios de más' },
    'filters.maxLength': { en: 'Maximum characters per message', es: 'Máximo de caracteres por mensaje' },
    'queue.maxItems': { en: 'Maximum messages waiting', es: 'Máximo de mensajes en espera' }
};
const tagLabel = (path: string): FieldLabel | undefined => path.startsWith('filters.expressiveTags.')
    ? { en: `Voice tag [${path.slice(23)}]`, es: `Etiqueta de voz [${path.slice(23)}]` } : undefined;
const labelsFor = (paths: string[]): Record<string, FieldLabel> => Object.fromEntries(paths.map((path) => [path, LABELS[path] ?? tagLabel(path) ?? { en: path, es: path }]));

export interface TtsInput {
    enabled?: boolean;
    provider?: 'piper' | 'kokoro' | 'fish';
    defaultLanguage?: 'en' | 'es';
    kokoroVoice?: string;
    fishVoice?: string;
    skipEmotes?: boolean;
    stripLinks?: boolean;
    normalizeWhitespace?: boolean;
    maxLength?: number;
    maxQueue?: number;
    voiceTagsOn?: string[];
    voiceTagsOff?: string[];
}

function tagList(input: Record<string, unknown>, key: string): string[] | undefined {
    const value = input[key];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((tag) => typeof tag !== 'string' || !(EXPRESSIVE_TTS_TAGS as readonly string[]).includes(tag.trim().toLowerCase()))) {
        throw new ToolInputError(`${key} must list Fish voice tags such as whisper, laugh, excited (see get_settings area "tts")`);
    }
    return [...new Set((value as string[]).map((tag) => tag.trim().toLowerCase()))];
}

/** Resolves a Fish voice like the page does: built-in key, saved favorite (nickname or name), or a Fish voice ID. */
export async function resolveFishChoice(channelId: string, value: string): Promise<{ value: string; label: string } | null> {
    const requested = value.trim();
    const key = requested.toLowerCase().replaceAll(' ', '_');
    if (Object.hasOwn(FISH_VOICES, key)) return { value: key, label: key };
    const favorites = await getFishVoiceFavorites(channelId);
    const favorite = favorites.find((item) => item.alias.toLowerCase() === requested.toLowerCase())
        ?? favorites.find((item) => item.name.trim().toLowerCase() === requested.toLowerCase())
        ?? favorites.find((item) => item.id.toLowerCase() === requested.toLowerCase());
    if (favorite) return { value: favorite.id, label: favorite.alias || favorite.name };
    return /^[a-f\d]{32}$/i.test(requested) ? { value: requested.toLowerCase(), label: requested.toLowerCase() } : null;
}

async function loadCurrent(ctx: Pick<ToolContext, 'channelId'>): Promise<{ name: string; current: ChannelTtsSettingsData }> {
    const name = await channelName(ctx.channelId);
    return { name, current: await getChannelTtsSettings(ctx.channelId, name) };
}

/**
 * Compare-and-set write: changes only `values` (path → value), and only while every `expected` path
 * still has its value (checked inside the database write, so an edit in between wins and nothing is written).
 */
async function write(ctx: Pick<ToolContext, 'channelId' | 'lang'>, expected: Record<string, unknown>, values: Record<string, unknown>): Promise<ChannelTtsSettingsData> {
    const name = await channelName(ctx.channelId);
    const saved = await updateChannelTtsSettingsIfUnchanged(ctx.channelId, name, expected, values);
    if (saved.ok) return saved.settings;
    if ('conflict' in saved) {
        assertUnchanged(saved.current, expected, ctx.lang, tr(ctx.lang, 'The TTS settings', 'La configuración de TTS'), labelsFor(Object.keys(expected)));
        conflict(ctx.lang, 'The TTS settings changed while saving. Nothing was changed; ask again for a fresh proposal.',
            'La configuración de TTS cambió mientras se guardaba. No se cambió nada; vuelve a pedirlo para preparar uno nuevo.');
    }
    throw new Error(routeMessage(saved.body, 'Could not save the TTS settings'));
}

export const updateTtsSettings: AgentTool<TtsInput> = {
    name: 'update_tts_settings',
    kind: 'write',
    permissions: TTS_PERMISSIONS,
    description: [
        'Change Text to Speech settings (Modules → Text to Speech). TTS reads chat messages aloud on stream through the Speech URL browser source in OBS (`!s` command, `$(tts ...)` functions, rewards).',
        'Fields: enabled (channel TTS on/off; off refuses new speech); provider = default voice engine: "piper" (one English voice Ryan and one Spanish voice Ald, cheapest, works with no credits), "kokoro" (preset voices), "fish" (cloned voices, the only engine that reads voice tags, most credits);',
        'defaultLanguage (en/es, picks the Piper voice); kokoroVoice (a Kokoro preset id such as af_heart or ef_dora); fishVoice (built-in gojo, rias_gremory, toji_fushiguro, carlos_bodoque, a saved favorite nickname, or a 32-character Fish voice ID; it does not switch the engine, set provider "fish" too);',
        'skipEmotes (remove emote names), stripLinks (links become [link]), normalizeWhitespace (collapse spaces), maxLength (30–500 characters, longer messages are cut), maxQueue (1–20 messages waiting, counting the one playing);',
        'voiceTagsOn / voiceTagsOff (Fish voice tags like whisper, laugh, excited that viewers may use or not).',
        'Only send fields that change. The user approves before anything is saved; it can be undone. The Speech URL is never shown here: tell the user to copy it from the TTS page.'
    ].join(' '),
    parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
            enabled: { type: 'boolean' },
            provider: { type: 'string', enum: ['piper', 'kokoro', 'fish'] },
            defaultLanguage: { type: 'string', enum: ['en', 'es'] },
            kokoroVoice: { type: 'string', enum: [...KOKORO_VOICES] },
            fishVoice: { type: 'string', maxLength: 100 },
            skipEmotes: { type: 'boolean' },
            stripLinks: { type: 'boolean' },
            normalizeWhitespace: { type: 'boolean' },
            maxLength: { type: 'integer', minimum: 30, maximum: 500 },
            maxQueue: { type: 'integer', minimum: 1, maximum: 20 },
            voiceTagsOn: { type: 'array', items: { type: 'string' }, maxItems: 100 },
            voiceTagsOff: { type: 'array', items: { type: 'string' }, maxItems: 100 }
        }
    },
    label: (_input, lang) => tr(lang, 'Preparing TTS changes…', 'Preparando cambios de TTS…'),
    validate(raw) {
        const input = asObject(raw);
        const kokoro = str(input, 'kokoroVoice', { max: 40 });
        if (kokoro !== undefined && !resolveKokoroVoice(kokoro)) throw new ToolInputError('kokoroVoice is not a Kokoro voice');
        const value: TtsInput = {
            enabled: bool(input, 'enabled'),
            provider: oneOf(input, 'provider', ['piper', 'kokoro', 'fish'] as const),
            defaultLanguage: oneOf(input, 'defaultLanguage', ['en', 'es'] as const),
            kokoroVoice: kokoro === undefined ? undefined : resolveKokoroVoice(kokoro)!,
            fishVoice: str(input, 'fishVoice', { max: 100 }),
            skipEmotes: bool(input, 'skipEmotes'),
            stripLinks: bool(input, 'stripLinks'),
            normalizeWhitespace: bool(input, 'normalizeWhitespace'),
            maxLength: int(input, 'maxLength', { min: 30, max: 500 }),
            maxQueue: int(input, 'maxQueue', { min: 1, max: 20 }),
            voiceTagsOn: tagList(input, 'voiceTagsOn'),
            voiceTagsOff: tagList(input, 'voiceTagsOff')
        };
        if (value.voiceTagsOn?.some((tag) => value.voiceTagsOff?.includes(tag))) throw new ToolInputError('A voice tag cannot be both on and off');
        requireSomething(value, 'TTS setting');
        return value;
    },
    async run(input, ctx) {
        const { current } = await loadCurrent(ctx);
        const wanted: Record<string, unknown> = {};
        if (input.enabled !== undefined) wanted.enabled = input.enabled;
        if (input.provider !== undefined) wanted.provider = input.provider;
        if (input.defaultLanguage !== undefined) wanted.defaultLanguage = input.defaultLanguage;
        if (input.kokoroVoice !== undefined) wanted['voices.kokoroDefault'] = input.kokoroVoice;
        let fishLabel: string | null = null;
        if (input.fishVoice !== undefined) {
            const choice = await resolveFishChoice(ctx.channelId, input.fishVoice);
            if (!choice) throw new ToolInputError('fishVoice is not a built-in voice, a saved favorite or a Fish voice ID');
            wanted['voices.cloneDefault'] = choice.value;
            fishLabel = choice.label;
        }
        if (input.skipEmotes !== undefined) wanted['filters.skipEmotes'] = input.skipEmotes;
        if (input.stripLinks !== undefined) wanted['filters.stripLinks'] = input.stripLinks;
        if (input.normalizeWhitespace !== undefined) wanted['filters.normalizeWhitespace'] = input.normalizeWhitespace;
        if (input.maxLength !== undefined) wanted['filters.maxLength'] = input.maxLength;
        if (input.maxQueue !== undefined) wanted['queue.maxItems'] = input.maxQueue;
        for (const tag of input.voiceTagsOn ?? []) wanted[`filters.expressiveTags.${tag}`] = true;
        for (const tag of input.voiceTagsOff ?? []) wanted[`filters.expressiveTags.${tag}`] = false;

        const paths = changedPaths(current, wanted);
        if (!paths.length) return { type: 'result', result: { unchanged: true, message: 'These TTS settings already have those values. Nothing to change.' }, summary: tr(ctx.lang, 'Already set', 'Ya estaba así') };
        const after = Object.fromEntries(paths.map((path) => [path, wanted[path]]));
        const before = pickPaths(current, paths);
        const labels = labelsFor(paths);
        const warnings: string[] = [];
        if (after.enabled === false) warnings.push(tr(ctx.lang, 'New speech requests will be refused while TTS is off.', 'Las nuevas solicitudes de voz se rechazarán mientras el TTS esté apagado.'));
        if (after.provider === 'fish') warnings.push(tr(ctx.lang, 'Fish Audio uses the most AI credits (1.5 per character).', 'Fish Audio usa más créditos de IA (1.5 por carácter).'));
        if (paths.some((path) => path.startsWith('filters.expressiveTags.')) && (after.provider ?? current.provider) !== 'fish') {
            warnings.push(tr(ctx.lang, 'Voice tags only work with Fish Audio.', 'Las etiquetas de voz solo funcionan con Fish Audio.'));
        }
        const proposal: ChangeProposal = {
            tool: 'update_tts_settings',
            title: tr(ctx.lang, 'Change Text to Speech settings', 'Cambiar la configuración de Texto a voz'),
            area: 'tts',
            target: { type: 'tts_settings', id: ctx.channelId, label: tr(ctx.lang, 'Text to Speech', 'Texto a voz') },
            before: display(before, labels, ctx.lang),
            after: display(fishLabel ? { ...after, 'voices.cloneDefault': fishLabel } : after, labels, ctx.lang),
            effects: [],
            warnings,
            permissions: [...TTS_PERMISSIONS],
            payload: { before, after, expected: before }
        };
        return { type: 'approval', proposal };
    },
    async apply(proposal, ctx) {
        const { before, after, expected } = proposal.payload as { before: Record<string, unknown>; after: Record<string, unknown>; expected: Record<string, unknown> };
        const saved = await write(ctx, expected, after);
        return {
            result: { saved: true, settings: pickPaths(saved, Object.keys(after)) },
            change: {
                area: 'tts', target: proposal.target, before: proposal.before, after: proposal.after,
                undo: { before, after }, summary: proposal.title
            }
        };
    },
    async undo(change, ctx) {
        const data = change.undo as { before: Record<string, unknown>; after: Record<string, unknown> };
        await write(ctx, data.after, data.before);
    }
};
