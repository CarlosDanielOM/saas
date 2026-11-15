import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import path from 'path';
import { Types } from 'mongoose';
import { hasGlobalChannelOwnerAccess } from '../../middleware/admin.middleware.js';
import { AdminSchema } from '../../schemas/admin.schema.js';
import { UserMediaLibraryItemSchema } from '../../schemas/user_media_library_item.schema.js';
import type { MediaAssetMarketplaceStatus, MediaAssetScope, MediaAssetType } from '../../schemas/media_asset.schema.js';
import { getApiUrl } from '../../utils/dev.js';

export type PlanTier = 'free' | 'premium' | 'pro';

// Display names start with a letter, may contain letters/digits/underscores,
// and must end with a letter or digit (no leading/trailing underscore, no
// leading digit). Multiple underscores between segments are allowed at the
// storage level but will be collapsed to a single space when rendered.
export const MEDIA_NAME_REGEX = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*$/;
export const DOMDIMABOT_SITE_OWNER_USER_ID = 'system:domdimabot';
export const DOMDIMABOT_SITE_OWNER_CHANNEL_ID = 'domdimabot';
export const DOMDIMABOT_SITE_OWNER_CHANNEL_NAME = 'DomDimaBot';

const PLAN_UPLOAD_LIMIT_MB: Record<PlanTier, number> = {
    free: 5,
    premium: 25,
    pro: 100
};

const PLAN_STORAGE_QUOTA_BYTES: Record<PlanTier, number> = {
    free: 0,                        // Public-only; public media is quota-free
    premium: 250 * 1024 * 1024,    // 250 MB
    pro: 1024 * 1024 * 1024        // 1 GB
};

const MIME_EXTENSION_FALLBACK: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'video/quicktime': 'mov'
};

export function normalizePlanTier(planTier: string | undefined): PlanTier {
    if (planTier === 'premium' || planTier === 'pro') {
        return planTier;
    }

    return 'free';
}

export function getPlanUploadLimitBytes(planTier: PlanTier): number {
    return PLAN_UPLOAD_LIMIT_MB[planTier] * 1024 * 1024;
}

export function getPlanStorageQuotaBytes(planTier: PlanTier): number {
    return PLAN_STORAGE_QUOTA_BYTES[planTier];
}

export function getMediaQuotaChargeBytes(scope: MediaAssetScope, bytes: number): number {
    return scope === 'private' ? Math.max(0, bytes) : 0;
}

export function isValidMediaDisplayName(name: string): boolean {
    return MEDIA_NAME_REGEX.test(name);
}

export function inferMediaTypeFromMimeType(mimeType: string): MediaAssetType | null {
    if (mimeType === 'image/gif') {
        return 'gif';
    }

    if (mimeType.startsWith('video/')) {
        return 'video';
    }

    if (mimeType.startsWith('audio/')) {
        return 'audio';
    }

    if (mimeType.startsWith('image/')) {
        return 'image';
    }

    return null;
}

export function getFileExtension(fileName: string, mimeType: string): string {
    const rawExtension = path.extname(fileName).replace(/^\./, '').toLowerCase();
    if (rawExtension) {
        return normalizeExtension(rawExtension);
    }

    return MIME_EXTENSION_FALLBACK[mimeType] || mimeType.split('/')[1]?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
}

function normalizeExtension(extension: string): string {
    if (extension === 'jpeg') return 'jpg';
    if (extension === 'svg+xml') return 'svg';
    if (extension === 'quicktime') return 'mov';
    return extension;
}

export function buildStoredMediaFileName(displayName: string, extension: string): string {
    const hashId = randomBytes(6).toString('hex');
    return `${hashId}-${displayName}-${Date.now()}.${extension}`;
}

export function buildMediaS3Key(scope: MediaAssetScope, mediaType: MediaAssetType, channelID: string, fileName: string): string {
    if (scope === 'public') {
        return `library/${mediaType}/${fileName}`;
    }

    return `${channelID}/triggers/${fileName}`;
}

/**
 * Link signature for `GET /media/:id`: HMAC-SHA256 over `media:<id>` with SECRET_KEY, base64url, 22 characters.
 * Returns null when this process has no SECRET_KEY (links are then unsigned).
 */
export function mediaLinkSignature(mediaID: string | Types.ObjectId): string | null {
    const secret = process.env.SECRET_KEY;
    if (!secret) {
        return null;
    }

    return createHmac('sha256', secret).update(`media:${String(mediaID)}`).digest('base64url').slice(0, 22);
}

/** Constant-time string comparison (different lengths are unequal without comparing content). */
export function safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

/** Whether `k` is this asset's link signature. False without SECRET_KEY or for a non-string `k`. */
export function isValidMediaLinkSignature(mediaID: string | Types.ObjectId, k: unknown): boolean {
    const expected = mediaLinkSignature(mediaID);
    return expected !== null && typeof k === 'string' && safeEqual(k, expected);
}

export function buildMediaPlaybackUrl(mediaID: string | Types.ObjectId): string {
    const url = `${getApiUrl()}/media/${String(mediaID)}`;
    const signature = mediaLinkSignature(mediaID);
    return signature ? `${url}?k=${signature}` : url;
}

export function getDefaultMediaScope(planTier: PlanTier, requestedScope: unknown): MediaAssetScope {
    if (planTier === 'free') {
        return 'public';
    }

    return requestedScope === 'public' ? 'public' : 'private';
}

export function getInitialMarketplaceStatus(scope: MediaAssetScope): MediaAssetMarketplaceStatus {
    return scope === 'public' ? 'published' : 'not_listed';
}

export function buildMediaAssetSearchPattern(input: string): string {
    const folded = input.trim().slice(0, 80).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const accentClasses: Record<string, string> = {
        a: '[aáàâäãå]', e: '[eéèêë]', i: '[iíìîï]',
        o: '[oóòôöõ]', u: '[uúùûü]', n: '[nñ]'
    };

    return folded.split(/[\s_]+/).filter(Boolean).map((word) =>
        [...word].map((char) => accentClasses[char.toLowerCase()] || char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
    ).join('[\\s_]+');
}

export async function getChannelQuotaUsageBytes(channelID: string): Promise<number> {
    const result = await UserMediaLibraryItemSchema.aggregate<{ total: number }>([
        {
            $match: {
                channelID,
                assetScope: 'private',
                isActive: true,
                deletedAt: null
            }
        },
        {
            $group: {
                _id: null,
                total: { $sum: '$quotaBytesCharged' }
            }
        }
    ]);

    return Number(result[0]?.total || 0);
}

export async function hasTriggerPermission(requesterID: string, channelID: string, requiredPermissions: string[]): Promise<boolean> {
    if (requesterID === channelID) {
        return true;
    }

    if (await hasGlobalChannelOwnerAccess(requesterID, channelID)) {
        return true;
    }

    const permissionsToCheck = ['*', 'triggers:all', ...requiredPermissions];
    const admin = await AdminSchema.findOne({
        channelID,
        adminID: requesterID,
        actived: true,
        permissions: { $in: permissionsToCheck }
    }).lean();

    return Boolean(admin);
}
