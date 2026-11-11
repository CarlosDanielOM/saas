import { PetSettingsSchema } from '../../schemas/pet_settings.schema.js';
import { invalidatePet } from '../../pets/state.js';
import mongoose, { Types } from "mongoose";
import { getDragonflyClient } from "../../utils/databases/dragonfly.database.js";
import { ChannelAIPersonalitySchema, type IChannelAIPersonality } from "../../schemas/channel_ai_personality.schema.js";
import UsersSchema from "../../schemas/users.schema.js";
import type { IUsers } from "../../schemas/users.schema.js";

/**
 * AI Personality settings: sanitizers and the save shared by `PUT /ai-personality/:channelID`
 * and the site assistant (`site_agent/tools/write/settings/ai_personality.ts`).
 */

export interface UpdatePersonalityRequest {
    enabled?: boolean;
    streamSummariesEnabled?: boolean;
    recommendationsEnabled?: boolean;
    profiles?: Array<{
        profileID?: string;
        name?: string;
        personality?: string;
        personaMode?: 'original' | 'inspired' | 'strict_roleplay';
        personaReference?: string;
        tonePreset?: 'family_friendly' | 'balanced' | 'dark_humor';
        voiceProfile?: {
            tone?: string;
            cadence?: string;
            style?: string;
            catchphrases?: string[];
        };
        createdAt?: Date | string;
        updatedAt?: Date | string;
    }>;
    activeProfileId?: string;
    personality?: string;
    personaMode?: 'original' | 'inspired' | 'strict_roleplay';
    personaReference?: string;
    tonePreset?: 'family_friendly' | 'balanced' | 'dark_humor';
    language?: 'en' | 'es' | null;
    voiceProfile?: {
        tone?: string;
        cadence?: string;
        style?: string;
        catchphrases?: string[];
    };
    learningConfig?: {
        enabled?: boolean;
        autoConfirmEnabled?: boolean;
        autoConfirmThreshold?: number;
        minMessageLength?: number;
        maxPendingMemories?: number;
        maxConfirmedMemories?: number;
        postStreamSummaryEnabled?: boolean;
        weeklyMaintenanceEnabled?: boolean;
        monthlyMaintenanceEnabled?: boolean;
        autoApplyCreates?: boolean;
        autoApplyEdits?: boolean;
        autoApplyArchives?: boolean;
        autoApplyPermanentDeletes?: boolean;
        summaryMinDurationMinutes?: number;
        summaryMinChatMessages?: number;
        createMinConfidence?: number;
        editMinConfidence?: number;
        archiveMinConfidence?: number;
        deleteMinConfidence?: number;
        maxActionsPerRun?: number;
        maxDeletesPerRun?: number;
        minMemoryAgeDaysForDelete?: number;
        minUnusedDaysForDelete?: number;
        // Semantic chat history (Qdrant integration)
        semanticChatHistoryEnabled?: boolean;
        semanticChatHistoryLimit?: number | null;
        semanticChatHistoryPrimaryMinScore?: number;
        semanticChatHistoryFallbackMinScore?: number;
    };
    memoryPolicy?: {
        prioritizeRecentChat?: boolean;
        allowSensitiveMemories?: boolean;
        allowUserPreferenceMemories?: boolean;
        allowRunningJokes?: boolean;
    };
    rules?: string[];
    knownUsers?: Array<{
        username?: string;
        description?: string;
        relationship?: string;
        lastInteraction?: Date | string;
    }>;
}

export interface TierLimits {
    profiles: number;
    rules: number | string;
    knownUsers: number | string;
    contextWindow: number;
}

export interface TierInfo {
    isPremiumPlus: boolean;
    isPremium: boolean;
    limits: TierLimits;
}

export async function getChannelTierInfo(channelID: string): Promise<IUsers | null> {
    return await UsersSchema.findOne({
        'accounts.type': 'twitch',
        'accounts.id': channelID
    }) as IUsers | null;
}

export function getTierLimits(planTier: string | null | undefined): TierInfo {
    const isPro = planTier === 'pro';
    const isPremium = planTier === 'premium';

    const profileLimit = isPro ? 3 : (isPremium ? 2 : 1);
    const rulesLimit = isPro ? 'unlimited' : (isPremium ? 5 : 3);
    const knownUsersLimit = isPro ? 'unlimited' : (isPremium ? 10 : 3);
    const contextWindowValue = isPro ? 35 : (isPremium ? 15 : 7);

    return {
        isPremiumPlus: isPro,
        isPremium: isPremium,
        limits: {
            profiles: profileLimit,
            rules: rulesLimit,
            knownUsers: knownUsersLimit,
            contextWindow: contextWindowValue
        }
    };
}

