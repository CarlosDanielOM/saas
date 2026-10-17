import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { authenticateAccess, oauthWebsite, rateLimit, hash } from './service.js';

/** A native WebSocket protocol, deliberately separate from browser Socket.IO namespaces. */
export function attachDesktopWebsocket(server: Server): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false,
        handleProtocols: protocols => protocols.has('dima.desktop.v1') ? 'dima.desktop.v1' : false });
    const connections = new Map<WebSocket, { token: string; sessionID: string; alive: boolean; checking: boolean }>();
    server.on('upgrade', (req, socket, head) => {
        let url: URL;
        try { url = new URL(req.url || '/', 'http://localhost'); }
        catch {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            return;
        }
        if (url.pathname !== '/v1/desktop/ws') {
            if (!url.pathname.startsWith('/socket.io/')) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            return;
        }
        const reject = (status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
        const timeout = setTimeout(() => socket.destroy(), 5000);
        timeout.unref();
        socket.once('close', () => clearTimeout(timeout));
        void (async () => {
            if (url.search || (req.headers.origin && req.headers.origin !== oauthWebsite())) return reject(403);
            if (!req.headers['sec-websocket-protocol']?.split(',').map(value => value.trim()).includes('dima.desktop.v1')) return reject(426);
            await rateLimit(`ws:${req.socket.remoteAddress}`, 120);
            const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
            const identity = await authenticateAccess(token);
            if (!identity.scopes.includes('desktop:connect')) return reject(403);
            if ([...connections.values()].filter(item => item.sessionID === identity.session_id).length >= 2) return reject(429);
            if (socket.destroyed) return;
            wss.handleUpgrade(req, socket, head, ws => {
                clearTimeout(timeout);
                const state = { token: token!, sessionID: identity.session_id, alive: true, checking: false };
                connections.set(ws, state);
                ws.on('error', () => ws.terminate());
                ws.on('close', () => connections.delete(ws));
                ws.on('pong', () => { state.alive = true; });
                ws.send(JSON.stringify({ type: 'hello', protocol_version: 1, session_id: identity.session_id,
                    channel_id: identity.channel_id, scopes: identity.scopes, pet_available: false }));
                let busy = false;
                ws.on('message', (data, binary) => {
                    if (busy) return ws.close(4429, 'Too many requests');
                    busy = true;
                    void (async () => {
                        await rateLimit(`ws-message:${hash(state.token)}`, 60);
                        await authenticateAccess(state.token);
                        if (binary) return ws.close(4400, 'Text messages required');
                        let input: { type?: unknown; id?: unknown };
                        try { input = JSON.parse(data.toString()); }
                        catch { return ws.close(4400, 'Invalid JSON'); }
                        if (!input || typeof input !== 'object' || input.type !== 'ping' ||
                            (input.id !== undefined && (typeof input.id !== 'string' || input.id.length > 64))) {
                            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', error: 'unsupported_message' }));
                            return;
                        }
                        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong', ...(input.id ? { id: input.id } : {}) }));
                    })().catch(() => ws.close(4401, 'Session expired or revoked')).finally(() => { busy = false; });
                });
            });
        })().catch(() => reject(401));
    });
    // Revalidate even idle sockets: revoked sessions and expired access stop receiving events.
    const timer = setInterval(() => {
        for (const [ws, state] of connections) {
            if (!state.alive) { ws.terminate(); continue; }
            if (state.checking) continue;
            state.alive = false;
            state.checking = true;
            void authenticateAccess(state.token).then(() => {
                if (ws.readyState === WebSocket.OPEN) ws.ping();
            }).catch(() => ws.close(4401, 'Session expired or revoked'))
                .finally(() => { state.checking = false; });
        }
    }, 15000);
    timer.unref();
    server.once('close', () => { clearInterval(timer); for (const ws of connections.keys()) ws.terminate(); wss.close(); });
}
