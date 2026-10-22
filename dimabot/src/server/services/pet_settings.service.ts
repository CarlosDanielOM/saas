import { Types } from 'mongoose';
import { PetRuntime } from '../../schemas/pet_runtime.schema.js';
import { PetSettingsSchema, type PetSettings } from '../../schemas/pet_settings.schema.js';
import { ChannelAIPersonalitySchema } from '../../schemas/channel_ai_personality.schema.js';
import { KOKORO_VOICES } from '../../utils/tts/kokoro_voices.util.js';
import { FISH_VOICES } from './tts/fish_tts.service.js';
import { findAsset, registerAssetConsumer, withAssetLibrary } from '../../assets/library.js';
import { invalidatePet } from '../../pets/state.js';
import { selectedVtsController, validatePetSessions } from '../../pets/peers.js';
import UsersSchema from '../../schemas/users.schema.js';

export class PetSettingsError extends Error {
    constructor(public code: string, public status = 400) { super(code); }
}

export async function requirePetPlan(userId: string, channelID: string): Promise<void> {
    const user = await UsersSchema.findOne({ _id: userId,
        accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('plan_tier').lean();
    if (!user) throw new PetSettingsError('access_denied', 403);
    if (user.plan_tier !== 'premium' && user.plan_tier !== 'pro') throw new PetSettingsError('plan_required', 403);
}

export const PET_VOICES = [
    { provider: 'piper', id: 'en_US-ryan-medium', name: 'Ryan', language: 'en' },
    { provider: 'piper', id: 'es_MX-ald-medium', name: 'Ald', language: 'es' },
    ...KOKORO_VOICES.map(id => ({ provider: 'kokoro', id,
        name: id.split('_')[1].replace(/^./, c => c.toUpperCase()),
        language: id.startsWith('e') ? 'es' : /^[ab]/.test(id) ? 'en' : 'other' })),
    ...Object.keys(FISH_VOICES).map(id => ({ provider: 'fish', id: FISH_VOICES[id],
        name: id.split('_').map(word => word.replace(/^./, c => c.toUpperCase())).join(' '), language: 'any' }))
];

export function defaultPetSettings(): PetSettings {
    return { appearance: { kind: 'png', idleAssetId: null, talkingAssetId: null },
        playback: { target: 'browser', desktopSessionId: null, vtsSessionId: null }, enabled: false, name: 'Dima',
        tts: { enabled: true, provider: 'piper', language: 'es', voice: 'es_MX-ald-medium' },
        personality: { source: 'custom', profileId: '', prompt: 'You are a friendly, playful virtual companion. Keep replies short and respectful.' },
        rules: [], behavior: { respondToChat: true, respondToEvents: true, cooldownSeconds: 15, maxReplyLength: 280 } };
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !keys.includes(key))) throw new PetSettingsError('invalid_settings');
    return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
        throw new PetSettingsError('invalid_settings');
    }
    return value.trim();
}
function bool(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new PetSettingsError('invalid_settings');
    return value;
}
function integer(value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new PetSettingsError('invalid_settings');
    return value;
}

export function validatePetSettings(input: unknown): PetSettings {
    const value = object(input, ['enabled', 'name', 'tts', 'personality', 'rules', 'behavior', 'appearance', 'playback']);
    const appearance = object(value.appearance ?? defaultPetSettings().appearance, ['kind', 'idleAssetId', 'talkingAssetId']);
    const playback = object(value.playback ?? defaultPetSettings().playback, ['target', 'desktopSessionId', 'vtsSessionId']);
    if (!['png', 'vts'].includes(String(appearance.kind)) || !['browser', 'desktop'].includes(String(playback.target))) throw new PetSettingsError('invalid_settings');
    const nullableId = (id: unknown): string | null => {
        if (id === null) return null;
        if (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id)) throw new PetSettingsError('invalid_settings');
        return id;
    };
    const tts = object(value.tts, ['enabled', 'provider', 'language', 'voice']);
    const personality = object(value.personality, ['source', 'profileId', 'prompt']);
    const behavior = object(value.behavior, ['respondToChat', 'respondToEvents', 'cooldownSeconds', 'maxReplyLength']);
    if (!['piper', 'kokoro', 'fish'].includes(String(tts.provider)) || !['en', 'es'].includes(String(tts.language)) ||
        !['custom', 'profile'].includes(String(personality.source))) throw new PetSettingsError('invalid_settings');
    const voice = text(tts.voice, 100);
    // Fish also supports custom public reference IDs; never accept a URL or a filesystem path.
    const voiceValid = tts.provider === 'fish' ? /^[a-f0-9]{32}$/i.test(voice) :
        PET_VOICES.some(item => item.provider === tts.provider && item.id === voice && item.language === tts.language);
    if (!voiceValid) throw new PetSettingsError('invalid_voice');
    if (!Array.isArray(value.rules) || value.rules.length > 20) throw new PetSettingsError('invalid_rules');
    return { appearance: { kind: appearance.kind as 'png' | 'vts', idleAssetId: nullableId(appearance.idleAssetId), talkingAssetId: nullableId(appearance.talkingAssetId) },
        playback: { target: playback.target as 'browser' | 'desktop', desktopSessionId: nullableId(playback.desktopSessionId), vtsSessionId: nullableId(playback.vtsSessionId) }, enabled: bool(value.enabled), name: text(value.name, 40),
        tts: { enabled: bool(tts.enabled), provider: tts.provider as PetSettings['tts']['provider'],
            language: tts.language as 'en' | 'es', voice },
        personality: { source: personality.source as 'custom' | 'profile',
            profileId: text(personality.profileId, 100, personality.source === 'custom'),
            prompt: text(personality.prompt, 4000, personality.source === 'profile') },
        rules: value.rules.map(rule => text(rule, 300)),
        behavior: { respondToChat: bool(behavior.respondToChat), respondToEvents: bool(behavior.respondToEvents),
            cooldownSeconds: integer(behavior.cooldownSeconds, 0, 3600), maxReplyLength: integer(behavior.maxReplyLength, 30, 500) } };
}

