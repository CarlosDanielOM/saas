import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { fork } from 'node:child_process';
import test from 'node:test';
import {
    DomainEventExecutionSupervisor, forkDomainEventConsumer,
    type DomainEventChild, type DomainEventChildMessage
} from './domain_event_execution.js';

class FakeChild extends EventEmitter {
    signals: string[] = [];
    kill(signal: string): boolean { this.signals.push(signal); return true; }
    message(message: DomainEventChildMessage): void { this.emit('message', message); }
}

const config = {
    executionTimeoutMs: 1000, operationTimeoutMs: 5000, leaseSafetyMs: 100,
    shutdownGraceMs: 200, restartDelayMs: 100
};

function harness(ids = ['blocked', 'healthy'], once = false) {
    let now = 0;
    const children = new Map<string, FakeChild[]>();
    const supervisor = new DomainEventExecutionSupervisor(ids, config, (id) => {
        const child = new FakeChild();
        children.set(id, [...children.get(id) ?? [], child]);
        return child as DomainEventChild;
    }, once, () => now, () => undefined);
    supervisor.tick();
    return {
        supervisor, children,
        advance(time: number) { now = time; supervisor.tick(); },
        child(id: string) { return children.get(id)!.at(-1)!; }
    };
}

test('a stuck handler is killed independently; renewal cannot extend its execution deadline', () => {
    const h = harness();
    const blocked = h.child('blocked');
    const lease = { eventKey: 'event', leaseToken: 'token', lockedUntil: 5000 };
    blocked.message({ type: 'claimed', lease });
    h.child('healthy').message({ type: 'claimed', lease });
    h.advance(900);
    blocked.message({ type: 'renewed', lease: { ...lease, lockedUntil: 9000 } });
    h.child('healthy').message({ type: 'finished' });
    h.advance(1000);
    assert.deepEqual(blocked.signals, ['SIGKILL']);
    assert.deepEqual(h.child('healthy').signals, []);
    h.advance(2000);
    assert.equal(h.children.get('blocked')!.length, 1, 'no replacement before exit');
    blocked.emit('exit', null, 'SIGKILL');
    h.advance(2099);
    assert.equal(h.children.get('blocked')!.length, 1);
    h.advance(2100);
    assert.equal(h.children.get('blocked')!.length, 2);
    assert.equal(h.children.get('healthy')!.length, 1, 'healthy process stays persistent');
    blocked.emit('close', null, 'SIGKILL');
    blocked.emit('error', new Error('late child error'));
    blocked.message({ type: 'finished' });
    assert.deepEqual(h.child('blocked').signals, [], 'old lifecycle cannot affect replacement');
});

test('missing or hung renewal kills the process before lease expiry', () => {
    const h = harness(['consumer']);
    h.child('consumer').message({
        type: 'claimed', lease: { eventKey: 'event', leaseToken: 'token', lockedUntil: 500 }
    });
    h.advance(399);
    assert.deepEqual(h.child('consumer').signals, []);
    h.advance(400);
    assert.deepEqual(h.child('consumer').signals, ['SIGKILL']);
});

test('a late renewal cannot revive an expired lease between watchdog ticks', () => {
    let now = 0;
    const child = new FakeChild();
    const supervisor = new DomainEventExecutionSupervisor(['consumer'], config,
        () => child as DomainEventChild, false, () => now, () => undefined);
    supervisor.tick();
    const lease = { eventKey: 'event', leaseToken: 'token', lockedUntil: 500 };
    child.message({ type: 'claimed', lease });
    now = 450;
    child.message({ type: 'renewed', lease: { ...lease, lockedUntil: 5000 } });
    assert.deepEqual(child.signals, ['SIGKILL']);
});

test('startup and infrastructure awaits are bounded independently of handlers', () => {
    const h = harness(['consumer']);
    h.advance(5000);
    assert.deepEqual(h.child('consumer').signals, ['SIGKILL']);
});

