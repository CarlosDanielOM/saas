// Preload for ops/checks/admin-console-alert-activity.mjs on saas-ops' private test network.
// Twitch is mocked, and the real cron supervisor runs only the domain-events worker with only the
// chat-announcements-v1 consumer child, so the check stays far below the candidate's memory limit.
// Every application module runs unchanged.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { fork, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
const directory = process.env.FIXTURES_DIR || '/tmp/saas-fixtures';
const originalFetch = globalThis.fetch;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const log = value => fs.appendFileSync(`${directory}/calls.jsonl`, JSON.stringify(value) + '\n');
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return originalFetch(input, options);
    if (url.hostname === 'qdrant.test') return json(url.pathname === '/' ? { version: '1.18.0' }
        : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
    if (url.hostname === 'id.twitch.tv') return json({ access_token: 'app-token', expires_in: 3600, token_type: 'bearer' });
    if (url.hostname === 'api.twitch.tv') {
        if (url.pathname === '/helix/chat/messages') {
            log({ chat: JSON.parse(options.body) });
            return json({ data: [{ is_sent: true, message_id: 'mock-message' }] });
        }
        return json({ data: [], total: 0, pagination: {} });
    }
    if (url.hostname === 'us.i.posthog.com') return json({ status: 1 });
    throw new Error(`External request blocked in alert activity test: ${url.origin}${url.pathname}`);
};

const inert = () => {
    const child = new EventEmitter();
    child.pid = 0;
    child.kill = () => { setImmediate(() => child.emit('exit', 0, null)); return true; };
    return child;
};
globalThis.__alertActivitySpawn = (command, args, options) => {
    const entry = String(args?.[0] ?? '');
    if (!entry.endsWith('/domain_events.worker.js')) return inert();
    log({ worker: entry });
    return spawn(command, args, options);
};
globalThis.__alertActivityFork = (entry, args, options) => {
    if (!args?.includes('--consumer=chat-announcements-v1')) return inert();
    log({ consumer: 'chat-announcements-v1' });
    return fork(entry, args, options);
};
const shim = name => `export const ${name} = (...args) => globalThis.__alertActivity${name[0].toUpperCase()}${name.slice(1)}(...args);`;
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'node:child_process' && context.parentURL?.endsWith('/workers/cron.index.js')) {
            return { url: `data:text/javascript,${encodeURIComponent(shim('spawn'))}`, shortCircuit: true };
        }
        if (specifier === 'node:child_process' && context.parentURL?.endsWith('/utils/domain_event_execution.js')) {
            return { url: `data:text/javascript,${encodeURIComponent(shim('fork'))}`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    }
});
