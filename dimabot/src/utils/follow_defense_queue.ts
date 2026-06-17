import { getDragonflyClient } from './databases/dragonfly.database.js';
import type { IFollowEvent } from '../interfaces/twitch/eventsub.interface.js';
import { error as logError } from './logger.js';

export type FollowDefenseMode = 'normal' | 'silent' | 'protection' | 'attack';
export type FollowDefenseQueueEventType = 'follow' | 'manual_attack';
export type FollowDefenseTriggerSource = 'threshold' | 'manual';

export interface FollowDefenseFollowPayload {
    eventID: string;
    channelID: string;
    channelLogin: string;
    channelName: string;
    followerID: string;
    followerLogin: string;
    followerName: string;
    followedAt: string;
    receivedAt: number;
}

export interface FollowDefenseManualAttackPayload {
    eventID: string;
    channelID: string;
    channelLogin: string;
    channelName: string;
    triggeredBy: FollowDefenseTriggerSource;
    triggeredAt: number;
}

export type FollowDefenseQueueEvent =
    | { type: 'follow'; payload: FollowDefenseFollowPayload }
    | { type: 'manual_attack'; payload: FollowDefenseManualAttackPayload };

export interface FollowDefenseState {
    mode: FollowDefenseMode;
    channelID: string;
    channelLogin: string;
    channelName: string;
    modeStartedAt: number;
    burstStartedAt: number;
    expiresAt: number;
    triggeredBy: FollowDefenseTriggerSource;
    lastTransitionReason: string;
    lastUpdatedAt: number;
}

export interface FollowDefenseRaidMarker {
    channelID: string;
    channelLogin: string;
    channelName: string;
    raiderChannelID: string;
    raiderChannelLogin: string;
    raiderChannelName: string;
    raidViewers: number;
    createdAt: number;
    expiresAt: number;
}

export const FOLLOW_DEFENSE_QUEUE_KEY = 'twitch:follow-defense:queue';
const QUEUE_DATA_PREFIX = 'twitch:follow-defense:queue:data:';
const QUEUE_EVENT_TTL_SECONDS = 24 * 60 * 60;

export function followDefenseKeys(channelID: string) {
    return {
        settings: `twitch:${channelID}:follow-defense:settings`,
        state: `twitch:${channelID}:follow-defense:state`,
        recent: `twitch:${channelID}:follow-defense:recent`,
        tracked: `twitch:${channelID}:follow-defense:tracked`,
        followDataPrefix: `twitch:${channelID}:follow-defense:follow:`,
        banDataPrefix: `twitch:${channelID}:follow-defense:ban:`,
        raid: `twitch:${channelID}:follow-defense:raid`,
        activeChannels: 'twitch:follow-defense:active-channels'
    };
}

export function followDefenseQueueDataKey(eventID: string): string {
    return `${QUEUE_DATA_PREFIX}${eventID}`;
}

