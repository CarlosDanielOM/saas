import { manageOverlayToken, readOverlayToken, rememberOverlayToken, storedOverlayToken, type OverlayTokenStore } from '../utils/overlay-token.js';
import { createHash } from 'node:crypto';
import { Schema, model } from 'mongoose';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import * as domain from './model.js';
import type { State } from './model.js';
import { parse } from '../utils/ast_parser/parser.js';
import type { DrawActor, WinnerAction } from './action-model.js';

interface Receipt { key: string; fingerprint: string; result: string; at: number }
interface Stored { _id: string; revision: number; state: State; tokenHash: string | null; overlayToken?: { iv: string; content: string } | null; dueAt: number | null; receipts: Receipt[]; actions: WinnerAction[]; actionDueAt: number | null }
const schema = new Schema<Stored>({
  actions: { type: [new Schema<WinnerAction>({ drawId: String, rouletteId: String, itemId: String, label: String, source: String, dueAt: Number, status: String, actor: Schema.Types.Mixed, startedAt: Number, finishedAt: Number }, { _id: false })], default: [] }, actionDueAt: { type: Number, default: null },
  _id: String, revision: { type: Number, required: true }, state: { type: Schema.Types.Mixed, required: true },
  tokenHash: { type: String, default: null }, overlayToken: { type: Schema.Types.Mixed, select: false }, dueAt: { type: Number, default: null }, receipts: { type: [new Schema<Receipt>({ key: String, fingerprint: String, result: String, at: Number }, { _id: false })], default: [] },
}, { versionKey: false, collection: 'roulette_channels' });
schema.index({ dueAt: 1 });
schema.index({ actionDueAt: 1 });
export const RouletteChannel = model<Stored>('RouletteChannel', schema);
export type Operation = 'create' | 'configure' | 'delete' | 'add' | 'update' | 'remove' | 'shuffle' | 'switch' | 'show' | 'hide' | 'start';
export interface Action { operation: Operation; roulette?: string; itemId?: string; data?: Record<string, unknown> }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const actionDue = (actions: WinnerAction[]) => { const pending = actions.filter(a => a.status === 'pending'); return pending.length ? Math.min(...pending.map(a => a.dueAt)) : null; };
const actionRuns = (actions: WinnerAction[] = []) => actions.slice(-100).map(({ drawId, status }) => ({ drawId, status }));
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
export async function execute(channelId: string, action: Action, requestKey?: string, expectedRevision?: number, actor?: DrawActor) {
  if ((action.operation === 'add' || action.operation === 'update') && action.data?.action !== undefined) {
    const source = domain.actionSource(action.data.action);
    if (source && parse(source).error) domain.fail('invalid_action', 'Invalid AST syntax in item action');
  }
  if (actor && (typeof actor.userId !== 'string' || typeof actor.userLogin !== 'string' || typeof actor.userDisplayName !== 'string'
    || actor.userId.length > 100 || actor.userLogin.length > 100 || actor.userDisplayName.length > 120 || (actor.argument?.length ?? 0) > 2000)) domain.fail('invalid', 'Invalid draw actor');
  if (requestKey !== undefined) domain.text(requestKey, 'Idempotency-Key', 128);
  if (expectedRevision !== undefined) domain.integer(expectedRevision, 'revision', 0);
  const fingerprint = hash(JSON.stringify(actor ? { ...action, actor } : action)); const receiptKey = requestKey ? hash(requestKey) : null;
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
    const actions = doc.actions ?? [];
    if (action.operation === 'start') {
      const draw = doc.state.draw!;
      const winner = domain.find(doc.state, draw.rouletteId).items.find(i => i.id === draw.winner.itemId)!;
      if (winner.action) {
        if (actions.filter(a => a.status === 'pending' || a.status === 'running').length >= 100) domain.fail('capacity', 'Too many pending item actions');
        actions.push({ drawId: draw.id, rouletteId: draw.rouletteId, itemId: winner.id, label: winner.label,
          source: winner.action, dueAt: draw.endsAt, status: 'pending', ...(actor ? { actor } : {}) });
      }
    }
    const retained = actions.filter(a => a.status === 'pending' || a.status === 'running');
    const recent = actions.filter(a => a.status !== 'pending' && a.status !== 'running').slice(-100);
    const savedActions = [...recent, ...retained];
    const aliases = doc.state.roulettes.map(r => r.alias);
    if (new Set(aliases).size !== aliases.length || doc.state.roulettes.some(r => aliases.includes(r.id))) domain.fail('alias_conflict', 'Alias already exists in this channel', 409);
    if (Buffer.byteLength(JSON.stringify(doc.state)) > 4 * 1024 * 1024) domain.fail('capacity', 'Channel roulette storage limit reached');
    const receipts = doc.receipts.filter(r => now - r.at < 86400000);
    if (receiptKey) receipts.push({ key: receiptKey, fingerprint, result, at: now });
    const saved = await RouletteChannel.updateOne({ _id: channelId, revision: doc.revision }, {
      $set: { actions: savedActions, actionDueAt: actionDue(savedActions), state: doc.state, dueAt: due(doc.state), receipts: receipts.slice(-200) }, $inc: { revision: 1 },
    });
    if (saved.modifiedCount) return { revision: doc.revision + 1, result, replayed: false };
  }
  return domain.fail('busy', 'Roulette is busy; retry with the same idempotency key', 409);
}
export async function snapshot(channelId: string) {
  for (let retry = 0; retry < 20; retry++) {
    const doc = await load(channelId);
    if (!domain.settle(doc.state, Date.now())) return { revision: doc.revision, serverTime: Date.now(), ...doc.state, actionRuns: actionRuns(doc.actions) };
    const saved = await RouletteChannel.updateOne({ _id: channelId, revision: doc.revision }, {
      $set: { state: doc.state, dueAt: due(doc.state) }, $inc: { revision: 1 },
    });
    if (saved.modifiedCount) return { revision: doc.revision + 1, serverTime: Date.now(), ...doc.state, actionRuns: actionRuns(doc.actions) };
  }
  return domain.fail('busy', 'Roulette is busy', 409);
}
function overlayTokenStore(id: string): OverlayTokenStore {
  return {
    read: async () => { await load(id); return (await RouletteChannel.findById(id).select('tokenHash +overlayToken').lean())!; },
    save: async (expectedHash, token, replace) => {
      const result = await RouletteChannel.updateOne({ _id: id, tokenHash: expectedHash }, { $set: storedOverlayToken(token), ...(replace ? { $inc: { revision: 1 } } : {}) });
      return result.matchedCount === 1;
    },
  };
}
export async function overlayTokenState(id: string) { return readOverlayToken(overlayTokenStore(id)); }
export async function updateOverlayToken(id: string, input: unknown) {
  const result = await manageOverlayToken(overlayTokenStore(id), input, domain.fail);
  return result;
}
// Internal callers retain explicit rotation semantics; HTTP creation uses updateOverlayToken.
export async function rotateToken(id: string): Promise<string> {
  const current = await overlayTokenState(id);
  return (await updateOverlayToken(id, { rotate: true, version: current.version })).token!;
}
export async function authorizeOverlay(id: string, token: unknown): Promise<boolean> {
  if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return false;
  const allowed = !!await RouletteChannel.exists({ _id: channel(id), tokenHash: hash(token) });
  if (allowed) await rememberOverlayToken(overlayTokenStore(id), token).catch(() => { /* Recovery must not interrupt an existing OBS source. */ });
  return allowed;
}

export async function overlaySnapshot(channelId: string) {
  const s = await snapshot(channelId);
  const active = s.roulettes.find(r => r.id === s.activeId);
  // OBS tokens can view the display, never the broadcaster's executable scripts.
  const roulette = active ? { ...active, items: active.items.map(({ action: _action, ...item }) => item) } : null;
  return { revision: s.revision, serverTime: s.serverTime, visible: s.visible, roulette, draw: s.draw, hideAt: s.hideAt };
}
/** Poll only indexed deadlines; snapshots also settle lazily after downtime. */
export async function settleDue(): Promise<void> {
  await getMongoDBConnection('roulette-completion');
  const rows = await RouletteChannel.find({ dueAt: { $ne: null, $lte: Date.now() } }, { _id: 1 }).limit(100).lean();
  for (const row of rows) await snapshot(row._id);
}