export function buildDefaultPersonality(channelID: string, user: IUsers): Partial<IChannelAIPersonality> {
    const twitchAccount = user.accounts.find((account) => account.type === 'twitch' && account.id === channelID);
    const channelName = twitchAccount?.name || user.name || 'Unknown';
    const tierInfo = getTierLimits(user.plan_tier);

    return {
        channelID,
        channel: channelName,
        enabled: true,
        streamSummariesEnabled: true,
        recommendationsEnabled: true,
        contextWindow: tierInfo.limits.contextWindow,
        personality: `You are a friendly and playful Twitch chat moderator for ${channelName}. You speak in Spanish by default but can adapt to other languages. You have a good sense of humor and enjoy interacting with chat users. You maintain a fun and engaging atmosphere while still being able to moderate when necessary.`,
        rules: ['Be respectful and friendly with users'],
        knownUsers: [
            {
                username: 'cdom201',
                description: 'Creator, Owner and Developer of you, bot',
                relationship: 'professional',
                lastInteraction: new Date()
            }
        ]
    };
}

export async function getOrCreatePersonality(channelID: string, user: IUsers): Promise<IChannelAIPersonality> {
    const personality = await ChannelAIPersonalitySchema.findOne({ channelID });
    if (personality) {
        return personality;
    }

    return await ChannelAIPersonalitySchema.create(buildDefaultPersonality(channelID, user));
}

export function sanitizeRules(rules: string[] | undefined): string[] | undefined {
    if (!Array.isArray(rules)) {
        return undefined;
    }

    return rules
        .map((rule) => String(rule || '').trim())
        .filter(Boolean);
}

export function sanitizeKnownUsers(knownUsers: UpdatePersonalityRequest['knownUsers']): IChannelAIPersonality['knownUsers'] | undefined {
    if (!Array.isArray(knownUsers)) {
        return undefined;
    }

    return knownUsers
        .map((knownUser) => ({
            username: String(knownUser?.username || '').trim(),
            description: String(knownUser?.description || '').trim(),
            relationship: String(knownUser?.relationship || '').trim(),
            lastInteraction: knownUser?.lastInteraction ? new Date(knownUser.lastInteraction) : new Date()
        }))
        .filter((knownUser) => Boolean(knownUser.username));
}

export function sanitizeProfiles(profiles: UpdatePersonalityRequest['profiles']): IChannelAIPersonality['profiles'] | undefined {
    if (!Array.isArray(profiles)) {
        return undefined;
    }

    return profiles
        .map((profile) => ({
            profileID: String(profile?.profileID || new Types.ObjectId().toString()).trim(),
            name: String(profile?.name || 'Default Personality').trim() || 'Default Personality',
            personality: String(profile?.personality || '').trim(),
            personaMode: profile?.personaMode || 'original',
            personaReference: String(profile?.personaReference || '').trim(),
            tonePreset: profile?.tonePreset || 'balanced',
            voiceProfile: {
                tone: String(profile?.voiceProfile?.tone || 'friendly and playful').trim(),
                cadence: String(profile?.voiceProfile?.cadence || 'short and dynamic').trim(),
                style: String(profile?.voiceProfile?.style || 'chat-native and expressive').trim(),
                catchphrases: Array.isArray(profile?.voiceProfile?.catchphrases)
                    ? profile.voiceProfile.catchphrases.map((catchphrase) => String(catchphrase || '').trim()).filter(Boolean)
                    : []
            },
            createdAt: profile?.createdAt ? new Date(profile.createdAt) : new Date(),
            updatedAt: new Date()
        }))
        .filter((profile) => Boolean(profile.personality));
}

