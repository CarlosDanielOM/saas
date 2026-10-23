import type { PetPeer } from './peers.js';
interface View { requestId: string; operation: 'talk' | 'ask' | 'tts'; status: string; version: number; text?: string; errorCode?: string }
interface Snapshot { generation: number; active: View | null }
function retire(peer: PetPeer, id: string) {
    peer.retiredRequestIds ??= new Set(); peer.retiredRequestIds.add(id);
    if (peer.retiredRequestIds.size > 8) peer.retiredRequestIds.delete(peer.retiredRequestIds.values().next().value!);
}
export function beginPetSnapshot(peer: PetPeer) { return peer.snapshotSerial = (peer.snapshotSerial ?? 0) + 1; }
/** No awaits between fence validation and emission: an older assembled view cannot overtake ready/play. */
export function emitPetSnapshot(peer: PetPeer, serial: number, snapshot: Snapshot, terminal?: { generation: number; request: View }) {
    if (!peer.socket.connected || serial !== peer.snapshotSerial || snapshot.generation < (peer.generationSeen ?? 0) ||
        snapshot.active && (peer.retiredRequestIds?.has(snapshot.active.requestId) ||
            snapshot.generation === peer.generationSeen && snapshot.active.requestId === peer.activeSeen && snapshot.active.version < (peer.activeVersionSeen ?? 0))) return false;
    const changedGeneration = peer.generationSeen !== undefined && snapshot.generation !== peer.generationSeen;
    const changedRequest = peer.activeSeen && peer.activeSeen !== snapshot.active?.requestId;
    if (terminal) {
        peer.socket.emit('pet:request', { v: 1, ...terminal });
        if (['completed', 'cancelled', 'failed', 'expired'].includes(terminal.request.status)) retire(peer, terminal.request.requestId);
    }
    if (changedGeneration || changedRequest) peer.socket.emit('pet:stop', { v: 1, requestId: peer.activeSeen ?? '',
        generation: snapshot.generation, reason: changedGeneration ? 'state_changed' : 'request_finished' });
    peer.generationSeen = snapshot.generation; peer.activeSeen = snapshot.active?.requestId; peer.activeVersionSeen = snapshot.active?.version;
    peer.socket.emit('pet:snapshot', snapshot);
    if (snapshot.active) peer.socket.emit('pet:request', { v: 1, generation: snapshot.generation, request: snapshot.active });
    return true;
}
export function emitPetReadyAndPlay(peer: PetPeer, generation: number, request: View, play: unknown, beforeEmit?: () => boolean) {
    if (!peer.socket.connected || generation < (peer.generationSeen ?? 0) || peer.retiredRequestIds?.has(request.requestId) ||
        generation === peer.generationSeen && request.requestId === peer.activeSeen && (peer.activeVersionSeen ?? 0) > request.version) return false;
    if (beforeEmit?.() === false) return false;
    beginPetSnapshot(peer); // Invalidate every snapshot assembled before this delivery.
    peer.generationSeen = generation; peer.activeSeen = request.requestId; peer.activeVersionSeen = request.version;
    // Socket.IO preserves packet order on this connection. Rust requires this ready view before play.
    peer.socket.emit('pet:request', { v: 1, generation, request });
    peer.socket.emit('pet:play', play);
    return true;
}
