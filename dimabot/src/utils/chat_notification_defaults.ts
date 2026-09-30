export const WATCH_STREAK_MESSAGES = {
    en: '$(user) has a streak of $(twitch.streak) days!',
    es: '¡$(user) tiene una racha de $(twitch.streak) días!'
} as const;

/** Empty configurations and either built-in default follow the channel language. */
export function resolveWatchStreakMessage(message: string, language: 'en' | 'es'): string {
    return !message.trim() || message === WATCH_STREAK_MESSAGES.en || message === WATCH_STREAK_MESSAGES.es
        ? WATCH_STREAK_MESSAGES[language] : message;
}
