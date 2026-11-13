import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

mock.module('../server/services/ai_personality.service.js', { namedExports: { readChannelPersonality: async () => null } });
mock.module('../utils/databases/dragonfly.database.js', { namedExports: { getDragonflyClient: async () => ({}) } });

const { effectiveLevel, levelAvailable, levelConfig, SITE_AGENT_PLANS } = await import('./config.js');
const { levelView } = await import('./prefs.js');

test('owner decisions 2026-11-13: daily messages, Standard/Expert per plan, compaction at the limit', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(SITE_AGENT_PLANS).map(([plan, config]) => [plan, config.dailyMessages])), { free: 20, premium: 100, pro: 400 });
    const shape = (plan: 'free' | 'premium' | 'pro', level: 'standard' | 'expert') => {
        const config = SITE_AGENT_PLANS[plan].levels[level];
        return config ? [config.model, config.effort, config.contextLimit, config.compactAt, config.cost] : null;
    };
    assert.deepEqual(shape('free', 'standard'), ['openai/gpt-6-luna', 'high', 100_000, 1, 1]);
    assert.equal(shape('free', 'expert'), null);
    assert.deepEqual(shape('premium', 'standard'), ['openai/gpt-6-luna', 'high', 256_000, 1, 1]);
    assert.deepEqual(shape('premium', 'expert'), ['anthropic/claude-haiku-5.5', 'high', 100_000, 1, 2]);
    assert.deepEqual(shape('pro', 'standard'), ['openai/gpt-6-luna', 'high', 256_000, 1, 1]);
    assert.deepEqual(shape('pro', 'expert'), ['anthropic/claude-haiku-5.5', 'high', 256_000, 1, 2]);
});

test('Expert falls back to Standard where the plan has no Expert (e.g. after a downgrade)', () => {
    assert.equal(levelAvailable('free', 'expert'), false);
    assert.equal(effectiveLevel('free', 'expert'), 'standard');
    assert.equal(effectiveLevel('premium', 'expert'), 'expert');
    assert.equal(effectiveLevel('pro', null), 'standard');
    assert.equal(levelConfig('free', 'expert').model, 'openai/gpt-6-luna');
});

test('levelView: the panel sees both options, which are on the plan, and what each costs', () => {
    assert.deepEqual(levelView('free', 'expert'), {
        current: 'standard',
        options: [{ id: 'standard', available: true, cost: 1, contextLimit: 100_000 }, { id: 'expert', available: false, cost: 2, contextLimit: null }],
    });
    assert.deepEqual(levelView('premium', 'expert').options.map((option) => [option.id, option.available, option.cost, option.contextLimit]),
        [['standard', true, 1, 256_000], ['expert', true, 2, 100_000]]);
    assert.equal(levelView('pro', 'expert').current, 'expert');
});

test('moving a chat to the other level (owner decisions 2026-11-13)', async () => {
    const { messageCost, nextCosts } = await import('./config.js');
    const luna = (tokens: number) => ({ lastLevel: 'standard' as const, contextTokens: tokens, contextModel: 'openai/gpt-6-luna' });
    const haiku = (tokens: number) => ({ lastLevel: 'expert' as const, contextTokens: tokens, contextModel: 'anthropic/claude-haiku-5.5' });
    // New chat or same level: just the level.
    assert.deepEqual(messageCost('pro', 'expert', null), { total: 2, level: 2, move: 0 });
    assert.deepEqual(messageCost('pro', 'expert', haiku(180_000)), { total: 2, level: 2, move: 0 });
    assert.deepEqual(messageCost('pro', 'standard', luna(40_000)), { total: 1, level: 1, move: 0 });
    // Standard → Expert: +2, or +4 when the chat is over 100k in Claude's tokens (Luna tokens × 1.8).
    assert.deepEqual(messageCost('pro', 'expert', luna(40_000)), { total: 4, level: 2, move: 2 }, '72k on Claude');
    assert.deepEqual(messageCost('pro', 'expert', luna(60_000)), { total: 6, level: 2, move: 4 }, '108k on Claude');
    assert.deepEqual(messageCost('premium', 'expert', luna(150_000)), { total: 6, level: 2, move: 4 }, "owner's example");
    // Expert → Standard: +1.
    assert.deepEqual(messageCost('premium', 'standard', haiku(90_000)), { total: 2, level: 1, move: 1 });
    // A chat with no measured size (nothing answered yet) moves for free.
    assert.deepEqual(messageCost('pro', 'expert', { lastLevel: 'standard', contextTokens: 0 }), { total: 2, level: 2, move: 0 });
    // Free has no Expert: a saved Expert chat on Free runs Standard and pays the move back to it.
    assert.deepEqual(messageCost('free', 'expert', haiku(10_000)), { total: 2, level: 1, move: 1 });
    assert.deepEqual(nextCosts('free', luna(1_000)), { standard: { total: 1, level: 1, move: 0 }, expert: null });
});
