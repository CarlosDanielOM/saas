/**
 * MCP tool core: check order (tool → access → scope → permissions/plan → input → credits → run), writes that apply
 * without a card (fresh re-check, safe-body guard, shared apply step, change log with source mcp), charging only a
 * billable success, the listing filter and the MCP-only change-log tools. Registry, access, credits and logger are fakes.
 */
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { chain, installFakeModel } from './write/fake_store.testutil.js';
import type { AgentTool, ChangeProposal, PlanTier, ToolContext, ToolKind } from '../types.js';

process.env.SECRET_KEY ??= 'tool-test-secret';

const CHANNEL = '100';
const ADMIN = '2002';
const OTHER = '3003';
const ALL_SCOPES = ['channel:read', 'channel:write', 'stream:act'];

interface Access { channelId: string; channelLogin: string; role: 'owner' | 'admin'; plan: PlanTier; savedLang: 'en' | 'es' | null }
const state = {
    access: { channelId: CHANNEL, channelLogin: 'chan', role: 'admin', plan: 'premium', savedLang: null } as Access | null,
    /** Answers for the next resolveAccess calls (then `access`). */
    accessQueue: [] as Array<Access | null>,
    accessCalls: 0,
    grants: new Set<string>(['commands:view', 'commands:manage']) as Set<string> | '*',
    checks: [] as Array<{ permissions: string[]; fresh: boolean }>,
    prices: {} as Record<string, number>,
    reserveError: null as Error | null,
    credits: [] as unknown[][],
    logged: [] as Array<{ level: string; data: Record<string, unknown> }>,
    callLog: [] as Array<Record<string, unknown>>,
    lateLog: [] as Array<[string, boolean]>,
};
mock.module('../mcp_call_log.js', {
    namedExports: {
        recordMcpCall: (record: Record<string, unknown>) => { state.callLog.push(record); },
        settleLateMcpCall: (operationId: string, landed: boolean) => { state.lateLog.push([operationId, landed]); },
    },
});

