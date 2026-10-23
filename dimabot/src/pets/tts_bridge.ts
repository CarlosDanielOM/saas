import type { PetRequestRecord } from '../schemas/pet_runtime.schema.js';
export interface ReadTtsTurnInput { channelId: string; speechId: string; cancelled: () => boolean; ended: (reason: string) => Promise<void> }
export interface ReadTtsInput extends ReadTtsTurnInput {
    channelId: string; speechId: string; file: string; mime: string; text: string;
    cancelled: () => boolean; ended: (reason: string) => Promise<void>;
}
export interface ReadTtsRoute { audio: 'pet' | 'overlay' | 'cancelled'; durationMs: number }
interface Bridge {
    reserve?(input: ReadTtsTurnInput): Promise<boolean>;
    resume?(channelId: string): Promise<void>;
    available(channelId: string): Promise<boolean>;
    prepare(input: ReadTtsInput): Promise<ReadTtsRoute | null>;
    release(channelId: string, speechId: string): Promise<void>;
    report(channelId: string, speechId: string, phase: string, position: number): Promise<void>;
    terminal(request: PetRequestRecord): Promise<void>;
    invalidated(ownerId: string): Promise<void>;
}
let bridge: Bridge | undefined;
export function registerReadTtsBridge(value?: Bridge) { bridge = value; }
export const reserveReadTts = (input: ReadTtsTurnInput) => bridge?.reserve?.(input) ?? Promise.resolve(true);
export const resumeReadTts = (channel: string) => bridge?.resume?.(channel) ?? Promise.resolve();
export const readTtsAvailable = (channel: string) => bridge?.available(channel) ?? Promise.resolve(false);
export const prepareReadTts = (input: ReadTtsInput) => bridge?.prepare(input) ?? Promise.resolve(null);
export const releaseReadTts = (channel: string, speech: string) => bridge?.release(channel, speech) ?? Promise.resolve();
export const reportReadTts = (channel: string, speech: string, phase: string, position: number) => bridge?.report(channel, speech, phase, position) ?? Promise.resolve();
export const readTtsTerminal = (request: PetRequestRecord) => bridge?.terminal(request) ?? Promise.resolve();
export const invalidateReadTts = (owner: string) => bridge?.invalidated(owner) ?? Promise.resolve();

const pendingResumes = new Set<string>();
/** The socket handler returns/queues its lease ACK before this macrotask can run. */
export function scheduleReadTtsResume(channel: string) {
    if (pendingResumes.has(channel)) return;
    pendingResumes.add(channel);
    setImmediate(() => { pendingResumes.delete(channel); void resumeReadTts(channel).catch(() => {}); });
}
