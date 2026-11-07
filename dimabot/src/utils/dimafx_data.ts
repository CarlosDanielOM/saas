import { ChannelExtensionItemSchema } from '../schemas/channel_extension_item.schema.js';
import { DimafxPlaybackSchema, DimafxQueueGateSchema, DimafxFreePaceSchema, DimafxModerationCacheSchema, DimafxRequestLimitSchema } from '../schemas/dimafx_playback.schema.js';
import { ExtensionWalletTransactionSchema, DimafxTransactionClaimSchema } from '../schemas/extension_wallet_transaction.schema.js';
import { UserExtensionInventorySchema } from '../schemas/user_extension_inventory.schema.js';

export interface IDeleteChannelDimafxResult {
    dimafxItemsDeleted: number;
    dimafxWalletsDeleted: number;
    dimafxTransactionsDeleted: number;
    dimafxPlaybacksDeleted: number;
    dimafxClaimsDeleted: number;
}

/**
 * Removes everything DimaFX stores for one channel: its shop items (including soft-deleted ones),
 * viewer wallets and saved items, the purchase log and playback records. Media files are handled
 * by the media library cleanup.
 */
export async function deleteChannelDimafxData(channelID: string): Promise<IDeleteChannelDimafxResult> {
    if (!channelID) {
        throw new Error('channelID is required to delete DimaFX data');
    }

    await DimafxQueueGateSchema.deleteOne({ _id: channelID });
    await DimafxFreePaceSchema.deleteMany({ channelID });
    await DimafxModerationCacheSchema.deleteMany({ channelID });
    await DimafxRequestLimitSchema.deleteMany({ channelID });
    const [items, wallets, transactions, playbacks, claims] = await Promise.all([
        ChannelExtensionItemSchema.deleteMany({ channelID }),
        UserExtensionInventorySchema.deleteMany({ channelID }),
        ExtensionWalletTransactionSchema.deleteMany({ channelID }),
        DimafxPlaybackSchema.deleteMany({ channelID }),
        DimafxTransactionClaimSchema.deleteMany({ channelID })
    ]);

    return {
        dimafxItemsDeleted: items.deletedCount ?? 0,
        dimafxWalletsDeleted: wallets.deletedCount ?? 0,
        dimafxTransactionsDeleted: transactions.deletedCount ?? 0,
        dimafxPlaybacksDeleted: playbacks.deletedCount ?? 0,
        dimafxClaimsDeleted: claims.deletedCount ?? 0
    };
}
