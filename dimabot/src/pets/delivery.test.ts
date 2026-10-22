import assert from 'node:assert/strict';
import test from 'node:test';
import type { PetPeer } from './peers.js';
import { beginPetSnapshot, emitPetSnapshot, emitPetReadyAndPlay } from './delivery.js';

function client() {
    let active: { requestId: string; status: string } | null = null;
    let plays = 0;
    const events: string[] = [];
    const peer = { socket: { connected: true, emit: (event: string, data: any) => {
        events.push(event);
        if (event === 'pet:snapshot') active = data.active;
        if (event === 'pet:request') active = data.request;
        // Same prerequisite as the actual Rust server_pet handler, which drops a lone early play.
        if (event === 'pet:play' && active?.requestId === data.requestId && active?.status === 'ready') plays++;
    } } } as unknown as PetPeer;
    return { peer, events, plays: () => plays, active: () => active };
}
const ready = { requestId: 'request-a', operation: 'talk' as const, status: 'ready', version: 4 };

test('selected socket receives ready before the sole play; delayed older broadcast cannot regress it', () => {
    const c = client();
    const delayed = beginPetSnapshot(c.peer);
    const assembled = { generation: 3, active: { ...ready, status: 'synthesizing', version: 3 } };
    assert.equal(emitPetReadyAndPlay(c.peer, 3, ready, { requestId: ready.requestId }), true);
    assert.deepEqual(c.events, ['pet:request', 'pet:play']);
    assert.equal(c.plays(), 1, 'the Rust ready prerequisite accepts the play');
    assert.equal(emitPetSnapshot(c.peer, delayed, assembled), false);
    assert.equal(c.active()?.status, 'ready');
});

test('request versions and retired identities prevent ready regression and terminal resurrection', () => {
    const c = client();
    emitPetReadyAndPlay(c.peer, 3, ready, { requestId: ready.requestId });
    assert.equal(emitPetSnapshot(c.peer, beginPetSnapshot(c.peer), { generation: 3, active: { ...ready, version: 2, status: 'synthesizing' } }), false);
    assert.equal(emitPetSnapshot(c.peer, beginPetSnapshot(c.peer), { generation: 3, active: null }, { generation: 3, request: { ...ready, status: 'completed', version: 6 } }), true);
    assert.equal(emitPetSnapshot(c.peer, beginPetSnapshot(c.peer), { generation: 3, active: ready }), false);
    assert.equal(c.active(), null);
    assert.equal(c.plays(), 1);
});
