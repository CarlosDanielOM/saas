/** Verify the read-only production probe using disposable records first. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
assert.match(process.env.MONGO_URI, /saas_ops_oauth_beta_test$/);
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { defaultPetSettings } = await import('/app/dist/server/services/pet_settings.service.js');
const mongo = await getMongoDBConnection('dima046-production-probe-fixture');
const db = mongo.connection.db;
for (let index = 0; index < 3; index++) {
  const user = await db.collection('users').insertOne({ plan_tier: index === 2 ? 'pro' : 'premium',
    accounts: [{ type: 'twitch', id: `9900460${index}` }] });
  const settings = defaultPetSettings();
  if (index === 0) delete settings.moods;
  if (index === 1) settings.moods = { enabled: true, holdMs: -1, emotions: null };
  await db.collection('pet_settings').insertOne({ userId: user.insertedId, revision: 1, settings, updatedAt: new Date() });
}
const env = { ...process.env, DIMA046_READ_ONLY_CHECK: '1' }; delete env.NODE_OPTIONS;
const result = spawnSync(process.execPath, ['/tmp/saas-fixtures/production-probe.mjs'], { env, stdio: 'inherit', timeout: 30000 });
assert.ifError(result.error); assert.equal(result.status, 0);
console.log('PASS read-only production probe against disposable legacy, corrupt and valid saved pet settings.');
process.exit(0);
