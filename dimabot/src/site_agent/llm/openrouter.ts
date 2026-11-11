/**
 * OpenRouter streaming client for the site agent (one model step per call).
 *
 * - Chat Completions with `stream: true`; text, reasoning summaries, merged `reasoning_details` and
 *   tool calls (assembled by index) come back in one `LlmStepResult`. Arguments stay raw JSON text.
 * - Retries (max 2) only before any SSE data arrived: network errors, 429, 502, 503. Never after.
 * - Timeouts: response headers (60 s) and silence between SSE lines (120 s; `:` comments count).
 * - Stop: aborting `req.signal` mid-stream resolves with `aborted: true` and the partial text;
 *   the cost is then looked up later with `reconcileGeneration` (no usage chunk on aborts).
 * - Key and base URL are read from the environment at call time. The key is never logged or
 *   put in error messages. `OPENROUTER_BASE_URL` exists for the isolated checks (fake server).
 */
import type { LlmErrorKind, LlmRequest, LlmStepResult, LlmStreamHandlers, LlmUsage, ToolCallRequest } from '../types.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const HEADERS_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [1_000, 3_000];
const MAX_RETRY_AFTER_MS = 10_000;
/** When to look a generation up after it ended (ms from the first lookup). 404 = not ready yet. */
export const RECONCILE_SCHEDULE_MS: readonly number[] = [5_000, 15_000, 45_000, 90_000];

export class LlmError extends Error {
    readonly kind: LlmErrorKind;
    readonly status?: number;
    /** Seconds the provider asked us to wait (429/503 Retry-After), when given. */
    readonly retryAfter?: number;
    /** Set when the stream had started a generation: its usage must still be reconciled. */
    generationId?: string;

    constructor(kind: LlmErrorKind, message: string, opts: { status?: number; retryAfter?: number } = {}) {
        super(message);
        this.name = 'LlmError';
        this.kind = kind;
        if (opts.status !== undefined) this.status = opts.status;
        if (opts.retryAfter !== undefined) this.retryAfter = opts.retryAfter;
    }
}

/** Test hooks; production uses the defaults. */
export interface StreamChatOptions {
    headersTimeoutMs?: number;
    idleTimeoutMs?: number;
    /** Wait before retry 1 and 2. */
    retryDelaysMs?: readonly number[];
}

interface Config {
    base: string;
    key: string;
}

function config(): Config {
    const key = process.env.OPENROUTER_API_KEY?.trim();
    if (!key) throw new LlmError('config', 'OPENROUTER_API_KEY is not set');
    const base = (process.env.OPENROUTER_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    return { base, key };
}

function headers(key: string): Record<string, string> {
    return {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://domdimabot.com',
        'X-Title': 'DomDimaBot assistant',
    };
}

function requestBody(req: LlmRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages,
        stream: true,
        reasoning: { effort: req.effort },
        usage: { include: true },
        session_id: req.sessionKey,
        user: req.sessionKey,
    };
    if (req.tools?.length) {
        body.tools = req.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
        body.parallel_tool_calls = true;
        if (req.toolChoice) body.tool_choice = req.toolChoice;
    }
    if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens;
    return body;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const CONTEXT_PATTERN = /context length|maximum context|context window|context_length|too many tokens|prompt is too long/i;

/** Short, single-line provider message without anything that looks like a key. */
function sanitize(text: string, key?: string): string {
    let out = text;
    if (key) out = out.split(key).join('[key]');
    out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]').replace(/\s+/g, ' ').trim();
    return out.length > 300 ? `${out.slice(0, 297)}...` : out;
}

/** Pulls `error.message` (and nested provider raw text) out of an OpenRouter error body. */
function errorText(raw: string): string {
    try {
        const parsed = JSON.parse(raw) as { error?: { message?: unknown; metadata?: { raw?: unknown } } };
        const message = typeof parsed.error?.message === 'string' ? parsed.error.message : '';
        const providerRaw = typeof parsed.error?.metadata?.raw === 'string' ? parsed.error.metadata.raw : '';
        const text = [message, providerRaw].filter(Boolean).join(': ');
        if (text) return text;
    } catch {
        // Not JSON: use the text as is.
    }
    return raw;
}

function kindForStatus(status: number, text: string): LlmErrorKind {
    if ((status === 400 || status === 413) && CONTEXT_PATTERN.test(text)) return 'context_too_long';
    if (status === 400) return 'bad_request';
    if (status === 401 || status === 402 || status === 403) return 'config';
    if (status === 408 || status === 504) return 'timeout';
    if (status === 429) return 'rate_limited';
    if (status === 502 || status === 503) return 'overloaded';
    return 'upstream';
}

