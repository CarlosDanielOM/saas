import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test, { type TestContext } from 'node:test';
import { Types } from 'mongoose';
import UsersSchema from '../../../schemas/users.schema.js';
import { ClipRecommendationSchema, type IClipRecommendation } from '../../../schemas/clip_recommendation.schema.js';
import { ClipRecommendationConfigSchema } from '../../../schemas/clip_recommendation_config.schema.js';
import { runVodClipRecommendationWorkflow, type RunVodClipRecommendationInput } from './vod_clip_recommendation_runner.js';

type Dependencies = Required<NonNullable<Parameters<typeof runVodClipRecommendationWorkflow>[1]>>;
const now = Date.UTC(2026, 0, 1);
const input: RunVodClipRecommendationInput = {
    channelID: 'channel-123',
    channel: ' streamer ',
    vodUrl: 'https://www.twitch.tv/videos/123',
    queueJobID: 'queue-job-123',
    source: 'manual',
    recoveryOnly: true
};

function fixture(context: TestContext, overrides: Partial<IClipRecommendation> = {}) {
    context.mock.timers.enable({ apis: ['Date'], now });
    const rec = new ClipRecommendationSchema({
        _id: new Types.ObjectId('0123456789abcdef01234567'),
        channelID: input.channelID,
        vodUrl: input.vodUrl,
        queueJobID: input.queueJobID,
        source: 'manual',
        status: 'completed',
        analysisCompletedAt: new Date(now - 60_000),
        completedAt: new Date(now - 60_000),
        billingStatus: 'pending',
        costCredits: 2750,
        candidateCount: 1,
        approvedCount: 1,
        notificationStatus: 'pending',
        notificationPayload: {
            from: 'clips@example.com', to: ['streamer@example.com'],
            subject: 'Clips ready', html: '<p>Ready</p>', text: 'Ready'
        },
        candidates: [{
            _id: new Types.ObjectId('abcdef0123456789abcdef01'),
            startSeconds: 10, endSeconds: 30, reason: 'Saved moment',
            status: 'approved', videoApproved: true,
            s3Key: 'clip-recommendations/channel-123/0123456789abcdef01234567/abcdef0123456789abcdef01.mp4',
            previewUrl: 'https://previews.example.com/saved.mp4'
        }],
        ...overrides
    });
    const user = new UsersSchema({
        name: 'Streamer', email: 'streamer@example.com', language: 'en',
        accounts: [{ id: input.channelID, type: 'twitch' }]
    }).toObject();
    const save = context.mock.method(rec, 'save', async () => rec);
    const recordExec = context.mock.fn(async (): Promise<typeof rec | null> => rec);
    const findOne = context.mock.method(ClipRecommendationSchema, 'findOne', (filter: unknown) => {
        assert.deepEqual(filter, { queueJobID: input.queueJobID });
        return {
            select: (selection: string) => {
                assert.equal(selection, '+notificationPayload');
                return { exec: recordExec };
            }
        } as unknown as ReturnType<typeof ClipRecommendationSchema.findOne>;
    });
    const userExec = context.mock.fn(async () => user);
    const findUser = context.mock.method(UsersSchema, 'findOne', (filter: unknown) => {
        assert.deepEqual(filter, { accounts: { $elemMatch: { id: input.channelID, type: 'twitch' } } });
        return { lean: () => ({ exec: userExec }) } as unknown as ReturnType<typeof UsersSchema.findOne>;
    });
    const create = context.mock.method(ClipRecommendationSchema, 'create', () => assert.fail('Recovery must never create a recommendation'));
    const conditionalUpdate = context.mock.method(ClipRecommendationSchema, 'findOneAndUpdate', () => assert.fail('Unexpected conditional write'));
    const updateByID = context.mock.method(ClipRecommendationSchema, 'findByIdAndUpdate', () => assert.fail('Unexpected record write'));
    const updateConfig = context.mock.method(ClipRecommendationConfigSchema, 'updateOne', () => assert.fail('Unexpected config write'));
    const deps = {
        charge: context.mock.fn<Dependencies['charge']>(async () => assert.fail('Unexpected charge')),
        notify: context.mock.fn<Dependencies['notify']>(async () => assert.fail('Unexpected notification')),
        deletePreviews: context.mock.fn<Dependencies['deletePreviews']>(async () => assert.fail('Unexpected preview deletion')),
        reportError: context.mock.fn<Dependencies['reportError']>(async () => ({ success: true }))
    };
    // Recovery must stop before filesystem work, downloads, or provider requests.
    const forbidden = [
        create,
        context.mock.method(fs, 'mkdir', () => assert.fail('Recovery must not create a work directory')),
        context.mock.method(fs, 'rm', () => assert.fail('Recovery must not remove a work directory')),
        context.mock.method(childProcess, 'spawn', () => assert.fail('Recovery must not start a process')),
        context.mock.method(globalThis, 'fetch', () => assert.fail('Recovery must not call an API'))
    ];
    syncBuiltinESMExports();
    context.after(() => {
        for (const mock of forbidden) assert.equal(mock.mock.callCount(), 0);
        context.mock.restoreAll();
        syncBuiltinESMExports();
    });
    return { rec, user, save, recordExec, findOne, findUser, userExec, conditionalUpdate, updateByID, updateConfig, deps };
}

