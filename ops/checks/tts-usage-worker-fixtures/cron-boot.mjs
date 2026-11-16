// Preload for ops/checks/tts-usage-worker.mjs, inside the isolated cron candidate only.
// The real supervisor starts just the tts-usage and ai-usage-receipts workers; every other
// registered worker becomes an inert child. OpenRouter's generation lookup and Polar are mocked;
// any other external request fails closed. No application code is replaced.
import fs from 'node:fs';
import { registerHooks } from 'node:module';

const UNDER_TEST = ['tts_usage', 'ai_usage_receipts'];
globalThis.__cronCheckUnderTest = UNDER_TEST;
const source = `
import { spawn as actual } from 'node:child_process';
import { EventEmitter } from 'node:events';
const real = new RegExp('/(' + globalThis.__cronCheckUnderTest.join('|') + ')\\\\.worker\\\\.(js|ts)$');
export const spawn = (command, args, options) => {
    if (real.test(String(args?.[0] ?? ''))) return actual(command, args, options);
    const child = new EventEmitter();
    Object.assign(child, { pid: 0, exitCode: null, signalCode: null, kill: () => true });
    return child;
};`;
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'node:child_process' && /\/workers\/cron\.index\.(js|ts)$/.test(context.parentURL ?? '')) {
            return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

const logPath = '/tmp/saas-fixtures/provider-calls.jsonl';
const statePath = '/tmp/saas-fixtures/state.json';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const append = entry => fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
    if (url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/generation') {
        const id = url.searchParams.get('id') || '';
        const auth = new Headers(options.headers).get('Authorization');
        append({ generation: id, auth });
        // `gen-found-<usd>` reports that charge; `gen-error-*` fails; anything else is not recorded yet.
        const found = /^gen-found-([0-9.]+)$/.exec(id);
        if (found) return json({ data: { id, total_cost: Number(found[1]), usage: Number(found[1]), api_type: 'tts' } });
        if (id.startsWith('gen-error-')) return json({ error: { message: 'upstream', code: 502 } }, 502);
        return json({ error: { message: `Generation ${id} not found`, code: 404 } }, 404);
    }
    if (url.hostname === 'api.polar.sh') {
        const body = options.body ? JSON.parse(String(options.body)) : input instanceof Request ? await input.clone().json() : undefined;
        append({ billing: url.pathname, body, status: state.polarDown ? 503 : 200 });
        if (state.polarDown) return json({ detail: 'unavailable' }, 503);
        return json({ inserted: body?.events?.length ?? 0, duplicates: 0 });
    }
    throw new Error(`Unmocked external request blocked: ${url.origin}${url.pathname}`);
};