function statusError(status: number, raw: string, key: string, retryAfter?: number): LlmError {
    const text = errorText(raw);
    const kind = kindForStatus(status, text);
    const message = sanitize(`OpenRouter ${status}${text ? `: ${text}` : ''}`, key);
    return new LlmError(kind, message, { status, ...(retryAfter !== undefined ? { retryAfter } : {}) });
}

/** Error object inside a stream chunk (`error` or `choices[0].error`). */
function chunkError(error: unknown, key: string): LlmError {
    const err = (error && typeof error === 'object' ? error : {}) as { code?: unknown; message?: unknown; metadata?: { raw?: unknown } };
    const code = typeof err.code === 'number' ? err.code : Number.parseInt(String(err.code ?? ''), 10);
    const text = [typeof err.message === 'string' ? err.message : '', typeof err.metadata?.raw === 'string' ? err.metadata.raw : '']
        .filter(Boolean).join(': ') || 'stream error';
    const kind: LlmErrorKind = Number.isFinite(code) && code >= 400 ? kindForStatus(code, text) : CONTEXT_PATTERN.test(text) ? 'context_too_long' : 'upstream';
    return new LlmError(kind, sanitize(`OpenRouter stream error${Number.isFinite(code) ? ` ${code}` : ''}: ${text}`, key),
        Number.isFinite(code) ? { status: code } : {});
}

