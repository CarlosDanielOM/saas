// Read-only production smoke: use the existing cached app token without refresh,
// search real Twitch categories, and never invoke channel updates or chat sends.
// Usage: docker exec -i dima-bot node --input-type=module < ops/checks/game-search-live.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createClient } from 'redis';
const cache = createClient({ url: `redis://${process.env.DRAGONFLY_HOST}:${process.env.DRAGONFLY_PORT}` });
cache.on('error', () => {});
await cache.connect();
const token = await cache.get('app:twitch:token');
await cache.quit();
assert.ok(token, 'cached Twitch app token must exist; this smoke never refreshes it');
globalThis.gameSearchSmokeHeaders = { 'Client-Id': process.env.CLIENT_ID, Authorization: `Bearer ${token}` };
registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url !== 'file:///app/dist/utils/header.js') return resolved;
    const source = 'export const getTwitchAppHeader = async () => globalThis.gameSearchSmokeHeaders;';
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
} });
const { searchCategories } = await import('/app/dist/functions/search/search_categories.search.js');
const { categoryTokens } = await import('/app/dist/functions/search/category_matching.js');
for (const [query, expected] of [
    ['mortal shell 2', 'Mortal Shell II'],
    ['dark souls 3', 'Dark Souls III'],
    ['baldurs gate3', "Baldur's Gate 3"],
    ['mortal shell', 'Mortal Shell']
]) {
    const result = await searchCategories(query);
    assert.equal(result.error, false, result.message);
    assert.deepEqual(categoryTokens(result.data?.[0]?.name || ''), categoryTokens(expected), query);
    console.log(`${query} -> ${result.data[0].name}`);
}
const missing = await searchCategories('mortal shell 987654321');
assert.equal(missing.error, false, missing.message);
assert.deepEqual(missing.data, [], 'nonexistent sequel must never choose the original');
console.log('PASS read-only live Twitch selection; no stream categories changed');