function createEventID(channelID: string, subjectID: string): string {
    return `${channelID}:${subjectID}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function parseJson<T>(value: string | null): T | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

async function isDisabledInCachedSettings(channelID: string): Promise<boolean> {
    const cache = await getDragonflyClient('isDisabledInCachedSettings');
    const cachedSettings = parseJson<{ enabled?: boolean }>(await cache.get(followDefenseKeys(channelID).settings));
    return cachedSettings?.enabled === false;
}

async function enqueueFollowDefenseEvent(event: FollowDefenseQueueEvent): Promise<void> {
    const cache = await getDragonflyClient('enqueueFollowDefenseEvent');
    const eventID = event.payload.eventID;
    await cache.set(followDefenseQueueDataKey(eventID), JSON.stringify(event), { EX: QUEUE_EVENT_TTL_SECONDS });
    await cache.zAdd(FOLLOW_DEFENSE_QUEUE_KEY, {
        score: Date.now(),
        value: eventID
    });
}

export async function enqueueFollowDefenseFollow(eventData: IFollowEvent): Promise<void> {
    try {
        if (await isDisabledInCachedSettings(eventData.broadcaster_user_id)) {
            return;
        }

        const eventID = createEventID(eventData.broadcaster_user_id, eventData.user_id);
        await enqueueFollowDefenseEvent({
            type: 'follow',
            payload: {
                eventID,
                channelID: eventData.broadcaster_user_id,
                channelLogin: eventData.broadcaster_user_login || '',
                channelName: eventData.broadcaster_user_name || '',
                followerID: eventData.user_id,
                followerLogin: eventData.user_login || '',
                followerName: eventData.user_name || '',
                followedAt: eventData.followed_at || new Date().toISOString(),
                receivedAt: Date.now()
            }
        });
    } catch (error) {
        await logError({
            function: 'enqueueFollowDefenseFollow',
            channelID: eventData.broadcaster_user_id,
            followerID: eventData.user_id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        }, { channelId: eventData.broadcaster_user_id, destination: 'both' });
    }
}

export async function shouldSuppressFollowAlerts(channelID: string): Promise<boolean> {
    try {
        if (await isDisabledInCachedSettings(channelID)) {
            return false;
        }

        const cache = await getDragonflyClient('shouldSuppressFollowAlerts');
        const state = parseJson<FollowDefenseState>(await cache.get(followDefenseKeys(channelID).state));
        if (!state || state.mode === 'normal') return false;
        if (state.expiresAt > 0 && state.expiresAt <= Date.now()) return false;
        return state.mode === 'silent' || state.mode === 'protection' || state.mode === 'attack';
    } catch {
        return false;
    }
}

export async function setFollowDefenseRaidMarker(marker: Omit<FollowDefenseRaidMarker, 'createdAt' | 'expiresAt'>, ttlSeconds = 300): Promise<void> {
    try {
        const now = Date.now();
        const cache = await getDragonflyClient('setFollowDefenseRaidMarker');
        const payload: FollowDefenseRaidMarker = {
            ...marker,
            createdAt: now,
            expiresAt: now + (ttlSeconds * 1000)
        };
        await cache.set(followDefenseKeys(marker.channelID).raid, JSON.stringify(payload), { EX: ttlSeconds });
    } catch (error) {
        await logError({
            function: 'setFollowDefenseRaidMarker',
            channelID: marker.channelID,
            raiderChannelID: marker.raiderChannelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        }, { channelId: marker.channelID, destination: 'both' });
    }
}

export async function triggerFollowDefenseAttackMode(channelID: string, channelLogin = '', channelName = ''): Promise<void> {
    const eventID = createEventID(channelID, 'manual-attack');
    const now = Date.now();
    const cache = await getDragonflyClient('triggerFollowDefenseAttackMode');
    const existingState = parseJson<FollowDefenseState>(await cache.get(followDefenseKeys(channelID).state));
    const state: FollowDefenseState = {
        mode: 'attack',
        channelID,
        channelLogin: channelLogin || existingState?.channelLogin || '',
        channelName: channelName || existingState?.channelName || '',
        modeStartedAt: now,
        burstStartedAt: existingState?.burstStartedAt || now,
        expiresAt: existingState?.expiresAt || now + 60_000,
        triggeredBy: 'manual',
        lastTransitionReason: 'manual_attack_command',
        lastUpdatedAt: now
    };
    await cache.set(followDefenseKeys(channelID).state, JSON.stringify(state));
    await enqueueFollowDefenseEvent({
        type: 'manual_attack',
        payload: {
            eventID,
            channelID,
            channelLogin: state.channelLogin,
            channelName: state.channelName,
            triggeredBy: 'manual',
            triggeredAt: now
        }
    });
}

export async function getFollowDefenseStatus(channelID: string): Promise<FollowDefenseState | null> {
    const cache = await getDragonflyClient('getFollowDefenseStatus');
    return parseJson<FollowDefenseState>(await cache.get(followDefenseKeys(channelID).state));
}
