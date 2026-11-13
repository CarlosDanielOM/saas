import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import type { TurnRecord } from './store.js';

/**
 * In-memory stand-ins for the turn-log collection, the account check and Dragonfly: enough of their behaviour
 * (insert-only upsert, filtered $inc with arrayFilters, list pops) to prove the write orderings.
 */
type Doc = Record<string, any>;
const rows = new Map<string, Doc>();
const ops: { op: string; filter: Doc; update?: Doc; options?: Doc }[] = [];
const accounts = new Set<string>();
const hashes = new Map<string, Record<string, string>>();
const logged: unknown[] = [];
let sessionItems: unknown[] | Error = [];
let failWrites = false;
/** Updates that throw before failing stops (the next ones succeed). */
let failNextUpdates = 0;
/** Runs once when a reconcile update misses for lack of a row: puts a concurrent insert right after the miss. */
let afterMissingRow: (() => Promise<void>) | null = null;

const matches = (doc: Doc, filter: Doc): boolean => Object.entries(filter).every(([key, want]) => {
    if (key === '$or') return (want as Doc[]).some((part): boolean => matches(doc, part));
    const have = key.split('.').reduce<any>((value, part) => value?.[part], doc);
    if (want && typeof want === 'object' && '$gt' in want) return typeof have === 'number' && have > want.$gt;
    if (want && typeof want === 'object' && '$ne' in want) return Array.isArray(have) ? !have.includes(want.$ne) : have !== want.$ne;
    return Array.isArray(have) && typeof want !== 'object' ? have.includes(want) : have === want;
});

function applyInc(doc: Doc, inc: Doc, arrayFilters: Doc[] = []) {
    for (const [path, by] of Object.entries(inc)) {
        const array = /^(\w+)\.\$\[(\w+)\]\.(\w+)$/.exec(path);
        if (array) {
            const [, field, name, key] = array;
            const filter = arrayFilters.find((item) => Object.keys(item)[0].startsWith(`${name}.`))!;
            const [filterPath, filterValue] = Object.entries(filter)[0];
            for (const element of doc[field] ?? []) if (element[filterPath.slice(name.length + 1)] === filterValue) element[key] += by;
        } else doc[path] = (doc[path] ?? 0) + by;
    }
}

mock.module('./turn_log.schema.js', {
    namedExports: {
        TURN_LOG_MAX_TOOLS: 60, TURN_LOG_RETENTION_DAYS: 90, TURN_LOG_MESSAGE_MAX: 4000, TURN_LOG_ANSWER_MAX: 12000, TURN_LOG_STEERS_MAX: 10,
        TURN_LOG_STEER_MAX: 2000, TURN_LOG_TOOL_TEXT_MAX: 2000, TURN_LOG_TEXT_DAYS: 3,
        SiteAgentTurnLog: {
            updateMany: async (filter: Doc, update: Doc, options?: Doc) => {
                ops.push({ op: 'updateMany', filter, update, options });
                if (failWrites) throw new Error('mongo down');
                return { modifiedCount: 2 };
            },
            updateOne: async (filter: Doc, update: Doc, options?: Doc) => {
                ops.push({ op: 'updateOne', filter, update, options });
                if (failWrites) throw new Error('mongo down');
                if (failNextUpdates > 0 && !options?.upsert) { failNextUpdates--; throw new Error('mongo blip'); }
                const doc = rows.get(filter._id);
                if (!doc) {
                    if (!options?.upsert) {
                        const hook = afterMissingRow;
                        afterMissingRow = null;
                        await hook?.();
                        return { matchedCount: 0 };
                    }
                    rows.set(filter._id, structuredClone({ _id: filter._id, ...update.$setOnInsert }));
                    return { matchedCount: 0, upsertedCount: 1 };
                }
                if (!matches(doc, filter)) return { matchedCount: 0 };
                if (update.$set) Object.assign(doc, structuredClone(update.$set));
                if (update.$inc) applyInc(doc, update.$inc, options?.arrayFilters);
                if (update.$push) for (const [field, value] of Object.entries(update.$push)) (doc[field] ??= []).push(value);
                return { matchedCount: 1 };
            },
            exists: async (filter: Doc) => { const doc = rows.get(filter._id); return doc && matches(doc, filter) ? { _id: filter._id } : null; },
            deleteMany: async (filter: Doc) => {
                ops.push({ op: 'deleteMany', filter });
                let deleted = 0;
                for (const [id, doc] of rows) if (matches(doc, filter)) { rows.delete(id); deleted++; }
                return { deletedCount: deleted };
            },
        },
    },
});
mock.module('../schemas/users.schema.js', {
    defaultExport: { exists: async (filter: Doc) => (accounts.has(filter.accounts.$elemMatch.id) ? { _id: 'u' } : null) },
});
/** Sorted sets: key → member → score. */
const zsets = new Map<string, Map<string, number>>();
const hash = (key: string) => { if (!hashes.has(key)) hashes.set(key, {}); return hashes.get(key)!; };
const zset = (key: string) => { if (!zsets.has(key)) zsets.set(key, new Map()); return zsets.get(key)!; };
const zAdd = (key: string, entry: { score: number; value: string }, options?: { condition?: 'NX' | 'XX' }) => {
    const has = zset(key).has(entry.value);
    if ((options?.condition === 'NX' && has) || (options?.condition === 'XX' && !has)) return 0;
    zset(key).set(entry.value, entry.score);
    return has ? 0 : 1;
};
const hashExists = (key: string) => hashes.has(key) && Object.keys(hashes.get(key)!).length > 0;
/** Runs just before the atomic "unindex if empty" script, to put a concurrent write right before it. */
let beforeUnindex: (() => void) | null = null;
const fakeRedis = {
    hGet: async (key: string, field: string) => hashes.get(key)?.[field] ?? null,
    hGetAll: async (key: string) => ({ ...(hashes.get(key) ?? {}) }),
    hDel: async (key: string, field: string) => { const h = hashes.get(key); if (h) { delete h[field]; if (!Object.keys(h).length) hashes.delete(key); } return 1; },
    exists: async (key: string) => (hashExists(key) ? 1 : 0),
    zAdd: async (key: string, entry: { score: number; value: string }, options?: { condition?: 'NX' | 'XX' }) => zAdd(key, entry, options),
    zRangeByScore: async (key: string, _min: string, max: number, options: { LIMIT: { offset: number; count: number } }) => [...zset(key)]
        .filter(([, score]) => score <= max).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([member]) => member)
        .slice(options.LIMIT.offset, options.LIMIT.offset + options.LIMIT.count),
    /** The one script turn_log uses: remove the index entry only when the hash is absent, atomically. */
    eval: async (_script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) => {
        beforeUnindex?.();
        beforeUnindex = null;
        if (hashExists(keys[0])) return 0;
        return zset(keys[1]).delete(args[0]) ? 1 : 0;
    },
    multi() {
        const queued: (() => void)[] = [];
        const chain = {
            hSet: (key: string, field: string, value: string) => { queued.push(() => { hash(key)[field] = value; }); return chain; },
            zAdd: (key: string, entry: { score: number; value: string }, options?: { condition?: 'NX' | 'XX' }) => { queued.push(() => zAdd(key, entry, options)); return chain; },
            expire: () => chain,
            exec: async () => { for (const run of queued) run(); return []; },
        };
        return chain;
    },
};
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => fakeRedis } });
mock.module('./store.js', {
    namedExports: { snapshot: async () => { if (sessionItems instanceof Error) throw sessionItems; return { items: sessionItems, cursor: '0-0' }; } },
});
mock.module('../utils/logger.js', { namedExports: { warn: async (data: unknown) => { logged.push(data); }, error: async (data: unknown) => { logged.push(data); } } });

