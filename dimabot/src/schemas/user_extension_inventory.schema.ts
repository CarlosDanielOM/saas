import { Schema, model, type HydratedDocument, Types } from 'mongoose';

export type ExtensionPlatform = 'twitch';
export type QuickPurchasePriority = 'credits_first' | 'bits_first';
export type QuickPurchaseAction = 'use_now' | 'save';
export type InventoryItemSource = 'bits_purchase' | 'credit_purchase' | 'refund_credit' | 'gift' | 'admin_adjustment';

export interface IUserExtensionInventoryConfig {
    quickPurchasePriority: QuickPurchasePriority;
    quickPurchaseAction: QuickPurchaseAction;
}

export interface IUserExtensionInventoryItem {
    channelExtensionItemID: Types.ObjectId;
    quantity: number;
    purchasePriceBits: number;
    acquiredAt: Date;
    source: InventoryItemSource;
}

export interface IUserExtensionInventory {
    _id: Types.ObjectId;
    platform: ExtensionPlatform;
    userID: string;
    channelID: string;
    displayName?: string | null;
    balance: number;
    config: IUserExtensionInventoryConfig;
    items: IUserExtensionInventoryItem[];
    createdAt: Date;
    updatedAt: Date;
}

export const DEFAULT_EXTENSION_INVENTORY_CONFIG: IUserExtensionInventoryConfig = {
    quickPurchasePriority: 'credits_first',
    quickPurchaseAction: 'use_now'
};

const inventoryItemSchema = new Schema<IUserExtensionInventoryItem>({
    channelExtensionItemID: { type: Schema.Types.ObjectId, ref: 'ChannelExtensionItem', required: true },
    quantity: { type: Number, required: true, min: 0, default: 0 },
    purchasePriceBits: { type: Number, required: true, min: 0, default: 0 },
    acquiredAt: { type: Date, default: Date.now },
    source: {
        type: String,
        required: true,
        enum: ['bits_purchase', 'credit_purchase', 'refund_credit', 'gift', 'admin_adjustment'],
        default: 'bits_purchase'
    }
}, { _id: false });

const userExtensionInventorySchema = new Schema<IUserExtensionInventory>({
    platform: { type: String, required: true, enum: ['twitch'], default: 'twitch' },
    userID: { type: String, required: true, index: true },
    channelID: { type: String, required: true, index: true },
    displayName: { type: String, default: null },
    balance: { type: Number, default: 0, min: 0 },
    config: {
        quickPurchasePriority: { type: String, enum: ['credits_first', 'bits_first'], default: DEFAULT_EXTENSION_INVENTORY_CONFIG.quickPurchasePriority },
        quickPurchaseAction: { type: String, enum: ['use_now', 'save'], default: DEFAULT_EXTENSION_INVENTORY_CONFIG.quickPurchaseAction }
    },
    items: { type: [inventoryItemSchema], default: [] }
}, {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

userExtensionInventorySchema.index({ platform: 1, userID: 1, channelID: 1 }, { unique: true });

export type UserExtensionInventoryDocument = HydratedDocument<IUserExtensionInventory>;

export const UserExtensionInventorySchema = model<IUserExtensionInventory>('UserExtensionInventory', userExtensionInventorySchema);
