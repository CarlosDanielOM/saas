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
export type Operation = 'create' | 'configure' | 'delete' | 'clear' | 'add' | 'import' | 'update' | 'remove' | 'shuffle' | 'switch' | 'show' | 'hide' | 'start';
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
    case 'clear':
      // Like a replacing import: never empty a roulette under a spin; the old winner card goes too.
      domain.idle(state); r.items = []; r.order = [];
      if (state.activeId === r.id) { state.draw = null; state.hideAt = null; }
      return r.id;
    case 'add': return domain.add(r, data).id;
    case 'import': {
      // Replacing must not pull prizes out from under a spin; the old winner card goes too.
      if (data.replace === true) domain.idle(state);
      const count = domain.importItems(r, data);
      if (data.replace === true && state.activeId === r.id) { state.draw = null; state.hideAt = null; }
      return String(count);
    }
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
  const done = await commit(channelId, [action], requestKey, expectedRevision, actor);
  return { revision: done.revision, result: done.results[0], replayed: done.replayed };
}
/**
 * Several actions as ONE write: applied in order to the same state and saved under one revision, so
 * either all of them land or none (any refusal, or `expectedRevision` no longer current, writes
 * nothing). Returns each action's result, the revision the write produced and the state it saved
 * (callers that keep undo data use it instead of reading again, where another save may already
 * have landed). No idempotency key; spins can't be batched.
 */
export async function executeAll(channelId: string, actions: Action[], expectedRevision?: number): Promise<{ revision: number; results: string[]; state: State }> {
  if (!actions.length || actions.length > domain.IMPORT_LIMIT) domain.fail('invalid', `Give 1–${domain.IMPORT_LIMIT} roulette actions`);
  if (actions.some(a => a.operation === 'start')) domain.fail('invalid', 'A spin cannot be part of a batch');
  const done = await commit(channelId, actions, undefined, expectedRevision);
  return { revision: done.revision, results: done.results, state: done.state };
}
function checkSources(action: Action): void {
  if ((action.operation === 'add' || action.operation === 'update') && action.data?.action !== undefined) {
    const source = domain.actionSource(action.data.action);
    if (source && parse(source).error) domain.fail('invalid_action', 'Invalid AST syntax in item action');
  }
  if (action.operation === 'import' && Array.isArray(action.data?.items)) {
    action.data.items.forEach((entry: unknown, i: number) => {
      const source = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).action : undefined;
      if (typeof source === 'string' && source.trim() && source.length <= 8000 && parse(source.trim()).error)
        throw new domain.RouletteError('invalid_action', `Prize ${i + 1}: Invalid AST syntax in item action`, 400, i + 1);
    });
  }
}
async function commit(channelId: string, list: Action[], requestKey?: string, expectedRevision?: number, actor?: DrawActor) {
  list.forEach(checkSources);
  if (actor && (typeof actor.userId !== 'string' || typeof actor.userLogin !== 'string' || typeof actor.userDisplayName !== 'string'
    || actor.userId.length > 100 || actor.userLogin.length > 100 || actor.userDisplayName.length > 120 || (actor.argument?.length ?? 0) > 2000)) domain.fail('invalid', 'Invalid draw actor');
  if (requestKey !== undefined) domain.text(requestKey, 'Idempotency-Key', 128);
  if (expectedRevision !== undefined) domain.integer(expectedRevision, 'revision', 0);
  // Receipts (single actions only) fingerprint the action as before.
  const action = list[0];
  const fingerprint = hash(JSON.stringify(actor ? { ...action, actor } : action)); const receiptKey = requestKey ? hash(requestKey) : null;
  for (let retry = 0; retry < 20; retry++) {
    const doc = await load(channelId); const now = Date.now();
    const receipt = receiptKey && doc.receipts.find(r => r.key === receiptKey && now - r.at < 86400000);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) domain.fail('idempotency_conflict', 'Idempotency key was used for a different action', 409);
      return { revision: doc.revision, results: [receipt.result], replayed: true, state: doc.state };
    }
    if (expectedRevision !== undefined && expectedRevision !== doc.revision) domain.fail('revision_conflict', 'State changed; refresh before saving', 409);
    domain.settle(doc.state, now);
    const results = list.map(item => apply(doc.state, item, now));
    const result = results[0];
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
    if (saved.modifiedCount) return { revision: doc.revision + 1, results, replayed: false, state: doc.state };
  }
  return domain.fail('busy', 'Roulette is busy; retry with the same idempotency key', 409);
}
async function settled(channelId: string) {
  for (let retry = 0; retry < 20; retry++) {
    const doc = await load(channelId), now = Date.now();
    if (!domain.settle(doc.state, now)) return { doc, revision: doc.revision, changed: false, now };
    const saved = await RouletteChannel.updateOne({ _id: channelId, revision: doc.revision }, {
      $set: { state: doc.state, dueAt: due(doc.state) }, $inc: { revision: 1 },
    });
    if (saved.modifiedCount) return { doc, revision: doc.revision + 1, changed: true, now };
  }
  return domain.fail('busy', 'Roulette is busy', 409);
}
export async function snapshot(channelId: string) {
  const { doc, revision } = await settled(channelId);
  return { revision, serverTime: Date.now(), ...doc.state, actionRuns: actionRuns(doc.actions) };
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
export async function settleDue(): Promise<{ changed: number; fetched: number; ready: boolean }> {
  await getMongoDBConnection('roulette-completion');
  const dueNow = () => ({ dueAt: { $ne: null, $lte: Date.now() } });
  const rows = await RouletteChannel.find(dueNow(), { _id: 1 }).limit(100).lean();
  let changed = 0, blocked = false;
  for (const row of rows) {
    const result = await settled(row._id);
    if (result.changed) changed++;
    // Another writer settling it moves the deadline on; a stale deadline that cannot settle would be picked forever.
    else if (result.doc.dueAt !== null && result.doc.dueAt <= result.now) blocked = true;
  }
  // Ready means more deadlines are already due, whatever this pass fetched or changed.
  const ready = rows.length > 0 && !blocked && !!await RouletteChannel.exists(dueNow());
  return { changed, fetched: rows.length, ready };
}
