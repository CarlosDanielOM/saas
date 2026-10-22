import { OAuthSession } from '../schemas/oauth_session.schema.js';
import { getPetConfiguration, savePetConfiguration } from '../server/services/pet_settings.service.js';
import type { AccessIdentity } from '../server/oauth/service.js';
import { commandId, PetError } from './state.js';
import { desktopCandidates } from './peers.js';

export async function selectOwnPetPlayback(identity: AccessIdentity, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PetError('invalid_command');
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !['commandId', 'revision', 'roles'].includes(key)) ||
        !Number.isSafeInteger(body.revision) || Number(body.revision) < 0 || !Array.isArray(body.roles) ||
        body.roles.length < 1 || body.roles.length > 2 || new Set(body.roles).size !== body.roles.length ||
        body.roles.some(role => role !== 'audio' && role !== 'vts')) throw new PetError('invalid_command');
    commandId(body.commandId);
    if (!await OAuthSession.exists({ _id: identity.session_id, user_id: identity.user_id, revoked_at: null }) ||
        !(await desktopCandidates(identity.user_id)).some(session => session.sessionId === identity.session_id)) throw new PetError('session_unavailable', 409);
    const current = await getPetConfiguration(identity.user_id, identity.channel_id);
    const playback = { ...current.settings.playback,
        ...(body.roles.includes('audio') ? { target: 'desktop' as const, desktopSessionId: identity.session_id } : {}),
        ...(body.roles.includes('vts') ? { vtsSessionId: identity.session_id } : {}) };
    // A repeated command after an acknowledged/ambiguous successful save is harmless.
    if (current.revision === Number(body.revision) + 1 && JSON.stringify(playback) === JSON.stringify(current.settings.playback)) return current;
    return savePetConfiguration(identity.user_id, identity.channel_id, { revision: body.revision, settings: { ...current.settings, playback } });
}
