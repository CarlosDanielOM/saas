import type { IEvent } from '../schemas/event.schema.js';
import { WATCH_STREAK_MESSAGES, MODIVERSARY_MESSAGES } from './chat_notification_defaults.js';

// Built-in discovery keeps this supported event available without a catalog migration.
export const CHAT_NOTIFICATION_EVENT = {
    name: 'Chat Notifications',
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
        EN: 'Celebrate watch streaks and moderator anniversaries shared in chat.',
        ES: 'Celebra las rachas de visualización y los aniversarios de moderación compartidos en el chat.'
    },
    config: [{
        id: 'watchStreakEnabled',
        label: { EN: 'Watch streak announcements', ES: 'Anuncios de rachas de visualización' },
        type: 'checkbox', value: true, canDisable: true
    }, {
        id: 'message',
        label: { EN: 'Streak message', ES: 'Mensaje de la racha' },
        type: 'text',
        value: WATCH_STREAK_MESSAGES.en,
        canDisable: true
    }, {
        id: 'modiversaryEnabled',
        label: { EN: 'Moderator anniversary announcements', ES: 'Anuncios de aniversarios de moderación' },
        type: 'checkbox', value: true, canDisable: true
    }, {
        id: 'modiversaryMessage',
        label: { EN: 'Moderator anniversary message', ES: 'Mensaje de aniversario de moderación' },
        type: 'text', value: MODIVERSARY_MESSAGES.en, canDisable: true
    }]
} satisfies Omit<IEvent, '_id' | 'createdAt' | 'updatedAt' | 'tierLimits'>;

export function withBuiltinChatEvents<T extends { type?: string }>(events: T[]): (T | typeof CHAT_NOTIFICATION_EVENT)[] {
    return events.some(event => event.type === CHAT_NOTIFICATION_EVENT.type)
        ? events
        : [...events, CHAT_NOTIFICATION_EVENT];
}
