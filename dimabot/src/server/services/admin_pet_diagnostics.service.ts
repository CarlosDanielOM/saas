import { PetSettingsSchema } from '../../schemas/pet_settings.schema.js';
import { PetRuntime, PetRequest } from '../../schemas/pet_runtime.schema.js';
import { OAuthSession } from '../../schemas/oauth_session.schema.js';
import { OAuthGrant } from '../../schemas/oauth_grant.schema.js';
import { OAuthClient } from '../../schemas/oauth_client.schema.js';
import { PetReadiness } from '../../pets/readiness.schema.js';
import { hasSharedVtsReadiness, VTS_READINESS_TTL_MS } from '../../pets/readiness.js';
import { petPeers } from '../../pets/peers.js';
import { OAUTH_SCOPES } from '../oauth/catalog.js';

/** Observation only: never authenticate, refresh readiness, or change the playback runtime. */
export async function getAdminPetDiagnostics(ownerId: string, channelId: string) {
    const now = Date.now();
    const [config, runtime, projection, failures] = await Promise.all([
        PetSettingsSchema.findOne({ userId: ownerId }).select('revision settings.enabled settings.appearance.kind settings.playback').lean(),
        PetRuntime.findById(ownerId).select('generation').lean(),
        PetReadiness.findById(ownerId).select('validatedAt expiresAt').lean(),
        PetRequest.find({ ownerId, channelId, status: { $in: ['failed', 'cancelled', 'expired'] }, errorCode: { $exists: true } })
            .select('_id status errorCode createdAt').sort({ createdAt: -1, _id: -1 }).limit(10).lean()
    ]);
    const playback = config?.settings.playback;
    async function computer(sessionId: string | null | undefined) {
        if (!sessionId) return { selectedSessionId: null, session: null, connected: false, reportedReady: false, ready: false };
        const session = await OAuthSession.findOne({ _id: sessionId, user_id: ownerId })
            .select('device_name scopes last_used_at expires_at idle_expires_at revoked_at grant_id client_id channel_id').lean();
        if (!session) return { selectedSessionId: sessionId, session: null, connected: false, reportedReady: false, ready: false };
        const [grant, client] = await Promise.all([
            OAuthGrant.findOne({ _id: session.grant_id, user_id: ownerId, client_id: session.client_id, channel_id: channelId }).select('revoked_at scopes').lean(),
            OAuthClient.findOne({ client_id: session.client_id }).select('enabled allowed_scopes').lean()
        ]);
        const required = ['desktop:connect', 'pet:read', 'pet:receive'];
        const authorization = session.revoked_at || !grant || grant.revoked_at || session.channel_id !== channelId ? 'revoked' :
            session.expires_at.getTime() <= now || session.idle_expires_at.getTime() <= now ? 'expired' :
            !client?.enabled ? 'client_disabled' :
            !required.every(scope => session.scopes.includes(scope)) || session.scopes.some(scope => !grant.scopes.includes(scope) ||
                !client.allowed_scopes.includes(scope) || !Object.hasOwn(OAUTH_SCOPES, scope) ||
                !OAUTH_SCOPES[scope as keyof typeof OAUTH_SCOPES].active) ? 'insufficient_scope' : 'valid';
        const peers = [...petPeers.values()].filter(peer => peer.ownerId === ownerId && peer.channelId === channelId &&
            peer.kind === 'desktop' && peer.sessionId === sessionId && peer.socket.connected);
        return { selectedSessionId: sessionId, session: { name: session.device_name, authorization,
            lastUsedAt: session.last_used_at, expiresAt: session.expires_at, idleExpiresAt: session.idle_expires_at },
            connected: peers.length > 0, reportedReady: false, ready: false,
            // Internal observations are stripped before returning the public response.
            peers, authorized: authorization === 'valid' };
    }
    const [vtsComputer, audioComputer] = await Promise.all([computer(playback?.vtsSessionId), computer(playback?.desktopSessionId)]);
    const sharedReady = config?.settings.appearance.kind === 'vts' && await hasSharedVtsReadiness(ownerId,
        runtime?.generation, config.revision, playback?.vtsSessionId ?? null);
    const freshPeer = (peer: { validatedAt: number; authorizationExpiresAt: number; scopes: string[] }) =>
        peer.validatedAt > now - VTS_READINESS_TTL_MS && peer.validatedAt <= now && peer.authorizationExpiresAt > now &&
        ['desktop:connect', 'pet:read', 'pet:receive'].every(scope => peer.scopes.includes(scope));
    const strip = (value: typeof vtsComputer, kind: 'audio' | 'vts') => ({
        selectedSessionId: value.selectedSessionId, session: value.session, connected: value.connected,
        reportedReady: value.peers?.some(peer => kind === 'vts' ? peer.vtsReady : peer.audioReady) ?? false,
        ready: !!value.authorized && !!value.peers?.some(peer => freshPeer(peer) && (kind === 'vts' ? peer.vtsReady : peer.audioReady)) &&
            (kind !== 'vts' || !!sharedReady)
    });
    return { observedAt: new Date(now), configured: !!config, enabled: config?.settings.enabled ?? false,
        appearance: config?.settings.appearance.kind ?? null, playbackTarget: playback?.target ?? null,
        vts: { ...strip(vtsComputer, 'vts'), projection: { status: sharedReady ? 'fresh' : projection ? 'stale' : 'missing',
            lastValidatedAt: projection?.validatedAt ?? null, expiresAt: projection?.expiresAt ?? null } },
        audio: strip(audioComputer, 'audio'), failures: failures.map(row => ({ requestId: row._id, status: row.status,
            errorCode: /^[a-z0-9_]{1,80}$/.test(row.errorCode ?? '') ? row.errorCode : 'unknown_error', createdAt: row.createdAt })) };
}
