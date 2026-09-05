import { Types } from 'mongoose';
import { sendTwitchChatMessage } from '../functions/chats/send_message.chat.js';
import { ban } from '../functions/moderation/ban.moderation.js';
import { FollowAttackLogSchema, type IFollowAttackTrackedFollow } from '../schemas/follow_attack_log.schema.js';
import { FollowDefenseSettingsSchema, type FollowDefenseLanguage, type IFollowDefenseSettings } from '../schemas/follow_defense_settings.schema.js';
import { FollowHateRaidSourceSchema } from '../schemas/follow_hate_raid_source.schema.js';
import { getDragonflyClient } from './databases/dragonfly.database.js';
import {
    FOLLOW_DEFENSE_QUEUE_KEY,
    FOLLOW_DEFENSE_MAX_EVENT_AGE_MS,
    followDefenseKeys,
    followDefenseQueueDataKey,
    type FollowDefenseFollowPayload,
    type FollowDefenseMode,
    type FollowDefenseQueueEvent,
    type FollowDefenseRaidMarker,
    type FollowDefenseState,
    type FollowDefenseTriggerSource
} from './follow_defense_queue.js';
import { error as logError, info as logInfo, warn as logWarn } from './logger.js';
import TwitchStreamers from '../classes/twitch_streamers.class.js';
import { chat as aiChat } from './ai/openrouter/ai.js';

const BOT_ID = '698614112';
const QUEUE_BATCH_SIZE = Math.max(25, Number(process.env.FOLLOW_DEFENSE_QUEUE_BATCH_SIZE || 250));
const FOLLOW_DATA_TTL_SECONDS = Math.max(3600, Number(process.env.FOLLOW_DEFENSE_FOLLOW_DATA_TTL_SECONDS || 24 * 60 * 60));
const RECENT_RETENTION_SECONDS = Math.max(60, Number(process.env.FOLLOW_DEFENSE_RECENT_RETENTION_SECONDS || 300));
const BAN_DELAY_MS = Math.max(0, Number(process.env.FOLLOW_DEFENSE_BAN_DELAY_MS || 200));

interface FollowDefenseRuntimeSettings {
    channelID: string;
    channel: string;
    enabled: boolean;
    silentModeEnabled: boolean;
    protectionModeEnabled: boolean;
    attackModeEnabled: boolean;
    silentThresholdX: number;
    silentWindowYSeconds: number;
    protectionThresholdB: number;
    attackThreshold: number;
    silentDurationSeconds: number;
    baselineFollowsPerHour: number | null;
    language: FollowDefenseLanguage;
    settingsVersion: number;
}

interface BanCacheResult {
    banned: boolean;
    status?: number;
    message?: string;
}

const DEFAULT_SETTINGS: FollowDefenseRuntimeSettings = {
    channelID: '',
    channel: '',
    enabled: true,
    silentModeEnabled: true,
    protectionModeEnabled: true,
    attackModeEnabled: true,
    silentThresholdX: 10,
    silentWindowYSeconds: 5,
    protectionThresholdB: 100,
    attackThreshold: 500,
    silentDurationSeconds: 60,
    baselineFollowsPerHour: null,
    language: 'en',
    settingsVersion: 1
};

