import path from 'path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const LOCK_KEY = String(process.env.ACTIVATION_REMINDER_LOCK_KEY || 'worker:activation-reminder:lock');
const LOCK_TTL_SECONDS = Math.max(60, Number(process.env.ACTIVATION_REMINDER_LOCK_TTL_SECONDS || 3600));
const LOCK_RETRY_MS = Math.max(2000, Number(process.env.ACTIVATION_REMINDER_LOCK_RETRY_MS || 10000));
const REMINDER_DAYS = Math.max(1, Number(process.env.ACTIVATION_REMINDER_DAYS || 3));
const BATCH_SIZE = Math.max(1, Number(process.env.ACTIVATION_REMINDER_BATCH_SIZE || 50));
const RUN_ON_START = process.env.ACTIVATION_REMINDER_RUN_ON_START !== 'false';
const RUN_ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
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
            LOCK_TTL_SECONDS,
            LOCK_RETRY_MS,
            REMINDER_DAYS,
            BATCH_SIZE
        },
        keys: {
            LOCK_KEY
        },
        environment: {
            NODE_ENV: process.env.NODE_ENV || 'undefined',
            ACTIVATION_REMINDER_LOCK_TTL_SECONDS: process.env.ACTIVATION_REMINDER_LOCK_TTL_SECONDS || '3600 (default)',
            ACTIVATION_REMINDER_LOCK_RETRY_MS: process.env.ACTIVATION_REMINDER_LOCK_RETRY_MS || '10000 (default)',
            ACTIVATION_REMINDER_DAYS: process.env.ACTIVATION_REMINDER_DAYS || '3 (default)',
            ACTIVATION_REMINDER_BATCH_SIZE: process.env.ACTIVATION_REMINDER_BATCH_SIZE || '50 (default)',
            ACTIVATION_REMINDER_RUN_ON_START: process.env.ACTIVATION_REMINDER_RUN_ON_START || 'false (default)'
        }
    };

    console.log(JSON.stringify(config, null, 2));
}

