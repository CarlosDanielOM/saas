import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import mongoose from 'mongoose';

const query = <T>(value: T) => ({ lean: async () => value, select: () => ({ lean: async () => value }) });
mock.module('node:child_process', { namedExports: { execFile: (_cmd: unknown, _args: unknown, _options: unknown, cb: Function) => cb(null, { stdout: JSON.stringify({ streams: [{ width: 1, height: 1 }] }) }) } });
mock.module('../utils/databases/mongodb.database.js', { namedExports: { getMongoDBConnection: async () => {} } });
mock.module('../schemas/users.schema.js', { defaultExport: { findOne: () => query({ _id: 'owner', plan_tier: 'premium' }) } });
mock.module('../schemas/pet_settings.schema.js', { namedExports: { PetSettingsSchema: { findOne: () => query(null) } } });
const { Libraries, uploadAsset, ASSET_QUOTAS, MAX_ASSETS } = await import('./library.js');
const library: { usedBytes: number; assets: any[] } = { usedBytes: ASSET_QUOTAS.premium, assets: [] };
Libraries.findById = (() => query(library)) as unknown as typeof Libraries.findById;
Libraries.updateOne = (async (filter: any, update: any) => {
  if (update.$setOnInsert) return { modifiedCount: 0 };
  if (update.$push) {
    for (const [key, condition] of Object.entries(filter)) {
      const match = /^assets\.(\d+)$/.exec(key);
      if (match && (condition as { $exists?: boolean }).$exists === false && library.assets.length > Number(match[1])) return { modifiedCount: 0 };
    }
    if (filter.$expr) {
      const [expression, limit] = filter.$expr.$lt;
      const condition = expression.$size.$filter.cond;
      const count = library.assets.filter(a => condition.$eq ? a.purpose === condition.$eq[1] : (a.purpose ?? '') !== condition.$ne[1]).length;
      if (count >= limit) return { modifiedCount: 0 };
    }
    if (filter.usedBytes && library.usedBytes > filter.usedBytes.$lte) return { modifiedCount: 0 };
    library.usedBytes += update.$inc.usedBytes; library.assets.push(update.$push.assets); return { modifiedCount: 1 };
  }
  if (update.$set?.['assets.$.state']) library.assets.find(a => a.id === filter['assets.id']).state = update.$set['assets.$.state'];
  return { modifiedCount: 1 };
}) as typeof Libraries.updateOne;
Object.defineProperty(mongoose.mongo, 'GridFSBucket', { configurable: true, value: class { openUploadStreamWithId() { return new Writable({ write(_chunk, _encoding, callback) { callback(); } }); } } });
Object.defineProperty(mongoose.connection, 'db', { configurable: true, value: {} });

test('mood upload reserves its own slots even when media byte quota is full', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mood-test-'));
  const path = join(directory, 'one.png');
  // PNG signature is inspected; the ffprobe response is mocked for isolation.
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path, bytes);
  try {
    for (let i = 0; i < 8; i++) assert.equal((await uploadAsset('owner', { path, size: bytes.length, originalname: 'x.png' }, 'pet-mood')).purpose, 'pet-mood');
    assert.equal(library.usedBytes, ASSET_QUOTAS.premium);
    await assert.rejects(uploadAsset('owner', { path, size: bytes.length, originalname: 'x.png' }, 'pet-mood'), { code: 'mood_image_limit' });
    await assert.rejects(uploadAsset('owner', { path, size: bytes.length, originalname: 'x.png' }), { code: 'quota_exceeded' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('a full normal library does not consume the independent mood asset allowance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mood-test-count-'));
  const path = join(directory, 'one.png');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path, bytes);
  library.usedBytes = 0;
  library.assets = Array.from({ length: MAX_ASSETS }, (_, i) => ({ id: `normal-${i}`, state: 'ready' }));
  try {
    assert.equal((await uploadAsset('owner', { path, size: bytes.length, originalname: 'x.png' }, 'pet-mood')).purpose, 'pet-mood');
    assert.equal(library.assets.length, MAX_ASSETS + 1);
    assert.equal(library.usedBytes, 0);
    await assert.rejects(uploadAsset('owner', { path, size: bytes.length, originalname: 'x.png' }), { code: 'quota_exceeded' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
