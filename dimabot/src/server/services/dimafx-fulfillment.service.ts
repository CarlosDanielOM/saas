import { Types } from 'mongoose';
import { UserExtensionInventorySchema } from '../../schemas/user_extension_inventory.schema.js';

/** The receipt and its monetary/inventory effect are one Mongo document update. */
export async function refundDimafxOnce(channelID: string, userID: string, amount: number, receipt: string): Promise<void> {
  if (amount <= 0) return;
  const result = await UserExtensionInventorySchema.updateOne(
    { platform: 'twitch', channelID, userID, dimafxReceipts: { $ne: receipt } },
    { $inc: { balance: amount }, $addToSet: { dimafxReceipts: receipt } },
  );
  if (!result.matchedCount && !await UserExtensionInventorySchema.exists({ platform: 'twitch', channelID, userID, dimafxReceipts: receipt })) {
    throw new Error('DimaFX refund inventory is unavailable');
  }
}

export async function saveDimafxPurchaseOnce(channelID: string, userID: string, itemID: string, price: number, ledgerID: string) {
  const identity = { platform: 'twitch', channelID, userID };
  const receipt = `save:${ledgerID}`;
  await UserExtensionInventorySchema.updateOne(
    { ...identity, dimafxReceipts: { $ne: receipt } },
    {
      $addToSet: { dimafxReceipts: receipt },
      $push: { items: { channelExtensionItemID: new Types.ObjectId(itemID), quantity: 1, purchasePriceBits: price, acquiredAt: new Date(), source: 'bits_purchase' } },
    },
  );
  const inventory = await UserExtensionInventorySchema.findOne({ ...identity, dimafxReceipts: receipt }).lean();
  if (!inventory) throw new Error('DimaFX inventory is unavailable');
  return inventory;
}
