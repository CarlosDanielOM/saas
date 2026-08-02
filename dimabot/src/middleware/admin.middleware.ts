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

    const permissionsToCheck = ['*', ...(Array.isArray(permission) ? permission : [permission])];
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
