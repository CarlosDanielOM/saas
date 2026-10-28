/// Application identity attached to OpenRouter requests.
pub const OPENROUTER_APP_HEADERS: &[(&str, &str)] = &[
    ("HTTP-Referer", "https://domdimabot.com"),
    ("X-OpenRouter-Title", "DomDimaBot"),
    (
        "X-OpenRouter-Description",
        "DomDimaBot is a Twitch chat bot that helps make streams more engaging and fun.",
    ),
    ("X-OpenRouter-Categories", "general-chat, roleplay"),
];
