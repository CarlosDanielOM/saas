import { getDragonflyClient } from '../databases/dragonfly.database.js';
import { recordRedisOpsEstimate } from '../observability/bot_runtime_metrics.js';
import type { IChatMessage } from '../../interfaces/twitch/eventsub.interface.js';

/**
 * Tag permission system — identity resolution (TAG_PERMISSION_SYSTEM.md §2.1).
 *
 * A message author resolves to BOTH a legacy numeric `level` (1..10, max-level
 * semantics identical to the old `giveUserLevel`) and a full `tags` set holding
 * every role the chatter has. Tags are additive: a mod who is also subscribed
 * holds both `mod` and `sub`.
 */
export const ROLE_TAGS = [
    'everyone', 'sub', 'vip', 'founder', 'mod', 'editor', 'admin', 'broadcaster'
] as const;
export type RoleTag = (typeof ROLE_TAGS)[number];

const ROLE_TAG_SET: ReadonlySet<string> = new Set(ROLE_TAGS);

/** Badge set_ids that identify a channel moderator. */
export const MODERATOR_BADGE_IDS: ReadonlySet<string> = new Set(['moderator', 'lead_moderator']);

export const BROADCASTER_USER_LEVEL = 10;

/** Canonical legacy numeric level names (level -> name). */
export const LEGACY_USER_LEVEL_NAMES: Record<number, string> = {
    1: 'everyone',
    2: 'tier1',
    3: 'tier2',
    4: 'tier3',
    5: 'vip',
    6: 'founder',
    7: 'mod',
    8: 'editor',
    9: 'admin',
    10: 'broadcaster'
};

export interface UserIdentity {
    /** Legacy 1..10 max-level, identical semantics to the old giveUserLevel. */
    level: number;
    /** Full role set; always contains `everyone`. */
    tags: Set<RoleTag>;
}

/** Serialized identity used to transport a resolved identity (e.g. AI tool tags). */
export interface SerializedUserIdentity {
    level: number;
    tags: RoleTag[];
}

export function isRoleTag(value: unknown): value is RoleTag {
    return typeof value === 'string' && ROLE_TAG_SET.has(value);
}

export function createUserIdentity(level: number, tags: Iterable<RoleTag> = []): UserIdentity {
    const tagSet = new Set<RoleTag>(tags);
    tagSet.add('everyone');
    return { level, tags: tagSet };
}

/** Explicit broadcaster identity for trusted streamer-authored AST execution. */
export function createBroadcasterIdentity(): UserIdentity {
    return createUserIdentity(BROADCASTER_USER_LEVEL, ['broadcaster']);
}

export function createDefaultIdentity(): UserIdentity {
    return createUserIdentity(1, []);
}

export function serializeUserIdentity(identity: UserIdentity): SerializedUserIdentity {
    return { level: identity.level, tags: [...identity.tags] };
}

/**
 * Safely rehydrates a serialized identity. Unknown shapes fall back to a
 * conservative identity with the given fallback level and no extra tags —
 * never fabricates authorization.
 */
export function parseUserIdentity(raw: unknown, fallbackLevel: number = 1): UserIdentity {
    if (!raw || typeof raw !== 'object') {
        return createUserIdentity(fallbackLevel, []);
    }

    const record = raw as { level?: unknown; tags?: unknown };
    const level = typeof record.level === 'number' && Number.isFinite(record.level)
        ? Math.max(1, Math.min(BROADCASTER_USER_LEVEL, Math.trunc(record.level)))
        : fallbackLevel;
    const tags = Array.isArray(record.tags) ? record.tags.filter(isRoleTag) : [];

    return createUserIdentity(level, tags);
}

interface IBadgeLike {
    set_id?: string;
    id?: string;
}

function badgeSetIds(badges: unknown): string[] {
    if (!Array.isArray(badges)) return [];
    return badges.map((badge) => String((badge as IBadgeLike)?.set_id ?? (badge as IBadgeLike)?.id ?? ''));
}

/**
 * Legacy numeric level from badges alone. Sequential-override (max) semantics
 * exactly matching giveUserLevel: sub=2, vip=5, founder=6, moderator=7.
 */
export function deriveBadgeLevel(badges: unknown): number {
    let level = 1;
    const setIds = badgeSetIds(badges);

    for (const setId of setIds) {
        if (setId === 'subscriber') level = Math.max(level, 2);
        if (setId === 'vip') level = Math.max(level, 5);
        if (setId === 'founder') level = Math.max(level, 6);
        if (MODERATOR_BADGE_IDS.has(setId)) level = Math.max(level, 7);
    }

    return level;
}

