import type { ICondition } from '../schemas/eventsub.schema.js';

export const OUTGOING_RAID_EVENT = 'channel.raid.outgoing';
export type RaidDirection = 'incoming' | 'outgoing';
export function isRaidEvent(type: string): boolean { return type === 'channel.raid' || type === OUTGOING_RAID_EVENT; }
export function raidDirection(condition?: ICondition): RaidDirection {
    return condition?.from_broadcaster_user_id && !condition.to_broadcaster_user_id ? 'outgoing' : 'incoming';
}
export function raidConfigType(type: string, condition?: ICondition): string {
    return type === 'channel.raid' && raidDirection(condition) === 'outgoing' ? OUTGOING_RAID_EVENT : type;
}
export function raidCondition(channelID: string, direction: RaidDirection): ICondition {
    return direction === 'outgoing' ? { from_broadcaster_user_id: channelID } : { to_broadcaster_user_id: channelID };
}
