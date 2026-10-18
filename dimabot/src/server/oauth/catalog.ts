/** Dima permissions are independent of Twitch scopes and channel-admin permissions. */
export const OAUTH_SCOPES = {
    'profile:read': { active: true, key: 'profile' },
    'credits:read': { active: true, key: 'credits' },
    'desktop:connect': { active: true, key: 'connect' },
    'usage:read': { active: false, key: 'usage' },
    'pet:read': { active: true, key: 'petRead' },
    'pet:write': { active: false, key: 'petWrite' },
    'pet:receive': { active: false, key: 'petReceive' },
    'pet:interact': { active: false, key: 'petInteract' },
    'pet:control': { active: false, key: 'petControl' },
    'pet:playback:select': { active: false, key: 'petSelect' }
} as const;

export type OAuthScope = keyof typeof OAUTH_SCOPES;
export const ACCESS_TTL_SECONDS = 600;
export const REQUEST_TTL_SECONDS = 600;
export const CODE_TTL_SECONDS = 60;
export const REFRESH_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
export const DESKTOP_CLIENT_ID = 'dima-desktop';

export class OAuthError extends Error {
    constructor(public readonly code: string, public readonly status = 400) { super(code); }
}

export function parseScopes(value: unknown): OAuthScope[] {
    if (typeof value !== 'string' || value.length > 500) throw new OAuthError('invalid_scope');
    const values = value.split(' ');
    if (!values.length || values.some(scope => !Object.hasOwn(OAUTH_SCOPES, scope) ||
        !OAUTH_SCOPES[scope as OAuthScope].active)) throw new OAuthError('invalid_scope');
    return [...new Set(values)] as OAuthScope[];
}

/** Only an ephemeral port may differ from a registered loopback callback. */
export function validateRedirect(value: unknown, registered: string[]): string {
    if (typeof value !== 'string' || value.length > 300) throw new OAuthError('invalid_request');
    let url: URL;
    try { url = new URL(value); } catch { throw new OAuthError('invalid_request'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        !url.port || Number(url.port) < 1 || url.username || url.password || url.search || url.hash ||
        !registered.includes(`${url.protocol}//${url.hostname}${url.pathname}`) ||
        value !== url.href) throw new OAuthError('invalid_request');
    return value;
}
