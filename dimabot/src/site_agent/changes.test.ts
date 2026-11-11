import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { installFakeModel } from './tools/write/fake_store.testutil.js';
import type { AgentTool, ToolContext } from './types.js';

const { SiteAgentChangeSchema, SITE_AGENT_CHANGE_TTL_DAYS } = await import('./changes.schema.js');
const { recordChange, listChanges, undoChange, changeFromApply, ChangeNotFoundError, ChangeNotUndoableError, ChangeForbiddenError } = await import('./changes.js');
const { ToolConflictError } = await import('./types.js');

const CHANNEL = '1001';
const OWNER = { id: CHANNEL, login: 'owner_login', displayName: 'Owner', role: 'owner' as const };
const ADMIN = { id: '2002', login: 'helper', displayName: 'Helper', role: 'admin' as const };
const OTHER_ADMIN = { id: '3003', login: 'other', displayName: 'Other', role: 'admin' as const };

const db = installFakeModel(SiteAgentChangeSchema);

const undoCalls: unknown[] = [];
let undoImpl: (change: unknown) => Promise<void> = async () => {};
const tool = {
    name: 'update_command', permissions: ['commands:manage'],
    async undo(change: unknown) { undoCalls.push(change); await undoImpl(change); },
} as unknown as AgentTool;
const noUndo = { name: 'navigate', permissions: [] } as unknown as AgentTool;
const tools: Record<string, AgentTool> = { update_command: tool, navigate: noUndo };
const resolve = (name: string) => tools[name];

function context(actor: typeof OWNER | typeof ADMIN | typeof OTHER_ADMIN, overrides: Partial<ToolContext> = {}): () => Omit<ToolContext, 'callId'> {
    return () => ({
        channelId: CHANNEL, channelLogin: 'owner_login', requester: { id: actor.id, login: actor.login, displayName: actor.displayName },
        role: actor.role, plan: 'premium', lang: 'en', sessionId: '', turnId: '', userMessage: '', page: null,
        signal: new AbortController().signal, can: async () => true, ...overrides,
    });
}

async function record(actor: typeof OWNER | typeof ADMIN | typeof OTHER_ADMIN, title: string, extra: Partial<Parameters<typeof recordChange>[0]> = {}) {
    return recordChange({
        channelId: CHANNEL, actor, sessionId: 's1', turnId: 't1', callId: 'c1', request: `please ${title}`, tool: 'update_command', title,
        effects: ['Can ban viewers'],
        change: { area: 'commands', target: { type: 'command', id: 'abc', label: '!dice' }, before: { Reply: 'old' }, after: { Reply: 'new' }, undo: { op: 'update', secret: 'restore-data' }, summary: 'Updated !dice' },
        ...extra,
    });
}

beforeEach(() => {
    db.store.clear();
    undoCalls.length = 0;
    undoImpl = async () => {};
});

test('recordChange keeps the request, the private undo data and a 90-day expiry', async () => {
    const at = new Date('2026-11-11T00:00:00Z');
    const id = await record(ADMIN, 'Update command !dice', { request: 'x'.repeat(5000), at });
    const stored = db.store.get(id)!;
    assert.equal(stored.request.length, 2000);
    assert.equal(stored.expiresAt.getTime(), at.getTime() + SITE_AGENT_CHANGE_TTL_DAYS * 86_400_000);
    assert.deepEqual(stored.undo, { op: 'update', secret: 'restore-data' });
    assert.equal(stored.undoable, true);
    assert.deepEqual(stored.actor, ADMIN);
    assert.equal(stored.sessionId, 's1');
    const none = await record(ADMIN, 'No undo', { change: { area: 'commands', target: { type: 'command', id: null, label: '!x' }, before: null, after: null, undo: null, summary: '' } });
    assert.equal(db.store.get(none)!.undoable, false);
    const indexes = SiteAgentChangeSchema.schema.indexes();
    assert.ok(indexes.some(([fields, options]) => 'expiresAt' in fields && options?.expireAfterSeconds === 0));
    assert.equal(SiteAgentChangeSchema.collection.collectionName, 'site_agent_changes');
});

