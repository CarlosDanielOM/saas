import express, { type NextFunction, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { ChannelExtensionItemSchema, type ChannelExtensionItemCategory, type IChannelExtensionItem } from '../../schemas/channel_extension_item.schema.js';
import { ExtensionWalletTransactionSchema, DimafxTransactionClaimSchema } from '../../schemas/extension_wallet_transaction.schema.js';
import { MediaAssetSchema, type IMediaAsset, type MediaAssetType } from '../../schemas/media_asset.schema.js';
import {
    DEFAULT_EXTENSION_INVENTORY_CONFIG,
    UserExtensionInventorySchema,
    type IUserExtensionInventory
} from '../../schemas/user_extension_inventory.schema.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { buildMediaPlaybackUrl } from '../services/media_library.service.js';
import { scheduleThumbnailGeneration } from '../../utils/thumbnail_generator.js';
import {
    getAllowedDimafxBitPrices,
    getDimafxSkuForBitsPrice,
    dimafxSkuForItem,
    dimafxItemUsesViewerInput,
    hasDimafxPermission,
    normalizeDimafxPurchaseAction,
    normalizeDimafxTtsConfig,
    normalizeDimafxViewerConfig,
    sanitizeDimafxViewerTtsText,
    selectRedeemCandidate,
    type DimafxPurchaseAction
} from '../services/dimafx.service.js';
import { dimafxQueueHandler, type DimafxQueueSource, type DimafxWidgetFacts } from '../../handlers/dimafx_queue.handler.js';
import { makeGoodDimafx, saveDimafxPurchaseOnce, admitFreeDimafx, saveFreeDimafx } from '../services/dimafx-fulfillment.service.js';
import { moderateDimafxViewerText, admitDimafxTtsCheck, type DimafxTextDecision } from '../../utils/moderation/dimafx_tts.js';
import { refundDeletedDimafxItem } from '../services/dimafx-deletion.service.js';
import { createDimafxSpend, recoverDimafxSpend } from '../services/dimafx-spend.service.js';
import { dimafxOverlayUrl } from '../services/dimafx-overlay.service.js';
import type { IExtensionWalletTransaction } from '../../schemas/extension_wallet_transaction.schema.js';

interface DimafxRequest extends Request {
    user?: {
        id?: string;
        login?: string;
        display_name?: string;
        profile_image_url?: string;
    };
}

interface ChannelExtensionItemPayload {
    assetID?: string;
    channelName?: string;
    name?: string;
    description?: string;
    category?: ChannelExtensionItemCategory;
    thumbnailUrl?: string;
    durationMs?: number;
    bitsPrice?: number;
    volume?: number;
    isEnabled?: boolean;
    sortOrder?: number;
    tts?: unknown;
}

interface ExtensionIdentityBody {
    userID?: string;
    opaqueUserID?: string;
    displayName?: string;
    transactionID?: string;
    sku?: string;
    action?: DimafxPurchaseAction;
    ttsText?: string;
    identityShared?: boolean;
    bitsTransaction?: { transactionID: string; userID: string; sku: string; amount: number; time: string; inDevelopment: boolean };
}

const router = express.Router();

function getParamValue(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] : value || '';
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
        return fallback;
    }

    return Math.max(0, Math.floor(numberValue));
}

function normalizeVolume(value: unknown): number {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
        return 100;
    }

    return Math.min(100, Math.max(0, Math.floor(numberValue)));
}

function getFallbackThumbnail(asset: IMediaAsset | null): string {
    if (!asset) return '';
    if (asset.thumbnailAssetID) {
        return buildMediaPlaybackUrl(asset.thumbnailAssetID);
    }
    if (asset.mediaType === 'image' || asset.mediaType === 'gif') {
        // The asset itself is an image — its own playback URL works as a thumbnail.
        return buildMediaPlaybackUrl(asset._id);
    }
    return '';
}

/**
 * If a media asset is missing its generated thumbnail and is not audio,
 * schedule background generation. This is the safety net for assets that
 * were uploaded before this feature shipped or whose initial generation
 * failed silently.
 */
function ensureThumbnailInFlight(asset: IMediaAsset | null): void {
    if (!asset) return;
    if (asset.thumbnailAssetID) return;
    if (asset.thumbnailStatus === 'skipped') return;
    if (asset.mediaType === 'audio') return;
    scheduleThumbnailGeneration(asset._id);
}

const ALLOWED_DIMAFX_CATEGORIES: ChannelExtensionItemCategory[] = ['video', 'audio', 'gif', 'tts'];

function isChannelExtensionItemCategory(value: unknown): value is ChannelExtensionItemCategory {
    return typeof value === 'string' && (ALLOWED_DIMAFX_CATEGORIES as string[]).includes(value);
}

function defaultCategoryFromMediaType(mediaType: string | undefined): ChannelExtensionItemCategory {
    if (mediaType === 'audio') return 'audio';
    if (mediaType === 'image' || mediaType === 'gif') return 'gif';
    return 'video';
}

function normalizeCategoryInput(value: unknown, fallback: ChannelExtensionItemCategory): ChannelExtensionItemCategory {
    return isChannelExtensionItemCategory(value) ? value : fallback;
}

function mapChannelExtensionItem(item: IChannelExtensionItem, asset: IMediaAsset | null): Record<string, unknown> {
    // thumbnailUrl resolution order:
    //   1. auto-generated thumbnail (always serves from api.domdimabot.com)
    //   2. asset's own playback URL (works for image/gif assets)
    //   3. the legacy stored thumbnailUrl (kept for back-compat, may be a stale external URL)
    // The mapper ALWAYS prefers the auto-generated thumbnail so the extension never
    // receives a broadcaster-controlled URL. The stale item.thumbnailUrl is only
    // consulted as a last-resort fallback for very old rows where the asset has
    // no thumbnailAssetID and is not an image/gif.
    const resolvedThumbnail = (() => {
        if (asset?.thumbnailAssetID) return buildMediaPlaybackUrl(asset.thumbnailAssetID);
        if (asset && (asset.mediaType === 'image' || asset.mediaType === 'gif')) {
            return buildMediaPlaybackUrl(asset._id);
        }
        if (typeof item.thumbnailUrl === 'string' && item.thumbnailUrl.trim().startsWith('https://api.domdimabot.com/')) {
            return item.thumbnailUrl.trim();
        }
        return '';
    })();

    return {
        _id: item._id,
        id: String(item._id),
        channelID: item.channelID,
        channelName: item.channelName,
        assetID: item.assetID,
        name: item.name,
        description: item.description,
        category: item.category,
        mediaType: item.mediaType,
        thumbnailUrl: resolvedThumbnail,
        durationMs: item.durationMs,
        bitsPrice: item.bitsPrice,
        sku: dimafxSkuForItem(item),
        volume: item.volume,
        isEnabled: item.isEnabled,
        sortOrder: item.sortOrder,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        asset: asset ? {
            _id: asset._id,
            displayName: asset.displayName,
            mediaType: asset.mediaType,
            mimeType: asset.mimeType,
            storageUrl: asset.storageUrl,
            playbackUrl: buildMediaPlaybackUrl(asset._id),
            scope: asset.scope,
            marketplaceStatus: asset.marketplaceStatus
        } : null,
        mediaUrl: asset ? buildMediaPlaybackUrl(asset._id) : null,
        tts: item.tts
            ? {
                mode: item.tts.mode,
                text: item.tts.text,
                voice: item.tts.voice,
                language: item.tts.language
            }
            : null
    };
}