test('shutdown waits for exits, escalates blocked children, and never replaces them', async () => {
    const h = harness();
    let stopped = false;
    const stopping = h.supervisor.stop().then(() => { stopped = true; });
    assert.deepEqual(h.child('blocked').signals, ['SIGTERM']);
    h.child('healthy').emit('exit', 0);
    await Promise.resolve();
    assert.equal(stopped, false);
    h.advance(200);
    assert.deepEqual(h.child('blocked').signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(stopped, false);
    h.child('blocked').emit('exit', null, 'SIGKILL');
    await stopping;
    h.advance(10_000);
    assert.equal(h.children.get('blocked')!.length, 1);
});

test('--once waits for every drain AND successful child exit', async () => {
    const h = harness(undefined, true);
    let done = false;
    const drained = h.supervisor.waitForDrain().then((success) => { done = true; return success; });
    h.child('healthy').message({ type: 'drained' });
    h.child('healthy').emit('exit', 0);
    await Promise.resolve();
    assert.equal(done, false);
    h.child('blocked').message({ type: 'drained' });
    await Promise.resolve();
    assert.equal(done, false);
    h.child('blocked').emit('exit', 0);
    assert.equal(await drained, true);
});

test('--once reports a crashed consumer rather than silently succeeding', async () => {
    const h = harness(['consumer'], true);
    h.child('consumer').emit('exit', 1);
    assert.equal(await h.supervisor.waitForDrain(), false);
    h.advance(10_000);
    assert.equal(h.children.get('consumer')!.length, 1);
});

test('spawn errors remain bounded and duplicate registry IDs are rejected', async () => {
    assert.throws(() => harness(['duplicate', 'duplicate']), /Duplicate/);
    const h = harness(['consumer'], true);
    h.child('consumer').emit('error', new Error('spawn failed'));
    h.child('consumer').emit('close', -2);
    assert.equal(await h.supervisor.waitForDrain(), false);
});

test('real TS child with a blocked event loop is killed while its sibling drains', { timeout: 10_000 }, async (context) => {
    const children: ReturnType<typeof fork>[] = [];
    const supervisor = new DomainEventExecutionSupervisor(['blocked', 'healthy'], {
        ...config, executionTimeoutMs: 200, operationTimeoutMs: 5000
    }, (consumer) => {
        const child = forkDomainEventConsumer(new URL('./domain_event_execution.fixture.ts', import.meta.url), consumer, true);
        children.push(child);
        return child;
    }, true, Date.now, () => undefined);
    const timer = setInterval(() => supervisor.tick(), 20);
    context.after(() => {
        clearInterval(timer);
        supervisor.killAll();
    });
    supervisor.tick();
    assert.equal(await supervisor.waitForDrain(), false);
    assert.equal(children[0].signalCode, 'SIGKILL');
    assert.equal(children[1].exitCode, 0);
});

test('worker dry-run is service-free and validates internal consumer IDs', { timeout: 10_000 }, async () => {
    for (const consumer of ['polar-plan-v1', 'not-registered']) {
        const child = fork(new URL('../workers/domain_events.worker.ts', import.meta.url), [
            '--dry-run', '--once', `--consumer=${consumer}`
        ], { execArgv: process.execArgv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        let output = '';
        child.stdout!.on('data', (chunk) => { output += chunk; });
        const [code] = await once(child, 'exit');
        if (consumer === 'not-registered') {
            assert.equal(code, 1);
        } else {
            assert.equal(code, 0);
            const parsed = JSON.parse(output);
            assert.equal(parsed.config.consumer, consumer);
            assert.equal(parsed.config.wakeups, 'mongo-polling-only');
            assert.equal(parsed.config.maxChildren, parsed.config.consumers.length);
            assert.equal(parsed.config.runOnce, true);
        }
    }
});

for (const mode of ['lease-error', 'lease-zero']) {
    test(`hard exit on ${mode} prevents a pending handler's later effects`, { timeout: 10_000 }, async (context) => {
        const child = forkDomainEventConsumer(new URL('./domain_event_execution.fixture.ts', import.meta.url), mode, true);
        context.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
        const messages: unknown[] = [];
        child.on('message', (message) => messages.push(message));
        const [code] = await once(child, 'exit');
        assert.equal(code, 23);
        assert.deepEqual(messages, [], 'obsolete handler never resumed its side effect');
    });
}