/** Retry-After in ms (seconds or an HTTP date), or undefined. */
function retryAfterMs(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isRetryableStatus(status: number): boolean {
    return status === 429 || status === 502 || status === 503;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new LlmError('aborted', 'Request cancelled'));
        const onAbort = () => {
            clearTimeout(timer);
            reject(new LlmError('aborted', 'Request cancelled'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

// ---------------------------------------------------------------------------
// Stream assembly
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const numOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Maps an OpenRouter `usage` object from the stream. */
export function mapStreamUsage(raw: unknown): LlmUsage {
    const usage = (raw ?? {}) as Json;
    const promptDetails = (usage.prompt_tokens_details ?? {}) as Json;
    const completionDetails = (usage.completion_tokens_details ?? {}) as Json;
    const costDetails = (usage.cost_details ?? {}) as Json;
    let upstream = numOrNull(costDetails.upstream_inference_cost);
    if (upstream === null) {
        const prompt = numOrNull(costDetails.upstream_inference_prompt_cost);
        const completions = numOrNull(costDetails.upstream_inference_completions_cost);
        if (prompt !== null || completions !== null) upstream = (prompt ?? 0) + (completions ?? 0);
    }
    return {
        promptTokens: num(usage.prompt_tokens),
        cachedTokens: num(promptDetails.cached_tokens),
        completionTokens: num(usage.completion_tokens),
        reasoningTokens: num(completionDetails.reasoning_tokens),
        upstreamCostUsd: upstream,
        routerCostUsd: numOrNull(usage.cost),
        source: 'reported',
        isByok: typeof usage.is_byok === 'boolean' ? usage.is_byok : null,
    };
}

const MERGED_STRINGS = ['summary', 'text', 'data', 'signature'] as const;

/** Merges `reasoning_details` fragments by (type, index); strings are concatenated, first id/format kept. */
export function mergeReasoningDetails(target: Json[], fragments: unknown[]): void {
    for (const fragment of fragments) {
        if (!fragment || typeof fragment !== 'object') continue;
        const part = fragment as Json;
        const index = part.index ?? 0;
        const previous = target.find((item) => item.type === part.type && (item.index ?? 0) === index);
        if (!previous) {
            target.push({ ...part });
            continue;
        }
        for (const field of MERGED_STRINGS) {
            if (typeof part[field] === 'string') previous[field] = `${typeof previous[field] === 'string' ? previous[field] : ''}${part[field]}`;
        }
        for (const field of ['id', 'format'] as const) {
            if (part[field] && !previous[field]) previous[field] = part[field];
        }
    }
}

interface CallParts {
    index: number;
    id: string;
    name: string;
    arguments: string;
}

/** Appends a streamed piece unless the provider repeated the whole value. */
const appendPiece = (current: string, piece: unknown): string => (typeof piece !== 'string' || piece === '' || piece === current ? current : current + piece);

class StepAssembler {
    generationId: string | null = null;
    provider: string | null = null;
    content = '';
    finishReason: string | null = null;
    usage: LlmUsage | null = null;
    done = false;
    readonly reasoning: Json[] = [];
    private readonly calls = new Map<number, CallParts>();
    private lastIndex = -1;

    constructor(private readonly handlers: LlmStreamHandlers, private readonly key: string) {}

    chunk(chunk: Json): void {
        // Keep the generation id even when this very chunk is an error: it may still be billed.
        if (typeof chunk.id === 'string' && !this.generationId) this.generationId = chunk.id;
        if (chunk.error) throw chunkError(chunk.error, this.key);
        if (typeof chunk.provider === 'string' && !this.provider) this.provider = chunk.provider;
        if (chunk.usage && typeof chunk.usage === 'object') this.usage = mapStreamUsage(chunk.usage);
        const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as Json | undefined) : undefined;
        if (!choice) return;
        if (choice.error) throw chunkError(choice.error, this.key);
        if (choice.finish_reason === 'error') throw new LlmError('upstream', 'OpenRouter stream ended with an error');
        const delta = (choice.delta ?? {}) as Json;
        if (typeof delta.reasoning === 'string' && delta.reasoning) this.handlers.onReasoning?.(delta.reasoning);
        if (Array.isArray(delta.reasoning_details)) mergeReasoningDetails(this.reasoning, delta.reasoning_details);
        if (typeof delta.content === 'string' && delta.content) {
            this.content += delta.content;
            this.handlers.onText?.(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) this.toolCall(call as Json);
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) this.finishReason = choice.finish_reason;
    }

    private toolCall(delta: Json): void {
        let index: number;
        if (typeof delta.index === 'number') index = delta.index;
        else {
            // No index: a new id starts a new call, otherwise it continues the last one.
            const last = this.calls.get(this.lastIndex);
            index = !last || (typeof delta.id === 'string' && delta.id && last.id && delta.id !== last.id) ? this.lastIndex + 1 : this.lastIndex;
        }
        this.lastIndex = Math.max(this.lastIndex, index);
        const call = this.calls.get(index) ?? { index, id: '', name: '', arguments: '' };
        const fn = (delta.function ?? {}) as Json;
        call.id = appendPiece(call.id, delta.id);
        call.name = appendPiece(call.name, fn.name);
        if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
        this.calls.set(index, call);
    }

    toolCalls(): ToolCallRequest[] {
        return [...this.calls.values()].sort((a, b) => a.index - b.index).filter((call) => call.name)
            .map((call) => ({ id: call.id || `call_${this.generationId ?? 'step'}_${call.index}`, name: call.name, arguments: call.arguments }));
    }
}

/**
 * Splits SSE text into lines (LF, CRLF or CR) across network chunks and groups `data:` lines into
 * events. `onLine` fires for every complete line (activity, including `:` comments).
 */
class SseReader {
    private buffer = '';
    private data: string[] = [];

    constructor(private readonly onEvent: (data: string) => void, private readonly onLine: () => void) {}

    push(text: string, final = false): void {
        this.buffer += text;
        let start = 0;
        for (;;) {
            let end = -1;
            for (let i = start; i < this.buffer.length; i++) {
                const ch = this.buffer.charCodeAt(i);
                if (ch === 10 || ch === 13) { end = i; break; }
            }
            if (end < 0) break;
            // A CR at the very end may be the first half of CRLF: wait for the next chunk.
            if (this.buffer.charCodeAt(end) === 13 && end === this.buffer.length - 1 && !final) break;
            const line = this.buffer.slice(start, end);
            start = end + (this.buffer.charCodeAt(end) === 13 && this.buffer.charCodeAt(end + 1) === 10 ? 2 : 1);
            this.line(line);
        }
        this.buffer = this.buffer.slice(start);
        if (final) {
            if (this.buffer) this.line(this.buffer);
            this.buffer = '';
            this.dispatch();
        }
    }

    private line(line: string): void {
        this.onLine();
        if (line === '') return this.dispatch();
        if (line.startsWith(':')) return;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        if (field !== 'data') return;
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        this.data.push(value);
    }

    private dispatch(): void {
        if (!this.data.length) return;
        const data = this.data.join('\n');
        this.data = [];
        this.onEvent(data);
    }
}

// ---------------------------------------------------------------------------
// streamChat
// ---------------------------------------------------------------------------

/** Internal marker so the attempt loop knows a failure may be retried (nothing was received yet). */
class RetryableFailure extends Error {
    constructor(readonly error: LlmError, readonly delayMs?: number) {
        super(error.message);
    }
}

/**
 * Runs one model step. Throws `LlmError` on failure; a caller abort after the headers resolves with
 * `aborted: true` instead. `options` only exists for tests.
 */
export async function streamChat(req: LlmRequest, handlers: LlmStreamHandlers = {}, options: StreamChatOptions = {}): Promise<LlmStepResult> {
    const { base, key } = config();
    const started = Date.now();
    const body = JSON.stringify(requestBody(req));
    const retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    const maxRetries = 2;
    if (req.signal?.aborted) throw new LlmError('aborted', 'Request cancelled');

    for (let attempt = 0; ; attempt++) {
        try {
            return await attemptStream(`${base}/chat/completions`, key, body, req.signal, handlers, options, started);
        } catch (err) {
            if (!(err instanceof RetryableFailure)) throw err;
            if (attempt >= maxRetries) throw err.error;
            const backoff = retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 0;
            await wait(err.delayMs !== undefined ? Math.min(err.delayMs, MAX_RETRY_AFTER_MS) : backoff, req.signal);
        }
    }
}

async function attemptStream(url: string, key: string, body: string, signal: AbortSignal | undefined, handlers: LlmStreamHandlers,
    options: StreamChatOptions, started: number): Promise<LlmStepResult> {
    const controller = new AbortController();
    // Object (not a let) so TypeScript doesn't narrow it away: the timers set it.
    const state: { timedOut: 'headers' | 'idle' | null; sawData: boolean } = { timedOut: null, sawData: false };
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    let timer: NodeJS.Timeout | undefined = setTimeout(() => { state.timedOut = 'headers'; controller.abort(); }, options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS);
    const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { state.timedOut = 'idle'; controller.abort(); }, idleMs);
    };
    const callerAborted = () => signal?.aborted === true && state.timedOut === null;
    const assembler = new StepAssembler(handlers, key);

    try {
        let response: Response;
        try {
            response = await fetch(url, { method: 'POST', headers: headers(key), body, signal: controller.signal });
        } catch (err) {
            if (callerAborted()) throw new LlmError('aborted', 'Request cancelled');
            if (state.timedOut === 'headers') throw new LlmError('timeout', 'OpenRouter did not respond in time');
            throw new RetryableFailure(new LlmError('upstream', sanitize(`Could not reach OpenRouter: ${errMessage(err)}`, key)));
        }
        touch();

        if (!response.ok) {
            const raw = await response.text().catch(() => '');
            if (callerAborted()) throw new LlmError('aborted', 'Request cancelled');
            const delay = retryAfterMs(response.headers.get('retry-after'));
            const error = statusError(response.status, raw, key, delay !== undefined ? Math.ceil(delay / 1000) : undefined);
            if (isRetryableStatus(response.status)) throw new RetryableFailure(error, delay);
            throw error;
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
            // A 200 JSON body is an error (or a non-streamed reply we never ask for).
            const raw = await response.text().catch(() => '');
            const parsed = safeJson(raw);
            if (parsed?.error) throw chunkError(parsed.error, key);
            throw new LlmError('upstream', 'OpenRouter returned JSON instead of a stream');
        }
        if (!response.body) throw new LlmError('incomplete', 'OpenRouter returned an empty response');

        // Errors thrown here (stream error chunks, handler bugs) propagate as they are.
        const sse = new SseReader((data) => {
            if (assembler.done) return;
            if (data === '[DONE]') { assembler.done = true; return; }
            const parsed = safeJson(data);
            if (!parsed) return; // A broken line is skipped; a missing finish_reason still fails the step.
            state.sawData = true;
            assembler.chunk(parsed);
        }, touch);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
            for (;;) {
                let read: ReadableStreamReadResult<Uint8Array>;
                try {
                    read = await reader.read();
                } catch (err) {
                    // The model already finished; only the trailing usage chunk is missing (reconcile it).
                    if (assembler.finishReason) break;
                    if (callerAborted()) return result(assembler, started, true);
                    if (state.timedOut === 'idle') throw new LlmError('timeout', 'OpenRouter stream went quiet');
                    const error = new LlmError('incomplete', sanitize(`OpenRouter stream broke: ${errMessage(err)}`, key));
                    if (!state.sawData) throw new RetryableFailure(error);
                    throw error;
                }
                if (read.done) {
                    sse.push(decoder.decode(), true);
                    break;
                }
                sse.push(decoder.decode(read.value, { stream: true }));
                if (assembler.done) break;
            }
        } finally {
            reader.cancel().catch(() => {});
        }

        if (!assembler.finishReason) {
            if (callerAborted()) return result(assembler, started, true);
            const error = new LlmError('incomplete', 'OpenRouter stream ended before the model finished');
            if (!state.sawData) throw new RetryableFailure(error);
            throw error;
        }
        return result(assembler, started, false);
    } catch (err) {
        // A started generation is billed even when the stream fails: let the caller reconcile it.
        if (assembler.generationId) {
            if (err instanceof LlmError) err.generationId ??= assembler.generationId;
            else if (err instanceof RetryableFailure) err.error.generationId ??= assembler.generationId;
        }
        throw err;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onCallerAbort);
        controller.abort();
    }
}

