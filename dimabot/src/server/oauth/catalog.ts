/** Dima permissions are independent of Twitch scopes and channel-admin permissions. Each belongs to one
 *  audience (`resource`, RFC 8707): a grant never mixes desktop and MCP scopes. */
export const OAUTH_SCOPES = {
    'profile:read': { active: true, key: 'profile', resource: 'desktop' },
    'credits:read': { active: true, key: 'credits', resource: 'desktop' },
    'desktop:connect': { active: true, key: 'connect', resource: 'desktop' },
    'ai:interact': { active: true, key: 'aiInteract', resource: 'desktop' },
    'usage:read': { active: false, key: 'usage', resource: 'desktop' },
    'pet:read': { active: true, key: 'petRead', resource: 'desktop' },
    'pet:write': { active: false, key: 'petWrite', resource: 'desktop' },
    'pet:receive': { active: true, key: 'petReceive', resource: 'desktop' },
    'pet:interact': { active: true, key: 'petInteract', resource: 'desktop' },
    'pet:control': { active: true, key: 'petControl', resource: 'desktop' },
    'pet:playback:select': { active: true, key: 'petSelect', resource: 'desktop' },
    'channel:read': { active: true, key: 'channelRead', resource: 'mcp' },
    'channel:write': { active: true, key: 'channelWrite', resource: 'mcp' },
    'stream:act': { active: false, key: 'streamAct', resource: 'mcp' }
} as const;

export type OAuthScope = keyof typeof OAUTH_SCOPES;
export const ACCESS_TTL_SECONDS = 600;
export const REQUEST_TTL_SECONDS = 600;
export const CODE_TTL_SECONDS = 60;
export const REFRESH_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
export const DESKTOP_CLIENT_ID = 'dima-desktop';
export const MCP_TOOL_SCOPES = { read: 'channel:read', write: 'channel:write', stream: 'stream:act' } as const;

/** Audience URIs, read lazily from the environment. Desktop tokens work only on `/v1`, MCP tokens only on the MCP server. */
export const OAUTH_RESOURCES: { readonly desktop: string; readonly mcp: string } = {
    get desktop() { return `${new URL(process.env.PUBLIC_API_URL || 'https://api.domdimabot.com').origin}/v1`; },
    get mcp() { return process.env.MCP_PUBLIC_URL || 'https://mcp.domdimabot.com/mcp'; }
};
/** True when a Host header names the MCP host: such requests are served only by the MCP router, never by
 *  Socket.IO, the desktop WebSocket or the rest of the API. */
export function isMcpHost(host: unknown): boolean {
    if (typeof host !== 'string' || !host) return false;
    try { return new URL(`http://${host}`).hostname === new URL(OAUTH_RESOURCES.mcp).hostname; } catch { return false; }
}
/** The audience URI a catalog scope belongs to; undefined for unknown scopes. */
export function scopeResource(scope: string): string | undefined {
    return Object.hasOwn(OAUTH_SCOPES, scope) ? OAUTH_RESOURCES[OAUTH_SCOPES[scope as OAuthScope].resource] : undefined;
}

export class OAuthError extends Error {
    /** `scope` lists the scopes an `insufficient_scope` request lacked, for the Bearer challenge. */
    constructor(public readonly code: string, public readonly status = 400, public readonly scope?: readonly string[]) { super(code); }
}

export function parseScopes(value: unknown): OAuthScope[] {
    if (typeof value !== 'string' || value.length > 500) throw new OAuthError('invalid_scope');
    const values = value.split(' ');
    if (!values.length || values.some(scope => !Object.hasOwn(OAUTH_SCOPES, scope) ||
        !OAUTH_SCOPES[scope as OAuthScope].active)) throw new OAuthError('invalid_scope');
    return [...new Set(values)] as OAuthScope[];
}

/** RFC 8252 §7.3: a registered loopback callback matches with any port and its exact host and path;
 *  https callbacks match exactly. `localhost` is accepted only when the client's policy allows it (CIMD). */
export function validateRedirect(value: unknown, registered: readonly string[], policy: { localhost?: boolean } = {}): string {
    if (typeof value !== 'string' || value.length > 2000) throw new OAuthError('invalid_request');
    const parse = (item: string) => { try { return new URL(item); } catch { return null; } };
    const url = parse(value);
    if (url?.protocol === 'https:' && !url.username && !url.password && !url.hash && registered.includes(value)) return value;
    const hosts = policy.localhost ? ['127.0.0.1', '[::1]', 'localhost'] : ['127.0.0.1', '[::1]'];
    if (!url || url.protocol !== 'http:' || !hosts.includes(url.hostname) ||
        !url.port || Number(url.port) < 1 || url.username || url.password || url.search || url.hash ||
        !registered.some(item => {
            const entry = parse(item);
            return entry?.protocol === 'http:' && entry.hostname === url.hostname && entry.pathname === url.pathname &&
                !entry.username && !entry.password && !entry.search && !entry.hash;
        }) || value !== url.href) throw new OAuthError('invalid_request');
    return value;
}

/** RFC 6750 §3 challenge; `resourceMetadata` adds the RFC 9728 `resource_metadata` URL (`dima` and MCP realms only).
 * Values keep only the characters RFC 6750 allows in these quoted strings, so nothing needs escaping. */
export function bearerChallenge(realm: string, error?: string, scope: readonly string[] = [], resourceMetadata?: string): string {
    const quote = (value: string) => `"${value.replace(/[^\x20\x21\x23-\x5B\x5D-\x7E]/g, '')}"`;
    const scopes = scope.filter(item => /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(item));
    return `Bearer ${[`realm=${quote(realm)}`, ...(error ? [`error=${quote(error)}`] : []),
        ...(scopes.length ? [`scope=${quote(scopes.join(' '))}`] : []),
        ...(resourceMetadata ? [`resource_metadata=${quote(resourceMetadata)}`] : [])].join(', ')}`;
}
