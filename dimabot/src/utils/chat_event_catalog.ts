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

export const SHOUTOUT_RECEIVED_EVENT = {
    name: 'Shoutout Received',
    type: 'channel.shoutout.receive',
    version: '1',
    condition: { broadcaster_user_id: 'user', moderator_user_id: 'moderator' },
    icon: 'MessageCircle',
    color: '#7c3aed',
    textColor: '#ffffff',
    releaseStage: 'stable',
    enabled: false,
    plan_tier: 'free',
    description: {
        EN: 'Thank another streamer when they send your channel a shoutout.',
        ES: 'Agradece a otro streamer cuando le hace un shoutout a tu canal.'
    },
    config: [{
        id: 'message',
        label: { EN: 'Message', ES: 'Mensaje' },
        type: 'text',
        value: '$(shoutout.channel) has sent a shoutout to $(twitch.channel)!',
        canDisable: true
    }]
} satisfies Omit<IEvent, '_id' | 'createdAt' | 'updatedAt' | 'tierLimits'>;

// These subscriptions already feed analytics and chat delivery. Discovery only
// exposes their existing settings; it never enables or rewrites a channel's data.
export const SUBSCRIPTION_CHAT_EVENTS = [
    {
        name: 'New subscriptions',
        type: 'channel.subscribe',
        icon: 'Star',
        description: {
            EN: 'Welcome new subscribers, including viewers who receive a gift subscription.',
            ES: 'Da la bienvenida a nuevos suscriptores, incluidos quienes reciben una suscripción regalada.'
        },
        message: 'Thanks $(user) for subscribing at $(sub.tier)!'
    },
    {
        name: 'Gifted subscriptions',
        type: 'channel.subscription.gift',
        icon: 'Heart',
        description: {
            EN: 'Thank subscription gifts with one message per gift batch, including anonymous gifts.',
            ES: 'Agradece las suscripciones regaladas con un mensaje por lote, incluidos los regalos anónimos.'
        },
        message: 'Thank you for the gifted $(sub.tier) subscriptions!'
    },
    {
        name: 'Resubscription messages',
        type: 'channel.subscription.message',
        icon: 'MessageCircle',
        description: {
            EN: 'Celebrate subscribers who share their resubscription in chat. Automatic renewals do not trigger this message.',
            ES: 'Celebra a quienes comparten su resuscripción en el chat. Las renovaciones automáticas no activan este mensaje.'
        },
        message: 'Thanks $(user) for $(sub.months) months of support at $(sub.tier)!'
    },
    {
        name: 'Subscription endings',
        type: 'channel.subscription.end',
        icon: 'Clock',
        description: {
            EN: 'Post a message when a subscription expires. Leave the message empty to stay silent.',
            ES: 'Publica un mensaje cuando vence una suscripción. Deja el mensaje vacío para no anunciarlo.'
        },
        message: ''
    }
].map(({ message, ...event }) => ({
    ...event,
    version: '1',
    condition: { broadcaster_user_id: 'user' },
    color: '#7c3aed',
    textColor: '#ffffff',
    releaseStage: 'stable',
    enabled: false,
    plan_tier: 'free',
    config: [{
        id: 'message',
        label: { EN: 'Message', ES: 'Mensaje' },
        type: 'text',
        value: message,
        canDisable: true
    }]
} satisfies Omit<IEvent, '_id' | 'createdAt' | 'updatedAt' | 'tierLimits'>));

export const OUTGOING_RAID_CHAT_EVENT = {
    name: 'Outgoing raid', type: 'channel.raid.outgoing', version: '1', condition: { from_broadcaster_user_id: 'user' },
    icon: 'Users', color: '#7c3aed', textColor: '#ffffff', releaseStage: 'stable', enabled: false, plan_tier: 'free',
    description: { EN: 'Track channels you raid for your dashboard. An empty message tracks silently. Disabling or deleting stops outgoing tracking only; recorded history remains.',
        ES: 'Registra los canales a los que haces raid para tu panel. Un mensaje vacío registra en silencio. Desactivar o eliminar solo detiene el registro de salida; el historial se conserva.' },
    config: [{ id: 'message', label: { EN: 'Optional message · $(raid.channel), $(raid.login), $(raid.viewers)',
        ES: 'Mensaje opcional · $(raid.channel), $(raid.login), $(raid.viewers)' }, type: 'text', value: '', canDisable: true }]
} satisfies Omit<IEvent, '_id' | 'createdAt' | 'updatedAt' | 'tierLimits'>;

export const INCOMING_RAID_CHAT_EVENT = {
    ...OUTGOING_RAID_CHAT_EVENT, name: 'Incoming raid', type: 'channel.raid', condition: { to_broadcaster_user_id: 'user' },
    description: { EN: 'Incoming raid protection, announcements, clips and shoutouts. Independent of outgoing tracking.',
        ES: 'Protección ante raids entrantes, anuncios, clips y shoutouts. Independiente del registro de salida.' },
    config: [{ id: 'message', label: { EN: 'Announcement', ES: 'Anuncio' }, type: 'text', value: '$(raid.channel) is raiding with $(raid.viewers) viewers!', canDisable: true },
        { id: 'enableClip', dbId: 'clipEnabled', label: { EN: 'Show a clip', ES: 'Mostrar un clip' }, type: 'checkbox', value: true, canDisable: true },
        { id: 'minViewers', label: { EN: 'Minimum viewers for announcements', ES: 'Espectadores mínimos para anuncios' }, type: 'number', value: 2, canDisable: true }]
} satisfies Omit<IEvent, '_id' | 'createdAt' | 'updatedAt' | 'tierLimits'>;

const BUILTIN_CHAT_EVENTS = [CHAT_NOTIFICATION_EVENT, SHOUTOUT_RECEIVED_EVENT, INCOMING_RAID_CHAT_EVENT, OUTGOING_RAID_CHAT_EVENT, ...SUBSCRIPTION_CHAT_EVENTS] as const;

export function getBuiltinChatEvent(type: string) {
    return BUILTIN_CHAT_EVENTS.find(event => event.type === type);
}

export function withBuiltinChatEvents<T extends { type?: string }>(events: T[]) {
    return [...events, ...BUILTIN_CHAT_EVENTS.filter(builtin => !events.some(event => event.type === builtin.type))];
}
