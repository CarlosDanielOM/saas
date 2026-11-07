import { Types } from 'mongoose';
import { ChannelExtensionItemSchema } from '../../schemas/channel_extension_item.schema.js';
import { UserExtensionInventorySchema } from '../../schemas/user_extension_inventory.schema.js';
import { ExtensionWalletTransactionSchema } from '../../schemas/extension_wallet_transaction.schema.js';

/** Resumable per-wallet refunds: balance, quantities and audit intent change in one write. */
export async function refundDeletedDimafxItem(channelID: string, itemID: string): Promise<void> {
  const id = new Types.ObjectId(itemID);
  while (await UserExtensionInventorySchema.findOneAndUpdate({ channelID, items: { $elemMatch: { channelExtensionItemID: id, quantity: { $gt: 0 } } } }, [
    { $set: { _dimafxRefundAmount: { $sum: { $map: { input: '$items', as: 'row', in: {
      $cond: [{ $eq: ['$$row.channelExtensionItemID', id] }, { $multiply: ['$$row.quantity', '$$row.purchasePriceBits'] }, 0],
    } } } } } },
    { $set: {
      balance: { $add: ['$balance', '$_dimafxRefundAmount'] },
      items: { $map: { input: '$items', as: 'row', in: { $cond: [{ $eq: ['$$row.channelExtensionItemID', id] }, { $mergeObjects: ['$$row', { quantity: 0 }] }, '$$row'] } } },
      dimafxDeletionRefunds: { $concatArrays: [{ $ifNull: ['$dimafxDeletionRefunds', []] }, { $cond: [{ $gt: ['$_dimafxRefundAmount', 0] }, [{ itemID: id, ledgerID: new Types.ObjectId(), amount: '$_dimafxRefundAmount' }], []] }] },
    } },
    { $unset: '_dimafxRefundAmount' },
  ], { new: true }).lean()) { /* Bounded by this item's current holders; every pass clears at least one. */ }

  const wallets = await UserExtensionInventorySchema.find({ channelID, 'dimafxDeletionRefunds.itemID': id }).lean();
  for (const wallet of wallets) for (const refund of wallet.dimafxDeletionRefunds || []) {
    if (String(refund.itemID) !== itemID) continue;
    await ExtensionWalletTransactionSchema.updateOne({ _id: refund.ledgerID }, { $setOnInsert: {
      platform: 'twitch', channelID, userID: wallet.userID, type: 'refund_credit', amountBits: refund.amount, balanceDelta: refund.amount,
      channelExtensionItemID: id, metadata: { reason: 'channel_extension_item_deleted' },
    } }, { upsert: true });
    await UserExtensionInventorySchema.updateOne({ _id: wallet._id }, { $pull: { dimafxDeletionRefunds: { ledgerID: refund.ledgerID } } });
  }
  await ChannelExtensionItemSchema.updateOne({ _id: id, channelID }, { $set: { refundSavedPending: false } });
}
