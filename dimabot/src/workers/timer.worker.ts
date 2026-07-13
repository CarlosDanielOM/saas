import path from 'path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

//? Constants (parsed before any I/O imports)
function readNumberSetting(rawValue: string | undefined, fallback: number, minimum: number): number {
    const parsed = Number(rawValue ?? fallback);
    return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

const INTERVAL_MS = readNumberSetting(process.env.TIMER_WORKER_INTERVAL_MS, 60_000, 60_000);
const RUN_ON_START = process.env.TIMER_WORKER_RUN_ON_START === 'true';
const LOCK_KEY = String(process.env.TIMER_WORKER_LOCK_KEY || 'worker:timer:lock');
const LOCK_TTL_SECONDS = readNumberSetting(process.env.TIMER_WORKER_LOCK_TTL_SECONDS, 900, 120);
const LOCK_RETRY_MS = readNumberSetting(process.env.TIMER_WORKER_LOCK_RETRY_MS, 10_000, 2_000);
const RUN_ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

//? Redis key contracts (must be preserved exactly)
const TIMER_ACTIVE_KEY = 'timer:active';
const getTimerChannelKey = (channelID: string) => `timer:channel:${channelID}:timers`;
const getTimerHeartbeatKey = (channelID: string, timerID: string) => `timer:channel:${channelID}:heartbeat:${timerID}`;
const getTimerHeartbeatUnitKey = (channelID: string, timerID: string) => `timer:channel:${channelID}:heartbeat-unit:${timerID}`;

let shutdownRequested = false;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDryRun(): Promise<void> {
    const config = {
        mode: RUN_ONCE ? 'once' : 'scheduler',
        dryRun: true,
        flags: {
            RUN_ONCE,
            RUN_ON_START,
            DRY_RUN
        },
        intervals: {
            INTERVAL_MS,
            LOCK_TTL_SECONDS,
            LOCK_RETRY_MS
        },
        keys: {
            LOCK_KEY,
            TIMER_ACTIVE_KEY,
            timerChannelPattern: 'timer:channel:{channelID}:timers',
            timerHeartbeatPattern: 'timer:channel:{channelID}:heartbeat:{timerID}',
            timerHeartbeatUnitPattern: 'timer:channel:{channelID}:heartbeat-unit:{timerID}'
        },
        environment: {
            NODE_ENV: process.env.NODE_ENV || 'undefined',
            TIMER_WORKER_INTERVAL_MS: process.env.TIMER_WORKER_INTERVAL_MS || '60000 (default)',
            TIMER_WORKER_RUN_ON_START: process.env.TIMER_WORKER_RUN_ON_START || 'false (default)',
            TIMER_WORKER_LOCK_KEY: process.env.TIMER_WORKER_LOCK_KEY || 'worker:timer:lock (default)',
            TIMER_WORKER_LOCK_TTL_SECONDS: process.env.TIMER_WORKER_LOCK_TTL_SECONDS || '900 (default)',
            TIMER_WORKER_LOCK_RETRY_MS: process.env.TIMER_WORKER_LOCK_RETRY_MS || '10000 (default)',
            DRAGONFLY_HOST: process.env.DRAGONFLY_HOST || 'undefined'
        }
    };

    console.log(JSON.stringify(config, null, 2));
}

async function main(): Promise<void> {
    if (DRY_RUN) {
        await runDryRun();
        return;
    }

    //? Dynamic imports for modules that connect to databases
    const { getDragonflyClient } = await import('../utils/databases/dragonfly.database.js');
    const { getMongoDBConnection } = await import('../utils/databases/mongodb.database.js');
    const { sendTwitchChatMessage } = await import('../functions/chats/send_message.chat.js');
    const TwitchStreamers = (await import('../classes/twitch_streamers.class.js')).default;
    const { error: logError, warn: logWarn } = await import('../utils/logger.js');
    const { parseSpecialCommands } = await import('../handlers/special_parser.handler.js');
    const {
        TIMER_FREQUENCY_UNIT,
        getTimerHeartbeatMinutes,
        getTimerIntervalMinutes
    } = await import('../utils/timer_policy.js');
    const { renderTimerMessage } = await import('../utils/timer_runtime.js');

    async function acquireWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('TimerWorker');
        const result = await cache.set(LOCK_KEY, lockOwnerId, {
            NX: true,
            EX: LOCK_TTL_SECONDS
        });
        return result === 'OK';
    }

    async function refreshWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('TimerWorker');
        const activeOwner = await cache.get(LOCK_KEY);
        if (activeOwner !== lockOwnerId) {
            return false;
        }
        await cache.expire(LOCK_KEY, LOCK_TTL_SECONDS);
        return true;
    }

    async function releaseWorkerLock(lockOwnerId: string): Promise<void> {
        const cache = await getDragonflyClient('TimerWorker');
        const activeOwner = await cache.get(LOCK_KEY);
        if (activeOwner === lockOwnerId) {
            await cache.del(LOCK_KEY);
        }
    }

    async function processTimerTick(
        cache: Awaited<ReturnType<typeof getDragonflyClient>>,
        channelID: string,
        timer: { _id: string | number; frequency: number; frequencyUnit?: string; message: string; name: string; active: boolean },
        streamerName: string,
        planTier: 'free' | 'premium' | 'pro'
    ): Promise<void> {
        const timerID = String(timer._id);
        const heartbeatKey = getTimerHeartbeatKey(channelID, timerID);
        const heartbeatUnitKey = getTimerHeartbeatUnitKey(channelID, timerID);
        const rawHeartbeat = Number.parseInt(await cache.get(heartbeatKey) || '0', 10);
        const heartbeatUnit = await cache.get(heartbeatUnitKey);
        const currentHeartbeat = getTimerHeartbeatMinutes(timer, rawHeartbeat, heartbeatUnit);
        const newHeartbeat = currentHeartbeat + 1;
        const intervalMinutes = getTimerIntervalMinutes(timer);

        if (heartbeatUnit !== TIMER_FREQUENCY_UNIT) {
            await cache.set(heartbeatUnitKey, TIMER_FREQUENCY_UNIT);
        }

        if (newHeartbeat >= intervalMinutes) {
            try {
                const parsedMessage = await renderTimerMessage({
                    channelID,
                    streamerName,
                    timerName: timer.name,
                    message: timer.message,
                    planTier,
                    parse: parseSpecialCommands
                });

                if (parsedMessage) {
                    await sendTwitchChatMessage(channelID, parsedMessage);
                }

                await cache.set(heartbeatKey, '0');
                await cache.set(heartbeatUnitKey, TIMER_FREQUENCY_UNIT);
            } catch (err) {
                await logError({
                    worker: 'timer',
                    message: 'Error processing timer',
                    channelID,
                    timerName: timer.name,
                    error: err instanceof Error ? err.message : String(err),
                    stack: err instanceof Error ? err.stack : undefined
                }, { channelId: channelID, destination: 'console' });
                await cache.set(heartbeatKey, '0');
                await cache.set(heartbeatUnitKey, TIMER_FREQUENCY_UNIT);
            }
        } else {
            await cache.set(heartbeatKey, String(newHeartbeat));
        }
    }

    async function runTimerTick(lockOwnerId: string): Promise<void> {
        const lockIsValid = await refreshWorkerLock(lockOwnerId);
        if (!lockIsValid) {
            throw new Error('Worker lock lost; another timer worker appears active');
        }

        const cache = await getDragonflyClient('TimerWorker');
        const activeChannels = await cache.sMembers(TIMER_ACTIVE_KEY);

        if (!activeChannels || activeChannels.length === 0) {
            return;
        }

        for (const channelID of activeChannels) {
            try {
                const timersData = await cache.hGetAll(getTimerChannelKey(channelID));
                if (!timersData || Object.keys(timersData).length === 0) {
                    continue;
                }

                const streamer = await TwitchStreamers.getTwitchAccountById(channelID);
                if (!streamer) {
                    continue;
                }

                const planTier = (streamer.plan_tier as 'free' | 'premium' | 'pro') || 'free';

                for (const [timerID, timerJSON] of Object.entries(timersData)) {
                    try {
                        const timer = JSON.parse(timerJSON);
                        if (!timer.active) {
                            continue;
                        }
                        await processTimerTick(cache, channelID, timer, streamer.name || '', planTier);
                    } catch (parseErr) {
                        await logError({
                            worker: 'timer',
                            message: 'Error parsing timer from cache',
                            channelID,
                            timerID,
                            error: parseErr instanceof Error ? parseErr.message : String(parseErr)
                        }, { destination: 'console' });
                    }
                }
            } catch (channelErr) {
                await logError({
                    worker: 'timer',
                    message: 'Error processing channel timers',
                    channelID,
                    error: channelErr instanceof Error ? channelErr.message : String(channelErr)
                }, { destination: 'console' });
            }
        }
    }

    async function bootstrap(): Promise<void> {
        const lockOwnerId = `${process.pid}-${Date.now()}`;

        await getDragonflyClient('TimerWorker');
        await getMongoDBConnection('TimerWorker');
        await TwitchStreamers.getTwitchAccountsFromDB();

        let lockAcquired = await acquireWorkerLock(lockOwnerId);
        let lockContentionLogged = false;
        while (!lockAcquired) {
            if (!lockContentionLogged) {
                lockContentionLogged = true;
                await logWarn({
                    worker: 'timer',
                    message: 'Another timer worker is active. Waiting for lock.',
                    lockKey: LOCK_KEY,
                    retryInMs: LOCK_RETRY_MS
                }, { destination: 'console' });
            }
            await sleep(LOCK_RETRY_MS);
            if (shutdownRequested) {
                return;
            }
            lockAcquired = await acquireWorkerLock(lockOwnerId);
        }

        const shutdown = async (signal: string): Promise<void> => {
            if (shutdownRequested) {
                return;
            }
            shutdownRequested = true;
            await releaseWorkerLock(lockOwnerId);
            process.exit(0);
        };

        process.once('SIGINT', () => void shutdown('SIGINT'));
        process.once('SIGTERM', () => void shutdown('SIGTERM'));

        if (RUN_ONCE) {
            await runTimerTick(lockOwnerId);
            await releaseWorkerLock(lockOwnerId);
            return;
        }

        if (RUN_ON_START) {
            await runTimerTick(lockOwnerId);
        }

        while (!shutdownRequested) {
            await sleep(INTERVAL_MS);
            if (shutdownRequested) {
                break;
            }
            try {
                await runTimerTick(lockOwnerId);
            } catch (error) {
                await logError({
                    worker: 'timer',
                    message: 'Error during timer tick',
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                }, { destination: 'console' });

                const lockIsValid = await refreshWorkerLock(lockOwnerId);
                if (!lockIsValid) {
                    await logWarn({
                        worker: 'timer',
                        message: 'Worker lock is no longer valid. Exiting process to avoid duplicate workers.',
                        lockKey: LOCK_KEY
                    }, { destination: 'console' });
                    break;
                }
            }
        }

        await releaseWorkerLock(lockOwnerId);
    }

    await bootstrap();
}

main().catch(async (error) => {
    console.error({
        worker: 'timer',
        message: 'Failed to bootstrap timer worker',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
});
