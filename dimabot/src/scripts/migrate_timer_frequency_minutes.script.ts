import path from 'path';
import dotenv from 'dotenv';
import { ObjectId } from 'mongodb';
import { CustomTimerSchema } from '../schemas/custom_timer.schema.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import {
    TIMER_FREQUENCY_UNIT,
    convertLegacyTimerFrequency
} from '../utils/timer_policy.js';

interface RawTimerDocument {
    _id: ObjectId;
    frequency?: unknown;
    frequencyUnit?: unknown;
}

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function run(): Promise<void> {
    const execute = process.argv.includes('--execute');

    await getMongoDBConnection('migrate_timer_frequency_minutes');

    const documents = await CustomTimerSchema.collection
        .find(
            { frequencyUnit: { $ne: TIMER_FREQUENCY_UNIT } },
            { projection: { _id: 1, frequency: 1, frequencyUnit: 1 } }
        )
        .toArray() as RawTimerDocument[];

    const operations: Array<{
        updateOne: {
            filter: { _id: ObjectId; frequencyUnit: { $ne: typeof TIMER_FREQUENCY_UNIT } };
            update: { $set: { frequency: number; frequencyUnit: typeof TIMER_FREQUENCY_UNIT } };
        };
    }> = [];
    const skipped: Array<{ id: string; frequency: unknown }> = [];

    for (const document of documents) {
        const convertedFrequency = convertLegacyTimerFrequency(document.frequency);
        if (convertedFrequency === null) {
            skipped.push({ id: String(document._id), frequency: document.frequency });
            continue;
        }

        operations.push({
            updateOne: {
                filter: {
                    _id: document._id,
                    frequencyUnit: { $ne: TIMER_FREQUENCY_UNIT }
                },
                update: {
                    $set: {
                        frequency: convertedFrequency,
                        frequencyUnit: TIMER_FREQUENCY_UNIT
                    }
                }
            }
        });
    }

    console.log(`[migration] legacy timer documents matched: ${documents.length}`);
    console.log(`[migration] timer documents ready to convert: ${operations.length}`);
    console.log(`[migration] invalid timer documents skipped: ${skipped.length}`);

    if (skipped.length > 0) {
        console.warn('[migration] skipped timer documents require manual review', skipped.slice(0, 20));
    }

    if (!execute) {
        console.log('[migration] dry-run complete. Re-run with --execute to apply changes.');
        return;
    }

    if (operations.length === 0) {
        console.log('[migration] no changes to apply.');
        return;
    }

    const result = await CustomTimerSchema.collection.bulkWrite(operations, { ordered: false });
    console.log(`[migration] applied. matchedCount=${result.matchedCount} modifiedCount=${result.modifiedCount}`);
    console.log('[migration] active Dragonfly timer payloads remain compatible and will refresh on the next stream-online cycle.');
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
