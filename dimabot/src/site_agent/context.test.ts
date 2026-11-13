import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { ContextItem, LlmRequest } from './types.js';

const requests: LlmRequest[] = [];
mock.module('./llm/openrouter.js', {
    namedExports: {
        streamChat: async (req: LlmRequest) => {
            requests.push(req);
            return { generationId: 'g', provider: 'OpenAI', content: 'SUMMARY: user wants a dice command; created !dice (change c1).', toolCalls: [], reasoning: [], finishReason: 'stop', usage: null, aborted: false, durationMs: 1 };
        },
    },
});
mock.module('../utils/siteanalytics.js', { namedExports: { getCachedLiveStatus: async () => ({ isLive: false, stream: null }) } });
mock.module('../schemas/users.schema.js', { defaultExport: { findOne: () => ({ select: () => ({ maxTimeMS: () => ({ lean: async () => null }) }) }) } });

const { compact, dropOldest, estimateItemTokens, promptHash, repairContext, toMessages, estimateTokens } = await import('./context.js');

const at = 1;
const user = (content: string): ContextItem => ({ role: 'user', content, at });
const assistant = (content: string | null, calls: string[] = []): ContextItem => ({ role: 'assistant', content, at,
    ...(calls.length ? { toolCalls: calls.map((id) => ({ id, name: 'search_docs', arguments: '{"query":"x"}' })) } : {}) });
const tool = (id: string, content = 'r'.repeat(400)): ContextItem => ({ role: 'tool', toolCallId: id, name: 'search_docs', content, at });

test('repairContext adds a result for every unanswered tool call and never re-runs it', () => {
    const items = [user('q'), assistant(null, ['a', 'b']), tool('a'), user('next')];
    const { items: fixed, repaired } = repairContext(items);
    assert.equal(repaired, 1);
    assert.deepEqual(fixed.map((item) => item.role), ['user', 'assistant', 'tool', 'tool', 'user']);
    const added = fixed[3] as Extract<ContextItem, { role: 'tool' }>;
    assert.equal(added.toolCallId, 'b');
    assert.match(added.content, /interrupted/);
    assert.equal(repairContext(fixed).repaired, 0, 'idempotent');
});

test('toMessages sends reasoning back only to the model that produced it, and labels summaries as data', () => {
    const items: ContextItem[] = [
        { role: 'summary', content: 'earlier', covers: 3, at },
        user('q'),
        { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 't', arguments: '{}' }], reasoning: { provider: 'openrouter', model: 'openai/gpt-6-luna', details: [{ type: 'reasoning.encrypted', data: 'x' }] }, at },
        tool('a'),
    ];
    const same = toMessages('SYS', items, 'openai/gpt-6-luna');
    assert.equal(same[0].content, 'SYS');
    assert.match(String(same[1].content), /^\[Earlier conversation summary/);
    assert.deepEqual((same[3] as { reasoning_details?: unknown[] }).reasoning_details, [{ type: 'reasoning.encrypted', data: 'x' }]);
    const other = toMessages('SYS', items, 'anthropic/claude-haiku-5.5');
    assert.equal((other[3] as { reasoning_details?: unknown[] }).reasoning_details, undefined);
    assert.equal((other[4] as { tool_call_id: string }).tool_call_id, 'a');
});

test('Claude gets reasoning back only while the history before it is unchanged', () => {
    const HAIKU = 'anthropic/claude-haiku-5.5';
    const tools = [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }];
    const rd = (n: number) => [{ type: 'reasoning.text', text: `think ${n}`, signature: `sig${n}`, format: 'anthropic-claude-v1', index: 0 }];
    // Replays the runner: each step's reasoning is stamped with the hash of the request that made it.
    const items: ContextItem[] = [user('q')];
    const step = (n: number, systemText = 'SYS', note?: string) => {
        const sent = toMessages(systemText, items, HAIKU, tools);
        if (note) sent.push({ role: 'user', content: note });
        items.push({ role: 'assistant', content: null, toolCalls: [{ id: `c${n}`, name: 't', arguments: '{}' }],
            reasoning: { provider: 'openrouter', model: HAIKU, details: rd(n), prefixHash: promptHash(tools, sent) }, at });
        items.push(tool(`c${n}`, `result ${n}`));
        return sent;
    };
    step(1);
    step(2);
    const carried = (messages: ReturnType<typeof toMessages>) => messages.filter((m) => m.role === 'assistant').map((m) => (m as { reasoning_details?: unknown[] }).reasoning_details !== undefined);
    assert.deepEqual(carried(toMessages('SYS', items, HAIKU, tools)), [true, true], 'append-only history keeps every block');
    assert.deepEqual(carried(toMessages('SYS + persona', items, HAIKU, tools)), [false, false], 'a system prompt change drops them all');
    assert.deepEqual(carried(toMessages('SYS', items, HAIKU, [...tools, { ...tools[0], name: 'u' }])), [false, false], 'a tool change drops them all');
    const edited = items.map((item, index) => (index === 2 ? { ...item, content: 'changed result 1' } as ContextItem : item));
    assert.deepEqual(carried(toMessages('SYS', edited, HAIKU, tools)), [true, false], 'an edit drops the blocks after it');
    // The unsaved last-step note: the block made after it is not sent back later.
    step(3, 'SYS', 'FINAL NOTE');
    assert.deepEqual(carried(toMessages('SYS', items, HAIKU, tools)), [true, true, false]);
    // Compaction: the kept tail loses its reasoning.
    const compacted: ContextItem[] = [{ role: 'summary', content: 'notes', covers: 2, at }, ...items.slice(3)];
    assert.deepEqual(carried(toMessages('SYS', compacted, HAIKU, tools)), [false, false]);
    // Luna is not bound: unchanged behavior.
    const luna = items.map((item) => (item.role === 'assistant' && item.reasoning ? { ...item, reasoning: { ...item.reasoning, model: 'openai/gpt-6-luna' } } : item));
    assert.deepEqual(carried(toMessages('SYS + persona', luna, 'openai/gpt-6-luna', tools)), [true, true, true]);
});

