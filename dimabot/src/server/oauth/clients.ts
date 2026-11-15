import { OAuthClient } from '../../schemas/oauth_client.schema.js';
import { DESKTOP_CLIENT_ID, OAuthError, OAUTH_RESOURCES, OAUTH_SCOPES, type OAuthScope } from './catalog.js';
import { isCimdClientDenied, isCimdClientId, resolveCimdClient } from './cimd.js';

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

/** One normalized shape for first-party (DB registry) and CIMD clients. */
export interface ClientRecord {
    client_id: string; name: string; kind: 'first_party' | 'cimd'; application_type: 'native' | 'web';
    redirect_uris: string[]; allowed_scopes: string[]; resources: string[]; default_resource?: string;
    channel_selection: boolean; recognized: boolean; document_host?: string;
}
/** What live sessions, refresh and revocation need; never fetches a document. */
export type SessionClient = Pick<ClientRecord, 'client_id' | 'kind' | 'allowed_scopes' | 'resources' | 'channel_selection'>;

const loopback = (uri: string) => {
    try { const url = new URL(uri); return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname); }
    catch { return false; }
};
const mcpScopes = () => Object.entries(OAUTH_SCOPES).filter(([, scope]) => scope.active && scope.resource === 'mcp').map(([name]) => name);

async function firstParty(clientID: string): Promise<ClientRecord> {
    const client = await OAuthClient.findOne({ client_id: clientID, enabled: true }).lean();
    if (!client) throw new OAuthError('invalid_client');
    return { client_id: client.client_id, name: client.name || client.client_id, kind: 'first_party',
        application_type: client.redirect_uris.every(loopback) ? 'native' : 'web',
        redirect_uris: client.redirect_uris, allowed_scopes: client.allowed_scopes,
        resources: [OAUTH_RESOURCES.desktop], default_resource: OAUTH_RESOURCES.desktop, channel_selection: false, recognized: true };
}

/** For a CIMD client_id this fetches its metadata document: call it only when an authorization starts.
 *  `options.source`: the requester's rate-limit identities (`clientIps`), charged for a real document fetch. */
export async function resolveClient(clientID: unknown, options: { source?: readonly string[] } = {}): Promise<ClientRecord> {
    if (typeof clientID !== 'string' || clientID.length > 512) throw new OAuthError('invalid_client');
    if (!isCimdClientId(clientID)) return firstParty(clientID);
    const client = await resolveCimdClient(clientID, { source: options.source });
    return { client_id: client.client_id, name: client.client_name, kind: 'cimd',
        application_type: client.redirect_uris.every(loopback) ? 'native' : 'web',
        redirect_uris: client.redirect_uris, allowed_scopes: mcpScopes(), resources: [OAUTH_RESOURCES.mcp],
        channel_selection: true, recognized: client.recognized, document_host: client.document_host };
}

/** Live sessions, refresh and revocation: a CIMD document is never refetched, but the operator denylist applies. */
export async function resolveSessionClient(clientID: unknown): Promise<SessionClient> {
    if (typeof clientID !== 'string' || clientID.length > 512) throw new OAuthError('invalid_client');
    if (!isCimdClientId(clientID)) return firstParty(clientID);
    if (await isCimdClientDenied(clientID)) throw new OAuthError('invalid_client');
    return { client_id: clientID, kind: 'cimd', allowed_scopes: mcpScopes(), resources: [OAUTH_RESOURCES.mcp], channel_selection: true };
}
