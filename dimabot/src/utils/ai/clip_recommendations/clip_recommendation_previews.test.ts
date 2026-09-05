import assert from 'node:assert/strict';
import test from 'node:test';
import { Types } from 'mongoose';
import type { IClipRecommendation, IClipRecommendationCandidate } from '../../../schemas/clip_recommendation.schema.js';
import { deleteClipRecommendationPreviews } from './clip_recommendation_previews.js';

const recommendationID = '0123456789abcdef01234567';
const candidateID = 'abcdef0123456789abcdef01';
const prefix = `clip-recommendations/channel-123/${recommendationID}/`;

function fixture(candidates: Partial<IClipRecommendationCandidate>[] = []): Pick<IClipRecommendation, '_id' | 'channelID' | 'candidates'> {
    return {
        _id: new Types.ObjectId(recommendationID),
        channelID: 'channel-123',
        candidates: candidates as IClipRecommendationCandidate[]
    };
}

test('deletes only the recommendation own keys without mutating the record', async () => {
    const rec = fixture([{ s3Key: `${prefix}first.mp4` }, { s3Key: `${prefix}second.mp4` }]);
    const before = JSON.stringify(rec);
    const batches: string[][] = [];
    await deleteClipRecommendationPreviews(rec, async (keys) => {
        batches.push(keys);
        return { Errors: [] };
    });
    assert.deepEqual(batches, [[`${prefix}first.mp4`, `${prefix}second.mp4`]]);
    assert.equal(JSON.stringify(rec), before);
});

test('reconstructs exact upload keys for absent, null, and schema-default empty keys', async () => {
    for (const s3Key of [undefined, null, '']) {
        const rec = fixture([{ _id: new Types.ObjectId(candidateID), s3Key: s3Key as string }]);
        const batches: string[][] = [];
        await deleteClipRecommendationPreviews(rec, async (keys) => {
            batches.push(keys);
            return {};
        });
        assert.deepEqual(batches, [[`${prefix}${candidateID}.mp4`]]);
    }
});

test('accepts serialized ObjectId strings without changing their keys', async () => {
    const rec = fixture([{ _id: candidateID as unknown as Types.ObjectId }]);
    rec._id = recommendationID as unknown as Types.ObjectId;
    await deleteClipRecommendationPreviews(rec, async (keys) => {
        assert.deepEqual(keys, [`${prefix}${candidateID}.mp4`]);
        return {};
    });
});

test('rejects foreign, prefix-only, and malformed keys before deleting any batch', async () => {
    for (const key of [
        `clip-recommendations/other-channel/${recommendationID}/preview.mp4`,
        `clip-recommendations/channel-123/${candidateID}/preview.mp4`,
        `${prefix.slice(0, -1)}-other/preview.mp4`,
        prefix,
        ' ',
        0
    ]) {
        const rec = fixture([
            ...Array.from({ length: 1001 }, (_, i) => ({ s3Key: `${prefix}${i}.mp4` })),
            { _id: new Types.ObjectId(candidateID), s3Key: key as string }
        ]);
        let calls = 0;
        await assert.rejects(deleteClipRecommendationPreviews(rec, async () => {
            calls++;
            return {};
        }), /outside the recommendation scope/);
        assert.equal(calls, 0);
    }
});

test('deduplicates both saved and reconstructed keys', async () => {
    const key = `${prefix}${candidateID}.mp4`;
    const rec = fixture([
        { s3Key: key }, { s3Key: key }, { _id: new Types.ObjectId(candidateID), s3Key: '' }
    ]);
    const batches: string[][] = [];
    await deleteClipRecommendationPreviews(rec, async (keys) => {
        batches.push(keys);
        return {};
    });
    assert.deepEqual(batches, [[key]]);
});

test('batches unique keys at the 1000-key limit', async () => {
    for (const count of [1000, 1001, 2001]) {
        const keys = Array.from({ length: count }, (_, i) => `${prefix}${i}.mp4`);
        const batches: string[][] = [];
        await deleteClipRecommendationPreviews(fixture(keys.map((s3Key) => ({ s3Key }))), async (batch) => {
            batches.push(batch);
            return {};
        });
        assert.deepEqual(batches.flat(), keys);
        assert.equal(batches.length, Math.ceil(count / 1000));
        assert.ok(batches.every((batch) => batch.length > 0 && batch.length <= 1000));
    }
});

test('reported delete errors throw with details and prevent subsequent batches', async () => {
    const errors = [{ Key: `${prefix}0.mp4`, Code: 'AccessDenied' }];
    let calls = 0;
    await assert.rejects(deleteClipRecommendationPreviews(fixture(
        Array.from({ length: 1001 }, (_, i) => ({ s3Key: `${prefix}${i}.mp4` }))
    ), async () => {
        calls++;
        return { Errors: errors };
    }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Failed to delete/);
        assert.equal(error.cause, errors);
        return true;
    });
    assert.equal(calls, 1);
});

test('delete rejections propagate unchanged and prevent subsequent batches', async () => {
    const failure = new Error('Delete request failed');
    let calls = 0;
    await assert.rejects(deleteClipRecommendationPreviews(fixture(
        Array.from({ length: 1001 }, (_, i) => ({ s3Key: `${prefix}${i}.mp4` }))
    ), async () => {
        calls++;
        throw failure;
    }), (error: unknown) => error === failure);
    assert.equal(calls, 1);
});

test('empty collections and candidates without keys or IDs are no-ops, including without injection', async () => {
    for (const rec of [fixture(), fixture([{}, { s3Key: '' }])]) {
        await deleteClipRecommendationPreviews(rec, async () => assert.fail('Must not delete'));
        await deleteClipRecommendationPreviews(rec);
    }
});

test('rejects unsafe channel IDs before deletion', async () => {
    for (const channelID of ['', ' ', '/', '..', 'channel/other', 'channel\\other', 'channel\n', null, undefined, 123]) {
        const rec = fixture([{ s3Key: `${prefix}preview.mp4` }]);
        rec.channelID = channelID as string;
        await assert.rejects(deleteClipRecommendationPreviews(rec, async () => assert.fail('Must not delete')), /Invalid clip recommendation channelID/);
    }
});

test('rejects malformed recommendation and reconstruction IDs before deletion', async () => {
    for (const id of ['', ' ', '..', 'other/path', 'a'.repeat(23), 'g'.repeat(24), null, undefined, 123, { toString: () => recommendationID }]) {
        const rec = fixture([{ s3Key: `${prefix}preview.mp4` }]);
        rec._id = id as Types.ObjectId;
        await assert.rejects(deleteClipRecommendationPreviews(rec, async () => assert.fail('Must not delete')), /Invalid clip recommendation _id/);
        if (id !== null && id !== undefined) {
            await assert.rejects(deleteClipRecommendationPreviews(fixture([
                { s3Key: `${prefix}preview.mp4` }, { _id: id as Types.ObjectId }
            ]), async () => assert.fail('Must not delete')), /Invalid clip recommendation candidate _id/);
        }
    }
});
