import type { ITtsUsagePending } from '../../schemas/tts_usage_pending.schema.js';

/**
 * The real provider cost of paid voice lines.
 *
 * Polar fields, as on every `ai_usage` event: `_cost.amount` and `cost` are what the provider charged us,
 * in cents (Polar's cost dashboards read `_cost`); `credits` is what the streamer pays. Voice credits are a
 * fixed price per character (`tts_usage.ts`) and never follow the provider's price or its promotions.
 *
 * OpenRouter's speech endpoint returns only the audio: no usage in the response, just an `x-generation-id`
 * header, and the charge appears at `GET /api/v1/generation?id=…` some 20-60 s later. So an OpenRouter line
 * takes its credits from the local balance at once, waits in `tts_usage_pending` (MongoDB), and the
 * `tts-usage` worker sends its one `ai_usage` event, which also writes the receipt, once the charge is
 * known. The row stays until Polar has the event, flushing the channel's durable queue after an outage. Fish's own API reports no charge and Piper runs on our host: those are sent at once, with the list
 * price below or zero.
 */

/**
 * List prices in USD per million UTF-8 bytes. Used for Fish's own API, which reports no charge, and for an
 * OpenRouter line whose charge could not be looked up in time. OpenRouter lines normally use the real
 * charge; update these when a provider changes its list price.
 */
export const TTS_LIST_PRICE_USD_PER_MILLION_BYTES: Readonly<Record<string, number>> = {
    'fish-audio/drama-3': 10, // OpenRouter, Fish Audio provider
    's2.1-pro': 15, // Fish Audio API
    'hexgrad/kokoro-82m': 0.62 // OpenRouter, DeepInfra only
};
const PROVIDER_LIST_PRICE: Readonly<Record<PaidTtsProvider, number>> = { fish: 15, kokoro: 0.62 };

/** OpenRouter records a speech generation some 20-60 s after the call. */
export const FIRST_LOOKUP_DELAY_MS = 30_000;
export const LOOKUP_RETRY_MS = 20_000;
/** After this the list price is used, so a lost generation never holds the usage back for long. */
export const LOOKUP_GIVE_UP_MS = 15 * 60_000;
export const DELIVERY_RETRY_MS = 60_000;
/** A claimed row is skipped by other passes this long; a worker that dies mid-row retries it after. */
export const CLAIM_LEASE_MS = 2 * 60_000;

export type PaidTtsProvider = 'fish' | 'kokoro';

/** USD, rounded to 1e-10 so tiny lines keep their digits without float noise. */
export function roundUsd(value: number): number {
    return Math.round(value * 1e10) / 1e10;
}

export function listPriceCostUsd(provider: PaidTtsProvider, backend: string, bytes: number): number {
    const perMillion = TTS_LIST_PRICE_USD_PER_MILLION_BYTES[backend] ?? PROVIDER_LIST_PRICE[provider];
    return roundUsd(Math.max(0, bytes) * perMillion / 1_000_000);
}

export type GenerationLookup =
    | { status: 'found'; costUsd: number }
    | { status: 'pending' }
    | { status: 'failed'; message: string };

