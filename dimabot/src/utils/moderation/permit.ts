import { getDragonflyClient } from '../databases/dragonfly.database.js';

export const PERMIT_MIN_SECONDS = 1;
export const PERMIT_MAX_SECONDS = 600;
export const PERMIT_DEFAULT_SECONDS = 60;

const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/i;
const NUMBER_PATTERN = /^\d+$/;

export interface PermitTarget {
    /** null = channel-wide permit (everyone bypasses) */
    login: string | null;
    seconds: number;
}

export type PermitParseResult = { error: string } | PermitTarget;

function parseSeconds(raw: string): number | null {
    if (!NUMBER_PATTERN.test(raw)) return null;
    const parsed = Number.parseInt(raw, 10);
    if (parsed < PERMIT_MIN_SECONDS || parsed > PERMIT_MAX_SECONDS) return NaN;
    return parsed;
}

export function normalizePermitLogin(raw: string): string {
    return String(raw || '').trim().replace(/^@+/, '').toLowerCase();
}

export const PERMIT_USAGE = `Usage: $(permit [user] [seconds]). No arguments permits everyone for ${PERMIT_DEFAULT_SECONDS}s; a number permits everyone for that many seconds (${PERMIT_MIN_SECONDS}-${PERMIT_MAX_SECONDS}); a username permits only that user.`;

/**
 * Parses permit arguments:
 *   (none)          → everyone, 60s
 *   username        → that user, 60s
 *   120             → everyone, 120s
 *   username 120    → that user, 120s
 * An argument that is purely digits is a duration; anything containing
 * letters/underscore is treated as a username.
 */
export function parsePermitArgs(rawArgs: string[]): PermitParseResult {
    const args = rawArgs.map(arg => String(arg || '').trim()).filter(Boolean);

    if (args.length === 0) {
        return { login: null, seconds: PERMIT_DEFAULT_SECONDS };
    }

    if (args.length > 2) {
        return { error: PERMIT_USAGE };
    }

    const first = args[0];
    const firstSeconds = parseSeconds(first);

    if (args.length === 1) {
        if (firstSeconds !== null && !Number.isNaN(firstSeconds)) {
            return { login: null, seconds: firstSeconds };
        }
        if (firstSeconds !== null && Number.isNaN(firstSeconds)) {
            return { error: `Duration must be between ${PERMIT_MIN_SECONDS} and ${PERMIT_MAX_SECONDS} seconds.` };
        }
        const login = normalizePermitLogin(first);
        if (!LOGIN_PATTERN.test(login)) {
            return { error: PERMIT_USAGE };
        }
        return { login, seconds: PERMIT_DEFAULT_SECONDS };
    }

    // Two arguments: user + duration, in that order.
    const login = normalizePermitLogin(first);
    if (firstSeconds !== null || !LOGIN_PATTERN.test(login)) {
        return { error: PERMIT_USAGE };
    }

    const seconds = parseSeconds(args[1]);
    if (seconds === null || Number.isNaN(seconds)) {
        return { error: `Duration must be a number between ${PERMIT_MIN_SECONDS} and ${PERMIT_MAX_SECONDS} seconds.` };
    }

    return { login, seconds };
}

export function permitUserKey(channelID: string, login: string): string {
    return `moderation:${channelID}:permit:user:${login.toLowerCase()}`;
}

export function permitChannelKey(channelID: string): string {
    return `moderation:${channelID}:permit:channel`;
}

/**
 * Grants a moderation bypass. With a login the permit applies to that user;
 * without one it applies to the whole channel. The TTL IS the permit —
 * expiry removes the bypass automatically.
 */
export async function grantPermit(channelID: string, seconds: number, login?: string | null): Promise<void> {
    const cache = await getDragonflyClient('moderation.grantPermit');
    const key = login ? permitUserKey(channelID, login) : permitChannelKey(channelID);
    await cache.set(key, String(Date.now() + seconds * 1000), { EX: seconds });
}

export async function hasActivePermit(channelID: string, login: string): Promise<boolean> {
    const cache = await getDragonflyClient('moderation.hasActivePermit');
    const [userPermit, channelPermit] = await Promise.all([
        cache.get(permitUserKey(channelID, login)),
        cache.get(permitChannelKey(channelID))
    ]);
    return userPermit !== null || channelPermit !== null;
}
