import path from 'path';
import dotenv from 'dotenv';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import UsersSchema from '../schemas/users.schema.js';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

interface AccountFieldCount {
    has_permissions_true: number;
    up_to_date_permissions_true: number;
    actived_true: number;
    chat_enabled_true: number;
}

const FIELDS_TO_RESET = ['has_permissions', 'up_to_date_permissions', 'actived', 'chat_enabled'] as const;

async function run(): Promise<void> {
    const execute = process.argv.includes('--execute');

    await getMongoDBConnection('invalidate_all_user_permissions');

    const orClauses = FIELDS_TO_RESET.map((field) => ({ [`accounts.${field}`]: { $ne: false } }));
    const filter = {
        'accounts.0': { $exists: true },
        $or: orClauses,
    };

    const totalUsers = await UsersSchema.countDocuments({});
    const usersWithAccounts = await UsersSchema.countDocuments({ 'accounts.0': { $exists: true } });
    const affectedUsers = await UsersSchema.countDocuments(filter);

    const affectedAccountsAgg = await UsersSchema.aggregate([
        { $unwind: '$accounts' },
        { $match: { $or: orClauses } },
        { $count: 'count' },
    ]);
    const affectedAccounts = affectedAccountsAgg[0]?.count ?? 0;

    const perFieldAgg = await UsersSchema.aggregate([
        { $unwind: '$accounts' },
        {
            $group: {
                _id: null,
                has_permissions_true: {
                    $sum: { $cond: [{ $eq: ['$accounts.has_permissions', true] }, 1, 0] },
                },
                up_to_date_permissions_true: {
                    $sum: { $cond: [{ $eq: ['$accounts.up_to_date_permissions', true] }, 1, 0] },
                },
                actived_true: {
                    $sum: { $cond: [{ $eq: ['$accounts.actived', true] }, 1, 0] },
                },
                chat_enabled_true: {
                    $sum: { $cond: [{ $eq: ['$accounts.chat_enabled', true] }, 1, 0] },
                },
            },
        },
    ]);
    const perField: AccountFieldCount = perFieldAgg[0] ?? {
        has_permissions_true: 0,
        up_to_date_permissions_true: 0,
        actived_true: 0,
        chat_enabled_true: 0,
    };

    console.log('[invalidate-permissions] users in collection: ' + totalUsers);
    console.log('[invalidate-permissions] users with at least one account: ' + usersWithAccounts);
    console.log('[invalidate-permissions] users that would be updated: ' + affectedUsers);
    console.log('[invalidate-permissions] accounts that would be updated: ' + affectedAccounts);
    console.log('[invalidate-permissions]   accounts with has_permissions=true: ' + perField.has_permissions_true);
    console.log('[invalidate-permissions]   accounts with up_to_date_permissions=true: ' + perField.up_to_date_permissions_true);
    console.log('[invalidate-permissions]   accounts with actived=true: ' + perField.actived_true);
    console.log('[invalidate-permissions]   accounts with chat_enabled=true: ' + perField.chat_enabled_true);

    if (!execute) {
        console.log(
            '[invalidate-permissions] dry-run complete. Re-run with --execute to set has_permissions, up_to_date_permissions, actived, and chat_enabled to false on all affected accounts, and to flush their Dragonfly cache entries.'
        );
        return;
    }

    if (affectedUsers === 0) {
        console.log('[invalidate-permissions] no changes to apply — all accounts already have all four flags set to false.');
        return;
    }

    const result = await UsersSchema.updateMany(filter, {
        $set: {
            'accounts.$[].has_permissions': false,
            'accounts.$[].up_to_date_permissions': false,
            'accounts.$[].actived': false,
            'accounts.$[].chat_enabled': false,
        },
    });

    console.log(
        '[invalidate-permissions] mongo applied. ' +
            `matched=${result.matchedCount}, ` +
            `modified=${result.modifiedCount}, ` +
            `acknowledged=${result.acknowledged}`
    );

    // Flush Dragonfly cache entries for the affected accounts so the in-memory streamer
    // objects re-hydrate from Mongo (which now has all four flags set to false).
    // Capture account IDs BEFORE the update runs — the update flips the fields, which
    // would make a second filter-based query return zero documents.
    const affectedAccountIds = await UsersSchema.aggregate([
        { $match: { 'accounts.0': { $exists: true }, $or: orClauses } },
        { $unwind: '$accounts' },
        { $match: { $or: orClauses } },
        { $group: { _id: '$accounts.id' } },
    ]);

    const accountIds: string[] = affectedAccountIds
        .map((doc: { _id: string | null }) => doc._id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (accountIds.length === 0) {
        console.log('[invalidate-permissions] no account ids found in matched users; skipping cache flush.');
        return;
    }

    const cache = await getDragonflyClient('invalidate_all_user_permissions');
    const cacheKeys = accountIds.map((id) => `accounts:twitch:${id}:data`);

    console.log('[invalidate-permissions] cache flush preview: ' + cacheKeys.length + ' keys');
    if (cacheKeys.length <= 20) {
        for (const key of cacheKeys) {
            console.log('[invalidate-permissions]   ' + key);
        }
    } else {
        for (const key of cacheKeys.slice(0, 10)) {
            console.log('[invalidate-permissions]   ' + key);
        }
        console.log('[invalidate-permissions]   ... and ' + (cacheKeys.length - 10) + ' more');
    }

    let deletedCount = 0;
    // Redis DEL accepts multiple keys in one call; batch in groups of 500 to avoid huge arg lists.
    const BATCH_SIZE = 500;
    for (let i = 0; i < cacheKeys.length; i += BATCH_SIZE) {
        const batch = cacheKeys.slice(i, i + BATCH_SIZE);
        const deleted = await cache.del(batch);
        deletedCount += deleted;
    }

    console.log(
        `[invalidate-permissions] cache flush applied. requested=${cacheKeys.length}, deleted=${deletedCount}`
    );
}

run()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('[invalidate-permissions] failed', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
        });
        process.exit(1);
    });
