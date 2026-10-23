import type { PetRequestRecord } from '../schemas/pet_runtime.schema.js';
export interface ReadTtsTurnInput { channelId: string; speechId: string; cancelled: () => boolean; ended: (reason: string) => Promise<void> }
export interface ReadTtsInput extends ReadTtsTurnInput {
    channelId: string; speechId: string; file: string; mime: string; text: string; holdMs?: number;
    cancelled: () => boolean; ended: (reason: string) => Promise<void>; attemptId?: string;
    analysis?: { inspected?: boolean; durationMs?: number; enveloped?: boolean; envelope?: { stepMs: number; values: number[] } };
}
export interface ReadTtsRoute {
    audio: 'pet' | 'overlay' | 'cancelled' | 'waiting'; durationMs: number;
    /** Preparation cannot expose audio. The queue claims its current attempt at this boundary. */
    emit?: (beforeEmit: () => boolean) => Promise<boolean>;
    fallback?: () => Promise<ReadTtsRoute>;
}
interface Bridge {
    configured?(channelId: string): Promise<boolean>;
    owns?(channelId: string, speechId?: string): boolean;
    current?(channelId: string, speechId: string, minimumHoldMs?: number): boolean;
    protect?(channelId: string, speechId: string, holdMs: number): Promise<boolean>;
    reserve?(input: ReadTtsTurnInput): Promise<boolean>;
    resume?(channelId: string): Promise<void>;
    available(channelId: string): Promise<boolean>;
    prepare(input: ReadTtsInput): Promise<ReadTtsRoute | null>;
    release(channelId: string, speechId: string): Promise<void>;
    park?(channelId: string, speechId: string): Promise<void>;
    owners?(): string[];
    observe?(runtime: { _id: string; generation: number; activeRequestId: string | null; notBefore: Date; lease?: { leaseId: string } | null }): void;
    report(channelId: string, speechId: string, phase: string, position: number): Promise<void>;
    terminal(request: PetRequestRecord): Promise<void>;
    invalidated(ownerId: string, reason?: string): Promise<void>;
}
let bridge: Bridge | undefined;
export function registerReadTtsBridge(value?: Bridge) { bridge = value; }
export const isReadTtsConfigured = (channel: string) => bridge?.configured?.(channel) ?? Promise.resolve(false);
export const hasReadTtsTurn = (channel: string, speech?: string) => bridge?.owns?.(channel, speech) ?? false;
export const readTtsTurnCurrent = (channel: string, speech: string, minimumHoldMs = 0) => bridge?.current?.(channel, speech, minimumHoldMs) ?? true;
export const protectReadTtsTurn = (channel: string, speech: string, holdMs: number) => bridge?.protect?.(channel, speech, holdMs) ?? Promise.resolve(true);
export const reserveReadTts = (input: ReadTtsTurnInput) => bridge?.reserve?.(input) ?? Promise.resolve(true);
export const resumeReadTts = (channel: string) => bridge?.resume?.(channel) ?? Promise.resolve();
export const readTtsAvailable = (channel: string) => bridge?.available(channel) ?? Promise.resolve(false);
export const prepareReadTts = (input: ReadTtsInput) => bridge?.prepare(input) ?? Promise.resolve(null);
export const releaseReadTts = (channel: string, speech: string) => bridge?.release(channel, speech) ?? Promise.resolve();
export const parkReadTts = (channel: string, speech: string) => bridge?.park?.(channel, speech) ?? releaseReadTts(channel, speech);
export const readTtsOwners = () => bridge?.owners?.() ?? [];
export const observeReadTtsRuntime = (runtime: Parameters<NonNullable<Bridge['observe']>>[0]) => bridge?.observe?.(runtime);
export const reportReadTts = (channel: string, speech: string, phase: string, position: number) => bridge?.report(channel, speech, phase, position) ?? Promise.resolve();
export const readTtsTerminal = (request: PetRequestRecord) => bridge?.terminal(request) ?? Promise.resolve();
export const invalidateReadTts = (owner: string, reason?: string) => bridge?.invalidated(owner, reason) ?? Promise.resolve();

const pendingResumes = new Set<string>();
/** The socket handler returns/queues its lease ACK before this macrotask can run. */
export function scheduleReadTtsResume(channel: string) {
    if (pendingResumes.has(channel)) return;
    pendingResumes.add(channel);
    setImmediate(() => { pendingResumes.delete(channel); void resumeReadTts(channel).catch(() => {}); });
}
