// Records the access decision table from the frozen `admin.middleware.ts` against a scratch
// MongoDB database seeded with `access-cases.json`.
//
//   eval "$(dima-rust/tools/test-env)"
//   cd "$DIMABOT_DIR" && TZ=UTC node_modules/.bin/tsx \
//       "$REPO/dima-rust/crates/platform/tests/record-access.mts"
//
// Only `admin.middleware.ts` is evaluated (transpiled; its imports replaced by the real `Admin`
// model and a logger stub). `adminMiddleware` runs behind a real Express app; the user is set by
// a test header instead of Twitch. Twitch ids are random per run; the recording names them by
// kind.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const cases = JSON.parse(fs.readFileSync(fileURLToPath(new URL('access-cases.json', import.meta.url)), 'utf8'));
const root = process.env.DIMABOT_DIR!;
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const express = require('express');
const mongoose = require('mongoose');
const SOURCES = ['src/middleware/admin.middleware.ts', 'src/schemas/admin.schema.ts'];

function load(rel: string, mapping: Record<string, unknown>) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} as Record<string, any> };
    const req = (spec: string) => {
        if (spec in mapping) return mapping[spec];
        throw new Error(`unexpected import ${spec} in ${rel}`);
    };
    vm.compileFunction(out, ['exports', 'require', 'module'])(module.exports, req, module);
    return module.exports;
}

const run = randomBytes(6).toString('hex');
const CREATOR = '533538623';
const idOf = (kind: string) => kind === 'creator' || kind === 'creator_channel' ? CREATOR
    : kind === 'owner' ? idOf('managed')
    : `9${createHash('sha256').update(kind + run).digest('hex').replace(/\D/g, '').slice(0, 9)}`;
const special = (value: unknown): unknown => {
    if (value === '$missing') return undefined;
    if (value === '$21') return Array.from({ length: 21 }, (_, i) => `p${i}`).join(',');
    if (value === '$20') return Array.from({ length: 20 }, (_, i) => `p${i}`).join(',');
    if (value === '$64') return 'a'.repeat(64);
    if (value === '$65') return 'a'.repeat(65);
    return value;
};
const requesterId = (kind: string) => kind === 'missing' ? undefined : kind === 'empty' ? '' : idOf(kind);
const targetId = (kind: string, requester: string) => kind === 'own' ? requesterId(requester)
    : kind === 'missing' ? undefined : kind === 'empty' ? '' : idOf(kind);
const literal = (kind: string) => kind === '$missing' ? undefined : kind === 'creator' ? CREATOR : kind;

const dbName = `dima_test_platform_${run}`;
await mongoose.connect(process.env.DIMA_TEST_MONGO_URI!, { dbName });
const { AdminSchema } = await import(path.join(root, 'src/schemas/admin.schema.ts'));
const admin = load('src/middleware/admin.middleware.ts', {
    '../schemas/admin.schema.js': { AdminSchema },
    '../utils/logger.js': { error: async () => {} },
});

const app = express();
app.get('/admin', (req: any, _res: any, next: any) => {
    const id = req.get('x-test-user');
    if (id !== undefined) req.user = { id, login: 'login', display_name: 'Display' };
    next();
}, admin.adminMiddleware, (req: any, res: any) => {
    res.json({ next: true, globalAdminRole: req.globalAdminRole ?? null, isSuperAdmin: req.isSuperAdmin ?? false });
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const port = (server.address() as any).port;
const send = (user: string | undefined) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (user !== undefined) headers['x-test-user'] = user;
    http.request({ host: '127.0.0.1', port, path: '/admin', headers }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
    }).on('error', reject).end();
});

const log = console.log;
try {
    console.log = () => {}; // adminMiddleware prints its name on every call
    for (const row of cases.admins) {
        await AdminSchema.create({ adminID: idOf(row.admin), adminName: `login_${row.admin}`,
            channelID: idOf(row.channel), channelName: `login_${row.channel}`,
            ...(row.role ? { role: row.role } : {}), actived: row.actived, permissions: row.permissions });
    }
    const out: Record<string, unknown[]> = { global: [], owner: [], context: [], decisions: [], parse: [], expand: [],
        resolve: [], creatorAssignment: [], adminMiddleware: [] };
    for (const requester of cases.requesters) {
        out.global.push({ requester, result: await admin.getGlobalAdminRole(requesterId(requester)) });
        for (const target of cases.targets) {
            const r = requesterId(requester), t = targetId(target, requester);
            out.owner.push({ requester, target, result: await admin.hasGlobalChannelOwnerAccess(r, t) });
            for (const permission of cases.permissions) {
                out.context.push({ requester, target, permission,
                    result: await admin.getChannelAccessContext(r, t, special(permission)) });
            }
            for (const list of cases.decision_lists) {
                const decisions = await admin.getChannelAccessDecisions(r, t, list);
                out.decisions.push({ requester, target, list, result: JSON.stringify(decisions) });
            }
        }
    }
    for (const input of cases.parse_inputs) out.parse.push({ input, result: admin.parsePermissionList(special(input)) ?? '$null' });
    for (const input of cases.expand_inputs) out.expand.push({ input, result: admin.expandChannelPermissionChecks(special(input)) });
    for (const [granted, requested] of cases.resolve_inputs) {
        out.resolve.push({ granted, requested, result: JSON.stringify(admin.resolveGrantedPermissions(granted, requested)) });
    }
    for (const [r, c, t] of cases.creator_assignment) {
        out.creatorAssignment.push({ args: [r, c, t], result: admin.canModifyCreatorAdminAssignment(literal(r), literal(c), literal(t)) });
    }
    for (const user of cases.admin_users) {
        out.adminMiddleware.push({ user, ...(await send(requesterId(user))) });
    }
    const sha256 = Object.fromEntries(SOURCES.map(rel => [rel, createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')]));
    const file = fileURLToPath(new URL('access-reference.json', import.meta.url));
    fs.writeFileSync(file, JSON.stringify({ sha256, ...out }, null, 1) + '\n');
} finally {
    console.log = log;
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    server.close();
}
