import type { NextFunction, Request, Response } from 'express';
import { AdminSchema } from '../schemas/admin.schema.js';
import type { AuthRequest } from './types.js';
import { error } from '../utils/logger.js';

export const CREATOR_TWITCH_USER_ID = '533538623';

export type AdminRole = 'creator' | 'super' | 'support' | 'billing' | 'channel';
export type GlobalAdminRole = Extract<AdminRole, 'creator' | 'super'>;

const GLOBAL_ADMIN_ROLES: GlobalAdminRole[] = ['creator', 'super'];

function normalizeAdminRole(value: unknown): AdminRole | null {
    if (
        value === 'creator' ||
        value === 'super' ||
        value === 'support' ||
        value === 'billing' ||
        value === 'channel'
    ) {
        return value;
    }

    return null;
}

export function isCreatorUser(userID: string | undefined | null): boolean {
    return userID === CREATOR_TWITCH_USER_ID;
}

export function isCreatorTarget(targetID: string | undefined | null): boolean {
    return targetID === CREATOR_TWITCH_USER_ID;
}

export function canModifyCreatorAdminAssignment(
    requesterID: string | undefined | null,
    channelID: string | undefined | null,
    targetAdminID: string | undefined | null
): boolean {
    if (!isCreatorTarget(targetAdminID)) {
        return true;
    }

    return isCreatorUser(requesterID) || requesterID === channelID;
}

export async function getGlobalAdminRole(userID: string | undefined | null): Promise<GlobalAdminRole | null> {
    if (!userID) {
        return null;
    }

    // Hard fallback so the bot creator cannot be locked out by a missing/misconfigured DB role.
    if (isCreatorUser(userID)) {
        return 'creator';
    }

    const adminRows = await AdminSchema.find({
        adminID: userID,
        actived: true,
        role: { $in: GLOBAL_ADMIN_ROLES }
    })
        .select('role')
        .lean();

    const roles = adminRows
        .map((admin) => normalizeAdminRole(admin.role))
        .filter((role): role is GlobalAdminRole => role === 'creator' || role === 'super');

    if (roles.includes('creator')) {
        return 'creator';
    }

    if (roles.includes('super')) {
        return 'super';
    }

    return null;
}

export async function hasGlobalChannelOwnerAccess(
    requesterID: string | undefined | null,
    targetChannelID: string | undefined | null
): Promise<boolean> {
    if (!requesterID || !targetChannelID) {
        return false;
    }

    const role = await getGlobalAdminRole(requesterID);
    if (role === 'creator') {
        return true;
    }

    // Super admins can act as owners globally, except against the creator's channel/account.
    if (role === 'super') {
        return !isCreatorTarget(targetChannelID);
    }

    return false;
}

export interface ChannelAccessContext {
    allowed: boolean;
    role: 'owner' | 'admin' | 'none';
}

/** Preserve legacy module-wide grants when checking a specific feature action. */
export function expandChannelPermissionChecks(permission: string | string[]): string[] {
    const requested = (Array.isArray(permission) ? permission : [permission])
        .filter((value): value is string => typeof value === 'string');
    return [...new Set([
        '*',
        ...requested,
        ...(requested.some((value) => value.startsWith('triggers:')) ? ['triggers:all'] : []),
        ...(requested.some((value) => value.startsWith('dimafx:')) ? ['dimafx:all'] : [])
    ])];
}

export async function getChannelAccessContext(
    requesterID: string | undefined | null,
    targetChannelID: string | undefined | null,
    permission: string | string[]
): Promise<ChannelAccessContext> {
    if (!requesterID || !targetChannelID) {
        return { allowed: false, role: 'none' };
    }

    if (requesterID === targetChannelID) {
        return { allowed: true, role: 'owner' };
    }

    if (await hasGlobalChannelOwnerAccess(requesterID, targetChannelID)) {
        return { allowed: true, role: 'owner' };
    }

    const permissionsToCheck = expandChannelPermissionChecks(permission);
    const admin = await AdminSchema.findOne({
        channelID: targetChannelID,
        adminID: requesterID,
        actived: true,
        permissions: { $in: permissionsToCheck }
    }).lean();

    if (admin) {
        return { allowed: true, role: 'admin' };
    }

    return { allowed: false, role: 'none' };
}

