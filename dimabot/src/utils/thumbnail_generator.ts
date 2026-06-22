import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import pLimit from 'p-limit';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Types } from 'mongoose';
import { MediaAssetSchema, type IMediaAsset } from '../schemas/media_asset.schema.js';
import { BUCKET, getS3PublicObjectUrl, s3Client } from './s3.js';

const execFileP = (command: string, args: string[]): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                const wrapped = error instanceof Error ? error : new Error(String(error));
                (wrapped as Error & { stderr?: string }).stderr = stderr;
                reject(wrapped);
                return;
            }
            resolve({ stdout, stderr });
        });
    });

// Cap concurrent ffmpeg jobs per process so a burst of uploads does not
// saturate CPU. ffmpeg is heavy (single-threaded per job, ~1 CPU each).
const limit = pLimit(2);

const THUMB_WIDTH = 480;
const THUMB_JPEG_QUALITY = 5; // ffmpeg -q:v scale (2=best, 31=worst; 5 ≈ q82)
const MAX_INPUT_FETCH_BYTES = 200 * 1024 * 1024; // 200MB safety cap

/**
 * Generates and persists a 480px-wide JPEG thumbnail for a media asset.
 *
 * - For images/gifs: rescales the original to fit THUMB_WIDTH.
 * - For videos: extracts the frame at +1.0s and rescales.
 * - For audio: returns immediately (UI shows a generated waveform).
 *
 * The result is stored as a new MediaAsset (mediaType: 'image', scope: 'system',
 * marketplaceStatus: 'not_listed') and its _id is written back to the parent's
 * `thumbnailAssetID`. The thumbnail is served through the same /media/{id}
 * endpoint as audio/video, so it always resolves to https://api.domdimabot.com.
 *
 * Idempotent: if the parent already has a `thumbnailAssetID`, the call is a no-op.
 * Safe to call concurrently: a p-limit(2) semaphore plus the `thumbnailStatus`
 * state machine prevents duplicate generation.
 */
export async function generateAndStoreThumbnail(parentAssetID: Types.ObjectId | string): Promise<void> {
    return limit(async () => {
        const parent = await MediaAssetSchema.findById(parentAssetID).lean<IMediaAsset>().exec();
        if (!parent) return;

        if (parent.thumbnailStatus === 'ready' && parent.thumbnailAssetID) return;
        if (parent.mediaType === 'audio') {
            // Mark as skipped so we never retry.
            await MediaAssetSchema.updateOne(
                { _id: parent._id, thumbnailStatus: { $ne: 'ready' } },
                { $set: { thumbnailStatus: 'skipped', thumbnailLastError: null } }
            );
            return;
        }

        await MediaAssetSchema.updateOne(
            { _id: parent._id },
            { $inc: { thumbnailAttempts: 1 }, $set: { thumbnailStatus: 'pending' } }
        );

        const tmpIn = path.join(os.tmpdir(), `dima-in-${crypto.randomBytes(6).toString('hex')}`);
        const tmpOut = path.join(os.tmpdir(), `dima-out-${crypto.randomBytes(6).toString('hex')}.jpg`);

        try {
            // 1. Stream the original from S3 to a local tmp file.
            const res = await fetch(parent.storageUrl);
            if (!res.ok) {
                throw new Error(`Failed to fetch source: HTTP ${res.status}`);
            }
            const contentLength = Number(res.headers.get('content-length') || 0);
            if (contentLength > MAX_INPUT_FETCH_BYTES) {
                throw new Error(`Source too large for thumbnail (${contentLength} bytes)`);
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            await fs.writeFile(tmpIn, buffer);

            // 2. Run ffmpeg to produce a 480px-wide JPEG.
            //    For videos, seek to 1s (skip black opening frames / channel intros).
            //    For images/gifs, just rescale the first frame.
            const isVideo = parent.mediaType === 'video';
            const args = isVideo
                ? ['-y', '-ss', '00:00:01', '-i', tmpIn, '-vframes', '1', '-vf', `scale=${THUMB_WIDTH}:-1`, '-q:v', String(THUMB_JPEG_QUALITY), tmpOut]
                : ['-y', '-i', tmpIn, '-vf', `scale=${THUMB_WIDTH}:-1`, '-q:v', String(THUMB_JPEG_QUALITY), tmpOut];
            await execFileP('ffmpeg', args);

            // 3. Verify ffmpeg actually produced a non-empty file.
            const stat = await fs.stat(tmpOut);
            if (stat.size < 256) {
                throw new Error('ffmpeg produced an empty/invalid output');
            }
            const thumbBuffer = await fs.readFile(tmpOut);

            // 4. Upload to S3 and create a sibling MediaAsset row.
            const thumbKey = `library/thumbnails/${crypto.randomBytes(8).toString('hex')}.jpg`;
            await s3Client.send(new PutObjectCommand({
                Bucket: BUCKET,
                Key: thumbKey,
                Body: thumbBuffer,
                ContentType: 'image/jpeg',
                ACL: 'public-read',
                CacheControl: 'public, max-age=31536000, immutable'
            }));

            const thumbAsset = await MediaAssetSchema.create({
                ownerUserID: parent.ownerUserID,
                ownerChannelID: parent.ownerChannelID,
                ownerChannelName: parent.ownerChannelName,
                uploadedByUserID: parent.uploadedByUserID,
                originalName: `${parent.originalName}.thumb.jpg`,
                displayName: `${parent.displayName} (thumbnail)`,
                fileName: `${parent.fileName}.thumb.jpg`,
                extension: 'jpg',
                mimeType: 'image/jpeg',
                mediaType: 'image',
                bytes: thumbBuffer.length,
                bucket: process.env.S3_BUCKET || '',
                s3Key: thumbKey,
                storageUrl: getS3PublicObjectUrl(thumbKey),
                proxyPath: null,
                scope: 'system',
                marketplaceStatus: 'not_listed',
                checksumSha256: null,
                libraryCount: 0,
                triggerReferenceCount: 0,
                alertReferenceCount: 0,
                extensionReferenceCount: 0,
                deletedAt: null
            });

            await MediaAssetSchema.updateOne(
                { _id: parent._id },
                {
                    $set: {
                        thumbnailAssetID: thumbAsset._id,
                        thumbnailStatus: 'ready',
                        thumbnailLastError: null
                    }
                }
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[thumbnail_generator] failed for asset', String(parent._id), {
                mediaType: parent.mediaType,
                error: message,
                timestamp: new Date().toISOString()
            });
            await MediaAssetSchema.updateOne(
                { _id: parent._id },
                { $set: { thumbnailStatus: 'failed', thumbnailLastError: message } }
            );
        } finally {
            await fs.unlink(tmpIn).catch(() => undefined);
            await fs.unlink(tmpOut).catch(() => undefined);
        }
    });
}

/**
 * Schedules thumbnail generation for a parent asset without awaiting it.
 * Safe to call from request handlers — failures are logged inside the generator.
 */
export function scheduleThumbnailGeneration(parentAssetID: Types.ObjectId | string): void {
    generateAndStoreThumbnail(parentAssetID).catch((err) => {
        console.error('[thumbnail_generator] unhandled error:', err);
    });
}