test('completed analysis retries pending billing on the same document and queue ID before notifying', async (context) => {
    const { rec, user, save, updateConfig, conditionalUpdate, updateByID, deps } = fixture(context);
    const before = rec.toObject();
    const effects: string[] = [];
    deps.charge.mock.mockImplementation(async (document, owner, channelID, verifyBalance) => {
        effects.push('charge');
        assert.equal(document, rec);
        assert.equal(document.queueJobID, input.queueJobID);
        assert.equal(String(document._id), String(before._id));
        assert.equal(owner, user);
        assert.equal(channelID, input.channelID);
        assert.equal(verifyBalance, false);
        document.billingStatus = 'charged';
        return null;
    });
    updateConfig.mock.mockImplementation(((filter: unknown, update: unknown, options: unknown) => {
        effects.push('config');
        assert.deepEqual(filter, { channelID: input.channelID });
        assert.deepEqual(update, { $set: { lastAnalyzedAt: new Date(now) }, $setOnInsert: { autoAnalyzeEnabled: false } });
        assert.deepEqual(options, { upsert: true });
        return Promise.resolve({ acknowledged: true });
    }) as unknown as typeof ClipRecommendationConfigSchema.updateOne);
    deps.notify.mock.mockImplementation(async (document, owner, channelID, channel) => {
        effects.push('notify');
        assert.equal(document, rec);
        assert.equal(owner, user);
        assert.equal(channelID, input.channelID);
        assert.equal(channel, 'streamer');
        assert.equal(document.billingStatus, 'charged');
        assert.deepEqual(document.toObject().notificationPayload, before.notificationPayload);
    });

    const result = await runVodClipRecommendationWorkflow(input, deps);

    assert.deepEqual(result, {
        error: false, status: 'completed', message: 'Clip recommendation billing recovered',
        recommendationID: String(rec._id), candidateCount: 1, approvedCount: 1
    });
    assert.deepEqual(effects, ['charge', 'config', 'notify']);
    assert.deepEqual(rec.toObject(), { ...before, billingStatus: 'charged' });
    assert.equal(save.mock.callCount(), 0);
    assert.equal(conditionalUpdate.mock.callCount(), 0);
    assert.equal(updateByID.mock.callCount(), 0);
    assert.equal(deps.deletePreviews.mock.callCount(), 0);
    assert.equal(deps.reportError.mock.callCount(), 0);
});

test('charged analysis with failed notification only retries notification', async (context) => {
    const { rec, user, save, updateConfig, conditionalUpdate, updateByID, deps } = fixture(context, {
        billingStatus: 'charged', notificationStatus: 'failed'
    });
    const before = rec.toObject();
    deps.notify.mock.mockImplementation(async (document, owner, channelID, channel) => {
        assert.equal(document, rec);
        assert.equal(owner, user);
        assert.equal(channelID, input.channelID);
        assert.equal(channel, 'streamer');
    });

    const result = await runVodClipRecommendationWorkflow(input, deps);

    assert.equal(result.error, false);
    assert.equal(result.status, 'completed');
    assert.equal(result.recommendationID, String(rec._id));
    assert.equal(deps.notify.mock.callCount(), 1);
    assert.equal(deps.charge.mock.callCount(), 0);
    assert.equal(deps.deletePreviews.mock.callCount(), 0);
    assert.equal(deps.reportError.mock.callCount(), 0);
    assert.equal(save.mock.callCount(), 0);
    assert.equal(updateConfig.mock.callCount(), 0);
    assert.equal(conditionalUpdate.mock.callCount(), 0);
    assert.equal(updateByID.mock.callCount(), 0);
    assert.deepEqual(rec.toObject(), before);
});

