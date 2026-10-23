import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createClient } from 'redis';
import { enqueueTtsSession, popTtsSession, resetTtsSession } from './tts_session.util.js';

// This suite deliberately executes the application's actual Lua, not a JS
// interpreter of the intended algorithm. Run only on a disposable candidate
// dependency with default Dragonfly scripting flags. No production fallback.
const url = process.env.DIMA032_TEST_REDIS_URL;
test('actual Lua: declared-key pop CAS and reset preserve stream identity under concurrent changes', { skip: !url }, async () => {
    const endpoint = new URL(url!);
    assert.equal(endpoint.protocol, 'redis:');
    assert.ok(['redis', 'localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname), 'only loopback or the saas-ops private redis alias is allowed');
    assert.equal(endpoint.username, '', 'fixture dependency must not use account credentials');
    assert.equal(endpoint.password, '', 'fixture dependency must not use account credentials');
    const cache = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } });
    await cache.connect();
    const channel = `dima032-lua-${randomUUID()}`;
    const prefix = `twitch:${channel}:tts:`;
    const queue = `${prefix}queue`, marker = `${prefix}session`;
    const payloadKey = (id: string) => `${prefix}queue:data:${id}`;
    const put = (id: string, score: number) => enqueueTtsSession(cache as any, channel, id, score, JSON.stringify({ speechID: id }));
    try {
        await put('ordinary-default-off', 10);
        assert.deepEqual(await popTtsSession(cache as any, channel), {
            value: 'ordinary-default-off', payload: await cache.get(payloadKey('ordinary-default-off')), session: null,
        });
        assert.equal(await popTtsSession(cache as any, channel), null);
        await put('peeked', 20);
        let crossed = false;
        const competing = {
            zRange: async (...args: Parameters<typeof cache.zRange>) => {
                const ids = await cache.zRange(...args);
                if (!crossed) { crossed = true; await put('new-minimum', 5); }
                return ids;
            },
            eval: cache.eval.bind(cache),
        };
        assert.equal((await popTtsSession(competing as any, channel))?.value, 'new-minimum');
        assert.deepEqual(await cache.zRange(queue, 0, -1), ['peeked']);

        // RESET returns its old membership snapshot. Delay the actual response
        // before cleanup; a post-boundary enqueue reusing an old ID must survive.
        await cache.set(`${prefix}processing`, 'active');
        await cache.set(payloadKey('active'), JSON.stringify({ speechID: 'active' }));
        const orphan = payloadKey('orphan'); await cache.set(orphan, '{}');
        const delayed = { eval: async (script: string, options: any) => {
            const result = await cache.eval(script, options);
            if (script.includes('DIMA032_RESET')) {
                assert.equal(await cache.zCard(queue), 0);
                assert.equal(await cache.get(marker), 'new-session');
                await put('peeked', 1); await put('after-boundary', 2);
            }
            return result;
        } };
        await resetTtsSession(delayed as any, channel, 'new-session', [orphan]);
        assert.equal(await cache.get(orphan), null);
        assert.equal(await cache.get(payloadKey('active')), null);
        assert.deepEqual(await cache.zRange(queue, 0, -1), ['peeked', 'after-boundary']);
        const current = await popTtsSession(cache as any, channel);
        assert.equal(current?.value, 'peeked'); assert.equal(current?.session, 'new-session');
        assert.equal(JSON.parse(current!.payload).queueSession, 'new-session');

        // A stream reset between peek and CAS cannot dequeue the retired item.
        await put('before-second-boundary', 0);
        crossed = false;
        const resetting = { ...competing, zRange: async (...args: Parameters<typeof cache.zRange>) => {
            const ids = await cache.zRange(...args);
            if (!crossed) {
                crossed = true; await resetTtsSession(cache as any, channel, 'third-session', []);
                await put('third-session-item', 0);
            }
            return ids;
        } };
        const third = await popTtsSession(resetting as any, channel);
        assert.equal(third?.value, 'third-session-item'); assert.equal(third?.session, 'third-session');
        assert.equal(await cache.get(payloadKey('before-second-boundary')), null);
    } finally {
        // Unique fixture-owned namespace, including the marker and popped data.
        const keys = await cache.keys(`${prefix}*`);
        if (keys.length) await cache.del(keys);
        await cache.quit();
    }
});

test('pop bounds failed minimum CAS attempts without losing queue membership', async () => {
    let attempts = 0;
    const cache = { zRange: async () => ['old-minimum'], eval: async (_script: string, options: any) => {
        assert.equal(options.keys[2], 'twitch:fixture:tts:queue:data:old-minimum');
        assert.deepEqual(options.arguments, ['old-minimum']); attempts++; return ['retry'];
    } };
    assert.equal(await popTtsSession(cache as any, 'fixture'), null);
    assert.equal(attempts, 8);
});
