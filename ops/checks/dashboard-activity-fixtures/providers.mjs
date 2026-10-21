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
if (process.env.RAID_PROTECTION_REGRESSION === 'true') {
    const originalLog = console.log;
    console.log = (...args) => {
        if (args[0] === 'Raid session worker ready') log({ raidReady: process.pid });
        if (args[0] === 'Follow defense action worker ready') log({ ready: process.pid });
        originalLog(...args);
    };
}
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return originalFetch(input, options);
    if (url.hostname === 'qdrant.test') return json(url.pathname === '/' ? { version: '1.18.0' }
        : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
    if (url.hostname === 'id.twitch.tv') return json({ access_token: 'app-token', expires_in: 3600, token_type: 'bearer' });
    if (url.hostname === 'api.twitch.tv') {
        if (url.pathname === '/helix/eventsub/subscriptions') {
            const remote = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : [];
            if (options.method === 'DELETE') {
                if (fs.existsSync(`${directory}/fail-delete`)) {
                    const mode=fs.readFileSync(`${directory}/fail-delete`,'utf8');
                    if(mode==='throw')throw new Error('Fixture Twitch transport failure');
                    return new Response(JSON.stringify({error:'Fixture unavailable',message:'Retry deletion'}),{status:502,headers:{'Content-Type':'application/json'}});
                }
                const kept = remote.filter(row => row.id !== url.searchParams.get('id'));
                fs.writeFileSync(statePath, JSON.stringify(kept)); log({ unsubscribe: url.searchParams.get('id') });
                return new Response(null, { status: 204 });
            }
            if (options.method === 'POST') {
                const body = JSON.parse(options.body);
                log({ subscription: body, authorization: options.headers.Authorization });
                const subscription = { ...body, id: `remote-${Date.now()}-${Math.random().toString(36).slice(2)}`, status: 'enabled', cost: 0, created_at: new Date().toISOString() };
                if(body.type==='channel.raid')subscription.condition={from_broadcaster_user_id:'',to_broadcaster_user_id:'',...body.condition};
                remote.push(subscription);
                fs.writeFileSync(statePath, JSON.stringify(remote));
                return json({ data: [subscription] });
            }
            return json({ data: remote, total: remote.length, pagination: {} });
        }
        if (url.pathname === '/helix/chat/emotes' || url.pathname === '/helix/chat/emotes/global') {
            const channel = url.searchParams.get('broadcaster_id') || 'global';
            log({ emoteCatalog: channel });
            const modePath = `${directory}/emote-mode-${channel}`;
            const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, 'utf8') : '';
            if (mode === 'fail') return new Response('{}', { status: 503 });
            if (mode === 'malformed') return json({ data: [{ name: 'missing-id' }] });
            const path = `${directory}/emotes-${channel}.json`;
            return json({ data: fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : [] });
        }
        log({ endpoint: url.pathname, method: options.method || 'GET' });
        if (url.pathname === '/helix/moderation/bans') {
            const user=JSON.parse(options.body).data.user_id;
            log({user,channel:url.searchParams.get('broadcaster_id'),moderator:url.searchParams.get('moderator_id'),at:Date.now()});
            if(user==='slow-first')await new Promise(resolve=>setTimeout(resolve,4000));
            return new Response(JSON.stringify({data:[{user_id:user}]}),{headers:{'Content-Type':'application/json','Ratelimit-Remaining':'800','Ratelimit-Reset':String(Math.ceil(Date.now()/1000)+60)}});
        }
        if (url.pathname === '/helix/chat/messages') {
            log({ chat: JSON.parse(options.body) });
            return json({ data: [{ is_sent: true, message_id: 'mock-message' }] });
        }
        return json({ data: [], total: 0, pagination: {} });
    }
    throw new Error(`External request blocked in chat notification test: ${url.origin}${url.pathname}`);
};

// Limit the real cron supervisor to the native dashboard worker. Unrelated
// workers are provider fixtures; production uses the normal child processes.
globalThis.__chatNoticeSpawn = (command, args, options) => {
    if (command === '/usr/local/bin/dashboard_activity') {
        log({ worker: command });
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
