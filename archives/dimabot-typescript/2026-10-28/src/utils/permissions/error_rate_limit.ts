const DEFAULT_PERMISSION_ERROR_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TRACKED_PERMISSION_ERRORS = 2_000;

const lastPermissionErrorAt = new Map<string, number>();

/**
 * Process-local limiter for repeated permission/configuration errors. Keys are
 * bounded so malformed records across many channels cannot grow memory forever.
 */
export function shouldLogPermissionError(
    key: string,
    now: number = Date.now(),
    intervalMs: number = DEFAULT_PERMISSION_ERROR_INTERVAL_MS
): boolean {
    const previous = lastPermissionErrorAt.get(key);
    if (previous !== undefined && now - previous < intervalMs) {
        return false;
    }

    if (!lastPermissionErrorAt.has(key) && lastPermissionErrorAt.size >= MAX_TRACKED_PERMISSION_ERRORS) {
        const oldestKey = lastPermissionErrorAt.keys().next().value as string | undefined;
        if (oldestKey !== undefined) {
            lastPermissionErrorAt.delete(oldestKey);
        }
    }

    // Refresh insertion order so the bounded map evicts the least recently
    // logged key instead of a key that is still producing occasional errors.
    lastPermissionErrorAt.delete(key);
    lastPermissionErrorAt.set(key, now);
    return true;
}