const { addReconciledStep, clipText, deleteTurnLogs, FORM_SUBMITTED, retryLateSteps, setTurnLogFeedback, toTurnLog, turnModelCosts, turnModels, turnUnits, writeTurnLog } = await import('./turn_log.js');

/** Kept for the operator: the exchange (with secrets masked). */
const KEPT = ['TEXT-MESSAGE-7f3', 'TEXT-STEER-91a', 'TEXT-ARGS-c22', 'TEXT-RESULT-5d0', 'https://api.example.test/x?key=', 'Authorization: ', 'wrote in chat'];
/** Never stored: secrets, e-mails, form values, page title, proposal payload, undo data, approval errors, row summaries. */
const NEVER = ['SECRETKEY123456', 'SECRETTOKEN123456', 'someone@example.com', 'FORMVALUE-8e8', 'NEVER-TITLE-e4b', 'NEVER-PROPOSAL-0aa', 'NEVER-PAYLOAD-1b2',
    'NEVER-UNDO-9c9', 'NEVER-SUMMARY-77b', 'NEVER-UI-3c1', 'NEVER-APPROVAL-4d4'];
const known = new Set(['search_docs', 'create_command', 'read_docs', 'get_command', 'recent_chat', 'show_ui']);
const extras = { knownTool: (name: string) => known.has(name) };
const HAIKU = 'anthropic/claude-haiku-5.5';
const LUNA = 'openai/gpt-6-luna';

