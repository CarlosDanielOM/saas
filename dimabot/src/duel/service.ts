import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Schema, model } from 'mongoose';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { getDragonflyClient } from '../utils/databases/dragonfly.database.js';
import { requirePremium, hasPremium } from '../widgets/service.js';
import { fail, integer, text } from '../roulette/model.js';
import { defaultSettings, settings, createRun, nextDeadline, type DuelSettings, type DuelChallenge, type DuelRun, type DuelSide } from './model.js';

interface Receipt { key: string; fingerprint: string; at: number }
export interface DuelDocument { _id: string; revision: number; settings: DuelSettings; challenge: DuelChallenge | null; run: DuelRun | null; tokenHash: string | null; dueAt: number | null; leaseUntil: number; receipts: Receipt[] }
const schema = new Schema<DuelDocument>({ _id: String, revision: { type: Number, default: 0 }, settings: { type: Schema.Types.Mixed, required: true }, challenge: { type: Schema.Types.Mixed, default: null }, run: { type: Schema.Types.Mixed, default: null }, tokenHash: { type: String, default: null }, dueAt: { type: Number, default: null }, leaseUntil: { type: Number, default: 0 }, receipts: { type: [new Schema<Receipt>({ key: String, fingerprint: String, at: Number }, { _id: false })], default: [] } }, { versionKey: false, collection: 'duel_widgets' });
schema.index({ dueAt: 1 });
export const DuelChannel = model<DuelDocument>('DuelWidget', schema);
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const presenceKey = (channel: string) => `widgets:duel:${channel}:connected`;
export function channelId(id: string): string { if (!/^[0-9]{1,30}$/.test(id)) fail('invalid', 'Invalid channel ID'); return id; }
export async function loadDuel(id: string): Promise<DuelDocument> {
  channelId(id); await getMongoDBConnection('duel-widget');
  let doc = await DuelChannel.findById(id).lean();
  if (!doc) {
    try { await DuelChannel.create({ _id: id, settings: defaultSettings() }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    doc = await DuelChannel.findById(id).lean();
  }
  return doc!;
}
export async function overlayActive(doc: DuelDocument): Promise<boolean> {
  if (!doc.settings.enabled || !doc.tokenHash) return false;
  try {
    const raw = await (await getDragonflyClient('duel-presence')).get(presenceKey(doc._id));
    if (!raw) return false;
    const value = JSON.parse(raw) as { hash?: unknown; at?: unknown };
    const now = Date.now();
    return value.hash === doc.tokenHash && typeof value.at === 'number' && value.at <= now && now - value.at < 5000;
  } catch { return false; } // A stale/unavailable overlay always falls back to chat.
}
export async function duelSnapshot(id: string) {
  const doc = await loadDuel(id), now = Date.now();
  const run = doc.run;
  return { revision: doc.revision, settings: doc.settings, serverTime: now, connected: await overlayActive(doc),
    challenge: doc.challenge && doc.challenge.expiresAt > now ? doc.challenge : null,
    run: run ? { id: run.id, challenger: run.challenger, opponent: run.opponent, winner: run.winner, fighters: run.fighters, turns: run.turns, enraged: run.enraged ?? null, mode: run.mode, startedAt: run.startedAt, endsAt: run.endsAt, completedAt: run.completedAt, announcementError: run.announcementError, timeoutError: run.timeoutError } : null };
}
export async function configureDuel(id: string, input: unknown, revision: number, key: string): Promise<void> {
  await requirePremium(id); integer(revision, 'If-Match', 0); text(key, 'Idempotency-Key', 128);
  const config = settings(input), fingerprint = tokenHash(JSON.stringify(config)), receiptKey = tokenHash(key), doc = await loadDuel(id), now = Date.now();
  const previous = doc.receipts.find(receipt => receipt.key === receiptKey && now - receipt.at < 86400000);
  if (previous) { if (previous.fingerprint !== fingerprint) fail('idempotency_conflict', 'Key already used for different settings', 409); return; }
  if (revision !== doc.revision) fail('revision_conflict', 'Duel changed; refresh before saving', 409);
  const saved = await DuelChannel.updateOne({ _id: id, revision }, { $set: { settings: config, receipts: [...doc.receipts.filter(receipt => now - receipt.at < 86400000), { key: receiptKey, fingerprint, at: now }].slice(-200) }, $inc: { revision: 1 } }, { writeConcern: { w: 1, j: true } });
  if (!saved.modifiedCount) fail('revision_conflict', 'Duel changed; refresh before saving', 409);
}
export async function rotateDuelToken(id: string): Promise<string> {
  await requirePremium(id); await loadDuel(id);
  const token = randomBytes(32).toString('base64url');
  await DuelChannel.updateOne({ _id: id }, { $set: { tokenHash: tokenHash(token) }, $inc: { revision: 1 } });
  await (await getDragonflyClient('duel-token')).del(presenceKey(id));
  return token;
}
export async function authorizeDuelOverlay(id: string, token: unknown): Promise<boolean> {
  if (!/^[0-9]{1,30}$/.test(id) || typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return false;
  return await hasPremium(id) && !!await DuelChannel.exists({ _id: id, tokenHash: tokenHash(token) });
}
export async function challengeDuel(id: string, challenger: string, opponent: string, enraged: DuelSide | null = null): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const doc = await loadDuel(id), now = Date.now();
    if (doc.run && doc.run.completedAt === null || doc.challenge && doc.challenge.expiresAt > now) fail('busy', 'A duel is already waiting or fighting in this channel', 409);
    const overlay = await overlayActive(doc);
    const challenge: DuelChallenge = { id: randomUUID(), challenger, opponent, expiresAt: now + 180000, enraged };
    const saved = await DuelChannel.updateOne({ _id: id, revision: doc.revision }, { $set: { challenge, run: null, dueAt: challenge.expiresAt, leaseUntil: 0 }, $inc: { revision: 1 } });
    if (saved.modifiedCount) return overlay;
  }
  return fail('busy', 'Duel is busy; try again', 409);
}
/** Challenging the streamer skips the accept step: the enraged streamer always fights. */
export async function fightStreamer(id: string, challenger: string, streamer: string): Promise<DuelRun> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const doc = await loadDuel(id), now = Date.now();
    if (doc.run && doc.run.completedAt === null || doc.challenge && doc.challenge.expiresAt > now) fail('busy', 'A duel is already waiting or fighting in this channel', 409);
    const run = createRun({ id: randomUUID(), challenger, opponent: streamer, expiresAt: now, enraged: 'right' }, doc.settings, await overlayActive(doc), now);
    const saved = await DuelChannel.updateOne({ _id: id, revision: doc.revision }, { $set: { challenge: null, run, dueAt: nextDeadline(run), leaseUntil: 0 }, $inc: { revision: 1 } });
    if (saved.modifiedCount) return run;
  }
  return fail('busy', 'Duel is busy; try again', 409);
}
export async function acceptDuel(id: string, opponent: string): Promise<DuelRun> {
  const doc = await loadDuel(id), now = Date.now();
  if (!doc.challenge || doc.challenge.opponent !== opponent || doc.challenge.expiresAt <= now) return fail('missing', 'There is no duel challenge to accept', 409);
  const run = createRun(doc.challenge, doc.settings, await overlayActive(doc), now);
  const saved = await DuelChannel.updateOne({ _id: id, revision: doc.revision, 'challenge.id': doc.challenge.id }, { $set: { challenge: null, run, dueAt: nextDeadline(run), leaseUntil: 0 }, $inc: { revision: 1 } });
  if (!saved.modifiedCount) return fail('busy', 'This duel was already accepted or changed', 409);
  return run;
}
export async function declineDuel(id: string, opponent: string): Promise<{ challenger: string; overlay: boolean }> {
  const doc = await loadDuel(id);
  if (!doc.challenge || doc.challenge.opponent !== opponent || doc.challenge.expiresAt <= Date.now()) return fail('missing', 'There is no duel challenge to decline', 409);
  const result = { challenger: doc.challenge.challenger, overlay: await overlayActive(doc) };
  const saved = await DuelChannel.updateOne({ _id: id, revision: doc.revision }, { $set: { challenge: null, dueAt: null }, $inc: { revision: 1 } });
  if (!saved.modifiedCount) return fail('busy', 'This duel changed; try again', 409);
  return result;
}