test('compact keeps the current request verbatim and whole recent rounds, summarizing the rest', async () => {
    const items: ContextItem[] = [user('old 1'), assistant('old answer 1'), user('old 2'), assistant(null, ['x']), tool('x', 'y'.repeat(4000)), assistant('old answer 2'),
        user('CURRENT request'), assistant(null, ['c1']), tool('c1', 'z'.repeat(8000)), assistant(null, ['c2']), tool('c2', 'w'.repeat(400))];
    const result = await compact({ items, currentUserIndex: 6, limitTokens: 6000, model: 'openai/gpt-6-luna', effort: 'xhigh', sessionKey: 's' });
    assert.equal(result.compacted, true);
    assert.equal(result.items[0].role, 'summary');
    assert.equal((result.items[1] as { content: string }).content, 'CURRENT request');
    // Every kept assistant tool call still has its result right after it.
    const kept = result.items.slice(2);
    assert.equal(kept[0].role, 'assistant');
    for (let index = 0; index < kept.length; index++) {
        const item = kept[index];
        if (item.role === 'assistant' && item.toolCalls) assert.equal((kept[index + 1] as { toolCallId?: string }).toolCallId, item.toolCalls[0].id);
    }
    assert.ok(!kept.some((item) => item.role === 'tool' && (item as { toolCallId: string }).toolCallId === 'x'), 'old rounds summarized');
    const request = requests.at(-1)!;
    assert.equal(request.tools, undefined, 'summary call has no tools');
    assert.equal(request.sessionKey, 's:compact');
    assert.match(String(request.messages[1].content), /old 1/);
    assert.doesNotMatch(String(request.messages[1].content), /CURRENT request/);
});

test('dropOldest removes whole rounds before the current request', () => {
    const items: ContextItem[] = [user('a'.repeat(4000)), assistant('b'.repeat(4000)), user('c'.repeat(4000)), assistant(null, ['t']), tool('t'), user('current')];
    const trimmed = dropOldest(items, 5, 200);
    assert.equal(trimmed[0].role, 'summary');
    assert.equal((trimmed.at(-1) as { content: string }).content, 'current');
    assert.ok(trimmed.length < items.length);
    assert.ok(estimateTokens('abcd') >= 1);
});

test('dropOldest trims the current request\'s own older steps when older history is not enough', () => {
    // First request of a chat: nothing before it, three big tool rounds after it.
    const items: ContextItem[] = [user('current'), assistant(null, ['a']), tool('a', 'x'.repeat(8000)), assistant(null, ['b']), tool('b', 'y'.repeat(8000)),
        assistant(null, ['c']), tool('c', 'z'.repeat(800))];
    const trimmed = dropOldest(items, 0, 1500);
    assert.equal((trimmed[0] as { content: string }).content, 'current', 'the request stays first');
    assert.equal(trimmed[1].role, 'summary', 'a note says steps were removed');
    assert.deepEqual(trimmed.slice(2).map((item) => item.role), ['assistant', 'tool'], 'only the newest whole round is left');
    assert.equal((trimmed.at(-1) as { toolCallId: string }).toolCallId, 'c');
    assert.equal((trimmed[1] as { covers: number }).covers, 4, 'two rounds = four items removed');
    // Dropping again replaces the note instead of stacking a second one, and keeps its count.
    const again = dropOldest([...trimmed, assistant(null, ['d']), tool('d', 'w'.repeat(8000))], 0, 1500);
    assert.equal(again.filter((item) => item.role === 'summary').length, 1);
    assert.equal((again[1] as { covers: number }).covers, 6);
    // Messages the user sent while the request ran (steer) are never removed, even trailing ones.
    const steered: ContextItem[] = [user('current'), assistant(null, ['a']), tool('a', 'x'.repeat(8000)), user('[steer] Never change timers'),
        assistant(null, ['b']), tool('b', 'y'.repeat(8000)), assistant(null, ['c']), tool('c', 'z'.repeat(800)), user('[steer] also check commands')];
    const kept = dropOldest(steered, 0, 1500);
    assert.deepEqual(kept.map((item) => item.role === 'user' ? item.content : item.role),
        ['current', 'summary', '[steer] Never change timers', 'assistant', 'tool', '[steer] also check commands']);
    assert.equal((kept[4] as { toolCallId: string }).toolCallId, 'c', 'the newest round stays whole');
    // Small enough already: unchanged.
    assert.deepEqual(dropOldest(items, 0, 1_000_000), items);
});

test('Claude thinking counts at its reported size; Luna reasoning stays discounted', () => {
    const details = [{ type: 'reasoning.text', text: 'short summary', signature: 's'.repeat(400) }];
    const withReasoning = (model: string, tokens?: number): ContextItem => ({ role: 'assistant', content: 'ok', at,
        reasoning: { provider: 'openrouter', model, details, ...(tokens ? { tokens } : {}) } });
    const base = estimateItemTokens({ role: 'assistant', content: 'ok', at });
    assert.equal(estimateItemTokens(withReasoning('anthropic/claude-haiku-5.5', 15_000)) - base, 10_000, '15k real tokens = 10k estimate units (factor 1.5)');
    assert.equal(estimateItemTokens(withReasoning('anthropic/claude-haiku-5.5')) - base, estimateTokens(JSON.stringify(details)), 'no count: full size, no discount');
    assert.ok(estimateItemTokens(withReasoning('openai/gpt-6-luna', 15_000)) - base < 100, 'Luna: unchanged');
});
