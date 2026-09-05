import { randomUUID } from 'node:crypto';
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
    moderationExpiresAt?: number;
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
    triggerEventID?: string;
    version?: string;
    manualEventID?: string;
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
    eventID?: string;
}

export const FOLLOW_DEFENSE_QUEUE_KEY = 'twitch:follow-defense:queue';
// Delayed delivery is not evidence of a current attack. Never moderate backlog.
export const FOLLOW_DEFENSE_MAX_EVENT_AGE_MS = 60_000;
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
        completedPrefix: `twitch:${channelID}:follow-defense:completed:`,
        raid: `twitch:${channelID}:follow-defense:raid`,
        activeChannels: 'twitch:follow-defense:active-channels'
    };
}

export function followDefenseQueueDataKey(eventID: string): string {
    return `${QUEUE_DATA_PREFIX}${eventID}`;
}

type StateMutation =
    | { type: 'repair' }
    | { type: 'reset'; token: string }
    | { type: 'transition'; state: FollowDefenseState; moderationExpiresAt?: number }
    | { type: 'manual'; state: FollowDefenseState; preserveExpiry?: boolean };

export async function projectFollowDefenseState(channelID: string, mutation: StateMutation = { type: 'repair' }): Promise<{
    changed: boolean; state: FollowDefenseState | null; token: string;
}> {
    const cache = await getDragonflyClient('followDefense.projectState');
    const keys = followDefenseKeys(channelID);
    // All writers use the same projection. Check types before any mutation: Lua errors do not roll back Redis writes.
    const result = await cache.eval(`
local stateType = redis.call('TYPE', KEYS[1]).ok
local indexType = redis.call('TYPE', KEYS[2]).ok
local trackedType = redis.call('TYPE', KEYS[3]).ok
if (stateType ~= 'none' and stateType ~= 'string') or
   (indexType ~= 'none' and indexType ~= 'zset') or
   (trackedType ~= 'none' and trackedType ~= 'zset') then
    return redis.error_reply('WRONGTYPE follow defense state projection')
end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local raw = redis.call('GET', KEYS[1])
local current = raw and cjson.decode(raw) or nil
local function project(state)
    if state and state.expiresAt > 0 then
        redis.call('ZADD', KEYS[2], state.expiresAt, ARGV[1])
    else
        redis.call('ZREM', KEYS[2], ARGV[1])
    end
end
local function unchanged()
    project(current)
    return {0, raw or ''}
end
if ARGV[2] == 'repair' then return unchanged() end
if ARGV[2] == 'reset' then
    if not raw or raw ~= ARGV[3] or current.expiresAt > now then return unchanged() end
    redis.call('DEL', KEYS[1], KEYS[3])
    redis.call('ZREM', KEYS[2], ARGV[1])
    return {1, ''}
end
local incoming = cjson.decode(ARGV[3])
if incoming.expiresAt <= now or (tonumber(ARGV[4]) > 0 and tonumber(ARGV[4]) <= now) then
    return unchanged()
end
local active = current and current.expiresAt > now
if ARGV[2] == 'transition' then
    local rank = {normal = 0, silent = 1, protection = 2, attack = 3}
    if active and rank[current.mode] >= rank[incoming.mode] then return unchanged() end
else
    -- A queued older command must not replace a newer mode. The same command may finish its configured-duration write.
    if current and current.modeStartedAt > incoming.modeStartedAt then return unchanged() end
    if ARGV[5] ~= '1' and current and current.modeStartedAt == incoming.modeStartedAt and
       current.manualEventID and current.manualEventID ~= incoming.manualEventID then return unchanged() end
    if incoming.channelLogin == '' and current then incoming.channelLogin = current.channelLogin end
    if incoming.channelName == '' and current then incoming.channelName = current.channelName end
    if ARGV[5] == '1' and active then incoming.expiresAt = current.expiresAt end
end
if active then incoming.burstStartedAt = current.burstStartedAt end
local nextRaw = cjson.encode(incoming)
redis.call('SET', KEYS[1], nextRaw)
project(incoming)
return {1, nextRaw}
`, {
        keys: [keys.state, keys.activeChannels, keys.tracked],
        arguments: [channelID, mutation.type,
            'state' in mutation ? JSON.stringify({ ...mutation.state, version: randomUUID() }) : mutation.type === 'reset' ? mutation.token : '',
            String(mutation.type === 'transition' ? mutation.moderationExpiresAt || 0 : 0),
            mutation.type === 'manual' && mutation.preserveExpiry ? '1' : '0']
    }) as [number, string];
    return { changed: result[0] === 1, state: result[1] ? JSON.parse(result[1]) as FollowDefenseState : null, token: result[1] };
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

export async function applyDurableFollowDefenseRaidMarker(marker: FollowDefenseRaidMarker): Promise<void> {
    if (!Number.isFinite(marker.createdAt) || !Number.isFinite(marker.expiresAt) || !marker.eventID) {
        throw new Error('Invalid durable raid marker identity or occurrence time');
    }
    if (marker.expiresAt <= Date.now()) return;
    const cache = await getDragonflyClient('applyDurableFollowDefenseRaidMarker');
    // Compare and write atomically; retries neither extend expiry nor replace a newer raid.
    await cache.eval(`
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if tonumber(ARGV[3]) <= now then return 0 end
local raw = redis.call('GET', KEYS[1])
if raw then
    local previous = cjson.decode(raw)
    if previous.createdAt > tonumber(ARGV[2]) then return 0 end
    if previous.createdAt == tonumber(ARGV[2]) and (previous.eventID or '') >= ARGV[4] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[3])
return 1
`, {
        keys: [followDefenseKeys(marker.channelID).raid],
        arguments: [JSON.stringify(marker), String(marker.createdAt), String(marker.expiresAt), marker.eventID]
    });
}

export async function triggerFollowDefenseAttackMode(channelID: string, channelLogin = '', channelName = ''): Promise<void> {
    const eventID = createEventID(channelID, 'manual-attack');
    const now = Date.now();
    const state: FollowDefenseState = {
        mode: 'attack',
        channelID,
        channelLogin,
        channelName,
        modeStartedAt: now,
        burstStartedAt: now,
        expiresAt: now + 60_000,
        triggeredBy: 'manual',
        lastTransitionReason: 'manual_attack_command',
        lastUpdatedAt: now,
        manualEventID: eventID
    };
    const projected = await projectFollowDefenseState(channelID, { type: 'manual', state, preserveExpiry: true });
    if (!projected.changed) return;
    await enqueueFollowDefenseEvent({
        type: 'manual_attack',
        payload: {
            eventID,
            channelID,
            channelLogin: projected.state!.channelLogin,
            channelName: projected.state!.channelName,
            triggeredBy: 'manual',
            triggeredAt: now
        }
    });
}

export async function getFollowDefenseStatus(channelID: string): Promise<FollowDefenseState | null> {
    const cache = await getDragonflyClient('getFollowDefenseStatus');
    return parseJson<FollowDefenseState>(await cache.get(followDefenseKeys(channelID).state));
}
