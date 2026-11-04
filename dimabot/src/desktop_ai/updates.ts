import type { FilterQuery, UpdateQuery, QueryOptions } from 'mongoose';
import { DesktopAiTurn, type DesktopTurn } from './schema.js';
import { PetRequest } from '../schemas/pet_runtime.schema.js';

export const TURN_STATUS_FEATURE = 'turn-status-v1';
export const BOT_AUDIO_DELIVERY_MS = 20_000;
export type TurnMetadata = Pick<DesktopTurn, '_id' | 'requestId' | 'ownerId' | 'clientId' | 'channelId' | 'sessionId' | 'target' | 'revision' | 'petRequestId'>;
export type TurnUpdate = { turn: TurnMetadata; revision: number };
const TURN_METADATA = '_id requestId ownerId clientId channelId sessionId target revision petRequestId';
type Listener = (update: TurnUpdate) => void;
const listeners = new Map<Listener, () => boolean>();
const pending = new Map<string, Promise<void>>();
const dirty = new Set<string>();

/** This is the same revision domain as the authoritative HTTP snapshot. */
export function turnWireRevision(revision: number, petVersion = 0): number {
    return (revision - 1) * 100_000 + 1 + Math.min(petVersion || 0, 99999);
}
export function subscribeTurnUpdates(listener: Listener, interested: () => boolean = () => true): () => void {
    listeners.set(listener, interested);
    return () => { listeners.delete(listener); };
}
/** Best-effort invalidation, never a dependency of committed work or playback.
 * Concurrent writes coalesce into a current committed snapshot, once per turn. */
export function notifyTurnUpdated(id: string): void {
    if (![...listeners.values()].some(interested => interested())) return;
    if (pending.has(id)) { dirty.add(id); return; }
    // Runtime admission is bounded; retain a hard bound even for recovery bursts.
    if (pending.size >= 128) return;
    const work = Promise.resolve().then(async () => {
        do {
            dirty.delete(id);
            const turn = await DesktopAiTurn.findById(id).select(TURN_METADATA).lean();
            if (!turn) return;
            const pet = turn.petRequestId ? await PetRequest.findOne({ _id: turn.petRequestId, ownerId: turn.ownerId }).select('version').lean() : null;
            publishTurnUpdate(turn, pet?.version);
        } while (dirty.has(id) && listeners.size);
    }).catch(() => { /* A lost hint is recovered by the HTTP polling fallback. */ }).finally(() => { pending.delete(id); dirty.delete(id); });
    pending.set(id, work);
}
function publishTurnUpdate(turn: TurnMetadata, petVersion = 0): void {
    const update = { turn, revision: turnWireRevision(turn.revision, petVersion) };
    for (const [listener, interested] of listeners) if (interested()) listener(update);
}
/** Pet owner wakes carry no request data. Read a bounded metadata projection and
 * its Pet versions in two shared queries, independent of the connected peer count.
 * Namespace delivery still validates the initiating identity and target scope. */
export async function refreshPetTurnUpdates(ownerId: string, sessionIds: string[]): Promise<void> {
    if (!sessionIds.length || ![...listeners.values()].some(interested => interested())) return;
    const turns = await DesktopAiTurn.find({ ownerId, sessionId: { $in: [...new Set(sessionIds)].slice(0, 1024) },
        target: 'pet', petRequestId: { $exists: true }, expiresAt: { $gt: new Date() } })
        .sort({ createdAt: -1 }).limit(64).select(TURN_METADATA).lean();
    if (!turns.length) return;
    const pets = await PetRequest.find({ ownerId, _id: { $in: turns.map(turn => turn.petRequestId!) } })
        .limit(64).select('_id version').lean();
    const versions = new Map(pets.map(pet => [pet._id, pet.version]));
    for (const turn of turns) publishTurnUpdate(turn, versions.get(turn.petRequestId!));
}
/** Write helpers only publish after a successful Mongo acknowledgement. No-op
 * compare-and-set losses cannot advertise a state that was never committed. */
function visibleChange(update: UpdateQuery<DesktopTurn>): boolean {
    return Object.keys(update.$set ?? {}).some(key => ['status', 'replyText', 'errorCode', 'petRequestId', 'speech.status', 'speech.errorCode'].includes(key));
}
export async function updateTurn(filter: FilterQuery<DesktopTurn>, update: UpdateQuery<DesktopTurn>) {
    const result = await DesktopAiTurn.updateOne(filter, update);
    if (result.modifiedCount && visibleChange(update) && typeof filter._id === 'string') notifyTurnUpdated(filter._id);
    return result;
}
export async function changeTurn(filter: FilterQuery<DesktopTurn>, update: UpdateQuery<DesktopTurn>, options: QueryOptions = { new: true }) {
    const result = await DesktopAiTurn.findOneAndUpdate(filter, update, options).lean();
    if (result && visibleChange(update)) notifyTurnUpdated(result._id);
    return result;
}