/** A finished turn shaped like real ones: tool results that hold secrets and addresses, a submitted form. */
function markedTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
    const createdAt = Date.UTC(2026, 10, 13, 10, 0, 0);
    return {
        id: 'turn-1', sessionId: 'sess-1', channelId: '533538623', userId: '533538623', userLogin: 'cdom201', userDisplayName: 'CDOM201',
        role: 'owner', plan: 'pro', lang: 'es', page: { route: 'modules.tts', path: '/cdom201/modules/tts', title: 'NEVER-TITLE-e4b' },
        status: 'completed', revision: 9, inputRevision: 1, createdAt, startedAt: createdAt + 50, endedAt: createdAt + 9_000,
        userMessage: 'TEXT-MESSAGE-7f3 please', userItemId: 'item-1', mode: 'send', countedDay: '2026-11-13', level: 'expert', cost: 4, levelCost: 2,
        answeredSteps: 3, userAdded: true, lastPromptTokens: 0, lastPromptItems: 0, stopRequested: false, steps: 3, toolCallCount: 5, activeMs: 8_200,
        inputs: [{ id: 'in-1', text: 'TEXT-STEER-91a', at: createdAt + 100, applied: true, itemId: 'item-2', cost: 2, countedDay: '2026-11-13' }],
        calls: [
            { id: 'c1', name: 'search_docs', args: '{"q":"TEXT-ARGS-c22"}', state: 'done', itemId: 'i', inputRevision: 1, result: 'TEXT-RESULT-5d0 docs', summary: 'NEVER-SUMMARY-77b',
                startedAt: createdAt + 1_000, endedAt: createdAt + 1_250 },
            { id: 'c2', name: 'create_command', args: '{"name":"x"}', state: 'done', itemId: 'j', inputRevision: 1, result: 'applied',
                proposal: { title: 'NEVER-PROPOSAL-0aa', payload: { secret: 'NEVER-PAYLOAD-1b2' }, undo: { token: 'NEVER-UNDO-9c9' } } as never,
                approval: { state: 'applied', decidedAt: createdAt + 3_000, changeId: 'ch1', error: 'NEVER-APPROVAL-4d4' }, startedAt: createdAt + 2_000 },
            { id: 'c3', name: 'get_command', args: '{"name":"!weather"}', state: 'done', itemId: null, inputRevision: 1, startedAt: createdAt + 3_000, endedAt: createdAt + 3_010,
                result: '{"response":"$(urlfetch https://api.example.test/x?key=SECRETKEY123456)","headers":"Authorization: Bearer SECRETTOKEN123456"}' },
            { id: 'c4', name: 'recent_chat', args: '{}', state: 'done', itemId: null, inputRevision: 1, startedAt: createdAt + 4_000, endedAt: createdAt + 4_010,
                result: '<untrusted_data>viewer1: mail me at someone@example.com — wrote in chat</untrusted_data>' },
            // runUi puts the submitted values into the result sent to the model.
            { id: 'c5', name: 'show_ui', args: '{"title":"Pick","html":"<form></form>"}', state: 'done', itemId: 'k', inputRevision: 1, startedAt: createdAt + 5_000, endedAt: createdAt + 6_000,
                result: '{"submitted":true,"values":{"name":"FORMVALUE-8e8"}}', ui: { state: 'submitted', values: { name: 'NEVER-UI-3c1' } } },
        ],
        usage: { promptTokens: 101_647, cachedTokens: 66_594, completionTokens: 973, reasoningTokens: 368, costUsd: 0.005533865, unknownSteps: 0 },
        ...overrides,
    };
}

beforeEach(() => {
    rows.clear(); ops.length = 0; accounts.clear(); hashes.clear(); zsets.clear(); beforeUnindex = null; afterMissingRow = null; logged.length = 0; sessionItems = []; failWrites = false; failNextUpdates = 0;
    accounts.add('533538623');
});

test('maps a turn to a row with the exchange, secrets masked, and nothing that must never be stored', () => {
    const row = toTurnLog(markedTurn(), { ...extras, models: [HAIKU], modelCosts: [{ model: HAIKU, steps: 3, costUsd: 0.005533865 }], channelLogin: 'cdom201', answer: 'Done. Write to boss@example.org.' });
    assert.deepEqual(row, {
        _id: 'turn-1', at: new Date(Date.UTC(2026, 10, 13, 10)), endedAt: new Date(Date.UTC(2026, 10, 13, 10, 0, 9)), channelId: '533538623', channelLogin: 'cdom201',
        user: { id: '533538623', login: 'cdom201', name: 'CDOM201', role: 'owner' }, plan: 'pro', level: 'expert', fellBack: false,
        models: [HAIKU], modelCosts: [{ model: HAIKU, steps: 3, costUsd: 0.005533865 }], status: 'completed', errorCode: '', lang: 'es', pageRoute: 'modules.tts',
        message: 'TEXT-MESSAGE-7f3 please', steers: ['TEXT-STEER-91a'], answer: 'Done. Write to [email].', steps: 3,
        tools: [
            { name: 'search_docs', state: 'done', ms: 250, approval: null, args: '{"q":"TEXT-ARGS-c22"}', result: 'TEXT-RESULT-5d0 docs' },
            { name: 'create_command', state: 'done', ms: null, approval: 'applied', args: '{"name":"x"}', result: 'applied' },
            { name: 'get_command', state: 'done', ms: 10, approval: null, args: '{"name":"!weather"}',
                result: '{"response":"$(urlfetch https://api.example.test/x?key=[redacted])","headers":"Authorization: [redacted]"}' },
            { name: 'recent_chat', state: 'done', ms: 10, approval: null, args: '{}', result: '<untrusted_data>viewer1: mail me at [email] — wrote in chat</untrusted_data>' },
            { name: 'show_ui', state: 'done', ms: 1_000, approval: null, args: '{"title":"Pick","html":"<form></form>"}', result: FORM_SUBMITTED },
        ],
        units: 6, promptTokens: 101_647, cachedTokens: 66_594, completionTokens: 973, reasoningTokens: 368, costUsd: 0.005533865, unknownCostSteps: 0,
        durationMs: 9_000, activeMs: 8_200, feedback: null, reconciledSteps: [], textCleared: false, expiresAt: new Date(Date.UTC(2026, 10, 13, 10) + 90 * 86_400_000),
    });
    const json = JSON.stringify(row);
    for (const marker of KEPT) assert.equal(json.includes(marker), true, marker);
    for (const marker of NEVER) assert.equal(json.includes(marker), false, marker);
    assert.equal(json.includes('/cdom201/modules/tts'), false, 'the route key only, never the path');
});

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

