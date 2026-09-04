import { CustomTimerSchema } from '../schemas/custom_timer.schema.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { error as logError } from '../utils/logger.js';
import { TIMER_FREQUENCY_UNIT } from './timer_policy.js';

export async function loadChannelTimersIntoCache(channelID: string): Promise<void> {
    try {
        const cache = await getDragonflyClient('loadChannelTimers');
        const timers = await CustomTimerSchema.find({ channelID, active: true }).lean();

        if (timers.length === 0) {
            const staleTimers = await cache.hGetAll(`timer:channel:${channelID}:timers`);
            for (const timerID of Object.keys(staleTimers || {})) {
                await cache.del(`timer:channel:${channelID}:heartbeat:${timerID}`);
                await cache.del(`timer:channel:${channelID}:heartbeat-unit:${timerID}`);
            }
            await cache.del(`timer:channel:${channelID}:timers`);
            await cache.sAdd('timer:active', channelID);
            return;
        }

        const timerMap: Record<string, string> = {};
        for (const timer of timers) {
            timerMap[String(timer._id)] = JSON.stringify(timer);
        }

        if (Object.keys(timerMap).length > 0) {
            await cache.hSet(`timer:channel:${channelID}:timers`, timerMap);

            for (const timer of timers) {
                const heartbeatKey = `timer:channel:${channelID}:heartbeat:${timer._id}`;
                const heartbeatUnitKey = `timer:channel:${channelID}:heartbeat-unit:${timer._id}`;
                const exists = await cache.exists(heartbeatKey);
                const unitExists = await cache.exists(heartbeatUnitKey);
                if (!exists || !unitExists) {
                    await cache.set(heartbeatKey, '0');
                    await cache.set(heartbeatUnitKey, TIMER_FREQUENCY_UNIT);
                }
            }
        }

        await cache.sAdd('timer:active', channelID);

    } catch (error) {
        await logError({
            function: 'loadChannelTimersIntoCache',
            channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        }, { channelId: channelID, destination: 'both' });
        throw error;
    }
}

export async function unloadChannelTimersFromCache(channelID: string): Promise<void> {
    try {
        const cache = await getDragonflyClient('unloadChannelTimers');
        await cache.sRem('timer:active', channelID);

        const timersData = await cache.hGetAll(`timer:channel:${channelID}:timers`);
        if (timersData) {
            for (const timerID of Object.keys(timersData)) {
                await cache.del(`timer:channel:${channelID}:heartbeat:${timerID}`);
                await cache.del(`timer:channel:${channelID}:heartbeat-unit:${timerID}`);
            }
        }

        await cache.del(`timer:channel:${channelID}:timers`);

    } catch (error) {
        await logError({
            function: 'unloadChannelTimersFromCache',
            channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        }, { channelId: channelID, destination: 'both' });
        throw error;
    }
}

export async function refreshChannelTimerInCache(channelID: string, timerID: string): Promise<void> {
    try {
        const cache = await getDragonflyClient('refreshChannelTimer');
        const isActive = await cache.sIsMember('timer:active', channelID);
        if (!isActive) {
            return;
        }

        const timer = await CustomTimerSchema.findById(timerID).lean();
        if (!timer || !timer.active) {
            await cache.hDel(`timer:channel:${channelID}:timers`, timerID);
            await cache.del(`timer:channel:${channelID}:heartbeat:${timerID}`);
            await cache.del(`timer:channel:${channelID}:heartbeat-unit:${timerID}`);
            return;
        }

        await cache.hSet(`timer:channel:${channelID}:timers`, timerID, JSON.stringify(timer));
        await cache.set(`timer:channel:${channelID}:heartbeat:${timerID}`, '0');
        await cache.set(`timer:channel:${channelID}:heartbeat-unit:${timerID}`, TIMER_FREQUENCY_UNIT);
    } catch (error) {
        await logError({
            function: 'refreshChannelTimerInCache',
            channelID,
            timerID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        }, { channelId: channelID, destination: 'both' });
    }
}

export async function removeChannelTimerFromCache(channelID: string, timerID: string): Promise<void> {
    try {
        const cache = await getDragonflyClient('removeChannelTimer');
        await cache.hDel(`timer:channel:${channelID}:timers`, timerID);
        await cache.del(`timer:channel:${channelID}:heartbeat:${timerID}`);
        await cache.del(`timer:channel:${channelID}:heartbeat-unit:${timerID}`);
    } catch (error) {
        await logError({
            function: 'removeChannelTimerFromCache',
            channelID,
            timerID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        }, { channelId: channelID, destination: 'both' });
    }
}
