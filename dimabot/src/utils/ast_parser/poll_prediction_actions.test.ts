import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { parse } from './parser.js';
import { createExecutionContext, evaluate } from './evaluator.js';

const forbidden = mock.fn(() => assert.fail('An unrelated action ran'));
let prediction = { error: false, message: 'Success', data: {
    id: 'prediction-1', status: 'ACTIVE', outcomes: [
        { id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }
    ]
} } as any;
let poll = { error: false, message: 'Success', data: { id: 'poll-1', status: 'ACTIVE' } } as any;
let predictionEnd = { error: false, message: 'Prediction ended' } as any;
let pollEnd = { error: false, message: 'Poll ended' } as any;
const getPrediction = mock.fn(async () => prediction);
const endPrediction = mock.fn(async () => predictionEnd);
const getPoll = mock.fn(async () => poll);
const endPoll = mock.fn(async () => pollEnd);

mock.module('../../functions/channels/index.js', { namedExports: { setChannelInformation: forbidden } });
mock.module('../../functions/chats/index.js', { namedExports: { sendTwitchChatMessage: forbidden } });
mock.module('../../functions/users/index.js', { namedExports: { getTwitchUserByLogin: forbidden } });
mock.module('../../functions/search/index.js', { namedExports: { searchCategories: forbidden } });
mock.module('../../functions/predictions/index.js', { namedExports: {
    createPrediction: forbidden, getPrediction, endPrediction
} });
mock.module('../../functions/polls/index.js', { namedExports: {
    createPoll: forbidden, getPoll, endPoll
} });
mock.module('../../classes/twitch_streamers.class.js', { defaultExport: { getTwitchAccountById: forbidden } });
mock.module('../ai/openrouter/command.ai.js', { namedExports: { executeAiCommand: forbidden } });

const { registerChannelFunctions } = await import('./functions/channel.functions.js');
registerChannelFunctions();

async function run(command: string, level = 7): Promise<string> {
    const context = createExecutionContext({ broadcasterId: 'channel-1' });
    context.userLevel = level;
    const parsed = parse(`$(${command})`);
    assert.equal(parsed.error, undefined);
    return String((await evaluate(parsed.ast, context)).value);
}

function reset(): void {
    prediction = { error: false, message: 'Success', data: {
        id: 'prediction-1', status: 'ACTIVE', outcomes: [
            { id: 'yes', title: 'Yes' }, { id: 'no', title: 'No' }
        ]
    } };
    poll = { error: false, message: 'Success', data: { id: 'poll-1', status: 'ACTIVE' } };
    predictionEnd = { error: false, message: 'Prediction ended' };
    pollEnd = { error: false, message: 'Poll ended' };
    getPrediction.mock.resetCalls();
    endPrediction.mock.resetCalls();
    getPoll.mock.resetCalls();
    endPoll.mock.resetCalls();
}

test('mod can resolve the current prediction by outcome number without a cached ID', async () => {
    reset();
    assert.equal(await run('end.prediction 2'), '');
    assert.deepEqual(getPrediction.mock.calls[0]?.arguments, ['channel-1']);
    assert.deepEqual(endPrediction.mock.calls[0]?.arguments, ['channel-1', 'prediction-1', 'RESOLVED', 'no']);
});

test('LLM can inspect the exact question and numbered outcomes before deciding', async () => {
    reset();
    prediction.data.title = 'Does he survive?';
    prediction.data.outcomes = [
        { id: 'no', title: 'No' }, { id: 'yes', title: 'Yes' }
    ];
    const result = await run('get.prediction');
    assert.match(result, /Does he survive\?/);
    assert.match(result, /1: No/);
    assert.match(result, /2: Yes/);
    assert.equal(endPrediction.mock.callCount(), 0);
});

test('resolving by exact outcome title uses its real ID, regardless of option order', async () => {
    reset();
    prediction.data.title = 'Does he survive?';
    prediction.data.outcomes = [
        { id: 'no', title: 'No' }, { id: 'yes', title: 'Yes' }
    ];
    assert.equal(await run('end.prediction "No"'), '');
    assert.deepEqual(endPrediction.mock.calls[0]?.arguments, ['channel-1', 'prediction-1', 'RESOLVED', 'no']);
});

test('unknown or ambiguous outcome titles never resolve the prediction', async () => {
    reset();
    assert.match(await run('end.prediction Maybe'), /exact option title/i);
    assert.equal(endPrediction.mock.callCount(), 0);
    prediction.data.outcomes = [
        { id: 'first', title: 'Yes' }, { id: 'second', title: 'yes' }
    ];
    assert.match(await run('end.prediction yes'), /ambiguous/i);
    assert.equal(endPrediction.mock.callCount(), 0);
});

test('prediction resolution rejects missing, invalid, and unavailable outcomes', async () => {
    reset();
    assert.match(await run('end.prediction'), /Usage:/);
    assert.match(await run('end.prediction banana'), /exact option title/i);
    assert.match(await run('end.prediction 3'), /option number/i);
    assert.equal(endPrediction.mock.callCount(), 0);
});

test('prediction cancellation uses the current Twitch ID and reports lookup and ending errors', async () => {
    reset();
    assert.equal(await run('cancel.prediction'), '');
    assert.deepEqual(endPrediction.mock.calls[0]?.arguments, ['channel-1', 'prediction-1', 'CANCELED']);
    reset();
    prediction = { error: true, message: 'Twitch unavailable' };
    assert.match(await run('cancel.prediction'), /Twitch unavailable/);
    assert.equal(endPrediction.mock.callCount(), 0);
    reset();
    prediction.data.id = '';
    assert.match(await run('cancel.prediction'), /no active prediction/i);
    assert.equal(endPrediction.mock.callCount(), 0);
    reset();
    predictionEnd = { error: true, message: 'Twitch rejected the request' };
    assert.match(await run('end.prediction 1'), /Twitch rejected the request/);
});

test('end.poll archives results and cancel.poll terminates without results', async () => {
    reset();
    assert.equal(await run('end.poll'), '');
    assert.deepEqual(getPoll.mock.calls[0]?.arguments, ['channel-1']);
    assert.deepEqual(endPoll.mock.calls[0]?.arguments, ['channel-1', 'poll-1', 'ARCHIVED']);
    reset();
    assert.equal(await run('cancel.poll'), '');
    assert.deepEqual(endPoll.mock.calls[0]?.arguments, ['channel-1', 'poll-1', 'TERMINATED']);
});

test('poll actions report missing IDs, lookup errors, and Twitch errors', async () => {
    reset();
    poll.data.id = '';
    assert.match(await run('end.poll'), /no active poll/i);
    assert.equal(endPoll.mock.callCount(), 0);
    reset();
    poll = { error: true, message: 'Twitch unavailable' };
    assert.match(await run('cancel.poll'), /Twitch unavailable/);
    assert.equal(endPoll.mock.callCount(), 0);
    reset();
    pollEnd = { error: true, message: 'Twitch rejected the request' };
    assert.match(await run('end.poll'), /Twitch rejected the request/);
});

test('all four actions require mod permission before lookup or mutation', async () => {
    reset();
    for (const action of ['get.prediction', 'end.prediction 1', 'cancel.prediction', 'end.poll', 'cancel.poll']) {
        assert.match(await run(action, 1), /permission denied/i);
    }
    assert.equal(getPrediction.mock.callCount(), 0);
    assert.equal(getPoll.mock.callCount(), 0);
    assert.equal(endPrediction.mock.callCount(), 0);
    assert.equal(endPoll.mock.callCount(), 0);
});
