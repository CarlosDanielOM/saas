/** MCP call log rows: outcome classes (admin console problem rule), clipping and scrubbing, retention. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __mcpCallRowForTests as row, classifyMcpOutcome, MCP_CALL_LOG_RETENTION_DAYS, MCP_CALL_REASON_MAX } from './mcp_call_log.js';

test('classes: ok; failed for our own trouble; blocked otherwise; problem = failed or blocked except permission_denied', () => {
    assert.deepEqual(classifyMcpOutcome(null), { outcome: 'ok', problem: false });
    for (const code of ['failed', 'outcome_unknown', 'credits_unavailable']) assert.deepEqual(classifyMcpOutcome(code), { outcome: 'failed', problem: true }, code);
    for (const code of ['unsafe_content', 'invalid_input', 'credits_exhausted', 'busy', 'conflict', 'unknown_tool']) assert.deepEqual(classifyMcpOutcome(code), { outcome: 'blocked', problem: true }, code);
    assert.deepEqual(classifyMcpOutcome('permission_denied'), { outcome: 'blocked', problem: false });
});

test('a row: wall time, clipped and scrubbed reason, no reason on success, 90-day expiry, late pending', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    const base = { operationId: 'op-1', startedAt: now - 1500, channelId: '100', channelLogin: 'Chan', user: { id: '200', login: 'helper', role: 'admin' as const },
        client: { id: 'https://claude.ai/x', name: ' Claude \n App ' }, sessionId: 's', tool: 'create_command', kind: 'write' as const, charged: 0 };
    const refused = row({ ...base, code: 'unsafe_content', reason: `Not applied: key sk-ant-api03-${'A'.repeat(40)} ${'x'.repeat(500)}` }, now);
    assert.equal(refused._id, 'op-1');
    assert.equal(refused.ms, 1500);
    assert.equal(refused.outcome, 'blocked');
    assert.equal(refused.problem, true);
    assert.ok(refused.reason.length <= MCP_CALL_REASON_MAX);
    assert.doesNotMatch(refused.reason, /sk-ant-api03-A{40}/);
    assert.equal(refused.client.name, 'Claude App');
    assert.equal(refused.expiresAt.getTime(), now + MCP_CALL_LOG_RETENTION_DAYS * 86_400_000);
    assert.equal(refused.late, null);
    const ok = row({ ...base, code: null, reason: 'ignored', charged: 1, changeId: 'c1', late: true }, now);
    assert.equal(ok.reason, '');
    assert.equal(ok.code, '');
    assert.equal(ok.changeId, 'c1');
    assert.equal(ok.late, 'pending');
});
