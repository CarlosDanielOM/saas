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

const { compact, dropOldest, repairContext, toMessages, estimateTokens } = await import('./context.js');

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
