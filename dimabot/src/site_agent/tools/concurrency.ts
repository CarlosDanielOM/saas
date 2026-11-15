/**
 * Per-connection limit on MCP tool calls running at once (in this API process). AI apps run tool calls in
 * parallel, as separate HTTP requests or as a JSON-RPC batch; calls past the limit wait their turn in arrival
 * order instead of failing, and only a long queue or a long wait is refused. Free tools count too: they still
 * use the database, the docs search and the command tester.
 */

export const MCP_CALLS_AT_ONCE = 12;
/** Calls that may wait behind the running ones (per connection). */
export const MCP_CALLS_QUEUED = 48;
/** Longest wait for a turn before the call is refused. */
export const MCP_CALL_WAIT_MS = 30_000;

interface Waiter { resolve: (release: () => void) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; onAbort?: () => void; signal?: AbortSignal }
interface Lane { running: number; waiting: Waiter[] }

const lanes = new Map<string, Lane>();

export class CallSlotError extends Error {
    constructor(readonly reason: 'queue_full' | 'timeout' | 'aborted') { super(reason); }
}

function releaser(key: string, lane: Lane): () => void {
    let done = false;
    return () => {
        if (done) return;
        done = true;
        const next = lane.waiting.shift();
        if (next) {
            clearTimeout(next.timer);
            if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
            next.resolve(releaser(key, lane));
            return;
        }
        lane.running--;
        if (lane.running === 0) lanes.delete(key);
    };
}

/**
 * Waits for a free slot on `key` (the OAuth session) and resolves with its release function, which must be
 * called exactly once when the call ends (extra calls are ignored). Rejects with CallSlotError.
 */
export function acquireCallSlot(key: string, signal?: AbortSignal, limits = { atOnce: MCP_CALLS_AT_ONCE, queued: MCP_CALLS_QUEUED, waitMs: MCP_CALL_WAIT_MS }): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new CallSlotError('aborted'));
    let lane = lanes.get(key);
    if (!lane) { lane = { running: 0, waiting: [] }; lanes.set(key, lane); }
    if (lane.running < limits.atOnce) {
        lane.running++;
        return Promise.resolve(releaser(key, lane));
    }
    if (lane.waiting.length >= limits.queued) return Promise.reject(new CallSlotError('queue_full'));
    const current = lane;
    return new Promise((resolve, reject) => {
        const waiter: Waiter = {
            resolve, reject, signal,
            timer: setTimeout(() => leave(new CallSlotError('timeout')), limits.waitMs),
        };
        function leave(error: CallSlotError) {
            const index = current.waiting.indexOf(waiter);
            if (index === -1) return;
            current.waiting.splice(index, 1);
            clearTimeout(waiter.timer);
            if (waiter.onAbort) signal?.removeEventListener('abort', waiter.onAbort);
            reject(error);
        }
        if (signal) {
            waiter.onAbort = () => leave(new CallSlotError('aborted'));
            signal.addEventListener('abort', waiter.onAbort, { once: true });
        }
        current.waiting.push(waiter);
    });
}

/** Test helper: running and waiting calls for a key. */
export function callSlotState(key: string): { running: number; waiting: number } {
    const lane = lanes.get(key);
    return { running: lane?.running ?? 0, waiting: lane?.waiting.length ?? 0 };
}
