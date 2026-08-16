import path from 'node:path';
import dotenv from 'dotenv';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function run(): Promise<void> {
    const execute = process.argv.includes('--execute');
    const [databaseModule, memorySchemaModule, memoryServiceModule] = await Promise.all([
        import('../utils/databases/mongodb.database.js'),
        import('../schemas/channel_ai_memory.schema.js'),
        import('../utils/ai/memory/memory.service.js')
    ]);
    const { getMongoDBConnection } = databaseModule;
    const { ChannelAIMemorySchema } = memorySchemaModule;
    const { syncMemoryToQdrant } = memoryServiceModule;

    await getMongoDBConnection('resync_ai_memories');

    const total = await ChannelAIMemorySchema.countDocuments({});
    const missingPointID = await ChannelAIMemorySchema.countDocuments({
        qdrantPointID: { $exists: false }
    });
    console.log(`[memory-resync] memories=${total}, missing qdrantPointID=${missingPointID}`);

    if (!execute) {
        console.log('[memory-resync] dry-run complete. Re-run with --execute to assign IDs and synchronize Qdrant.');
        return;
    }

    let synchronized = 0;
    let failed = 0;
    const cursor = ChannelAIMemorySchema.find({}).cursor();
    for await (const memory of cursor) {
        try {
            await syncMemoryToQdrant(memory);
            synchronized++;
        } catch (error) {
            failed++;
            console.error('[memory-resync] failed', {
                memoryID: String(memory._id),
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    console.log(`[memory-resync] complete. synchronized=${synchronized}, failed=${failed}`);
    if (failed > 0) {
        process.exitCode = 1;
    }
}

run()
    .then(() => process.exit(process.exitCode || 0))
    .catch((error) => {
        console.error('[memory-resync] fatal', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
        process.exit(1);
    });