for (const state of ['sent', 'missing', 'incomplete', 'unkeyed', 'foreign-channel'] as const) {
    test(`recovery is a side-effect-free ${state === 'sent' ? 'no-op' : 'nonretryable refusal'} for ${state}`, async (context) => {
        const { rec, save, recordExec, findOne, findUser, conditionalUpdate, updateByID, updateConfig, deps } = fixture(context, {
            billingStatus: 'charged', notificationStatus: 'sent',
            ...(state === 'incomplete' ? { status: 'processing', analysisCompletedAt: null, billingStatus: 'pending' } : {}),
            ...(state === 'foreign-channel' ? { channelID: 'another-channel' } : {})
        });
        if (state === 'missing') recordExec.mock.mockImplementation(async () => null);
        const before = rec.toObject();

        const result = await runVodClipRecommendationWorkflow({ ...input, ...(state === 'unkeyed' ? { queueJobID: undefined } : {}) }, deps);

        assert.equal(result.error, state !== 'sent');
        assert.equal(result.status, state === 'sent' ? 'completed' : 'failed');
        if (state !== 'sent') assert.equal(result.retryable, false);
        if (state === 'foreign-channel') assert.match(result.message, /another channel/);
        assert.equal(findOne.mock.callCount(), state === 'unkeyed' ? 0 : 1);
        assert.equal(findUser.mock.callCount(), 0);
        assert.equal(save.mock.callCount(), 0);
        assert.equal(conditionalUpdate.mock.callCount(), 0);
        assert.equal(updateByID.mock.callCount(), 0);
        assert.equal(updateConfig.mock.callCount(), 0);
        for (const effect of Object.values(deps)) assert.equal(effect.mock.callCount(), 0);
        assert.deepEqual(rec.toObject(), before);
    });
}

test('cleanup-only removes the failed document own previews and clears cleanup flags without charging', async (context) => {
    const { rec, save, findUser, conditionalUpdate, updateByID, updateConfig, deps } = fixture(context, {
        status: 'failed', analysisCompletedAt: null, previewCleanupPending: true,
        previewCleanupError: 'Previous deletion failed', previewCleanupNextRetryAt: new Date(now - 1)
    });
    const before = rec.toObject();
    const removed: string[] = [];
    deps.deletePreviews.mock.mockImplementation(async (document) => {
        assert.equal(document, rec);
        assert.equal(document.channelID, input.channelID);
        for (const candidate of document.candidates) {
            assert.ok(candidate.s3Key.startsWith(`clip-recommendations/${input.channelID}/${rec._id}/`));
            removed.push(candidate.s3Key);
        }
    });

    const result = await runVodClipRecommendationWorkflow({ ...input, cleanupOnly: true }, deps);

    assert.equal(result.error, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.recommendationID, String(rec._id));
    assert.deepEqual(removed, before.candidates.map((candidate) => candidate.s3Key));
    assert.equal(deps.deletePreviews.mock.callCount(), 1);
    assert.deepEqual(rec.toObject(), { ...before, previewCleanupPending: false, previewCleanupError: '', previewCleanupNextRetryAt: null });
    assert.equal(save.mock.callCount(), 1);
    assert.equal(findUser.mock.callCount(), 0);
    assert.equal(conditionalUpdate.mock.callCount(), 0);
    assert.equal(updateByID.mock.callCount(), 0);
    assert.equal(updateConfig.mock.callCount(), 0);
    assert.equal(deps.charge.mock.callCount(), 0);
    assert.equal(deps.notify.mock.callCount(), 0);
    assert.equal(deps.reportError.mock.callCount(), 0);
});

for (const state of ['completed', 'charged', 'persisted-analysis'] as const) {
    test(`cleanup-only skips ${state} records without modifying them`, async (context) => {
        const { rec, save, findUser, conditionalUpdate, updateByID, updateConfig, deps } = fixture(context, {
            status: state === 'completed' ? 'completed' : 'failed',
            analysisCompletedAt: state === 'persisted-analysis' ? new Date(now - 1) : null,
            billingStatus: state === 'charged' ? 'charged' : 'pending',
            previewCleanupPending: true, previewCleanupError: 'Previous failure', previewCleanupNextRetryAt: new Date(now - 1)
        });
        const before = rec.toObject();

        const result = await runVodClipRecommendationWorkflow({ ...input, cleanupOnly: true }, deps);

        assert.equal(result.error, false);
        assert.equal(result.status, 'completed');
        assert.deepEqual(rec.toObject(), before);
        assert.equal(save.mock.callCount(), 0);
        assert.equal(findUser.mock.callCount(), 0);
        assert.equal(conditionalUpdate.mock.callCount(), 0);
        assert.equal(updateByID.mock.callCount(), 0);
        assert.equal(updateConfig.mock.callCount(), 0);
        for (const effect of Object.values(deps)) assert.equal(effect.mock.callCount(), 0);
    });
}

