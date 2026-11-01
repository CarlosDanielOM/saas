/**
 * MiniMax client (Anthropic-compatible API).
 *
 * - Model: MiniMax-M3.1-Flash only (see constants.ts). It always thinks; `effort` sets how much.
 * - Every call streams under the hood, so long thinking never hits a non-streaming
 *   timeout. `minimaxChat` returns the final text; `minimaxChatStream` also hands out
 *   text as it arrives.
 * - No artificial output cap: `max_tokens` defaults to the model's own ceiling.
 * - The SDK retries connection errors, 429 and 5xx before the stream starts. Once text
 *   has started, nothing is retried (it would duplicate output).
 * - The API key is read from MINI_TOKEN_PLAN_API_KEY at call time and never logged.
 */
import Anthropic from '@anthropic-ai/sdk';
import { debug, error } from '../../logger.js';
import {
    MINIMAX_BASE_URL,
    MINIMAX_COST_PER_M_CACHE_READ,
    MINIMAX_COST_PER_M_INPUT,
    MINIMAX_COST_PER_M_OUTPUT,
    MINIMAX_MAX_OUTPUT_TOKENS,
    MINIMAX_MODEL,
} from '../constants.js';

export type MiniMaxEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Time allowed to receive the response headers (per attempt). */
const CONNECT_TIMEOUT_MS = 60_000;
/** Abort if the stream goes quiet this long (thinking deltas count as activity). */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

export type MiniMaxErrorKind =
    | 'config'        // key missing
    | 'aborted'       // caller cancelled (e.g. browser closed the tab)
    | 'timeout'       // no response / stream went quiet
    | 'rate_limited'  // 429 after retries
    | 'overloaded'    // 5xx / 529 after retries
    | 'bad_request'   // 4xx: our request was wrong
    | 'upstream';     // anything else

export class MiniMaxError extends Error {
    constructor(public readonly kind: MiniMaxErrorKind, message: string, public readonly status?: number) {
        super(message);
        this.name = 'MiniMaxError';
    }
}

export interface MiniMaxChatParams {
    messages: Anthropic.MessageParam[];
    /** A string, or text blocks (lets callers keep a stable prefix for MiniMax's cache). */
    system?: string | Anthropic.TextBlockParam[];
    effort?: MiniMaxEffort;
    /** Defaults to the model's ceiling. Thinking tokens count toward it. */
    maxTokens?: number;
    channelID?: string;
    signal?: AbortSignal;
    idleTimeoutMs?: number;
    /** Short label for logs, e.g. 'docs-assistant'. */
    feature?: string;
}

export interface MiniMaxChatResult {
    content: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    thinkingTokens: number;
    /** USD, computed from the token counts above. */
    cost: number;
    stopReason?: string;
    durationMs: number;
    model: string;
}

export interface MiniMaxStreamHandlers {
    onText?: (delta: string) => void;
    /** Called for each thinking delta; useful to show "thinking…" progress. */
    onThinking?: (delta: string) => void;
}

let client: Anthropic | null = null;
let clientKey: string | null = null;

function getClient(): Anthropic {
    const apiKey = process.env.MINI_TOKEN_PLAN_API_KEY?.trim();
    if (!apiKey) throw new MiniMaxError('config', 'MINI_TOKEN_PLAN_API_KEY is not set');
    if (!client || clientKey !== apiKey) {
        // MINIMAX_BASE_URL is only for isolated tests (fake server); production uses the constant.
        const baseURL = process.env.MINIMAX_BASE_URL || MINIMAX_BASE_URL;
        debug({ function: 'minimax.getClient', message: '[MiniMax] Initializing client', baseURL }, { destination: 'console' });
        client = new Anthropic({ baseURL, apiKey, timeout: CONNECT_TIMEOUT_MS, maxRetries: MAX_RETRIES });
        clientKey = apiKey;
    }
    return client;
}

export function calculateMiniMaxCost(inputTokens: number, outputTokens: number, cacheReadTokens = 0): number {
    return (inputTokens * MINIMAX_COST_PER_M_INPUT
        + cacheReadTokens * MINIMAX_COST_PER_M_CACHE_READ
        + outputTokens * MINIMAX_COST_PER_M_OUTPUT) / 1_000_000;
}

function classify(err: unknown, aborted: boolean, idle: boolean): MiniMaxError {
    if (err instanceof MiniMaxError) return err;
    if (idle) return new MiniMaxError('timeout', 'MiniMax stream went quiet');
    if (aborted) return new MiniMaxError('aborted', 'Request cancelled');
    if (err instanceof Anthropic.APIConnectionTimeoutError) return new MiniMaxError('timeout', 'MiniMax did not respond in time');
    if (err instanceof Anthropic.APIUserAbortError) return new MiniMaxError('aborted', 'Request cancelled');
    if (err instanceof Anthropic.APIError) {
        const status = err.status;
        if (status === 429) return new MiniMaxError('rate_limited', err.message, status);
        if (status && (status >= 500 || status === 529)) return new MiniMaxError('overloaded', err.message, status);
        if (status && status >= 400) return new MiniMaxError('bad_request', err.message, status);
        // Errors sent inside the stream (no HTTP status) — e.g. {"type":"overloaded_error"}.
        const type = (err.error as { error?: { type?: string } } | undefined)?.error?.type;
        if (type === 'overloaded_error') return new MiniMaxError('overloaded', err.message);
        if (type === 'rate_limit_error') return new MiniMaxError('rate_limited', err.message);
        return new MiniMaxError('upstream', err.message, status);
    }
    return new MiniMaxError('upstream', err instanceof Error ? err.message : String(err));
}

