import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { applyProposal, fakeEffects, makeCtx, propose, undoChange } from './write/settings/test_context.test_util.js';

process.env.SECRET_KEY ??= 'tool-test-secret';

const calls: string[] = [];
const state: { activated: boolean; clients: number; bitsAlert: boolean; reward: any; twitch: any } = { activated: true, clients: 1, bitsAlert: true, reward: null, twitch: null };
const realChannels = await import('../../functions/channels/index.js');
const realLive = await import('../../overlays/live.js');
const realStore = await import('../../overlays/store.js');
const realRewards = await import('../../server/services/reward_creation.service.js');
const realHeader = await import('../../utils/header.js');
mock.module('./effects.js', { namedExports: { describeCommandEffects: fakeEffects } });
mock.module('../../functions/channels/index.js', { namedExports: { ...realChannels,
    getChannelInformation: async () => ({ error: false, data: { title: 'Old title', game_name: 'Just Chatting' } }),
    setChannelInformation: async (_id: string, info: unknown) => { calls.push(`info:${JSON.stringify(info)}`); return { error: false, message: '' }; } } });
mock.module('../../functions/polls/index.js', { namedExports: { createPoll: async (...args: unknown[]) => { calls.push(`poll:${JSON.stringify(args.slice(1))}`); return { id: 'poll-1' }; } } });
mock.module('../../functions/predictions/index.js', { namedExports: { createPrediction: async (...args: unknown[]) => { calls.push(`prediction:${JSON.stringify(args.slice(1))}`); return { id: 'pred-1' }; } } });
mock.module('../../functions/search/index.js', { namedExports: { searchCategories: async () => ({ error: false, data: [{ id: '509658', name: 'Just Chatting' }, { id: '27471', name: 'Minecraft' }] }) } });
mock.module('../../overlays/live.js', { namedExports: { ...realLive,
    bitsRuleFor: async (_c: string, kind: string) => kind === 'bits' ? { name: 'Quiet', alert: state.bitsAlert } : null,
    publishStudioAlert: async (_c: string, kind: string, raw: any) => { calls.push(`alert:${kind}:${raw.user_name}:${raw.bits}`); return state.clients; } } });
mock.module('../../overlays/store.js', { namedExports: { ...realStore, requireOverlayAccount: async () => {} } });
mock.module('../../server/services/reward_creation.service.js', { namedExports: { ...realRewards,
    createRewardWithEventsub: async ({ body }: any) => { calls.push(`create-reward:${body.title}`); state.reward = { rewardID: 'r1', eventsubID: 'es1', title: body.title, cost: body.cost, message: body.message ?? '' }; return { error: false, status: 201, message: 'ok', data: state.reward }; },
    patchTwitchReward: async (_c: string, body: any) => { calls.push(`patch-reward:${JSON.stringify(body)}`); Object.assign(state.twitch, body.cost !== undefined ? { cost: body.cost } : {}, body.isPaused !== undefined ? { is_paused: body.isPaused } : {}); return { id: 'r1' }; },
    cleanupRewardArtifacts: async (_c: string, rewardId: string) => { calls.push(`cleanup:${rewardId}`); state.reward = null; } } });
mock.module('../../utils/header.js', { namedExports: { ...realHeader, getTwitchStreamerHeaderById: async () => ({ error: false, header: { 'Client-Id': 'x', Authorization: 'Bearer x' } }) } });

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => Response.json({ data: state.twitch ? [state.twitch] : [] })) as typeof fetch;
after(() => { globalThis.fetch = originalFetch; });

