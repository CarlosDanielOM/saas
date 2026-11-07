import { Types } from 'mongoose';
import { UserExtensionInventorySchema, type InventoryItemSource } from '../../schemas/user_extension_inventory.schema.js';

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

export async function saveDimafxPurchaseOnce(channelID: string, userID: string, itemID: string, price: number, ledgerID: string, source: InventoryItemSource = 'bits_purchase') {
  const identity = { platform: 'twitch', channelID, userID };
  const receipt = `save:${ledgerID}`;
  await UserExtensionInventorySchema.updateOne(
    { ...identity, dimafxReceipts: { $ne: receipt } },
    {
      $addToSet: { dimafxReceipts: receipt },
      $push: { items: { channelExtensionItemID: new Types.ObjectId(itemID), quantity: 1, purchasePriceBits: price, acquiredAt: new Date(), source } },
    },
  );
  const inventory = await UserExtensionInventorySchema.findOne({ ...identity, dimafxReceipts: receipt }).lean();
  if (!inventory) throw new Error('DimaFX inventory is unavailable');
  return inventory;
}

/** Single make-good policy boundary. Item context is supplied so this can later grant the same item instead of credits. */
export async function makeGoodDimafx(channelID: string, userID: string, amount: number, receipt: string, _itemID?: string): Promise<{ credits: number }> {
  await refundDimafxOnce(channelID, userID, amount, receipt);
  return { credits: amount };
}

/** Atomic per-channel/viewer pace; shared identity takes precedence over rotating opaque IDs. */
export async function admitFreeDimafx(channelID: string, viewerID: string): Promise<boolean> {
  const { DimafxFreePaceSchema } = await import('../../schemas/dimafx_playback.schema.js');
  try {
    const result = await DimafxFreePaceSchema.findOneAndUpdate(
      { _id: `${channelID}:${viewerID}`, nextAt: { $lte: new Date() } },
      { $set: { channelID, nextAt: new Date(Date.now() + 10_000), updatedAt: new Date() } }, { upsert: true, new: true },
    );
    return Boolean(result);
  } catch (error) { if ((error as { code?: number }).code === 11000) return false; throw error; }
}

export async function saveFreeDimafx(channelID: string, userID: string, itemID: string) {
  // Mongo expression counts quantities, rather than rows (paid zero-price copies included).
  return UserExtensionInventorySchema.findOneAndUpdate({ platform: 'twitch', channelID, userID,
    $expr: { $lt: [{ $sum: { $map: { input: '$items', as: 'item', in: { $cond: [{ $eq: ['$$item.purchasePriceBits', 0] }, '$$item.quantity', 0] } } } }, 20] },
  }, { $push: { items: { channelExtensionItemID: new Types.ObjectId(itemID), quantity: 1, purchasePriceBits: 0, acquiredAt: new Date(), source: 'bits_purchase' } } }, { new: true }).lean();
}