async function main(): Promise<void> {
    if (DRY_RUN) {
        await runDryRun();
        return;
    }

    const { getDragonflyClient } = await import('../utils/databases/dragonfly.database.js');
    const { getMongoDBConnection } = await import('../utils/databases/mongodb.database.js');
    const UsersSchema = (await import('../schemas/users.schema.js')).default;
    const { error: logError, info: logInfo, warn: logWarn } = await import('../utils/logger.js');
    const { sendEmail, EMAIL_AUTH_BASE_URL } = await import('../utils/email/email.service.js');
    const { signEmailActivationToken } = await import('../utils/email/email.service.js');
    const { ActivationReminderEmail, getActivationReminderSubject } = await import('../utils/email/templates/activation-reminder.js');

    async function acquireWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('ActivationReminderWorker');
        const result = await cache.set(LOCK_KEY, lockOwnerId, {
            NX: true,
            EX: LOCK_TTL_SECONDS
        });
        return result === 'OK';
    }

    async function refreshWorkerLock(lockOwnerId: string): Promise<boolean> {
        const cache = await getDragonflyClient('ActivationReminderWorker');
        const owner = await cache.get(LOCK_KEY);
        if (owner !== lockOwnerId) {
            return false;
        }
        await cache.expire(LOCK_KEY, LOCK_TTL_SECONDS);
        return true;
    }

    async function releaseWorkerLock(lockOwnerId: string): Promise<void> {
        const cache = await getDragonflyClient('ActivationReminderWorker');
        const owner = await cache.get(LOCK_KEY);
        if (owner === lockOwnerId) {
            await cache.del(LOCK_KEY);
        }
    }

    function getDelayToNextUtcMidnight(now: Date = new Date()): number {
        const next = new Date(now);
        next.setUTCHours(24, 0, 0, 0);
        return Math.max(0, next.getTime() - now.getTime());
    }

    async function sendActivationReminders(): Promise<void> {
        const lockOwnerId = `${process.pid}-${Date.now()}`;
        if (!(await acquireWorkerLock(lockOwnerId))) {
            await logWarn({
                worker: 'activation_reminder',
                message: 'Another activation-reminder worker is active. Skipping this run.'
            }, { destination: 'console' });
            return;
        }

        const startedAt = Date.now();
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - REMINDER_DAYS);

        try {
            await logInfo({
                worker: 'activation_reminder',
                message: 'Starting activation reminder sweep',
                reminderDays: REMINDER_DAYS,
                cutoffDate: cutoffDate.toISOString()
            }, { destination: 'console' });

            // Find users who:
            // - Have at least one inactive account
            // - Created more than REMINDER_DAYS days ago
            // - Haven't received a reminder yet (last_activation_email_sent_at is null/not set)
            // - Have an email address
            const usersToRemind = await UsersSchema.find({
                'accounts.actived': false,
                created_at: { $lt: cutoffDate },
                reminder_sent_at: { $in: [null, undefined] },
                email: { $exists: true, $ne: '' }
            }).limit(BATCH_SIZE);

            if (usersToRemind.length === 0) {
                await logInfo({
                    worker: 'activation_reminder',
                    message: 'No users found needing activation reminder'
                }, { destination: 'console' });
                return;
            }

            await logInfo({
                worker: 'activation_reminder',
                message: 'Found users needing activation reminder',
                count: usersToRemind.length
            }, { destination: 'console' });

            let sent = 0;
            let failed = 0;
            let skipped = 0;

            for (const user of usersToRemind) {
                // Get the first inactive account's name for personalization
                const inactiveAccount = user.accounts?.find((acc: any) => !acc.actived);
                const streamerName = inactiveAccount?.name || user.name || 'Streamer';

                // Use the user's primary email or the account email
                const email = user.email || inactiveAccount?.email;
                if (!email) {
                    skipped += 1;
                    await logWarn({
                        worker: 'activation_reminder',
                        message: 'Skipping user with no email',
                        userId: String(user._id)
                    }, { destination: 'console' });
                    continue;
                }

                const twitchLogin = inactiveAccount?.name || (user as any).name || '';
                const token = signEmailActivationToken(String(user._id), twitchLogin);
                const activationLink = `${EMAIL_AUTH_BASE_URL}?token=${encodeURIComponent(token)}`;
                const userLanguage = user.language === 'es' ? 'es' : 'en';

                try {
                    const emailResult = await sendEmail({
                        to: email,
                        subject: getActivationReminderSubject(userLanguage),
                        emailComponent: ActivationReminderEmail({
                            streamerName,
                            activationLink,
                            language: userLanguage
                        })
                    });

                    if (emailResult.error) {
                        failed += 1;
                        await logWarn({
                            worker: 'activation_reminder',
                            message: 'Failed to send activation reminder email',
                            userId: String(user._id),
                            email,
                            error: emailResult.message
                        }, { destination: 'console' });
                        continue;
                    }

                    // Mark reminder as sent
                    await UsersSchema.updateOne(
                        { _id: user._id },
                        { $set: { reminder_sent_at: new Date() } }
                    );

                    sent += 1;
                    await logInfo({
                        worker: 'activation_reminder',
                        message: 'Sent activation reminder email',
                        userId: String(user._id),
                        email
                    }, { destination: 'console' });

                } catch (error) {
                    failed += 1;
                    await logError({
                        worker: 'activation_reminder',
                        message: 'Error sending activation reminder',
                        userId: String(user._id),
                        error: error instanceof Error ? error.message : String(error)
                    }, { destination: 'console' });
                }
            }

            await logInfo({
                worker: 'activation_reminder',
                message: 'Activation reminder sweep completed',
                total: usersToRemind.length,
                sent,
                failed,
                skipped,
                durationMs: Date.now() - startedAt
            }, { destination: 'console' });

        } catch (error) {
            await logError({
                worker: 'activation_reminder',
                message: 'Unexpected error during activation reminder sweep',
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                durationMs: Date.now() - startedAt
            }, { destination: 'console' });
        } finally {
            await releaseWorkerLock(lockOwnerId);
        }
    }

    function scheduleNextRun(): void {
        const delayMs = getDelayToNextUtcMidnight();
        void logInfo({
            worker: 'activation_reminder',
            message: 'Scheduled next activation reminder sweep',
            delayMs,
            nextRunAtUtc: new Date(Date.now() + delayMs).toISOString()
        }, { destination: 'console' });

        setTimeout(async () => {
            await sendActivationReminders();
            scheduleNextRun();
        }, delayMs);
    }

    let shutdownRequested = false;

    async function bootstrap(): Promise<void> {
        const lockOwnerId = `${process.pid}-${Date.now()}`;

        await getDragonflyClient('ActivationReminderWorker');
        await getMongoDBConnection('ActivationReminderWorker');

        const shutdown = async (signal: string): Promise<void> => {
            if (shutdownRequested) {
                return;
            }
            shutdownRequested = true;
            await logInfo({
                worker: 'activation_reminder',
                message: 'Shutting down activation reminder worker',
                signal
            }, { destination: 'console' });
            await releaseWorkerLock(lockOwnerId);
            process.exit(0);
        };

        process.once('SIGINT', () => {
            void shutdown('SIGINT');
        });
        process.once('SIGTERM', () => {
            void shutdown('SIGTERM');
        });

        await logInfo({
            worker: 'activation_reminder',
            message: 'Activation reminder worker initialized',
            mode: RUN_ONCE ? 'once' : 'scheduler',
            runOnStart: RUN_ON_START,
            reminderDays: REMINDER_DAYS,
            batchSize: BATCH_SIZE
        }, { destination: 'console' });

        if (RUN_ONCE) {
            await sendActivationReminders();
            return;
        }

        if (RUN_ON_START) {
            await sendActivationReminders();
        }

        scheduleNextRun();
    }

    await bootstrap();
}

main().catch(async (error) => {
    console.error({
        worker: 'activation_reminder',
        message: 'Failed to bootstrap activation reminder worker',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
});