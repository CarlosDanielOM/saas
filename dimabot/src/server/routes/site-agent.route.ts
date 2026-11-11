/**
 * Site agent ("Dima assistant") API for dimasite. Contract: dimabot/SITE_AGENT.md.
 * Every request: authenticated requester → website access to the channel (dashboard:view) →
 * session/turn/change ids checked against requester + channel. The channel always comes from the URL.
 */
import express, { type Response } from 'express';
import { createHash } from 'node:crypto';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import type { AuthRequest } from '../../middleware/types.js';
import { error as logError } from '../../utils/logger.js';
import { hitRateLimit } from '../../utils/rate_limit.js';
import { permissionChecker, resolveAccess, type ChannelAccess } from '../../site_agent/access.js';
import { ChangeError, listChanges, undoChange } from '../../site_agent/changes.js';
import { isSiteAgentEnabled, PLAN_MODELS, SITE_AGENT_LIMITS } from '../../site_agent/config.js';
import { readLimits } from '../../site_agent/limits.js';
import {
    AgentRequestError, decideApproval, feedback, isTurnActive, retryTurn, stopTurn, submitMessage, submitUi,
} from '../../site_agent/runner.js';
import * as store from '../../site_agent/store.js';
import { getTool } from '../../site_agent/tools/registry.js';
import { ToolConflictError, type InputMode, type Lang, type PageContext, type Requester } from '../../site_agent/types.js';

export const siteAgentRoute = express.Router();
siteAgentRoute.use(authMiddleware as express.RequestHandler);

const PING_MS = 15_000;

interface Ctx { access: ChannelAccess; requester: Requester }

function ok(res: Response, data: unknown, status = 200) {
    return res.status(status).json({ error: false, message: 'OK', status, data });
}

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    if (typeof extra.retryAfter === 'number') res.setHeader('Retry-After', String(extra.retryAfter));
    return res.status(status).json({ error: true, message, status, data: { code, ...extra } });
}

async function handleError(res: Response, err: unknown, where: string) {
    if (err instanceof AgentRequestError) return fail(res, err.status, err.code, err.message, err.extra);
    if (err instanceof ToolConflictError) return fail(res, 409, 'undo_conflict', err.message);
    if (err instanceof ChangeError) return fail(res, err.status, err.code, err.message);
    await logError({ function: `siteAgent.${where}`, error: err instanceof Error ? err.stack ?? err.message : String(err) }, { destination: 'both' });
    return fail(res, 500, 'internal_error', 'Something went wrong');
}

/** Resolves requester + channel access; sends the error response and returns null when not allowed. */
async function context(req: AuthRequest, res: Response, requireEnabled = true): Promise<Ctx | null> {
    const user = req.user;
    if (!user) { fail(res, 401, 'unauthorized', 'Not signed in'); return null; }
    const channelId = String(req.params.channelID ?? '');
    const limit = await hitRateLimit('site-agent:req', user.id, SITE_AGENT_LIMITS.requestsPerMinute, 60);
    if (!limit.allowed) { fail(res, 429, 'rate_limited', 'Too many requests', { retryAfter: limit.retryAfter }); return null; }
    const access = await resolveAccess(user.id, channelId);
    if (!access) { fail(res, 403, 'forbidden', 'No access to this channel'); return null; }
    if (requireEnabled && !isSiteAgentEnabled(channelId)) { fail(res, 404, 'not_enabled', 'The assistant is not available on this channel yet'); return null; }
    return { access, requester: { id: user.id, login: user.login, displayName: user.display_name || user.login } };
}

async function ownTurn(ctx: Ctx, turnId: string) {
    if (!/^[0-9a-f-]{36}$/.test(turnId)) throw new AgentRequestError('turn_not_found', 404);
    const turn = await store.getTurn(turnId);
    if (!turn || turn.userId !== ctx.requester.id || turn.channelId !== ctx.access.channelId) throw new AgentRequestError('turn_not_found', 404);
    return turn;
}

function turnSnapshot(turn: store.TurnRecord, cursor: string) {
    return { turnId: turn.id, sessionId: turn.sessionId, status: turn.status, inputRevision: turn.inputRevision, cursor };
}

function parsePage(raw: unknown): PageContext | null {
    if (!raw || typeof raw !== 'object') return null;
    const page = raw as Record<string, unknown>;
    const path = typeof page.path === 'string' ? page.path.slice(0, 300) : '';
    const route = typeof page.route === 'string' && /^[a-z0-9.-]{1,60}$/.test(page.route) ? page.route : null;
    const title = typeof page.title === 'string' ? page.title.replace(/[\u0000-\u001f]/g, '').slice(0, 120) : undefined;
    return { route, path, ...(title ? { title } : {}) };
}

