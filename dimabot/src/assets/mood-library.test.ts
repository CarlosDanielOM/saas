import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let planTier = 'premium';
let settingsRecord: unknown = null;
const rows = [
  { id: 'normal', state: 'ready', purpose: undefined },
  { id: 'mood', state: 'ready', purpose: 'pet-mood' },
];
const query = <T>(value: T) => ({ lean: async () => value, select: () => ({ lean: async () => value }) });
mock.module('../utils/databases/mongodb.database.js', { namedExports: { getMongoDBConnection: async () => {} } });
mock.module('../schemas/users.schema.js', { defaultExport: { findOne: () => query({ _id: 'owner', plan_tier: planTier }) } });
mock.module('../schemas/pet_settings.schema.js', { namedExports: { PetSettingsSchema: { findOne: () => query(settingsRecord) } } });
const { Libraries, findAsset, listAssets, requireMoodAssetPlan } = await import('./library.js');
Libraries.findById = ((owner: string) => query(owner === 'owner' ? { usedBytes: 123, assets: rows } : null)) as unknown as typeof Libraries.findById;

test('mood assets stay private from ordinary library consumers and do not affect media usage', async () => {
  assert.equal((await findAsset('owner', 'normal')).id, 'normal');
  await assert.rejects(findAsset('owner', 'mood'), { code: 'not_found' });
  assert.equal((await findAsset('owner', 'mood', true)).id, 'mood');
  const normal = await listAssets('owner');
  assert.deepEqual(normal.assets.map(asset => asset.id), ['normal']);
  assert.equal(normal.usedBytes, 123);
  const mood = await listAssets('owner', 'pet-mood');
  assert.deepEqual(mood.assets.map(asset => asset.id), ['mood']);
  assert.equal(mood.usedBytes, 123);
  assert.equal(mood.moodImageLimit, 8);
  assert.equal(mood.configuredMoodImages, 0);
  await assert.rejects(findAsset('other-owner', 'mood', true), { code: 'not_found' });
});


test('downgrade blocks listing and preview authorization while retaining assets', async () => {
  const mood = await findAsset('owner', 'mood', true);
  const ordinary = await findAsset('owner', 'normal');
  await requireMoodAssetPlan('owner', mood);
  planTier = 'free';
  await assert.rejects(listAssets('owner', 'pet-mood'), { code: 'plan_required', status: 403 });
  await assert.rejects(requireMoodAssetPlan('owner', mood), { code: 'plan_required', status: 403 });
  await requireMoodAssetPlan('owner', ordinary);
  const normal = await listAssets('owner');
  assert.deepEqual(normal.assets.map(asset => asset.id), ['normal']);
  assert.equal('moodImageLimit' in normal, false);
  assert.equal((await findAsset('owner', 'mood', true)).id, 'mood');
  planTier = 'pro';
  await requireMoodAssetPlan('owner', mood);
  assert.deepEqual((await listAssets('owner', 'pet-mood')).assets.map(asset => asset.id), ['mood']);
});


test('corrupt stored moods do not break mood asset listing', async () => {
  settingsRecord = { settings: { moods: { enabled: true, images: 'corrupt' } } };
  const result = await listAssets('owner', 'pet-mood');
  assert.equal(result.configuredMoodImages, 0);
  assert.deepEqual(result.assets.map(asset => asset.id), ['mood']);
  settingsRecord = null;
});
