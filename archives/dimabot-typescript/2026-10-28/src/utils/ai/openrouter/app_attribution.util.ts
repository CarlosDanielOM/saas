// Match the app identity used by Muse's OpenRouter calls.
export const OPENROUTER_APP_HEADERS = {
    'HTTP-Referer': 'https://domdimabot.com',
    'X-OpenRouter-Title': 'DomDimaBot',
    'X-OpenRouter-Description': 'DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.',
    'X-OpenRouter-Categories': 'general-chat, roleplay',
} as const;
