import { getDragonflyClient } from './databases/dragonfly.database.js';
import { error } from './logger.js';
import { AdminSchema } from '../schemas/admin.schema.js';
import type { IAdmin } from '../schemas/admin.schema.js';

/**
 * Loads active channel admins from MongoDB into Redis cache.
 * Called when a stream goes online to ensure admin data is available for user level checks.
 */
export async function loadChannelAdminsIntoCache(channelID: string): Promise<void> {
    try {
        const cache = await getDragonflyClient('loadChannelAdminsIntoCache');

        // Fetch active admins from MongoDB
        const admins = await AdminSchema.find({ channelID, actived: true }).lean<IAdmin[]>();

        // Clear existing admin cache keys (pattern: twitch:${channelID}:admins*)
        const existingKeys = await cache.keys(`twitch:${channelID}:admins*`);
        for (const key of existingKeys) {
            await cache.del(key);
        }

        // Populate cache with admin data
        for (const admin of admins) {
            // Set: twitch:${channelID}:admins -> username
            await cache.sAdd(`twitch:${channelID}:admins`, admin.adminName);

            // Set: twitch:${channelID}:admins:ids -> adminID
            await cache.sAdd(`twitch:${channelID}:admins:ids`, admin.adminID);

            // Hash: twitch:${channelID}:admins:${adminID}
            await cache.hSet(`twitch:${channelID}:admins:${admin.adminID}`, {
                adminID: admin.adminID,
                adminName: admin.adminName,
                channelID: admin.channelID,
                channelName: admin.channelName,
                permissions: JSON.stringify(admin.permissions),
                actived: String(admin.actived)
            });
        }

        console.log(`Loaded ${admins.length} admins into cache for channel ${channelID}`);
    } catch (err) {
        await error({
            function: 'loadChannelAdminsIntoCache',
            channelID,
            error: err instanceof Error ? err.message : String(err)
        });
    }
}

export async function clearChannelCache(channelID: string): Promise<void> {
    try {
        const cache = await getDragonflyClient('clearChannelCache');
        await cache.del(`${channelID}:follows:count`);
        await cache.del(`${channelID}:commands`);
    } catch (err) {
        await error({ 
            function: 'clearChannelCache', 
            channelID, 
            error: err instanceof Error ? err.message : String(err) 
        });
    }
}

export async function resetSumimetro(channelID: string): Promise<void> {
    try {
        const cache = await getDragonflyClient('resetSumimetro');
        const keys = await cache.keys(`${channelID}:sumimetro:*`);
        
        if (keys.length === 0) return;
        
        for (const key of keys) {
            await cache.del(key);
        }
    } catch (err) {
        await error({ 
            function: 'resetSumimetro', 
            channelID, 
            error: err instanceof Error ? err.message : String(err) 
        });
    }
}
