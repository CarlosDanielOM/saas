/**
 * Masks credentials and e-mail addresses inside free text before it is kept in an owner-only record
 * (the activity log, the assistant's turn log, a failed docs question) or shown from a bot log line.
 * The text comes from chat lines, reward inputs, tool results and error messages: whatever the source,
 * a debug record is no place for a token, an API key or somebody's address.
 *
 * Two things matter equally: a real secret must not survive, and ordinary chat must stay readable,
 * because the record exists to debug what a command or the bot said. So each pattern is anchored on
 * something that marks a secret (a name, a prefix, a shape), keeps the words around it, and leaves
 * template syntax such as `$(channel)` alone. It is a best effort, not a guarantee: a secret with no
 * recognisable name, prefix or shape cannot be told from any other word.
 *
 * Every pattern is linear on hostile input: quantifiers in front of a required delimiter are bounded.
 */
const TOKEN = 'A-Za-z0-9._~+/=-';

const SCRUBS: ReadonlyArray<readonly [RegExp, string]> = [
    // Whole header values: "Authorization: Basic …", "Cookie: sessionid=…; other=…".
    [/\b(authorization|proxy-authorization|cookie|set-cookie)(["']?\s*[:=]\s*)("[^"\r\n]{1,2000}"|'[^'\r\n]{1,2000}'|[^\r\n"'}]{1,2000})/gi, '$1$2[redacted]'],
    // "Bearer <token>" / "OAuth <token>". Twenty characters or more: "Bearer Champion42 wins" is chat, not a token.
    [new RegExp(`\\b(bearer|oauth)\\s+[${TOKEN}]{20,}`, 'gi'), '$1 [redacted]'],
    [/\boauth:[A-Za-z0-9]{8,}/gi, 'oauth:[redacted]'],
    // user:password@ inside a URL (database and proxy connection strings in error messages).
    [/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/:@]{1,200}:[^\s/@]{1,200}@/gi, '$1[redacted]@'],
    // Webhook URLs carry their secret in the path.
    [/(discord(?:app)?\.com\/api\/webhooks\/\d{1,30}\/)[A-Za-z0-9._-]{1,200}/gi, '$1[redacted]'],
    [/(hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]{1,200}/gi, '$1[redacted]'],
    // name=value and "name": "value" where the name says it is a secret, in any spelling (client_secret, clientSecret).
    // A password is masked whatever it looks like, up to the end of a quoted value even when it has spaces.
    [/\b(password|passwd|pwd|client[_-]?secret|secret)(["']?\s*[:=]\s*)("[^"\r\n]{1,500}"|'[^'\r\n]{1,500}'|[^\s&"',;)}\]]{1,500})/gi, '$1$2[redacted]'],
    // A token needs eight token-like characters: "token=1234" is a counter, and "?key=$(channel)" is a template.
    [new RegExp(`\\b(access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|private[_-]?key|token|signature)(["']?\\s*[:=]\\s*["']?)[${TOKEN}]{8,}`, 'gi'), '$1$2[redacted]'],
    // Short query-string names that carry a key only inside a URL (?key=…, &sig=…).
    [new RegExp(`([?&](?:key|auth|sig|code)=)[%${TOKEN}]{8,}`, 'gi'), '$1[redacted]'],
    // Shapes that are secrets with no name in front of them: JWTs and provider key prefixes.
    // The JWT lookbehind (not \b) matters: "-" is a token character, so \b would let a match start again inside a
    // long dashed token and rescan the rest of the string each time it fails to find the dots.
    [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted token]'],
    // A key prefix has nothing required after its run, so it cannot rescan: it may start after any separator,
    // a dash or an underscore included ("-sk-proj-…", "KEY_sk-…").
    [/(?<![A-Za-z0-9])(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[redacted key]'],
    [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, '[redacted key]'],
    [/(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted key]'],
    // A bare Twitch OAuth token: exactly thirty lower-case letters and digits, both present.
    [/\b(?=[a-z0-9]{0,29}\d)(?=[a-z0-9]{0,29}[a-z])[a-z0-9]{30}\b/g, '[redacted token]'],
    [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g, '[email]']
];

export function scrubSensitive(text: string): string {
    if (!text) return text;
    let out = text;
    for (const [pattern, replacement] of SCRUBS) out = out.replace(pattern, replacement);
    return out;
}

const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|private[_-]?key|token|signature|session(?:[_-]?id)?|e-?mail)$/i;

/** True for an object key whose value is a secret or a contact detail by its name alone, in any spelling. */
export function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEY.test(key);
}

/**
 * Scrubs text that may be JSON (a tool result, a logged payload): when it parses, values under secret
 * key names are masked whatever they look like and every other string is scrubbed, then it is written
 * back compactly; otherwise it is scrubbed as plain text. Depth and size are bounded.
 */
export function scrubMaybeJson(text: string): string {
    if (!text) return text;
    const trimmed = text.trim();
    if (trimmed.length <= 200_000 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
        try {
            return JSON.stringify(scrubValue(JSON.parse(trimmed), 0));
        } catch {
            // Not JSON after all (or clipped mid-way): treat it as text.
        }
    }
    return scrubSensitive(text);
}

function scrubValue(value: unknown, depth: number): unknown {
    if (typeof value === 'string') return scrubSensitive(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 12) return '[nested]';
    if (Array.isArray(value)) return value.slice(0, 500).map(item => scrubValue(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = isSensitiveKey(key) && item !== null && item !== '' ? '[redacted]' : scrubValue(item, depth + 1);
    }
    return out;
}