/** Role tags derivable from chat badges (editor/admin come from channel role caches). */
export function deriveBadgeTags(badges: unknown): Set<RoleTag> {
    const tags = new Set<RoleTag>();
    const setIds = badgeSetIds(badges);

    for (const setId of setIds) {
        if (setId === 'subscriber') tags.add('sub');
        if (setId === 'vip') tags.add('vip');
        if (setId === 'founder') {
            tags.add('founder');
            tags.add('sub'); // founder implies sub
        }
        if (MODERATOR_BADGE_IDS.has(setId)) tags.add('mod');
    }

    return tags;
}

// ============================================================================
// Canonical Twitch role cache keys (TAG_PERMISSION_SYSTEM.md §2.1)
// ============================================================================

export function editorsKey(channelID: string): string {
    return `twitch:${channelID}:editors`;
}

export function editorsIdsKey(channelID: string): string {
    return `twitch:${channelID}:editors:ids`;
}

export function adminsKey(channelID: string): string {
    return `twitch:${channelID}:admins`;
}

export function adminsIdsKey(channelID: string): string {
    return `twitch:${channelID}:admins:ids`;
}

export function adminDetailKey(channelID: string, adminID: string): string {
    return `twitch:${channelID}:admins:${adminID}`;
}

/** Legacy pre-`twitch:` editor key, deleted during cache refresh. */
export function legacyEditorsKey(channelID: string): string {
    return `${channelID}:channel:editors`;
}

/** Structural subset of the Dragonfly client used by role cache helpers. */
export interface RoleCacheClient {
    sIsMember(key: string, member: string): Promise<number>;
    sAdd(key: string, member: string): Promise<number>;
    sRem(key: string, member: string): Promise<number>;
    del(key: string | string[]): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    keys(pattern: string): Promise<string[]>;
    hSet(key: string, value: Record<string, string>): Promise<number>;
}

export const ROLE_CACHE_TTL_SECONDS = 60 * 60 * 24;

/** Editor row shape produced by the Helix editors endpoint (already normalized). */
export interface EditorCacheEntry {
    user_id: string;
    user_login: string;
}

/**
 * Atomically refreshes both editor sets (normalized logins + stable Twitch IDs)
 * and their TTLs, removing the legacy non-`twitch:` editor key.
 */
export async function refreshEditorCache(
    client: RoleCacheClient,
    channelID: string,
    editors: EditorCacheEntry[]
): Promise<void> {
    await client.del([editorsKey(channelID), editorsIdsKey(channelID), legacyEditorsKey(channelID)]);

    for (const editor of editors) {
        const login = String(editor.user_login || '').toLowerCase();
        if (login) {
            await client.sAdd(editorsKey(channelID), login);
        }
        const id = String(editor.user_id || '');
        if (id) {
            await client.sAdd(editorsIdsKey(channelID), id);
        }
    }

    await client.expire(editorsKey(channelID), ROLE_CACHE_TTL_SECONDS);
    await client.expire(editorsIdsKey(channelID), ROLE_CACHE_TTL_SECONDS);
}

/** Admin row shape loaded from MongoDB for cache population. */
export interface AdminCacheEntry {
    adminID: string;
    adminName: string;
    channelName: string;
    permissions: unknown;
    actived: boolean;
}

function adminPermissionsToString(permissions: unknown): string {
    return JSON.stringify(Array.isArray(permissions) ? permissions : ['*']);
}

/**
 * Rebuilds the canonical admin sets + detail hashes from the database list,
 * clearing stale canonical and legacy keys first.
 */
export async function populateAdminCache(
    client: RoleCacheClient,
    channelID: string,
    admins: AdminCacheEntry[]
): Promise<void> {
    const canonicalKeys = await client.keys(`twitch:${channelID}:admins*`);
    const legacyKeys = await client.keys(`${channelID}:admins*`);
    const keysToDelete = [...canonicalKeys, ...legacyKeys];
    if (keysToDelete.length > 0) {
        await client.del(keysToDelete);
    }

    for (const admin of admins) {
        const adminID = String(admin.adminID || '');
        const adminName = String(admin.adminName || '').toLowerCase();
        if (!adminID || !adminName) continue;

        await client.sAdd(adminsKey(channelID), adminName);
        await client.sAdd(adminsIdsKey(channelID), adminID);
        await client.hSet(adminDetailKey(channelID, adminID), {
            adminID,
            adminName,
            channelID,
            channelName: String(admin.channelName || ''),
            permissions: adminPermissionsToString(admin.permissions),
            actived: String(admin.actived)
        });
    }
}

