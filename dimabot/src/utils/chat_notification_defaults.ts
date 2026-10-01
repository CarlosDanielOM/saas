export const WATCH_STREAK_MESSAGES = {
    en: '$(user) has a streak of $(twitch.streak) days!',
    es: '¡$(user) tiene una racha de $(twitch.streak) días!'
} as const;

export const MODIVERSARY_MESSAGES = {
    en: 'Happy mod anniversary, $(user)! Thank you for $(twitch.modiversary) months of moderating!',
    es: '¡Feliz aniversario de moderación, $(user)! ¡Gracias por tus $(twitch.modiversary) meses como moderador!'
} as const;

export function isSupportedChatNotice(noticeType: unknown): noticeType is 'watch_streak' | 'modiversary' {
    return noticeType === 'watch_streak' || noticeType === 'modiversary';
}

export function resolveChatNotificationMessage(
    noticeType: unknown,
    config: { message?: unknown; watchStreakEnabled?: unknown; modiversaryMessage?: unknown; modiversaryEnabled?: unknown },
    language: 'en' | 'es'
): string {
    if (noticeType === 'watch_streak') {
        return config.watchStreakEnabled === false ? ''
            : resolveWatchStreakMessage(typeof config.message === 'string' ? config.message : '', language);
    }
    if (noticeType !== 'modiversary' || config.modiversaryEnabled === false) return '';
    const message = typeof config.modiversaryMessage === 'string' ? config.modiversaryMessage : '';
    return !message.trim() || message === MODIVERSARY_MESSAGES.en || message === MODIVERSARY_MESSAGES.es
        ? MODIVERSARY_MESSAGES[language] : message;
}

/** Empty configurations and either built-in default follow the channel language. */
export function resolveWatchStreakMessage(message: string, language: 'en' | 'es'): string {
    return !message.trim() || message === WATCH_STREAK_MESSAGES.en || message === WATCH_STREAK_MESSAGES.es
        ? WATCH_STREAK_MESSAGES[language] : message;
}