type Usage = Partial<Record<'input_tokens' | 'output_tokens' | 'cache_read_input_tokens', number | null>> & {
    output_tokens_details?: { thinking_tokens?: number };
};

/**
 * Stream a reply. Text arrives through `handlers.onText`; the promise resolves with
 * the full reply and usage once the model is done.
 */
export async function minimaxChatStream(params: MiniMaxChatParams, handlers: MiniMaxStreamHandlers = {}): Promise<MiniMaxChatResult> {
    const anthropic = getClient();
    const started = Date.now();
    const feature = params.feature ?? 'minimax';
    const messages = params.messages.filter((msg) => (msg.role as string) !== 'system');

    // One controller for caller cancellation and the idle watchdog.
    const controller = new AbortController();
    let idle = false;
    const onCallerAbort = () => controller.abort();
    if (params.signal?.aborted) controller.abort();
    params.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const idleMs = params.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    let idleTimer: NodeJS.Timeout | undefined;
    const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { idle = true; controller.abort(); }, idleMs);
    };

    debug({
        function: 'minimax.chatStream', message: '[MiniMax] Request', feature, channelID: params.channelID,
        model: MINIMAX_MODEL, effort: params.effort, messageCount: messages.length,
    }, { destination: 'console' });

    const usage: Usage = {};
    const mergeUsage = (next?: Usage | null) => {
        if (!next) return;
        for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens'] as const) {
            const value = next[key];
            if (typeof value === 'number' && value > 0) usage[key] = value;
        }
        if (next.output_tokens_details?.thinking_tokens) usage.output_tokens_details = next.output_tokens_details;
    };

    try {
        touch();
        const body = {
            model: MINIMAX_MODEL,
            messages,
            system: params.system,
            max_tokens: params.maxTokens ?? MINIMAX_MAX_OUTPUT_TOKENS,
            ...(params.effort ? { output_config: { effort: params.effort } } : {}),
        } as unknown as Anthropic.MessageStreamParams; // SDK types don't list 'xhigh' yet.

        const stream = anthropic.messages.stream(body, { signal: controller.signal });
        stream.on('streamEvent', (event) => {
            touch();
            if (event.type === 'message_start') mergeUsage(event.message.usage as Usage);
            else if (event.type === 'message_delta') mergeUsage(event.usage as Usage);
            else if (event.type === 'content_block_delta') {
                if (event.delta.type === 'text_delta') handlers.onText?.(event.delta.text);
                else if (event.delta.type === 'thinking_delta') handlers.onThinking?.(event.delta.thinking);
            }
        });
        // Settle as soon as we abort (cancel or idle), without waiting for the transport to notice.
        const abortedEarly = new Promise<never>((_, reject) => {
            const stop = () => reject(new Anthropic.APIUserAbortError());
            if (controller.signal.aborted) stop();
            else controller.signal.addEventListener('abort', stop, { once: true });
        });
        const message = await Promise.race([stream.finalMessage(), abortedEarly]);

        const content = message.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');
        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
        const result: MiniMaxChatResult = {
            content,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            thinkingTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
            cost: calculateMiniMaxCost(inputTokens, outputTokens, cacheReadTokens),
            stopReason: message.stop_reason ?? undefined,
            durationMs: Date.now() - started,
            model: MINIMAX_MODEL,
        };
        debug({
            function: 'minimax.chatStream', message: '[MiniMax] Done', feature, channelID: params.channelID,
            durationMs: result.durationMs, inputTokens, outputTokens, cacheReadTokens,
            thinkingTokens: result.thinkingTokens, cost: result.cost.toFixed(6), stopReason: result.stopReason,
        }, { destination: 'console' });
        return result;
    } catch (err) {
        const failure = classify(err, Boolean(params.signal?.aborted), idle);
        if (failure.kind !== 'aborted') {
            await error({
                function: 'minimax.chatStream', message: '[MiniMax] Request failed', feature, channelID: params.channelID,
                kind: failure.kind, status: failure.status, durationMs: Date.now() - started, error: failure.message,
            }, { channelId: params.channelID, destination: 'both' });
        }
        throw failure;
    } finally {
        clearTimeout(idleTimer);
        params.signal?.removeEventListener('abort', onCallerAbort);
    }
}

/** Same as `minimaxChatStream`, for callers that only need the final reply. */
export function minimaxChat(params: MiniMaxChatParams): Promise<MiniMaxChatResult> {
    return minimaxChatStream(params);
}

export { MINIMAX_MODEL };
