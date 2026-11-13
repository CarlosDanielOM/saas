import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { TurnRecord } from '../../site_agent/store.js';

// The route helpers and the docs assistant pull in the auth and tool stacks (they need secrets); these tests only
// need the pure shaping.
mock.module('../../utils/ai/docs_assistant/docs_assistant.js', { namedExports: {
    DOCS_ASSISTANT_KEYS: { stats: (day: string) => `docs_assistant:stats:${day}`, answer: (id: string) => `docs_assistant:answer:${id}`, recent: 'docs_assistant:recent' },
    DOCS_ASSISTANT_RECENT_KEEP: 1000,
} });
/** Dragonfly stand-in for the docs reader: answer hashes, the recent list, and a count of the fields each read asked for. */
const store = new Map<string, Record<string, string>>();
let recent: string[] = [];
const reads = { metaKeys: 0, textKeys: 0 };
mock.module('../../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({
    lRange: async () => [...recent],
    hGetAll: async (key: string) => ({ ...(store.get(key) ?? {}) }),
    hmGet: async (key: string, fields: string[]) => {
        if (fields.includes('answer')) reads.textKeys++; else reads.metaKeys++;
        return fields.map((field) => store.get(key)?.[field] ?? null);
    },
    multi: () => {
        const removed: string[] = [];
        const chain = { lRem: (_key: string, _count: number, id: string) => { removed.push(id); return chain; }, exec: async () => { recent = recent.filter((id) => !removed.includes(id)); return []; } };
        return chain;
    },
}) } });
mock.module('../routes/admin_site/shared.js', { namedExports: {
    channelLogins: async () => new Map(),
    pagination: (page: { page: number; limit: number }, total: number) => ({ page: page.page, limit: page.limit, total, totalPages: Math.max(1, Math.ceil(total / page.limit)) }),
} });

const service = await import('./admin_assistants.service.js');
const { toTurnLog } = await import('../../site_agent/turn_log.js');
const { docsPagePath } = await import('../../utils/ai/docs_assistant/docs_page.js');
const { clearDocsCacheForTests, docsAnswers, docsSummary, filterDocsRecords, toDocsAnswer, parseAssistantDay, parseDocsDay, parseDocsRecord, toAssistantTurn, toAssistantTurnDetail, utcDays } = service;

