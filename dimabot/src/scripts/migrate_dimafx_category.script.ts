import path from 'path';
import dotenv from 'dotenv';
import { ChannelExtensionItemSchema } from '../schemas/channel_extension_item.schema.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const LEGACY_CATEGORY = 'gifs';
const TARGET_CATEGORY = 'gif';

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');

    if (dryRun) {
        console.log('[migrate_dimafx_category] DRY-RUN mode — no writes will be performed.');
    } else {
        console.log('[migrate_dimafx_category] LIVE mode — changes will be written.');
    }

    await getMongoDBConnection('migrate_dimafx_category');

    const matched = await ChannelExtensionItemSchema.countDocuments({ category: LEGACY_CATEGORY });
    console.log(`[migrate_dimafx_category] matched documents with category="${LEGACY_CATEGORY}": ${matched}`);

    if (matched === 0) {
        console.log('[migrate_dimafx_category] nothing to migrate.');
        await disconnectSafely();
        return;
    }

    if (dryRun) {
        console.log(`[migrate_dimafx_category] DRY-RUN would update ${matched} documents to category="${TARGET_CATEGORY}".`);
        console.log('[migrate_dimafx_category] DRY-RUN complete. Re-run without --dry-run to apply.');
    } else {
        const result = await ChannelExtensionItemSchema.updateMany(
            { category: LEGACY_CATEGORY },
            { $set: { category: TARGET_CATEGORY } }
        );
        console.log('[migrate_dimafx_category] updateMany result:', {
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
            acknowledged: result.acknowledged,
            upsertedCount: result.upsertedCount
        });
    }

    const remaining = await ChannelExtensionItemSchema.countDocuments({ category: LEGACY_CATEGORY });
    console.log(`[migrate_dimafx_category] remaining documents with category="${LEGACY_CATEGORY}": ${remaining}`);

    const newCount = await ChannelExtensionItemSchema.countDocuments({ category: TARGET_CATEGORY });
    console.log(`[migrate_dimafx_category] total documents with category="${TARGET_CATEGORY}": ${newCount}`);

    await disconnectSafely();
}

let mongooseConnection: { disconnect: () => Promise<void>; close: () => Promise<void> } | null = null;
async function disconnectSafely(): Promise<void> {
    try {
        const conn = (ChannelExtensionItemSchema as unknown as { db: { close: () => Promise<void> } }).db;
        if (conn?.close) {
            await conn.close();
        }
    } catch {
        // best-effort cleanup
    }
    if (mongooseConnection) {
        try { await mongooseConnection.disconnect(); } catch { /* noop */ }
        try { await mongooseConnection.close(); } catch { /* noop */ }
    }
    // Mongoose connection is module-level; the process.exit below will close it.
    void mongooseConnection;
    process.exit(0);
}

main().catch((error) => {
    console.error('[migrate_dimafx_category] failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString()
    });
    process.exit(1);
});
