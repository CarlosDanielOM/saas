import Users from '../schemas/users.schema.js';
import { Studio } from '../overlays/store.js';
import { upgradeDefaultAlerts, type StudioDoc } from '../overlays/default-alerts-migration.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';

/**
 * Gives every studio still on the untouched old starter alerts the Dima default alerts (in the owner's language).
 * Designs anyone changed are left exactly as they are. Dry run by default: prints what would change.
 *   node dist/scripts/migrate_default_alerts.script.js            # dry run
 *   node dist/scripts/migrate_default_alerts.script.js --apply    # write (revision-checked per studio)
 */
async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await getMongoDBConnection('default-alerts-migration');
  const docs = await Studio.find({}).lean() as unknown as StudioDoc[];
  let changed = 0, skipped = 0;
  for (const doc of docs) {
    const owner = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: doc._id } } }).select('language').lean();
    const language = owner?.language === 'es' ? 'es' : 'en';
    const upgrade = upgradeDefaultAlerts(doc, language);
    if (!upgrade) { skipped++; continue; }
    const line = `${doc._id} lang=${language} designs=${upgrade.draft.join(',')} published=${upgrade.published.join(',') || '-'}`;
    if (!apply) { console.log(`would update ${line}`); changed++; continue; }
    const result = await Studio.updateOne({ _id: doc._id, revision: doc.revision }, { $set: { designs: upgrade.designs, scenes: upgrade.scenes }, $inc: { revision: 1 } });
    if (result.modifiedCount) { console.log(`updated ${line}`); changed++; }
    else console.log(`SKIPPED ${doc._id}: the studio changed while migrating; run again`);
  }
  console.log(`${apply ? 'updated' : 'would update'} ${changed} studio(s); ${skipped} left as they are`);
}

run().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