test('utcDays: both ends included, across months', () => {
    assert.deepEqual(utcDays(new Date('2026-10-30T23:00:00Z'), new Date('2026-11-02T01:00:00Z')), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    assert.deepEqual(utcDays(new Date('2026-11-13T00:00:00Z'), new Date('2026-11-13T05:00:00Z')), ['2026-11-13']);
    assert.equal(utcDays(new Date('2026-07-15T00:00:00Z'), new Date('2026-11-12T00:00:00Z')).length, 121);
});

test('assistant day: counters parsed, interrupted counted as failed, missing day = zeros', () => {
    assert.deepEqual(parseAssistantDay('2026-11-13', {
        turns: '23', turns_completed: '8', turns_cancelled: '15', turns_failed: '1', turns_interrupted: '2', steps: '132', compactions: '3', tool_calls: '172',
        prompt_tokens: '4980000', cached_tokens: '1530000', completion_tokens: '80000', cost_micro_usd: '411792', helpful: '2', unhelpful: '1', messages: '23',
    }), {
        date: '2026-11-13', turns: 23, completed: 8, failed: 3, cancelled: 15, steps: 132, toolCalls: 172, promptTokens: 4_980_000, cachedTokens: 1_530_000,
        completionTokens: 80_000, providerUSD: 0.411792, helpful: 2, unhelpful: 1,
    });
    assert.deepEqual(parseAssistantDay('2026-11-01', {}), {
        date: '2026-11-01', turns: 0, completed: 0, failed: 0, cancelled: 0, steps: 0, toolCalls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0,
        providerUSD: 0, helpful: 0, unhelpful: 0,
    });
    assert.equal(parseAssistantDay('d', { turns: 'garbage', steps: '-4' }).turns, 0);
});

test('docs day: abandoned = asked − answered − failed, never negative', () => {
    assert.deepEqual(parseDocsDay('2026-11-02', { asked: '4', answered: '2', failed: '1', failed_timeout: '1', tool_calls: '5', input_tokens: '100', cache_read_tokens: '50',
        output_tokens: '20', cost_micro_usd: '9296', helpful: '1' }), {
        date: '2026-11-02', asked: 4, answered: 2, failed: 1, abandoned: 1, toolCalls: 5, inputTokens: 100, outputTokens: 20, providerUSD: 0.009296, helpful: 1, unhelpful: 0,
    });
    assert.equal(parseDocsDay('d', { asked: '1', answered: '2' }).abandoned, 0);
});

test('docs records: new and old answers, failures, unreadable ones', () => {
    const answer = parseDocsRecord('a1', {
        at: '2026-11-09T14:15:00.000Z', lang: 'es', page: 'https://docs.domdimabot.com/es/follow-defense/?utm=x#modes', turn: '2', question: '¿Cómo?', answer: 'Así.',
        sources: '["https://docs.domdimabot.com/es/follow-defense/"]', duration_ms: '12300', input_tokens: '55435', output_tokens: '1632', cost_usd: '0.009296',
        stop_reason: 'end_turn', rounds: '3', tool_calls: '[{"name":"search_ast_functions","input":{"query":"x"}},{"name":"test_command","input":{}}]', feedback: 'helpful',
    })!;
    assert.deepEqual(toDocsAnswer(answer), {
        id: 'a1', at: '2026-11-09T14:15:00.000Z', lang: 'es', page: '/es/follow-defense/', turn: 2, question: '¿Cómo?', answer: 'Así.',
        sources: ['https://docs.domdimabot.com/es/follow-defense/'], tools: ['search_ast_functions', 'test_command'], rounds: 3, durationMs: 12_300,
        inputTokens: 55_435, outputTokens: 1_632, providerUSD: 0.009296, stopReason: 'end_turn', failed: null, feedback: 'helpful',
    });

    // Before 2026-11-02 answers had no rounds/tool_calls (stored as empty strings).
    const old = parseDocsRecord('a0', { at: '2026-11-01T06:50:47Z', lang: 'en', page: '', turn: '1', question: 'q', answer: 'a', sources: '', duration_ms: '13169',
        input_tokens: '1', output_tokens: '1', cost_usd: '0.000100', stop_reason: '', rounds: '', tool_calls: '', feedback: '' })!;
    assert.equal(old.rounds, null);
    assert.deepEqual(old.tools, []);
    assert.deepEqual(old.sources, []);
    assert.equal(old.page, null);
    assert.equal(old.stopReason, null);
    assert.equal(old.feedback, null);

    const failed = parseDocsRecord('f1', { at: '2026-11-10T00:00:00Z', lang: 'en', page: '/ai/', turn: '1', question: 'why', answer: '', sources: '[]', duration_ms: '60000',
        input_tokens: '0', output_tokens: '0', cost_usd: '0.000000', stop_reason: 'timeout', failed: 'timeout' })!;
    assert.equal(failed.failed, 'timeout');
    assert.equal(toDocsAnswer(failed).failed, 'timeout', 'the page is told why, not left to guess from an empty answer');
    assert.equal(failed.stopReason, 'timeout');
    assert.equal(failed.answer, '');

    assert.equal(parseDocsRecord('x', { at: 'not a date' }), null);
    assert.equal(parseDocsRecord('x', { tool_calls: '{bad' }), null, 'no time: unreadable');
    assert.deepEqual(parseDocsRecord('x', { at: '2026-11-10T00:00:00Z', tool_calls: '{bad', sources: '"str"' })!.tools, []);
});

test('docs page paths: query strings and fragments are dropped', () => {
    assert.equal(docsPagePath('https://docs.domdimabot.com/'), '/');
    assert.equal(docsPagePath('https://docs.domdimabot.com/ai-assistants/?token=abc#x'), '/ai-assistants/');
    assert.equal(docsPagePath('/es/?q=1'), '/es/');
    assert.equal(docsPagePath('javascript:alert(1)'), null);
    assert.equal(docsPagePath('not a url'), null);
    assert.equal(docsPagePath(''), null);
});

test('docs list filters and sorts', () => {
    const make = (id: string, at: string, extra: Record<string, string>) => parseDocsRecord(id, { at, lang: 'en', duration_ms: '1', cost_usd: '0.000001', ...extra })!;
    const records = [
        make('a', '2026-11-01T00:00:00Z', { feedback: 'helpful', cost_usd: '0.02' }),
        make('b', '2026-11-03T00:00:00Z', { lang: 'es', duration_ms: '9000' }),
        make('c', '2026-11-02T00:00:00Z', { feedback: 'unhelpful' }),
    ];
    assert.deepEqual(filterDocsRecords(records, { sort: 'newest' }).map((r) => r.id), ['b', 'c', 'a']);
    assert.deepEqual(filterDocsRecords(records, { sort: 'cost' }).map((r) => r.id), ['a', 'b', 'c']);
    assert.deepEqual(filterDocsRecords(records, { sort: 'slowest' }).map((r) => r.id), ['b', 'c', 'a']);
    assert.deepEqual(filterDocsRecords(records, { sort: 'newest', feedback: 'none' }).map((r) => r.id), ['b']);
    assert.deepEqual(filterDocsRecords(records, { sort: 'newest', lang: 'en', feedback: 'helpful' }).map((r) => r.id), ['a']);
});

const NEVER = ['NEVER-TITLE-e4b', 'NEVER-PROPOSAL-0aa', 'NEVER-PAYLOAD-1b2', 'NEVER-SUMMARY-77b', 'NEVER-UI-3c1', 'NEVER-APPROVAL-4d4', 'FORMVALUE-8e8',
    'SECRETKEY123456', 'SECRETTOKEN123456', 'someone@example.com'];

function textTurn(): TurnRecord {
    const createdAt = Date.UTC(2026, 10, 13, 10);
    return {
        id: 'turn-p', sessionId: 's', channelId: '1', userId: '2', userLogin: 'editor', userDisplayName: 'Editor', role: 'admin', plan: 'premium', lang: 'en',
        page: { route: 'commands', path: '/x/commands', title: 'NEVER-TITLE-e4b' }, status: 'failed', revision: 1, inputRevision: 0, createdAt, endedAt: createdAt + 500,
        userMessage: `Why ${'q'.repeat(400)}`, userItemId: 'i', mode: 'send', countedDay: '2026-11-13', level: 'expert', cost: 2, levelCost: 2, fellBack: true, answeredSteps: 1,
        extraCharged: 2, extraDay: '2026-11-13', userAdded: true, lastPromptTokens: 0, lastPromptItems: 0, stopRequested: false, steps: 2, toolCallCount: 1, activeMs: 400,
        errorCode: 'model_overloaded',
        inputs: [{ id: 'in', text: 'also this', at: createdAt, applied: true, itemId: 'i2', cost: 2, countedDay: '2026-11-13' }],
        calls: [{ id: 'c', name: 'create_command', args: '{"name":"!hi"}', state: 'error', itemId: null, inputRevision: 0, result: 'tool_failed', summary: 'NEVER-SUMMARY-77b',
            proposal: { title: 'NEVER-PROPOSAL-0aa', payload: { x: 'NEVER-PAYLOAD-1b2' } } as never, approval: { state: 'failed', error: 'NEVER-APPROVAL-4d4' },
            startedAt: createdAt },
            { id: 'g', name: 'get_command', args: '{"name":"!w"}', state: 'done', itemId: null, inputRevision: 0, startedAt: createdAt,
                result: 'fetch https://api.example.test/x?key=SECRETKEY123456 with Authorization: Bearer SECRETTOKEN123456' },
            { id: 'r', name: 'recent_chat', args: '{}', state: 'done', itemId: null, inputRevision: 0, startedAt: createdAt, result: 'viewer: write to someone@example.com' },
            { id: 'u', name: 'show_ui', args: '{"title":"Form"}', state: 'done', itemId: null, inputRevision: 0, startedAt: createdAt,
                result: '{"submitted":true,"values":{"name":"FORMVALUE-8e8"}}', ui: { state: 'submitted', values: 'NEVER-UI-3c1' } }],
        usage: { promptTokens: 10, cachedTokens: 0, completionTokens: 5, reasoningTokens: 1, costUsd: 0.0001234567, unknownSteps: 1 },
    };
}

test('list row: a 300-character question, tools without their text; detail: the whole exchange', () => {
    const row = toTurnLog(textTurn(), { knownTool: () => true, answer: 'Sorry, that failed.' });
    const logins = new Map([['1', 'somechannel']]);
    const listed = toAssistantTurn(row, logins);
    assert.deepEqual(listed, {
        id: 'turn-p', at: '2026-11-13T10:00:00.000Z', channelID: '1', channel: 'somechannel', user: { id: '2', login: 'editor', name: 'Editor', role: 'admin' },
        plan: 'premium', level: 'expert', fellBack: true, models: ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna'], status: 'failed', errorCode: 'model_overloaded',
        lang: 'en', pageRoute: 'commands', question: `Why ${'q'.repeat(296)}`, steps: 2,
        tools: [{ name: 'create_command', state: 'error', ms: null, approval: 'failed' }, { name: 'get_command', state: 'done', ms: null, approval: null },
            { name: 'recent_chat', state: 'done', ms: null, approval: null }, { name: 'show_ui', state: 'done', ms: null, approval: null }], units: 6,
        promptTokens: 10, cachedTokens: 0, completionTokens: 5, providerUSD: 0.000123, durationMs: 500, activeMs: 400, feedback: null, textKept: true,
    });
    const detail = toAssistantTurnDetail(row, logins);
    const { tools: _listedTools, ...listedRest } = listed;
    const { tools, message, steers, answer, ...detailRest } = detail;
    assert.deepEqual(detailRest, listedRest);
    assert.equal(message, `Why ${'q'.repeat(400)}`);
    assert.deepEqual(steers, ['also this']);
    assert.equal(answer, 'Sorry, that failed.');
    assert.deepEqual(tools, [
        { name: 'create_command', state: 'error', ms: null, approval: 'failed', args: '{"name":"!hi"}', result: 'tool_failed' },
        { name: 'get_command', state: 'done', ms: null, approval: null, args: '{"name":"!w"}', result: 'fetch https://api.example.test/x?key=[redacted] with Authorization: [redacted]' },
        { name: 'recent_chat', state: 'done', ms: null, approval: null, args: '{}', result: 'viewer: write to [email]' },
        { name: 'show_ui', state: 'done', ms: null, approval: null, args: '{"title":"Form"}', result: '[form submitted]' },
    ], 'the text around secrets is kept; the secrets, the address and the form values are not');
    const json = JSON.stringify([row, listed, detail]);
    for (const marker of NEVER) assert.equal(json.includes(marker), false, marker);
});

test('rows from before text was kept: question, message and answer are null', () => {
    const { message: _m, steers: _s, answer: _a, ...old } = toTurnLog(textTurn(), { knownTool: () => true });
    const legacy = { ...old, tools: old.tools.map(({ args: _args, result: _result, ...tool }) => tool) } as never;
    assert.equal(toAssistantTurn(legacy, new Map()).question, null);
    const detail = toAssistantTurnDetail(legacy, new Map());
    assert.equal(detail.message, null);
    assert.deepEqual(detail.steers, []);
    assert.equal(detail.answer, null);
    assert.deepEqual(detail.tools[0], { name: 'create_command', state: 'error', ms: null, approval: 'failed', args: null, result: null });
    // The list projection's preview wins when present.
    assert.equal(toAssistantTurn({ ...old, question: '' } as never, new Map()).question, null);
    assert.equal(toAssistantTurn({ ...old, question: '😀'.repeat(301) } as never, new Map()).question, '😀'.repeat(300));
});

test('API row: empty error code and route become null; a stored login wins', () => {
    const base = toTurnLog({
        id: 't', sessionId: 's', channelId: '1', userId: '1', userLogin: 'o', userDisplayName: 'O', role: 'owner', plan: 'free', lang: 'en', page: null, status: 'completed',
        revision: 1, inputRevision: 0, createdAt: 0, endedAt: 10, userMessage: 'x', userItemId: 'i', mode: 'send', countedDay: '', userAdded: true, lastPromptTokens: 0,
        lastPromptItems: 0, stopRequested: false, steps: 1, toolCallCount: 0, activeMs: 5, inputs: [], calls: [],
        usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: 0, unknownSteps: 0 },
    }, { knownTool: () => true, channelLogin: 'stored' });
    const api = toAssistantTurn({ ...base, feedback: 'helpful' }, new Map([['1', 'looked_up']]));
    assert.equal(api.errorCode, null);
    assert.equal(api.pageRoute, null);
    assert.equal(api.channel, 'stored');
    assert.equal(api.feedback, 'helpful');
    assert.equal(api.units, 0);
    assert.equal(toAssistantTurn({ ...base, channelLogin: '' }, new Map()).channel, null);
});

