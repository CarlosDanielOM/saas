import express, { type Router } from 'express';
import type { AddressInfo } from 'node:net';

/**
 * Minimal HTTP harness for route pin tests: mounts one router behind a fake auth step
 * (the test mocks `authMiddleware` to read `harness.user`) and returns status + JSON body.
 */
export interface RouteHarness {
    user: { id: string; login: string; display_name: string } | null;
    request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
    close(): Promise<void>;
}

export const harnessState: { user: RouteHarness['user'] } = { user: null };

/** Drop-in replacement for `authMiddleware` in mocked route tests. */
export function fakeAuthMiddleware(req: any, res: any, next: () => void): void {
    if (!harnessState.user) { res.status(401).json({ error: true, message: 'Unauthorized', status: 401 }); return; }
    req.user = harnessState.user;
    next();
}

export async function startRouter(mount: string, router: Router): Promise<RouteHarness> {
    const app = express();
    app.use(express.json());
    app.use(mount, router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
        get user() { return harnessState.user; },
        set user(value) { harnessState.user = value; },
        async request(method, path, body, headers = {}) {
            const response = await fetch(`http://127.0.0.1:${port}${mount}${path}`, {
                method,
                headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            const text = await response.text();
            return { status: response.status, body: text ? JSON.parse(text) : null };
        },
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
}