test('JSON tool text is scrubbed by key name; JWTs and webhook paths anywhere are masked', () => {
    const turn = markedTurn({
        calls: [
            { id: 'a', name: 'get_settings', args: '{"channel":"x"}', state: 'done', itemId: null, inputRevision: 0, startedAt: 0, endedAt: 1,
                result: '{"accessToken":"plainlookingvalue","clientSecret":"zzzz9999","name":"ok"}' },
            { id: 'b', name: 'get_command', args: '{"name":"!alert"}', state: 'done', itemId: null, inputRevision: 0, startedAt: 0, endedAt: 1,
                result: JSON.stringify({ name: '!alert', response: `posting to ${WEBHOOK} now` }) },
        ],
    });
    const row = toTurnLog(turn, { knownTool: () => true, answer: `Your session token is ${JWT}, keep it safe.` });
    assert.equal(row.tools[0].result, '{"accessToken":"[redacted]","clientSecret":"[redacted]","name":"ok"}', 'by key name, whatever the value looks like');
    assert.equal(row.tools[1].result, '{"name":"!alert","response":"posting to https://discord.com/api/webhooks/123456789012345678/[redacted] now"}');
    assert.equal(row.answer.includes(JWT.split('.')[2]), false, 'no part of the JWT');
    assert.equal(row.answer.startsWith('Your session token is '), true);
    assert.equal(row.answer.endsWith(', keep it safe.'), true);
    const json = JSON.stringify(row);
    for (const secret of ['plainlookingvalue', 'zzzz9999', 'AbCdEfGhIjKlMnOp', JWT.slice(0, 30)]) assert.equal(json.includes(secret), false, secret);
});

test('a long JSON tool result is scrubbed whole, then clipped', () => {
    const big = JSON.stringify({ items: 'i'.repeat(3_000), accessToken: 'plainlookingvalue' });
    const row = toTurnLog(markedTurn({ calls: [{ id: 'a', name: 'read_docs', args: '{}', state: 'done', itemId: null, inputRevision: 0, startedAt: 0, result: big }] }), extras);
    assert.equal(row.tools[0].result.length, 2_000);
    assert.equal(JSON.stringify(row).includes('plainlookingvalue'), false, 'masked by key even though its key is past the clip');
});

test('every text field is scrubbed, including a secret that straddles the clip limit', () => {
    const near = `${'x'.repeat(1_990)} token=SECRETTOKEN123456`;
    const turn = markedTurn({
        userMessage: 'my key is api_key=SECRETKEY123456 ok', inputs: [{ id: 's', text: 'also oauth:SECRETTOKEN123456', at: 0, applied: true, itemId: 'i' }],
        calls: [{ id: 'c', name: 'read_docs', args: near, state: 'done', itemId: null, inputRevision: 0, result: 'mail someone@example.com', startedAt: 0, endedAt: 1 },
            { id: 'u', name: 'show_ui', args: '{}', state: 'expired', itemId: null, inputRevision: 0, result: '{"error":"not_submitted"}', ui: { state: 'closed' }, startedAt: 0 }],
    });
    const row = toTurnLog(turn, { ...extras, answer: 'Set Authorization: Bearer SECRETTOKEN123456 there' });
    const json = JSON.stringify(row);
    for (const secret of ['SECRETKEY123456', 'SECRETTOKEN', 'someone@example.com']) assert.equal(json.includes(secret), false, secret);
    assert.equal(row.message, 'my key is api_key=[redacted] ok');
    assert.equal(row.tools[0].args.length, 2_000);
    assert.equal(row.tools[0].args.endsWith(' token=[re'), true, 'masked before the cut, so no part of it survives');
    assert.equal(row.tools[1].result, '', 'an unanswered form keeps no result');
});

test('clipText counts code points and never splits a surrogate pair', () => {
    assert.equal(clipText('abc', 5), 'abc');
    assert.equal(clipText('😀😀😀', 2), '😀😀');
    assert.equal(clipText(`a${'😀'.repeat(3)}`, 2), 'a😀');
    assert.equal(clipText('a😀', 1), 'a', 'not half an emoji');
    assert.equal(clipText(undefined, 3), '');
    assert.equal(clipText(42, 3), '');
    // 2 000 emoji = 4 000 UTF-16 units: all of them fit in 2 000 code points.
    assert.equal(clipText('😀'.repeat(2_000), 2_000), '😀'.repeat(2_000));
});

test('text is clipped at the documented limits', () => {
    const steers = Array.from({ length: 14 }, (_, index) => ({ id: `s${index}`, text: `steer ${index} ${'s'.repeat(3_000)}`, at: index, applied: true, itemId: `i${index}` }));
    const calls = [
        { id: 'c', name: 'read_docs', args: 'a'.repeat(20_000), state: 'done' as const, itemId: null, inputRevision: 0, result: `${'😀'.repeat(1_999)}xyz`, startedAt: 0, endedAt: 1 },
        { id: 'd', name: 'NEVER-INVENTED', args: '{"q":"kept"}', state: 'error' as const, itemId: null, inputRevision: 0, startedAt: 0 },
    ];
    const row = toTurnLog(markedTurn({ userMessage: 'm'.repeat(4_500), inputs: steers, calls }), { ...extras, answer: 'w'.repeat(13_000) });
    assert.equal(row.message.length, 4_000);
    assert.equal(row.steers.length, 10, 'the last 10');
    assert.equal(row.steers[0].startsWith('steer 4 '), true, 'oldest first');
    assert.equal(row.steers.every((text) => text.length === 2_000), true);
    assert.equal(row.answer.length, 12_000);
    assert.equal(row.tools[0].args.length, 2_000);
    assert.equal(row.tools[0].result, `${'😀'.repeat(1_999)}x`);
    assert.deepEqual(row.tools[1], { name: 'unknown_tool', state: 'error', ms: null, approval: null, args: '{"q":"kept"}', result: '' }, 'invented name hidden, its args kept');
});