const MESSAGES: Record<FollowDefenseLanguage, Record<string, string>> = {
    en: {
        silentSummary: '⚠️ Follow spike detected: {count} follows in {seconds}s. Protection active.',
        protection: '⚠️ Follow flood detected! Follow protection enabled. Use !defmode to activate attack mode.',
        attack: '🚨 Attack mode activated! Banning all followers from this wave.'
    },
    es: {
        silentSummary: '⚠️ Pico de follows detectado: {count} follows en {seconds}s. Protección activa.',
        protection: '⚠️ ¡Avalancha de follows detectada! Protección de follows activada. Usa !defmode para activar el modo ataque.',
        attack: '🚨 ¡Modo ataque activado! Baneando todos los follows de esta ola.'
    }
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson<T>(value: string | null): T | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

function toPositiveInteger(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.max(1, Math.round(parsed));
}

function normalizeSettings(channelID: string, channel: string, settings?: Partial<IFollowDefenseSettings> | null): FollowDefenseRuntimeSettings {
    return {
        channelID,
        channel: settings?.channel || channel || '',
        enabled: settings?.enabled ?? DEFAULT_SETTINGS.enabled,
        silentModeEnabled: settings?.silentModeEnabled ?? DEFAULT_SETTINGS.silentModeEnabled,
        protectionModeEnabled: settings?.protectionModeEnabled ?? DEFAULT_SETTINGS.protectionModeEnabled,
        attackModeEnabled: settings?.attackModeEnabled ?? DEFAULT_SETTINGS.attackModeEnabled,
        silentThresholdX: toPositiveInteger(settings?.silentThresholdX, DEFAULT_SETTINGS.silentThresholdX),
        silentWindowYSeconds: toPositiveInteger(settings?.silentWindowYSeconds, DEFAULT_SETTINGS.silentWindowYSeconds),
        protectionThresholdB: toPositiveInteger(settings?.protectionThresholdB, DEFAULT_SETTINGS.protectionThresholdB),
        attackThreshold: toPositiveInteger(settings?.attackThreshold, DEFAULT_SETTINGS.attackThreshold),
        silentDurationSeconds: toPositiveInteger(settings?.silentDurationSeconds, DEFAULT_SETTINGS.silentDurationSeconds),
        baselineFollowsPerHour: settings?.baselineFollowsPerHour ?? null,
        language: settings?.language === 'es' ? 'es' : 'en',
        settingsVersion: toPositiveInteger(settings?.settingsVersion, DEFAULT_SETTINGS.settingsVersion)
    };
}

async function getSettings(channelID: string, channel = ''): Promise<FollowDefenseRuntimeSettings> {
    const cache = await getDragonflyClient('followDefense.getSettings');
    const keys = followDefenseKeys(channelID);
    const cached = parseJson<FollowDefenseRuntimeSettings>(await cache.get(keys.settings));
    if (cached) {
        return normalizeSettings(channelID, channel || cached.channel, cached);
    }

    const dbSettings = await FollowDefenseSettingsSchema.findOne({ channelID }).lean<IFollowDefenseSettings | null>();
    const settings = normalizeSettings(channelID, channel, dbSettings);
    await cache.set(keys.settings, JSON.stringify(settings));
    return settings;
}

async function getState(channelID: string): Promise<FollowDefenseState | null> {
    const cache = await getDragonflyClient('followDefense.getState');
    return parseJson<FollowDefenseState>(await cache.get(followDefenseKeys(channelID).state));
}

async function setState(state: FollowDefenseState): Promise<void> {
    const cache = await getDragonflyClient('followDefense.setState');
    const keys = followDefenseKeys(state.channelID);
    await cache.set(keys.state, JSON.stringify(state));
    if (state.expiresAt > 0) {
        await cache.zAdd(keys.activeChannels, {
            score: state.expiresAt,
            value: state.channelID
        });
    }
}

function modeRank(mode: FollowDefenseMode): number {
    switch (mode) {
        case 'normal': return 0;
        case 'silent': return 1;
        case 'protection': return 2;
        case 'attack': return 3;
    }
}

async function zCount(key: string, min: number, max: number): Promise<number> {
    const cache = await getDragonflyClient('followDefense.zCount');
    const result = await cache.sendCommand(['ZCOUNT', key, String(min), String(max)]);
    return Number(result || 0);
}

async function zRemRangeByScore(key: string, min: string | number, max: string | number): Promise<void> {
    const cache = await getDragonflyClient('followDefense.zRemRangeByScore');
    await cache.sendCommand(['ZREMRANGEBYSCORE', key, String(min), String(max)]);
}

async function getRaidMarker(channelID: string): Promise<FollowDefenseRaidMarker | null> {
    const cache = await getDragonflyClient('followDefense.getRaidMarker');
    const marker = parseJson<FollowDefenseRaidMarker>(await cache.get(followDefenseKeys(channelID).raid));
    if (!marker || marker.expiresAt <= Date.now()) return null;
    return marker;
}

async function saveFollowPayload(follow: FollowDefenseFollowPayload): Promise<void> {
    const cache = await getDragonflyClient('followDefense.saveFollowPayload');
    const keys = followDefenseKeys(follow.channelID);
    await cache.set(`${keys.followDataPrefix}${follow.eventID}`, JSON.stringify(follow), { EX: FOLLOW_DATA_TTL_SECONDS });
}

async function getFollowPayload(channelID: string, eventID: string): Promise<FollowDefenseFollowPayload | null> {
    const cache = await getDragonflyClient('followDefense.getFollowPayload');
    return parseJson<FollowDefenseFollowPayload>(await cache.get(`${followDefenseKeys(channelID).followDataPrefix}${eventID}`));
}

async function addTrackedFollow(channelID: string, eventID: string, score: number): Promise<void> {
    const cache = await getDragonflyClient('followDefense.addTrackedFollow');
    await cache.zAdd(followDefenseKeys(channelID).tracked, { score, value: eventID });
}

async function addRecentWindowToTracked(channelID: string, windowStart: number, now: number): Promise<void> {
    const cache = await getDragonflyClient('followDefense.addRecentWindowToTracked');
    const keys = followDefenseKeys(channelID);
    const recentEventIds = await cache.zRangeByScore(keys.recent, windowStart, now);
    for (const eventID of recentEventIds) {
        await cache.zAdd(keys.tracked, { score: now, value: eventID });
    }
}

async function getTrackedEventIDs(channelID: string): Promise<string[]> {
    const cache = await getDragonflyClient('followDefense.getTrackedEventIDs');
    return cache.zRangeByScore(followDefenseKeys(channelID).tracked, 0, Date.now());
}

function formatMessage(template: string, params: Record<string, string | number>): string {
    return Object.entries(params).reduce((message, [key, value]) => {
        return message.replaceAll(`{${key}}`, String(value));
    }, template);
}

const DEFENSE_EVENT_DESCRIPTIONS: Record<FollowDefenseLanguage, Record<string, string>> = {
    en: {
        protection: 'A follow flood was detected in the channel. Follow protection mode is now enabled and suspicious followers will be banned. Moderators can activate attack mode with the !defmode command.',
        attack: 'Attack mode is now activated. The bot is banning all followers from this follow-bot wave.'
    },
    es: {
        protection: 'Se detectó una avalancha de follows en el canal. La protección de follows está activada y los follows sospechosos serán baneados. Los moderadores pueden activar el modo ataque con el comando !defmode.',
        attack: 'El modo ataque está activado. El bot está baneando todos los follows de esta ola de follow-bots.'
    }
};

async function sendDefenseMessage(channelID: string, settings: FollowDefenseRuntimeSettings, messageKey: keyof typeof MESSAGES.en): Promise<void> {
    const fallbackMessage = MESSAGES[settings.language][messageKey];
    if (!fallbackMessage) return;

    // Try an in-personality announcement first; fall back to the static
    // message if the AI is unavailable, disabled, or errors out.
    try {
        const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
        const eventDescription = DEFENSE_EVENT_DESCRIPTIONS[settings.language]?.[messageKey] || fallbackMessage;
        if (streamer) {
            const aiResult = await aiChat({
                channelID,
                message: `[SYSTEM EVENT - not a chat message, do not tag anyone] ${eventDescription} Announce this to chat in one short message using your personality. Keep the warning clear.`,
                streamer: streamer as any,
                history: [],
                disableTools: true,
                tags: { badges: [], username: 'system', userLevel: 1 }
            });
            const aiMessage = !aiResult.error ? String(aiResult.message || '').trim() : '';
            if (aiMessage) {
                await sendTwitchChatMessage(channelID, aiMessage.slice(0, 450), null, { channelID });
                return;
            }
        }
    } catch (aiAnnounceError) {
        await logWarn({
            function: 'followDefense.sendDefenseMessage.ai',
            channelID,
            messageKey,
            error: aiAnnounceError instanceof Error ? aiAnnounceError.message : String(aiAnnounceError)
        }, { channelId: channelID, destination: 'cache' });
    }

    await sendTwitchChatMessage(channelID, fallbackMessage, null, { channelID });
}

async function transitionMode(
    follow: FollowDefenseFollowPayload,
    settings: FollowDefenseRuntimeSettings,
    mode: Exclude<FollowDefenseMode, 'normal'>,
    triggeredBy: FollowDefenseTriggerSource,
    reason: string
): Promise<FollowDefenseState | null> {
    const previous = await getState(follow.channelID);
    const now = Date.now();
    if (follow.moderationExpiresAt !== undefined && follow.moderationExpiresAt <= now) return null;
    if (previous && modeRank(previous.mode) >= modeRank(mode) && previous.expiresAt > now) {
        return previous;
    }

    const startedAt = follow.moderationExpiresAt ? new Date(follow.followedAt).getTime() : now;
    const burstStartedAt = previous && previous.expiresAt > now ? previous.burstStartedAt : startedAt;
    const expiresAt = startedAt + (settings.silentDurationSeconds * 1000);
    if (expiresAt <= now) return null;
    const state: FollowDefenseState = {
        mode,
        channelID: follow.channelID,
        channelLogin: follow.channelLogin,
        channelName: follow.channelName,
        modeStartedAt: startedAt,
        burstStartedAt,
        expiresAt,
        triggeredBy,
        lastTransitionReason: reason,
        lastUpdatedAt: now,
        ...(follow.moderationExpiresAt ? { triggerEventID: follow.eventID } : {})
    };

    await setState(state);
    await logInfo({
        worker: 'follow_defense',
        message: 'Follow defense mode transition',
        channelID: follow.channelID,
        mode,
        triggeredBy,
        reason
    }, { channelId: follow.channelID, destination: 'both' });
    return state;
}

async function setManualAttackState(payload: { channelID: string; channelLogin: string; channelName: string; triggeredAt: number }, settings: FollowDefenseRuntimeSettings): Promise<FollowDefenseState> {
    const existing = await getState(payload.channelID);
    const state: FollowDefenseState = {
        mode: 'attack',
        channelID: payload.channelID,
        channelLogin: payload.channelLogin || existing?.channelLogin || '',
        channelName: payload.channelName || existing?.channelName || '',
        modeStartedAt: payload.triggeredAt,
        burstStartedAt: existing?.burstStartedAt || payload.triggeredAt,
        expiresAt: payload.triggeredAt + (settings.silentDurationSeconds * 1000),
        triggeredBy: 'manual',
        lastTransitionReason: 'manual_attack_command',
        lastUpdatedAt: Date.now()
    };
    await setState(state);
    return state;
}

async function cacheBanResult(channelID: string, eventID: string, result: BanCacheResult): Promise<void> {
    const cache = await getDragonflyClient('followDefense.cacheBanResult');
    await cache.set(`${followDefenseKeys(channelID).banDataPrefix}${eventID}`, JSON.stringify(result), { EX: FOLLOW_DATA_TTL_SECONDS });
}

async function getCachedBanResult(channelID: string, eventID: string): Promise<BanCacheResult | null> {
    const cache = await getDragonflyClient('followDefense.getCachedBanResult');
    return parseJson<BanCacheResult>(await cache.get(`${followDefenseKeys(channelID).banDataPrefix}${eventID}`));
}

async function banFollow(channelID: string, eventID: string, reason: string, required = false): Promise<void> {
    const follow = await getFollowPayload(channelID, eventID);
    if (!follow) {
        if (required) throw new Error(`Missing required follow defense payload: ${eventID}`);
        return;
    }

    const alreadyBanned = await getCachedBanResult(channelID, eventID);
    if (alreadyBanned?.banned) return;

    if (required || follow.moderationExpiresAt !== undefined) {
        const occurredAt = new Date(follow.followedAt).getTime();
        const expiresAt = follow.moderationExpiresAt ?? occurredAt + FOLLOW_DEFENSE_MAX_EVENT_AGE_MS;
        if (!Number.isFinite(occurredAt) || occurredAt > Date.now() || expiresAt <= Date.now()) return;
    }

    const result = await ban(channelID, follow.followerID, BOT_ID, null, reason);
    // A lost successful response can retry as "already banned". Other errors are not completion.
    const banned = !result.error || (required && result.status === 400
        && /^The user specified in the user_id field is already banned\.?$/i.test(result.message));
    await cacheBanResult(channelID, eventID, {
        banned,
        status: result.status,
        message: result.message
    });
    if (required && !banned) throw new Error(`Follow defense ban failed (${result.status || 'unknown'}): ${result.message}`);

    if (BAN_DELAY_MS > 0) {
        await sleep(BAN_DELAY_MS);
    }
}

async function banTrackedFollows(channelID: string, required = false): Promise<void> {
    const eventIDs = await getTrackedEventIDs(channelID);
    for (const eventID of eventIDs) {
        await banFollow(channelID, eventID, 'DimaBot follow defense attack mode', required);
    }
}

async function buildTrackedFollowsForLog(channelID: string): Promise<IFollowAttackTrackedFollow[]> {
    const tracked: IFollowAttackTrackedFollow[] = [];
    const eventIDs = await getTrackedEventIDs(channelID);
    for (const eventID of eventIDs) {
        const follow = await getFollowPayload(channelID, eventID);
        if (!follow) continue;
        const banResult = await getCachedBanResult(channelID, eventID);
        tracked.push({
            eventID,
            followerID: follow.followerID,
            followerLogin: follow.followerLogin,
            followerName: follow.followerName,
            followedAt: new Date(follow.followedAt),
            banned: banResult?.banned || false,
            banStatus: banResult?.status,
            banMessage: banResult?.message
        });
    }
    return tracked;
}

async function persistAttackLog(state: FollowDefenseState): Promise<void> {
    const trackedFollows = await buildTrackedFollowsForLog(state.channelID);
    if (trackedFollows.length === 0) return;

    const raidMarker = await getRaidMarker(state.channelID);
    const durationSeconds = Math.max(1, Math.round((Date.now() - state.burstStartedAt) / 1000));
    const velocity = Number((trackedFollows.length / durationSeconds).toFixed(2));
    const isHateRaid = state.triggeredBy === 'manual' && Boolean(raidMarker);

    await FollowAttackLogSchema.create({
        _id: new Types.ObjectId(),
        targetChannelID: state.channelID,
        targetChannelLogin: state.channelLogin,
        targetChannelName: state.channelName,
        modeTriggered: state.mode === 'normal' ? 'silent' : state.mode,
        triggeredBy: state.triggeredBy,
        totalFollows: trackedFollows.length,
        velocity,
        durationSeconds,
        isRaid: Boolean(raidMarker),
        raidInfo: raidMarker ? {
            raiderChannelID: raidMarker.raiderChannelID,
            raiderChannelLogin: raidMarker.raiderChannelLogin,
            raiderChannelName: raidMarker.raiderChannelName,
            raidViewers: raidMarker.raidViewers
        } : undefined,
        trackedFollows,
        isHateRaid
    });

    if (isHateRaid && raidMarker) {
        const now = new Date();
        await FollowHateRaidSourceSchema.findOneAndUpdate({
            targetChannelID: state.channelID,
            raiderChannelID: raidMarker.raiderChannelID
        }, {
            $set: {
                targetChannelLogin: state.channelLogin,
                targetChannelName: state.channelName,
                raiderChannelLogin: raidMarker.raiderChannelLogin,
                raiderChannelName: raidMarker.raiderChannelName,
                lastSeenAt: now
            },
            $inc: { count: 1 },
            $setOnInsert: {
                firstSeenAt: now
            }
        }, {
            upsert: true,
            setDefaultsOnInsert: true
        });
    }
}

async function resetDefenseState(channelID: string): Promise<void> {
    const cache = await getDragonflyClient('followDefense.resetDefenseState');
    const keys = followDefenseKeys(channelID);
    await cache.del(keys.state);
    await cache.del(keys.tracked);
    await cache.zRem(keys.activeChannels, channelID);
}

async function sendSilentSummaryIfNeeded(state: FollowDefenseState, settings: FollowDefenseRuntimeSettings): Promise<void> {
    if (state.mode !== 'silent') return;
    const count = await zCount(followDefenseKeys(state.channelID).tracked, 0, Date.now());
    if (count <= 0) return;
    const message = formatMessage(MESSAGES[settings.language].silentSummary, {
        count,
        seconds: settings.silentDurationSeconds
    });
    await sendTwitchChatMessage(state.channelID, message, null, { channelID: state.channelID });
}

async function handleFollowEvent(follow: FollowDefenseFollowPayload): Promise<void> {
    const settings = await getSettings(follow.channelID, follow.channelName || follow.channelLogin);
    if (!settings.enabled) return;

    const cache = await getDragonflyClient('followDefense.handleFollowEvent');
    const keys = followDefenseKeys(follow.channelID);
    const now = Date.now();
    const durable = follow.moderationExpiresAt !== undefined;
    if (durable && follow.moderationExpiresAt! <= now) return;
    const followedAtMs = new Date(follow.followedAt).getTime();
    const score = Number.isFinite(followedAtMs) ? followedAtMs : now;
    const windowMs = settings.silentWindowYSeconds * 1000;
    const windowStart = now - windowMs;

    await saveFollowPayload(follow);
    await cache.zAdd(keys.recent, { score, value: follow.eventID });
    await zRemRangeByScore(keys.recent, '-inf', now - (RECENT_RETENTION_SECONDS * 1000));

    const raidMarker = await getRaidMarker(follow.channelID);
    const state = await getState(follow.channelID);
    const activeState = state && state.expiresAt > Date.now() ? state : null;
    // A delayed follow from before this wave must not inherit its moderation mode.
    if (durable && activeState && score < activeState.burstStartedAt - windowMs) return;
    if (durable && activeState?.triggerEventID === follow.eventID) {
        // Repair a partial state/index write before resuming the required wave effects.
        await setState(activeState);
    }

    if (raidMarker || (activeState && activeState.mode !== 'normal')) {
        await addTrackedFollow(follow.channelID, follow.eventID, score);
    }

    if (activeState?.mode === 'attack') {
        if (durable && activeState.triggerEventID === follow.eventID) {
            await banTrackedFollows(follow.channelID, true);
        } else {
            await banFollow(follow.channelID, follow.eventID, 'DimaBot follow defense attack mode', durable);
        }
        return;
    }

    if (activeState?.mode === 'protection' && !raidMarker) {
        await banFollow(follow.channelID, follow.eventID, 'DimaBot follow defense protection mode', durable);
        return;
    }

    const recentCount = await zCount(keys.recent, windowStart, now);
    if (durable && (score < windowStart || follow.moderationExpiresAt! <= Date.now())) return;
    const shouldAttack = settings.attackModeEnabled && recentCount >= settings.attackThreshold;
    const shouldProtect = settings.protectionModeEnabled && recentCount >= settings.protectionThresholdB;
    const shouldSilent = settings.silentModeEnabled && recentCount >= settings.silentThresholdX;

    if (shouldAttack && !raidMarker) {
        await addRecentWindowToTracked(follow.channelID, windowStart, now);
        if (!await transitionMode(follow, settings, 'attack', 'threshold', 'attack_threshold')) return;
        await sendDefenseMessage(follow.channelID, settings, 'attack');
        await banTrackedFollows(follow.channelID, durable);
        return;
    }

    if (shouldProtect) {
        await addRecentWindowToTracked(follow.channelID, windowStart, now);
        if (!await transitionMode(follow, settings, 'protection', 'threshold', raidMarker ? 'raid_protection_tracking' : 'protection_threshold')) return;
        if (!raidMarker) {
            await sendDefenseMessage(follow.channelID, settings, 'protection');
            await banFollow(follow.channelID, follow.eventID, 'DimaBot follow defense protection mode', durable);
        }
        return;
    }

    if (shouldSilent) {
        await addRecentWindowToTracked(follow.channelID, windowStart, now);
        await transitionMode(follow, settings, 'silent', 'threshold', 'silent_threshold');
    }
}

export async function processDurableFollowDefenseFollow(follow: FollowDefenseFollowPayload): Promise<void> {
    const occurredAt = new Date(follow.followedAt).getTime();
    if (!follow.eventID || !Number.isFinite(occurredAt)) throw new Error('Invalid durable follow identity or occurrence time');
    const moderationExpiresAt = occurredAt + FOLLOW_DEFENSE_MAX_EVENT_AGE_MS;
    if (occurredAt > Date.now() || moderationExpiresAt <= Date.now()) return;
    const cache = await getDragonflyClient('processDurableFollowDefenseFollow');
    const receiptKey = `${followDefenseKeys(follow.channelID).completedPrefix}${follow.eventID}`;
    if (await cache.get(receiptKey)) return;
    await handleFollowEvent({ ...follow, moderationExpiresAt });
    // The receipt outlives the moderation horizon; cache loss cannot make old events actionable.
    await cache.set(receiptKey, '1', { EX: FOLLOW_DATA_TTL_SECONDS });
}

async function handleManualAttack(event: Extract<FollowDefenseQueueEvent, { type: 'manual_attack' }>): Promise<void> {
    const settings = await getSettings(event.payload.channelID, event.payload.channelName || event.payload.channelLogin);
    if (!settings.enabled || !settings.attackModeEnabled) return;

    const state = await setManualAttackState(event.payload, settings);
    await sendDefenseMessage(event.payload.channelID, settings, 'attack');
    await banTrackedFollows(event.payload.channelID);
    await persistAttackLog(state);
}

export async function processFollowDefenseQueue(): Promise<number> {
    const cache = await getDragonflyClient('processFollowDefenseQueue');
    const now = Date.now();
    const eventIDs = (await cache.zRangeByScore(FOLLOW_DEFENSE_QUEUE_KEY, 0, now)).slice(0, QUEUE_BATCH_SIZE);
    let processed = 0;

    for (const eventID of eventIDs) {
        const removed = await cache.zRem(FOLLOW_DEFENSE_QUEUE_KEY, eventID);
        if (removed === 0) continue;

        const dataKey = followDefenseQueueDataKey(eventID);
        const raw = await cache.get(dataKey);
        if (!raw) continue;

        const event = parseJson<FollowDefenseQueueEvent>(raw);
        await cache.del(dataKey);
        if (!event) continue;

        try {
            if (event.type === 'follow') {
                await handleFollowEvent(event.payload);
            } else if (event.type === 'manual_attack') {
                await handleManualAttack(event);
            }
            processed += 1;
        } catch (error) {
            await logError({
                function: 'processFollowDefenseQueue.event',
                eventID,
                eventType: event.type,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            }, { channelId: 'payload' in event ? event.payload.channelID : undefined, destination: 'both' });
        }
    }

    return processed;
}

export async function expireFollowDefenseModes(): Promise<number> {
    const cache = await getDragonflyClient('expireFollowDefenseModes');
    const activeKey = followDefenseKeys('global').activeChannels;
    const now = Date.now();
    const channelIDs = await cache.zRangeByScore(activeKey, 0, now);
    let expired = 0;

    for (const channelID of channelIDs) {
        await cache.zRem(activeKey, channelID);
        const state = await getState(channelID);
        if (!state || state.expiresAt > now) continue;

        try {
            const settings = await getSettings(channelID, state.channelName || state.channelLogin);
            await sendSilentSummaryIfNeeded(state, settings);
            await persistAttackLog(state);
            await resetDefenseState(channelID);
            expired += 1;
        } catch (error) {
            await logWarn({
                function: 'expireFollowDefenseModes',
                channelID,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            }, { channelId: channelID, destination: 'both' });
        }
    }

    return expired;
}