export async function getPetConfiguration(userId: string, channelID: string) {
    await requirePetPlan(userId, channelID);
    const [record, personality, runtimeRecord] = await Promise.all([
        PetSettingsSchema.findOne({ userId }).lean(),
        ChannelAIPersonalitySchema.findOne({ channelID }).select('profiles rules').lean(),
        PetRuntime.findById(userId).lean()
    ]);
    const settings = { ...(record?.settings ?? defaultPetSettings()),
        appearance: record?.settings.appearance ?? defaultPetSettings().appearance,
        playback: record?.settings.playback ?? defaultPetSettings().playback };
    const profiles = (personality?.profiles ?? []).map(profile => ({ id: profile.profileID, name: profile.name }));
    const profile = settings.personality.source === 'profile' ?
        personality?.profiles.find(item => item.profileID === settings.personality.profileId) : null;
    const issues = settings.personality.source === 'profile' && !profile ? ['personality_unavailable'] : [];
    if (settings.appearance.kind === 'png') {
        try {
            const ids = [settings.appearance.idleAssetId, settings.appearance.talkingAssetId];
            if (ids.some(id => !id)) throw new Error('Missing PNG asset');
            for (const id of ids) {
                const asset = await findAsset(channelID, id!);
                if (asset.kind !== 'image' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.mime)) throw new Error('Invalid PNG asset');
            }
        } catch { issues.push('appearance_unavailable'); }
    } else if (!await selectedVtsController(userId, settings.playback.vtsSessionId)) issues.push('vts_unavailable');
    // Only explicit persona fields are shared. Memories, known users and moderation tools are excluded.
    const resolvedPersonality = profile ? { prompt: profile.personality, personaMode: profile.personaMode,
        personaReference: profile.personaReference, tonePreset: profile.tonePreset,
        voiceProfile: profile.voiceProfile, rules: [...(personality?.rules ?? []), ...settings.rules] } :
        { prompt: settings.personality.prompt, rules: settings.rules };
    return { schemaVersion: 2, revision: record?.revision ?? 0, updatedAt: record?.updatedAt ?? null,
        settings, profiles, voices: PET_VOICES, runtime: { enabled: settings.enabled && !issues.length,
            issues, personality: resolvedPersonality, playbackAvailable: !!runtimeRecord?.lease && runtimeRecord.lease.expiresAt.getTime() > Date.now() } };
}

export async function savePetConfiguration(userId: string, channelID: string, input: unknown) {
    await requirePetPlan(userId, channelID);
    const request = object(input, ['revision', 'settings']);
    const revision = integer(request.revision, 0, Number.MAX_SAFE_INTEGER - 1);
    const settings = validatePetSettings(request.settings);
    if (settings.personality.source === 'profile' && !await ChannelAIPersonalitySchema.exists({
        channelID, 'profiles.profileID': settings.personality.profileId
    })) throw new PetSettingsError('personality_unavailable');
    const previous = await PetSettingsSchema.findOne({ userId }).lean();
    await validatePetSessions(userId, settings.playback, previous?.settings.playback);
    return withAssetLibrary(channelID, async () => {
    for (const id of [settings.appearance.idleAssetId, settings.appearance.talkingAssetId]) {
        if (!id) continue;
        const asset = await findAsset(channelID, id);
        if (asset.kind !== 'image' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(asset.mime)) throw new PetSettingsError('invalid_asset');
    }
    const update = { settings, revision: revision + 1, updatedAt: new Date() };
    // The first write must wait for the account uniqueness index, including on a new install.
    await PetSettingsSchema.init();
    try {
        if (revision === 0) await PetSettingsSchema.create({ userId: new Types.ObjectId(userId), ...update });
        else if (!await PetSettingsSchema.findOneAndUpdate({ userId, revision }, { $set: update }, { runValidators: true })) {
            throw new PetSettingsError('settings_conflict', 409);
        }
    } catch (error) {
        if ((error as { code?: number }).code === 11000) throw new PetSettingsError('settings_conflict', 409);
        throw error;
    }
    await invalidatePet(userId, 'settings_changed');
    return getPetConfiguration(userId, channelID);
    });
}

registerAssetConsumer('pet', async (channelID, assetId) => {
    const user = await UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelID } } }).select('_id').lean();
    return !!user && !!await PetSettingsSchema.exists({ userId: user._id, $or: [
        { 'settings.appearance.idleAssetId': assetId }, { 'settings.appearance.talkingAssetId': assetId }
    ] });
});
