import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { basename } from 'node:path';
import { createClient } from 'redis';
import type { Request, Response, NextFunction } from 'express';

// Only bounded metadata leaves the process. Never export message text, arguments,
// bodies, query strings, database statements, headers, or credentials.
export const LATENCY_BOUNDS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000, 1e12];
export const TELEMETRY_INBOX = 'observability:v1:inbox';
const context = new AsyncLocalStorage<TraceContext>();
export interface TraceContext { traceId: string; spanId: string; sampled: boolean; channel: string; outcome?: string }
interface Metric { at: number; kind: string; name: string; channel: string; outcome: string; count: number; sum: number; max: number; histogram: number[] }
interface Span extends TraceContext { parentId: string | null; at: number; duration: number; kind: string; name: string; outcome: string; partial: boolean }
interface TelemetryLog { at: number; level: string; name: string; channel: string; traceId: string | null; fields: Record<string, string | number | boolean> }
const metrics = new Map<string, Metric>();
let spans: Span[] = [], logs: TelemetryLog[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let client: ReturnType<typeof createClient> | undefined;
let flushing = false, dropped = 0;
const instance = randomUUID();
const processName = basename(process.argv[1] || 'unknown').replace(/\.(?:js|ts)$/, '');
const service = (process.argv[1] || '').includes('/workers/') ? 'cron' : (process.argv[1] || '').includes('/bot/') ? 'bot' : 'api';
const clean = (value: unknown, max = 100): string => String(value ?? '').replace(/[^a-zA-Z0-9_.:/ -]/g, '_').slice(0, max);
const channelId = (value: unknown): string => /^[a-zA-Z0-9_-]{1,80}$/.test(String(value || '')) ? String(value) : '';
const traceId = (): string => randomBytes(16).toString('hex');
const spanId = (): string => randomBytes(8).toString('hex');
let active = false;

export function startTelemetry(): void {
    if (timer || process.env.OBSERVABILITY_DISABLED === 'true' || !process.env.DRAGONFLY_HOST) return;
    active = true;
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    let lastCpu = process.cpuUsage(), lastTime = performance.now();
    timer = setInterval(() => {
        const memory = process.memoryUsage(), cpu = process.cpuUsage(), now = performance.now();
        const cpuCores = ((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / ((now - lastTime) * 1000);
        lastCpu = cpu; lastTime = now;
        observe('runtime', `${processName}.rss_bytes`, memory.rss);
        observe('runtime', `${processName}.heap_bytes`, memory.heapUsed);
        observe('runtime', `${processName}.cpu_cores`, cpuCores);
        observe('runtime', `${processName}.event_loop_p99_ms`, Number.isFinite(loop.percentile(99)) ? loop.percentile(99) / 1e6 : 0);
        observe('runtime', `${processName}.telemetry_dropped`, dropped);
        loop.reset();
        void flushTelemetry();
    }, 10000);
    timer.unref();
}

export function observe(kind: string, name: string, value = 0, outcome = 'ok', channel?: string, at = Date.now()): void {
    if (!active || !Number.isFinite(value)) return;
    const item = { at: Math.floor(at / 10000) * 10000, kind: clean(kind, 30), name: clean(name), channel: channelId(channel ?? context.getStore()?.channel), outcome: clean(outcome, 30) };
    const key = JSON.stringify(item);
    let metric = metrics.get(key);
    if (!metric) {
        if (metrics.size >= 2000) { dropped++; return; }
        metric = { ...item, count: 0, sum: 0, max: 0, histogram: LATENCY_BOUNDS.map(() => 0) };
        metrics.set(key, metric);
    }
    metric.count++; metric.sum += Math.max(0, value); metric.max = Math.max(metric.max, value);
    metric.histogram[LATENCY_BOUNDS.findIndex(bound => value <= bound) < 0 ? LATENCY_BOUNDS.length - 1 : LATENCY_BOUNDS.findIndex(bound => value <= bound)]++;
}

export function telemetryContext(): TraceContext | undefined { return context.getStore(); }
export function bindChannel(channel: unknown): void { const current = context.getStore(); if (current) current.channel = channelId(channel); }
export function traceOutcome(outcome: string): void { const current = context.getStore(); if (current) current.outcome = clean(outcome, 30); }
export function restoreContext<T>(saved: unknown, channel: string, run: () => T): T {
    const candidate = saved as Partial<TraceContext> | undefined;
    const valid = candidate && /^[a-f0-9]{32}$/.test(candidate.traceId || '') && /^[a-f0-9]{16}$/.test(candidate.spanId || '');
    return context.run(valid ? { traceId: candidate.traceId!, spanId: candidate.spanId!, sampled: candidate.sampled === true, channel: channelId(channel) }
        : { traceId: traceId(), spanId: spanId(), sampled: Math.random() < 0.01, channel: channelId(channel) }, run);
}

export function beginSpan(kind: string, name: string, channel?: string) {
    const parent = context.getStore();
    const current: TraceContext = { traceId: parent?.traceId || traceId(), spanId: spanId(), sampled: parent?.sampled ?? Math.random() < 0.01, channel: channelId(channel ?? parent?.channel) };
    const started = performance.now(), at = Date.now();
    let ended = false;
    return {
        context: current,
        run: <T>(fn: () => T): T => context.run(current, fn),
        end: (outcome = 'ok', finalName?: string): void => {
            if (ended) return;
            ended = true;
            outcome = current.outcome || outcome;
            const duration = performance.now() - started;
            observe(kind, finalName || name, duration, outcome, current.channel, at);
            if (!active || !(current.sampled || duration >= 1000 || outcome === 'error')) return;
            if (spans.length >= 300) { dropped++; return; }
            spans.push({ ...current, parentId: parent?.spanId || null, at, duration, kind: clean(kind, 30), name: clean(finalName || name), outcome: clean(outcome, 30), partial: !current.sampled });
        }
    };
}

export async function traced<T>(kind: string, name: string, run: () => Promise<T>, channel?: string): Promise<T> {
    const span = beginSpan(kind, name, channel);
    return span.run(async () => {
        try { const value = await run(); span.end((value as { error?: unknown })?.error ? 'error' : 'ok'); return value; }
        catch (error) { span.end('error'); throw error; }
    });
}

export function recordLog(level: string, data: unknown, channel?: string): void {
    if (!active || !['warn', 'error', 'fatal'].includes(level)) return;
    if (logs.length >= 100) { dropped++; return; }
    const value = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const fields: Record<string, string | number | boolean> = {};
    // Explicit metadata allowlist. Free-text messages/errors often contain user data.
    for (const key of ['function', 'step', 'status', 'code', 'errorCode', 'operation', 'provider', 'attempt', 'durationMs']) {
        if (typeof value[key] === 'number' || typeof value[key] === 'boolean') fields[key] = value[key] as number | boolean;
        else if (typeof value[key] === 'string') fields[key] = clean(value[key], 80);
    }
    logs.push({ at: Date.now(), level, name: clean(value.function || value.operation || 'application'), channel: channelId(channel ?? context.getStore()?.channel), traceId: context.getStore()?.traceId || null, fields });
}

export function httpTelemetry(req: Request, res: Response, next: NextFunction): void {
    if (req.path.startsWith('/observability')) { next(); return; }
    startTelemetry();
    // Public trace headers cannot force capture or inject tenant identity.
    const incoming = String(req.headers.traceparent || '');
    const signature = String(req.headers['x-observability-signature'] || '');
    const expected = process.env.SECRET_KEY ? createHmac('sha256', process.env.SECRET_KEY).update(incoming).digest('hex') : '';
    const trusted = expected.length > 0 && signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    const match = trusted ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-(0[01])$/.exec(incoming) : null;
    const run = () => {
        const span = beginSpan('http', req.method);
        let finished = false;
        const done = (aborted: boolean) => {
            if (finished) return;
            finished = true;
            const route = typeof req.route?.path === 'string' ? `${req.baseUrl || ''}${req.route.path}` : '/unmatched';
            // Dynamic router mounts are never exported as literal channel IDs.
            const safeRoute = route.replace(/\/\d{5,}(?=\/|$)/g, '/:id').replace(/\/[a-f0-9]{24,}(?=\/|$)/g, '/:id');
            span.end(aborted ? 'aborted' : res.statusCode >= 500 ? 'error' : String(res.statusCode), `${req.method} ${safeRoute}`);
        };
        res.once('finish', () => done(false)); res.once('close', () => done(!res.writableFinished));
        span.run(next);
    };
    if (match) context.run({ traceId: match[1], spanId: match[2], sampled: match[3] === '01', channel: '' }, run);
    else run();
}

export function instrumentFetch(): void {
    const original = globalThis.fetch as typeof fetch & { instrumented?: boolean };
    if (original.instrumented) return;
    const wrapped: typeof fetch & { instrumented?: boolean } = async (input, init) => {
        let url: URL;
        try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
        catch { return original(input, init); }
        // Fixed provider labels avoid putting tokens and user-controlled URLs in telemetry.
        const provider = url.hostname === 'api.twitch.tv' ? 'twitch' : url.hostname === 'openrouter.ai' ? 'openrouter'
            : url.hostname.includes('qdrant') ? 'qdrant' : url.hostname === 'dima-server' || url.hostname === '127.0.0.1' ? 'internal-api'
            : url.hostname.includes('piper') ? 'piper' : 'external';
        if (['us.i.posthog.com', 'dima-analytics'].includes(url.hostname)) return original(input, init);
        const span = beginSpan('http_client', `${provider} ${init?.method || (input instanceof Request ? input.method : 'GET')}`);
        return span.run(async () => {
            const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
            if (provider === 'internal-api' && process.env.SECRET_KEY) {
                const value = `00-${span.context.traceId}-${span.context.spanId}-${span.context.sampled ? '01' : '00'}`;
                headers.set('traceparent', value);
                headers.set('x-observability-signature', createHmac('sha256', process.env.SECRET_KEY).update(value).digest('hex'));
            }
            try { const response = await original(input, { ...init, headers }); span.end(response.status >= 400 ? 'error' : String(response.status)); return response; }
            catch (error) { span.end('error'); throw error; }
        });
    };
    wrapped.instrumented = true;
    globalThis.fetch = wrapped;
}

const ENQUEUE = `local n=redis.call('LPUSH',KEYS[1],ARGV[1]); local dropped=math.max(0,n-100); redis.call('LTRIM',KEYS[1],0,99); if dropped>0 then redis.call('INCRBY',KEYS[2],dropped) end; redis.call('EXPIRE',KEYS[1],3600); return dropped`;
function disconnectTelemetryClient(): void {
    if (client?.isOpen) client.destroy();
    client = undefined;
}
async function telemetryClient() {
    if (client?.isReady) return client;
    disconnectTelemetryClient();
    const fresh = createClient({ url: `redis://${process.env.DRAGONFLY_HOST}:${process.env.DRAGONFLY_PORT || 6379}`, disableOfflineQueue: true, socket: { connectTimeout: 1000, reconnectStrategy: false } });
    fresh.on('error', () => {});
    client = fresh;
    await fresh.connect();
    return fresh;
}
export async function flushTelemetry(): Promise<void> {
    if (flushing || !active) return;
    flushing = true;
    // Swap once: requests never wait for telemetry. A failed flush is observable loss.
    const rows = [...metrics.values()]; metrics.clear();
    const traceRows = spans; spans = [];
    const logRows = logs; logs = [];
    const batches = Math.max(1, Math.ceil(rows.length / 100), Math.ceil(traceRows.length / 50), Math.ceil(logRows.length / 25));
    const timeout = setTimeout(disconnectTelemetryClient, 1800); timeout.unref();
    try {
        const redis = await telemetryClient();
        for (let i = 0; i < batches; i++) {
            const payload = JSON.stringify({ version: 1, id: randomUUID(), service, instance, at: Date.now(), metrics: rows.slice(i * 100, (i + 1) * 100), spans: traceRows.slice(i * 50, (i + 1) * 50), logs: logRows.slice(i * 25, (i + 1) * 25) });
            if (Buffer.byteLength(payload) > 256000) { dropped++; continue; }
            await redis.eval(ENQUEUE, { keys: [TELEMETRY_INBOX, 'observability:v1:overflow'], arguments: [payload] });
        }
    } catch { dropped += rows.reduce((sum, row) => sum + row.count, 0) + traceRows.length + logRows.length; }
    finally { clearTimeout(timeout); flushing = false; }
}

export const telemetryTesting = {
    enable: () => { active = true; },
    snapshot: () => ({ metrics: [...metrics.values()], spans: [...spans], logs: [...logs], dropped }),
    reset: () => { metrics.clear(); spans = []; logs = []; dropped = 0; },
    stop: () => { if (timer) clearInterval(timer); timer = undefined; disconnectTelemetryClient(); active = false; }
};