test('failed cleanup retains pending, deletion error, and retry deadline through the conditional failed guard', async (context) => {
    const { rec, save, conditionalUpdate, updateByID, updateConfig, deps } = fixture(context, {
        status: 'failed', analysisCompletedAt: null, previewCleanupPending: true
    });
    const candidates = rec.toObject().candidates;
    deps.deletePreviews.mock.mockImplementation(async (document) => {
        assert.equal(document, rec);
        throw new Error('Preview deletion unavailable');
    });
    conditionalUpdate.mock.mockImplementation(((filter: unknown, update: unknown, options: unknown) => {
        assert.deepEqual(filter, { _id: String(rec._id), analysisCompletedAt: null, billingStatus: { $ne: 'charged' } });
        assert.deepEqual(options, { new: true });
        assert.equal(rec.analysisCompletedAt, null);
        assert.notEqual(rec.billingStatus, 'charged');
        return { exec: async () => {
            rec.set((update as { $set: Partial<IClipRecommendation> }).$set);
            return rec;
        } };
    }) as unknown as typeof ClipRecommendationSchema.findOneAndUpdate);

    const result = await runVodClipRecommendationWorkflow({ ...input, cleanupOnly: true }, deps);

    assert.equal(result.error, true);
    assert.equal(result.status, 'failed');
    assert.equal(result.retryable, true);
    assert.equal(rec.status, 'failed');
    assert.equal(rec.previewCleanupPending, true);
    assert.equal(rec.previewCleanupError, 'Preview deletion unavailable');
    assert.equal(rec.previewCleanupNextRetryAt?.getTime(), now + 60 * 60 * 1000);
    assert.deepEqual(rec.toObject().candidates, candidates);
    assert.equal(conditionalUpdate.mock.callCount(), 1);
    assert.equal(save.mock.callCount(), 1);
    assert.equal(deps.deletePreviews.mock.callCount(), 2);
    assert.equal(deps.reportError.mock.callCount(), 1);
    assert.equal(deps.charge.mock.callCount(), 0);
    assert.equal(deps.notify.mock.callCount(), 0);
    assert.equal(updateByID.mock.callCount(), 0);
    assert.equal(updateConfig.mock.callCount(), 0);
});

test('a pre-analysis failure cannot overwrite a concurrently completed record or clean its previews again', async (context) => {
    const { rec, save, conditionalUpdate, updateByID, updateConfig, deps } = fixture(context, {
        status: 'failed', analysisCompletedAt: null, previewCleanupPending: true
    });
    // The worker holds a stale document; the conditional DB guard sees a committed completion.
    const persisted = new ClipRecommendationSchema({
        ...rec.toObject(), status: 'completed', analysisCompletedAt: new Date(now), billingStatus: 'charged'
    });
    const persistedSave = context.mock.method(persisted, 'save', async () => assert.fail('Must not save the completed record'));
    const before = persisted.toObject();
    const staleBefore = rec.toObject();
    deps.deletePreviews.mock.mockImplementation(async (document) => {
        assert.equal(document, rec);
        throw new Error('Pre-analysis cleanup failed');
    });
    conditionalUpdate.mock.mockImplementation(((filter: unknown, _update: unknown, options: unknown) => {
        assert.deepEqual(filter, { _id: String(persisted._id), analysisCompletedAt: null, billingStatus: { $ne: 'charged' } });
        assert.deepEqual(options, { new: true });
        assert.ok(persisted.analysisCompletedAt);
        assert.equal(persisted.billingStatus, 'charged');
        return { exec: async () => null };
    }) as unknown as typeof ClipRecommendationSchema.findOneAndUpdate);

    const result = await runVodClipRecommendationWorkflow({ ...input, cleanupOnly: true }, deps);

    assert.equal(result.error, true);
    assert.match(result.message, /Pre-analysis cleanup failed/);
    assert.equal(conditionalUpdate.mock.callCount(), 1);
    assert.equal(deps.deletePreviews.mock.callCount(), 1);
    assert.equal(save.mock.callCount(), 0);
    assert.equal(persistedSave.mock.callCount(), 0);
    assert.deepEqual(persisted.toObject(), before);
    assert.deepEqual(rec.toObject(), staleBefore);
    assert.equal(updateByID.mock.callCount(), 0);
    assert.equal(updateConfig.mock.callCount(), 0);
    assert.equal(deps.charge.mock.callCount(), 0);
    assert.equal(deps.notify.mock.callCount(), 0);
    assert.equal(deps.reportError.mock.callCount(), 1);
});