/**
 * Aborted steps keep their partial text and reasoning but no tool calls (half-received calls must
 * never run). `usage` is kept only if the usage chunk had already arrived.
 */
function result(assembler: StepAssembler, started: number, aborted: boolean): LlmStepResult {
    return {
        generationId: assembler.generationId,
        provider: assembler.provider,
        content: assembler.content,
        toolCalls: aborted ? [] : assembler.toolCalls(),
        reasoning: assembler.reasoning,
        finishReason: assembler.finishReason,
        usage: assembler.usage,
        aborted,
        durationMs: Date.now() - started,
    };
}

function safeJson(text: string): Json | null {
    try {
        const value = JSON.parse(text) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
    } catch {
        return null;
    }
}

function errMessage(err: unknown): string {
    if (err instanceof Error) {
        const cause = (err as Error & { cause?: unknown }).cause;
        return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
    }
    return String(err);
}

// ---------------------------------------------------------------------------
// Generation lookup (cost of aborted steps)
// ---------------------------------------------------------------------------

export interface ReconcileOptions {
    /** Lookup times in ms after the first lookup (which runs immediately). [] = one lookup only. */
    scheduleMs?: readonly number[];
    signal?: AbortSignal;
}

/** Maps `GET /generation` data to usage (native token counts preferred). */
export function mapGenerationUsage(raw: unknown): LlmUsage | null {
    const data = (raw ?? {}) as Json;
    const prompt = numOrNull(data.native_tokens_prompt) ?? numOrNull(data.tokens_prompt);
    const completion = numOrNull(data.native_tokens_completion) ?? numOrNull(data.tokens_completion);
    if (prompt === null && completion === null) return null; // Still processing.
    return {
        promptTokens: prompt ?? 0,
        cachedTokens: num(data.native_tokens_cached),
        completionTokens: completion ?? 0,
        reasoningTokens: num(data.native_tokens_reasoning),
        upstreamCostUsd: numOrNull(data.upstream_inference_cost),
        routerCostUsd: numOrNull(data.total_cost),
        source: 'reconciled',
        isByok: typeof data.is_byok === 'boolean' ? data.is_byok : null,
    };
}