function mapInventory(inventory: IUserExtensionInventory): Record<string, unknown> {
    return {
        _id: inventory._id,
        platform: inventory.platform,
        userID: inventory.userID,
        channelID: inventory.channelID,
        displayName: inventory.displayName || null,
        balance: inventory.balance,
        config: {
            quickPurchasePriority: inventory.config?.quickPurchasePriority || DEFAULT_EXTENSION_INVENTORY_CONFIG.quickPurchasePriority,
            quickPurchaseAction: inventory.config?.quickPurchaseAction || DEFAULT_EXTENSION_INVENTORY_CONFIG.quickPurchaseAction
        },
        items: inventory.items.map((item) => ({
            channelExtensionItemID: item.channelExtensionItemID,
            quantity: item.quantity,
            purchasePriceBits: item.purchasePriceBits,
            acquiredAt: item.acquiredAt,
            source: item.source
        })),
        createdAt: inventory.createdAt,
        updatedAt: inventory.updatedAt
    };
}

async function getAssetMap(assetIDs: (string | Types.ObjectId | null | undefined)[]): Promise<Map<string, IMediaAsset>> {
    const uniqueIDs = Array.from(new Set(assetIDs.filter((id): id is string | Types.ObjectId => Boolean(id)).map(String)));
    if (uniqueIDs.length === 0) return new Map();

    const assets = await MediaAssetSchema.find({ _id: { $in: uniqueIDs }, deletedAt: null }).lean();
    const map = new Map(assets.map((asset) => [String(asset._id), asset]));

    // Lazy fallback: any non-audio asset without a thumbnail gets a background job.
    for (const asset of assets) {
        ensureThumbnailInFlight(asset);
    }

    return map;
}

async function ensureDimafxPermission(req: DimafxRequest, res: Response, channelID: string, permissions: string[]): Promise<boolean> {
    const requesterID = req.user?.id;
    if (!requesterID) {
        res.status(401).json({ error: true, message: 'Unauthorized', status: 401 });
        return false;
    }

    const allowed = await hasDimafxPermission(requesterID, channelID, permissions);
    if (!allowed) {
        res.status(403).json({ error: true, message: 'You do not have permission to manage DimaFX for this channel', status: 403 });
        return false;
    }

    return true;
}

function internalServiceAuth(req: Request, res: Response, next: NextFunction): void {
    const configuredToken = process.env.DIMAFX_SERVICE_TOKEN;
    if (!configuredToken) {
        res.status(503).json({ error: true, message: 'DimaFX service auth is not configured', status: 503 });
        return;
    }

    const headerToken = req.header('x-dimafx-service-token');
    const authHeader = req.header('authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const providedToken = headerToken || bearerToken;

    if (!providedToken || Buffer.byteLength(providedToken) !== Buffer.byteLength(configuredToken) || !timingSafeEqual(Buffer.from(providedToken), Buffer.from(configuredToken))) {
        res.status(401).json({ error: true, message: 'Invalid DimaFX service token', status: 401 });
        return;
    }

    next();
}

async function getActiveChannelItem(channelID: string, itemID: string): Promise<{ item: IChannelExtensionItem; asset: IMediaAsset | null } | null> {
    if (!Types.ObjectId.isValid(itemID)) return null;

    const item = await ChannelExtensionItemSchema.findOne({
        _id: itemID,
        channelID,
        isEnabled: true,
        deletedAt: null
    }).lean();

    if (!item) return null;

    // TTS items synthesize audio at playback time; they have no stored asset.
    if (item.category === 'tts') {
        return { item, asset: null };
    }

    if (!item.assetID) return null;
    const asset = await MediaAssetSchema.findOne({ _id: item.assetID, deletedAt: null }).lean();
    if (!asset) return null;

    return { item, asset };
}

async function getOrCreateInventory(channelID: string, userID: string, displayName?: string): Promise<IUserExtensionInventory> {
    const inventory = await UserExtensionInventorySchema.findOneAndUpdate(
        { platform: 'twitch', userID, channelID },
        {
            $setOnInsert: {
                platform: 'twitch',
                userID,
                channelID,
                balance: 0,
                config: DEFAULT_EXTENSION_INVENTORY_CONFIG,
                items: []
            },
            ...(displayName ? { $set: { displayName } } : {})
        },
        { new: true, upsert: true }
    ).lean();

    return inventory as IUserExtensionInventory;
}

function inventoryIdentityFilter(channelID: string, userID: string): { platform: 'twitch'; userID: string; channelID: string } {
    return { platform: 'twitch', userID, channelID };
}

class DimafxQueueError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly noClients: boolean
    ) {
        super(message);
        this.name = noClients ? 'NO_TRIGGER_CLIENTS' : 'DIMAFX_QUEUE_ERROR';
    }
}

/**
 * Enqueues durable playback exclusively for the dedicated DimaFX namespace.
 * A purchase's stable trigger ID also identifies retries after API restarts.
 */
async function queueChannelExtensionItem(
    channelID: string,
    item: IChannelExtensionItem,
    asset: IMediaAsset | null,
    options: { triggerID?: string; viewerText?: string; refundOnFailure?: { userID: string; priceBits: number }; source: DimafxQueueSource; widget?: DimafxWidgetFacts; viewerUserID?: string; moderation?: DimafxTextDecision }
): Promise<Record<string, unknown>> {
    const result = await dimafxQueueHandler.enqueue({
        channelID,
        triggerID: options.triggerID,
        item,
        asset,
        viewerText: options.viewerText,
        refundOnFailure: options.refundOnFailure,
        source: options.source,
        widget: options.widget, viewerUserID: options.viewerUserID, moderation: options.moderation
    });

    if (!result.ok) {
        throw new DimafxQueueError(result.message, result.status, result.status === 409);
    }

    return {
        queued: true,
        queueLength: result.queueLength,
        triggerID: result.triggerID,
        activeConnections: result.activeConnections,
        namespace: `/overlays/dimafx/${channelID}`
    };
}

