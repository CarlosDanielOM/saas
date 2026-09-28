import assert from 'node:assert/strict';

const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { MediaAssetSchema } = await import('/app/dist/schemas/media_asset.schema.js');
const { UserMediaLibraryItemSchema } = await import('/app/dist/schemas/user_media_library_item.schema.js');
const { default: UsersSchema } = await import('/app/dist/schemas/users.schema.js');
await getMongoDBConnection('trigger-public-assets-check');
const redis = await getDragonflyClient('trigger-public-assets-check');

const owner = '991541', viewer = '991542';
const ownerUser = await UsersSchema.collection.insertOne({ accounts: [{ type: 'twitch', id: owner, name: 'owner' }], plan_tier: 'pro' });
const viewerUser = await UsersSchema.collection.insertOne({ accounts: [{ type: 'twitch', id: viewer, name: 'viewer' }], plan_tier: 'free' });
for (const [id, name] of [[owner, 'owner'], [viewer, 'viewer']]) {
  await redis.hSet(`token:public-assets-${id}`, { id, login: name, display_name: name });
  await redis.hSet(`accounts:twitch:${id}:data`, { id, name, plan_tier: id === owner ? 'pro' : 'free' });
}

const now = new Date();
const asset = (index, scope = 'public', marketplaceStatus = 'published') => ({
  ownerUserID: String(ownerUser.insertedId), ownerChannelID: owner, ownerChannelName: 'owner',
  uploadedByUserID: String(ownerUser.insertedId), originalName: `asset_${index}.mp3`,
  displayName: index === 101 ? 'Mejor_Pais_de_Chile' : `Asset_${index}`, fileName: `asset_${index}.mp3`, extension: 'mp3',
  mimeType: 'audio/mp3', mediaType: 'audio', bytes: 100, bucket: 'fixture',
  s3Key: `fixture/trigger-public-assets/${index}`, storageUrl: 'https://fixture.invalid/file',
  scope, marketplaceStatus, libraryCount: 0, deletedAt: null,
  createdAt: new Date(now.getTime() + index), updatedAt: now
});
const inserted = await MediaAssetSchema.collection.insertMany([
  ...Array.from({ length: 101 }, (_, index) => asset(index)),
  asset(101, 'public', 'not_listed'),
  asset(102, 'public', 'hidden'),
  asset(103, 'public', 'pending_review'),
  asset(104, 'public', 'removed'),
  asset(105, 'private', 'not_listed')
]);
const legacyId = String(inserted.insertedIds[101]);
const privateId = inserted.insertedIds[105];
const privateItem = await UserMediaLibraryItemSchema.collection.insertOne({
  channelID: owner, channelName: 'owner', addedByUserID: String(ownerUser.insertedId),
  assetID: privateId, relationType: 'owner_upload', localAlias: null,
  quotaBytesCharged: 100, assetScope: 'private', mediaType: 'audio',
  isActive: true, deletedAt: null, createdAt: now, updatedAt: now
});

const base = 'http://127.0.0.1:3000/triggers';
async function request(path, token = viewer, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer public-assets-${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const json = await response.json();
  assert.equal(response.status, method === 'POST' && json.status === 201 ? 201 : 200, JSON.stringify(json));
  return json;
}

const first = await request('/assets/public?limit=100&skip=0');
const second = await request('/assets/public?limit=100&skip=100');
assert.equal(first.total, 102);
assert.equal(first.data.length, 100);
assert.equal(second.total, 102);
assert.equal(second.data.length, 2);
assert(first.data.concat(second.data).some(item => item._id === legacyId), 'legacy public asset should be listed');
assert.equal((await request('/assets/public?q=mejor%20pa%C3%ADs%20de%20chile&mediaType=audio')).data[0]._id, legacyId);
assert.equal((await request('/assets/public?mediaType=video')).total, 0);
assert.equal((await request(`/assets/public?id=${inserted.insertedIds[102]}`)).total, 0, 'hidden asset remains excluded');

const added = await request(`/library/${viewer}/add-public/${legacyId}`, viewer, 'POST');
assert.equal(added.data.assetID, legacyId);
assert.equal(added.data.assetScope, 'public');
assert.equal((await UserMediaLibraryItemSchema.findOne({ channelID: viewer, assetID: legacyId }).lean())?.quotaBytesCharged, 0);

await request(`/library/${owner}/${privateItem.insertedId}/scope`, owner, 'PATCH', { scope: 'public', planTier: 'pro' });
const promoted = await MediaAssetSchema.findById(privateId).lean();
assert.equal(promoted?.scope, 'public');
assert.equal(promoted?.marketplaceStatus, 'published');
assert.equal((await request(`/assets/public?id=${privateId}`)).total, 1);
console.log('PASS trigger public assets: legacy promotions, catalog pagination and filters, hidden exclusion, adding public media, and new promotion.');
process.exit(0);