export function sanitizeLearningConfig(
    learningConfig: UpdatePersonalityRequest['learningConfig'],
    currentLearningConfig: IChannelAIPersonality['learningConfig']
): IChannelAIPersonality['learningConfig'] | undefined {
    if (!learningConfig) {
        return undefined;
    }

    const numberValue = (value: number | undefined, fallback: number, min?: number, max?: number): number => {
        const normalized = Number.isFinite(value) ? Number(value) : fallback;
        const withMin = min !== undefined ? Math.max(min, normalized) : normalized;
        return max !== undefined ? Math.min(max, withMin) : withMin;
    };

    return {
        enabled: typeof learningConfig.enabled === 'boolean' ? learningConfig.enabled : currentLearningConfig.enabled,
        autoConfirmEnabled:
            typeof learningConfig.autoConfirmEnabled === 'boolean'
                ? learningConfig.autoConfirmEnabled
                : currentLearningConfig.autoConfirmEnabled,
        autoConfirmThreshold: numberValue(
            learningConfig.autoConfirmThreshold,
            currentLearningConfig.autoConfirmThreshold,
            0,
            1
        ),
        minMessageLength: numberValue(learningConfig.minMessageLength, currentLearningConfig.minMessageLength, 1, 1000),
        maxPendingMemories: numberValue(learningConfig.maxPendingMemories, currentLearningConfig.maxPendingMemories, 1, 10000),
        maxConfirmedMemories: numberValue(
            learningConfig.maxConfirmedMemories,
            currentLearningConfig.maxConfirmedMemories,
            1,
            100000
        ),
        postStreamSummaryEnabled:
            typeof learningConfig.postStreamSummaryEnabled === 'boolean'
                ? learningConfig.postStreamSummaryEnabled
                : currentLearningConfig.postStreamSummaryEnabled,
        weeklyMaintenanceEnabled:
            typeof learningConfig.weeklyMaintenanceEnabled === 'boolean'
                ? learningConfig.weeklyMaintenanceEnabled
                : currentLearningConfig.weeklyMaintenanceEnabled,
        monthlyMaintenanceEnabled:
            typeof learningConfig.monthlyMaintenanceEnabled === 'boolean'
                ? learningConfig.monthlyMaintenanceEnabled
                : currentLearningConfig.monthlyMaintenanceEnabled,
        autoApplyCreates:
            typeof learningConfig.autoApplyCreates === 'boolean'
                ? learningConfig.autoApplyCreates
                : currentLearningConfig.autoApplyCreates,
        autoApplyEdits:
            typeof learningConfig.autoApplyEdits === 'boolean'
                ? learningConfig.autoApplyEdits
                : currentLearningConfig.autoApplyEdits,
        autoApplyArchives:
            typeof learningConfig.autoApplyArchives === 'boolean'
                ? learningConfig.autoApplyArchives
                : currentLearningConfig.autoApplyArchives,
        autoApplyPermanentDeletes:
            typeof learningConfig.autoApplyPermanentDeletes === 'boolean'
                ? learningConfig.autoApplyPermanentDeletes
                : currentLearningConfig.autoApplyPermanentDeletes,
        summaryMinDurationMinutes: numberValue(
            learningConfig.summaryMinDurationMinutes,
            currentLearningConfig.summaryMinDurationMinutes,
            1,
            1440
        ),
        summaryMinChatMessages: numberValue(
            learningConfig.summaryMinChatMessages,
            currentLearningConfig.summaryMinChatMessages,
            1,
            100000
        ),
        createMinConfidence: numberValue(learningConfig.createMinConfidence, currentLearningConfig.createMinConfidence, 0, 1),
        editMinConfidence: numberValue(learningConfig.editMinConfidence, currentLearningConfig.editMinConfidence, 0, 1),
        archiveMinConfidence: numberValue(
            learningConfig.archiveMinConfidence,
            currentLearningConfig.archiveMinConfidence,
            0,
            1
        ),
        deleteMinConfidence: numberValue(learningConfig.deleteMinConfidence, currentLearningConfig.deleteMinConfidence, 0, 1),
        maxActionsPerRun: numberValue(learningConfig.maxActionsPerRun, currentLearningConfig.maxActionsPerRun, 1, 1000),
        maxDeletesPerRun: numberValue(learningConfig.maxDeletesPerRun, currentLearningConfig.maxDeletesPerRun, 0, 1000),
        minMemoryAgeDaysForDelete: numberValue(
            learningConfig.minMemoryAgeDaysForDelete,
            currentLearningConfig.minMemoryAgeDaysForDelete,
            0,
            3650
        ),
        minUnusedDaysForDelete: numberValue(
            learningConfig.minUnusedDaysForDelete,
            currentLearningConfig.minUnusedDaysForDelete,
            0,
            3650
        ),
        semanticChatHistoryEnabled:
            typeof learningConfig.semanticChatHistoryEnabled === 'boolean'
                ? learningConfig.semanticChatHistoryEnabled
                : (currentLearningConfig as any).semanticChatHistoryEnabled ?? true,
        semanticChatHistoryLimit:
            learningConfig.semanticChatHistoryLimit === null
                ? null
                : numberValue(learningConfig.semanticChatHistoryLimit, (currentLearningConfig as any).semanticChatHistoryLimit ?? null, 1, 30),
        semanticChatHistoryPrimaryMinScore: numberValue(
            learningConfig.semanticChatHistoryPrimaryMinScore,
            (currentLearningConfig as any).semanticChatHistoryPrimaryMinScore ?? 0.75,
            0,
            1
        ),
        semanticChatHistoryFallbackMinScore: numberValue(
            learningConfig.semanticChatHistoryFallbackMinScore,
            (currentLearningConfig as any).semanticChatHistoryFallbackMinScore ?? 0.69,
            0,
            1
        )
    };
}

