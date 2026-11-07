import { moderateDimafxViewerText, type DimafxTextDecision } from '../../utils/moderation/dimafx_tts.js';
import { dimafxItemUsesViewerInput } from './dimafx.service.js';
import { Types } from 'mongoose';
import { ExtensionWalletTransactionSchema, type IExtensionWalletTransaction } from '../../schemas/extension_wallet_transaction.schema.js';
import { UserExtensionInventorySchema, type IUserExtensionInventoryItem } from '../../schemas/user_extension_inventory.schema.js';
import { dimafxQueueHandler } from '../../handlers/dimafx_queue.handler.js';
import { makeGoodDimafx, saveDimafxPurchaseOnce } from './dimafx-fulfillment.service.js';
import type { IChannelExtensionItem } from '../../schemas/channel_extension_item.schema.js';
import type { IMediaAsset } from '../../schemas/media_asset.schema.js';

export interface SpendIntent {
  channelID: string; userID: string; item: IChannelExtensionItem; asset: IMediaAsset | null;
  action: 'save' | 'use_now'; viewerText?: string; moderation?: DimafxTextDecision; savedItem?: IUserExtensionInventoryItem;
}
export type SpendResult = { status: number; data?: Record<string, unknown>; message?: string };

/** Journal first; wallet debit and debit receipt are one atomic document update. */
export async function createDimafxSpend(input: SpendIntent): Promise<SpendResult> {
  if (dimafxItemUsesViewerInput(input.item)) {
    input.moderation = await moderateDimafxViewerText({ channelID: input.channelID, userID: input.userID, text: input.viewerText || '' });
    if (!input.moderation.allowed) return { status: 200, data: { blocked: true, reason: input.moderation.verdict } };
  }
  const ledger = await ExtensionWalletTransactionSchema.create({
    platform: 'twitch', userID: input.userID, channelID: input.channelID,
    type: input.savedItem ? 'redeem_saved' : 'credit_purchase',
    amountBits: input.savedItem?.purchasePriceBits ?? input.item.bitsPrice,
    balanceDelta: input.savedItem ? 0 : -input.item.bitsPrice,
    channelExtensionItemID: input.item._id,
    metadata: { fulfillment: 'pending', intent: input, ...(input.moderation ? { moderation: input.moderation } : {}) },
  });
  return recoverDimafxSpend(ledger.toObject());
}

async function restoreCopyOnce(ledger: IExtensionWalletTransaction, row: IUserExtensionInventoryItem): Promise<void> {
  const identity = { platform: 'twitch', channelID: ledger.channelID, userID: ledger.userID };
  const receipt = `refund:spend-${ledger._id}`;
  const match = { channelExtensionItemID: new Types.ObjectId(String(row.channelExtensionItemID)), purchasePriceBits: row.purchasePriceBits, source: row.source, acquiredAt: new Date(row.acquiredAt) };
  const result = await UserExtensionInventorySchema.updateOne({ ...identity, dimafxReceipts: { $ne: receipt }, items: { $elemMatch: match } },
    { $inc: { 'items.$.quantity': 1 }, $addToSet: { dimafxReceipts: receipt } });
  if (result.matchedCount) return;
  await UserExtensionInventorySchema.updateOne({ ...identity, dimafxReceipts: { $ne: receipt } },
    { $push: { items: { ...row, quantity: 1 } }, $addToSet: { dimafxReceipts: receipt } });
  if (!await UserExtensionInventorySchema.exists({ ...identity, dimafxReceipts: receipt })) throw new Error('DimaFX saved-copy restoration pending');
}

