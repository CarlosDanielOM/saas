// Behavior check for the units on Polar `ai_usage` events, for any dimabot candidate (bot, api, cron):
// `_cost.amount` = the provider charge in cents (Polar's dashboards), `cost` = the same charge in USD as the
// provider reports it, `credits` unchanged (LLM: cents × 1000; voice: fixed price; generic: price in cents × 1000).
//
//   scripts/saas-ops verify bot-<run-id> --dependency mongo --dependency redis \
//     --test-env ops/checks/ai-chat-fixtures/test-env.json --fixtures ops/checks/ai-chat-fixtures \
//     --check ops/checks/polar-cost-units.mjs
//
// The compiled `ingestPolarSHEvent` of the candidate sends to a Polar mock in this process; nothing leaves it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

if (process.env.SAAS_TARGET === 'bot') {
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
        try { ready = (await fetch('http://127.0.0.1:3333/eventsub', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status === 403; } catch {}
        if (!ready) await pause(500);
    }
    assert.ok(ready, 'the real bot entrypoint is up');
}

execFileSync(process.execPath, ['--experimental-test-module-mocks', '--test', '/app/dist/utils/polarsh_accounting.test.js',
    '/app/dist/site_agent/credits.test.js', '/app/dist/utils/usage_receipt_path.test.js', '/app/dist/utils/ai/openrouter/ai.tools_disabled.test.js'],
{ env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'inherit' });

const sent = [];
const fixtureFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'api.polar.sh') return fixtureFetch(input, init);
    const body = init.body ? JSON.parse(String(init.body)) : await input.clone().json();
    sent.push(...(body.events || []));
    return new Response(JSON.stringify({ inserted: (body.events || []).length, duplicates: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { ingestPolarSHEvent } = await import('/app/dist/utils/polarsh.js');
const base = { customerId: 'customer-units', channelID: '900000555', mode: 'immediate' };
const event = id => sent.find(item => (item.external_id ?? item.externalId) === id)?.metadata;

// An LLM call OpenRouter reported at $0.00033.
assert.equal((await ingestPolarSHEvent({ ...base, externalId: 'units-llm', cost: 0.00033, reason: 'messages',
    llm: { model: 'openai/test:model', usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } } })).error, false);
let metadata = event('units-llm');
assert.equal(Number(metadata._cost.amount), 0.033, '_cost is cents');
assert.equal(metadata.cost, 0.00033, 'cost is USD, as OpenRouter reported it');
assert.equal(metadata.credits, 33, 'credits = cents × 1000, as before');

// A Drama 3 voice line: OpenRouter charged $0.00033; the streamer pays the fixed 50 credits.
assert.equal((await ingestPolarSHEvent({ ...base, externalId: 'units-tts', cost: 0.00033, credits: 50, characters: 33, reason: 'tts_fish' })).error, false);
metadata = event('units-tts');
assert.equal(Number(metadata._cost.amount), 0.033);
assert.equal(metadata.cost, 0.00033);
assert.equal(metadata.credits, 50);

// A fixed-price charge (one MCP tool credit): the price arrives in cents, `cost` shows it in USD.
assert.equal((await ingestPolarSHEvent({ ...base, externalId: 'units-generic', cost: 0.001, reason: 'mcp_tool' })).error, false);
metadata = event('units-generic');
assert.equal(metadata._cost, undefined);
assert.equal(metadata.cost, 0.00001);
assert.equal(metadata.credits, 1);

// Every digit OpenRouter reported is kept.
assert.equal((await ingestPolarSHEvent({ ...base, externalId: 'units-precise', cost: 0.000048874542, reason: 'messages',
    llm: { model: 'openai/test', usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } } })).error, false);
assert.equal(event('units-precise').cost, 0.000048874542);

// The monthly free grant on the generic branch: -25 cents = -$0.25 = -25000 credits, no provider cost.
assert.equal((await ingestPolarSHEvent({ ...base, externalId: 'units-grant', cost: -25, reason: 'Free benefits' })).error, false);
metadata = event('units-grant');
assert.equal(metadata.cost, -0.25);
assert.equal(metadata.credits, -25000);
assert.equal(metadata._cost, undefined);

// A tiny LLM call keeps a plain JSON number.
assert.equal((await ingestPolarSHEvent({ ...base, externalId: 'units-tiny', cost: 0.0000005, reason: 'messages',
    llm: { model: 'openai/test', usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } } })).error, false);
metadata = event('units-tiny');
assert.equal(metadata.cost, 5e-7);
assert.equal(Number(metadata._cost.amount), 0.00005);
assert.equal(metadata.credits, 1);

console.log(`PASS Polar cost units (${process.env.SAAS_TARGET || 'candidate'}): _cost cents, cost USD, credits unchanged.`);
process.exit(0);
