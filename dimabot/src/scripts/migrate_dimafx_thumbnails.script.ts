import path from 'path';
import dotenv from 'dotenv';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { MediaAssetSchema, type IMediaAsset } from '../schemas/media_asset.schema.js';
import { ChannelExtensionItemSchema } from '../schemas/channel_extension_item.schema.js';
import { generateAndStoreThumbnail } from '../utils/thumbnail_generator.js';

const isDev = process.env.NODE_ENV !== 'production';
if (isDev) {
    dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
}
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const BATCH_SIZE = 50;

interface BackfillReport {
    generatedAt: string;
    durationMs: number;
    totals: {
        assetsScanned: number;
        assetsNeedingThumbnail: number;
        audioSkipped: number;
        imagesAndGifs: number;
        videos: number;
        thumbnailsGenerated: number;
        thumbnailsAlreadyReady: number;
        thumbnailsFailed: number;
        itemsClearedExternalUrl: number;
        itemsAlreadyClean: number;
    };
    failures: Array<{ assetID: string; reason: string }>;
}

function getArgValue(flag: string): string | null {
    const index = process.argv.indexOf(flag);
    if (index === -1) return null;
    return process.argv[index + 1] || null;
}

function getReportPath(): string {
    const explicit = getArgValue('--report');
    if (explicit) return path.resolve(process.cwd(), explicit);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.resolve(process.cwd(), '.opencode', 'reports', `dimafx-thumbnail-backfill-${timestamp}.json`);
}

function shouldClearExternalThumbnail(url: string | null | undefined): boolean {
    if (!url) return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    // Trust only our own domain; clear anything else.
    return !trimmed.startsWith('https://api.domdimabot.com/');
}

async function backfillThumbnails(): Promise<void> {
    const startedAt = Date.now();
    const dryRun = process.argv.includes('--dry-run');
    await getMongoDBConnection('migrate_dimafx_thumbnails');

    const report: BackfillReport = {
        generatedAt: new Date().toISOString(),
        durationMs: 0,
        totals: {
            assetsScanned: 0,
            assetsNeedingThumbnail: 0,
            audioSkipped: 0,
            imagesAndGifs: 0,
            videos: 0,
            thumbnailsGenerated: 0,
            thumbnailsAlreadyReady: 0,
            thumbnailsFailed: 0,
            itemsClearedExternalUrl: 0,
            itemsAlreadyClean: 0
        },
        failures: []
    };

    // 1. Find every asset that needs a thumbnail.
    //    - audio: skipped (no UI thumbnail)
    //    - already ready: skip
    //    - everything else (image, gif, video): generate
    const allAssets = await MediaAssetSchema.find({ deletedAt: null })
        .select('_id mediaType thumbnailStatus thumbnailAssetID thumbnailLastError')
        .lean<IMediaAsset[]>()
        .exec();

    report.totals.assetsScanned = allAssets.length;
    for (const asset of allAssets) {
        if (asset.mediaType === 'audio') report.totals.audioSkipped++;
        else if (asset.mediaType === 'image' || asset.mediaType === 'gif') report.totals.imagesAndGifs++;
        else if (asset.mediaType === 'video') report.totals.videos++;
    }

    const needsThumb = allAssets.filter((a) => {
        if (a.mediaType === 'audio') return false;
        if (a.thumbnailStatus === 'ready' && a.thumbnailAssetID) return false;
        return true;
    });
    report.totals.assetsNeedingThumbnail = needsThumb.length;
    report.totals.thumbnailsAlreadyReady = allAssets.length - needsThumb.length - report.totals.audioSkipped;

    console.log(`[backfill] scanned=${report.totals.assetsScanned} ` +
        `audio=${report.totals.audioSkipped} imgGif=${report.totals.imagesAndGifs} ` +
        `video=${report.totals.videos} needsThumb=${needsThumb.length} ` +
        `alreadyReady=${report.totals.thumbnailsAlreadyReady}`);

    if (dryRun) {
        console.log('[backfill] dry-run complete. Re-run without --dry-run to apply.');
    } else {
        // 2. Process in batches; the generator itself is p-limit(2) on ffmpeg.
        for (let i = 0; i < needsThumb.length; i += BATCH_SIZE) {
            const batch = needsThumb.slice(i, i + BATCH_SIZE);
            await Promise.allSettled(batch.map((asset) => generateAndStoreThumbnail(asset._id).then(() => {
                report.totals.thumbnailsGenerated++;
            }).catch((err) => {
                report.totals.thumbnailsFailed++;
                report.failures.push({
                    assetID: String(asset._id),
                    reason: err instanceof Error ? err.message : String(err)
                });
            })));
            if ((i + BATCH_SIZE) % (BATCH_SIZE * 4) === 0) {
                console.log(`[backfill] progress: ${Math.min(i + BATCH_SIZE, needsThumb.length)}/${needsThumb.length}`);
            }
        }
    }

    // 3. Clean up ChannelExtensionItem rows whose stored thumbnailUrl is
    //    a non-allowed external URL. The mapper already prefers the auto-generated
    //    thumbnail, but clearing the legacy field avoids confusion in the dashboard
    //    and prevents the field from being re-saved by older code paths.
    const itemsWithExternalUrl = await ChannelExtensionItemSchema.find({
        deletedAt: null,
        thumbnailUrl: { $exists: true, $nin: [null, ''] }
    })
        .select('_id thumbnailUrl')
        .lean()
        .exec();

    const toClear: string[] = [];
    for (const item of itemsWithExternalUrl) {
        if (shouldClearExternalThumbnail(item.thumbnailUrl)) {
            toClear.push(String(item._id));
        } else {
            report.totals.itemsAlreadyClean++;
        }
    }

    console.log(`[backfill] channel extension items: scanned=${itemsWithExternalUrl.length} ` +
        `external=${toClear.length} clean=${report.totals.itemsAlreadyClean}`);

    if (!dryRun && toClear.length > 0) {
        const result = await ChannelExtensionItemSchema.updateMany(
            { _id: { $in: toClear } },
            { $set: { thumbnailUrl: '' } }
        );
        report.totals.itemsClearedExternalUrl = result.modifiedCount;
        console.log(`[backfill] cleared external thumbnailUrl from ${result.modifiedCount} items`);
    }

    report.durationMs = Date.now() - startedAt;
    const reportPath = getReportPath();
    await import('fs/promises').then((fs) => fs.writeFile(reportPath, JSON.stringify(report, null, 2)));
    console.log(`[backfill] report written to ${reportPath}`);
    console.log(`[backfill] done in ${report.durationMs}ms`);
}

backfillThumbnails()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('[backfill] failed', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
        process.exit(1);
    });
