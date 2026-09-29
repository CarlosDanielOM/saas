import express, { type NextFunction, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { ChannelExtensionItemSchema, type ChannelExtensionItemCategory, type IChannelExtensionItem } from '../../schemas/channel_extension_item.schema.js';
import { ExtensionWalletTransactionSchema } from '../../schemas/extension_wallet_transaction.schema.js';
import { MediaAssetSchema, type IMediaAsset, type MediaAssetType } from '../../schemas/media_asset.schema.js';
import {
    DEFAULT_EXTENSION_INVENTORY_CONFIG,
    UserExtensionInventorySchema,
    type InventoryItemSource,
    type IUserExtensionInventory
} from '../../schemas/user_extension_inventory.schema.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { buildMediaPlaybackUrl } from '../services/media_library.service.js';
import { scheduleThumbnailGeneration } from '../../utils/thumbnail_generator.js';
import {
    getAllowedDimafxBitPrices,
    getDimafxSkuForBitsPrice,
    hasDimafxPermission,
    normalizeDimafxPurchaseAction,
    normalizeDimafxTtsConfig,
    normalizeDimafxViewerConfig,
    sanitizeDimafxViewerTtsText,
    selectRedeemCandidate,
    type DimafxPurchaseAction
} from '../services/dimafx.service.js';
import { dimafxQueueHandler, type DimafxQueueSource } from '../../handlers/dimafx_queue.handler.js';

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
        sku: item.sku,
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

    if (!providedToken || providedToken !== configuredToken) {
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

function matchingInventoryRowFilter(itemID: string, price: number, source: InventoryItemSource, acquiredAt?: Date) {
    return {
        channelExtensionItemID: new Types.ObjectId(itemID),
        purchasePriceBits: price,
        source,
        ...(acquiredAt ? { acquiredAt } : {})
    };
}

async function addInventoryItem(channelID: string, userID: string, itemID: string, price: number, source: InventoryItemSource): Promise<IUserExtensionInventory> {
    const identity = inventoryIdentityFilter(channelID, userID);
    const existingRow = matchingInventoryRowFilter(itemID, price, source);

    const incremented = await UserExtensionInventorySchema.findOneAndUpdate(
        { ...identity, items: { $elemMatch: existingRow } },
        { $inc: { 'items.$.quantity': 1 } },
        { new: true }
    ).lean();
    if (incremented) {
        return incremented as IUserExtensionInventory;
    }

    const pushed = await UserExtensionInventorySchema.findOneAndUpdate(
        { ...identity, items: { $not: { $elemMatch: existingRow } } },
        {
            $push: {
                items: {
                    channelExtensionItemID: new Types.ObjectId(itemID),
                    quantity: 1,
                    purchasePriceBits: price,
                    acquiredAt: new Date(),
                    source
                }
            }
        },
        { new: true }
    ).lean();
    if (pushed) {
        return pushed as IUserExtensionInventory;
    }

    const retried = await UserExtensionInventorySchema.findOneAndUpdate(
        { ...identity, items: { $elemMatch: existingRow } },
        { $inc: { 'items.$.quantity': 1 } },
        { new: true }
    ).lean();
    if (!retried) {
        throw new Error('Inventory not found');
    }

    return retried as IUserExtensionInventory;
}

async function debitCredits(channelID: string, userID: string, price: number): Promise<IUserExtensionInventory | null> {
    const updated = await UserExtensionInventorySchema.findOneAndUpdate(
        { ...inventoryIdentityFilter(channelID, userID), balance: { $gte: price } },
        { $inc: { balance: -price } },
        { new: true }
    ).lean();
    return (updated as IUserExtensionInventory | null) || null;
}

async function decrementSavedItem(
    channelID: string,
    userID: string,
    itemID: string,
    savedItem: { purchasePriceBits: number; source: InventoryItemSource; acquiredAt: Date }
): Promise<IUserExtensionInventory | null> {
    const updated = await UserExtensionInventorySchema.findOneAndUpdate(
        {
            ...inventoryIdentityFilter(channelID, userID),
            items: {
                $elemMatch: {
                    ...matchingInventoryRowFilter(itemID, savedItem.purchasePriceBits, savedItem.source, savedItem.acquiredAt),
                    quantity: { $gt: 0 }
                }
            }
        },
        { $inc: { 'items.$.quantity': -1 } },
        { new: true }
    ).lean();
    return (updated as IUserExtensionInventory | null) || null;
}

async function restoreSavedItem(
    channelID: string,
    userID: string,
    itemID: string,
    savedItem: { purchasePriceBits: number; source: InventoryItemSource; acquiredAt: Date }
): Promise<void> {
    const restored = await UserExtensionInventorySchema.findOneAndUpdate(
        {
            ...inventoryIdentityFilter(channelID, userID),
            items: {
                $elemMatch: matchingInventoryRowFilter(itemID, savedItem.purchasePriceBits, savedItem.source, savedItem.acquiredAt)
            }
        },
        { $inc: { 'items.$.quantity': 1 } },
        { new: true }
    ).lean();

    if (restored) {
        return;
    }

    await addInventoryItem(channelID, userID, itemID, savedItem.purchasePriceBits, savedItem.source);
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
 * Enqueues a DimaFX trigger for sequential on-stream playback. Replaces the
 * old fire-and-forget socket emit: items now play one at a time, survive
 * brief overlay disconnects, and reach both the legacy trigger overlay and
 * Overlay Studio sources.
 */
async function queueChannelExtensionItem(
    channelID: string,
    item: IChannelExtensionItem,
    asset: IMediaAsset | null,
    options: { viewerText?: string; refundOnFailure?: { userID: string; priceBits: number }; source: DimafxQueueSource }
): Promise<Record<string, unknown>> {
    const result = await dimafxQueueHandler.enqueue({
        channelID,
        item,
        asset,
        viewerText: options.viewerText,
        refundOnFailure: options.refundOnFailure,
        source: options.source
    });

    if (!result.ok) {
        throw new DimafxQueueError(result.message, result.status, result.status === 409);
    }

    return {
        queued: true,
        queueLength: result.queueLength,
        triggerID: result.triggerID,
        activeConnections: result.activeConnections,
        namespace: `/overlays/triggers/${channelID}`
    };
}

function isDuplicateKeyError(error: unknown): boolean {
    return Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 11000;
}

type PurchaseFulfillment = 'pending' | 'processing' | 'fulfilled' | 'refunded';

async function markPurchaseFulfillment(ledgerID: Types.ObjectId, fulfillment: PurchaseFulfillment): Promise<void> {
    await ExtensionWalletTransactionSchema.updateOne(
        { _id: ledgerID },
        { $set: { 'metadata.fulfillment': fulfillment } }
    );
}

interface BitsPurchaseContext {
    ledgerID: Types.ObjectId;
    channelID: string;
    itemData: { item: IChannelExtensionItem; asset: IMediaAsset | null };
    userID?: string;
    opaqueUserID?: string;
    displayName?: string;
    action: DimafxPurchaseAction;
    viewerText?: string;
}

/**
 * Shared fulfillment for fresh Bits purchases and idempotent retries. Callers
 * must own the ledger row (fresh insert or successful pending→processing
 * claim) before invoking this. On queue rejection the purchase ledger is
 * marked refunded and the viewer is credited, so a later retry of the same
 * Twitch transaction reports the refunded state instead of double-charging.
 */
async function fulfillBitsPurchase(ctx: BitsPurchaseContext): Promise<{ status: number; body: Record<string, unknown> }> {
    const { item, asset } = ctx.itemData;

    try {
        if (ctx.userID) {
            await getOrCreateInventory(ctx.channelID, ctx.userID, ctx.displayName);
        }

        if (ctx.action === 'save') {
            const inventory = await addInventoryItem(ctx.channelID, ctx.userID!, String(item._id), item.bitsPrice, 'bits_purchase');
            await markPurchaseFulfillment(ctx.ledgerID, 'fulfilled');
            await ExtensionWalletTransactionSchema.create({
                platform: 'twitch', userID: ctx.userID, channelID: ctx.channelID, type: 'save_item', amountBits: item.bitsPrice, balanceDelta: 0,
                channelExtensionItemID: item._id, metadata: { source: 'bits_purchase' }
            });
            return {
                status: 200,
                body: { error: false, message: 'Item saved to inventory', status: 200, data: { inventory: mapInventory(inventory) } }
            };
        }

        const queueResult = await queueChannelExtensionItem(ctx.channelID, item, asset, {
            viewerText: ctx.viewerText,
            source: 'bits_purchase',
            refundOnFailure: ctx.userID ? { userID: ctx.userID, priceBits: item.bitsPrice } : undefined
        });
        await markPurchaseFulfillment(ctx.ledgerID, 'fulfilled');
        await ExtensionWalletTransactionSchema.create({
            platform: 'twitch', userID: ctx.userID || null, opaqueUserID: ctx.opaqueUserID || null, channelID: ctx.channelID, type: 'use_now', amountBits: item.bitsPrice, balanceDelta: 0,
            channelExtensionItemID: item._id, metadata: { source: 'bits_purchase' }
        });
        return {
            status: 200,
            body: { error: false, message: 'DimaFX item queued for stream playback', status: 200, data: queueResult }
        };
    } catch (error) {
        await markPurchaseFulfillment(ctx.ledgerID, 'refunded').catch(() => undefined);
        if (ctx.userID) {
            await creditViewerForFailedUse(ctx.channelID, ctx.userID, String(item._id), item.bitsPrice, error instanceof Error ? error.message : String(error));
        }
        const status = error instanceof DimafxQueueError ? error.status : 500;
        return {
            status,
            body: {
                error: true,
                message: ctx.userID
                    ? `${error instanceof Error ? error.message : 'DimaFX purchase failed'}. Your Bits were converted to credits.`
                    : (error instanceof Error ? error.message : 'DimaFX purchase failed'),
                status
            }
        };
    }
}

/**
 * Idempotent retry path for Bits purchases: Twitch (or the extension client)
 * may resubmit the same transactionID. The unique ledger index blocks a
 * second insert; this resolves the stored outcome or resumes a purchase that
 * was interrupted after the ledger write but before fulfillment.
 */
async function resolveDuplicateBitsPurchase(res: Response, channelID: string, transactionID: string): Promise<Response> {
    const existing = await ExtensionWalletTransactionSchema.findOne({ twitchTransactionID: transactionID }).lean();
    if (!existing || existing.type !== 'bits_purchase') {
        return res.status(409).json({ error: true, message: 'This Bits transaction was already submitted', status: 409 });
    }

    const fulfillment = (existing.metadata?.fulfillment as PurchaseFulfillment | undefined) || 'fulfilled';

    if (fulfillment === 'refunded') {
        return res.status(409).json({
            error: true,
            message: existing.userID
                ? 'This purchase could not be fulfilled. Your Bits were converted to credits.'
                : 'This purchase could not be fulfilled.',
            status: 409
        });
    }

    if (fulfillment === 'fulfilled') {
        const inventory = existing.userID
            ? await UserExtensionInventorySchema.findOne(inventoryIdentityFilter(channelID, existing.userID)).lean()
            : null;
        return res.status(200).json({
            error: false,
            message: 'DimaFX purchase already processed',
            status: 200,
            data: { duplicate: true, inventory: inventory ? mapInventory(inventory as IUserExtensionInventory) : null }
        });
    }

    // pending/processing → try to claim and resume fulfillment. A fresh
    // 'processing' state means another request is actively fulfilling right
    // now; only a stale one (crashed request) may be reclaimed.
    const staleThreshold = new Date(Date.now() - 30_000);
    const claimed = await ExtensionWalletTransactionSchema.updateOne(
        {
            _id: existing._id,
            $or: [
                { 'metadata.fulfillment': 'pending' },
                { 'metadata.fulfillment': 'processing', updatedAt: { $lt: staleThreshold } }
            ]
        },
        { $set: { 'metadata.fulfillment': 'processing' } }
    );
    if (claimed.modifiedCount === 0) {
        return res.status(200).json({
            error: false,
            message: 'DimaFX purchase is already being processed',
            status: 200,
            data: { duplicate: true }
        });
    }

    const itemData = await getActiveChannelItem(channelID, String(existing.channelExtensionItemID || ''));
    if (!itemData) {
        await markPurchaseFulfillment(existing._id, 'refunded').catch(() => undefined);
        if (existing.userID) {
            await creditViewerForFailedUse(channelID, existing.userID, String(existing.channelExtensionItemID), Number(existing.amountBits || 0), 'item_unavailable_on_retry');
        }
        return res.status(404).json({ error: true, message: 'DimaFX item not found', status: 404 });
    }

    const action = normalizeDimafxPurchaseAction(existing.metadata?.action);
    const viewerText = typeof existing.metadata?.viewerText === 'string' ? existing.metadata.viewerText : undefined;
    const result = await fulfillBitsPurchase({
        ledgerID: existing._id,
        channelID,
        itemData,
        userID: existing.userID || undefined,
        opaqueUserID: existing.opaqueUserID || undefined,
        action,
        viewerText
    });
    return res.status(result.status).json(result.body);
}

async function creditViewerForFailedUse(channelID: string, userID: string, itemID: string, price: number, reason: string): Promise<void> {
    await UserExtensionInventorySchema.updateOne(
        { platform: 'twitch', userID, channelID },
        { $inc: { balance: price } }
    );
    await ExtensionWalletTransactionSchema.create({
        platform: 'twitch',
        userID,
        channelID,
        type: 'refund_credit',
        amountBits: price,
        balanceDelta: price,
        channelExtensionItemID: new Types.ObjectId(itemID),
        metadata: { reason }
    });
}

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

router.post('/internal/channels/:channelID/items/:itemID/purchase', internalServiceAuth, async (req: Request, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        const itemID = getParamValue(req.params.itemID);
        const body = (req.body || {}) as ExtensionIdentityBody;
        const action = normalizeDimafxPurchaseAction(body.action);

        const itemData = await getActiveChannelItem(channelID, itemID);
        if (!itemData) {
            return res.status(404).json({ error: true, message: 'DimaFX item not found', status: 404 });
        }

        if (body.sku !== itemData.item.sku) {
            return res.status(400).json({ error: true, message: 'SKU does not match the selected item', status: 400 });
        }

        if (action === 'save' && !body.userID) {
            return res.status(403).json({ error: true, message: 'Anonymous viewers cannot save DimaFX items', status: 403 });
        }

        // Custom-text TTS items must play immediately: the viewer's text only
        // exists in this request, so saving them for later is not supported.
        const isCustomTts = itemData.item.category === 'tts' && itemData.item.tts?.mode === 'custom';
        if (action === 'save' && isCustomTts) {
            return res.status(400).json({ error: true, message: 'Custom TTS items must be used immediately', status: 400 });
        }

        const viewerText = itemData.item.category === 'tts' && isCustomTts
            ? sanitizeDimafxViewerTtsText(body.ttsText)
            : undefined;
        if (isCustomTts && !viewerText) {
            return res.status(400).json({ error: true, message: 'TTS text is required for this item', status: 400 });
        }

        let ledger;
        try {
            ledger = await ExtensionWalletTransactionSchema.create({
                platform: 'twitch',
                userID: body.userID || null,
                opaqueUserID: body.opaqueUserID || null,
                channelID,
                type: 'bits_purchase',
                amountBits: itemData.item.bitsPrice,
                balanceDelta: 0,
                channelExtensionItemID: itemData.item._id,
                twitchTransactionID: body.transactionID || null,
                sku: body.sku,
                metadata: {
                    action,
                    fulfillment: 'pending',
                    ...(viewerText ? { viewerText } : {})
                }
            });
        } catch (createError) {
            if (isDuplicateKeyError(createError) && body.transactionID) {
                return await resolveDuplicateBitsPurchase(res, channelID, body.transactionID);
            }
            throw createError;
        }

        // Claim the row before fulfilling so a concurrent duplicate of the same
        // Twitch transaction reports the in-flight purchase instead of
        // fulfilling twice.
        const claimed = await ExtensionWalletTransactionSchema.updateOne(
            { _id: ledger._id, 'metadata.fulfillment': 'pending' },
            { $set: { 'metadata.fulfillment': 'processing' } }
        );
        if (claimed.modifiedCount === 0 && body.transactionID) {
            return await resolveDuplicateBitsPurchase(res, channelID, body.transactionID);
        }

        const result = await fulfillBitsPurchase({
            ledgerID: ledger._id,
            channelID,
            itemData,
            userID: body.userID,
            opaqueUserID: body.opaqueUserID,
            displayName: body.displayName,
            action,
            viewerText
        });
        return res.status(result.status).json(result.body);
    } catch (error) {
        console.error('Error processing DimaFX purchase:', {
            channelID: req.params.channelID,
            itemID: req.params.itemID,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
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

        const itemData = await getActiveChannelItem(channelID, itemID);
        if (!itemData) {
            return res.status(404).json({ error: true, message: 'DimaFX item not found', status: 404 });
        }

        const isCustomTts = itemData.item.category === 'tts' && itemData.item.tts?.mode === 'custom';
        if (action === 'save' && isCustomTts) {
            return res.status(400).json({ error: true, message: 'Custom TTS items must be used immediately', status: 400 });
        }

        const viewerText = itemData.item.category === 'tts' && isCustomTts
            ? sanitizeDimafxViewerTtsText(body.ttsText)
            : undefined;
        if (isCustomTts && !viewerText) {
            return res.status(400).json({ error: true, message: 'TTS text is required for this item', status: 400 });
        }

        const price = itemData.item.bitsPrice;
        const debited = await debitCredits(channelID, body.userID, price);
        if (!debited) {
            const exists = await UserExtensionInventorySchema.exists(inventoryIdentityFilter(channelID, body.userID));
            if (!exists) {
                return res.status(404).json({ error: true, message: 'Inventory not found', status: 404 });
            }
            return res.status(402).json({ error: true, message: 'Not enough DimaFX credits', status: 402 });
        }

        let creditsRefunded = false;
        const refundDebit = async (reason: string): Promise<void> => {
            if (creditsRefunded || price <= 0) return;
            await creditViewerForFailedUse(channelID, body.userID!, itemID, price, reason);
            creditsRefunded = true;
        };

        try {
            await ExtensionWalletTransactionSchema.create({
                platform: 'twitch', userID: body.userID, channelID, type: 'credit_purchase', amountBits: price, balanceDelta: -price,
                channelExtensionItemID: itemData.item._id, metadata: { action }
            });

            if (action === 'save') {
                const inventory = await addInventoryItem(channelID, body.userID, itemID, price, 'credit_purchase');
                return res.status(200).json({ error: false, message: 'Item saved to inventory', status: 200, data: { inventory: mapInventory(inventory) } });
            }

            try {
                const queueResult = await queueChannelExtensionItem(channelID, itemData.item, itemData.asset, {
                    viewerText,
                    source: 'credit_purchase',
                    refundOnFailure: { userID: body.userID!, priceBits: price }
                });
                return res.status(200).json({ error: false, message: 'DimaFX item queued for stream playback', status: 200, data: queueResult });
            } catch (emitError) {
                await refundDebit(emitError instanceof Error ? emitError.message : String(emitError));
                const status = emitError instanceof DimafxQueueError ? emitError.status : 409;
                return res.status(status).json({
                    error: true,
                    message: `${emitError instanceof Error ? emitError.message : 'Unable to queue DimaFX item'}. Your credits were returned.`,
                    status
                });
            }
        } catch (error) {
            await refundDebit(error instanceof Error ? error.message : String(error));
            console.error('Error using DimaFX credits:', {
                channelID: req.params.channelID,
                itemID: req.params.itemID,
                error: error instanceof Error ? error.message : String(error),
                timestamp: new Date().toISOString()
            });
            return res.status(500).json({ error: true, message: 'Internal server error', status: 500 });
        }
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

        const decremented = await decrementSavedItem(channelID, body.userID, itemID, savedItem);
        if (!decremented) {
            return res.status(400).json({ error: true, message: 'No saved copies available for this item', status: 400 });
        }

        try {
            const queueResult = await queueChannelExtensionItem(channelID, itemData.item, itemData.asset, {
                source: 'redeem_saved',
                refundOnFailure: { userID: body.userID!, priceBits: savedItem.purchasePriceBits }
            });
            try {
                await ExtensionWalletTransactionSchema.create({
                    platform: 'twitch', userID: body.userID, channelID, type: 'redeem_saved', amountBits: savedItem.purchasePriceBits, balanceDelta: 0,
                    channelExtensionItemID: itemData.item._id, metadata: {}
                });
            } catch (ledgerError) {
                console.error('DimaFX redeem overlay succeeded but ledger write failed:', {
                    channelID,
                    userID: body.userID,
                    itemID,
                    error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
                    timestamp: new Date().toISOString()
                });
            }

            return res.status(200).json({ error: false, message: 'Saved DimaFX item queued for stream playback', status: 200, data: { ...queueResult, inventory: mapInventory(decremented) } });
        } catch (emitError) {
            try {
                await restoreSavedItem(channelID, body.userID, itemID, savedItem);
            } catch (restoreError) {
                console.error('Failed to restore DimaFX inventory after overlay emit failure:', {
                    channelID,
                    userID: body.userID,
                    itemID,
                    restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
                    timestamp: new Date().toISOString()
                });
            }

            const noClients = emitError instanceof DimafxQueueError && emitError.noClients;
            const status = emitError instanceof DimafxQueueError ? emitError.status : 500;
            return res.status(status).json({
                error: true,
                message: noClients
                    ? 'No trigger overlay clients connected. Your saved copy was not used.'
                    : 'Unable to queue overlay playback. Your saved copy was not used.',
                status
            });
        }
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

router.get('/:channelID/overlay-status', authMiddleware as any, async (req: DimafxRequest, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        if (!await ensureDimafxPermission(req, res, channelID, ['dimafx:view'])) return;

        const connected = await dimafxQueueHandler.isOverlayConnected(channelID);
        return res.status(200).json({
            error: false,
            message: 'DimaFX overlay status',
            status: 200,
            data: { connected }
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

        // Custom-text TTS items need viewer text at purchase time; the test
        // trigger uses a fixed sample so broadcasters can verify the voice.
        const viewerText = itemData.item.category === 'tts' && itemData.item.tts?.mode === 'custom'
            ? 'This is a DimaFX test trigger.'
            : undefined;

        const queueResult = await queueChannelExtensionItem(channelID, itemData.item, itemData.asset, {
            viewerText,
            source: 'test'
        });

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
                    ? 'No trigger overlay clients connected. Open your trigger overlay or Overlay Studio source first.'
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

        const item = await ChannelExtensionItemSchema.findOne({ _id: itemID, channelID, deletedAt: null });
        if (!item) {
            return res.status(404).json({ error: true, message: 'DimaFX item not found', status: 404 });
        }

        item.isEnabled = false;
        item.deletedAt = new Date();
        await item.save();

        if (req.query.refundSaved === 'true') {
            const inventories = await UserExtensionInventorySchema.find({ channelID, 'items.channelExtensionItemID': item._id });
            for (const inventory of inventories) {
                let refundTotal = 0;
                for (const inventoryItem of inventory.items) {
                    if (String(inventoryItem.channelExtensionItemID) === itemID && inventoryItem.quantity > 0) {
                        refundTotal += inventoryItem.quantity * inventoryItem.purchasePriceBits;
                        inventoryItem.quantity = 0;
                    }
                }

                if (refundTotal > 0) {
                    inventory.balance += refundTotal;
                    await inventory.save();
                    await ExtensionWalletTransactionSchema.create({
                        platform: 'twitch', userID: inventory.userID, channelID, type: 'refund_credit', amountBits: refundTotal, balanceDelta: refundTotal,
                        channelExtensionItemID: item._id, metadata: { reason: 'channel_extension_item_deleted' }
                    });
                }
            }
        }

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