/**
 * Looks up a finished or cancelled generation's tokens and cost. OpenRouter answers 404 for a few
 * seconds after a stream ends; we try again on the schedule and return null if it never shows up.
 */
export async function reconcileGeneration(generationId: string, opts: ReconcileOptions = {}): Promise<LlmUsage | null> {
    const { base, key } = config();
    const schedule = opts.scheduleMs ?? RECONCILE_SCHEDULE_MS;
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
        const usage = await lookupGeneration(base, key, generationId, opts.signal);
        if (usage === 'auth') return null;
        if (usage) return usage;
        const next = schedule[attempt];
        if (next === undefined) return null;
        await wait(Math.max(0, started + next - Date.now()), opts.signal);
    }
}

async function lookupGeneration(base: string, key: string, generationId: string, signal?: AbortSignal): Promise<LlmUsage | null | 'auth'> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(`${base}/generation?id=${encodeURIComponent(generationId)}`, {
            headers: { Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://domdimabot.com', 'X-Title': 'DomDimaBot assistant' },
            signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) return 'auth';
        if (!response.ok) return null; // 404 (not ready) and transient errors: try again later.
        const body = safeJson(await response.text());
        return mapGenerationUsage(body?.data ?? body);
    } catch {
        if (signal?.aborted) throw new LlmError('aborted', 'Request cancelled');
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
