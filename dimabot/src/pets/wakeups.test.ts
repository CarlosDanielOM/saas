import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { RedisClientOptions } from 'redis';
import { PetWakeupPublisher, PET_WAKE, subscribePetWakeups } from './wakeups.js';
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
class Client extends EventEmitter {
    destroys = 0;
    publications: Array<[string, string]> = [];
    connecting: () => Promise<unknown> = async () => undefined;
    publishing: () => Promise<unknown> = async () => undefined;
    connect() { return this.connecting(); }
    publish(channel: string, value: string) { this.publications.push([channel, value]); return this.publishing(); }
    subscribe(_channel: string, _callback: (message: string) => void) { return Promise.resolve(); }
    destroy() { this.destroys++; }
}
test('pet admission hints never await stalled connect; timeout destroys and bounds client/owner queues', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const clients: Client[] = [], options: RedisClientOptions[] = [];
    const previous = process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED; delete process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED;
    const publisher = new PetWakeupPublisher(policy => {
        options.push(policy); const client = new Client(); client.connecting = () => new Promise(() => {}); clients.push(client); return client;
    });
    context.after(() => { publisher.stop(); if (previous === undefined) delete process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED; else process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED = previous; });
    for (let i = 0; i < 10_000; i++) assert.equal(publisher.notify(i.toString(16).padStart(24, '0')), undefined);
    assert.equal(clients.length, 0, 'cold network work is outside producer acknowledgement');
    await turn();
    assert.equal(clients.length, 1);
    assert.deepEqual(options[0].socket, { connectTimeout: 500, reconnectStrategy: false });
    assert.equal(options[0].disableOfflineQueue, true);
    assert.equal(options[0].commandsQueueMaxLength, 4);
    context.mock.timers.tick(500);
    assert.equal(clients[0].destroys, 1);
    for (let i = 0; i < 10_000; i++) publisher.notify('000000000000000000000001');
    await turn(); assert.equal(clients.length, 1, 'failed hints do not create a reconnect storm');
});
test('pet publish timeout destroys pending Redis command; bursts coalesce to bounded owner batches', async context => {
    const previous = process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED; delete process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED;
    context.after(() => { if (previous === undefined) delete process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED; else process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED = previous; });
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const client = new Client(); client.publishing = () => new Promise(() => {});
    const publisher = new PetWakeupPublisher(() => client); context.after(() => publisher.stop());
    for (let i = 0; i < 10_000; i++) publisher.notify(i.toString(16).padStart(24, '0'));
    await turn(); await turn();
    assert.equal(client.publications.length, 1);
    assert.equal(client.publications[0][0], PET_WAKE);
    assert.equal(JSON.parse(client.publications[0][1]).length, 64);
    context.mock.timers.tick(500);
    assert.equal(client.destroys, 1, 'destroy flushes commands rather than leaving an offline queue behind');
});
test('pet subscriber startup does not await Redis availability', async context => {
    const previous = process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED; delete process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED;
    context.after(() => { if (previous === undefined) delete process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED; else process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED = previous; });
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const client = new Client(); client.connecting = () => new Promise(() => {});
    const stop = subscribePetWakeups(() => assert.fail('No data during outage'), () => client); context.after(stop);
    assert.equal(typeof stop, 'function');
    await turn(); context.mock.timers.tick(500); assert.equal(client.destroys, 1);
});