const { default: UsersSchema } = await import('../../schemas/users.schema.js');
const { RedemptionRewardSchema } = await import('../../schemas/redemption_reward.schema.js');
mock.method(UsersSchema, 'findOne', () => ({ select: () => ({ lean: async () => ({ accounts: [{ type: 'twitch', id: '100', actived: state.activated }] }) }) }));
mock.method(RedemptionRewardSchema, 'find', () => ({ lean: async () => state.reward ? [structuredClone(state.reward)] : [] }));
mock.method(RedemptionRewardSchema, 'findOne', () => ({ lean: async () => state.reward ? structuredClone(state.reward) : null }));
mock.method(RedemptionRewardSchema, 'findOneAndUpdate', async (_f: unknown, body: any) => { calls.push(`db-reward:${JSON.stringify(body)}`); Object.assign(state.reward, body); return state.reward; });
mock.method(RedemptionRewardSchema, 'exists', async () => state.reward ? { _id: 'x' } : null);

const { sendTestAlert, setStreamInfo, createPollTool, createPredictionTool, createReward, updateReward } = await import('./stream.js');
const { ToolConflictError, ToolInputError } = await import('../types.js');

beforeEach(() => {
    calls.length = 0;
    Object.assign(state, { activated: true, clients: 1, bitsAlert: true, reward: null,
        twitch: { id: 'r1', title: 'Hydrate', prompt: '', cost: 100, is_enabled: true, is_paused: false, global_cooldown_setting: { is_enabled: false, global_cooldown_seconds: 0 },
            max_per_stream_setting: { is_enabled: false, max_per_stream: 0 }, max_per_user_per_stream_setting: { is_enabled: false, max_per_user_per_stream: 0 },
            is_user_input_required: false, should_redemptions_skip_request_queue: false, background_color: '#9147FF' } });
});

test('send_test_alert: only the exact channel owner, says it is live and cannot be undone, plays on apply', async () => {
    const admin = makeCtx({ role: 'owner', requester: { id: '533538623', login: 'creator', displayName: 'Creator' } });
    await assert.rejects(sendTestAlert.run(sendTestAlert.validate({ kind: 'follow' }), admin), ToolInputError);
    const ctx = makeCtx({ lang: 'es' });
    const proposal = await propose(sendTestAlert, { kind: 'bits', amount: 500, user: 'Viewer' }, ctx);
    assert.deepEqual(proposal.permissions, ['owner']);
    assert.ok(proposal.warnings!.some((w) => /en vivo/.test(w)));
    assert.ok(proposal.warnings!.some((w) => /no se puede deshacer/.test(w)));
    assert.equal(calls.length, 0);
    await assert.rejects(applyProposal(sendTestAlert, proposal, admin), ToolInputError);
    const { result, change } = await applyProposal(sendTestAlert, proposal, ctx);
    assert.deepEqual(result, { sent: true, clients: 1 });
    assert.deepEqual(calls, ['alert:bits:Viewer:500']);
    assert.equal(change!.undo, null);
    state.clients = 0;
    await assert.rejects(applyProposal(sendTestAlert, proposal, ctx), /Open a published browser source/);
    state.bitsAlert = false;
    await assert.rejects(sendTestAlert.run(sendTestAlert.validate({ kind: 'bits' }), ctx), /alerts turned off/);
});

