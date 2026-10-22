import { OAuthSession } from '../schemas/oauth_session.schema.js';
import type { Socket } from 'socket.io';
import { PetError } from './state.js';
export interface PetPeer {
    validatedAt: number; authorizationExpiresAt: number; snapshotSerial?: number; retiredRequestIds?: Set<string>; activeVersionSeen?: number;
    id: string; ownerId: string; channelId: string; kind: 'desktop' | 'browser'; sessionId?: string;
    label: string; socket: Socket; audioReady: boolean; renderReady: boolean; vtsReady: boolean;
    capability?: string; generationSeen?: number; activeSeen?: string; tokenHash?: string; scopes: string[]; revalidate: () => Promise<void>;
    sequenceRequestId?: string; seq: number; mouthSeq: number; lastMouthAt: number; lastProgressAt: number; busy: boolean;
}
export const petPeers = new Map<string, PetPeer>();
export async function desktopCandidates(ownerId: string) {
    const sessions = new Map<string, { sessionId: string; label: string; audioReady: boolean; vtsReady: boolean }>();
    for (const peer of petPeers.values()) {
        if (peer.ownerId !== ownerId || peer.kind !== 'desktop' || !peer.sessionId || !peer.socket.connected) continue;
        try { await peer.revalidate(); } catch { peer.socket.disconnect(true); continue; }
        if (!peer.scopes.includes('pet:receive')) continue;
        const current = sessions.get(peer.sessionId);
        sessions.set(peer.sessionId, { sessionId: peer.sessionId, label: peer.label, audioReady: peer.audioReady || !!current?.audioReady, vtsReady: peer.vtsReady || !!current?.vtsReady });
    }
    return [...sessions.values()];
}
export async function validatePetSessions(ownerId: string, playback: { desktopSessionId: string | null; vtsSessionId: string | null }, previous?: typeof playback) {
    const sessions = await desktopCandidates(ownerId);
    for (const id of [playback.desktopSessionId, playback.vtsSessionId]) {
        if (!id) continue;
        if (!await OAuthSession.exists({ _id: id, user_id: ownerId })) throw new PetError('session_unavailable', 409);
        // A saved offline selection may be retained, never substituted with another owner's ID.
        if (previous && (id === previous.desktopSessionId || id === previous.vtsSessionId)) continue;
        if (!sessions.some(session => session.sessionId === id)) throw new PetError('session_unavailable', 409);
    }
}

/** One deterministic, freshly authorized VTS controller; duplicate sockets never fan out. */
export async function selectedVtsController(ownerId: string, sessionId: string | null) {
    if (!sessionId) return null;
    const candidates = [...petPeers.values()].filter(peer => peer.kind === 'desktop' && peer.ownerId === ownerId &&
        peer.sessionId === sessionId && peer.vtsReady && peer.socket.connected && peer.scopes.includes('pet:receive'))
        .sort((a, b) => a.id.localeCompare(b.id));
    for (const peer of candidates) {
        try { await peer.revalidate(); if (peer.socket.connected && peer.vtsReady) return peer; } catch { peer.socket.disconnect(true); }
    }
    return null;
}