/** Runs a POST once per clientRequestId (10 min); repeats get the stored result. */
async function idempotent(ctx: Ctx, body: Record<string, unknown>, res: Response, run: () => Promise<{ status: number; data: unknown }>) {
    const clientRequestId = typeof body.clientRequestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.clientRequestId) ? body.clientRequestId : null;
    if (!clientRequestId) return fail(res, 400, 'invalid_request', 'clientRequestId is required');
    const { clientRequestId: _omit, ...rest } = body;
    const fingerprint = createHash('sha256').update(JSON.stringify(rest)).digest('base64url');
    const begun = await store.beginRequest(ctx.requester.id, clientRequestId, fingerprint);
    if (begun.state === 'conflict') return fail(res, 409, 'idempotency_conflict', 'This request id was used for a different request');
    if (begun.state === 'pending') return fail(res, 409, 'in_progress', 'This request is still being handled', { retryAfter: 1 });
    if (begun.state === 'done') { const stored = begun.result as { status: number; data: unknown }; return ok(res, stored.data, stored.status); }
    try {
        const result = await run();
        await store.finishRequest(ctx.requester.id, clientRequestId, fingerprint, result);
        return ok(res, result.data, result.status);
    } catch (err) {
        await store.finishRequest(ctx.requester.id, clientRequestId, fingerprint, null).catch(() => {});
        throw err;
    }
}

siteAgentRoute.get('/:channelID/status', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res, false);
        if (!ctx) return;
        const enabled = isSiteAgentEnabled(ctx.access.channelId);
        return ok(res, {
            enabled,
            role: ctx.requester.id === ctx.access.channelId ? 'owner' : ctx.access.role,
            limits: await readLimits(ctx.access.channelId, ctx.access.plan),
            contextLimit: PLAN_MODELS[ctx.access.plan].contextLimit,
        });
    } catch (err) { return handleError(res, err, 'status'); }
});

siteAgentRoute.get('/:channelID/sessions', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        return ok(res, { sessions: await store.listSessions(ctx.access.channelId, ctx.requester.id) });
    } catch (err) { return handleError(res, err, 'sessions'); }
});

siteAgentRoute.get('/:channelID/sessions/:sessionId', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const session = await store.getOwnSession(String(req.params.sessionId), ctx.access.channelId, ctx.requester.id);
        if (!session) return fail(res, 404, 'session_not_found', 'Chat not found (chats are kept for 3 days)');
        const active = session.activeTurnId ? await store.getTurn(session.activeTurnId) : null;
        const live = active && isTurnActive(active.status) ? active : null;
        const { items, cursor } = await store.snapshot(session.id, live?.id ?? null);
        return ok(res, { session, items, activeTurn: live ? turnSnapshot(live, cursor) : null });
    } catch (err) { return handleError(res, err, 'session'); }
});

siteAgentRoute.patch('/:channelID/sessions/:sessionId', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const title = typeof req.body?.title === 'string' ? req.body.title.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) : '';
        if (!title) return fail(res, 400, 'invalid_request', 'title is required');
        const own = await store.getOwnSession(String(req.params.sessionId), ctx.access.channelId, ctx.requester.id);
        if (!own) return fail(res, 404, 'session_not_found', 'Chat not found');
        return ok(res, { session: await store.updateSession(own.id, (meta) => { meta.title = title; }) });
    } catch (err) { return handleError(res, err, 'rename'); }
});

siteAgentRoute.delete('/:channelID/sessions/:sessionId', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const own = await store.getOwnSession(String(req.params.sessionId), ctx.access.channelId, ctx.requester.id);
        if (!own) return fail(res, 404, 'session_not_found', 'Chat not found');
        await store.clearQueue(own.id);
        if (own.activeTurnId) await stopTurn(own.activeTurnId, ctx.requester.id).catch(() => undefined);
        await store.deleteSession(own.id, ctx.access.channelId, ctx.requester.id);
        return ok(res, { deleted: true });
    } catch (err) { return handleError(res, err, 'delete'); }
});

siteAgentRoute.post('/:channelID/messages', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const mode: InputMode = body.mode === 'steer' || body.mode === 'queue' ? body.mode : 'send';
        const lang: Lang = body.lang === 'es' || body.lang === 'en' ? body.lang : ctx.access.savedLang ?? 'en';
        const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;
        return await idempotent(ctx, body, res, async () => ({
            status: 202,
            data: await submitMessage({ access: ctx.access, requester: ctx.requester, sessionId, text: body.text, mode, page: parsePage(body.page), lang }),
        }));
    } catch (err) { return handleError(res, err, 'messages'); }
});

siteAgentRoute.get('/:channelID/turns/:turnId', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const turn = await ownTurn(ctx, String(req.params.turnId));
        const { cursor } = await store.snapshot(turn.sessionId, turn.id);
        return ok(res, turnSnapshot(turn, cursor));
    } catch (err) { return handleError(res, err, 'turn'); }
});