mock.module('../access.js', {
    namedExports: {
        resolveAccess: async () => { state.accessCalls++; return state.accessQueue.length ? state.accessQueue.shift()! : state.access; },
        permissionChecker: () => async (permissions: readonly string[], fresh = false) => {
            state.checks.push({ permissions: [...permissions], fresh });
            return state.grants === '*' || permissions.every((permission) => (state.grants as Set<string>).has(permission));
        },
        roleFor: (requesterId: string, access: Access) => requesterId === access.channelId ? 'owner' : access.role,
    },
});
class CreditError extends Error { constructor(readonly code: 'credits_exhausted' | 'credits_unavailable') { super(code); } }
mock.module('../credits.js', {
    namedExports: {
        CreditError,
        toolPrice: (tool: { name: string; kind: ToolKind }, surface: string) => surface !== 'mcp' ? 0 : state.prices[tool.name] ?? (tool.kind === 'knowledge' || tool.kind === 'ui' ? 0 : 1),
        reserveToolCredits: async (channelId: string, credits: number, operationId: string) => {
            state.credits.push(['reserve', channelId, credits, operationId]);
            if (state.reserveError) throw state.reserveError;
            return { channelId, credits, operationId };
        },
        settleToolCredits: async (hold: { operationId: string }, meta: { tool: string; surface: string }) => { state.credits.push(['settle', hold.operationId, meta.tool, meta.surface]); },
        releaseToolCredits: async (hold: { operationId: string }) => { state.credits.push(['release', hold.operationId]); },
    },
});
const log = (level: string) => async (data: Record<string, unknown>) => { state.logged.push({ level, data }); return { success: true }; };
mock.module('../../utils/logger.js', { namedExports: { trace: log('trace'), debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'), fatal: log('fatal') } });
mock.module('../../schemas/users.schema.js', { defaultExport: { findOne: () => chain(() => ({ accounts: [{ type: 'twitch', id: ADMIN, name: 'Helper' }, { type: 'twitch', id: CHANNEL, name: 'Chan' }] })) } });

// ---------------------------------------------------------------------------
// Fake site registry
// ---------------------------------------------------------------------------

const { ToolConflictError, ToolInputError } = await import('../types.js');
const hooks = { run: null as null | (() => void), apply: 'ok' as 'ok' | 'conflict' | 'throw' | 'slow' | 'slowFail' | 'noUndo', undoConflict: false };
const applied: Array<{ proposal: ChangeProposal; ctx: ToolContext }> = [];
const undone: unknown[] = [];
let finishSlow: (() => void) | null = null;
let failSlow: (() => void) | null = null;

function fake(partial: Partial<AgentTool> & { name: string; kind: ToolKind }): AgentTool {
    return {
        description: `${partial.name}: does something on the channel.`, parameters: { type: 'object', properties: {} }, permissions: [],
        label: () => 'Working…', validate: (raw: unknown) => (raw ?? {}) as Record<string, unknown>,
        run: async () => ({ type: 'result', result: { untrusted_data: { rows: [1, 2] } } }), ...partial,
    } as AgentTool;
}
const createCommand = fake({
    name: 'create_command', kind: 'write', permissions: ['commands:manage'],
    validate(raw) { const body = (raw as { body?: unknown } | undefined)?.body; if (typeof body !== 'string') throw new ToolInputError('body is required'); return { body }; },
    executableFields: (input) => [String((input as { body: string }).body)],
    async run(input) {
        hooks.run?.();
        const { body } = input as { body: string };
        return { type: 'approval', proposal: { tool: 'create_command', title: 'Create command !x', area: 'commands', target: { type: 'command', id: null, label: '!x' }, before: null, after: { Reply: body }, effects: [], warnings: ['w'], permissions: ['commands:manage'], payload: { body } } };
    },
    async apply(proposal, ctx) {
        applied.push({ proposal, ctx });
        if (hooks.apply === 'conflict') throw new ToolConflictError('!x was created by someone else');
        if (hooks.apply === 'throw') throw new Error('cache refresh failed');
        if (hooks.apply === 'slow' || hooks.apply === 'slowFail') await new Promise<void>((resolve, reject) => { finishSlow = resolve; failSlow = () => reject(new Error('late failure')); });
        const undo = hooks.apply === 'noUndo' ? null : { id: 'c1' };
        return { result: { created: true }, change: { area: 'commands', target: { type: 'command', id: 'c1', label: '!x' }, before: null, after: proposal.after, undo, summary: 'Created !x' } };
    },
    async undo(change) { undone.push(change); if (hooks.undoConflict) throw new ToolConflictError('!x changed after the change (reply)'); },
});
const proTool = fake({ name: 'update_tts_settings', kind: 'write', permissions: ['tts:manage'], minPlan: 'pro', undo: async () => {}, async run() { return { type: 'result', result: { unchanged: true } }; } });
const siteTools: AgentTool[] = [
    fake({ name: 'search_docs', kind: 'knowledge' }),
    fake({ name: 'get_command', kind: 'read', permissions: ['commands:view'],
        async run(input) { return (input as { name?: string }).name === 'missing' ? { type: 'result', billable: false, result: { found: false } } : { type: 'result', result: { untrusted_data: { reply: 'hi' } } }; } }),
    fake({ name: 'list_commands', kind: 'read', permissions: ['commands:view'], async run() { throw new Error('db down'); } }),
    fake({ name: 'get_settings', kind: 'read', permissions: [], async run() { return { type: 'result', billable: false, result: { allowed: false } }; } }),
    fake({ name: 'delete_command', kind: 'write', permissions: ['commands:manage'] }),
    fake({ name: 'update_ai_personality', kind: 'write', permissions: ['ai:manage'], undo: async () => {} }),
    fake({ name: 'send_test_alert', kind: 'stream', permissions: ['owner'] }),
    createCommand,
    proTool,
];
const PLAN_ORDER: Record<PlanTier, number> = { free: 0, premium: 1, pro: 2 };
const planAllows = (tool: AgentTool, plan: PlanTier) => !tool.minPlan || PLAN_ORDER[plan] >= PLAN_ORDER[tool.minPlan];
mock.module('./registry.js', {
    namedExports: {
        allTools: () => new Map(siteTools.map((tool) => [tool.name, tool])),
        getTool: (name: string) => siteTools.find((tool) => tool.name === name),
        getUndoTool: (name: string) => siteTools.find((tool) => tool.name === name),
        planAllows,
        toolsFor: async (can: (permissions: readonly string[]) => Promise<boolean>, plan: PlanTier, role: string) => {
            const out: AgentTool[] = [];
            for (const tool of siteTools) {
                if (!planAllows(tool, plan) || (tool.permissions.includes('owner') && role !== 'owner')) continue;
                if (await can(tool.permissions.filter((permission) => permission !== 'owner'))) out.push(tool);
            }
            return out;
        },
    },
});

const { SiteAgentChangeSchema } = await import('../changes.schema.js');
const changesDb = installFakeModel(SiteAgentChangeSchema);
const { executeMcpToolCall, listMcpTools, createMcpToolContext } = await import('./execute.js');
const { recordChange, undoChange, listChanges } = await import('../changes.js');

const principal = (over: Partial<Parameters<typeof executeMcpToolCall>[0]> = {}) => ({
    requesterId: ADMIN, channelId: CHANNEL, sessionId: 'sess-1', clientId: 'https://claude.ai/oauth/mcp-client', clientName: '  Claude\n', scopes: ALL_SCOPES, ...over,
});
let op = 0;
const opts = (signal = new AbortController().signal) => ({ operationId: `op-${++op}`, signal });
const call = (name: string, args: unknown = {}, over: Partial<Parameters<typeof executeMcpToolCall>[0]> = {}, signal?: AbortSignal) => executeMcpToolCall(principal(over), name, args, opts(signal));
const kinds = () => state.credits.map((entry) => entry[0]);
const flush = async (rounds = 20) => { for (let index = 0; index < rounds; index++) await new Promise((resolve) => setImmediate(resolve)); };

beforeEach(() => {
    state.access = { channelId: CHANNEL, channelLogin: 'chan', role: 'admin', plan: 'premium', savedLang: null };
    state.accessQueue = [];
    state.accessCalls = 0;
    state.grants = new Set(['commands:view', 'commands:manage']);
    state.checks = [];
    state.prices = {};
    state.reserveError = null;
    state.credits = [];
    state.logged = [];
    state.callLog = [];
    state.lateLog = [];
    hooks.run = null;
    hooks.apply = 'ok';
    hooks.undoConflict = false;
    applied.length = 0;
    undone.length = 0;
    changesDb.store.clear();
});

// ---------------------------------------------------------------------------
// Order of checks
// ---------------------------------------------------------------------------

test('unknown and site-only tools are unknown_tool before anything is read', async () => {
    for (const name of ['nope', 'send_test_alert', 'update_ai_personality', 'show_ui', '__proto__']) {
        const outcome = await call(name);
        assert.equal(outcome.ok === false && outcome.code, 'unknown_tool', name);
    }
    assert.equal(state.accessCalls, 0);
    assert.deepEqual(state.credits, []);
});

test('order: access → scope → permissions → plan → input → credits', async () => {
    state.access = null;
    assert.equal((await call('get_command', { name: 'x' }) as { code: string }).code, 'no_access');
    state.access = { channelId: CHANNEL, channelLogin: 'chan', role: 'admin', plan: 'premium', savedLang: null };

    const scope = await call('get_command', { name: 'x' }, { scopes: ['channel:write'] });
    assert.deepEqual(scope, { ok: false, code: 'insufficient_scope', message: 'This app was not given the channel:read permission.', requiredScopes: ['channel:read'] });
    assert.deepEqual(state.checks, [], 'scope before permissions');
    const write = await call('create_command', { body: 'hi' }, { scopes: ['channel:read'] });
    assert.deepEqual(write.ok === false && write.requiredScopes, ['channel:write']);
    assert.equal((await call('search_docs', {}, { scopes: [] })).ok, true, 'knowledge needs no scope');

    state.grants = new Set(['commands:view']);
    assert.equal((await call('create_command', { nobody: true }) as { code: string }).code, 'permission_denied', 'permissions before input');
    state.grants = '*';
    assert.equal((await call('update_tts_settings', {}) as { code: string }).code, 'plan_required');
    const invalid = await call('create_command', { nobody: true });
    assert.deepEqual(invalid, { ok: false, code: 'invalid_input', message: 'body is required' });
    assert.deepEqual(state.credits, [], 'nothing held before the input is valid');
    assert.equal(applied.length, 0);
});

test('a cancelled call does nothing', async () => {
    const abort = new AbortController();
    abort.abort();
    assert.equal((await call('get_command', { name: 'x' }, {}, abort.signal) as { code: string }).code, 'failed');
    assert.equal(state.accessCalls, 0);
});

// ---------------------------------------------------------------------------
// Credits on reads
// ---------------------------------------------------------------------------

test('reads: held, then charged only when they returned data', async () => {
    const ok = await call('get_command', { name: 'x' });
    assert.deepEqual(ok, { ok: true, result: { untrusted_data: { reply: 'hi' } }, charged: 1 }, 'untrusted_data kept');
    assert.deepEqual(kinds(), ['reserve', 'settle']);
    assert.deepEqual(state.credits[1], ['settle', state.credits[0][3], 'get_command', 'mcp']);

    state.credits = [];
    const missing = await call('get_command', { name: 'missing' });
    assert.deepEqual(missing, { ok: true, result: { found: false }, charged: 0 });
    assert.deepEqual(kinds(), ['reserve', 'release']);

    state.credits = [];
    assert.equal((await call('list_commands') as { code: string }).code, 'failed');
    assert.deepEqual(kinds(), ['reserve', 'release']);
    assert.ok(state.logged.some((entry) => entry.data.function === 'mcp.tool'));

    state.credits = [];
    assert.deepEqual(await call('search_docs'), { ok: true, result: { untrusted_data: { rows: [1, 2] } }, charged: 0 });
    assert.deepEqual(state.credits, [], 'free: no hold at all');
});

test('credit errors stop the call before the tool runs', async () => {
    let ran = 0;
    hooks.run = () => { ran++; };
    state.reserveError = new CreditError('credits_exhausted');
    assert.equal((await call('create_command', { body: 'hi' }) as { code: string }).code, 'credits_exhausted');
    state.reserveError = new CreditError('credits_unavailable');
    assert.equal((await call('create_command', { body: 'hi' }) as { code: string }).code, 'credits_unavailable');
    state.reserveError = new TypeError('bad operation id');
    assert.equal((await call('create_command', { body: 'hi' }) as { code: string }).code, 'credits_unavailable');
    assert.ok(state.logged.some((entry) => entry.data.function === 'mcp.reserveCredits'));
    assert.equal(ran, 0);
    assert.deepEqual(kinds(), ['reserve', 'reserve', 'reserve']);
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

test('a write applies at once after a fresh check, is logged with source mcp, and is charged', async () => {
    const outcome = await call('create_command', { body: '$(user) rolled $(random 6)' });
    assert.equal(outcome.ok, true);
    const ok = outcome as Extract<typeof outcome, { ok: true }>;
    assert.equal(ok.charged, 1);
    assert.equal(ok.undoable, true);
    assert.match(ok.changeId!, /^[a-f0-9]{24}$/);
    assert.deepEqual(ok.result, {
        applied: true, change: { untrusted_data: { title: 'Create command !x', target: '!x', before: null, after: { Reply: '$(user) rolled $(random 6)' } } },
        warnings: ['w'], result: { created: true }, changeId: ok.changeId, undoable: true,
    });
    assert.deepEqual(kinds(), ['reserve', 'settle']);
    assert.equal(state.accessCalls, 2, 'access read again right before the write');
    assert.deepEqual(state.checks.filter((check) => check.fresh).map((check) => check.permissions), [['commands:manage']]);

    const { ctx } = applied[0];
    assert.equal(ctx.callId, ctx.turnId);
    assert.equal(ctx.userMessage, 'Via Claude (MCP)');
    const row = changesDb.store.get(ok.changeId!)!;
    assert.deepEqual(row.source, { surface: 'mcp', clientId: 'https://claude.ai/oauth/mcp-client', clientName: 'Claude' });
    assert.deepEqual(row.actor, { id: ADMIN, login: 'helper', displayName: 'Helper', role: 'admin' });
    assert.equal(row.request, 'Via Claude (MCP)');
    assert.equal(row.sessionId, 'sess-1');
    assert.equal(row.turnId, state.credits[0][3]);
    assert.equal(row.callId, row.turnId);
    assert.equal(row.tool, 'create_command');
    assert.deepEqual(row.undo, { id: 'c1' });

    // The website's Changes list shows it and its Undo works (same tool name in the log).
    const listed = await listChanges(CHANNEL, { id: ADMIN, role: 'admin' });
    assert.deepEqual(listed.changes[0].source, { surface: 'mcp', clientId: 'https://claude.ai/oauth/mcp-client', clientName: 'Claude' });
    assert.equal(listed.changes[0].canUndo, true);
    const site = await undoChange(CHANNEL, ok.changeId!, { id: ADMIN, role: 'admin' }, (name) => siteTools.find((tool) => tool.name === name), () => ({ ...ctx, sessionId: '', turnId: '', can: async () => true }));
    assert.equal(site.alreadyUndone, false);
    assert.equal(changesDb.store.get(site.undoChangeId!)!.source.surface, 'site');
});

test('unsafe command text is refused before apply and not charged', async () => {
    const outcome = await call('create_command', { body: 'hi *(1 == 1 ? ok : $(ban $(touser)))' });
    assert.equal(outcome.ok === false && outcome.code, 'unsafe_content');
    assert.match((outcome as { message: string }).message, /\$\(ban\): can ban viewers.*website/);
    assert.equal(applied.length, 0);
    assert.deepEqual(kinds(), ['reserve', 'release']);

    const original = createCommand.executableFields;
    createCommand.executableFields = () => null;
    try {
        const opaque = await call('create_command', { body: 'hi' });
        assert.equal(opaque.ok === false && opaque.code, 'unsafe_content');
        assert.match((opaque as { message: string }).message, /website/);
    } finally {
        createCommand.executableFields = original;
    }
    assert.equal(applied.length, 0);
});

test('the fresh re-check before the write: access, permissions and plan', async () => {
    state.accessQueue = [state.access, null];
    assert.equal((await call('create_command', { body: 'hi' }) as { code: string }).code, 'no_access');
    hooks.run = () => { state.grants = new Set(['commands:view']); };
    assert.equal((await call('create_command', { body: 'hi' }) as { code: string }).code, 'permission_denied');
    hooks.run = null;
    state.grants = '*';
    const pro = { ...state.access!, plan: 'pro' as const };
    proTool.run = async () => ({ type: 'approval', proposal: { tool: 'update_tts_settings', title: 't', area: 'tts', target: { type: 'tts', id: null, label: 'TTS' }, before: null, after: null, effects: [], permissions: ['tts:manage'], payload: {} } });
    state.accessQueue = [pro, { ...pro, plan: 'premium' }];
    assert.equal((await call('update_tts_settings', {}) as { code: string }).code, 'plan_required');
    assert.equal(applied.length, 0);
    assert.deepEqual(kinds(), ['reserve', 'release', 'reserve', 'release', 'reserve', 'release']);
});

test('not charged: conflicts, errors and unknown outcomes', async () => {
    hooks.apply = 'conflict';
    const conflict = await call('create_command', { body: 'hi' });
    assert.deepEqual(conflict, { ok: false, code: 'conflict', message: 'Not applied: !x was created by someone else' });
    hooks.apply = 'throw';
    assert.equal((await call('create_command', { body: 'hi' }) as { code: string }).code, 'outcome_unknown');
    assert.ok(state.logged.some((entry) => entry.level === 'error' && entry.data.function === 'mcp.apply'));
    assert.deepEqual(kinds(), ['reserve', 'release', 'reserve', 'release']);
    assert.equal(changesDb.store.size, 0);
});

// Review 2026-11-14 (P2): a started write is never abandoned, and a late one is charged once if it lands.
test('a client abort never abandons a write that started: it finishes, is logged and charged', async () => {
    hooks.apply = 'slow';
    const abort = new AbortController();
    const pending = call('create_command', { body: 'hi' }, {}, abort.signal);
    await flush();
    assert.equal(applied.length, 1);
    abort.abort();
    await flush();
    assert.deepEqual(kinds(), ['reserve'], 'still waiting for the write');
    finishSlow!();
    const outcome = await pending;
    assert.equal(outcome.ok, true);
    assert.equal((outcome as { charged: number }).charged, 1);
    assert.deepEqual(kinds(), ['reserve', 'settle']);
    assert.equal(changesDb.store.size, 1);
    assert.equal([...changesDb.store.values()][0].source.surface, 'mcp');
});

test('a write over 120 s is unknown; its hold is settled once if it lands later, released if it fails', async () => {
    for (const ending of ['lands', 'fails'] as const) {
        state.credits = [];
        changesDb.store.clear();
        hooks.apply = ending === 'lands' ? 'slow' : 'slowFail';
        mock.timers.enable({ apis: ['setTimeout'] });
        let outcome;
        try {
            const pending = call('create_command', { body: 'hi' });
            await flush();
            mock.timers.tick(120_000);
            outcome = await pending;
        } finally {
            mock.timers.reset();
        }
        assert.equal(outcome.ok === false && outcome.code, 'outcome_unknown', ending);
        assert.match((outcome as { message: string }).message, /took too long.*charged only if it lands/);
        assert.deepEqual(kinds(), ['reserve'], 'the hold waits for the write');
        if (ending === 'lands') finishSlow!(); else failSlow!();
        await flush();
        assert.deepEqual(kinds(), ['reserve', ending === 'lands' ? 'settle' : 'release'], ending);
        assert.equal(state.credits[1][1], state.credits[0][3], 'same operation id');
        assert.equal(changesDb.store.size, ending === 'lands' ? 1 : 0, 'a landed write is logged');
        await flush();
        assert.equal(state.credits.length, 2, 'exactly once');
    }
});

test('stored text a change makes reachable is refused with its own message; a pin reaches apply', async () => {
    const original = createCommand.executableFields;
    try {
        createCommand.executableFields = () => ({ texts: ['hi'], stored: ['ok', '*(1 == 1 ? x : $(ban $(user)))'], where: 'in this command' });
        const outcome = await call('create_command', { body: 'hi' });
        assert.deepEqual(outcome, { ok: false, code: 'unsafe_content', message: 'Not applied: some stored text in this command can act on your stream ($(ban): can ban viewers); edit it on the website.' });
        assert.equal(applied.length, 0);
        createCommand.executableFields = () => ({ texts: ['hi'], stored: ['ok $(user)'], pinned: { state: 'p1' } });
        assert.equal((await call('create_command', { body: 'hi' })).ok, true);
        assert.deepEqual(applied[0].proposal.payload.pinned, { state: 'p1' });
    } finally {
        createCommand.executableFields = original;
    }
});

test('change log down: still applied and charged, but not undoable, with a note; retries reuse one id', async () => {
    const create = SiteAgentChangeSchema.create;
    let attempts = 0;
    (SiteAgentChangeSchema as unknown as { create: unknown }).create = async () => { attempts++; throw new Error('mongo down'); };
    try {
        const outcome = await call('create_command', { body: 'hi' });
        assert.equal(outcome.ok, true);
        const ok = outcome as Extract<typeof outcome, { ok: true }>;
        assert.equal(ok.undoable, false);
        assert.equal(ok.changeId, undefined);
        assert.equal(ok.charged, 1);
        assert.match(String((ok.result as { note?: string }).note), /change log/);
        assert.equal(attempts, 3);
        assert.ok(state.logged.some((entry) => entry.data.function === 'mcp.recordChange'));
        assert.deepEqual(kinds(), ['reserve', 'settle']);

        const ids: string[] = [];
        attempts = 0;
        (SiteAgentChangeSchema as unknown as { create: unknown }).create = async (fields: { _id: unknown }) => {
            ids.push(String(fields._id));
            if (++attempts === 1) throw new Error('blip');
            return create.call(SiteAgentChangeSchema, fields);
        };
        const retried = await call('create_command', { body: 'hi' }) as Extract<typeof outcome, { ok: true }>;
        assert.equal(retried.undoable, true);
        assert.equal(ids.length, 2);
        assert.equal(ids[0], ids[1]);
        assert.equal(retried.changeId, ids[0]);
    } finally {
        (SiteAgentChangeSchema as unknown as { create: unknown }).create = create;
    }
});

test('a change without restore data applies but is not undoable', async () => {
    hooks.apply = 'noUndo';
    const outcome = await call('create_command', { body: 'hi' }) as { ok: true; undoable: boolean; changeId?: string };
    assert.equal(outcome.undoable, false);
    assert.ok(outcome.changeId);
});

test('a write tool\'s plain result (already set, needs full access…) is not charged', async () => {
    state.grants = '*';
    state.access = { ...state.access!, plan: 'pro' };
    proTool.run = async () => ({ type: 'result', result: { unchanged: true } });
    assert.deepEqual(await call('update_tts_settings', {}), { ok: true, result: { unchanged: true }, charged: 0 });
    assert.deepEqual(kinds(), ['reserve', 'release']);
});

// ---------------------------------------------------------------------------
// Listing and context
// ---------------------------------------------------------------------------

test('listing: allowlist ∩ the requester\'s tools ∩ the token\'s scopes, with annotations and prices', async () => {
    state.grants = new Set(['commands:view']);
    const reads = await listMcpTools(principal({ scopes: ['channel:read'] }));
    assert.deepEqual(reads.map((tool) => tool.name), ['search_docs', 'list_commands', 'get_command', 'get_settings', 'list_recent_changes']);
    const docs = reads[0];
    assert.equal(docs.credits, 0);
    assert.doesNotMatch(docs.description, /credit/);
    assert.deepEqual(docs.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.match(reads[1].description, / Costs 1 AI credit from the channel\.$/);
    assert.deepEqual(reads[1].inputSchema, { type: 'object', properties: {} });

    state.grants = new Set(['commands:view', 'commands:manage']);
    const all = await listMcpTools(principal());
    const names = all.map((tool) => tool.name);
    assert.ok(names.includes('create_command') && names.includes('delete_command') && names.includes('undo_change'));
    for (const hidden of ['update_tts_settings', 'update_ai_personality', 'send_test_alert']) assert.ok(!names.includes(hidden), hidden);
    const create = all.find((tool) => tool.name === 'create_command')!;
    assert.match(create.description, /applies right away/);
    assert.match(create.description, /reply functions/);
    // This fake declares no mcpAnnotations: a write then gets the spec's cautious hints.
    assert.deepEqual(create.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    assert.equal(all.find((tool) => tool.name === 'delete_command')!.annotations.destructiveHint, true);
    assert.equal(all.find((tool) => tool.name === 'undo_change')!.annotations.destructiveHint, true);

    state.access = null;
    assert.deepEqual(await listMcpTools(principal()), []);
});

test('createMcpToolContext: fresh access, the requester from users.accounts, the OAuth session and client', async () => {
    const signal = new AbortController().signal;
    const ctx = (await createMcpToolContext(principal(), { operationId: 'op-x', signal }))!;
    assert.deepEqual({ ...ctx, can: undefined }, {
        channelId: CHANNEL, channelLogin: 'chan', requester: { id: ADMIN, login: 'helper', displayName: 'Helper' }, role: 'admin', plan: 'premium',
        lang: 'en', sessionId: 'sess-1', turnId: 'op-x', callId: 'op-x', userMessage: 'Via Claude (MCP)', page: null, signal, can: undefined,
        mcp: { clientId: 'https://claude.ai/oauth/mcp-client', clientName: 'Claude', scopes: ALL_SCOPES },
    });
    assert.equal(await ctx.can(['commands:view']), true);
    assert.equal(await ctx.can(['tts:view']), false);
    state.access = { ...state.access!, savedLang: 'es' };
    assert.equal((await createMcpToolContext(principal(), { operationId: 'op-y', signal }))!.lang, 'es');
    state.access = null;
    assert.equal(await createMcpToolContext(principal(), { operationId: 'op-z', signal }), null);
});

// ---------------------------------------------------------------------------
// MCP-only change-log tools
// ---------------------------------------------------------------------------

async function logged(actor: { id: string; role: 'owner' | 'admin' }, tool: string, area: string, extra: Record<string, unknown> = {}) {
    return recordChange({
        channelId: CHANNEL, actor: { ...actor, login: actor.id === ADMIN ? 'helper' : actor.id === OTHER ? 'other' : 'chan', displayName: 'X' },
        request: 'please', tool, title: `${tool} change`, effects: [],
        change: { area, target: { type: 't', id: 'c1', label: '!x' }, before: { a: 1 }, after: { a: 2 }, undo: { id: 'c1' }, summary: '' }, ...extra,
    });
}

test('list_recent_changes: owner/admin rules, then the requester\'s current view permission per area', async () => {
    const mine = await logged({ id: ADMIN, role: 'admin' }, 'create_command', 'commands', { source: { surface: 'mcp', clientId: 'c', clientName: 'Cursor' } });
    const myTts = await logged({ id: ADMIN, role: 'admin' }, 'update_tts_settings', 'tts');
    const theirs = await logged({ id: OTHER, role: 'admin' }, 'create_command', 'commands');
    const personality = await logged({ id: CHANNEL, role: 'owner' }, 'update_ai_personality', 'ai_personality');

    const admin = await call('list_recent_changes', {}, { scopes: ['channel:read'] }) as { ok: true; result: { changes: Array<{ id: string; via: string; canUndo: boolean; undoOnWebsite?: boolean; details: unknown }> }; charged: number };
    assert.deepEqual(admin.result.changes.map((change) => change.id), [mine], 'own changes only, and not the tts one without tts:view');
    assert.equal(admin.result.changes[0].via, 'Cursor (MCP)');
    assert.equal(admin.result.changes[0].canUndo, true);
    assert.ok('untrusted_data' in (admin.result.changes[0].details as object));
    assert.equal(admin.charged, 1);

    state.grants = new Set(['commands:view', 'tts:view']);
    const withTts = await call('list_recent_changes', {}, { scopes: ['channel:read'] }) as typeof admin;
    assert.deepEqual(withTts.result.changes.map((change) => change.id), [myTts, mine]);

    state.grants = '*'; // the owner holds every permission
    const owner = await call('list_recent_changes', {}, { requesterId: CHANNEL, scopes: ['channel:read'] }) as typeof admin;
    assert.deepEqual(owner.result.changes.map((change) => change.id), [personality, theirs, myTts, mine]);
    assert.equal(owner.result.changes[0].canUndo, false, 'site-only tool: undo on the website');
    assert.equal(owner.result.changes[1].via, 'website assistant');
    // A website change: listed, but undone on the website (its undo would restore text the guard never saw).
    assert.equal(owner.result.changes[1].canUndo, false);
    assert.equal(owner.result.changes[1].undoOnWebsite, true);
    assert.equal(owner.result.changes[3].canUndo, true, 'the MCP change');
    assert.equal(owner.result.changes[3].undoOnWebsite, undefined);
});

const VIA_MCP = { source: { surface: 'mcp' as const, clientId: 'https://claude.ai/oauth/mcp-client', clientName: 'Claude' } };

test('undo_change: own MCP changes only, the original tool\'s permissions and plan, logged as mcp', async () => {
    const mine = await logged({ id: ADMIN, role: 'admin' }, 'create_command', 'commands', VIA_MCP);
    const theirs = await logged({ id: OTHER, role: 'admin' }, 'create_command', 'commands', VIA_MCP);
    const personality = await logged({ id: ADMIN, role: 'admin' }, 'update_ai_personality', 'ai_personality', VIA_MCP);
    const tts = await logged({ id: ADMIN, role: 'admin' }, 'update_tts_settings', 'tts', VIA_MCP);
    // Review 2026-11-14 (P1): a site-assistant change's undo would restore content the guard never saw.
    const fromSite = await logged({ id: ADMIN, role: 'admin' }, 'create_command', 'commands');
    state.prices.undo_change = 0;

    const site = await call('undo_change', { changeId: fromSite });
    assert.deepEqual(site, { ok: false, code: 'permission_denied', message: 'This change was made on the website: undo this on the website (Changes list in the assistant panel).' });
    assert.equal(undone.length, 0);

    assert.equal((await call('undo_change', { changeId: mine }, { scopes: ['channel:read'] }) as { code: string }).code, 'insufficient_scope');
    assert.equal((await call('undo_change', { changeId: 'nope' }) as { code: string }).code, 'invalid_input');
    assert.equal((await call('undo_change', { changeId: theirs }) as { code: string }).code, 'invalid_input', 'another admin\'s change looks missing');
    const siteOnly = await call('undo_change', { changeId: personality });
    assert.equal(siteOnly.ok === false && siteOnly.code, 'permission_denied');
    assert.match((siteOnly as { message: string }).message, /website/);
    state.grants = '*';
    assert.equal((await call('undo_change', { changeId: tts }) as { code: string }).code, 'plan_required', 'update_tts_settings is Pro here');
    state.grants = new Set(['commands:view']);
    assert.equal((await call('undo_change', { changeId: mine }) as { code: string }).code, 'permission_denied');
    assert.equal(undone.length, 0);

    state.grants = new Set(['commands:manage']);
    hooks.undoConflict = true;
    assert.equal((await call('undo_change', { changeId: mine }) as { code: string }).code, 'conflict');
    hooks.undoConflict = false;
    state.checks = [];
    const done = await call('undo_change', { changeId: mine }) as { ok: true; result: { applied: boolean; result: { undone: boolean; undoChangeId: string } }; charged: number; undoable: boolean };
    assert.equal(done.result.applied, true);
    assert.equal(done.result.result.undone, true);
    assert.equal(done.charged, 0);
    assert.equal(done.undoable, false);
    const reload = state.checks.findIndex((check) => check.fresh);
    assert.ok(reload >= 0 && state.checks.slice(reload).some((check) => check.permissions.includes('commands:manage')), 'original permissions checked on freshly loaded grants');
    const record = changesDb.store.get(done.result.result.undoChangeId)!;
    assert.equal(String(record.undoOf), mine);
    assert.deepEqual(record.source, { surface: 'mcp', clientId: 'https://claude.ai/oauth/mcp-client', clientName: 'Claude' });
    assert.ok(changesDb.store.get(mine)!.undoneAt);

    const again = await call('undo_change', { changeId: mine });
    assert.deepEqual(again, { ok: true, result: { alreadyUndone: true, message: 'This change was already undone. Nothing was changed.' }, charged: 0 });
    assert.equal((await call('undo_change', { changeId: done.result.result.undoChangeId }) as { code: string }).code, 'invalid_input', 'an undo can\'t be undone');
});

// ---------------------------------------------------------------------------
// v1.1: the connection re-check before a write, the call log, parallel calls
// ---------------------------------------------------------------------------

test('a connection revoked or blocked since the call started: the write is refused before apply, nothing charged', async () => {
    let checked = 0;
    const outcome = await call('create_command', { body: 'hi $(user)' }, { stillAuthorized: async () => { checked++; return false; } });
    assert.equal(outcome.ok === false && outcome.code, 'no_access');
    assert.match(outcome.ok === false ? outcome.message : '', /connection was removed or blocked/);
    assert.equal(checked, 1);
    assert.equal(applied.length, 0);
    assert.deepEqual(kinds(), ['reserve', 'release']);
    // A still-valid connection applies.
    const ok = await call('create_command', { body: 'hi $(user)' }, { stillAuthorized: async () => true });
    assert.equal(ok.ok, true);
    assert.equal(applied.length, 1);
    // A failing check (database down) never applies either.
    const broken = await call('create_command', { body: 'hi $(user)' }, { stillAuthorized: async () => { throw new Error('db down'); } });
    assert.equal(broken.ok === false && broken.code, 'failed');
    assert.equal(applied.length, 1);
});

test('every call gets one log row: tool, who, app, outcome code, reason and credits; unknown tools too', async () => {
    await call('get_command', { name: 'x' });
    await call('create_command', { body: '$(ban &p1)' });
    await call('nope');
    assert.equal(state.callLog.length, 3);
    const [read, unsafe, unknown] = state.callLog;
    assert.equal(read.tool, 'get_command');
    assert.equal(read.kind, 'read');
    assert.equal(read.code, null);
    assert.equal(read.charged, 1);
    assert.equal(read.channelLogin, 'chan');
    assert.deepEqual(read.user, { id: ADMIN, login: 'helper', role: 'admin' });
    assert.deepEqual(read.client, { id: 'https://claude.ai/oauth/mcp-client', name: '  Claude\n' });
    assert.equal(read.sessionId, 'sess-1');
    assert.equal(typeof read.startedAt, 'number');
    assert.equal(unsafe.code, 'unsafe_content');
    assert.match(String(unsafe.reason), /Not applied/);
    assert.equal(unsafe.charged, 0);
    assert.equal(unknown.code, 'unknown_tool');
    assert.equal(unknown.tool, 'nope');
});

test('credit refusals say why: out of credits (with the Credits link), busy, not set up', async () => {
    for (const [code, pattern] of [['credits_exhausted', /out of AI credits.*domdimabot\.com\/chan\/credits/], ['credits_busy', /Too many paid tool calls/],
        ['credits_not_set_up', /not set up for this channel/], ['credits_unavailable', /can't be checked right now/]] as const) {
        state.reserveError = new CreditError(code as never);
        const outcome = await call('get_command', { name: 'x' });
        assert.equal(outcome.ok === false && outcome.code, code);
        assert.match(outcome.ok === false ? outcome.message : '', pattern);
    }
});

test('parallel calls of one connection: up to 12 run at once, the rest wait their turn and all finish', async () => {
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    hooks.run = () => undefined;
    const slow = siteTools.find((tool) => tool.name === 'search_docs')!;
    const original = slow.run;
    slow.run = async () => { running++; peak = Math.max(peak, running); await gate; running--; return { type: 'result', result: { hits: [] } }; };
    try {
        const calls = Array.from({ length: 20 }, () => call('search_docs', {}));
        await flush(50);
        assert.equal(running, 12);
        release();
        const outcomes = await Promise.all(calls);
        assert.ok(outcomes.every((outcome) => outcome.ok));
        assert.equal(peak, 12);
        // Another connection is not held up by this one.
        assert.equal((await call('search_docs', {}, { sessionId: 'sess-2' })).ok, true);
    } finally {
        slow.run = original;
    }
});
