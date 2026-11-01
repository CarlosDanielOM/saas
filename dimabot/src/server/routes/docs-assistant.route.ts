/**
 * Public docs assistant for docs.domdimabot.com (no login).
 *
 * POST /docs-assistant/ask       → Server-Sent Events stream:
 *   event: start   {id}
 *   event: status  {phase: 'thinking'}       (once, when the model starts thinking)
 *   event: text    {delta}
 *   event: done    {id, sources: [{title, url}], stopReason}
 *   event: error   {code}
 *   Errors before the stream starts are JSON: {error, message, status, data: {code, retryAfter?}}.
 * POST /docs-assistant/feedback  {id, helpful} → {error: false, data: {recorded}}
 *
 * Request bounds (not output limits): per-IP rate limits, a daily total, and
 * a cap on simultaneous answers per API process.
 */
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { error as logError } from '../../utils/logger.js';
import { hitRateLimit } from '../../utils/rate_limit.js';
import { MiniMaxError } from '../../utils/ai/minimax/minimax_client.js';
import {
    answerDocsQuestion, countQuestion, DocsAssistantInputError, parseDocsAssistantRequest,
    recordAnswer, recordFailure, recordFeedback,
} from '../../utils/ai/docs_assistant/docs_assistant.js';

export const DOCS_ASSISTANT_LIMITS = {
    perMinute: 8,
    perDay: 80,
    dailyTotal: 5000,
    concurrent: 16,
} as const;

const PING_MS = 15_000;

const ALLOWED_ORIGIN = /^(https:\/\/docs\.domdimabot\.com|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;

export const docsAssistantRoute = express.Router();
docsAssistantRoute.use(cors({
    origin: (origin, done) => done(null, !origin || ALLOWED_ORIGIN.test(origin)),
    methods: ['POST'],
    maxAge: 86_400,
}));
docsAssistantRoute.use(express.json({ limit: '256kb' }));

let active = 0;

/** Cloudflare sets cf-connecting-ip; fall back to the proxy chain, then the socket. */
function clientIp(req: Request): string {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf.trim();
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    return first || req.socket.remoteAddress || 'unknown';
}

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    if (extra.retryAfter) res.setHeader('Retry-After', String(extra.retryAfter));
    return res.status(status).json({ error: true, message, status, data: { code, ...extra } });
}

function errorCode(err: unknown): string {
    if (err instanceof MiniMaxError) {
        if (err.kind === 'timeout') return 'timeout';
        if (err.kind === 'rate_limited' || err.kind === 'overloaded') return 'busy';
    }
    return 'unavailable';
}

docsAssistantRoute.post('/ask', async (req: Request, res: Response) => {
    let request;
    try {
        request = parseDocsAssistantRequest(req.body);
    } catch (err) {
        return fail(res, 400, 'invalid_request', err instanceof DocsAssistantInputError ? err.message : 'Invalid request');
    }

    try {
        const ip = clientIp(req);
        const minute = await hitRateLimit('docs-assistant:minute', ip, DOCS_ASSISTANT_LIMITS.perMinute, 60);
        if (!minute.allowed) return fail(res, 429, 'rate_limited', 'Too many questions; wait a moment', { retryAfter: minute.retryAfter });
        const today = await hitRateLimit('docs-assistant:day', ip, DOCS_ASSISTANT_LIMITS.perDay, 86_400);
        if (!today.allowed) return fail(res, 429, 'daily_limit', 'Daily question limit reached', { retryAfter: today.retryAfter });
        if (active >= DOCS_ASSISTANT_LIMITS.concurrent) return fail(res, 503, 'busy', 'The assistant is busy; try again shortly', { retryAfter: 10 });
        if (await countQuestion() > DOCS_ASSISTANT_LIMITS.dailyTotal) return fail(res, 503, 'daily_total', 'The assistant is resting until tomorrow');
    } catch (err) {
        await logError({ function: 'docsAssistant.ask', message: 'Pre-check failed', error: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
        return fail(res, 503, 'unavailable', 'The assistant is unavailable right now');
    }

    active++;
    const controller = new AbortController();
    // The browser closed the panel or navigated away: stop paying for the answer.
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx (Proxy Manager): don't buffer the stream
    res.flushHeaders();
    const send = (event: string, data: unknown) => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Thinking can take a while before any text; keep proxies from closing the connection.
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, PING_MS);

    let thinking = false;
    try {
        const answer = await answerDocsQuestion(request, {
            onStart: (id) => send('start', { id }),
            onThinking: () => { if (!thinking) { thinking = true; send('status', { phase: 'thinking' }); } },
            onText: (delta) => send('text', { delta }),
        }, controller.signal);
        send('done', { id: answer.id, sources: answer.sources, stopReason: answer.usage.stopReason });
        await recordAnswer(request, answer);
    } catch (err) {
        const aborted = controller.signal.aborted || (err instanceof MiniMaxError && err.kind === 'aborted');
        if (!aborted) {
            const code = errorCode(err);
            send('error', { code });
            await recordFailure(code);
            if (!(err instanceof MiniMaxError)) {
                await logError({ function: 'docsAssistant.ask', message: 'Answer failed', error: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
            }
        }
    } finally {
        clearInterval(ping);
        active--;
        res.end();
    }
});

docsAssistantRoute.post('/feedback', async (req: Request, res: Response) => {
    try {
        const limit = await hitRateLimit('docs-assistant:feedback', clientIp(req), 30, 60);
        if (!limit.allowed) return fail(res, 429, 'rate_limited', 'Too many requests', { retryAfter: limit.retryAfter });
        const recorded = await recordFeedback(req.body?.id, req.body?.helpful);
        return res.status(200).json({ error: false, message: 'OK', status: 200, data: { recorded } });
    } catch (err) {
        if (err instanceof DocsAssistantInputError) return fail(res, 400, 'invalid_request', err.message);
        await logError({ function: 'docsAssistant.feedback', message: 'Feedback failed', error: err instanceof Error ? err.message : String(err) }, { destination: 'both' });
        return fail(res, 503, 'unavailable', 'Could not save feedback');
    }
});
