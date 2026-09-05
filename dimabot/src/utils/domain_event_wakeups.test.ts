import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { type TestContext } from 'node:test';
import type { RedisClientOptions } from 'redis';
import { DomainEventWakeups, domainEventWakeupsEnabled } from './domain_event_wakeups.js';
import { DomainEventPollSignal } from './domain_event_execution.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeClient extends EventEmitter {
    connects = 0;
    publications: [string, string][] = [];
    subscriptions: string[] = [];
    destroys = 0;
    hint?: () => void;
    connecting: () => Promise<unknown> = async () => undefined;
    publishing: () => Promise<unknown> = async () => undefined;
    subscribing: () => Promise<unknown> = async () => undefined;
    destroying = () => undefined;
    connect() { this.connects++; return this.connecting(); }
    publish(channel: string, message: string) {
        this.publications.push([channel, message]);
        return this.publishing();
    }
    subscribe(channel: string, listener: () => void) {
        this.subscriptions.push(channel);
        this.hint = listener;
        return this.subscribing();
    }
    destroy() { this.destroys++; this.destroying(); }
}

function harness(context: TestContext, onWake?: () => void, configure = (_client: FakeClient) => {}) {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const previous = process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED;
    delete process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED;
    const clients: FakeClient[] = [];
    const policies: RedisClientOptions[] = [];
    const wakeups = new DomainEventWakeups({
        onWake, timeoutMs: 50, retryMs: 100, idleMs: 200,
        createClient: (options) => {
            policies.push(options);
            const client = new FakeClient();
            configure(client);
            clients.push(client);
            return client;
        }
    });
    context.after(() => {
        wakeups.stop();
        if (previous === undefined) delete process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED;
        else process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED = previous;
    });
    return { wakeups, clients, policies };
}

test('cold publication is deferred, coalesced, and delivered after bounded connect', async (context) => {
    const connect = Promise.withResolvers<void>();
    const publish = Promise.withResolvers<void>();
    const h = harness(context, undefined, (client) => {
        client.connecting = () => connect.promise;
        client.publishing = () => publish.promise;
    });
    assert.equal(domainEventWakeupsEnabled(), true);
    for (let i = 0; i < 10_000; i++) h.wakeups.publish();
    assert.equal(h.clients.length, 0, 'no client work on the producer call stack');
    await turn();
    assert.equal(h.clients.length, 1);
    assert.deepEqual(h.policies[0].socket, { connectTimeout: 50, reconnectStrategy: false });
    assert.equal(h.policies[0].disableOfflineQueue, true);
    assert.equal(h.policies[0].commandsQueueMaxLength, 4);
    assert.equal(h.clients[0].publications.length, 0);
    connect.resolve();
    await turn();
    assert.deepEqual(h.clients[0].publications, [['domain-events:wakeup:v1', '1']]);
    for (let i = 0; i < 10_000; i++) h.wakeups.publish();
    await turn();
    assert.equal(h.clients[0].publications.length, 1, 'one in-flight command despite burst');
    publish.resolve();
    await turn();
    await turn();
    assert.equal(h.clients[0].publications.length, 2, 'only one coalesced follow-up hint');
    context.mock.timers.tick(200);
    assert.equal(h.clients[0].destroys, 1, 'idle publishers release their connection');
});

test('nonsettling publisher connect is destroyed, drops hints, and bounds retries under load', async (context) => {
    const connect = Promise.withResolvers<void>();
    const h = harness(context, undefined, (client) => { client.connecting = () => connect.promise; });
    h.wakeups.publish();
    await turn();
    context.mock.timers.tick(50);
    assert.equal(h.clients[0].destroys, 1);
    for (let i = 0; i < 10_000; i++) h.wakeups.publish();
    await turn();
    assert.equal(h.clients.length, 1, 'cooldown drops bursts without reconnecting');
    context.mock.timers.tick(100);
    await turn();
    assert.equal(h.clients.length, 1, 'failed publishers do not retry retained events');
    h.wakeups.publish();
    await turn();
    assert.equal(h.clients.length, 2);
    connect.resolve();
    await turn();
    assert.equal(h.clients[0].publications.length, 0, 'late connect cannot revive expired hints');
    assert.equal(h.clients[1].publications.length, 1);
});

test('parent Mongo polling continues during nonsettling listener connect and reconnect', async (context) => {
    const signal = new DomainEventPollSignal();
    context.after(() => signal.stop());
    const h = harness(context, () => signal.wake(), (client) => {
        client.connecting = () => new Promise(() => {});
    });
    assert.equal(h.wakeups.start(), undefined, 'startup never awaits Redis');
    await turn();
    for (let i = 0; i < 10; i++) {
        let polled = false;
        const poll = signal.wait(20).then(() => { polled = true; });
        context.mock.timers.tick(19);
        await Promise.resolve();
        assert.equal(polled, false);
        context.mock.timers.tick(1);
        await poll;
        await turn();
    }
    assert.equal(h.clients.length, 2);
    assert.equal(h.clients[0].destroys, 1);
});