test('changeFromApply takes who, where and what from the turn context and proposal', () => {
    const ctx = { ...context(ADMIN)(), callId: 'c9', sessionId: 's9', turnId: 't9', userMessage: 'make it' } as ToolContext;
    const input = changeFromApply(ctx, { tool: 'create_command', title: 'Create command !x', area: 'commands', target: { type: 'command', id: null, label: '!x' }, before: null, after: {}, effects: ['e'], permissions: [], payload: {} },
        { area: 'commands', target: { type: 'command', id: '1', label: '!x' }, before: null, after: {}, undo: {}, summary: '' });
    assert.deepEqual({ ...input, change: undefined }, {
        channelId: CHANNEL, actor: ADMIN, sessionId: 's9', turnId: 't9', callId: 'c9', request: 'make it', tool: 'create_command', title: 'Create command !x', effects: ['e'], change: undefined,
    });
});

test('listChanges: owner sees the whole channel, an admin only their own; newest first, paged, never undo data', async () => {
    const a = await record(ADMIN, 'first');
    const b = await record(OTHER_ADMIN, 'second');
    const c = await record(OWNER, 'third');
    await recordChange({ channelId: '9999', actor: OWNER, request: '', tool: 'update_command', title: 'elsewhere', effects: [], change: { area: 'commands', target: { type: 'command', id: null, label: '' }, before: null, after: null, undo: null, summary: '' } });

    const owner = await listChanges(CHANNEL, { id: OWNER.id, role: 'owner' });
    assert.deepEqual(owner.changes.map((change) => change.id), [c, b, a]);
    assert.equal(owner.next, null);
    assert.ok(owner.changes.every((change) => change.canUndo));
    const view = owner.changes[2];
    assert.deepEqual(Object.keys(view).sort(), ['actor', 'after', 'area', 'at', 'before', 'canUndo', 'effects', 'id', 'request', 'target', 'title', 'undone']);
    assert.deepEqual(view.actor, ADMIN);
    assert.equal(view.request, 'please first');
    assert.deepEqual(view.before, { Reply: 'old' });
    assert.equal(view.undone, null);
    assert.equal(typeof view.at, 'number');
    assert.doesNotMatch(JSON.stringify(owner), /restore-data/);

    const admin = await listChanges(CHANNEL, { id: ADMIN.id, role: 'admin' });
    assert.deepEqual(admin.changes.map((change) => change.id), [a]);

    const page = await listChanges(CHANNEL, { id: OWNER.id, role: 'owner' }, undefined, 2);
    assert.deepEqual(page.changes.map((change) => change.id), [c, b]);
    assert.equal(page.next, b);
    const rest = await listChanges(CHANNEL, { id: OWNER.id, role: 'owner' }, page.next, 2);
    assert.deepEqual(rest.changes.map((change) => change.id), [a]);
    assert.equal(rest.next, null);
    assert.deepEqual(await listChanges(CHANNEL, { id: OWNER.id, role: 'owner' }, 'not-a-cursor'), { changes: [], next: null });
});

