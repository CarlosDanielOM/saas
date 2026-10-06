// Test-only boundaries: real application startup, AST and domain workers run
// against saas-ops' private databases; no messages or speech leave the container.
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
const directory = '/tmp/saas-fixtures';
if (!fs.existsSync(`${directory}/sample.mp3`)) execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-codec:a', 'libmp3lame', '-y', `${directory}/sample.mp3`, '-loglevel', 'error']);
if (!fs.existsSync(`${directory}/sample.wav`)) execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-y', `${directory}/sample.wav`, '-loglevel', 'error']);
const originalFetch = globalThis.fetch;
const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' }
});
const log = value => fs.appendFileSync(`${directory}/calls.jsonl`, JSON.stringify(value) + '\n');
globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return originalFetch(input, options);
    if (url.hostname === 'qdrant.test') return json(url.pathname === '/' ? { version: '1.18.0' }
        : { status: 'ok', time: 0, result: url.pathname.endsWith('/exists') ? { exists: true } : { collections: [] } });
    if (url.hostname === 'tts.test' && url.pathname.startsWith('/speech/')) {
        const speech = JSON.parse(options.body);
        log({ speech, channelID: url.pathname.split('/').at(-1) });
        return json({ error: false, data: { speechID: 'mock-speech' } });
    }
    if (url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/audio/speech') {
        const body = JSON.parse(options.body);
        log({ kokoro: body });
        const state = fs.existsSync(`${directory}/state.json`) ? JSON.parse(fs.readFileSync(`${directory}/state.json`)) : {};
        if (state.fail) return json({ error: 'provider unavailable' }, 503);
        return new Response(fs.readFileSync(`${directory}/sample.mp3`), { headers: { 'Content-Type': 'audio/mpeg' } });
    }
    if (url.hostname === 'piper.test') {
        log({ piper: JSON.parse(options.body) });
        return new Response(fs.readFileSync(`${directory}/sample.wav`), { headers: { 'Content-Type': 'audio/wav' } });
    }
    if (url.hostname === 'api.polar.sh') return json({ events: [], inserted: 1, duplicates: 0 });
    if (url.hostname === 'id.twitch.tv') return json({ access_token: 'app-token', expires_in: 3600 });
    if (url.hostname === 'api.twitch.tv') {
        if (url.pathname === '/helix/chat/messages') {
            log({ chat: JSON.parse(options.body) });
            return json({ data: [{ is_sent: true, message_id: 'mock-chat' }] });
        }
        return json({ data: [], total: 0, pagination: {} });
    }
    throw new Error(`External request blocked in TTS settings test: ${url.origin}${url.pathname}`);
};

// Exercise the real domain worker under the real cron supervisor while
// replacing unrelated workers with idle children in this disposable runtime.
globalThis.__ttsSettingsSpawn = (command, args, options) => {
    if (!String(args[0]).endsWith('/domain_events.worker.js')) return null;
    log({ worker: args[0] });
    return spawn(command, args, options);
};
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'node:child_process' && context.parentURL?.endsWith('/workers/cron.index.js')) {
            const source = `import { EventEmitter } from 'node:events';
                export const spawn = (...args) => {
                    const child = globalThis.__ttsSettingsSpawn(...args);
                    if (child) return child;
                    const idle = new EventEmitter(); idle.pid = 0; idle.kill = () => true; return idle;
                };`;
            return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    }
});
