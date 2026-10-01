import assert from 'node:assert/strict';
import test from 'node:test';
import { registerEventsubFunctions } from './eventsub.functions.js';
import { createExecutionContext, evaluate, getFunctionMetadata } from '../evaluator.js';
import { parse } from '../parser.js';

registerEventsubFunctions();

async function render(source: string, eventData?: Record<string, unknown>): Promise<string> {
    const parsed = parse(source);
    assert.equal(parsed.error, undefined);
    return String((await evaluate(parsed.ast, createExecutionContext({ broadcasterId: 'channel', eventData }))).value);
}

test('twitch.streak reads the current watch-streak payload in templates and expressions', async () => {
    const eventData = { notice_type: 'watch_streak', watch_streak: { streak_count: 10, channel_points_awarded: 450 } };
    assert.equal(await render('Watching $(twitch.streak) consecutive streams!', eventData), 'Watching 10 consecutive streams!');
    assert.equal(await render('*($(twitch.streak) + 1)', eventData), '11');
    assert.equal(await render('*($(twitch.streak) >= 5 ? "milestone" : "new")', eventData), 'milestone');
    assert.equal(await render('$(twitch.streak)', { watch_streak: { streak_count: 27 } }), '27');
});

test('twitch.streak returns zero without a valid streak and never uses subscription streak months', async () => {
    for (const eventData of [undefined, {}, { watch_streak: null }, { watch_streak: [] },
        { notice_type: 'resub', resub: { streak_months: 10 }, streak_months: 10 },
        ...['12', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined].map(streak_count => ({ watch_streak: { streak_count } }))]) {
        assert.equal(await render('$(twitch.streak)', eventData), '0');
    }
});

test('twitch.streak metadata identifies the event field, fallback and authoring surface', () => {
    const metadata = getFunctionMetadata('twitch.streak');
    assert.equal(metadata?.category, 'event-data');
    assert.equal(metadata?.syntax, 'twitch.streak');
    assert.deepEqual(metadata?.surfaces, ['authoring']);
    assert.match(metadata?.description ?? '', /watch_streak.streak_count/);
    assert.match(metadata?.description ?? '', /Returns 0/);
});

test('twitch.modiversary reads moderator months without using subscription months', async () => {
    const eventData = { notice_type: 'modiversary', modiversary: { months: 24 } };
    assert.equal(await render('$(twitch.modiversary)', eventData), '24');
    assert.equal(await render('*($(twitch.modiversary) / 12)', eventData), '2');
    for (const eventData of [{}, { modiversary: null }, { modiversary: [] }, { resub: { cumulative_months: 24 } },
        ...['24', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(months => ({ modiversary: { months } }))]) {
        assert.equal(await render('$(twitch.modiversary)', eventData), '0');
    }
    assert.deepEqual(getFunctionMetadata('twitch.modiversary')?.surfaces, ['authoring']);
});