for (const operation of ['publish', 'subscribe'] as const) {
    test(`stuck ${operation} destroys the connection and rejects the underlying queued command`, async (context) => {
        const command = Promise.withResolvers<void>();
        let rejected = false;
        void command.promise.catch(() => { rejected = true; });
        const h = harness(context, operation === 'subscribe' ? () => {} : undefined, (client) => {
            if (operation === 'subscribe') client.subscribing = () => command.promise;
            else client.publishing = () => command.promise;
            client.destroying = () => { command.reject(new Error('Client destroyed')); };
        });
        if (operation === 'subscribe') h.wakeups.start();
        else h.wakeups.publish();
        await turn();
        context.mock.timers.tick(49);
        assert.equal(h.clients[0].destroys, 0);
        context.mock.timers.tick(1);
        await turn();
        assert.equal(h.clients[0].destroys, 1);
        assert.equal(rejected, true, 'not merely an abandoned Promise.race loser');
        h.wakeups.stop();
        context.mock.timers.tick(1000);
        await turn();
        assert.equal(h.clients.length, 1, 'stop cancels background retries');
    });
}

test('publisher hints wake the independently subscribed parent before its fallback interval', async (context) => {
    const signal = new DomainEventPollSignal();
    context.after(() => signal.stop());
    const h = harness(context, () => signal.wake());
    h.wakeups.start();
    await turn();
    const publisherClient = new FakeClient();
    publisherClient.publishing = async () => { h.clients[0].hint!(); };
    const publisher = new DomainEventWakeups({ createClient: () => publisherClient });
    context.after(() => publisher.stop());
    let dispatched = false;
    const dispatch = signal.wait(1000).then(() => { dispatched = true; });
    publisher.publish();
    await turn();
    assert.equal(dispatched, true, 'no polling clock advancement needed');
    await dispatch;
    assert.equal(h.clients[0].subscriptions[0], publisherClient.publications[0][0]);
    assert.equal(h.clients[0].publications.length, 0, 'subscriber has a dedicated connection');
});

test('subscriber reconnects in the background and stop ignores late hints and completions', async (context) => {
    let wakes = 0;
    const h = harness(context, () => { wakes++; });
    h.wakeups.start();
    await turn();
    h.clients[0].emit('error', new Error('Connection lost'));
    context.mock.timers.tick(100);
    await turn();
    assert.equal(h.clients.length, 2);
    h.clients[0].hint!();
    h.clients[1].hint!();
    assert.equal(wakes, 1);
    h.wakeups.stop();
    h.clients[1].hint!();
    h.clients[1].emit('error', new Error('Late error'));
    context.mock.timers.tick(10_000);
    await turn();
    assert.equal(wakes, 1);
    assert.equal(h.clients.length, 2);
    assert.equal(h.clients[1].destroys, 1);
});

test('stop bounds a nonsettling connection and cancels scheduled cold publications', async (context) => {
    const connect = Promise.withResolvers<void>();
    const h = harness(context, undefined, (client) => { client.connecting = () => connect.promise; });
    h.wakeups.publish();
    await turn();
    h.wakeups.stop();
    assert.equal(h.clients[0].destroys, 1);
    connect.resolve();
    await turn();
    assert.equal(h.clients[0].publications.length, 0);
    const cold = new DomainEventWakeups({ createClient: () => assert.fail('Stopped before creation') });
    cold.publish();
    cold.stop();
    await turn();
});

test('disabled wakeups bypass all client creation, scheduling, and retries', async (context) => {
    const h = harness(context, () => assert.fail('Disabled hint'));
    process.env.DOMAIN_EVENTS_WAKEUPS_ENABLED = 'false';
    const publisher = new DomainEventWakeups({ createClient: () => assert.fail('Disabled publisher') });
    context.after(() => publisher.stop());
    assert.equal(domainEventWakeupsEnabled(), false);
    h.wakeups.start();
    for (let i = 0; i < 10_000; i++) publisher.publish();
    await turn();
    context.mock.timers.tick(10_000);
    await turn();
    assert.equal(h.clients.length, 0);
});

test('synchronous client creation failure and asynchronous rejection stay best-effort', async (context) => {
    const h = harness(context, undefined, (client) => {
        client.connecting = async () => { throw new Error('Unavailable'); };
    });
    h.wakeups.publish();
    await turn();
    assert.equal(h.clients[0].destroys, 1);
    const broken = new DomainEventWakeups({ createClient: () => { throw new Error('Invalid URL'); } });
    context.after(() => broken.stop());
    assert.doesNotThrow(() => broken.publish());
    await turn();
});
