import type { IEvent } from '../schemas/event.schema.js';
import { WATCH_STREAK_MESSAGES } from './chat_notification_defaults.js';

// Built-in discovery keeps this supported event available without a catalog migration.
export const WATCH_STREAK_EVENT = {
    name: 'Watch Streak',
    type: 'channel.chat.notification',
    version: '1',
    condition: { broadcaster_user_id: 'user', user_id: 'moderator' },
    icon: 'Trophy',
    color: '#7c3aed',
    textColor: '#ffffff',
    releaseStage: 'stable',
    enabled: false,
    plan_tier: 'free',
    description: {
        EN: 'Celebrate viewers who share a watch streak in chat.',
        ES: 'Celebra a quienes comparten una racha de visualización en el chat.'
    },
    config: [{
        id: 'message',
        label: { EN: 'Streak message', ES: 'Mensaje de la racha' },
        type: 'text',
        value: WATCH_STREAK_MESSAGES.en,
        canDisable: true
    }]
} satisfies Omit<IEvent, '_id' | 'createdAt' | 'updatedAt' | 'tierLimits'>;

export function withBuiltinChatEvents<T extends { type?: string }>(events: T[]): (T | typeof WATCH_STREAK_EVENT)[] {
    return events.some(event => event.type === WATCH_STREAK_EVENT.type)
        ? events
        : [...events, WATCH_STREAK_EVENT];
}
