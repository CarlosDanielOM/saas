import { createHash, randomBytes } from 'node:crypto';
import { Schema, model } from 'mongoose';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import * as domain from './model.js';
import type { State } from './model.js';

interface Receipt { key: string; fingerprint: string; result: string; at: number }
interface Stored { _id: string; revision: number; state: State; tokenHash: string | null; dueAt: number | null; receipts: Receipt[] }
const schema = new Schema<Stored>({
  _id: String, revision: { type: Number, required: true }, state: { type: Schema.Types.Mixed, required: true },
  tokenHash: { type: String, default: null }, dueAt: { type: Number, default: null }, receipts: { type: [new Schema<Receipt>({ key: String, fingerprint: String, result: String, at: Number }, { _id: false })], default: [] },
}, { versionKey: false, collection: 'roulette_channels' });
schema.index({ dueAt: 1 });
export const RouletteChannel = model<Stored>('RouletteChannel', schema);
export type Operation = 'create' | 'configure' | 'delete' | 'add' | 'update' | 'remove' | 'shuffle' | 'switch' | 'show' | 'hide' | 'start';
export interface Action { operation: Operation; roulette?: string; itemId?: string; data?: Record<string, unknown> }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const due = (state: State) => state.draw?.completedAt === null ? state.draw.endsAt : state.hideAt;
function channel(value: string): string { return domain.text(value, 'channel', 100); }
async function load(channelId: string): Promise<Stored> {
  channel(channelId); await getMongoDBConnection('roulette');
  let doc = await RouletteChannel.findById(channelId).lean();
  if (!doc) {
    try { await RouletteChannel.create({ _id: channelId, revision: 0, state: domain.emptyState(), tokenHash: null, dueAt: null, receipts: [] }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    doc = await RouletteChannel.findById(channelId).lean();
  }
  return doc!;
}
function apply(state: State, action: Action, now: number): string {
  const data = action.data ?? {};
  if (action.operation === 'create') {
    if (state.roulettes.length >= 20) domain.fail('capacity', 'A channel supports up to 20 saved roulettes');
    const r = domain.create(data); state.roulettes.push(r); state.activeId ??= r.id; return r.id;
  }
  if (action.operation === 'show' || action.operation === 'hide') {
    if (action.operation === 'show') domain.find(state);
    state.visible = action.operation === 'show'; state.hideAt = null; return '';
  }
  const r = domain.find(state, action.roulette);
  switch (action.operation) {
    case 'configure':
      domain.idle(state); domain.configure(r, data);
      if (state.activeId === r.id) { state.draw = null; state.hideAt = null; }
      return r.id;
    case 'delete':
      domain.idle(state); state.roulettes = state.roulettes.filter(x => x.id !== r.id);
      if (state.activeId === r.id) { state.activeId = null; state.visible = false; state.draw = null; state.hideAt = null; }
      return r.id;
    case 'add': return domain.add(r, data).id;
    case 'update': return domain.updateItem(r, domain.text(action.itemId, 'itemId'), data).id;
    case 'remove': domain.remove(r, domain.text(action.itemId, 'itemId')); return action.itemId!;
    case 'shuffle': domain.idle(state); domain.shuffle(r.order); return r.id;
    case 'switch': domain.idle(state); state.activeId = r.id; state.draw = null; state.hideAt = null; return r.id;
    case 'start': return domain.start(state, r, now).id;
    default: return domain.fail('invalid', 'Unknown roulette action');
  }
}
/** One channel document is the atomic boundary across API, bot and cron processes. */
export async function execute(channelId: string, action: Action, requestKey?: string, expectedRevision?: number) {
  if (requestKey !== undefined) domain.text(requestKey, 'Idempotency-Key', 128);
  if (expectedRevision !== undefined) domain.integer(expectedRevision, 'revision', 0);
  const fingerprint = hash(JSON.stringify(action)); const receiptKey = requestKey ? hash(requestKey) : null;
  for (let retry = 0; retry < 20; retry++) {
    const doc = await load(channelId); const now = Date.now();
    const receipt = receiptKey && doc.receipts.find(r => r.key === receiptKey && now - r.at < 86400000);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) domain.fail('idempotency_conflict', 'Idempotency key was used for a different action', 409);
      return { revision: doc.revision, result: receipt.result, replayed: true };
    }
    if (expectedRevision !== undefined && expectedRevision !== doc.revision) domain.fail('revision_conflict', 'State changed; refresh before saving', 409);
    domain.settle(doc.state, now);
    const result = apply(doc.state, action, now);
    const aliases = doc.state.roulettes.map(r => r.alias);
    if (new Set(aliases).size !== aliases.length || doc.state.roulettes.some(r => aliases.includes(r.id))) domain.fail('alias_conflict', 'Alias already exists in this channel', 409);
    if (Buffer.byteLength(JSON.stringify(doc.state)) > 4 * 1024 * 1024) domain.fail('capacity', 'Channel roulette storage limit reached');
    const receipts = doc.receipts.filter(r => now - r.at < 86400000);
    if (receiptKey) receipts.push({ key: receiptKey, fingerprint, result, at: now });
    const saved = await RouletteChannel.updateOne({ _id: channelId, revision: doc.revision }, {
      $set: { state: doc.state, dueAt: due(doc.state), receipts: receipts.slice(-200) }, $inc: { revision: 1 },
    });
    if (saved.modifiedCount) return { revision: doc.revision + 1, result, replayed: false };
  }
  return domain.fail('busy', 'Roulette is busy; retry with the same idempotency key', 409);
}
export async function snapshot(channelId: string) {
  for (let retry = 0; retry < 20; retry++) {
    const doc = await load(channelId);
    if (!domain.settle(doc.state, Date.now())) return { revision: doc.revision, serverTime: Date.now(), ...doc.state };
    const saved = await RouletteChannel.updateOne({ _id: channelId, revision: doc.revision }, {
      $set: { state: doc.state, dueAt: due(doc.state) }, $inc: { revision: 1 },
    });
    if (saved.modifiedCount) return { revision: doc.revision + 1, serverTime: Date.now(), ...doc.state };
  }
  return domain.fail('busy', 'Roulette is busy', 409);
}
export async function rotateToken(channelId: string): Promise<string> {
  await load(channelId); const token = randomBytes(32).toString('base64url');
  await RouletteChannel.updateOne({ _id: channelId }, { $set: { tokenHash: hash(token) }, $inc: { revision: 1 } });
  return token;
}
export async function authorizeOverlay(channelId: string, token: unknown): Promise<boolean> {
  if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return false;
  await getMongoDBConnection('roulette-overlay');
  return !!await RouletteChannel.exists({ _id: channel(channelId), tokenHash: hash(token) });
}
export async function overlaySnapshot(channelId: string) {
  const s = await snapshot(channelId);
  return { revision: s.revision, serverTime: s.serverTime, visible: s.visible,
    roulette: s.roulettes.find(r => r.id === s.activeId) ?? null, draw: s.draw, hideAt: s.hideAt };
}
/** Poll only indexed deadlines; snapshots also settle lazily after downtime. */
export async function settleDue(): Promise<void> {
  await getMongoDBConnection('roulette-completion');
  const rows = await RouletteChannel.find({ dueAt: { $ne: null, $lte: Date.now() } }, { _id: 1 }).limit(100).lean();
  for (const row of rows) await snapshot(row._id);
}