export async function recoverDimafxSpend(ledger: IExtensionWalletTransaction): Promise<SpendResult> {
  const input = ledger.metadata.intent as SpendIntent;
  if (!input || !ledger.userID) throw new Error('DimaFX spend intent missing');
  const identity = { platform: 'twitch', channelID: ledger.channelID, userID: ledger.userID };
  const triggerID = `spend-${ledger._id}`;
  const inventory = () => UserExtensionInventorySchema.findOne(identity).lean();
  const finish = (state: string) => ExtensionWalletTransactionSchema.updateOne({ _id: ledger._id }, { $set: { 'metadata.fulfillment': state } });
  if (['fulfilled', 'refunded', 'rejected'].includes(String(ledger.metadata.fulfillment))) {
    return { status: ledger.metadata.fulfillment === 'rejected' ? 402 : 200, data: { inventory: await inventory(), duplicate: true } };
  }
  const claimed = await ExtensionWalletTransactionSchema.updateOne({ _id: ledger._id, $or: [
    { 'metadata.fulfillment': 'pending' },
    { 'metadata.fulfillment': { $in: ['processing', 'refund_pending'] }, updatedAt: { $lt: new Date(Date.now() - 30_000) } },
  ] }, { $set: { 'metadata.fulfillment': ledger.metadata.fulfillment === 'refund_pending' ? 'refund_pending' : 'processing' } });
  if (!claimed.modifiedCount) return { status: 503, message: 'DimaFX spend recovery pending' };

  const debitReceipt = `debit:${ledger._id}`;
  const existing = await dimafxQueueHandler.existing(ledger.channelID, triggerID);
  if (existing?.ok) { await finish('fulfilled'); return { status: 200, data: { ...existing, queued: true, inventory: await inventory() } }; }

  let debited = Boolean(await UserExtensionInventorySchema.exists({ ...identity, dimafxReceipts: debitReceipt }));
  if (!debited) {
    const row = input.savedItem;
    const result = await UserExtensionInventorySchema.updateOne({ ...identity, dimafxReceipts: { $ne: debitReceipt },
      ...(row ? { items: { $elemMatch: {
        channelExtensionItemID: new Types.ObjectId(String(row.channelExtensionItemID)), purchasePriceBits: row.purchasePriceBits,
        source: row.source, acquiredAt: new Date(row.acquiredAt), quantity: { $gt: 0 },
      } } } : { balance: { $gte: ledger.amountBits } }),
    }, { $inc: row ? { 'items.$.quantity': -1 } : { balance: -ledger.amountBits }, $addToSet: { dimafxReceipts: debitReceipt } });
    debited = Boolean(result.matchedCount) || Boolean(await UserExtensionInventorySchema.exists({ ...identity, dimafxReceipts: debitReceipt }));
    if (!debited) { await finish('rejected'); return { status: 402, message: row ? 'No saved copies available' : 'Not enough DimaFX credits' }; }
  }

  // A durable terminal refund decision always wins over attempting a new queue admission.
  const compensate = async (): Promise<SpendResult> => {
    await finish('refund_pending');
    if (input.savedItem) await restoreCopyOnce(ledger, input.savedItem);
    else await makeGoodDimafx(ledger.channelID, ledger.userID!, ledger.amountBits, `refund:${triggerID}`, String(input.item._id));
    await finish('refunded');
    return { status: 200, data: { inventory: await inventory(), ...(input.savedItem ? { restored: true } : { madeGood: { credits: ledger.amountBits } }) } };
  };
  if (ledger.metadata.fulfillment === 'refund_pending') return compensate();
  if (input.action === 'save') {
    const saved = await saveDimafxPurchaseOnce(ledger.channelID, ledger.userID, String(input.item._id), ledger.amountBits, String(ledger._id), 'credit_purchase');
    await finish('fulfilled'); return { status: 200, data: { inventory: saved } };
  }
  // Throws after persistence are AMBIGUOUS. Leave the debit/intent pending; a
  // restart/retry checks the stable job/reservation before attempting compensation.
  const queued = await dimafxQueueHandler.enqueue({ channelID: ledger.channelID, triggerID, item: input.item, asset: input.asset,
    viewerText: input.viewerText, viewerUserID: input.userID, moderation: input.moderation, source: input.savedItem ? 'redeem_saved' : 'credit_purchase',
    refundOnFailure: { userID: ledger.userID, priceBits: ledger.amountBits },
    widget: { bits: null, credits: input.savedItem ? null : ledger.amountBits, buyerId: ledger.userID, message: input.viewerText ?? null },
  });
  if (!queued.ok) return compensate();
  await finish('fulfilled');
  return { status: 200, data: { ...queued, queued: true, inventory: await inventory() } };
}
