import { Schema, model, type HydratedDocument, Types } from 'mongoose';
import type { ExtensionPlatform } from './user_extension_inventory.schema.js';

export type ExtensionWalletTransactionType =
    | 'bits_purchase'
    | 'credit_purchase'
    | 'use_now'
    | 'save_item'
    | 'redeem_saved'
    | 'refund_credit'
    | 'gift_in'
    | 'gift_out';

export interface IExtensionWalletTransaction {
    _id: Types.ObjectId;
    platform: ExtensionPlatform;
    userID?: string | null;
    opaqueUserID?: string | null;
    channelID: string;
    type: ExtensionWalletTransactionType;
    amountBits: number;
    balanceDelta: number;
    channelExtensionItemID?: Types.ObjectId | null;
    twitchTransactionID?: string | null;
    sku?: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}

const extensionWalletTransactionSchema = new Schema<IExtensionWalletTransaction>({
    platform: { type: String, required: true, enum: ['twitch'], default: 'twitch', index: true },
    userID: { type: String, default: null, index: true },
    opaqueUserID: { type: String, default: null, index: true },
    channelID: { type: String, required: true, index: true },
    type: {
        type: String,
        required: true,
        enum: ['bits_purchase', 'credit_purchase', 'use_now', 'save_item', 'redeem_saved', 'refund_credit', 'gift_in', 'gift_out'],
        index: true
    },
    amountBits: { type: Number, default: 0 },
    balanceDelta: { type: Number, default: 0 },
    channelExtensionItemID: { type: Schema.Types.ObjectId, ref: 'ChannelExtensionItem', default: null, index: true },
    twitchTransactionID: { type: String, default: null },
    sku: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} }
}, {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' }
});

extensionWalletTransactionSchema.index(
    { twitchTransactionID: 1 },
    { unique: true, partialFilterExpression: { twitchTransactionID: { $type: 'string' } } }
);
extensionWalletTransactionSchema.index({ channelID: 1, userID: 1, createdAt: -1 });

export type ExtensionWalletTransactionDocument = HydratedDocument<IExtensionWalletTransaction>;

export const ExtensionWalletTransactionSchema = model<IExtensionWalletTransaction>('ExtensionWalletTransaction', extensionWalletTransactionSchema);
