import { getDragonflyClient } from './databases/dragonfly.database.js';
import { error } from './logger.js';
import { AdminSchema } from '../schemas/admin.schema.js';
import type { IAdmin } from '../schemas/admin.schema.js';
import { populateAdminCache } from './permissions/roles.js';

/**
 * Loads active channel admins from MongoDB into the canonical Dragonfly
 * role-cache keys. Called on stream online/offline transitions so admin data
 * remains available and stale cache membership is reconciled.
 */
export async function loadChannelAdminsIntoCache(channelID: string): Promise<void> {
    try {
        const cache = await getDragonflyClient('loadChannelAdminsIntoCache');

        // Fetch active admins from MongoDB
        const admins = await AdminSchema.find({ channelID, actived: true }).lean<IAdmin[]>();

        // Rebuild the canonical twitch: admin sets + detail hashes and remove
        // any stale canonical or legacy non-twitch: admin keys.
        await populateAdminCache(cache, channelID, admins.map((admin) => ({
            adminID: admin.adminID,
            adminName: admin.adminName,
            channelName: admin.channelName,
            permissions: admin.permissions,
            actived: admin.actived
        })));

        console.log(`Loaded ${admins.length} admins into cache for channel ${channelID}`);
    } catch (err) {
        await error({
            function: 'loadChannelAdminsIntoCache',
            channelID,
            error: err instanceof Error ? err.message : String(err)
        });
        throw err;
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
        throw err;
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
        throw err;
    }
}
