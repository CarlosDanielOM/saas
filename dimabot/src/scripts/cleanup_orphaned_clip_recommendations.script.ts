import path from 'node:path';
import dotenv from 'dotenv';
import { ClipRecommendationSchema } from '../schemas/clip_recommendation.schema.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function run(): Promise<void> {
    const execute = process.argv.includes('--execute');
    const staleHours = Math.max(1, Number(process.env.CLIP_RECOMMENDATION_ORPHAN_STALE_HOURS) || 24);
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);
    const filter = {
        status: { $in: ['pending', 'processing'] },
        billingStatus: { $ne: 'charged' },
        updated_at: { $lt: cutoff },
        $or: [
            { queueJobID: { $exists: false } },
            { queueJobID: null },
            { queueJobID: '' }
        ]
    };

    await getMongoDBConnection('cleanup_orphaned_clip_recommendations');
    const matchedCount = await ClipRecommendationSchema.countDocuments(filter);
    console.log(`[cleanup] stale unkeyed clip recommendation records: ${matchedCount}`);

    if (!execute) {
        console.log('[cleanup] dry-run complete. Re-run with --execute to mark these records failed.');
        return;
    }
    if (matchedCount === 0) return;

    const result = await ClipRecommendationSchema.updateMany(filter, {
        $set: {
            status: 'failed',
            errorMessage: 'Legacy recommendation was orphaned before durable queue recovery was available.',
            completedAt: new Date()
        }
    });
    console.log(`[cleanup] applied. matchedCount=${result.matchedCount} modifiedCount=${result.modifiedCount}`);
}

run()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('[cleanup] failed', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
        process.exit(1);
    });
