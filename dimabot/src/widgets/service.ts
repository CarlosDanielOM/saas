import { createHash, randomBytes } from 'node:crypto';
import { Schema, model } from 'mongoose';
import Users from '../schemas/users.schema.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { getPoll } from '../functions/polls/get.poll.js';
import * as domain from './model.js';
import type { State } from './model.js';

interface Receipt { key: string; fingerprint: string; at: number }
interface Stored { _id: string; revision: number; state: State; tokenHash: string | null; dueAt: number | null; receipts: Receipt[] }
const schema = new Schema<Stored>({ _id: String, revision: { type: Number, required: true }, state: { type: Schema.Types.Mixed, required: true }, tokenHash: { type: String, default: null }, dueAt: { type: Number, default: null }, receipts: { type: [new Schema<Receipt>({ key: String, fingerprint: String, at: Number }, { _id: false })], default: [] } }, { versionKey: false, collection: 'widget_channels' });
schema.index({ dueAt: 1 });
export const WidgetChannel = model<Stored>('WidgetChannel', schema);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function channel(id: string): string { if (!/^[0-9]{1,30}$/.test(id)) domain.fail('invalid', 'Invalid channel ID'); return id; }
export async function hasPro(id: string): Promise<boolean> {
  channel(id); await getMongoDBConnection('widget-entitlement');
  return !!await Users.exists({ accounts: { $elemMatch: { type: 'twitch', id } }, plan_tier: 'pro' });
}
export async function requirePro(id: string): Promise<void> { if (!await hasPro(id)) domain.fail('pro_required', 'Widgets Alpha requires Pro', 403); }
async function load(id: string): Promise<Stored> {
  channel(id); await getMongoDBConnection('widgets');
  let doc = await WidgetChannel.findById(id).lean();
  if (!doc) {
    try { await WidgetChannel.create({ _id: id, revision: 0, state: domain.initial(), receipts: [] }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    doc = await WidgetChannel.findById(id).lean();
  }
  return doc!;
}
export type Action = 'select' | 'configure' | 'start' | 'show' | 'hide' | 'reset' | 'retry-poll';
export async function execute(id: string, action: Action, body: unknown, key: string, revision: number) {
  await requirePro(id);
  domain.text(key, 'Idempotency-Key', 128); domain.integer(revision, 'If-Match', 0);
  const data = domain.object(body), fingerprint = hash(JSON.stringify({ action, data })), receiptKey = hash(key);
  for (let n = 0; n < 20; n++) {
    const doc = await load(id), now = Date.now();
    const receipt = doc.receipts.find(r => r.key === receiptKey && now - r.at < 86400000);
    if (receipt) { if (receipt.fingerprint !== fingerprint) domain.fail('idempotency_conflict', 'Key already used for a different action', 409); return { replayed: true }; }
    if (revision !== doc.revision) domain.fail('revision_conflict', 'Widget changed; refresh before trying again', 409);
    const state = doc.state;
    if (action !== 'select' && action !== 'configure' && Object.keys(data).length) domain.fail('invalid', 'This action does not accept settings');
    switch (action) {
      case 'select':
        domain.idle(state);
        if (Object.keys(data).some(k => k !== 'packId')) domain.fail('invalid', 'Unknown field');
        state.packId = domain.pack(domain.text(data.packId, 'packId')).id; state.phase = 'idle'; state.run = null; state.nextAt = null; break;
      case 'configure': domain.idle(state); state.config = domain.config(data); break;
      case 'start': domain.start(state, now); break;
      case 'show': state.visible = true; break;
      case 'hide': state.visible = false; break;
      case 'reset':
        if (domain.active(state)) domain.fail('busy', 'Wait for the current challenge to finish', 409);
        state.phase = 'idle'; state.run = null; state.nextAt = null; break;
      case 'retry-poll':
        if (state.phase !== 'poll-error' || !state.run) domain.fail('invalid', 'No failed poll to retry');
        state.phase = 'poll-starting'; state.nextAt = now + 30000; state.run.error = null; break;
      default: domain.fail('invalid', 'Unknown widget action');
    }
    const receipts = [...doc.receipts.filter(r => now - r.at < 86400000), { key: receiptKey, fingerprint, at: now }].slice(-200);
    const saved = await WidgetChannel.updateOne({ _id: id, revision: doc.revision }, { $set: { state, dueAt: state.nextAt, receipts }, $inc: { revision: 1 } });
    if (saved.modifiedCount) {
      if (action === 'retry-poll') await launchPoll(id, state, true);
      return { replayed: false };
    }
  }
  return domain.fail('busy', 'Widget is busy; retry with the same key', 409);
}
async function savePoll(id: string, state: State, patch: Record<string, unknown>) {
  return WidgetChannel.updateOne({ _id: id, 'state.run.id': state.run!.id, 'state.phase': 'poll-starting' }, { $set: patch, $inc: { revision: 1 } });
}
async function launchPoll(id: string, state: State, create: boolean): Promise<void> {
  const run = state.run!;
  try {
    if (!await hasPro(id)) return;
    // Recover an accepted poll after response loss without ever automatically creating a second one.
    let poll = await getPoll(id, null, false);
    if ((poll.data?.title !== run.pollTitle || poll.data.status === 'TERMINATED') && create) {
      const { parseSpecialCommands } = await import('../handlers/special_parser.handler.js');
      const label = state.config.language === 'es' ? 'Carta' : 'Card';
      const options = [1, 2, 3, 4, 5].map(n => `${label} ${n}`).join('/');
      const points = state.config.channelPointsVoting ? state.config.channelPointsPerVote : 0;
      const source = `$(start.poll ${JSON.stringify(`${run.pollTitle};${options};${state.config.pollSeconds};${points}`)})`;
      const result = await parseSpecialCommands(source, { channelID: id, scopeType: 'widgets', scopeName: state.packId, userPlan: 'pro', userLevel: 10, literalArguments: true });
      if (result.parsedText.trim()) throw new Error(result.parsedText.slice(0, 300));
      poll = await getPoll(id, null, false);
    }
    if (poll.error || !poll.data || poll.data.title !== run.pollTitle || poll.data.status === 'TERMINATED' || poll.data.choices.length !== 5) throw new Error('Could not confirm the widget poll. Check Twitch before retrying.');
    const now = Date.now();
    await savePoll(id, state, { 'state.phase': 'polling', 'state.run.pollId': poll.data.id, 'state.run.choiceIds': poll.data.choices.map(c => c.id), 'state.run.pollEndsAt': now + state.config.pollSeconds * 1000, 'state.run.error': null, 'state.nextAt': now, dueAt: now });
  } catch (error) {
    // Persist the failure; the broadcaster explicitly chooses whether to retry the AST effect.
    await savePoll(id, state, { 'state.phase': 'poll-error', 'state.run.error': error instanceof Error ? error.message : 'Poll failed', 'state.nextAt': null, dueAt: null });
  }
}
async function advance(id: string): Promise<void> {
  for (let n = 0; n < 10; n++) {
    const doc = await load(id), state = doc.state, now = Date.now();
    if (state.nextAt === null || state.nextAt > now) return;
    if (!await hasPro(id)) { await WidgetChannel.updateOne({ _id: id, revision: doc.revision }, { $set: { dueAt: now + 60000 } }); return; }
    let launch = false;
    if (state.phase === 'poll-starting') { await launchPoll(id, state, false); return; }
    if (state.phase === 'polling') {
      const result = await getPoll(id, state.run!.pollId, false);
      if (result.error || !result.data) { state.run!.error = 'Poll results temporarily unavailable'; state.nextAt = now + 5000; }
      else if (['COMPLETED', 'ARCHIVED'].includes(result.data.status)) {
        const votes = state.run!.choiceIds.map(choice => result.data!.choices.find(c => c.id === choice)?.votes ?? 0);
        if (result.data.id !== state.run!.pollId || state.run!.choiceIds.some(choice => !result.data!.choices.some(c => c.id === choice))) { state.phase = 'poll-error'; state.run!.error = 'Unexpected Twitch poll result. No card was revealed.'; state.nextAt = null; }
        else { state.run!.channelPointsVotes = state.run!.choiceIds.map(choice => result.data!.choices.find(c => c.id === choice)?.channelPointsVotes ?? 0); domain.reveal(state, votes, now); }
      } else if (result.data.status === 'TERMINATED') { state.phase = 'poll-error'; state.run!.error = 'The Twitch poll was canceled. No card was revealed.'; state.nextAt = null; }
      else { state.run!.votes = state.run!.choiceIds.map(choice => result.data!.choices.find(c => c.id === choice)?.votes ?? 0); state.run!.channelPointsVotes = state.run!.choiceIds.map(choice => result.data!.choices.find(c => c.id === choice)?.channelPointsVotes ?? 0); state.run!.error = null; state.nextAt = now + 3000; }
    } else {
      if (!domain.settle(state, now)) return;
      launch = (state as State).phase === 'poll-starting';
    }
    const saved = await WidgetChannel.updateOne({ _id: id, revision: doc.revision }, { $set: { state, dueAt: state.nextAt }, $inc: { revision: 1 } });
    if (saved.modifiedCount) { if (launch) await launchPoll(id, state, true); return; }
  }
}
export async function snapshot(id: string) {
  await advance(id);
  const doc = await load(id);
  return { revision: doc.revision, serverTime: Date.now(), ...domain.publicState(doc.state) };
}
export async function settleDue(): Promise<void> {
  await getMongoDBConnection('widget-completion');
  const rows = await WidgetChannel.find({ dueAt: { $ne: null, $lte: Date.now() } }, { _id: 1 }).sort({ dueAt: 1 }).limit(10).lean();
  for (const row of rows) await advance(row._id);
}
export async function rotateToken(id: string): Promise<string> {
  await requirePro(id); await load(id);
  const token = randomBytes(32).toString('base64url');
  await WidgetChannel.updateOne({ _id: id }, { $set: { tokenHash: hash(token) }, $inc: { revision: 1 } }); return token;
}
export async function authorizeOverlay(id: string, token: unknown): Promise<boolean> {
  if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token) || !/^[0-9]{1,30}$/.test(id)) return false;
  return await hasPro(id) && !!await WidgetChannel.exists({ _id: id, tokenHash: hash(token) });
}