function isDuplicateKeyError(error: unknown): boolean {
    return Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 11000;
}

type PurchaseFulfillment = 'pending' | 'processing' | 'fulfilled' | 'refund_pending' | 'refunded';
type PurchaseResult = { status: number; body: Record<string, unknown> };

async function markPurchaseFulfillment(ledgerID: Types.ObjectId, fulfillment: PurchaseFulfillment): Promise<void> {
    await ExtensionWalletTransactionSchema.updateOne(
        { _id: ledgerID },
        { $set: { 'metadata.fulfillment': fulfillment } }
    );
}

interface BitsPurchaseContext {
    ledgerID: Types.ObjectId;
    priceBits: number;
    channelID: string;
    itemData: { item: IChannelExtensionItem; asset: IMediaAsset | null };
    userID?: string;
    opaqueUserID?: string;
    displayName?: string;
    action: DimafxPurchaseAction;
    viewerText?: string;
    identityShared?: boolean;
    moderation?: DimafxTextDecision;
}

/** A terminal decision is persisted before applying an idempotent refund. */
async function refundBitsPurchase(ledger: Pick<IExtensionWalletTransaction, '_id' | 'userID' | 'channelID' | 'amountBits'> & { metadata?: Record<string, unknown>; channelExtensionItemID?: Types.ObjectId | null }): Promise<PurchaseResult> {
    await markPurchaseFulfillment(ledger._id, 'refund_pending');
    if (!ledger.userID) throw new Error('Paid DimaFX purchase has no receipt user ID; manual reconciliation required');
    await getOrCreateInventory(ledger.channelID, ledger.userID);
    const madeGood = await makeGoodDimafx(ledger.channelID, ledger.userID, ledger.amountBits, `refund:bits-${ledger._id}`, ledger.channelExtensionItemID ? String(ledger.channelExtensionItemID) : undefined);
    await markPurchaseFulfillment(ledger._id, 'refunded');
    const inventory = await getOrCreateInventory(ledger.channelID, ledger.userID);
    return { status: 200, body: { error: false, status: 200, message: 'DimaFX purchase converted to credits', data: { madeGood, inventory: mapInventory(inventory), ...(ledger.metadata?.blocked ? { blocked: true } : {}) } } };
}

async function fulfillBitsPurchase(ctx: BitsPurchaseContext): Promise<PurchaseResult> {
    const { item, asset } = ctx.itemData;
    if (ctx.userID) await getOrCreateInventory(ctx.channelID, ctx.userID, ctx.displayName);
    let data: Record<string, unknown>;
    try {
        if (ctx.action === 'save') {
            const alreadySaved = await UserExtensionInventorySchema.exists({
                ...inventoryIdentityFilter(ctx.channelID, ctx.userID!), dimafxReceipts: `save:${ctx.ledgerID}`,
            });
            if (!alreadySaved && !await dimafxQueueHandler.isOverlayConnected(ctx.channelID)) {
                throw new DimafxQueueError('DimaFX overlay is disconnected', 409, true);
            }
            const inventory = await saveDimafxPurchaseOnce(ctx.channelID, ctx.userID!, String(item._id), ctx.priceBits, String(ctx.ledgerID));
            data = { inventory: mapInventory(inventory) };
        } else {
            data = await queueChannelExtensionItem(ctx.channelID, item, asset, {
                triggerID: `bits-${ctx.ledgerID}`,
                viewerText: ctx.viewerText,
                source: 'bits_purchase',
                viewerUserID: ctx.identityShared ? ctx.userID : undefined, moderation: ctx.moderation,
                refundOnFailure: ctx.userID ? { userID: ctx.userID, priceBits: ctx.priceBits } : undefined,
                // Price from the Bits ledger; the buyer only when Twitch shared their identity (verified by the extension server).
                widget: { bits: ctx.priceBits, credits: null, buyerId: ctx.identityShared ? ctx.userID ?? null : null, message: ctx.viewerText ?? null },
            });
        }
    } catch (error) {
        // A database/network error is ambiguous: retain processing for recovery.
        // Only a definite rejection may convert this purchase into credits.
        if (!(error instanceof DimafxQueueError)) throw error;
        return refundBitsPurchase({ _id: ctx.ledgerID, channelID: ctx.channelID, userID: ctx.userID, amountBits: ctx.priceBits, channelExtensionItemID: item._id });
    }
    // If this write fails, retry uses the same job ID/atomic save receipt.
    await markPurchaseFulfillment(ctx.ledgerID, 'fulfilled');
    return { status: 200, body: { error: false, status: 200, message: ctx.action === 'save' ? 'Item saved to inventory' : 'DimaFX item queued for stream playback', data } };
}

