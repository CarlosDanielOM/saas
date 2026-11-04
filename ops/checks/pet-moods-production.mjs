/** Read-only post-deploy probe. Run with node stdin inside the live API container. */
import assert from 'node:assert/strict';
assert.equal(process.env.DIMA046_READ_ONLY_CHECK, '1');
assert.equal(process.env.PUBLIC_API_URL, 'https://api.domdimabot.com');
process.env.OTEL_SDK_DISABLED = 'true';
const { default: mongoose } = await import('/app/node_modules/mongoose/index.js');
// A diagnostic process must never create collections or indexes.
mongoose.set('autoCreate', false); mongoose.set('autoIndex', false);
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getPetConfiguration } = await import('/app/dist/server/services/pet_settings.service.js');
const { PetSettingsSchema } = await import('/app/dist/schemas/pet_settings.schema.js');
const { default: Users } = await import('/app/dist/schemas/users.schema.js');
const { MOOD_NAMES, defaultPetMoods, resolvePetMood, moodConfiguration } = await import('/app/dist/pets/moods.js');
try {
  await getMongoDBConnection('dima046-read-only-production');
  const records = await PetSettingsSchema.find().select('userId settings.moods').sort({ updatedAt: -1 }).limit(25).lean();
  let checked = 0;
  for (const record of records) {
    const owner = await Users.findById(record.userId).select('plan_tier accounts.type accounts.id').lean();
    if (!owner || !['premium', 'pro'].includes(owner.plan_tier)) continue;
    const channel = owner.accounts.find(account => account.type === 'twitch')?.id;
    if (!channel) continue;
    const config = await getPetConfiguration(String(record.userId), channel);
    assert.equal(config.moods.available, true);
    assert.equal(typeof config.moods.enabled, 'boolean');
    assert(Number.isInteger(config.moods.holdMs) && config.moods.holdMs >= 0 && config.moods.holdMs <= 10000);
    assert.deepEqual(Object.keys(config.moods.emotions).sort(), [...MOOD_NAMES].sort());
    assert.equal(config.moodImageLimit, owner.plan_tier === 'pro' ? 16 : 8);
    if (record.settings.moods === undefined) assert.deepEqual(config.settings.moods, defaultPetMoods());
    if (++checked === 3) break;
  }
  assert(checked > 0, 'production needs at least one saved paid Pet configuration for this read-only probe');
  assert.equal(resolvePetMood('[whisper] [anger] hello', defaultPetMoods()), 'angry');
  assert.deepEqual(moodConfiguration(defaultPetMoods(), 'free'), { available: false, enabled: false });
  const response = await fetch('http://127.0.0.1:3000/v1/me/pet', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 401, 'existing OAuth authorization remains required');
  console.log(`PASS production mood probe: ${checked} saved paid configurations load with valid additive mood fields; legacy defaults, plan limits, raw aliases and OAuth gate pass; no settings, requests, billing or speech written.`);
} finally { await mongoose.disconnect(); }
process.exit(0);
