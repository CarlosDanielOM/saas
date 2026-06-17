import path from 'path';
import dotenv from 'dotenv';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { ChannelAIPersonalitySchema } from '../schemas/channel_ai_personality.schema.js';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function run(): Promise<void> {
    const execute = process.argv.includes('--execute');

    await getMongoDBConnection('migrate_ai_feature_flags');

    const streamSummariesFilter = { streamSummariesEnabled: { $exists: false } };
    const recommendationsFilter = { recommendationsEnabled: { $exists: false } };
    const filter = { $or: [streamSummariesFilter, recommendationsFilter] };

    const matchedCount = await ChannelAIPersonalitySchema.countDocuments(filter);
    const missingStreamSummariesCount = await ChannelAIPersonalitySchema.countDocuments(streamSummariesFilter);
    const missingRecommendationsCount = await ChannelAIPersonalitySchema.countDocuments(recommendationsFilter);

    console.log(`[migration] AI personality documents requiring feature flag defaults: ${matchedCount}`);
    console.log(`[migration] missing streamSummariesEnabled: ${missingStreamSummariesCount}`);
    console.log(`[migration] missing recommendationsEnabled: ${missingRecommendationsCount}`);

    if (!execute) {
        console.log('[migration] dry-run complete. Re-run with --execute to set missing flags to true.');
        return;
    }

    if (matchedCount === 0) {
        console.log('[migration] no changes to apply.');
        return;
    }

    const streamSummariesResult = await ChannelAIPersonalitySchema.updateMany(streamSummariesFilter, {
        $set: { streamSummariesEnabled: true }
    });
    const recommendationsResult = await ChannelAIPersonalitySchema.updateMany(recommendationsFilter, {
        $set: { recommendationsEnabled: true }
    });

    console.log(
        '[migration] applied. ' +
            `streamSummaries modified=${streamSummariesResult.modifiedCount}, ` +
            `recommendations modified=${recommendationsResult.modifiedCount}`
    );
}

run()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('[migration] failed', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
        process.exit(1);
    });