async function recoverBitsPurchase(existing: IExtensionWalletTransaction): Promise<PurchaseResult> {
    const channelID = existing.channelID;
    const fulfillment = (existing.metadata?.fulfillment as PurchaseFulfillment | undefined) || 'fulfilled';
    if (fulfillment === 'refunded') return refundBitsPurchase(existing);
    if (fulfillment === 'fulfilled') {
        const playback = await dimafxQueueHandler.outcome(channelID, `bits-${existing._id}`);
        if (playback?.state === 'refunded') return refundBitsPurchase(existing);
        const inventory = existing.userID ? await UserExtensionInventorySchema.findOne(inventoryIdentityFilter(channelID, existing.userID)).lean() : null;
        return { status: 200, body: { error: false, status: 200, message: 'DimaFX purchase already processed', data: { duplicate: true, inventory: inventory ? mapInventory(inventory) : null } } };
    }
    if (fulfillment === 'refund_pending') return refundBitsPurchase(existing);
    // Resolve durable side effects before checking current item/overlay state.
    // Deleting an item or disconnecting OBS must not undo a fulfilled purchase.
    const action = normalizeDimafxPurchaseAction(existing.metadata?.action);
    const queued = action === 'use_now' ? await dimafxQueueHandler.existing(channelID, `bits-${existing._id}`) : null;
    const saved = action === 'save' && existing.userID
        ? await UserExtensionInventorySchema.findOne({ ...inventoryIdentityFilter(channelID, existing.userID), dimafxReceipts: `save:${existing._id}` }).lean()
        : null;
    const itemData = queued || saved ? null : await getActiveChannelItem(channelID, String(existing.channelExtensionItemID || ''));

    const claimed = await ExtensionWalletTransactionSchema.updateOne(
        { _id: existing._id, $or: [
            { 'metadata.fulfillment': 'pending' },
            { 'metadata.fulfillment': 'processing', updatedAt: { $lt: new Date(Date.now() - 30_000) } },
        ] }, { $set: { 'metadata.fulfillment': 'processing' } },
    );
    if (!claimed.modifiedCount) return { status: 503, body: { error: true, status: 503, message: 'DimaFX purchase is being recovered; retry this receipt' } };
    if (queued || saved) {
        await markPurchaseFulfillment(existing._id, 'fulfilled');
        return { status: 200, body: { error: false, status: 200, message: 'DimaFX purchase recovered', data: { duplicate: true, ...(queued?.ok ? { queued: true, triggerID: queued.triggerID, queueLength: queued.queueLength } : {}), ...(saved ? { inventory: mapInventory(saved) } : {}) } } };
    }
    const invalid = !itemData || existing.metadata?.unavailable || (action === 'save' && !existing.metadata?.identityShared) ||
        // Twitch test (in-development) products may report a 0 Bits cost; their SKU still names the tier.
        dimafxSkuForItem(itemData.item) !== existing.sku || (itemData.item.bitsPrice !== existing.amountBits && !(existing.metadata?.inDevelopment === true && existing.amountBits === 0)) ||
        (dimafxItemUsesViewerInput(itemData.item) && (!existing.metadata?.identityShared || action === 'save' || !existing.metadata?.viewerText));
    if (invalid || !itemData) return refundBitsPurchase(existing);
    let moderation: DimafxTextDecision | undefined;
    if (dimafxItemUsesViewerInput(itemData.item)) {
        moderation = existing.metadata?.moderation as DimafxTextDecision | undefined;
        if (!moderation) moderation = await moderateDimafxViewerText({ channelID, userID: existing.userID!, text: String(existing.metadata.viewerText) });
        await ExtensionWalletTransactionSchema.updateOne({ _id: existing._id }, { $set: { 'metadata.moderation': moderation, 'metadata.blocked': !moderation.allowed } });
        if (!moderation.allowed) return refundBitsPurchase({ ...existing, metadata: { ...existing.metadata, blocked: true } });
    }
    return fulfillBitsPurchase({
        ledgerID: existing._id, priceBits: existing.amountBits, channelID, itemData,
        userID: existing.userID || undefined, opaqueUserID: existing.opaqueUserID || undefined,
        action, moderation, identityShared: existing.metadata?.identityShared === true, viewerText: typeof existing.metadata?.viewerText === 'string' ? existing.metadata.viewerText : undefined,
    });
}

/** Recover interrupted HTTP fulfillment even if the viewer has closed Twitch. */
export async function recoverDimafxPurchases(channelID: string): Promise<void> {
    const claims = await DimafxTransactionClaimSchema.find({ channelID, materialized: false }).limit(25).lean();
    for (const claim of claims) await materializeBitsClaim(claim);
    const pending = await ExtensionWalletTransactionSchema.find({
        channelID, type: 'bits_purchase',
        'metadata.fulfillment': { $in: ['pending', 'processing', 'refund_pending'] },
        updatedAt: { $lt: new Date(Date.now() - 30_000) },
    }).sort({ createdAt: 1 }).limit(25).lean();
    for (const ledger of pending) {
        try { await recoverBitsPurchase(ledger); } catch (error) { console.error('DimaFX purchase recovery remains pending', { ledgerID: String(ledger._id), error }); }
    }
    const spends = await ExtensionWalletTransactionSchema.find({ channelID, type: { $in: ['credit_purchase', 'redeem_saved'] },
        'metadata.fulfillment': { $in: ['pending', 'processing', 'refund_pending'] }, updatedAt: { $lt: new Date(Date.now() - 30_000) },
    }).sort({ createdAt: 1 }).limit(25).lean();
    for (const ledger of spends) {
        try { await recoverDimafxSpend(ledger); } catch (error) { console.error('DimaFX spend recovery remains pending', { ledgerID: String(ledger._id), error }); }
    }
    const deletions = await ChannelExtensionItemSchema.find({ channelID, refundSavedPending: true }).limit(25).lean();
    for (const item of deletions) await refundDeletedDimafxItem(channelID, String(item._id));
}


router.get('/internal/channels/:channelID/overlay-status', internalServiceAuth, async (req: Request, res: Response) => {
    try {
        const connected = await dimafxQueueHandler.isOverlayConnected(getParamValue(req.params.channelID));
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ error: false, status: 200, data: { connected } });
    } catch {
        return res.status(503).json({ error: true, status: 503, message: 'DimaFX connection status unavailable' });
    }
});