siteAgentRoute.get('/:channelID/turns/:turnId/events', async (req: AuthRequest, res) => {
    let ctx: Ctx | null;
    let turn: store.TurnRecord;
    try {
        ctx = await context(req, res);
        if (!ctx) return;
        turn = await ownTurn(ctx, String(req.params.turnId));
    } catch (err) { return handleError(res, err, 'events'); }
    const after = typeof req.query.after === 'string' && /^\d+-\d+$/.test(req.query.after) ? req.query.after : '0-0';

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let last = after;
    let replaying = true;
    let closed = false;
    let settle: NodeJS.Timeout | undefined;
    const buffered: store.StoredEvent[] = [];
    const end = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        clearTimeout(settle);
        store.bus.off(turn.id, listener);
        res.end();
    };
    const send = (stored: store.StoredEvent) => {
        if (closed || store.compareIds(stored.id, last) <= 0) return;
        res.write(`id: ${stored.id}\nevent: ${stored.event.type}\ndata: ${JSON.stringify(stored.event)}\n\n`);
        last = stored.id;
        if (stored.event.type === 'done' && stored.event.turnId === turn.id) end();
    };
    const listener = (stored: store.StoredEvent) => { if (replaying) buffered.push(stored); else send(stored); };
    const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, PING_MS);
    ping.unref();
    req.on('close', end);
    store.bus.on(turn.id, listener);

    try {
        const { events, gap } = await store.eventsAfter(turn.id, after);
        if (gap || (!events.length && !isTurnActive((await store.getTurn(turn.id))?.status ?? 'completed') && after === '0-0')) {
            res.write('event: resync\ndata: {}\n\n');
            return end();
        }
        for (const stored of events) send(stored);
        replaying = false;
        for (const stored of buffered.splice(0)) send(stored);
        // Already finished: its last events (`done`) are written right after the status changes, so wait
        // a moment for them; if they never come (or were sent before the cursor), read the snapshot.
        if (!closed && !isTurnActive((await store.getTurn(turn.id))?.status ?? 'completed')) {
            settle = setTimeout(() => {
                if (closed) return;
                res.write('event: resync\ndata: {}\n\n');
                end();
            }, 3000);
        }
    } catch (err) {
        await logError({ function: 'siteAgent.events', error: err instanceof Error ? err.message : String(err) }, { destination: 'console' });
        if (!closed) { res.write('event: resync\ndata: {}\n\n'); end(); }
    }
});

siteAgentRoute.post('/:channelID/turns/:turnId/stop', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const turn = await ownTurn(ctx, String(req.params.turnId));
        return ok(res, { status: await stopTurn(turn.id, ctx.requester.id) });
    } catch (err) { return handleError(res, err, 'stop'); }
});

siteAgentRoute.post('/:channelID/turns/:turnId/retry', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const turn = await ownTurn(ctx, String(req.params.turnId));
        return await idempotent(ctx, { ...(req.body ?? {}), turn: turn.id }, res, async () => ({ status: 202, data: await retryTurn(turn.id, ctx.requester, ctx.access) }));
    } catch (err) { return handleError(res, err, 'retry'); }
});

siteAgentRoute.post('/:channelID/turns/:turnId/approvals/:callId', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const turn = await ownTurn(ctx, String(req.params.turnId));
        const decision = req.body?.decision;
        if (decision !== 'apply' && decision !== 'skip') return fail(res, 400, 'invalid_request', 'decision must be apply or skip');
        return ok(res, { state: await decideApproval(turn.id, String(req.params.callId), decision, ctx.requester.id) });
    } catch (err) { return handleError(res, err, 'approval'); }
});

siteAgentRoute.post('/:channelID/turns/:turnId/ui/:callId', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const turn = await ownTurn(ctx, String(req.params.turnId));
        return ok(res, { state: await submitUi(turn.id, String(req.params.callId), req.body?.values, ctx.requester.id) });
    } catch (err) { return handleError(res, err, 'ui'); }
});

siteAgentRoute.post('/:channelID/turns/:turnId/feedback', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const turn = await ownTurn(ctx, String(req.params.turnId));
        return ok(res, { recorded: await feedback(turn.id, ctx.requester.id, req.body?.helpful) });
    } catch (err) { return handleError(res, err, 'feedback'); }
});

siteAgentRoute.get('/:channelID/changes', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const before = typeof req.query.before === 'string' ? req.query.before : undefined;
        const role = ctx.requester.id === ctx.access.channelId ? 'owner' : ctx.access.role;
        return ok(res, await listChanges(ctx.access.channelId, { id: ctx.requester.id, role }, before));
    } catch (err) { return handleError(res, err, 'changes'); }
});

siteAgentRoute.post('/:channelID/changes/:changeId/undo', async (req: AuthRequest, res) => {
    try {
        const ctx = await context(req, res);
        if (!ctx) return;
        const { access, requester } = ctx;
        const role = requester.id === access.channelId ? 'owner' : access.role;
        const can = permissionChecker(requester.id, access.channelId, 0);
        const change = await undoChange(access.channelId, String(req.params.changeId), { id: requester.id, role }, getTool, () => ({
            channelId: access.channelId, channelLogin: access.channelLogin, requester, role, plan: access.plan,
            lang: access.savedLang ?? 'en', sessionId: '', turnId: '', userMessage: '', page: null,
            signal: new AbortController().signal, can: (permissions) => can(permissions, true),
        }));
        return ok(res, { change });
    } catch (err) { return handleError(res, err, 'undo'); }
});
