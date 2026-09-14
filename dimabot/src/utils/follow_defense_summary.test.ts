import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import { runFollowDefenseStateLua } from './follow_defense_state.test-helper.js';

const NOW = Date.parse('2026-09-14T12:00:00Z');
let now = NOW;
let values = new Map<string, string>();
let sorted = new Map<string, Map<string, number>>();
const cache = {
    async eval(script: string, options: { keys: string[]; arguments: string[] }) {
        return runFollowDefenseStateLua(script, options, values, sorted, now);
    },
    async zRangeByScore(key: string, min: number, max: number) {
        return [...sorted.get(key) || []].filter(([, score]) => score >= min && score <= max).map(([id]) => id);
    }
};
mock.module('./databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => cache } });
const { followDefenseKeys, shouldSuppressFollowAlerts } = await import('./follow_defense_queue.js');
const { sendPendingFollowDefenseSummaries, followSummaryMessage } = await import('./follow_defense_summary.js');
const keys = followDefenseKeys('channel');
let sent: string[];
const dependencies = {
    async preferences() { return { enabled: true, language: 'en' as const }; },
    async send(_channel: string, message: string) { sent.push(message); return { error: false }; }
};
function mode(mode = 'silent', expiresAt = now + 60000) {
    values.set(keys.state, JSON.stringify({ mode, expiresAt }));
}
async function suppress(count: number, prefix = 'follow') {
    for (let i = 0; i < count; i++) assert.equal(await shouldSuppressFollowAlerts('channel', `${prefix}-${i}`), true);
}
beforeEach(context => {
    now = NOW; values = new Map(); sorted = new Map(); sent = [];
    assert.ok('mock' in context);
    context.mock.method(Date, 'now', () => now);
});

test('20 follows with 10 announced produce one acknowledgement of exactly the other 10', async () => {
    for (let i = 0; i < 10; i++) assert.equal(await shouldSuppressFollowAlerts('channel', `announced-${i}`), false);
    mode();
    await suppress(10);
    await suppress(10); // delivery retry must not count twice
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 0);
    now += 60000;
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 1);
    assert.deepEqual(sent, ['10 additional follows were received while announcements were paused. Thanks for following!']);
    assert.equal(await shouldSuppressFollowAlerts('channel', 'follow-0'), true, 'receipt also prevents late individual replay');
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 0);
    assert.equal(values.has(keys.summary), false);
});

test('suppression survives escalation and cleanup and waits for renewed cooldown', async () => {
    mode(); await suppress(3);
    now += 50000; mode('protection'); await suppress(2, 'protected');
    now += 10000; mode('attack', NOW + 180000);
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 0);
    now = NOW + 110000;
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 0);
    assert.equal(sorted.get(keys.summaries)?.get('channel'), NOW + 180000);
    values.delete(keys.state); // maintenance expiry/reset of the mode itself
    now = NOW + 180000;
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 1);
    assert.match(sent[0], /^5 additional follows/);
});

test('follow receipts and atomic counter failures cannot silently lose the acknowledgement', async () => {
    mode(); values.set(keys.summaries, 'wrong type');
    await assert.rejects(shouldSuppressFollowAlerts('channel', 'retry-me'), /WRONGTYPE/);
    assert.equal(values.has(keys.summary), false);
    values.delete(keys.summaries);
    await shouldSuppressFollowAlerts('channel', 'retry-me');
    assert.equal(JSON.parse(values.get(keys.summary)!).count, 1);
    values.set(keys.settings, JSON.stringify({ enabled: false }));
    assert.equal(await shouldSuppressFollowAlerts('channel', 'disabled'), false);
});

test('failed sends back off and a successful acknowledgement is not resent', async () => {
    mode(); await suppress(1); now += 60000;
    assert.equal(await sendPendingFollowDefenseSummaries({ ...dependencies, async send() { return { error: true }; } }), 0);
    assert.equal(JSON.parse(values.get(keys.summary)!).count, 1);
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 0);
    now += 30000;
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 1);
    assert.match(sent[0], /^1 additional follow was/);
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 0);
});

test('concurrent sends are excluded and a follow arriving during delivery remains pending', async () => {
    mode(); await suppress(2); now += 60000;
    const sending = {
        ...dependencies,
        async send(channel: string, message: string) {
            assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 0, 'lease excludes another sender');
            mode('protection'); await suppress(1, 'new-wave');
            return dependencies.send(channel, message);
        }
    };
    assert.equal(await sendPendingFollowDefenseSummaries(sending), 1);
    assert.equal(JSON.parse(values.get(keys.summary)!).count, 1, 'ack subtracts only the delivered snapshot');
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 0);
    now += 60000;
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 1);
    assert.match(sent[0], /^2 additional follows/);
    assert.match(sent[1], /^1 additional follow/);
});

test('disabled chat/preferences discard the summary and very old pending summaries expire', async () => {
    mode(); await suppress(3); now += 60000;
    assert.equal(await sendPendingFollowDefenseSummaries({ ...dependencies, async preferences() { return { enabled: false, language: 'en' }; } }), 0);
    assert.equal(values.has(keys.summary), false);
    mode(); await suppress(1, 'old'); now += 360001;
    assert.equal(await sendPendingFollowDefenseSummaries(dependencies), 0);
    assert.equal(values.has(keys.summary), false);
    assert.deepEqual(sent, []);
});

test('summary wording uses exact readable counts and English/Spanish singular and plural', () => {
    assert.match(followSummaryMessage(4900, 'en'), /^4,900 additional follows/);
    assert.match(followSummaryMessage(1, 'es'), /1 follow adicional/);
    assert.match(followSummaryMessage(10, 'es'), /10 follows adicionales/);
});
