import express, { type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { MediaAssetSchema } from '../../schemas/media_asset.schema.js';
import { getS3PublicObjectUrl } from '../../utils/s3.js';
import { isValidMediaLinkSignature, mediaLinkSignature } from '../services/media_library.service.js';

const router = express.Router();

// Grace period: links stored or cached before signing existed still play. Set to true once the warning line
// (`media: unsigned private link`) has gone quiet, to refuse private assets requested without `k`.
const REFUSE_UNSIGNED_PRIVATE_MEDIA = false;
const UNSIGNED_WARNING_INTERVAL_MS = 10 * 60 * 1000;
const unsignedWarnings = new Map<string, number>();

function userAgentClass(userAgent: string | undefined): string {
    const ua = (userAgent || '').toLowerCase();
    if (!ua) return 'none';
    if (ua.includes('obs/') || ua.includes('obs-browser')) return 'obs';
    if (/bot|crawl|spider|curl|wget|python|node|axios|undici|go-http|java\//.test(ua)) return 'tool';
    if (/android|iphone|ipad|mobile/.test(ua)) return 'mobile';
    if (ua.includes('mozilla/')) return 'browser';
    return 'other';
}

function refererHost(referer: string | undefined): string {
    if (!referer) return '-';
    try {
        return new URL(referer).host.slice(0, 100) || '-';
    } catch {
        return 'invalid';
    }
}

/** At most one line per asset per 10 minutes per process; no IPs or full URLs. */
function warnUnsignedPrivateLink(assetID: string, req: Request): void {
    const now = Date.now();
    const last = unsignedWarnings.get(assetID);
    if (last !== undefined && now - last < UNSIGNED_WARNING_INTERVAL_MS) return;
    if (unsignedWarnings.size >= 5000) {
        for (const [id, at] of unsignedWarnings) {
            if (now - at >= UNSIGNED_WARNING_INTERVAL_MS) unsignedWarnings.delete(id);
        }
        // Still full of entries inside their 10 minutes: stay quiet for new assets instead of forgetting which ones
        // were already reported (clearing would let a scan log the same asset again and again).
        if (unsignedWarnings.size >= 5000) return;
    }
    unsignedWarnings.set(assetID, now);
    console.warn('media: unsigned private link', assetID, userAgentClass(req.get('user-agent')), refererHost(req.get('referer')));
}

router.get('/:mediaID', async (req: Request, res: Response) => {
    try {
        const { mediaID } = req.params;
        const mediaIdStr = Array.isArray(mediaID) ? mediaID[0] : mediaID;

        if (!mediaIdStr) {
            return res.status(400).json({
                error: true,
                message: 'mediaID is required',
                status: 400
            });
        }

        const notFound = () => res.status(404).json({
            error: true,
            message: 'Media not found',
            status: 404
        });

        if (!Types.ObjectId.isValid(mediaIdStr)) {
            return notFound();
        }

        const asset = await MediaAssetSchema.findOne({
            _id: mediaIdStr,
            deletedAt: null
        }).select('s3Key storageUrl scope').lean();

        if (!asset) {
            return notFound();
        }

        // Public and system assets are served with or without a signature.
        if (asset.scope !== 'public' && asset.scope !== 'system') {
            const assetID = String(asset._id);
            const k = req.query.k;
            // A process without SECRET_KEY cannot check signatures: every request counts as unsigned.
            const canVerify = mediaLinkSignature(assetID) !== null;
            if (k !== undefined && canVerify && !isValidMediaLinkSignature(assetID, k)) {
                return notFound();
            }
            if (k === undefined || !canVerify) {
                if (REFUSE_UNSIGNED_PRIVATE_MEDIA) {
                    return notFound();
                }
                warnUnsignedPrivateLink(assetID, req);
            }
        }

        const destinationUrl = asset.s3Key ? getS3PublicObjectUrl(asset.s3Key) : asset.storageUrl;
        if (!destinationUrl) {
            return res.status(404).json({
                error: true,
                message: 'Media URL not found',
                status: 404
            });
        }

        res.setHeader('Cache-Control', 'private, no-store');
        return res.redirect(307, destinationUrl);
    } catch (error) {
        console.error('Error in GET /media/:mediaID:', {
            mediaID: req.params.mediaID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({
            error: true,
            message: 'Internal server error',
            status: 500
        });
    }
});

export const mediaRoute = router;
