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
import { getIO } from '../websocket.js';
import { buildMediaPlaybackUrl } from '../services/media_library.service.js';
import {
    getAllowedDimafxBitPrices,
    getDimafxSkuForBitsPrice,
    hasDimafxPermission,
    normalizeDimafxPurchaseAction,
    type DimafxPurchaseAction
} from '../services/dimafx.service.js';

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
}

interface ExtensionIdentityBody {
    userID?: string;
    opaqueUserID?: string;
    displayName?: string;
    transactionID?: string;
    sku?: string;
    action?: DimafxPurchaseAction;
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
    if (asset.mediaType === 'image' || asset.mediaType === 'gif') {
        return buildMediaPlaybackUrl(asset._id);
    }
    return '';
}

function mapChannelExtensionItem(item: IChannelExtensionItem, asset: IMediaAsset | null): Record<string, unknown> {
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
        thumbnailUrl: item.thumbnailUrl || getFallbackThumbnail(asset),
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
        mediaUrl: asset ? buildMediaPlaybackUrl(asset._id) : null
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

async function getAssetMap(assetIDs: string[]): Promise<Map<string, IMediaAsset>> {
    const uniqueIDs = Array.from(new Set(assetIDs.filter(Boolean)));
    if (uniqueIDs.length === 0) return new Map();

    const assets = await MediaAssetSchema.find({ _id: { $in: uniqueIDs }, deletedAt: null }).lean();
    return new Map(assets.map((asset) => [String(asset._id), asset]));
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

async function getActiveChannelItem(channelID: string, itemID: string): Promise<{ item: IChannelExtensionItem; asset: IMediaAsset } | null> {
    if (!Types.ObjectId.isValid(itemID)) return null;

    const item = await ChannelExtensionItemSchema.findOne({
        _id: itemID,
        channelID,
        isEnabled: true,
        deletedAt: null
    }).lean();

    if (!item) return null;

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

async function addInventoryItem(channelID: string, userID: string, itemID: string, price: number, source: InventoryItemSource): Promise<IUserExtensionInventory> {
    const inventory = await UserExtensionInventorySchema.findOne({ platform: 'twitch', userID, channelID });
    if (!inventory) {
        throw new Error('Inventory not found');
    }

    const existingItem = inventory.items.find((item) =>
        String(item.channelExtensionItemID) === itemID && item.purchasePriceBits === price && item.source === source
    );

    if (existingItem) {
        existingItem.quantity += 1;
    } else {
        inventory.items.push({
            channelExtensionItemID: new Types.ObjectId(itemID),
            quantity: 1,
            purchasePriceBits: price,
            acquiredAt: new Date(),
            source
        });
    }

    await inventory.save();
    return inventory.toObject() as IUserExtensionInventory;
}

async function emitChannelExtensionItem(channelID: string, item: IChannelExtensionItem, asset: IMediaAsset): Promise<Record<string, unknown>> {
    const io = getIO();
    if (!io) {
        throw new Error('Websocket not initialized');
    }

    const namespacePath = `/overlays/triggers/${channelID}`;
    const namespace = io.of(namespacePath);
    const sockets = await namespace.fetchSockets();

    if (sockets.length === 0) {
        const noClientsError = new Error('No trigger overlay clients connected');
        noClientsError.name = 'NO_TRIGGER_CLIENTS';
        throw noClientsError;
    }

    namespace.emit('trigger', {
        url: buildMediaPlaybackUrl(asset._id),
        mediaType: asset.mimeType || item.mediaType,
        volume: item.volume,
        source: 'dimafx',
        itemID: String(item._id),
        assetID: String(asset._id),
        name: item.name
    });

    return { activeConnections: sockets.length, namespace: namespacePath };
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
        const assetMap = await getAssetMap(items.map((item) => String(item.assetID)));

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
        const nextConfig = {
            quickPurchasePriority: req.body?.quickPurchasePriority === 'bits_first' ? 'bits_first' : inventory.config.quickPurchasePriority,
            quickPurchaseAction: req.body?.quickPurchaseAction === 'save' ? 'save' : req.body?.quickPurchaseAction === 'use_now' ? 'use_now' : inventory.config.quickPurchaseAction
        };
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

        await ExtensionWalletTransactionSchema.create({
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
            metadata: { action }
        });

        if (body.userID) {
            await getOrCreateInventory(channelID, body.userID, body.displayName);
        }

        if (action === 'save') {
            const inventory = await addInventoryItem(channelID, body.userID!, itemID, itemData.item.bitsPrice, 'bits_purchase');
            await ExtensionWalletTransactionSchema.create({
                platform: 'twitch', userID: body.userID, channelID, type: 'save_item', amountBits: itemData.item.bitsPrice, balanceDelta: 0,
                channelExtensionItemID: itemData.item._id, metadata: { source: 'bits_purchase' }
            });
            return res.status(200).json({ error: false, message: 'Item saved to inventory', status: 200, data: { inventory: mapInventory(inventory) } });
        }

        try {
            const emitResult = await emitChannelExtensionItem(channelID, itemData.item, itemData.asset);
            await ExtensionWalletTransactionSchema.create({
                platform: 'twitch', userID: body.userID || null, opaqueUserID: body.opaqueUserID || null, channelID, type: 'use_now', amountBits: itemData.item.bitsPrice, balanceDelta: 0,
                channelExtensionItemID: itemData.item._id, metadata: { source: 'bits_purchase' }
            });
            return res.status(200).json({ error: false, message: 'DimaFX item triggered', status: 200, data: emitResult });
        } catch (emitError) {
            if (body.userID) {
                await creditViewerForFailedUse(channelID, body.userID, itemID, itemData.item.bitsPrice, emitError instanceof Error ? emitError.message : String(emitError));
            }
            return res.status(409).json({
                error: true,
                message: body.userID ? 'No trigger overlay clients connected. Your Bits were converted to credits.' : 'No trigger overlay clients connected',
                status: 409
            });
        }
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

        const inventoryDoc = await UserExtensionInventorySchema.findOne({ platform: 'twitch', userID: body.userID, channelID });
        if (!inventoryDoc) {
            return res.status(404).json({ error: true, message: 'Inventory not found', status: 404 });
        }

        if (inventoryDoc.balance < itemData.item.bitsPrice) {
            return res.status(402).json({ error: true, message: 'Not enough DimaFX credits', status: 402 });
        }

        inventoryDoc.balance -= itemData.item.bitsPrice;
        await inventoryDoc.save();
        await ExtensionWalletTransactionSchema.create({
            platform: 'twitch', userID: body.userID, channelID, type: 'credit_purchase', amountBits: itemData.item.bitsPrice, balanceDelta: -itemData.item.bitsPrice,
            channelExtensionItemID: itemData.item._id, metadata: { action }
        });

        if (action === 'save') {
            const inventory = await addInventoryItem(channelID, body.userID, itemID, itemData.item.bitsPrice, 'credit_purchase');
            return res.status(200).json({ error: false, message: 'Item saved to inventory', status: 200, data: { inventory: mapInventory(inventory) } });
        }

        try {
            const emitResult = await emitChannelExtensionItem(channelID, itemData.item, itemData.asset);
            return res.status(200).json({ error: false, message: 'DimaFX item triggered', status: 200, data: emitResult });
        } catch (emitError) {
            await creditViewerForFailedUse(channelID, body.userID, itemID, itemData.item.bitsPrice, emitError instanceof Error ? emitError.message : String(emitError));
            return res.status(409).json({ error: true, message: 'No trigger overlay clients connected. Your credits were returned.', status: 409 });
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

        const inventoryDoc = await UserExtensionInventorySchema.findOne({ platform: 'twitch', userID: body.userID, channelID });
        const savedItem = inventoryDoc?.items.find((item) => String(item.channelExtensionItemID) === itemID && item.quantity > 0);
        if (!inventoryDoc || !savedItem) {
            return res.status(400).json({ error: true, message: 'No saved copies available for this item', status: 400 });
        }

        savedItem.quantity -= 1;
        await inventoryDoc.save();

        const emitResult = await emitChannelExtensionItem(channelID, itemData.item, itemData.asset);
        await ExtensionWalletTransactionSchema.create({
            platform: 'twitch', userID: body.userID, channelID, type: 'redeem_saved', amountBits: savedItem.purchasePriceBits, balanceDelta: 0,
            channelExtensionItemID: itemData.item._id, metadata: {}
        });

        return res.status(200).json({ error: false, message: 'Saved DimaFX item redeemed', status: 200, data: { ...emitResult, inventory: mapInventory(inventoryDoc.toObject() as IUserExtensionInventory) } });
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

router.get('/:channelID/items', authMiddleware as any, async (req: DimafxRequest, res: Response) => {
    try {
        const channelID = getParamValue(req.params.channelID);
        if (!await ensureDimafxPermission(req, res, channelID, ['dimafx:view'])) return;

        const items = await ChannelExtensionItemSchema.find({ channelID, deletedAt: null }).sort({ sortOrder: 1, createdAt: -1 }).lean();
        const assetMap = await getAssetMap(items.map((item) => String(item.assetID)));

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

        const bitsPrice = normalizePositiveInteger(body.bitsPrice, 0);
        const sku = getDimafxSkuForBitsPrice(bitsPrice);
        if (!sku) {
            return res.status(400).json({ error: true, message: 'Unsupported Bits price for DimaFX SKU map', status: 400, data: { allowedBitPrices: getAllowedDimafxBitPrices() } });
        }

        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : asset.displayName;
        const item = await ChannelExtensionItemSchema.create({
            channelID,
            channelName: typeof body.channelName === 'string' && body.channelName.trim() ? body.channelName.trim() : req.user?.login || channelID,
            createdByUserID: req.user?.id || channelID,
            assetID: asset._id,
            name,
            description: typeof body.description === 'string' ? body.description.trim() : '',
            category: body.category || 'media',
            mediaType: asset.mediaType as MediaAssetType,
            thumbnailUrl: typeof body.thumbnailUrl === 'string' ? body.thumbnailUrl.trim() : getFallbackThumbnail(asset),
            durationMs: normalizePositiveInteger(body.durationMs, 0),
            bitsPrice,
            sku,
            volume: normalizeVolume(body.volume),
            isEnabled: typeof body.isEnabled === 'boolean' ? body.isEnabled : true,
            sortOrder: normalizePositiveInteger(body.sortOrder, 0)
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
        if (body.category) existing.category = body.category;
        if (typeof body.thumbnailUrl === 'string') existing.thumbnailUrl = body.thumbnailUrl.trim();
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
