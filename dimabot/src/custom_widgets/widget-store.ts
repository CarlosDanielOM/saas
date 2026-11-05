import { Schema, model } from 'mongoose';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { CommandsSchema } from '../schemas/commands.schema.js';
import { CustomWidgetError } from './store.js';

/**
 * `custom_widget_store`: small key/value data that widgets save (Dima.storage / SE_API.store). Namespace `se` is
 * shared by all StreamElements widgets of a channel (as on StreamElements); Dima widgets use their widget ID.
 */
/** Values are kept as JSON text, so any JSON (including keys Mongo can't store) round-trips exactly. */
interface StoredValue { _id: string; owner: string; namespace: string; key: string; json: string; bytes: number; updatedAt: Date }
const schema = new Schema<StoredValue>({ _id: String, owner: String, namespace: String, key: String, json: String, bytes: Number, updatedAt: Date },
  { versionKey: false, collection: 'custom_widget_store', minimize: false });
schema.index({ owner: 1, namespace: 1, key: 1 });
export const WidgetStore = model<StoredValue>('CustomWidgetStore', schema);

export const STORE_LIMITS = { key: 100, valueBytes: 64_000, keys: 500, totalBytes: 2_000_000 } as const;
const NAMESPACE = /^(se|[a-f0-9]{24})$/;
const db = () => getMongoDBConnection('custom-widget-store');
function check(namespace: string, key: unknown): string {
  if (!NAMESPACE.test(namespace)) throw new CustomWidgetError('Invalid store namespace');
  if (typeof key !== 'string' || !key || key.length > STORE_LIMITS.key) throw new CustomWidgetError('Store keys are 1–100 characters');
  return key;
}
export async function storeGet(owner: string, namespace: string, rawKey: unknown): Promise<unknown> {
  const key = check(namespace, rawKey);
  await db();
  const stored = await WidgetStore.findById(`${owner}:${namespace}:${key}`).select('json').lean();
  return stored ? JSON.parse(stored.json) as unknown : null;
}
// One write at a time per channel keeps the key/size limits exact.
const locks = new Map<string, Promise<unknown>>();
export async function storeSet(owner: string, namespace: string, rawKey: unknown, raw: unknown): Promise<void> {
  const key = check(namespace, rawKey);
  let json: string;
  try { json = JSON.stringify(raw ?? null); } catch { throw new CustomWidgetError('Store values must be JSON'); }
  if (json === undefined) json = 'null';
  const bytes = Buffer.byteLength(json);
  if (bytes > STORE_LIMITS.valueBytes) throw new CustomWidgetError('Store values are limited to 64 KB');
  await db();
  const previous = locks.get(owner) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const id = `${owner}:${namespace}:${key}`;
    const [totals] = await WidgetStore.aggregate<{ keys: number; bytes: number }>([{ $match: { owner } }, { $group: { _id: null, keys: { $sum: 1 }, bytes: { $sum: '$bytes' } } }]);
    const existing = await WidgetStore.findById(id).select('bytes').lean();
    const keys = (totals?.keys ?? 0) + (existing ? 0 : 1), total = (totals?.bytes ?? 0) - (existing?.bytes ?? 0) + bytes;
    if (keys > STORE_LIMITS.keys) throw new CustomWidgetError('This channel has reached 500 saved widget values');
    if (total > STORE_LIMITS.totalBytes) throw new CustomWidgetError('This channel has reached 2 MB of saved widget data');
    await WidgetStore.updateOne({ _id: id }, { $set: { owner, namespace, key, json, bytes, updatedAt: new Date() } }, { upsert: true });
  });
  locks.set(owner, current);
  try { await current; } finally { if (locks.get(owner) === current) locks.delete(owner); }
}

/** The count of the channel's command `name` (with or without "!"), 0 when it doesn't exist. */
export async function commandCount(owner: string, rawName: unknown): Promise<number> {
  const name = typeof rawName === 'string' ? rawName.trim().replace(/^!/, '').toLowerCase() : '';
  if (!name || name.length > 100) throw new CustomWidgetError('Invalid counter name');
  await db();
  const command = await CommandsSchema.findOne({ channelID: owner, activation: { $ne: 'keyword' }, cmd: name }).select('count').lean();
  return typeof command?.count === 'number' ? command.count : 0;
}
