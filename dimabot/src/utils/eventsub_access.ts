import { AdminSchema } from '../schemas/admin.schema.js';
import { hasGlobalChannelOwnerAccess } from '../middleware/admin.middleware.js';

/** Chat events access: the owner, global owners, or a channel admin with the eventsubs grant. */
export async function getEventsubAccess(requesterID: string, channelID: string, permission: 'eventsubs:view' | 'eventsubs:manage' = 'eventsubs:view'): Promise<'owner' | 'admin' | 'none'> {
    if (requesterID === channelID) {
        return 'owner';
    }

    if (await hasGlobalChannelOwnerAccess(requesterID, channelID)) {
        return 'owner';
    }

    const admin = await AdminSchema.findOne({
        channelID,
        adminID: requesterID,
        actived: true,
        permissions: { $in: ['*', permission] }
    }).lean();

    return admin ? 'admin' : 'none';
}