router.get('/internal/channels/:channelID/items', internalServiceAuth, async (req: Request, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const items = await ChannelExtensionItemSchema.find({ channelID, isEnabled: true, deletedAt: null }).sort({ sortOrder: 1, createdAt: -1 }).lean();
        const assetMap = await getAssetMap(items.map((item) => item.assetID));

        return res.status(200).json({
            error: false,
            message: 'DimaFX items fetched successfully',
            status: 200,
            data: items.map((item) => mapChannelExtensionItem(item, assetMap.get(String(item.assetID)) || null))
        });
    } catch (error) {
        console.error('Error in GET /extensions/dimafx/internal/channels/:channelID/items:', {
            channelID: req.params.channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });

        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.post('/internal/channels/:channelID/viewers/:userID/init', internalServiceAuth, async (req: Request, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const userID = getParamValue(req.params.userID);
        const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName : undefined;

        if (!userID) {
            return res.status(400).json({ error: true, message: 'Missing user ID', status: 400 });
        }

        const inventory = await getOrCreateInventory(channelID, userID, displayName);
        return res.status(200).json({ error: false, message: 'Inventory initialized', status: 200, data: mapInventory(inventory) });
    } catch (error) {
        console.error('Error initializing DimaFX inventory:', {
            channelID: req.params.channelID,
            userID: req.params.userID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.get('/internal/channels/:channelID/viewers/:userID/inventory', internalServiceAuth, async (req: Request, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const userID = getParamValue(req.params.userID);
        const inventory = await UserExtensionInventorySchema.findOne({ platform: 'twitch', userID, channelID }).lean();

        return res.status(200).json({
            error: false,
            message: 'Inventory fetched successfully',
            status: 200,
            data: inventory ? mapInventory(inventory) : null
        });
    } catch (error) {
        console.error('Error fetching DimaFX inventory:', {
            channelID: req.params.channelID,
            userID: req.params.userID,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.patch('/internal/channels/:channelID/viewers/:userID/config', internalServiceAuth, async (req: Request, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const userID = getParamValue(req.params.userID);
        const inventory = await getOrCreateInventory(channelID, userID);
        const nextConfig = normalizeDimafxViewerConfig(req.body || {}, {
            quickPurchasePriority: inventory.config?.quickPurchasePriority || DEFAULT_EXTENSION_INVENTORY_CONFIG.quickPurchasePriority,
            quickPurchaseAction: inventory.config?.quickPurchaseAction || DEFAULT_EXTENSION_INVENTORY_CONFIG.quickPurchaseAction
        });
        const updated = await UserExtensionInventorySchema.findOneAndUpdate(
            { platform: 'twitch', userID, channelID },
            { $set: { config: nextConfig } },
            { new: true }
        ).lean();

        return res.status(200).json({ error: false, message: 'Config updated', status: 200, data: updated ? mapInventory(updated) : null });
    } catch (error) {
        console.error('Error updating DimaFX config:', {
            channelID: req.params.channelID,
            userID: req.params.userID,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

/** Materialize the immutable claim snapshot before any effect; safe after a crash between writes. */
async function materializeBitsClaim(claim: { _id: string; ledger: IExtensionWalletTransaction }): Promise<IExtensionWalletTransaction> {
    const ledger = await ExtensionWalletTransactionSchema.findOneAndUpdate(
        { _id: claim.ledger._id }, { $setOnInsert: claim.ledger }, { upsert: true, new: true }
    ).lean();
    await DimafxTransactionClaimSchema.updateOne({ _id: claim._id }, { $set: { materialized: true } });
    return ledger!;
}

router.post('/internal/channels/:channelID/items/:itemID/tts-check', internalServiceAuth, async (req: Request, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const userID = typeof req.body?.userID === 'string' ? req.body.userID : '';
        if (!userID) return res.status(403).json({ error: true, status: 403, message: 'Shared Twitch identity required' });
        if (!await admitDimafxTtsCheck(channelID, userID)) return res.status(429).json({ error: true, status: 429, message: 'At most ten TTS checks per minute' });
        const item = await getActiveChannelItem(channelID, getParamValue(req.params.itemID));
        const text = sanitizeDimafxViewerTtsText(req.body?.ttsText);
        if (!item || !dimafxItemUsesViewerInput(item.item) || !text) return res.status(200).json({ error: false, status: 200, data: { allowed: false, reason: 'invalid' } });
        const decision = await moderateDimafxViewerText({ channelID, userID, text });
        return res.status(200).json({ error: false, status: 200, data: { allowed: decision.allowed, ...(!decision.allowed ? { reason: decision.verdict } : {}) } });
    } catch { return res.status(200).json({ error: false, status: 200, data: { allowed: false, reason: 'unavailable' } }); }
});

router.post('/internal/channels/:channelID/items/:itemID/purchase', internalServiceAuth, async (req: Request, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const itemID = getParamValue(req.params.itemID);
        const body = (req.body || {}) as ExtensionIdentityBody;
        const action = normalizeDimafxPurchaseAction(body.action);
        const bits = body.bitsTransaction;
        if (bits) {
            // Only EBS service auth may assert this object. Client transaction fields never enter the ledger.
            if (typeof bits.transactionID !== 'string' || !bits.transactionID || typeof bits.userID !== 'string' || !bits.userID ||
                typeof bits.sku !== 'string' || !bits.sku || !Number.isSafeInteger(bits.amount) || bits.amount < 0 || (bits.amount === 0 && bits.inDevelopment !== true)) {
                return res.status(400).json({ error: true, status: 400, message: 'Malformed verified Bits transaction' });
            }
            const legacy = await ExtensionWalletTransactionSchema.findOne({ twitchTransactionID: bits.transactionID }).lean();
            if (legacy) {
                if (legacy.channelID !== channelID || legacy.userID !== bits.userID) {
                    const terminal = !legacy.metadata?.fulfillment || ['fulfilled', 'refunded'].includes(String(legacy.metadata.fulfillment));
                    const status = terminal ? 409 : 503;
                    return res.status(status).json({ error: true, status, message: terminal ? 'Transaction already recorded for another purchase' : 'Conflicting legacy purchase requires reconciliation; retain this receipt' });
                }
                const result = await recoverBitsPurchase(legacy);
                return res.status(result.status).json(result.body);
            }
            const viewerText = sanitizeDimafxViewerTtsText(body.ttsText);
            const snapshot = {
                _id: new Types.ObjectId(), platform: 'twitch', userID: bits.userID, opaqueUserID: body.opaqueUserID || null, channelID,
                type: 'bits_purchase', amountBits: bits.amount, balanceDelta: 0,
                channelExtensionItemID: Types.ObjectId.isValid(itemID) ? new Types.ObjectId(itemID) : null,
                twitchTransactionID: bits.transactionID, sku: bits.sku,
                metadata: { action, fulfillment: 'pending', viewerText, identityShared: body.identityShared === true,
                    receiptTime: bits.time, inDevelopment: bits.inDevelopment, unavailable: !Types.ObjectId.isValid(itemID) },
            };
            let claim;
            try {
                claim = await DimafxTransactionClaimSchema.findOneAndUpdate({ _id: bits.transactionID },
                    { $setOnInsert: { channelID, userID: bits.userID, ledger: snapshot, materialized: false, createdAt: new Date() } }, { upsert: true, new: true }).lean();
            } catch (error) {
                if (!isDuplicateKeyError(error)) throw error;
                claim = await DimafxTransactionClaimSchema.findById(bits.transactionID).lean();
            }
            if (!claim) throw new Error('DimaFX transaction claim unavailable');
            if (claim.channelID !== channelID || claim.userID !== bits.userID) return res.status(503).json({ error: true, status: 503, message: 'Transaction claimed by another purchase; retain this receipt until its outcome is recorded' });
            const ledger = await materializeBitsClaim(claim);
            const result = await recoverBitsPurchase(ledger);
            return res.status(result.status).json(result.body);
        }

        const itemData = await getActiveChannelItem(channelID, itemID);
        if (!itemData) return res.status(404).json({ error: true, status: 404, message: 'DimaFX item not found' });
        if (itemData.item.bitsPrice !== 0) return res.status(400).json({ error: true, status: 400, message: 'A verified Twitch Bits receipt is required' });
        if (body.sku !== dimafxSkuForItem(itemData.item)) return res.status(400).json({ error: true, status: 400, message: 'SKU does not match this free item' });
        if (!body.opaqueUserID?.startsWith('U')) return res.status(403).json({ error: true, status: 403, message: 'Log in to Twitch to use free items' });
        const custom = dimafxItemUsesViewerInput(itemData.item);
        const viewerText = custom ? sanitizeDimafxViewerTtsText(body.ttsText) : undefined;
        if ((action === 'save' || custom) && !body.userID) return res.status(403).json({ error: true, status: 403, message: 'Share your identity to save or use custom content' });
        if (custom && (action === 'save' || !viewerText)) return res.status(400).json({ error: true, status: 400, message: 'Custom TTS requires text and immediate playback' });
        // Pace before moderation so a refused free message still counts and can't drive unlimited model calls.
        if (!await admitFreeDimafx(channelID, body.userID || body.opaqueUserID)) return res.status(429).json({ error: true, status: 429, message: 'Wait ten seconds between free DimaFX items' });
        if (custom && !await admitDimafxTtsCheck(channelID, body.userID!)) return res.status(429).json({ error: true, status: 429, message: 'At most ten TTS checks per minute' });
        const moderation = custom ? await moderateDimafxViewerText({ channelID, userID: body.userID!, text: viewerText! }) : undefined;
        if (moderation && !moderation.allowed) return res.status(200).json({ error: false, status: 200, data: { blocked: true, reason: moderation.verdict } });
        if (!await dimafxQueueHandler.isOverlayConnected(channelID)) return res.status(409).json({ error: true, status: 409, message: 'DimaFX overlay is disconnected' });
        const triggerID = `free-${randomUUID()}`;
        if (action === 'save') {
            await getOrCreateInventory(channelID, body.userID!);
            const inventory = await saveFreeDimafx(channelID, body.userID!, itemID);
            if (!inventory) return res.status(429).json({ error: true, status: 429, message: 'You can keep at most twenty free saved copies per channel' });
            return res.status(200).json({ error: false, status: 200, data: { inventory: mapInventory(inventory) } });
        }
        const data = await queueChannelExtensionItem(channelID, itemData.item, itemData.asset, { triggerID, viewerText, source: 'bits_purchase', viewerUserID: body.userID, moderation,
            widget: { bits: null, credits: null, buyerId: body.userID ?? null, message: viewerText ?? null } });
        return res.status(200).json({ error: false, status: 200, data });
    } catch (error) {
        const status = error instanceof DimafxQueueError ? error.status : 500;
        console.error('DimaFX purchase processing failed', error);
        return res.status(status).json({ error: true, status, message: status === 500 ? 'Purchase recovery pending; retry your receipt' : String(error) });
    }
});

router.post('/internal/channels/:channelID/items/:itemID/use-credit', internalServiceAuth, async (req: Request, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const itemID = getParamValue(req.params.itemID);
        const body = (req.body || {}) as ExtensionIdentityBody;
        const action = normalizeDimafxPurchaseAction(body.action);

        if (!body.userID) {
            return res.status(403).json({ error: true, message: 'Identity sharing is required to use DimaFX credits', status: 403 });
        }

        if (!await dimafxQueueHandler.isOverlayConnected(channelID)) {
            return res.status(409).json({ error: true, status: 409, message: 'DimaFX overlay is disconnected' });
        }

        const itemData = await getActiveChannelItem(channelID, itemID);
        if (!itemData) {
            return res.status(404).json({ error: true, message: 'DimaFX item not found', status: 404 });
        }

        const isCustomTts = dimafxItemUsesViewerInput(itemData.item);
        if (action === 'save' && isCustomTts) {
            return res.status(400).json({ error: true, message: 'Custom TTS items must be used immediately', status: 400 });
        }

        const viewerText = itemData.item.category === 'tts' && isCustomTts
            ? sanitizeDimafxViewerTtsText(body.ttsText)
            : undefined;
        if (isCustomTts && !viewerText) {
            return res.status(400).json({ error: true, message: 'TTS text is required for this item', status: 400 });
        }

        if (itemData.item.bitsPrice === 0) return res.status(400).json({ error: true, status: 400, message: 'Use the free purchase route for free items' });
        if (isCustomTts && !await admitDimafxTtsCheck(channelID, body.userID)) return res.status(429).json({ error: true, status: 429, message: 'At most ten TTS checks per minute' });
        const result = await createDimafxSpend({ channelID, userID: body.userID, item: itemData.item, asset: itemData.asset, action, viewerText });
        return res.status(result.status).json({ error: result.status >= 400, status: result.status, message: result.message, data: result.data });
    } catch (error) {
        console.error('Error using DimaFX credits:', {
            channelID: req.params.channelID,
            itemID: req.params.itemID,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.post('/internal/channels/:channelID/items/:itemID/redeem', internalServiceAuth, async (req: Request, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const itemID = getParamValue(req.params.itemID);
        const body = (req.body || {}) as ExtensionIdentityBody;

        if (!body.userID) {
            return res.status(403).json({ error: true, message: 'Identity sharing is required to redeem inventory items', status: 403 });
        }

        if (!await dimafxQueueHandler.isOverlayConnected(channelID)) {
            return res.status(409).json({ error: true, status: 409, message: 'DimaFX overlay is disconnected' });
        }

        const itemData = await getActiveChannelItem(channelID, itemID);
        if (!itemData) {
            return res.status(404).json({ error: true, message: 'DimaFX item not found', status: 404 });
        }

        const inventoryDoc = await UserExtensionInventorySchema.findOne(inventoryIdentityFilter(channelID, body.userID)).lean();
        const savedItem = selectRedeemCandidate(inventoryDoc?.items || [], itemID);
        if (!inventoryDoc || !savedItem) {
            return res.status(400).json({ error: true, message: 'No saved copies available for this item', status: 400 });
        }

        const matchingRows = (inventoryDoc.items || []).filter((item) => String(item.channelExtensionItemID) === itemID && item.quantity > 0);
        if (matchingRows.length > 1) {
            console.warn('[DIMAFX REDEEM] multiple inventory rows matched, only newest decremented', {
                channelID,
                userID: body.userID,
                itemID,
                rowCount: matchingRows.length,
                timestamp: new Date().toISOString()
            });
        }

        if (savedItem.purchasePriceBits === 0 && !await admitFreeDimafx(channelID, body.userID)) return res.status(429).json({ error: true, status: 429, message: 'Wait ten seconds between free DimaFX items' });
        const result = await createDimafxSpend({ channelID, userID: body.userID, item: itemData.item, asset: itemData.asset, action: 'use_now', savedItem });
        return res.status(result.status).json({ error: result.status >= 400, status: result.status, message: result.message, data: result.data });
    } catch (error) {
        console.error('Error redeeming DimaFX item:', {
            channelID: req.params.channelID,
            itemID: req.params.itemID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.get('/:channelID/queue', authMiddleware as any, async (req: DimafxRequest, res: Response) => {
    const channelID = getParamValue(req.params.channelID);
    if (!await ensureDimafxPermission(req, res, channelID, ['dimafx:edit'])) return;
    try { return res.json({ error: false, status: 200, data: await dimafxQueueHandler.snapshot(channelID) }); }
    catch { return res.status(503).json({ error: true, status: 503, message: 'DimaFX queue unavailable' }); }
});
router.post('/:channelID/queue/skip', authMiddleware as any, async (req: DimafxRequest, res: Response) => {
    const channelID = getParamValue(req.params.channelID);
    if (!await ensureDimafxPermission(req, res, channelID, ['dimafx:edit'])) return;
    if (req.body?.id !== undefined && (typeof req.body.id !== 'string' || !req.body.id)) return res.status(400).json({ error: true, status: 400, message: 'Invalid queue entry ID' });
    try { return res.json({ error: false, status: 200, data: { skipped: await dimafxQueueHandler.skip(channelID, req.body?.id) } }); }
    catch { return res.status(503).json({ error: true, status: 503, message: 'DimaFX queue removal unavailable' }); }
});
router.post('/:channelID/queue/clear', authMiddleware as any, async (req: DimafxRequest, res: Response) => {
    const channelID = getParamValue(req.params.channelID);
    if (!await ensureDimafxPermission(req, res, channelID, ['dimafx:edit'])) return;
    try { return res.json({ error: false, status: 200, data: { removed: await dimafxQueueHandler.clear(channelID) } }); }
    catch { return res.status(503).json({ error: true, status: 503, message: 'DimaFX queue removal unavailable' }); }
});

router.get('/:channelID/overlay-status', authMiddleware as any, async (req: DimafxRequest, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        if (!await ensureDimafxPermission(req, res, channelID, ['dimafx:view'])) return;

        const connected = await dimafxQueueHandler.isOverlayConnected(channelID);
        return res.status(200).json({
            error: false,
            message: 'DimaFX overlay status',
            status: 200,
            data: { connected, overlayUrl: dimafxOverlayUrl(channelID) }
        });
    } catch (error) {
        console.error('Error in GET /extensions/dimafx/:channelID/overlay-status:', {
            channelID: req.params.channelID,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.post('/:channelID/items/:itemID/test', authMiddleware as any, async (req: DimafxRequest, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const itemID = getParamValue(req.params.itemID);
        if (!await ensureDimafxPermission(req, res, channelID, ['dimafx:edit'])) return;

        const itemData = await getActiveChannelItem(channelID, itemID);
        if (!itemData) {
            return res.status(404).json({ error: true, message: 'DimaFX item not found', status: 404 });
        }

        // The dashboard tests the voice with an application-owned fixed sample.
        // No viewer-authored content or caller-supplied text enters this path.
        const testItem: IChannelExtensionItem = dimafxItemUsesViewerInput(itemData.item) ? {
            ...itemData.item, tts: { mode: 'fixed', text: 'This is a DimaFX test trigger.',
                voice: itemData.item.tts?.voice || '', language: itemData.item.tts?.language === 'es' ? 'es' : 'en' },
        } : itemData.item;
        const queueResult = await queueChannelExtensionItem(channelID, testItem, itemData.asset, { source: 'test' });

        return res.status(200).json({
            error: false,
            message: 'DimaFX test trigger queued',
            status: 200,
            data: queueResult
        });
    } catch (error) {
        if (error instanceof DimafxQueueError) {
            return res.status(error.status).json({
                error: true,
                message: error.noClients
                    ? 'DimaFX overlay is disconnected. Open your DimaFX OBS link first.'
                    : error.message,
                status: error.status
            });
        }
        console.error('Error in POST /extensions/dimafx/:channelID/items/:itemID/test:', {
            channelID: req.params.channelID,
            itemID: req.params.itemID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.get('/:channelID/items', authMiddleware as any, async (req: DimafxRequest, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        if (!await ensureDimafxPermission(req, res, channelID, ['dimafx:view'])) return;

        const items = await ChannelExtensionItemSchema.find({ channelID, deletedAt: null }).sort({ sortOrder: 1, createdAt: -1 }).lean();
        const assetMap = await getAssetMap(items.map((item) => item.assetID));

        return res.status(200).json({
            error: false,
            message: 'DimaFX items fetched successfully',
            status: 200,
            data: items.map((item) => mapChannelExtensionItem(item, assetMap.get(String(item.assetID)) || null)),
            meta: { allowedBitPrices: getAllowedDimafxBitPrices() }
        });
    } catch (error) {
        console.error('Error in GET /extensions/dimafx/:channelID/items:', {
            channelID: req.params.channelID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.post('/:channelID/items', authMiddleware as any, async (req: DimafxRequest, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        if (!await ensureDimafxPermission(req, res, channelID, ['dimafx:edit'])) return;

        const body = (req.body || {}) as ChannelExtensionItemPayload;
        const bitsPrice = normalizePositiveInteger(body.bitsPrice, 0);
        const sku = getDimafxSkuForBitsPrice(bitsPrice);
        if (!sku) {
            return res.status(400).json({ error: true, message: 'Unsupported Bits price for DimaFX SKU map', status: 400, data: { allowedBitPrices: getAllowedDimafxBitPrices() } });
        }

        const baseFields = {
            channelID,
            channelName: typeof body.channelName === 'string' && body.channelName.trim() ? body.channelName.trim() : req.user?.login || channelID,
            createdByUserID: req.user?.id || channelID,
            name: '',
            description: typeof body.description === 'string' ? body.description.trim() : '',
            bitsPrice,
            sku,
            volume: normalizeVolume(body.volume),
            isEnabled: typeof body.isEnabled === 'boolean' ? body.isEnabled : true,
            sortOrder: normalizePositiveInteger(body.sortOrder, 0)
        };

        if (body.category === 'tts') {
            let ttsConfig;
            try {
                ttsConfig = normalizeDimafxTtsConfig(body.tts) || { mode: 'custom' as const, text: '', voice: '', language: 'en' as const };
            } catch (ttsError) {
                return res.status(400).json({ error: true, message: ttsError instanceof Error ? ttsError.message : 'Invalid TTS configuration', status: 400 });
            }

            const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'TTS message';
            const item = await ChannelExtensionItemSchema.create({
                ...baseFields,
                name,
                assetID: null,
                category: 'tts',
                mediaType: 'audio',
                thumbnailUrl: '',
                durationMs: 0,
                tts: ttsConfig
            });

            return res.status(201).json({ error: false, message: 'DimaFX item created', status: 201, data: mapChannelExtensionItem(item.toObject(), null) });
        }

        if (!body.assetID || !Types.ObjectId.isValid(body.assetID)) {
            return res.status(400).json({ error: true, message: 'Valid assetID is required', status: 400 });
        }

        const asset = await MediaAssetSchema.findOne({ _id: body.assetID, deletedAt: null }).lean();
        if (!asset) {
            return res.status(404).json({ error: true, message: 'Media asset not found', status: 404 });
        }

        const canUseAsset = asset.scope === 'public' || asset.ownerChannelID === channelID;
        if (!canUseAsset) {
            return res.status(403).json({ error: true, message: 'This media asset is not available for this channel', status: 403 });
        }

        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : asset.displayName;
        const item = await ChannelExtensionItemSchema.create({
            ...baseFields,
            name,
            assetID: asset._id,
            category: normalizeCategoryInput(body.category, defaultCategoryFromMediaType(asset.mediaType as string | undefined)),
            mediaType: asset.mediaType as MediaAssetType,
            // body.thumbnailUrl is intentionally ignored — thumbnails are auto-generated
            // server-side so they always resolve to https://api.domdimabot.com/media/{id}.
            thumbnailUrl: getFallbackThumbnail(asset),
            durationMs: normalizePositiveInteger(body.durationMs, 0)
        });

        return res.status(201).json({ error: false, message: 'DimaFX item created', status: 201, data: mapChannelExtensionItem(item.toObject(), asset) });
    } catch (error) {
        console.error('Error creating DimaFX item:', {
            channelID: req.params.channelID,
            body: req.body,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.patch('/:channelID/items/:itemID', authMiddleware as any, async (req: DimafxRequest, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const itemID = getParamValue(req.params.itemID);
        if (!await ensureDimafxPermission(req, res, channelID, ['dimafx:edit'])) return;

        const existing = await ChannelExtensionItemSchema.findOne({ _id: itemID, channelID, deletedAt: null });
        if (!existing) {
            return res.status(404).json({ error: true, message: 'DimaFX item not found', status: 404 });
        }

        const body = (req.body || {}) as ChannelExtensionItemPayload;
        if (typeof body.name === 'string' && body.name.trim()) existing.name = body.name.trim();
        if (typeof body.description === 'string') existing.description = body.description.trim();
        if (body.category !== undefined) {
            if (!isChannelExtensionItemCategory(body.category)) {
                return res.status(400).json({
                    error: true,
                    message: `Invalid category. Allowed: ${ALLOWED_DIMAFX_CATEGORIES.join(', ')}`,
                    status: 400
                });
            }
            // TTS items have no media asset; switching between TTS and media
            // categories would strand the assetID/tts fields. Recreate instead.
            if ((body.category === 'tts') !== (existing.category === 'tts')) {
                return res.status(400).json({
                    error: true,
                    message: 'Category cannot switch between TTS and media. Create a new item instead.',
                    status: 400
                });
            }
            existing.category = body.category;
        }
        if (existing.category === 'tts' && body.tts !== undefined) {
            try {
                existing.tts = normalizeDimafxTtsConfig(body.tts);
            } catch (ttsError) {
                return res.status(400).json({
                    error: true,
                    message: ttsError instanceof Error ? ttsError.message : 'Invalid TTS configuration',
                    status: 400
                });
            }
        }
        // body.thumbnailUrl is intentionally ignored — thumbnails are auto-generated
        // server-side. (Old persisted values remain on the row; the mapper below
        // prefers the asset's generated thumbnail over the stale field.)
        if (body.durationMs !== undefined) existing.durationMs = normalizePositiveInteger(body.durationMs, 0);
        if (body.volume !== undefined) existing.volume = normalizeVolume(body.volume);
        if (typeof body.isEnabled === 'boolean') existing.isEnabled = body.isEnabled;
        if (body.sortOrder !== undefined) existing.sortOrder = normalizePositiveInteger(body.sortOrder, 0);
        if (body.bitsPrice !== undefined) {
            const bitsPrice = normalizePositiveInteger(body.bitsPrice, 0);
            const sku = getDimafxSkuForBitsPrice(bitsPrice);
            if (!sku) {
                return res.status(400).json({ error: true, message: 'Unsupported Bits price for DimaFX SKU map', status: 400, data: { allowedBitPrices: getAllowedDimafxBitPrices() } });
            }
            existing.bitsPrice = bitsPrice;
            existing.sku = sku;
        }

        await existing.save();
        const asset = await MediaAssetSchema.findOne({ _id: existing.assetID, deletedAt: null }).lean();

        return res.status(200).json({ error: false, message: 'DimaFX item updated', status: 200, data: mapChannelExtensionItem(existing.toObject(), asset) });
    } catch (error) {
        console.error('Error updating DimaFX item:', {
            channelID: req.params.channelID,
            itemID: req.params.itemID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

router.delete('/:channelID/items/:itemID', authMiddleware as any, async (req: DimafxRequest, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const itemID = getParamValue(req.params.itemID);
        if (!await ensureDimafxPermission(req, res, channelID, ['dimafx:delete'])) return;

        if (!Types.ObjectId.isValid(itemID)) return res.status(404).json({ error: true, status: 404, message: 'DimaFX item not found' });
        const item = await ChannelExtensionItemSchema.findOneAndUpdate({ _id: itemID, channelID }, { $set: {
            isEnabled: false, deletedAt: new Date(), ...(req.query.refundSaved === 'true' ? { refundSavedPending: true } : {}),
        } }, { new: true }).lean();
        if (!item) return res.status(404).json({ error: true, status: 404, message: 'DimaFX item not found' });
        if (item.refundSavedPending) await refundDeletedDimafxItem(channelID, itemID);

        return res.status(200).json({ error: false, message: 'DimaFX item deleted', status: 200, data: { id: itemID } });
    } catch (error) {
        console.error('Error deleting DimaFX item:', {
            channelID: req.params.channelID,
            itemID: req.params.itemID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
    }
});

export const dimafxRoute = router;