/** Adds one admin to the canonical sets + detail hash immediately. */
export async function addAdminToRoleCache(
    client: RoleCacheClient,
    channelID: string,
    admin: AdminCacheEntry
): Promise<void> {
    const adminID = String(admin.adminID || '');
    const adminName = String(admin.adminName || '').toLowerCase();
    if (!adminID || !adminName) return;

    await client.sAdd(adminsIdsKey(channelID), adminID);
    await client.sAdd(adminsKey(channelID), adminName);
    await client.hSet(adminDetailKey(channelID, adminID), {
        adminID,
        adminName,
        channelID,
        channelName: String(admin.channelName || ''),
        permissions: adminPermissionsToString(admin.permissions),
        actived: String(admin.actived)
    });
}

/** Removes the login, ID, and detail hash of one admin from the canonical namespace. */
export async function removeAdminFromRoleCache(
    client: RoleCacheClient,
    channelID: string,
    adminID: string,
    adminName: string
): Promise<void> {
    await client.del(adminDetailKey(channelID, adminID));
    await client.sRem(adminsKey(channelID), String(adminName || '').toLowerCase());
    await client.sRem(adminsIdsKey(channelID), adminID);
}

/** Stream lifecycle cleanup: canonical + legacy editor/admin keys. */
export async function clearChannelRoleCache(client: RoleCacheClient, channelID: string): Promise<void> {
    const adminKeys = await client.keys(`twitch:${channelID}:admins*`);
    const legacyAdminKeys = await client.keys(`${channelID}:admins*`);
    const keys = [
        editorsKey(channelID),
        editorsIdsKey(channelID),
        legacyEditorsKey(channelID),
        ...adminKeys,
        ...legacyAdminKeys
    ];
    if (keys.length > 0) {
        await client.del(keys);
    }
}

/** Editor membership by normalized login (used by duel/vanish/ruletarusa). */
export async function isEditorLoginCached(
    client: RoleCacheClient,
    channelID: string,
    login: string
): Promise<boolean> {
    const normalized = String(login || '').toLowerCase();
    if (!normalized) return false;
    const member = await client.sIsMember(editorsKey(channelID), normalized);
    recordRedisOpsEstimate(1);
    return member === 1;
}

/**
 * Resolves the full identity of a chat message author. Editor/admin membership
 * prefers the stable-ID sets and falls back to normalized logins while caches
 * repopulate. Level math is byte-for-byte equivalent to the legacy giveUserLevel.
 */
export async function resolveUserIdentity(
    channelID: string,
    messageEventData: IChatMessage,
    cache?: RoleCacheClient
): Promise<UserIdentity> {
    const badges = messageEventData?.badges ?? [];
    let level = deriveBadgeLevel(badges);
    const tags = deriveBadgeTags(badges);

    const client = cache ?? await getDragonflyClient('resolveUserIdentity');
    const userID = String(messageEventData?.chatter_user_id ?? '');
    const userLogin = String(messageEventData?.chatter_user_login ?? '').toLowerCase();

    const isEditor = await hasCachedRole(client, channelID, 'editors', userID, userLogin);
    if (isEditor) {
        if (level < 8) level = 8;
        tags.add('editor');
    }

    const isAdmin = await hasCachedRole(client, channelID, 'admins', userID, userLogin);
    if (isAdmin) {
        if (level < 9) level = 9;
        tags.add('admin');
    }

    if (messageEventData?.chatter_user_id && messageEventData.chatter_user_id === channelID) {
        level = BROADCASTER_USER_LEVEL;
        tags.add('broadcaster');
    }

    tags.add('everyone');

    return { level, tags };
}

async function hasCachedRole(
    client: RoleCacheClient,
    channelID: string,
    role: 'editors' | 'admins',
    userID: string,
    userLogin: string
): Promise<boolean> {
    if (userID) {
        const idsKey = role === 'editors' ? editorsIdsKey(channelID) : adminsIdsKey(channelID);
        const byID = await client.sIsMember(idsKey, userID);
        recordRedisOpsEstimate(1);
        if (byID === 1) return true;
    }

    if (userLogin) {
        const loginKey = role === 'editors' ? editorsKey(channelID) : adminsKey(channelID);
        const byLogin = await client.sIsMember(loginKey, userLogin);
        recordRedisOpsEstimate(1);
        if (byLogin === 1) return true;
    }

    return false;
}
