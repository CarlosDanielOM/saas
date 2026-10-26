import type { RedisClientType } from 'redis';
import type { PetRequestRecord } from '../schemas/pet_runtime.schema.js';

/**
 * Pet requests that share the normal TTS queue ("TTS lane"). Producers add one
 * Redis TTS queue item that points at a durable PetRequest; when the TTS queue
 * reaches it, the API pet runtime speaks it and the queue waits for its end.
 */
export interface PetLaneItem { requestId: string; ownerId: string; operation: 'talk' | 'ask' }
export interface PetLaneStart {
    channelId: string; speechId: string; item: PetLaneItem;
    /** True once a TTS control (skip/clear/refresh) or newer item owns the queue. */
    cancelled: () => boolean;
}
/** `done` resolves once with the terminal reason; it is never rejected. */
export type PetLaneTurn = { done: Promise<string> } | null;
interface Bridge {
    start(input: PetLaneStart): Promise<PetLaneTurn>;
    end(item: PetLaneItem, reason: string): Promise<void>;
    terminal(request: PetRequestRecord): void;
}
let bridge: Bridge | undefined;
export function registerPetLaneBridge(value?: Bridge) { bridge = value; }
/** Without the API runtime, a lane item cannot play: the queue skips it. */
export const startPetLaneTurn = (input: PetLaneStart) => bridge?.start(input) ?? Promise.resolve(null);
export const endPetLaneTurn = (item: PetLaneItem, reason: string) => bridge?.end(item, reason) ?? Promise.resolve();
export const petLaneTerminal = (request: PetRequestRecord) => bridge?.terminal(request);

export function petLaneItem(payload: unknown): PetLaneItem | null {
    const pet = payload && typeof payload === 'object' ? (payload as { pet?: unknown }).pet : undefined;
    if (!pet || typeof pet !== 'object') return null;
    const { requestId, ownerId, operation } = pet as Record<string, unknown>;
    if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId) || typeof ownerId !== 'string' || !/^[a-f0-9]{24}$/i.test(ownerId)
        || (operation !== 'talk' && operation !== 'ask')) return null;
    return { requestId, ownerId, operation };
}

/** Same Redis layout and stream-session tagging as normal TTS enqueue. */
export async function enqueuePetLaneItem(cache: RedisClientType, input: { channelId: string; speechId: string; timestamp: number; text: string; item: PetLaneItem }) {
    const { enqueueTtsSession } = await import('../utils/tts/tts_session.util.js');
    const payload = { channelID: input.channelId, source: 'ast', mode: 'speak', provider: 'piper', text: input.text.slice(0, 500),
        language: 'en', voice: '', speechID: input.speechId, timestamp: input.timestamp, pet: input.item };
    await enqueueTtsSession(cache, input.channelId, input.speechId, input.timestamp, JSON.stringify(payload));
}
export async function ttsQueueLength(cache: RedisClientType, channelId: string) {
    return cache.zCard(`twitch:${channelId}:tts:queue`);
}