test('model costs: the runner\'s split, otherwise all of it for one model and none for two', () => {
    const fell = markedTurn({ level: 'expert', fellBack: true, usage: { ...markedTurn().usage, costUsd: 0.021 } });
    const split = [{ model: HAIKU, steps: 1, costUsd: 0.02 }, { model: LUNA, steps: 2, costUsd: 0.001 }];
    assert.deepEqual(toTurnLog(fell, { ...extras, models: [HAIKU, LUNA], modelCosts: split }).modelCosts, split, 'after a fallback each model has its own cost');
    assert.deepEqual(turnModelCosts(markedTurn(), [HAIKU]), [{ model: HAIKU, steps: 3, costUsd: 0.005533865 }]);
    assert.deepEqual(turnModelCosts(fell, [HAIKU, LUNA]), [], 'two models without the runner\'s split: no guess');
});

test('every final status keeps its error code; queued-then-stopped turns have no models', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
        const row = toTurnLog(markedTurn({ status, errorCode: status === 'completed' ? undefined : `code_${status}` }), extras);
        assert.equal(row.status, status);
        assert.equal(row.errorCode, status === 'completed' ? '' : `code_${status}`);
    }
    const stopped = toTurnLog(markedTurn({ status: 'cancelled', steps: 0, answeredSteps: 0, calls: [], page: null, endedAt: undefined }), extras, Date.UTC(2026, 10, 13, 10, 0, 2));
    assert.deepEqual(stopped.models, []);
    assert.equal(stopped.pageRoute, '');
    assert.equal(stopped.endedAt, null);
    assert.equal(stopped.durationMs, 2_000);
    assert.equal(stopped.units, 6, 'stopped by the person: what was charged stays charged');
});

test('units: own price + move fee, steers and the fallback charge; 0 when not counted or refunded', () => {
    assert.equal(turnUnits(markedTurn({ extraCharged: 2, extraDay: '2026-11-13' })), 8);
    assert.equal(turnUnits(markedTurn({ countedDay: '', inputs: [] })), 0, 'a retry is not counted');
    assert.equal(turnUnits(markedTurn({ cost: undefined, inputs: [] })), 1, 'older turns: 1');
    assert.equal(turnUnits(markedTurn({ inputs: [{ id: 'x', text: 't', at: 0, applied: false, itemId: 'y' }] })), 4, 'steers without a day were never charged');
    assert.equal(turnUnits(markedTurn({ status: 'failed', answeredSteps: 0, extraCharged: 2 })), 0, 'our failure before any answer: refunded');
    assert.equal(turnUnits(markedTurn({ status: 'failed', answeredSteps: 1 })), 6, 'a failure after an answer is not refunded');
});

