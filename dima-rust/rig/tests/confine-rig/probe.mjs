// dima-rig confinement probe: run in the reference image with the rig's preload. GET /probe
// tries every way out of the machine and prints what happened as one `PROBE {...}` line.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { execFile } from 'node:child_process';

const attempt = async (name, fn) => {
    try {
        return [name, { ok: true, value: await fn() }];
    } catch (e) {
        return [name, { ok: false, error: String(e?.code || e?.cause?.code || e?.message || e) }];
    }
};

const get = (mod, url) => new Promise((resolve, reject) => {
    const req = mod.get(url, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 120) }));
    });
    req.on('error', reject);
});

async function probe() {
    const results = Object.fromEntries(await Promise.all([
        attempt('fetch_unknown', async () => {
            const r = await fetch('https://example.com/escape?via=fetch');
            return { status: r.status, body: (await r.text()).slice(0, 120) };
        }),
        attempt('https_get_unknown', () => get(https, 'https://neverssl.com/escape?via=https')),
        attempt('http_get_unknown', () => get(http, 'http://93.184.215.14/escape?via=http')),
        attempt('raw_socket', () => new Promise((resolve, reject) => {
            const s = net.connect(443, '93.184.215.14', () => { s.destroy(); resolve('connected'); });
            s.on('error', reject);
        })),
        attempt('dns_resolve', () => dns.promises.resolve4('example.org')),
        attempt('dns_lookup', () => dns.promises.lookup('example.net')),
        attempt('child_wget', () => new Promise((resolve, reject) => {
            execFile('wget', ['-q', '-T', '5', '-O-', 'http://example.com/escape?via=wget'],
                (err, stdout, stderr) => (err ? reject(new Error(`wget: ${stderr || err.message}`)) : resolve(stdout.slice(0, 120))));
        })),
        attempt('known_provider', async () => {
            const r = await fetch('https://api.twitch.tv/helix/users?login=nobody');
            return { status: r.status };
        }),
    ]));
    console.log(`PROBE ${JSON.stringify(results)}`);
    return results;
}

http.createServer(async (req, res) => {
    if (req.url === '/probe') {
        const results = await probe();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(results));
    } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
    }
}).listen(8080);