test('set_stream_info, create_poll and create_prediction need full access and only act on apply', async () => {
    const ctx = makeCtx();
    state.activated = false;
    for (const [tool, raw] of [[setStreamInfo, { title: 'x' }], [createPollTool, { title: 'Q', choices: ['a', 'b'], durationSeconds: 60 }], [createPredictionTool, { title: 'Q', outcomes: ['a', 'b'], windowSeconds: 60 }]] as const) {
        const outcome = await (tool as any).run((tool as any).validate(raw), ctx);
        assert.equal(outcome.result.needsFullAccess, true);
    }
    state.activated = true;
    const info = await propose(setStreamInfo, { title: 'New title', category: 'minecraft' }, ctx);
    assert.deepEqual(info.before, { title: 'Old title', category: 'Just Chatting' });
    assert.deepEqual(info.after, { title: 'New title', category: 'Minecraft' });
    assert.ok(info.warnings!.some((w) => /cannot be undone/.test(w)));
    await applyProposal(setStreamInfo, info, ctx);
    assert.deepEqual(calls, ['info:{"title":"New title","game_id":"27471"}']);

    assert.throws(() => createPollTool.validate({ title: 'Q', choices: ['only one'], durationSeconds: 60 }), /2–5 choices/);
    assert.throws(() => createPollTool.validate({ title: 'Q', choices: ['a', 'b'], durationSeconds: 5 }), /at least 15/);
    const poll = await propose(createPollTool, { title: 'Best map?', choices: ['Nuke', 'Mirage'], durationSeconds: 120, channelPointsPerVote: 50 }, ctx);
    await applyProposal(createPollTool, poll, ctx);
    assert.equal(calls.at(-1), 'poll:["Best map?",[{"title":"Nuke"},{"title":"Mirage"}],120,false,50]');
    const prediction = await propose(createPredictionTool, { title: 'Win?', outcomes: ['Yes', 'No'], windowSeconds: 120 }, ctx);
    await applyProposal(createPredictionTool, prediction, ctx);
    assert.equal(calls.at(-1), 'prediction:["Win?",[{"title":"Yes"},{"title":"No"}],120]');
});

test('create_reward mirrors the route validation, dry-runs the message and undo deletes it', async () => {
    const ctx = makeCtx({ role: 'admin', requester: { id: '5', login: 'ed', displayName: 'Ed' }, granted: ['rewards:manage'] });
    assert.throws(() => createReward.validate({ title: 'x'.repeat(46), cost: 10 }), /too long/);
    assert.throws(() => createReward.validate({ title: 'Hydrate', cost: 10, cooldown: 700000 }), /at most 604800/);
    const proposal = await propose(createReward, { title: 'Hydrate', cost: 100, message: '$(tts drink water)' }, ctx);
    assert.deepEqual(proposal.permissions, ['rewards:manage']);
    assert.ok(proposal.effects.some((effect) => /Runs tts/.test(effect)));
    const { change } = await applyProposal(createReward, proposal, ctx);
    assert.deepEqual(calls, ['create-reward:Hydrate']);
    state.reward.cost = 200;
    await assert.rejects(undoChange(createReward, change!, ctx), ToolConflictError);
    state.reward.cost = 100;
    await undoChange(createReward, change!, ctx);
    assert.equal(calls.at(-1), 'cleanup:r1');
});

test('update_reward reads Twitch for live values, compare-and-sets, patches Twitch then our copy, and undoes', async () => {
    const ctx = makeCtx();
    state.reward = { rewardID: 'r1', eventsubID: 'es1', title: 'Hydrate', cost: 100, message: '' };
    await assert.rejects(updateReward.run(updateReward.validate({ reward: 'nope', cost: 5 }), ctx), /No DomDimaBot reward/);
    const proposal = await propose(updateReward, { reward: 'hydrate', cost: 250, isPaused: true }, ctx);
    assert.deepEqual(proposal.before, { cost: 100, isPaused: false });
    assert.deepEqual(proposal.after, { cost: 250, isPaused: true });
    state.twitch.cost = 120; // changed on Twitch in the meantime
    await assert.rejects(applyProposal(updateReward, proposal, ctx), ToolConflictError);
    state.twitch.cost = 100;
    const { change } = await applyProposal(updateReward, proposal, ctx);
    assert.deepEqual(calls, ['patch-reward:{"cost":250,"isPaused":true}', 'db-reward:{"cost":250,"isPaused":true}']);
    await undoChange(updateReward, change!, ctx);
    assert.deepEqual(calls.slice(-2), ['patch-reward:{"cost":100,"isPaused":false}', 'db-reward:{"cost":100,"isPaused":false}']);
    const twitchOnly = await propose(updateReward, { reward: 'r1', maxPerStream: 3 }, ctx);
    calls.length = 0;
    await applyProposal(updateReward, twitchOnly, ctx);
    assert.deepEqual(calls, ['patch-reward:{"maxPerStream":3}'], 'Twitch-only settings are never stored in our DB (route behavior)');
});
