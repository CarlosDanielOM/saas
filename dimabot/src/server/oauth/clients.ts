import { DESKTOP_CLIENT_ID, OAUTH_SCOPES, type OAuthScope } from './catalog.js';

/** Built-in clients seeded at boot; fields mirror the OAuthClient schema. Each client lists its own scopes:
 *  activating a catalog scope grants it to no client. A listed inactive scope is stored but never issued. */
export interface FirstPartyClient {
    client_id: string; name: string; type: 'public'; redirect_uris: string[]; allowed_scopes: OAuthScope[];
}

export const FIRST_PARTY_CLIENTS: readonly FirstPartyClient[] = [{
    client_id: DESKTOP_CLIENT_ID, name: 'Dima Desktop Beta', type: 'public',
    redirect_uris: ['http://127.0.0.1/oauth/callback', 'http://[::1]/oauth/callback'],
    allowed_scopes: ['profile:read', 'credits:read', 'desktop:connect', 'pet:read', 'pet:receive', 'pet:control',
        'pet:playback:select', 'ai:interact', 'pet:interact']
}];

export function assertClientRegistry(clients: readonly FirstPartyClient[] = FIRST_PARTY_CLIENTS): void {
    const ids = new Set<string>();
    for (const client of clients) {
        if (ids.has(client.client_id)) throw new Error(`Duplicate OAuth client ${client.client_id}`);
        ids.add(client.client_id);
        const unknown = client.allowed_scopes.filter(scope => !Object.hasOwn(OAUTH_SCOPES, scope));
        if (unknown.length) throw new Error(`OAuth client ${client.client_id} lists unknown scopes: ${unknown.join(', ')}`);
    }
}
