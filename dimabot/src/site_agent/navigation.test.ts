import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NAV_ANCHORS, NAV_ROUTES } from './navigation.js';

// The browser mirror must list exactly the same keys and paths.
const mirror = readFileSync(new URL('../../../dimasite/src/app/features/assistant/assistant-routes.ts', import.meta.url), 'utf8');

function block(name: string): string {
    const start = mirror.indexOf(`export const ${name}`);
    assert.ok(start >= 0, `${name} missing in assistant-routes.ts`);
    return mirror.slice(start, mirror.indexOf('};', start));
}

test('routes match the dimasite mirror', () => {
    const routes = new Map([...block('ASSISTANT_ROUTES').matchAll(/'([a-z0-9.-]+)':\s*\[([^\]]*)\]/g)]
        .map((m) => [m[1], [...m[2].matchAll(/'([^']+)'/g)].map((p) => p[1])]));
    assert.deepEqual([...routes.keys()].sort(), NAV_ROUTES.map((r) => r.key).sort());
    for (const route of NAV_ROUTES) assert.deepEqual(routes.get(route.key), route.path, route.key);
});

test('anchors match the dimasite mirror and point at known routes', () => {
    const anchors = new Map([...block('ASSISTANT_ANCHORS').matchAll(/'([a-z0-9.-]+)':\s*'([a-z0-9.-]+)'/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual([...anchors.keys()].sort(), NAV_ANCHORS.map((a) => a.key).sort());
    const keys = new Set(NAV_ROUTES.map((r) => r.key));
    for (const anchor of NAV_ANCHORS) {
        assert.equal(anchors.get(anchor.key), anchor.route, anchor.key);
        assert.ok(keys.has(anchor.route), `${anchor.key} → unknown route ${anchor.route}`);
    }
});