export function sanitizeMemoryPolicy(
    memoryPolicy: UpdatePersonalityRequest['memoryPolicy'],
    currentMemoryPolicy: IChannelAIPersonality['memoryPolicy']
): IChannelAIPersonality['memoryPolicy'] | undefined {
    if (!memoryPolicy) {
        return undefined;
    }

    return {
        prioritizeRecentChat:
            typeof memoryPolicy.prioritizeRecentChat === 'boolean'
                ? memoryPolicy.prioritizeRecentChat
                : currentMemoryPolicy.prioritizeRecentChat,
        allowSensitiveMemories:
            typeof memoryPolicy.allowSensitiveMemories === 'boolean'
                ? memoryPolicy.allowSensitiveMemories
                : currentMemoryPolicy.allowSensitiveMemories,
        allowUserPreferenceMemories:
            typeof memoryPolicy.allowUserPreferenceMemories === 'boolean'
                ? memoryPolicy.allowUserPreferenceMemories
                : currentMemoryPolicy.allowUserPreferenceMemories,
        allowRunningJokes:
            typeof memoryPolicy.allowRunningJokes === 'boolean'
                ? memoryPolicy.allowRunningJokes
                : currentMemoryPolicy.allowRunningJokes
    };
}

/** Cache the chat AI reads the personality from (`utils/ai`). */
export async function invalidatePersonalityCache(channelID: string): Promise<void> {
    const cacheClient = await getDragonflyClient('Messages');
    await cacheClient.del(`twitch:${channelID}:chatbot:personality`);
}

/** Saved personality without creating defaults (null = never set up). */
export async function readChannelPersonality(channelID: string): Promise<IChannelAIPersonality | null> {
    return await ChannelAIPersonalitySchema.findOne({ channelID }).lean() as IChannelAIPersonality | null;
}

/**
 * Applies a PUT body: only the fields present change (lists replace the whole list). Creates the
 * default personality first if the channel has none, updates the plan context window, invalidates
 * the chat cache and a linked pet. Returns the saved personality with its `tier` info.
 */
export async function updateChannelPersonality(channelID: string, user: IUsers, body: UpdatePersonalityRequest): Promise<Record<string, unknown> | null> {
    const personality = await getOrCreatePersonality(channelID, user);
    return await saveLoadedPersonality(channelID, user, personality, body);
}

/** Revision of a stored personality for compare-and-set: every save sets `updatedAt`; `__v` moves when lists are replaced. */
export interface PersonalityRevision {
    updatedAt: Date | string | null;
    version: number | null;
}

/** The revision of a `readChannelPersonality` result (null = the channel has no personality yet). */
export function personalityRevision(stored: (Partial<IChannelAIPersonality> & { __v?: number }) | null): PersonalityRevision | null {
    if (!stored) return null;
    return { updatedAt: stored.updatedAt ?? null, version: typeof stored.__v === 'number' ? stored.__v : null };
}

/**
 * Compare-and-set PUT for the site assistant: the same save as `updateChannelPersonality`, but it
 * only lands while the stored personality still has `revision` (its `updatedAt`/`__v` are added to
 * the save's filter, so a save in between makes it write nothing). `revision` null = the caller saw
 * no personality: the default one is created only if there is still none. Returns `changed` when
 * nothing was written.
 */
export async function updateChannelPersonalityIfUnchanged(channelID: string, user: IUsers, body: UpdatePersonalityRequest, revision: PersonalityRevision | null): Promise<{ saved: Record<string, unknown> | null } | 'changed'> {
    let personality = await ChannelAIPersonalitySchema.findOne({ channelID });
    if (revision === null) {
        if (personality) return 'changed';
        personality = await ChannelAIPersonalitySchema.create(buildDefaultPersonality(channelID, user));
        revision = { updatedAt: (personality as any).updatedAt ?? null, version: (personality as any).__v ?? null };
    }
    if (!personality) return 'changed';
    (personality as any).$where = {
        updatedAt: revision.updatedAt === null ? null : new Date(revision.updatedAt),
        ...(revision.version !== null ? { __v: revision.version } : {})
    };
    try {
        return { saved: await saveLoadedPersonality(channelID, user, personality, body) };
    } catch (error) {
        if (error instanceof mongoose.Error.DocumentNotFoundError || error instanceof mongoose.Error.VersionError) return 'changed';
        throw error;
    }
}

