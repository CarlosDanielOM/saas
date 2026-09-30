// Mock providers only on saas-ops' private network. The changed EventSub,
// journal, reconciliation and domain worker modules all run unchanged.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { spawn } from 'node:child_process';
const directory = '/tmp/saas-fixtures';
const originalFetch = globalThis.fetch;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const log = value => fs.appendFileSync(`${directory}/calls.jsonl`, JSON.stringify(value) + '\n');
const statePath = `${directory}/remote.json`;
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return originalFetch(input, options);
    if (url.hostname === 'qdrant.test') return json(url.pathname === '/' ? { version: '1.18.0' }
        : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
    if (url.hostname === 'id.twitch.tv') return json({ access_token: 'app-token', expires_in: 3600, token_type: 'bearer' });
    if (url.hostname === 'api.twitch.tv') {
        if (url.pathname === '/helix/eventsub/subscriptions') {
            const remote = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : [];
            if (options.method === 'POST') {
                const body = JSON.parse(options.body);
                log({ subscription: body, authorization: options.headers.Authorization });
                const subscription = { ...body, id: `remote-${remote.length}`, status: 'enabled', cost: 0, created_at: new Date().toISOString() };
                remote.push(subscription);
                fs.writeFileSync(statePath, JSON.stringify(remote));
                return json({ data: [subscription] });
            }
            return json({ data: remote, total: remote.length, pagination: {} });
        }
        if (url.pathname === '/helix/chat/messages') {
            log({ chat: JSON.parse(options.body) });
            return json({ data: [{ is_sent: true, message_id: 'mock-message' }] });
        }
        return json({ data: [], total: 0, pagination: {} });
    }
    throw new Error(`External request blocked in chat notification test: ${url.origin}${url.pathname}`);
};

// Limit the real cron supervisor to the two affected workers. Unrelated
// workers are provider fixtures; production uses the normal child processes.
globalThis.__chatNoticeSpawn = (command, args, options) => {
    const entry = String(args[0]);
    if (entry.endsWith('/domain_events.worker.js') || entry.endsWith('/eventsub_reconciliation.worker.js')) {
        log({ worker: entry });
        return spawn(command, args, options);
    }
    return null;
};
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'node:child_process' && context.parentURL?.endsWith('/workers/cron.index.js')) {
            const source = `import { EventEmitter } from 'node:events';
                export const spawn = (...args) => {
                    const actual = globalThis.__chatNoticeSpawn(...args);
                    if (actual) return actual;
                    const child = new EventEmitter(); child.pid = 0; child.kill = () => true; return child;
                };`;
            return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    }
});
