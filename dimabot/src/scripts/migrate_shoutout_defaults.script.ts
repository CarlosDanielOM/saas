import { writeFile } from 'node:fs/promises';
import { BSON } from 'mongodb';
import { CommandsSchema } from '../schemas/commands.schema.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { migrationForShoutout } from './migrate_shoutout_defaults.lib.js';
async function run() {
    const apply = process.argv.includes('--apply');
    const backupIndex = process.argv.indexOf('--backup');
    const backup = backupIndex >= 0 ? process.argv[backupIndex + 1] : undefined;
    if (apply && (!backup || backup.startsWith('--'))) throw new Error('--apply requires a new --backup PATH for BSON-preserving EJSON backup');
    await getMongoDBConnection('migrate_shoutout_defaults');
    const rows = await CommandsSchema.collection.find({ func: 'shoutout', reserved: true, activation: { $ne: 'keyword' } }).toArray();
    console.log(`Matched ${rows.length} reserved shoutout records; ${apply ? 'apply' : 'dry run'}.`);
    if (!apply) return;
    await writeFile(backup!, BSON.EJSON.stringify(rows, undefined, 2, { relaxed: false }), { flag: 'wx', mode: 0o600 });
    const cache = await getDragonflyClient('migrate_shoutout_defaults');
    let changed = 0, conflicts = 0;
    for (const row of rows) {
        const operation = migrationForShoutout(row)!;
        const result = await CommandsSchema.collection.updateOne(operation.filter, operation.update);
        if (!result.modifiedCount) { conflicts++; continue; }
        changed++;
        await cache.del(`${row.channelID}:commands:${row.cmd}`);
    }
    console.log(`Converted ${changed}; skipped ${conflicts} concurrent changes. Backup: ${backup}`);
}
run().then(() => process.exit(0)).catch(error => { console.error('Shoutout migration failed:', error); process.exit(1); });