test('a thrown billing recovery error schedules six hours later without restarting completed analysis', async (context) => {
    const { rec, save, updateByID, conditionalUpdate, updateConfig, deps } = fixture(context);
    const before = rec.toObject();
    deps.charge.mock.mockImplementation(async (document, _user, _channelID, verifyBalance) => {
        assert.equal(document, rec);
        assert.equal(verifyBalance, false);
        throw new Error('Billing provider unavailable');
    });
    updateByID.mock.mockImplementation(((id: unknown, update: unknown) => {
        assert.equal(id, String(rec._id));
        assert.deepEqual(update, { $set: {
            billingStatus: 'failed', chargeError: 'Billing provider unavailable',
            billingNextRetryAt: new Date(now + 6 * 60 * 60 * 1000)
        } });
        return { exec: async () => {
            rec.set((update as { $set: Partial<IClipRecommendation> }).$set);
            return rec;
        } };
    }) as unknown as typeof ClipRecommendationSchema.findByIdAndUpdate);

    const result = await runVodClipRecommendationWorkflow(input, deps);

    assert.equal(result.error, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.phase, 'billing');
    assert.equal(result.retryable, true);
    assert.equal(result.recommendationID, String(rec._id));
    assert.deepEqual(rec.toObject(), {
        ...before, billingStatus: 'failed', chargeError: 'Billing provider unavailable',
        billingNextRetryAt: new Date(now + 6 * 60 * 60 * 1000)
    });
    assert.equal(deps.charge.mock.callCount(), 1);
    assert.equal(updateByID.mock.callCount(), 1);
    assert.equal(conditionalUpdate.mock.callCount(), 0);
    assert.equal(updateConfig.mock.callCount(), 0);
    assert.equal(save.mock.callCount(), 0);
    assert.equal(deps.notify.mock.callCount(), 0);
    assert.equal(deps.deletePreviews.mock.callCount(), 0);
    assert.equal(deps.reportError.mock.callCount(), 1);
});

test('a returned billing error stays retryable and never notifies or reruns analysis', async (context) => {
    const { rec, save, updateByID, conditionalUpdate, updateConfig, deps } = fixture(context);
    const before = rec.toObject();
    deps.charge.mock.mockImplementation(async () => 'Charge needs retry');

    const result = await runVodClipRecommendationWorkflow(input, deps);

    assert.equal(result.error, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.phase, 'billing');
    assert.equal(result.retryable, true);
    assert.match(result.message, /Charge needs retry/);
    assert.equal(deps.charge.mock.callCount(), 1);
    assert.equal(deps.notify.mock.callCount(), 0);
    assert.equal(deps.deletePreviews.mock.callCount(), 0);
    assert.equal(deps.reportError.mock.callCount(), 0);
    assert.equal(save.mock.callCount(), 0);
    assert.equal(updateByID.mock.callCount(), 0);
    assert.equal(conditionalUpdate.mock.callCount(), 0);
    assert.equal(updateConfig.mock.callCount(), 0);
    assert.deepEqual(rec.toObject(), before);
});

for (const phase of ['entry', 'billing', 'notification', 'cleanup'] as const) {
    test(`lease assertion failure before ${phase} rejects without effects or DB writes`, async (context) => {
        const { rec, save, findOne, updateByID, conditionalUpdate, updateConfig, deps } = fixture(context, {
            ...(phase === 'notification' ? { billingStatus: 'charged', notificationStatus: 'failed' } : {}),
            ...(phase === 'cleanup' ? { status: 'failed', analysisCompletedAt: null, previewCleanupPending: true } : {})
        });
        const before = rec.toObject();
        const leaseError = new Error('Lease no longer owned');
        let checks = 0;
        const assertActive = context.mock.fn(async () => {
            if (++checks >= (phase === 'entry' ? 1 : 2)) throw leaseError;
        });

        await assert.rejects(runVodClipRecommendationWorkflow({
            ...input, cleanupOnly: phase === 'cleanup', assertActive
        }, deps), (error: unknown) => error === leaseError);

        assert.equal(assertActive.mock.callCount(), phase === 'entry' ? 2 : 3);
        assert.equal(findOne.mock.callCount(), phase === 'entry' ? 0 : 1);
        assert.equal(save.mock.callCount(), 0);
        assert.equal(updateByID.mock.callCount(), 0);
        assert.equal(conditionalUpdate.mock.callCount(), 0);
        assert.equal(updateConfig.mock.callCount(), 0);
        for (const effect of Object.values(deps)) assert.equal(effect.mock.callCount(), 0);
        assert.deepEqual(rec.toObject(), before);
    });
}