/** Applies a PUT body to a loaded personality and saves it (the route's save, shared with the compare-and-set one). */
async function saveLoadedPersonality(channelID: string, user: IUsers, personality: IChannelAIPersonality, body: UpdatePersonalityRequest): Promise<Record<string, unknown> | null> {
    const tierInfo = getTierLimits(user.plan_tier);

    const linkedPet = await PetSettingsSchema.findOne({ userId: user._id, 'settings.personality.source': 'profile' }).lean();
    const petPersona = () => JSON.stringify({ rules: personality.rules,
        profile: personality.profiles?.find(profile => profile.profileID === linkedPet?.settings.personality.profileId) });
    const previousPetPersona = linkedPet ? petPersona() : null;

    const sanitizedEnabled = typeof body.enabled === 'boolean' ? body.enabled : personality.enabled;
    const sanitizedStreamSummariesEnabled =
        typeof body.streamSummariesEnabled === 'boolean'
            ? body.streamSummariesEnabled
            : ((personality as any).streamSummariesEnabled ?? true);
    const sanitizedRecommendationsEnabled =
        typeof body.recommendationsEnabled === 'boolean'
            ? body.recommendationsEnabled
            : ((personality as any).recommendationsEnabled ?? true);
    const sanitizedProfiles = sanitizeProfiles(body.profiles);
    const sanitizedRules = sanitizeRules(body.rules);
    const sanitizedKnownUsers = sanitizeKnownUsers(body.knownUsers);
    const sanitizedLearningConfig = sanitizeLearningConfig(body.learningConfig, personality.learningConfig);
    const sanitizedMemoryPolicy = sanitizeMemoryPolicy(body.memoryPolicy, personality.memoryPolicy);

    if (body.enabled !== undefined) {
        (personality as any).enabled = sanitizedEnabled;
    }

    if (body.streamSummariesEnabled !== undefined) {
        (personality as any).streamSummariesEnabled = sanitizedStreamSummariesEnabled;
    }

    if (body.recommendationsEnabled !== undefined) {
        (personality as any).recommendationsEnabled = sanitizedRecommendationsEnabled;
    }

    if (sanitizedProfiles !== undefined) {
        (personality as any).profiles = sanitizedProfiles;
    }

    if (body.activeProfileId !== undefined) {
        (personality as any).activeProfileId = String(body.activeProfileId || '').trim();
    }

    if (body.personality !== undefined) {
        (personality as any).personality = String(body.personality || '').trim();
    }

    if (body.personaMode !== undefined) {
        (personality as any).personaMode = body.personaMode;
    }

    if (body.personaReference !== undefined) {
        (personality as any).personaReference = String(body.personaReference || '').trim();
    }

    if (body.tonePreset !== undefined) {
        (personality as any).tonePreset = body.tonePreset;
    }

    if (body.language !== undefined) {
        const lang = body.language;
        (personality as any).language = (lang === 'en' || lang === 'es') ? lang : null;
    }

    if (body.voiceProfile !== undefined) {
        (personality as any).voiceProfile = {
            tone: String(body.voiceProfile?.tone || '').trim(),
            cadence: String(body.voiceProfile?.cadence || '').trim(),
            style: String(body.voiceProfile?.style || '').trim(),
            catchphrases: Array.isArray(body.voiceProfile?.catchphrases)
                ? body.voiceProfile.catchphrases.map((catchphrase) => String(catchphrase || '').trim()).filter(Boolean)
                : []
        };
    }

    if (sanitizedRules !== undefined) {
        (personality as any).rules = sanitizedRules;
    }

    if (sanitizedKnownUsers !== undefined) {
        (personality as any).knownUsers = sanitizedKnownUsers;
    }

    if (sanitizedLearningConfig !== undefined) {
        (personality as any).learningConfig = sanitizedLearningConfig;
    }

    if (sanitizedMemoryPolicy !== undefined) {
        (personality as any).memoryPolicy = sanitizedMemoryPolicy;
    }

    (personality as any).contextWindow = tierInfo.limits.contextWindow;
    (personality as any).updatedAt = new Date();

    await (personality as any).save();
    if (linkedPet && previousPetPersona !== petPersona()) await invalidatePet(String(user._id), 'personality_changed');

    // Invalidate cache so next read gets fresh data
    await invalidatePersonalityCache(channelID);

    const updatedPersonality = await ChannelAIPersonalitySchema.findOne({ channelID });
    const response = (updatedPersonality as any)?.toObject ? (updatedPersonality as any).toObject() : updatedPersonality;

    if (response) {
        (response as any).tier = tierInfo;
    }

    return response;
}
