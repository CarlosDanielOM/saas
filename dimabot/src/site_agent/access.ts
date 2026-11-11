/**
 * Who is asking, on which channel, with which rights. The assistant needs website access to the
 * channel (`dashboard:view`, like the dashboard shell); each tool then needs ALL of its permissions.
 * `getChannelAccessContext` matches ANY of a list, so tools must not pass several permissions to it.
 */
import { AdminSchema } from '../schemas/admin.schema.js';
import UsersSchema from '../schemas/users.schema.js';
import { hasGlobalChannelOwnerAccess } from '../middleware/admin.middleware.js';
import { channelPlanTier } from '../server/services/command_blocks.service.js';
import type { Lang, PlanTier } from './types.js';

export interface ChannelAccess {
    channelId: string;
    channelLogin: string;
    role: 'owner' | 'admin';
    plan: PlanTier;
    /** Requester's saved site language, if any. */
    savedLang: Lang | null;
}

interface Grants {
    role: 'owner' | 'admin' | 'none';
    permissions: Set<string>;
}

async function loadGrants(requesterId: string, channelId: string): Promise<Grants> {
    if (!requesterId || !channelId) return { role: 'none', permissions: new Set() };
    if (requesterId === channelId || await hasGlobalChannelOwnerAccess(requesterId, channelId)) {
        return { role: 'owner', permissions: new Set(['*']) };
    }
    const admin = await AdminSchema.findOne({ channelID: channelId, adminID: requesterId, actived: true })
        .select('permissions').lean() as { permissions?: string[] } | null;
    if (!admin) return { role: 'none', permissions: new Set() };
    return { role: 'admin', permissions: new Set(admin.permissions ?? []) };
}

/** Same expansion rules as `expandChannelPermissionChecks`, applied to one permission. */
function grants(set: Set<string>, permission: string): boolean {
    if (set.has('*')) return true;
    if (permission === '*' || permission === 'owner') return false;
    if (set.has(permission)) return true;
    if (permission.startsWith('triggers:') && set.has('triggers:all')) return true;
    if (permission.startsWith('dimafx:') && set.has('dimafx:all')) return true;
    return false;
}

export function hasAll(g: Grants, permissions: readonly string[]): boolean {
    if (g.role === 'none') return false;
    if (g.role === 'owner') return true;
    return permissions.every((permission) => grants(g.permissions, permission));
}

/**
 * Permission checker for one turn. Caches grants for a short time; `fresh` forces a reload
 * (used right before applying an approved change or undoing one).
 */
export function permissionChecker(requesterId: string, channelId: string, ttlMs = 30_000) {
    let cached: { at: number; grants: Grants } | null = null;
    return async (permissions: readonly string[], fresh = false): Promise<boolean> => {
        if (fresh || !cached || Date.now() - cached.at > ttlMs) {
            cached = { at: Date.now(), grants: await loadGrants(requesterId, channelId) };
        }
        return hasAll(cached.grants, permissions);
    };
}

/** Null when the requester has no website access to the channel. */
export async function resolveAccess(requesterId: string, channelId: string): Promise<ChannelAccess | null> {
    if (!/^\d{1,20}$/.test(channelId)) return null;
    const g = await loadGrants(requesterId, channelId);
    if (g.role === 'none' || !hasAll(g, ['dashboard:view'])) return null;
    const [channel, requester, plan] = await Promise.all([
        UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: channelId } } }).select('accounts language').lean(),
        requesterId === channelId ? null : UsersSchema.findOne({ accounts: { $elemMatch: { type: 'twitch', id: requesterId } } }).select('language').lean(),
        channelPlanTier(channelId),
    ]);
    if (!channel) return null;
    const account = (channel.accounts ?? []).find((item: { type?: string; id?: string }) => item.type === 'twitch' && item.id === channelId) as { name?: string } | undefined;
    const language = (requesterId === channelId ? (channel as { language?: string | null }).language : requester?.language) ?? null;
    return {
        channelId,
        channelLogin: (account?.name ?? channelId).toLowerCase(),
        role: g.role === 'owner' ? 'owner' : 'admin',
        plan,
        savedLang: language === 'es' || language === 'en' ? language : null,
    };
}

export function roleFor(requesterId: string, access: ChannelAccess): 'owner' | 'admin' {
    return requesterId === access.channelId ? 'owner' : access.role;
}