test('docs list: metadata for all, text for the page only, one metadata read shared for 30 s', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T12:00:00Z') });
    clearDocsCacheForTests();
    store.clear();
    recent = [];
    for (let index = 0; index < 30; index++) {
        const id = `id-${String(index).padStart(2, '0')}`;
        recent.push(id);
        store.set(`docs_assistant:answer:${id}`, { at: new Date(Date.parse('2026-11-13T11:00:00Z') - index * 60_000).toISOString(), lang: 'en', page: '/faq/',
            duration_ms: String(1000 + index), cost_usd: '0.001000', question: `Q${index}`, answer: `A${index}`, sources: '[]', tool_calls: '[{"name":"test_command"}]' });
    }
    recent.push('expired-id');
    reads.metaKeys = 0; reads.textKeys = 0;
    const page = { page: 2, limit: 10, skip: 10 };
    const [summary, list] = await Promise.all([docsSummary({ from: new Date('2026-11-12T00:00:00Z'), to: new Date('2026-11-13T12:00:00Z') }),
        docsAnswers({ sort: 'newest', page })]);
    assert.equal(reads.metaKeys, 31, 'one metadata read for both requests');
    assert.equal(reads.textKeys, 10, 'full text for the page\'s rows only');
    assert.equal(list.rows.length, 10);
    assert.deepEqual(list.rows.map((row) => row.question), Array.from({ length: 10 }, (_, index) => `Q${index + 10}`));
    assert.deepEqual(list.rows[0].tools, ['test_command']);
    assert.deepEqual(list.pagination, { page: 2, limit: 10, total: 30, totalPages: 3 });
    assert.equal(summary.medianDurationMs, 1015);
    assert.equal(recent.includes('expired-id'), false, 'expired ids trimmed');

    await docsAnswers({ sort: 'cost', page: { page: 1, limit: 5, skip: 0 } });
    assert.equal(reads.metaKeys, 31, 'within 30 s: cached');
    t.mock.timers.tick(31_000);
    await docsAnswers({ sort: 'newest', page: { page: 1, limit: 5, skip: 0 } });
    assert.equal(reads.metaKeys, 61, 'after 30 s: read again');
    clearDocsCacheForTests();
    await docsAnswers({ sort: 'newest', page: { page: 1, limit: 5, skip: 0 } });
    assert.equal(reads.metaKeys, 91, 'cleared on request');
});
