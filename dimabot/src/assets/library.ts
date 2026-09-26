import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mongoose, { Schema, model } from 'mongoose';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import Users from '../schemas/users.schema.js';

export const ASSET_QUOTAS = { free: 100_000_000, premium: 500_000_000, pro: 5_000_000_000 } as const;
export const MAX_ASSET_BYTES = 50_000_000;
export const MAX_ASSETS = 2000;
export class AssetError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export interface Asset {
  id: string; name: string; kind: 'image' | 'video'; mime: string;
  bytes: number; width: number; height: number; createdAt: string;
  state: 'uploading' | 'ready' | 'deleting';
}
interface Library { _id: string; usedBytes: number; assets: Asset[] }
const assetSchema = new Schema<Asset>({ id: String, name: String, kind: String, mime: String, bytes: Number, width: Number, height: Number, createdAt: String, state: String }, { _id: false });
const schema = new Schema<Library>({ _id: String, usedBytes: { type: Number, default: 0 }, assets: { type: [assetSchema], default: [] } }, { versionKey: false, collection: 'asset_libraries' });
export const Libraries = model<Library>('AssetLibrary', schema);

// The API is a single process. Consumers use this same boundary for reference
// updates and deletion; quota reservations also use an atomic Mongo condition.
const locks = new Map<string, Promise<unknown>>();
export async function withAssetLibrary<T>(owner: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(owner) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  locks.set(owner, current);
  try { return await current; } finally { if (locks.get(owner) === current) locks.delete(owner); }
}
const consumers = new Map<string, (owner: string, asset: string) => Promise<boolean>>();
export function registerAssetConsumer(name: string, inUse: (owner: string, asset: string) => Promise<boolean>) { consumers.set(name, inUse); }
async function bucket() {
  await getMongoDBConnection('asset-library');
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db!, { bucketName: 'private_assets' });
}
export async function assetQuota(owner: string) {
  await getMongoDBConnection('asset-library');
  const user = await Users.findOne({ accounts: { $elemMatch: { type: 'twitch', id: owner } } }).select('plan_tier').lean();
  if (!user) throw new AssetError('owner_missing', 404);
  const tier = user.plan_tier === 'pro' || user.plan_tier === 'premium' ? user.plan_tier : 'free';
  return { planTier: tier, quotaBytes: ASSET_QUOTAS[tier], maxFileBytes: MAX_ASSET_BYTES };
}
export async function findAsset(owner: string, id: string): Promise<Asset> {
  await getMongoDBConnection('asset-library');
  const library = await Libraries.findById(owner).lean();
  const asset = library?.assets.find(a => a.id === id && a.state === 'ready');
  if (!asset) throw new AssetError('not_found', 404);
  return asset;
}
async function removeBytes(owner: string, asset: Asset) {
  await bucket();
  const id = new mongoose.mongo.ObjectId(asset.id);
  // Delete chunks even if an interrupted upload never created its files record.
  await mongoose.connection.db!.collection('private_assets.chunks').deleteMany({ files_id: id });
  await mongoose.connection.db!.collection('private_assets.files').deleteOne({ _id: id });
  await Libraries.updateOne({ _id: owner, 'assets.id': asset.id }, { $pull: { assets: { id: asset.id } }, $inc: { usedBytes: -asset.bytes } });
}
async function recover(owner: string) {
  const library = await Libraries.findById(owner).lean();
  for (const asset of library?.assets ?? []) {
    if (asset.state === 'deleting' || asset.state === 'uploading' && Date.parse(asset.createdAt) < Date.now() - 60 * 60_000) await removeBytes(owner, asset);
  }
}
export async function listAssets(owner: string) {
  const quota = await assetQuota(owner);
  return withAssetLibrary(owner, async () => {
    await recover(owner);
    const library = await Libraries.findById(owner).lean();
    return { ...quota, usedBytes: library?.usedBytes ?? 0, assets: (library?.assets ?? []).filter(a => a.state === 'ready').reverse() };
  });
}
async function inspectFile(path: string): Promise<Pick<Asset, 'mime' | 'kind' | 'width' | 'height'>> {
  const file = await open(path, 'r'); const bytes = Buffer.alloc(32);
  try { await file.read(bytes, 0, bytes.length, 0); } finally { await file.close(); }
  let mime = '';
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) mime = 'image/gif';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else if (bytes.toString('ascii', 4, 8) === 'ftyp') mime = 'video/mp4';
  else if (bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) mime = 'video/webm';
  if (!mime) throw new AssetError('unsupported_type', 415);
  try {
    const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', path], { timeout: 10_000, maxBuffer: 65536 });
    const stream = JSON.parse(stdout).streams?.[0];
    if (!stream || !Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width < 1 || stream.height < 1 || stream.width > 16384 || stream.height > 16384) throw new Error('Invalid dimensions');
    if (mime === 'video/mp4' && !['h264', 'hevc', 'av1', 'vp9'].includes(stream.codec_name)) throw new Error('Unsupported MP4');
    if (mime === 'video/webm' && !['vp8', 'vp9', 'av1'].includes(stream.codec_name)) throw new Error('Unsupported WebM');
    return { mime, kind: mime.startsWith('image/') ? 'image' : 'video', width: stream.width, height: stream.height };
  } catch { throw new AssetError('invalid_media', 415); }
}
export async function uploadAsset(owner: string, file: { path: string; originalname: string; size: number }) {
  if (!file.size || file.size > MAX_ASSET_BYTES) throw new AssetError('file_size', 413);
  const media = await inspectFile(file.path);
  return withAssetLibrary(owner, async () => {
    const { quotaBytes } = await assetQuota(owner);
    await Libraries.updateOne({ _id: owner }, { $setOnInsert: { usedBytes: 0, assets: [] } }, { upsert: true });
    await recover(owner);
    const asset: Asset = { id: new mongoose.mongo.ObjectId().toHexString(), name: file.originalname.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 120) || randomUUID(), bytes: file.size, ...media, createdAt: new Date().toISOString(), state: 'uploading' };
    const reserved = await Libraries.updateOne({ _id: owner, usedBytes: { $lte: quotaBytes - asset.bytes }, [`assets.${MAX_ASSETS - 1}`]: { $exists: false } }, { $inc: { usedBytes: asset.bytes }, $push: { assets: asset } });
    if (!reserved.modifiedCount) throw new AssetError('quota_exceeded', 413);
    try {
      const b = await bucket();
      const upload = b.openUploadStreamWithId(new mongoose.mongo.ObjectId(asset.id), asset.name, { metadata: { owner, mime: asset.mime } });
      await pipeline(createReadStream(file.path), upload);
      await Libraries.updateOne({ _id: owner, 'assets.id': asset.id }, { $set: { 'assets.$.state': 'ready' } });
      return { ...asset, state: 'ready' as const };
    } catch (error) { await removeBytes(owner, asset); throw error; }
  });
}
export async function deleteAsset(owner: string, id: string) {
  return withAssetLibrary(owner, async () => {
    const asset = await findAsset(owner, id);
    for (const inUse of consumers.values()) if (await inUse(owner, id)) throw new AssetError('in_use', 409);
    await Libraries.updateOne({ _id: owner, 'assets.id': id }, { $set: { 'assets.$.state': 'deleting' } });
    await removeBytes(owner, asset);
  });
}
export async function readAsset(owner: string, id: string, start?: number, end?: number) {
  const asset = await findAsset(owner, id);
  const b = await bucket();
  return { asset, stream: b.openDownloadStream(new mongoose.mongo.ObjectId(id), { start, end }) };
}