test('models: the runner\'s list, otherwise rebuilt from the level and the fallback', () => {
    assert.deepEqual(turnModels(markedTurn(), ['b', 'a', 'b']), ['b', 'a']);
    assert.deepEqual(turnModels(markedTurn({ level: 'expert', fellBack: true })), ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna']);
    assert.deepEqual(turnModels(markedTurn({ level: 'expert', fellBack: true, steps: 0 })), ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna'], 'Expert declined the first step');
    assert.deepEqual(turnModels(markedTurn({ level: undefined })), ['openai/gpt-6-luna']);
    assert.deepEqual(turnModels(markedTurn({ plan: 'free', level: 'expert' })), ['openai/gpt-6-luna'], 'free has no Expert');
    assert.deepEqual(turnModels(markedTurn({ steps: 0 })), []);
});

test('tools: capped, invented names hidden, open calls have no duration', () => {
    const calls = Array.from({ length: 75 }, (_, index) => ({ id: `c${index}`, name: index === 0 ? 'SECRET-ARGS-c22' : 'read_docs', args: '{}', state: 'done' as const,
        itemId: null, inputRevision: 0, startedAt: 10, ...(index % 2 ? { endedAt: 30 } : {}) }));
    const row = toTurnLog(markedTurn({ calls }), extras);
    assert.equal(row.tools.length, 60);
    assert.deepEqual(row.tools[0], { name: 'unknown_tool', state: 'done', ms: null, approval: null, args: '{}', result: '' });
    assert.deepEqual(row.tools[1], { name: 'read_docs', state: 'done', ms: 20, approval: null, args: '{}', result: '' });
});

test('writeTurnLog inserts once by turn id, with the answer from the chat, and never throws', async () => {
    sessionItems = [
        { kind: 'user', id: 'u', turnId: 'turn-1', text: 'TEXT-MESSAGE-7f3', mode: 'send', at: 1 },
        { kind: 'assistant', id: 'a0', turnId: 'turn-0', text: 'an earlier answer', at: 1, final: true },
        { kind: 'assistant', id: 'a1', turnId: 'turn-1', text: 'Looking it up… ', at: 2, final: true },
        { kind: 'tool', id: 't', turnId: 'turn-1', callId: 'c1', name: 'search_docs', label: 'NEVER-SUMMARY-77b', state: 'done', at: 3 },
        { kind: 'assistant', id: 'a2', turnId: 'turn-1', text: '   ', at: 4, final: true },
        { kind: 'assistant', id: 'a3', turnId: 'turn-1', text: 'Here it is.', at: 5, final: true },
    ];
    await writeTurnLog(markedTurn(), extras);
    const row = rows.get('turn-1')!;
    assert.equal(row.answer, 'Looking it up…\n\nHere it is.');
    assert.deepEqual(ops[0].options, { upsert: true });
    assert.deepEqual(Object.keys(ops[0].update!), ['$setOnInsert'], 'insert only: a second finish never overwrites');
    const json = JSON.stringify(row);
    for (const marker of NEVER) assert.equal(json.includes(marker), false, marker);

    // Finished twice: the second write changes nothing.
    rows.get('turn-1')!.costUsd = 1;
    await writeTurnLog(markedTurn(), extras);
    assert.equal(rows.get('turn-1')!.costUsd, 1);
    assert.equal(rows.size, 1);

    failWrites = true;
    await writeTurnLog(markedTurn({ id: 'turn-2' }), extras);
    assert.equal(logged.length, 1, 'a failed write is logged, not thrown');
});

test('a missing or unreadable chat stores no answer, and the row is still written', async () => {
    await writeTurnLog(markedTurn(), extras);
    assert.equal(rows.get('turn-1')!.answer, '');
    sessionItems = new Error('dragonfly down');
    await writeTurnLog(markedTurn({ id: 'turn-2' }), extras);
    assert.equal(rows.get('turn-2')!.answer, '');
    assert.equal(logged.length, 1);
});

test('a deleted account gets no row, even from a write already under way', async () => {
    accounts.clear();
    await writeTurnLog(markedTurn(), extras);
    assert.equal(rows.size, 0);
    assert.equal(ops.length, 0);
});

test('a manager who deleted their account gets no row on a channel that still exists', async () => {
    // Channel 533538623 exists; manager 42 deleted their account while their turn ran there.
    await writeTurnLog(markedTurn({ id: 'm', userId: '42', userLogin: 'mgr', role: 'admin' }), extras);
    assert.equal(rows.size, 0);
    accounts.add('42');
    await writeTurnLog(markedTurn({ id: 'm', userId: '42', userLogin: 'mgr', role: 'admin' }), extras);
    assert.equal(rows.size, 1, 'written while both accounts exist');
});

test('account deletion removes the channel\'s rows and the person\'s rows elsewhere, and sweeps again later', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    accounts.add('42');
    await writeTurnLog(markedTurn({ id: 'a', channelId: '42', userId: '42' }), extras);
    await writeTurnLog(markedTurn({ id: 'b', channelId: '533538623', userId: '42', role: 'admin' }), extras);
    await writeTurnLog(markedTurn({ id: 'c' }), extras);
    assert.equal(await deleteTurnLogs('42'), 2);
    assert.deepEqual([...rows.keys()], ['c']);
    // A write that was under way lands after the first pass, before the account itself is gone (account deletion
    // removes the user last): only the second pass can catch it.
    await writeTurnLog(markedTurn({ id: 'd', channelId: '533538623', userId: '42', role: 'admin' }), extras);
    assert.equal(rows.has('d'), true);
    t.mock.timers.tick(15_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([...rows.keys()], ['c'], 'the second pass removed it');
});

test('a rating given before the row exists is on the row', async () => {
    await setTurnLogFeedback('turn-1', 'helpful');
    hashes.set('site_agent:feedback:turn-1', { rating: 'helpful' });
    assert.equal(rows.size, 0, 'no row yet: nothing to rate');
    await writeTurnLog(markedTurn(), extras);
    assert.equal(rows.get('turn-1')!.feedback, 'helpful');
    // After the row exists, a rating goes straight on it.
    await writeTurnLog(markedTurn({ id: 'turn-2' }), extras);
    await setTurnLogFeedback('turn-2', 'unhelpful');
    assert.equal(rows.get('turn-2')!.feedback, 'unhelpful');
});

const reconciled = { promptTokens: 1_000, cachedTokens: 800, completionTokens: 50, reasoningTokens: 10, upstreamCostUsd: 0.0002, routerCostUsd: 0, source: 'reconciled' as const, isByok: true };
const near = (actual: number, expected: number, label?: string) => assert.ok(Math.abs(actual - expected) < 1e-12, `${label ?? 'cost'}: ${actual} ≠ ${expected}`);
const withUnknown = (costUsd: number) => markedTurn({ usage: { promptTokens: 10, cachedTokens: 0, completionTokens: 1, reasoningTokens: 0, costUsd, unknownSteps: 1 } });

const late = () => hashes.get('site_agent:turnlog:late:turn-1') ?? {};

test('a reconciled step goes on the row and its model when the row exists, once per step', async () => {
    await writeTurnLog(withUnknown(0.001), { ...extras, models: [HAIKU], modelCosts: [{ model: HAIKU, steps: 1, costUsd: 0.001 }] });
    await addReconciledStep('turn-1', 'site_agent:turn-1:2', reconciled, 0.0002, HAIKU);
    const row = rows.get('turn-1')!;
    near(row.costUsd, 0.0012);
    assert.equal(row.unknownCostSteps, 0);
    assert.equal(row.promptTokens, 1_010);
    assert.deepEqual(row.reconciledSteps, ['site_agent:turn-1:2']);
    assert.equal(row.modelCosts.length, 1);
    near(row.modelCosts[0].costUsd, 0.0012, 'on its model');
    await addReconciledStep('turn-1', 'site_agent:turn-1:2', reconciled, 0.0002, HAIKU);
    near(rows.get('turn-1')!.costUsd, 0.0012, 'the same step again: no-op');
    await addReconciledStep('turn-1', 'site_agent:turn-1:3', reconciled, null, HAIKU);
    near(rows.get('turn-1')!.costUsd, 0.0012, 'still unknown: nothing changes');
    assert.deepEqual(late(), {}, 'nothing left waiting');
});

test('two unknown steps and a repeat of the first: each step is added once, the second is not consumed', async () => {
    await writeTurnLog(markedTurn({ usage: { promptTokens: 10, cachedTokens: 0, completionTokens: 1, reasoningTokens: 0, costUsd: 0.001, unknownSteps: 2 } }),
        { ...extras, models: [HAIKU], modelCosts: [{ model: HAIKU, steps: 2, costUsd: 0.001 }] });
    await addReconciledStep('turn-1', 'step-a', reconciled, 0.0002, HAIKU);
    await addReconciledStep('turn-1', 'step-a', reconciled, 0.0002, HAIKU);
    assert.equal(rows.get('turn-1')!.unknownCostSteps, 1, 'the repeat did not take step B\'s slot');
    await addReconciledStep('turn-1', 'step-b', reconciled, 0.0003, HAIKU);
    const row = rows.get('turn-1')!;
    near(row.costUsd, 0.0015);
    assert.equal(row.unknownCostSteps, 0);
    assert.deepEqual(row.reconciledSteps, ['step-a', 'step-b']);
});

test('a reconciled step that arrives before the row is applied when the row is written, exactly once', async () => {
    await addReconciledStep('turn-1', 'step-a', reconciled, 0.0002, LUNA);
    await addReconciledStep('turn-1', 'step-a', reconciled, 0.0002, LUNA);
    assert.equal(rows.size, 0);
    assert.deepEqual(Object.keys(late()), ['step-a'], 'kept once, not dropped');
    await writeTurnLog(withUnknown(0.001), { ...extras, models: [HAIKU, LUNA], modelCosts: [{ model: HAIKU, steps: 1, costUsd: 0.001 }, { model: LUNA, steps: 0, costUsd: 0 }] });
    const row = rows.get('turn-1')!;
    near(row.costUsd, 0.0012);
    assert.equal(row.unknownCostSteps, 0);
    assert.deepEqual(row.modelCosts, [{ model: HAIKU, steps: 1, costUsd: 0.001 }, { model: LUNA, steps: 0, costUsd: 0.0002 }], 'on the model that ran it, not the other');
    assert.deepEqual(late(), {});
    assert.equal(zsets.get('site_agent:turnlog:late')?.has('turn-1'), false, 'off the retry index');
    // Written again (recovery) and reconciled again: nothing more.
    await writeTurnLog(withUnknown(0.001), extras);
    await addReconciledStep('turn-1', 'step-a', reconciled, 0.0002, LUNA);
    near(rows.get('turn-1')!.costUsd, 0.0012);
});

test('Mongo failing once: the step is kept, not popped, and the retry adds it once', async () => {
    await writeTurnLog(withUnknown(0.001), extras);
    failNextUpdates = 1;
    await addReconciledStep('turn-1', 'step-a', reconciled, 0.0002, LUNA);
    // The direct update failed; the step waits, and its own follow-up applied it.
    near(rows.get('turn-1')!.costUsd, 0.0012);
    assert.deepEqual(late(), {});

    // Failing on the waiting-list apply too: still kept until a retry succeeds.
    rows.clear();
    await writeTurnLog(withUnknown(0.001), extras);
    failNextUpdates = 2;
    await addReconciledStep('turn-1', 'step-b', reconciled, 0.0002, LUNA);
    assert.equal(rows.get('turn-1')!.costUsd, 0.001, 'not added yet');
    assert.deepEqual(Object.keys(late()), ['step-b'], 'still waiting after the failure');
    await retryLateSteps();
    near(rows.get('turn-1')!.costUsd, 0.0012);
    assert.deepEqual(late(), {});
    await retryLateSteps();
    near(rows.get('turn-1')!.costUsd, 0.0012, 'a second retry adds nothing');
});

const LATE_INDEX = 'site_agent:turnlog:late';
const stepJson = (costUsd: number) => JSON.stringify({ model: HAIKU, costUsd, promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 });

test('a row inserted between the miss and the existence check: the step is applied, not dropped', async () => {
    afterMissingRow = () => writeTurnLog(withUnknown(0.001), extras);
    await addReconciledStep('turn-1', 'step-a', reconciled, 0.0002, HAIKU);
    const row = rows.get('turn-1')!;
    near(row.costUsd, 0.0012);
    assert.deepEqual(row.reconciledSteps, ['step-a']);
    assert.deepEqual(late(), {}, 'nothing waiting: it is on the row');
});

test('a row that cannot take the step and does not list it: the step keeps waiting', async () => {
    await writeTurnLog(markedTurn(), extras);
    await addReconciledStep('turn-1', 'step-a', reconciled, 0.0002, HAIKU);
    assert.deepEqual(Object.keys(late()), ['step-a'], 'never declared done because the row exists');
    near(rows.get('turn-1')!.costUsd, 0.005533865, 'unchanged');
});

test('the retry is fair: 50 turns whose row never comes do not starve one whose row exists', async () => {
    await writeTurnLog(withUnknown(0.001), extras);
    for (let index = 0; index < 50; index++) {
        hash(`site_agent:turnlog:late:missing-${index}`)[`k${index}`] = stepJson(0.0001);
        zset(LATE_INDEX).set(`missing-${index}`, index + 1);
    }
    hash('site_agent:turnlog:late:turn-1')['step-a'] = stepJson(0.0002);
    zset(LATE_INDEX).set('turn-1', 51);
    const t0 = 1_000;
    await retryLateSteps(50, t0);
    assert.equal(rows.get('turn-1')!.costUsd, 0.001, 'first tick: the 50 ahead of it');
    assert.equal(zset(LATE_INDEX).get('missing-0'), t0 + 30_000, 'visited entries go to the back');
    await retryLateSteps(50, t0 + 1_000);
    near(rows.get('turn-1')!.costUsd, 0.0012, 'second tick reaches it');
    assert.equal(zset(LATE_INDEX).has('turn-1'), false);
    assert.equal(zset(LATE_INDEX).size, 50, 'the others keep waiting (until their 1-day expiry)');
});

test('a retry pass that is still running is not joined by a second one', async () => {
    await writeTurnLog(withUnknown(0.001), extras);
    hash('site_agent:turnlog:late:turn-1')['step-a'] = stepJson(0.0002);
    zset(LATE_INDEX).set('turn-1', 1);
    const reads = fakeRedis.zRangeByScore;
    let passes = 0;
    fakeRedis.zRangeByScore = async (...args: Parameters<typeof reads>) => { passes++; return reads(...args); };
    try {
        // The timer fires again while the first pass is still waiting on the database.
        await Promise.all([retryLateSteps(50, 10), retryLateSteps(50, 10)]);
        assert.equal(passes, 1, 'the second call returns at once');
        near(rows.get('turn-1')!.costUsd, 0.0012, 'the first pass still did its work');
        await retryLateSteps(50, 20);
        assert.equal(passes, 2, 'once it has finished, the next tick runs');
    } finally {
        fakeRedis.zRangeByScore = reads;
    }
});

test('a new waiting step added just before the index removal keeps the turn indexed', async () => {
    await writeTurnLog(markedTurn({ usage: { promptTokens: 10, cachedTokens: 0, completionTokens: 1, reasoningTokens: 0, costUsd: 0.001, unknownSteps: 2 } }), extras);
    hash('site_agent:turnlog:late:turn-1')['step-a'] = stepJson(0.0002);
    zset(LATE_INDEX).set('turn-1', 1);
    // Step b arrives (its own attempt failed) after step a's entry was deleted, right before the "empty?" check.
    beforeUnindex = () => {
        hash('site_agent:turnlog:late:turn-1')['step-b'] = stepJson(0.0003);
        zAdd(LATE_INDEX, { score: 2, value: 'turn-1' }, { condition: 'NX' });
    };
    await retryLateSteps(50, 10);
    assert.deepEqual(Object.keys(late()), ['step-b']);
    assert.equal(zset(LATE_INDEX).has('turn-1'), true, 'still indexed, so step b is retried');
    await retryLateSteps(50, 40_000);
    near(rows.get('turn-1')!.costUsd, 0.0015);
    assert.deepEqual(rows.get('turn-1')!.reconciledSteps, ['step-a', 'step-b']);
    assert.equal(zset(LATE_INDEX).has('turn-1'), false);
});

test('a reconciled step that lands between the first look and the insert is applied by the reconciler, once', async () => {
    // The row is inserted right after the reconciler's first (missed) look, and its writer already read the hash.
    let first = true;
    const original = fakeRedis.multi;
    fakeRedis.multi = () => {
        const chain = original.call(fakeRedis);
        const exec = chain.exec;
        chain.exec = async () => {
            if (first) { first = false; await writeTurnLog(withUnknown(0.001), extras); }
            return exec();
        };
        return chain;
    };
    try {
        await addReconciledStep('turn-1', 'step-a', reconciled, 0.0002, HAIKU);
    } finally {
        fakeRedis.multi = original;
    }
    const row = rows.get('turn-1')!;
    near(row.costUsd, 0.0012);
    assert.equal(row.unknownCostSteps, 0);
    assert.deepEqual(late(), {});
});

test('conversation text is kept 3 days: the sweep asks for older rows whose text is still there and blanks only the text', async () => {
    const { clearExpiredTurnText } = await import('./turn_log.js');
    const now = Date.UTC(2026, 10, 13, 12);
    ops.length = 0;
    failWrites = false;
    try {
        assert.equal(await clearExpiredTurnText(now), 2);
        const sweep = ops.find((op) => op.op === 'updateMany')!;
        // Three days, because the dashboard tells people "Chats are kept for 3 days".
        assert.deepEqual(sweep.filter, { textCleared: false, at: { $lt: new Date(now - 3 * 86_400_000) } });
        assert.deepEqual(sweep.update, { $set: { message: '', steers: [], answer: '', 'tools.$[].args': '', 'tools.$[].result': '', textCleared: true } });
        // A store that is down never throws into the maintenance timer.
        failWrites = true;
        assert.equal(await clearExpiredTurnText(now), 0);
    } finally { failWrites = false; }
});
