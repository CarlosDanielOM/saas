import type { ICondition } from '../schemas/eventsub.schema.js';

interface EventsubConditionTemplate {
    type: string;
    condition: ICondition;
}

export function buildExpectedEventsubCondition(
    subscription: EventsubConditionTemplate,
    channelID: string
): ICondition {
    const condition = { ...subscription.condition };
    if (subscription.type === 'channel.raid') {
        condition.to_broadcaster_user_id = channelID;
    } else if (subscription.type === 'user.update') {
        condition.user_id = channelID;
    } else {
        condition.broadcaster_user_id = channelID;
    }
    return condition;
}