test('undoChange: ownership rules; owner undoes anyone, admin only their own', async () => {
    const mine = await record(ADMIN, 'Update command !dice');
    const theirs = await record(OTHER_ADMIN, 'Update command !coin');
    for (const id of ['nope', 'aaaaaaaaaaaaaaaaaaaaaaaa', theirs]) {
        await assert.rejects(undoChange(CHANNEL, id, { id: ADMIN.id, role: 'admin' }, resolve, context(ADMIN)),
            (error: unknown) => error instanceof ChangeNotFoundError && error.status === 404);
    }
    await assert.rejects(undoChange('9999', mine, { id: OWNER.id, role: 'owner' }, resolve, context(OWNER)), ChangeNotFoundError);
    assert.equal(undoCalls.length, 0);

    const result = await undoChange(CHANNEL, theirs, { id: OWNER.id, role: 'owner' }, resolve, context(OWNER));
    assert.equal(result.alreadyUndone, false);
    assert.equal(result.canUndo, false);
    assert.deepEqual(result.undone?.by, { id: OWNER.id, login: OWNER.login });
    assert.deepEqual(undoCalls, [{ undo: { op: 'update', secret: 'restore-data' }, after: { Reply: 'new' }, target: { type: 'command', id: 'abc', label: '!dice' } }]);

    const undoRecord = db.store.get(result.undoChangeId!)!;
    assert.equal(String(undoRecord.undoOf), theirs);
    assert.equal(undoRecord.title, 'Undo: Update command !coin');
    assert.deepEqual(undoRecord.before, { Reply: 'new' });
    assert.deepEqual(undoRecord.after, { Reply: 'old' });
    assert.equal(undoRecord.undo, null);
    assert.deepEqual(undoRecord.actor, OWNER);

    // Already undone: nothing happens again.
    const again = await undoChange(CHANNEL, theirs, { id: OWNER.id, role: 'owner' }, resolve, context(OWNER));
    assert.equal(again.alreadyUndone, true);
    assert.equal(undoCalls.length, 1);
    // The undo record itself can't be undone; the list shows it without the button.
    await assert.rejects(undoChange(CHANNEL, result.undoChangeId!, { id: OWNER.id, role: 'owner' }, resolve, context(OWNER)), ChangeNotUndoableError);
    const listed = await listChanges(CHANNEL, { id: OWNER.id, role: 'owner' });
    assert.equal(listed.changes.find((change) => change.id === result.undoChangeId)?.canUndo, false);
    assert.equal(listed.changes.find((change) => change.id === theirs)?.undone?.by.id, OWNER.id);

    // An admin undoes their own change.
    const own = await undoChange(CHANNEL, mine, { id: ADMIN.id, role: 'admin' }, resolve, context(ADMIN, { lang: 'es' }));
    assert.equal(own.alreadyUndone, false);
    assert.equal(db.store.get(own.undoChangeId!)!.title, 'Deshacer: Update command !dice');
});

test('undoChange: conflicts leave the change undoable; permissions, plan and tool support are re-checked', async () => {
    const id = await record(ADMIN, 'Update command !dice');
    undoImpl = async () => { throw new ToolConflictError('!dice changed after the assistant\'s change (reply)'); };
    await assert.rejects(undoChange(CHANNEL, id, { id: ADMIN.id, role: 'admin' }, resolve, context(ADMIN)), ToolConflictError);
    assert.equal(db.store.get(id)!.undoneAt, null);
    assert.equal(db.store.get(id)!.undoLockUntil, null, 'lock released for a retry');

    await assert.rejects(undoChange(CHANNEL, id, { id: ADMIN.id, role: 'admin' }, resolve, context(ADMIN, { can: async () => false })),
        (error: unknown) => error instanceof ChangeForbiddenError && error.status === 403);
    tools.update_command = Object.assign(Object.create(tool), { minPlan: 'pro' });
    await assert.rejects(undoChange(CHANNEL, id, { id: ADMIN.id, role: 'admin' }, resolve, context(ADMIN)), ChangeForbiddenError);
    tools.update_command = tool;
    await assert.rejects(undoChange(CHANNEL, id, { id: ADMIN.id, role: 'admin' }, resolve, context(OWNER)), ChangeForbiddenError, 'context must be the viewer');

    const navigate = await record(ADMIN, 'Open page', { tool: 'navigate' });
    await assert.rejects(undoChange(CHANNEL, navigate, { id: ADMIN.id, role: 'admin' }, resolve, context(ADMIN)),
        (error: unknown) => error instanceof ChangeNotUndoableError && error.status === 409);

    undoImpl = async () => {};
    const done = await undoChange(CHANNEL, id, { id: ADMIN.id, role: 'admin' }, resolve, context(ADMIN));
    assert.equal(done.alreadyUndone, false);
});

test('undoChange: two clicks at once run the undo only once', async () => {
    const id = await record(ADMIN, 'Update command !dice');
    let release!: () => void;
    undoImpl = () => new Promise<void>((resolveUndo) => { release = resolveUndo; });
    const first = undoChange(CHANNEL, id, { id: ADMIN.id, role: 'admin' }, resolve, context(ADMIN));
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    await assert.rejects(undoChange(CHANNEL, id, { id: OWNER.id, role: 'owner' }, resolve, context(OWNER)), /being undone/);
    release();
    assert.equal((await first).alreadyUndone, false);
    assert.equal(undoCalls.length, 1);
    assert.equal((await undoChange(CHANNEL, id, { id: OWNER.id, role: 'owner' }, resolve, context(OWNER))).alreadyUndone, true);
});
