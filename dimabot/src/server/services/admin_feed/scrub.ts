import { isSensitiveKey, scrubSensitive } from '../../../utils/scrub_text.js';

/**
 * Makes a Twitch payload safe to show: drops keys that name a credential, a contact detail, a signature
 * or one of our own internal ids, masks secrets and addresses inside every string value (wherever they
 * sit in the text), and bounds the size (depth, keys, items, string length and total characters). The
 * result is always a plain JSON value.
 */
// Substrings, so any spelling and any prefix is caught (accessToken, user_email, x_client_secret); plus
// ids that link a row to billing or to the operator, which a payload never needs to show.
const DENY_KEY = /token|secret|password|passwd|signature|e_?mail|authorization|auth_?code|api_?key|cookie|session|credential|private_?key|provider_?request_?id|customer_?id|reviewer_?id/i;
// A bare value that is one long opaque string (no name or known prefix for the text scrubber to go by).
const LONG_OPAQUE = /^(?=.*\d)(?=.*[a-z])[A-Za-z0-9+/_=-]{40,}$/;

export const REDACTED = '[removed]';

export interface ScrubLimits { depth: number; keys: number; items: number; string: number; total: number }
const DEFAULT_LIMITS: ScrubLimits = { depth: 6, keys: 60, items: 50, string: 1000, total: 20_000 };

export const isDroppedKey = (key: string): boolean => DENY_KEY.test(key) || isSensitiveKey(key);

export function scrubPayload(input: unknown, limits: Partial<ScrubLimits> = {}): Record<string, unknown> {
    const bound = { ...DEFAULT_LIMITS, ...limits };
    let budget = bound.total;

    const visit = (value: unknown, depth: number): unknown => {
        if (budget <= 0) return undefined;
        if (value === null || typeof value === 'boolean') { budget -= 5; return value; }
        if (typeof value === 'number') { budget -= 10; return Number.isFinite(value) ? value : null; }
        if (typeof value === 'string') {
            if (LONG_OPAQUE.test(value)) { budget -= REDACTED.length; return REDACTED; }
            // Scrubbed before clipping, so a cut can never leave half a secret the patterns no longer recognise.
            const clean = scrubSensitive(value.slice(0, bound.string * 4));
            const text = clean.length > bound.string ? `${Array.from(clean.slice(0, bound.string * 2)).slice(0, bound.string).join('')}…` : clean;
            budget -= text.length + 2;
            return text;
        }
        if (depth >= bound.depth) return undefined;
        if (Array.isArray(value)) {
            const out: unknown[] = [];
            for (const item of value.slice(0, bound.items)) {
                const clean = visit(item, depth + 1);
                if (clean !== undefined) out.push(clean);
                if (budget <= 0) break;
            }
            return out;
        }
        if (typeof value === 'object') {
            const out: Record<string, unknown> = {};
            let kept = 0;
            for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
                if (kept >= bound.keys || budget <= 0) break;
                if (isDroppedKey(key) || key.startsWith('$') || key === '__proto__') continue;
                const clean = visit(item, depth + 1);
                if (clean === undefined) continue;
                out[key] = clean;
                budget -= key.length + 3;
                kept++;
            }
            return out;
        }
        return undefined;
    };

    const result = visit(input, 0);
    return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
}

/**
 * A delivery error as a short reason: no addresses (driver errors can carry connection strings with
 * credentials), no secrets, at most `max` characters.
 */
export function safeErrorText(value: unknown, max = 200): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const text = scrubSensitive(value.slice(0, max * 8))
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]')
        .replace(/\b[\w.-]+@[\w.-]+(:\d+)?\b/g, '[address]')
        .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '[address]')
        .replace(/\b(token|secret|password|key|authorization)\b\s*[=:]\s*\S+/gi, '$1=[removed]')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > max ? `${Array.from(text.slice(0, max * 2)).slice(0, max - 1).join('')}…` : text;
}
