import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./admin_site.route.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('admin_site.route.ts', source, ts.ScriptTarget.Latest, true);
// Execute just the actual route and guard AST nodes, not the unrelated billing/email
// module graph. This tests reachability/authorization, not real OAuth or Express I/O.
const route = parsed.statements.find(node => node.getText(parsed).startsWith("router.get('/domain-events/health'"))!;
const guard = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ensureSuperAdmin')!;
const admin = parsed.statements.find(node => node.getText(parsed).startsWith('const SUPER_ADMIN_LOGIN ='))!;

test('health is mounted on the admin router with authentication before the super-admin gate', () => {
    const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    assert.match(server, /app\.use\('\/admin-site', adminSiteRoute\)/);
    assert.match(source, /export const adminSiteRoute = router/);
    assert.match(route.getText(parsed), /router\.get\('\/domain-events\/health', authMiddleware as any/);
    assert.ok(route.getText(parsed).indexOf('ensureSuperAdmin(req, res)') < route.getText(parsed).indexOf('getDomainEventHealth(consumer)'));
    assert.match(guard.getText(parsed), /req\.user\?\.login/);
    assert.match(guard.getText(parsed), /res\.status\(403\)/);
});

test('route denies non-admins before queries, validates scope, and hides credentials on health failures', async () => {
    let handler: any;
    let calls = 0;
    let fail = false;
    const auth = () => undefined;
    runInNewContext(ts.transpileModule([admin, guard, route].map(node => node.getText(parsed)).join('\n'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText, {
        authMiddleware: auth,
        router: { get(path: string, middleware: unknown, callback: unknown) {
            assert.equal(path, '/domain-events/health');
            assert.equal(middleware, auth);
            handler = callback;
        } },
        getDomainEventHealth: async (consumer?: string) => {
            calls++;
            if (fail) throw new Error('mongodb://admin:password@host payload@example.com');
            return { consumer: consumer ?? null };
        }
    });
    const invoke = async (login?: string, consumer?: unknown) => {
        const response = {
            code: 0, body: undefined as any, headers: {} as Record<string, string>,
            status(code: number) { this.code = code; return this; },
            json(body: unknown) { this.body = body; return this; },
            setHeader(key: string, value: string) { this.headers[key] = value; }
        };
        await handler({ user: login ? { login } : undefined, query: { consumer } }, response);
        return response;
    };
    for (const login of [undefined, 'viewer', 'cdom201-attacker']) assert.equal((await invoke(login)).code, 403);
    assert.equal(calls, 0);
    for (const consumer of [{ $ne: '' }, ['polar-plan-v1'], '', 'a'.repeat(101)]) {
        assert.equal((await invoke('cdom201', consumer)).code, 400);
    }
    assert.equal(calls, 0);
    const success = await invoke('CDOM201', 'polar-plan-v1');
    assert.equal(success.code, 200);
    assert.equal(success.body.data.consumer, 'polar-plan-v1');
    assert.equal(success.headers['Cache-Control'], 'no-store');
    fail = true;
    const failure = await invoke('cdom201');
    assert.equal(failure.code, 503);
    assert.equal(failure.body.error, true);
    assert.equal(failure.body.data, undefined);
    assert.doesNotMatch(JSON.stringify(failure), /password|mongodb|payload@/);
});
