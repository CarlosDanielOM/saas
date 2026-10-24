import { Schema, model } from 'mongoose';
import EventsubSchema from '../schemas/eventsub.schema.js';
import { getMongoDBConnection } from '../utils/databases/mongodb.database.js';
import { CANONICAL_BITS_EVENT_TYPE, LEGACY_BITS_EVENT_TYPES } from '../utils/eventsub.js';
import { BitsRuleError, rulesFromLegacyTiers, type BitsRule } from './model.js';

interface StoredBitsRules { _id: string; revision: number; rules: BitsRule[]; updatedAt: Date; updatedBy?: string }
const schema = new Schema<StoredBitsRules>({ _id: String, revision: Number, rules: [Schema.Types.Mixed], updatedAt: Date, updatedBy: String },
  { versionKey: false, collection: 'bits_rules' });
export const BitsRulesModel = model<StoredBitsRules>('BitsRules', schema);

export interface BitsRulesState { revision: number; rules: BitsRule[] }

/** The Cheers chat event config; the bits event type changed names over time. */
export async function findBitsEventsub(channel: string) {
  await getMongoDBConnection('bits-rules');
  return await EventsubSchema.findOne({ channelID: channel, type: CANONICAL_BITS_EVENT_TYPE }).lean()
    || await EventsubSchema.findOne({ channelID: channel, type: { $in: [...LEGACY_BITS_EVENT_TYPES] } }).lean();
}

/**
 * Channels that never saved shared rules still read the tiers from the old chat-events editor,
 * so nothing changes for them until their first edit copies those tiers here.
 */
export async function loadBitsRules(channel: string, legacyTiers?: unknown): Promise<BitsRulesState> {
  await getMongoDBConnection('bits-rules');
  const stored = await BitsRulesModel.findById(channel).lean();
  if (stored) return { revision: stored.revision, rules: stored.rules ?? [] };
  const tiers = legacyTiers !== undefined ? legacyTiers : (await findBitsEventsub(channel))?.cheerTiers;
  return { revision: 0, rules: rulesFromLegacyTiers(tiers) };
}

/** Applies one change with compare-and-swap; retries when the other page saved at the same moment. */
export async function changeBitsRules(channel: string, updatedBy: string, change: (rules: BitsRule[]) => BitsRule[]): Promise<BitsRulesState> {
  await getMongoDBConnection('bits-rules');
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await loadBitsRules(channel);
    const rules = change(structuredClone(current.rules));
    if (current.revision === 0) {
      try {
        await BitsRulesModel.create({ _id: channel, revision: 1, rules, updatedAt: new Date(), updatedBy });
        return { revision: 1, rules };
      } catch (error) {
        if ((error as { code?: number }).code === 11000) continue;
        throw error;
      }
    }
    const result = await BitsRulesModel.updateOne({ _id: channel, revision: current.revision },
      { $set: { rules, updatedAt: new Date(), updatedBy }, $inc: { revision: 1 } });
    if (result.modifiedCount) return { revision: current.revision + 1, rules };
  }
  throw new BitsRuleError('Your Bits rules were changed somewhere else at the same time. Try again.', 409);
}
