import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { Types } from 'mongoose';
import type { IClipRecommendation } from '../../../schemas/clip_recommendation.schema.js';

export async function deleteClipRecommendationPreviews(
    rec: Pick<IClipRecommendation, '_id' | 'channelID' | 'candidates'>,
    injectedDelete?: (keys: string[]) => Promise<{ Errors?: unknown[] }>
): Promise<void> {
    if (typeof rec.channelID !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(rec.channelID)) {
        throw new Error('Invalid clip recommendation channelID');
    }
    if ((typeof rec._id !== 'string' && !(rec._id instanceof Types.ObjectId))
        || !/^[a-fA-F0-9]{24}$/.test(String(rec._id))) {
        throw new Error('Invalid clip recommendation _id');
    }

    const prefix = `clip-recommendations/${rec.channelID}/${String(rec._id)}/`;
    const keys = new Set<string>();
    for (const candidate of rec.candidates) {
        let key = candidate.s3Key;
        if (key === undefined || key === null || key === '') {
            if (candidate._id === undefined || candidate._id === null) continue;
            if ((typeof candidate._id !== 'string' && !(candidate._id instanceof Types.ObjectId))
                || !/^[a-fA-F0-9]{24}$/.test(String(candidate._id))) {
                throw new Error('Invalid clip recommendation candidate _id');
            }
            // Upload may have succeeded before its key was saved on the candidate.
            key = `${prefix}${candidate._id}.mp4`;
        }
        if (typeof key !== 'string' || !key.startsWith(prefix) || key.length === prefix.length) {
            throw new Error('Clip recommendation preview key is outside the recommendation scope');
        }
        keys.add(key);
    }
    if (keys.size === 0) return;

    // Validate the entire collection before loading the client or deleting any batch.
    let deleteKeys = injectedDelete;
    if (!deleteKeys) {
        const { s3Client, BUCKET } = await import('../../s3.js');
        deleteKeys = (batch) => s3Client.send(new DeleteObjectsCommand({
            Bucket: BUCKET,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true }
        }));
    }
    const uniqueKeys = [...keys];
    for (let offset = 0; offset < uniqueKeys.length; offset += 1000) {
        const response = await deleteKeys(uniqueKeys.slice(offset, offset + 1000));
        if (response.Errors?.length) {
            throw new Error('Failed to delete clip recommendation previews', { cause: response.Errors });
        }
    }
}