export const MAX_ACCESS_PERMISSIONS = 20;
const PERMISSION_NAME_PATTERN = /^[a-z0-9_*:-]{1,64}$/i;

/** null when the query has no `permissions` param; [] when it is present but invalid. */
export function parsePermissionList(raw: unknown): string[] | null {
    if (raw === undefined) {
        return null;
    }
    const values = (Array.isArray(raw) ? raw : [raw])
        .flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
        .map((value) => value.trim())
        .filter(Boolean);
    const unique = [...new Set(values)];
    if (unique.length === 0 || unique.length > MAX_ACCESS_PERMISSIONS || !unique.every((value) => PERMISSION_NAME_PATTERN.test(value))) {
        return [];
    }
    return unique;
}

/** Which of the requested permissions a channel admin's granted list covers (legacy grants included). */
export function resolveGrantedPermissions(granted: string[], requested: string[]): Record<string, boolean> {
    const grantedSet = new Set(granted);
    return Object.fromEntries(requested.map((permission) => [
        permission,
        expandChannelPermissionChecks(permission).some((candidate) => grantedSet.has(candidate))
    ]));
}

export interface ChannelAccessDecisions {
    role: 'owner' | 'admin' | 'none';
    permissions: Record<string, boolean>;
}

/**
 * Per-permission variant of getChannelAccessContext: resolves several permissions for
 * one channel with a single admin lookup, instead of one request per permission.
 */
export async function getChannelAccessDecisions(
    requesterID: string | undefined | null,
    targetChannelID: string | undefined | null,
    permissions: string[]
): Promise<ChannelAccessDecisions> {
    const all = (allowed: boolean) => Object.fromEntries(permissions.map((permission) => [permission, allowed]));

    if (!requesterID || !targetChannelID) {
        return { role: 'none', permissions: all(false) };
    }

    if (requesterID === targetChannelID || await hasGlobalChannelOwnerAccess(requesterID, targetChannelID)) {
        return { role: 'owner', permissions: all(true) };
    }

    const rows = await AdminSchema.find({
        channelID: targetChannelID,
        adminID: requesterID,
        actived: true
    })
        .select('permissions')
        .lean();

    const decisions = resolveGrantedPermissions(rows.flatMap((row) => row.permissions ?? []), permissions);
    const anyAllowed = Object.values(decisions).some(Boolean);
    return { role: anyAllowed ? 'admin' : 'none', permissions: decisions };
}

export async function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    console.log('adminMiddleware');
    try {
        if (!req.user || !req.user.id) {
            res.status(401).json({
                error: true,
                message: 'Authentication required',
                status: 401,
                type: 'authentication_required'
            });
            return;
        }

        const admin = await AdminSchema.findOne({
            adminID: req.user.id,
            actived: true
        });

        if (!admin) {
            res.status(403).json({
                error: true,
                message: 'Admin privileges required',
                status: 403,
                type: 'admin_required'
            });
            return;
        }

        const role = normalizeAdminRole(admin.role);
        if (role === 'creator' || role === 'super') {
            (req as AuthRequest & { globalAdminRole?: GlobalAdminRole; isSuperAdmin?: boolean }).globalAdminRole = role;
            (req as AuthRequest & { globalAdminRole?: GlobalAdminRole; isSuperAdmin?: boolean }).isSuperAdmin = true;
        }

        next();
    } catch (err) {
        await error({
            function: 'adminMiddleware',
            userId: req.user?.id,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined
        }, { destination: 'both' });

        res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500,
            type: 'internal_error'
        });
    }
}
