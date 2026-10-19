import Eventsub from '../schemas/eventsub.schema.js';
import { RaidSubscriptionPreferenceSchema as Preferences } from '../schemas/raid_subscription_preference.schema.js';
import { raidDirection, type RaidDirection } from './raid_direction.js';
import type { ICondition } from '../schemas/eventsub.schema.js';

export const raidPreferenceID = (channelID: string, direction: RaidDirection) => `${channelID}:${direction}`;
export async function isRaidDeleted(channelID: string, direction: RaidDirection): Promise<boolean> {
    return Boolean(await Preferences.exists({ _id: raidPreferenceID(channelID, direction), deleted: true }));
}
export async function shouldRepairRaid(channelID: string, direction: RaidDirection): Promise<boolean> {
    const preference = await Preferences.findById(raidPreferenceID(channelID, direction)).lean();
    return preference ? preference.deleted !== true : direction === 'incoming';
}
export async function acceptsRaidNotification(subscription: { id?: string; condition?: ICondition }, event: Record<string, unknown>) {
    const direction = raidDirection(subscription.condition);
    const channelID = String(direction === 'outgoing' ? event.from_broadcaster_user_id || '' : event.to_broadcaster_user_id || '');
    if (!channelID || await isRaidDeleted(channelID, direction)) return false;
    const field = direction === 'outgoing' ? 'from_broadcaster_user_id' : 'to_broadcaster_user_id';
    const config = await Eventsub.findOne({ channelID, type: 'channel.raid', [`condition.${field}`]: channelID })
        .select('enabled id').maxTimeMS(1500).lean();
    // Old or duplicated remote subscriptions cannot bypass a direction's current settings.
    return config ? config.enabled !== false && (!subscription.id || config.id === subscription.id)
        : direction === 'incoming' && !subscription.id;
}
