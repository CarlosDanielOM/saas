/**
 * Pages the assistant may open (SPA navigation in dimasite) and spots the mascot can point at.
 * The browser mirrors this list in `dimasite/src/app/features/assistant/assistant-routes.ts`;
 * `navigation.test.ts` keeps both in sync. A key never contains the channel: the browser always
 * builds `/<current streamer>/...`, so the model can't send anyone to another channel.
 */

export interface NavRoute {
    key: string;
    /** Path segments after `/<streamer>/`. */
    path: string[];
    /** Same permission the page's route guard checks. 'owner' = channel owner only. */
    permission: string;
    /** For the model: what lives on this page. */
    about: string;
}

export const NAV_ROUTES: readonly NavRoute[] = [
    { key: 'dashboard', path: ['dashboard'], permission: 'dashboard:view', about: 'Channel dashboard: bot on/off button, Get started card, live status, activity, AI credits, profile menu.' },
    { key: 'usage', path: ['usage'], permission: 'billing:view', about: 'AI usage: credits spent per feature and history.' },
    { key: 'credits', path: ['credits'], permission: 'billing:view', about: 'Plans, credit packs and gift packs (buy or upgrade).' },
    { key: 'commands', path: ['commands'], permission: 'commands:view', about: 'Custom and built-in chat commands, keywords and timers (repeating messages).' },
    { key: 'modules', path: ['modules'], permission: 'dashboard:view', about: 'Hub listing every module.' },
    { key: 'modules.overlays', path: ['modules', 'overlays'], permission: 'owner', about: 'Overlay Studio: alerts, scenes and custom widgets for OBS.' },
    { key: 'modules.widgets', path: ['modules', 'widgets'], permission: '*', about: 'Widgets hub (duel, Dead by Daylight).' },
    { key: 'modules.widgets.duel', path: ['modules', 'widgets', 'duel'], permission: '*', about: 'Duel widget settings and leaderboard.' },
    { key: 'modules.widgets.dbd', path: ['modules', 'widgets', 'dbd'], permission: '*', about: 'Dead by Daylight widget.' },
    { key: 'modules.roulette', path: ['modules', 'roulette'], permission: '*', about: 'Roulettes: items, spins, winner actions, import.' },
    { key: 'modules.clips', path: ['modules', 'clips'], permission: 'clips:view', about: 'Clip overlay, !clip/!promo/!so.' },
    { key: 'modules.chat-events', path: ['modules', 'chat-events'], permission: 'eventsubs:view', about: 'Chat Events: messages the bot posts for follows, subs, raids, Bits, ads; Bits rules.' },
    { key: 'modules.triggers', path: ['modules', 'triggers'], permission: 'triggers:view', about: 'Triggers: sounds/videos/images played on stream by commands, rewards or events.' },
    { key: 'modules.dimafx', path: ['modules', 'dimafx'], permission: 'dimafx:view', about: 'DimaFX Twitch extension: items viewers buy with Bits.' },
    { key: 'modules.ai-personality', path: ['modules', 'ai-personality'], permission: 'ai:view', about: 'How the chat AI talks: personality, rules, known users.' },
    { key: 'modules.pet', path: ['modules', 'pet'], permission: 'owner', about: 'Pet (Premium/Pro): voiced companion on stream.' },
    { key: 'modules.memories', path: ['modules', 'memories'], permission: 'memories:view', about: 'What the chat AI remembers about the channel and viewers.' },
    { key: 'modules.analytics', path: ['modules', 'analytics'], permission: 'analytics:view', about: 'Analytics hub (Premium/Pro).' },
    { key: 'modules.analytics.timeline', path: ['modules', 'analytics', 'timeline'], permission: 'analytics:view', about: 'Stream timeline: per-stream moments, people, credits.' },
    { key: 'modules.analytics.follows', path: ['modules', 'analytics', 'follows'], permission: 'analytics:view', about: 'Follow Ledger.' },
    { key: 'modules.referrals', path: ['modules', 'referrals'], permission: 'referrals:view', about: 'Referral links and rewards.' },
    { key: 'modules.redemptions', path: ['modules', 'redemptions'], permission: 'rewards:view', about: 'Channel point rewards (Twitch custom rewards).' },
    { key: 'modules.tts', path: ['modules', 'tts'], permission: 'tts:view', about: 'Text to Speech: enable, voices, Speech URL for OBS, filters, queue.' },
    { key: 'modules.follow-defense', path: ['modules', 'follow-defense'], permission: 'moderation:view', about: 'Follow Defense: follow-bot protection modes and thresholds.' },
    { key: 'modules.moderation', path: ['modules', 'moderation'], permission: 'moderation:view', about: 'Chat moderation rules and logs.' },
    { key: 'modules.stream-summaries', path: ['modules', 'stream-summaries'], permission: 'summaries:view', about: 'AI summaries of past streams.' },
    { key: 'modules.clip-recommendations', path: ['modules', 'clip-recommendations'], permission: 'clips:view', about: 'AI clip moment recommendations from past streams.' },
    { key: 'modules.library', path: ['modules', 'library'], permission: 'triggers:view', about: 'Media library (uploaded sounds, images, videos).' },
    { key: 'settings', path: ['settings'], permission: 'admins:view', about: 'Channel settings: admins/editors and their permissions.' },
    { key: 'admin-hub', path: ['admin-hub'], permission: 'dashboard:view', about: 'Channels you manage.' },
    { key: 'profile', path: ['profile'], permission: 'settings:view', about: 'Account profile: language, email, notifications, delete account.' },
];

export interface NavAnchor {
    key: string;
    route: string;
    /** For the model. */
    about: string;
}

/**
 * Spots on a page the mascot can fly to. Each one matches an element with
 * `data-assistant-anchor="<key>"` in dimasite.
 */
export const NAV_ANCHORS: readonly NavAnchor[] = [
    { key: 'dashboard.bot-toggle', route: 'dashboard', about: 'Bot on/off (add the bot to chat) button.' },
    { key: 'dashboard.credits', route: 'dashboard', about: 'AI credits card.' },
    { key: 'commands.create', route: 'commands', about: 'Button to create a custom command.' },
    { key: 'commands.timers', route: 'commands', about: 'Timers (repeating messages) section.' },
    { key: 'tts.enable', route: 'modules.tts', about: 'Enable channel TTS switch.' },
    { key: 'tts.speech-url', route: 'modules.tts', about: 'Speech URL to add in OBS.' },
    { key: 'tts.voice', route: 'modules.tts', about: 'Default voice picker.' },
    { key: 'follow-defense.mode', route: 'modules.follow-defense', about: 'Protection mode choice.' },
    { key: 'chat-events.list', route: 'modules.chat-events', about: 'List of chat events.' },
    { key: 'ai-personality.profile', route: 'modules.ai-personality', about: 'Personality text of the active profile.' },
    { key: 'settings.admins', route: 'settings', about: 'Admins (editors) list and add button.' },
    { key: 'profile.language', route: 'profile', about: 'Language setting.' },
    { key: 'profile.delete-account', route: 'profile', about: 'Delete account section.' },
    { key: 'credits.packs', route: 'credits', about: 'Credit packs.' },
];

export const NAV_ROUTE_KEYS = new Set(NAV_ROUTES.map((route) => route.key));
export const NAV_ANCHOR_KEYS = new Set(NAV_ANCHORS.map((anchor) => anchor.key));