/** Looks up an OpenRouter generation's charge. 404 means OpenRouter has not recorded it yet. */
export async function lookupOpenRouterGeneration(
    generationId: string,
    options: { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<GenerationLookup> {
    const apiKey = (options.apiKey ?? process.env.OPENROUTER_API_KEY)?.trim();
    if (!apiKey) return { status: 'failed', message: 'OpenRouter API key is not configured' };
    try {
        const response = await (options.fetchImpl ?? fetch)(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(options.timeoutMs ?? 5_000)
        });
        if (response.status === 404) {
            await response.body?.cancel();
            return { status: 'pending' };
        }
        if (!response.ok) {
            await response.body?.cancel();
            return { status: 'failed', message: `OpenRouter generation lookup failed (HTTP ${response.status})` };
        }
        const body = await response.json() as { data?: { total_cost?: unknown } };
        const cost = body?.data?.total_cost;
        return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
            ? { status: 'found', costUsd: roundUsd(cost) }
            : { status: 'failed', message: 'OpenRouter generation has no total_cost' };
    } catch (caught) {
        return { status: 'failed', message: caught instanceof Error ? caught.message : String(caught) };
    }
}

export type PendingTtsUsage = Pick<ITtsUsagePending, 'entryId' | 'channelID' | 'customerId' | 'provider' | 'backend'
    | 'generationId' | 'bytes' | 'characters' | 'credits' | 'usage' | 'occurredAt' | 'attempts' | 'queued'> & { id: string };

export interface ParkTtsUsageDependencies {
    /** Inserts the row; throws a duplicate-key error (code 11000) when the entry is already parked. */
    insert(row: Omit<ITtsUsagePending, 'lastError' | 'created_at' | 'updated_at'>): Promise<unknown>;
    /** Takes the credits from the local balance now; idempotent per entry (`recordAiCreditUsage`). */
    debit(channelID: string, credits: number, entryId: string): Promise<unknown>;
}

/**
 * Parks an OpenRouter line until its charge is known. Throws when it could not be stored; the caller then
 * sends the usage at once with the list price, so the credits are never lost.
 */
export async function parkTtsUsage(
    deps: ParkTtsUsageDependencies,
    input: Omit<PendingTtsUsage, 'id' | 'occurredAt' | 'attempts' | 'queued'>,
    now = new Date()
): Promise<void> {
    try {
        await deps.insert({ ...input, occurredAt: now, nextAttemptAt: new Date(now.getTime() + FIRST_LOOKUP_DELAY_MS), attempts: 0, queued: false });
    } catch (caught) {
        // A retried request (same entry) is already waiting.
        if ((caught as { code?: unknown })?.code !== 11000) throw caught;
    }
    // Idempotent per entry, so a retried request never pays twice.
    await deps.debit(input.channelID, input.credits, input.entryId);
}

export interface TtsUsageDeliveryDependencies {
    /** The next row due at `now`, claimed until `leaseUntil`; null when none is due. */
    claimDue(now: Date, leaseUntil: Date): Promise<PendingTtsUsage | null>;
    reschedule(id: string, at: Date, lastError: string | null): Promise<void>;
    /** Polar was down but the event is in the channel's durable queue: only a flush is left to do. */
    markQueued(id: string, at: Date, lastError: string | null): Promise<void>;
    remove(id: string): Promise<void>;
    lookupGeneration(generationId: string): Promise<GenerationLookup>;
    /** Sends the usage event with this provider cost. `recorded` once Polar has it; `queued` when it waits in the durable queue. */
    send(row: PendingTtsUsage, costUsd: number): Promise<{ recorded: boolean; queued?: boolean; message?: string }>;
    /** Flushes the channel's durable queue; `recorded` once everything queued before it is in Polar. */
    flush(row: PendingTtsUsage): Promise<{ recorded: boolean; message?: string }>;
    log(level: 'info' | 'error', message: string, details: Record<string, unknown>): Promise<void> | void;
    now(): number;
}

/** One bounded pass over due rows. Re-sending is safe: Polar dedupes by entry and the local debit is per entry. */
export async function runTtsUsagePass(deps: TtsUsageDeliveryDependencies, batchSize = 25): Promise<{ events: number; failed: boolean; more: boolean }> {
    let claimed = 0, sent = 0, fromProvider = 0, failed = false;
    while (claimed < batchSize) {
        const nowMs = deps.now();
        const row = await deps.claimDue(new Date(nowMs), new Date(nowMs + CLAIM_LEASE_MS));
        if (!row) break;
        claimed++;
        if (row.queued) {
            // The event (with its cost) already waits in the durable queue; nothing else flushes it if the
            // channel goes quiet, so keep flushing until Polar has it.
            const flushed = await deps.flush(row);
            if (flushed.recorded) {
                await deps.remove(row.id);
                sent++;
            } else {
                failed = true;
                await deps.reschedule(row.id, new Date(nowMs + DELIVERY_RETRY_MS), flushed.message ?? 'Polar flush failed');
            }
            continue;
        }
        const age = nowMs - row.occurredAt.getTime();
        const lookup = await deps.lookupGeneration(row.generationId);
        let costUsd: number;
        if (lookup.status === 'found') {
            costUsd = lookup.costUsd;
            fromProvider++;
        } else if (age < LOOKUP_GIVE_UP_MS) {
            if (lookup.status === 'failed') failed = true;
            await deps.reschedule(row.id, new Date(nowMs + LOOKUP_RETRY_MS), lookup.status === 'failed' ? lookup.message : null);
            continue;
        } else {
            costUsd = listPriceCostUsd(row.provider, row.backend, row.bytes);
            await deps.log('error', 'OpenRouter never reported this voice line; using the list price', {
                channelID: row.channelID, entryId: row.entryId, generationId: row.generationId, costUsd,
                reason: lookup.status === 'failed' ? lookup.message : 'generation not found'
            });
        }
        const delivery = await deps.send(row, costUsd);
        if (delivery.recorded) {
            await deps.remove(row.id);
            sent++;
        } else {
            failed = true;
            const retryAt = new Date(nowMs + DELIVERY_RETRY_MS), message = delivery.message ?? 'Polar ingest failed';
            // Queued: the event and its cost are fixed now; later passes only flush the queue.
            if (delivery.queued) await deps.markQueued(row.id, retryAt, message);
            else await deps.reschedule(row.id, retryAt, message);
            await deps.log('error', delivery.queued ? 'Polar unavailable; the voice usage waits in the durable queue' : 'Voice usage could not be sent to Polar; retrying', {
                channelID: row.channelID, entryId: row.entryId, attempts: row.attempts, error: delivery.message ?? null
            });
        }
    }
    if (sent > 0) await deps.log('info', 'Voice usage sent with provider cost', { count: sent, fromProvider });
    return { events: claimed, failed, more: claimed === batchSize };
}
