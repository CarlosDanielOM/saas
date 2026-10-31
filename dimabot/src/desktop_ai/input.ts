import { createHash } from 'node:crypto';
import { OAuthError } from '../server/oauth/catalog.js';

export interface TurnInput { request_id: string; target: 'bot' | 'pet'; text: string; source: 'asr' | 'typed'; silent: boolean; conversation_id?: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isTurnId(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }
export function parseTurnInput(value: unknown): TurnInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OAuthError('invalid_request');
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some(key => !['request_id', 'target', 'text', 'source', 'silent', 'conversation_id'].includes(key)) ||
        !isTurnId(body.request_id) || typeof body.target !== 'string' || !['bot', 'pet'].includes(body.target) ||
        typeof body.text !== 'string' || !body.text.trim() || body.text.length > 2000 ||
        typeof body.source !== 'string' || !['asr', 'typed'].includes(body.source) || typeof body.silent !== 'boolean' ||
        (body.conversation_id !== undefined && !isTurnId(body.conversation_id))) throw new OAuthError('invalid_request');
    return body as unknown as TurnInput;
}
/** Include omission as distinct from an explicit conversation binding. */
export function turnFingerprint(input: TurnInput): string {
    return createHash('sha256').update(JSON.stringify([input.target, input.text, input.source, input.silent, input.conversation_id ?? null])).digest('hex');
}
/** A hard UTF-16 cap without leaving a dangling leading surrogate. */
export function truncateReply(text: string, max = 280): string {
    const limit = Math.max(1, Math.min(500, Math.trunc(max)));
    const trimmed = text.trim().split(/(?<=[.!?])\s+/u).slice(0, 2).join(' ');
    if (trimmed.length <= limit) return trimmed;
    let result = trimmed.slice(0, limit);
    if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
    const lastBoundary = Math.max(result.lastIndexOf('. '), result.lastIndexOf('! '), result.lastIndexOf('? '));
    if (lastBoundary >= Math.floor(limit / 2)) result = result.slice(0, lastBoundary + 1);
    else { const word = result.lastIndexOf(' '); if (word > limit / 2) result = result.slice(0, word); }
    return result.trim();
}
