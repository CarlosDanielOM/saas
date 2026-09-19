import path from 'node:path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const INTERVAL_MS = Math.max(60_000, Number(process.env.FREE_CREDIT_RESET_INTERVAL_MS || 60 * 60_000));
const BATCH_SIZE = Math.max(1, Math.min(1_000, Number(process.env.FREE_CREDIT_RESET_BATCH_SIZE || 100)));
const LOCK_KEY = String(process.env.FREE_CREDIT_RESET_LOCK_KEY || 'worker:free-credit-reset:lock');
const LOCK_TTL_SECONDS = Math.max(60, Number(process.env.FREE_CREDIT_RESET_LOCK_TTL_SECONDS || 30 * 60));
const RUN_ON_START = process.env.FREE_CREDIT_RESET_RUN_ON_START !== 'false';
const ENABLED = process.env.FREE_CREDIT_RESET_ENABLED !== 'false';
const RUN_ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
`;

const EXTEND_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrap(): Promise<void> {
    if (!ENABLED) {
        console.log(JSON.stringify({
            worker: 'free_credit_reset',
            message: 'Free credit reset worker disabled; FREE_CREDIT_RESET_ENABLED=false',
            enabled: false
        }, null, 2));
        return;
    }

    if (DRY_RUN) {
        console.log(JSON.stringify({
            worker: 'free_credit_reset',
            message: 'Dry run mode - resolved configuration',
            config: {
                intervalMs: INTERVAL_MS,
                batchSize: BATCH_SIZE,
                lockKey: LOCK_KEY,
                lockTtlSeconds: LOCK_TTL_SECONDS,
                runOnStart: RUN_ON_START,
                runOnce: RUN_ONCE
            }
        }, null, 2));
        return;
    }

    const [
        { default: UsersSchema },
        { AI_CREDIT_LIMITS, getAiCredits },
        { resolveFreeCreditPeriod },
        { decideFreeCreditReset },
        { grantPolarAiCredits },
        { getDragonflyClient },
        { getMongoDBConnection },
        { error: logError, info: logInfo },
        { default: mongoose }
    ] = await Promise.all([
        import('../schemas/users.schema.js'),
        import('../utils/billing.js'),
        import('../utils/ai_usage_receipts.js'),
        import('../utils/free_credit_reset.js'),
        import('../utils/polarsh.js'),
        import('../utils/databases/dragonfly.database.js'),
        import('../utils/databases/mongodb.database.js'),
        import('../utils/logger.js'),
        import('mongoose')
    ]);

    await getMongoDBConnection('FreeCreditResetWorker');
    const cache = await getDragonflyClient('FreeCreditResetWorker');
    let shutdownRequested = false;
    let activeOwner = '';
    let resolveShutdown: (() => void) | undefined;
    const shutdownSignal = new Promise<void>((resolve) => { resolveShutdown = resolve; });

    const releaseLock = async (owner: string): Promise<void> => {
        await cache.eval(RELEASE_LOCK_SCRIPT, { keys: [LOCK_KEY], arguments: [owner] });
    };
    const shutdown = async (): Promise<void> => {
        shutdownRequested = true;
        resolveShutdown?.();
        if (activeOwner) await releaseLock(activeOwner);
    };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });

    const run = async (): Promise<void> => {
        const owner = `${process.pid}-${Date.now()}`;
        const acquired = await cache.set(LOCK_KEY, owner, { NX: true, EX: LOCK_TTL_SECONDS });
        if (acquired !== 'OK') return;
        activeOwner = owner;
        let lockLost = false;
        const heartbeat = setInterval(() => {
            void (async () => {
                const extended = await cache.eval(EXTEND_LOCK_SCRIPT, {
                    keys: [LOCK_KEY],
                    arguments: [owner, String(LOCK_TTL_SECONDS)]
                });
                if (Number(extended) !== 1) lockLost = true;
            })().catch(() => { lockLost = true; });
        }, Math.max(5_000, Math.floor(LOCK_TTL_SECONDS * 1000 / 3)));
        heartbeat.unref?.();

        const counters = { examined: 0, initialized: 0, granted: 0, zero: 0, skipped: 0, failed: 0 };
        try {
            let lastId: unknown;
            while (!shutdownRequested && !lockLost) {
                const query: Record<string, unknown> = {
                    plan_tier: 'free',
                    polar_sh_customer_id: { $exists: true, $nin: [null, ''] },
                    created_at: { $lte: new Date() }
                };
                if (lastId) query._id = { $gt: lastId };
                const users = await UsersSchema.find(query)
                    .select('_id plan_tier polar_sh_customer_id created_at accounts free_credit_reset')
                    .sort({ _id: 1 })
                    .limit(BATCH_SIZE)
                    .lean()
                    .exec();
                if (users.length === 0) break;

                for (const user of users) {
                    if (shutdownRequested || lockLost) break;
                    counters.examined += 1;
                    const userId = String(user._id);
                    try {
                        const twitchAccount = user.accounts?.find((account) => account.type === 'twitch' && account.id);
                        const now = new Date();
                        const period = resolveFreeCreditPeriod(new Date(user.created_at), now);
                        if (!twitchAccount || !period) {
                            counters.skipped += 1;
                            continue;
                        }
                        const periodInput = { source: 'free_monthly' as const, startsAt: period.start.toISOString() };
                        let decision = decideFreeCreditReset({
                            userId,
                            period: periodInput,
                            previous: user.free_credit_reset,
                            maximumResetCredits: AI_CREDIT_LIMITS.free
                        });

                        if (decision.action === 'initialize') {
                            const updated = await UsersSchema.updateOne({
                                _id: user._id,
                                plan_tier: 'free',
                                free_credit_reset: { $exists: false }
                            }, {
                                $set: {
                                    free_credit_reset: {
                                        periodStart: period.start,
                                        periodEnd: period.end,
                                        status: 'initialized',
                                        credits: 0,
                                        externalId: decision.externalId,
                                        updatedAt: now,
                                        completedAt: null
                                    }
                                }
                            });
                            if (updated.modifiedCount === 1) counters.initialized += 1;
                            else counters.skipped += 1;
                            continue;
                        }

                        if (decision.action === 'skip') {
                            counters.skipped += 1;
                            continue;
                        }

                        const previousStart = user.free_credit_reset?.periodStart
                            ? new Date(user.free_credit_reset.periodStart).getTime()
                            : Number.NaN;
                        const isPendingRetry = previousStart === period.start.getTime()
                            && user.free_credit_reset?.status === 'pending';

                        if (!isPendingRetry) {
                            const credits = await getAiCredits(user, twitchAccount.id);
                            if (!credits.available) {
                                counters.failed += 1;
                                await logError({
                                    worker: 'free_credit_reset',
                                    message: 'Credit usage unavailable; reset deferred',
                                    userId,
                                    channelID: twitchAccount.id
                                }, { destination: 'both' });
                                continue;
                            }
                            decision = decideFreeCreditReset({
                                userId,
                                period: periodInput,
                                previous: user.free_credit_reset,
                                usedCredits: credits.used,
                                maximumResetCredits: AI_CREDIT_LIMITS.free
                            });

                            if (decision.action !== 'grant' && decision.action !== 'complete_zero') {
                                counters.skipped += 1;
                                continue;
                            }
                            const claimed = await UsersSchema.updateOne({
                                _id: user._id,
                                plan_tier: 'free',
                                'free_credit_reset.periodStart': { $lt: period.start }
                            }, {
                                $set: {
                                    free_credit_reset: {
                                        periodStart: period.start,
                                        periodEnd: period.end,
                                        status: 'pending',
                                        credits: decision.action === 'grant' ? decision.credits : 0,
                                        externalId: decision.externalId,
                                        updatedAt: now,
                                        completedAt: null
                                    }
                                }
                            });
                            if (claimed.modifiedCount !== 1) {
                                counters.skipped += 1;
                                continue;
                            }
                        }

                        if (decision.action === 'complete_zero') {
                            await UsersSchema.updateOne({
                                _id: user._id,
                                plan_tier: 'free',
                                'free_credit_reset.externalId': decision.externalId,
                                'free_credit_reset.status': 'pending'
                            }, {
                                $set: {
                                    'free_credit_reset.status': 'completed',
                                    'free_credit_reset.updatedAt': now,
                                    'free_credit_reset.completedAt': now
                                }
                            });
                            counters.zero += 1;
                            continue;
                        }

                        if (decision.action !== 'grant') {
                            counters.skipped += 1;
                            continue;
                        }

                        const stillEligible = await UsersSchema.exists({
                            _id: user._id,
                            plan_tier: 'free',
                            'free_credit_reset.externalId': decision.externalId,
                            'free_credit_reset.status': 'pending'
                        });
                        if (!stillEligible) {
                            counters.skipped += 1;
                            continue;
                        }
                        const result = await grantPolarAiCredits({
                            customerId: user.polar_sh_customer_id,
                            channelID: twitchAccount.id,
                            credits: decision.credits,
                            reason: 'free_monthly_credit_reset',
                            externalId: decision.externalId,
                            source: 'free_credit_reset_worker',
                            adminLogin: 'free-credit-reset-worker'
                        });
                        if (result.error) {
                            counters.failed += 1;
                            await logError({
                                worker: 'free_credit_reset',
                                message: 'Polar credit reset failed; pending grant will retry',
                                userId,
                                channelID: twitchAccount.id,
                                error: result.message || 'unknown Polar error'
                            }, { destination: 'both' });
                            continue;
                        }

                        const completedAt = new Date();
                        const completed = await UsersSchema.updateOne({
                            _id: user._id,
                            'free_credit_reset.externalId': decision.externalId,
                            'free_credit_reset.status': 'pending'
                        }, {
                            $set: {
                                'free_credit_reset.status': 'completed',
                                'free_credit_reset.updatedAt': completedAt,
                                'free_credit_reset.completedAt': completedAt
                            }
                        });
                        if (completed.modifiedCount === 1) {
                            await Promise.all([
                                cache.del(`twitch:${twitchAccount.id}:ai:credits`),
                                cache.del(`twitch:${twitchAccount.id}:ai:exhaust`),
                                cache.del(`${twitchAccount.id}:ai:exhaust`)
                            ]);
                            counters.granted += 1;
                        } else {
                            counters.failed += 1;
                            await logError({
                                worker: 'free_credit_reset',
                                message: 'Polar accepted reset but ledger completion failed; stable event ID will protect retry',
                                userId,
                                channelID: twitchAccount.id,
                                externalId: decision.externalId
                            }, { destination: 'both' });
                        }
                    } catch (error) {
                        counters.failed += 1;
                        await logError({
                            worker: 'free_credit_reset',
                            message: 'Failed to process free credit reset account',
                            userId,
                            error: error instanceof Error ? error.message : String(error),
                            stack: error instanceof Error ? error.stack : undefined
                        }, { destination: 'both' });
                    }
                }

                lastId = users[users.length - 1]._id;
                if (users.length < BATCH_SIZE) break;
            }
            await logInfo({
                worker: 'free_credit_reset',
                message: 'Free credit reset scan completed',
                ...counters
            }, { destination: 'console' });
        } finally {
            clearInterval(heartbeat);
            await releaseLock(owner);
            if (activeOwner === owner) activeOwner = '';
        }
    };

    if (RUN_ONCE) {
        await run();
        cache.destroy();
        await mongoose.disconnect();
        return;
    }
    if (RUN_ON_START) await run();
    while (!shutdownRequested) {
        await Promise.race([sleep(INTERVAL_MS), shutdownSignal]);
        if (!shutdownRequested) await run();
    }
    cache.destroy();
    await mongoose.disconnect();
}

bootstrap().catch((error) => {
    console.error(JSON.stringify({
        worker: 'free_credit_reset',
        message: 'Failed to bootstrap free credit reset worker',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    }, null, 2));
    process.exit(1);
});
