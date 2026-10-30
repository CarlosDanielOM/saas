'use strict';
// Run the actual route inside Express with the production body-parser order.
// Only the fixed analytics destination and the source timeout are interposed;
// requests and responses travel over loopback and use real Node fetch semantics.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Module = require('node:module');
const http = require('node:http');
const root = fs.realpathSync(process.env.DIMA_OBSERVABILITY_ROUTE_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const sourceFile = 'src/server/routes/observability.route.ts';
const sourceBytes = fs.readFileSync(path.join(root, sourceFile));
const sha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
const pinnedSourceSha256 = '94a812dd2af8ec942a1750b1d454dcf8394d46c47535c73a5cb43aa4421a3406';
assert.equal(sha256, pinnedSourceSha256, 'route source changed');
const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
const express = local('express');
const compiled = ts.transpileModule(sourceBytes.toString('utf8'), {
    fileName: sourceFile, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
});
assert(!compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error));
let scenario, upstreamBase, timeoutMs;
const actualFetch = globalThis.fetch;
const fetchAdapter = (url, init) => {
    scenario.fetch = { url, method: init.method, authorization: init.headers.Authorization,
        contentType: init.headers['Content-Type'], body: init.body ?? null,
        timeoutMs, redirect: init.redirect, hasSignal: Boolean(init.signal) };
    assert(url.startsWith('http://dima-analytics:3210/'));
    if (scenario.throws) return Promise.reject(new TypeError('fetch failed'));
    return actualFetch(upstreamBase + url.slice('http://dima-analytics:3210'.length), init);
};
const moduleRecord = { exports: {} };
new Function('require', 'module', 'exports', 'fetch', 'AbortSignal', compiled.outputText)(
    local, moduleRecord, moduleRecord.exports, fetchAdapter,
    { timeout: ms => { timeoutMs = ms; return AbortSignal.timeout(ms); } },
);
const cases = [
    {name:'get-session-query', method:'GET', url:'/api/session?window=7d&filter=a%20b&empty=', authorization:'Bearer source-token', upstream:{status:200,body:'{"ok":true}'}},
    {name:'trace-id', method:'GET', url:'/api/traces/0123456789abcdef0123456789abcdef?limit=5', upstream:{status:200,body:'{"traces":[]}'}},
    {name:'upstream-401', method:'GET', url:'/api/overview', upstream:{status:401,body:'{"message":"unauthorized"}'}},
    {name:'upstream-500', method:'GET', url:'/api/resources', upstream:{status:500,body:'failure'}},
    {name:'put-json', method:'PUT', url:'/api/grants/12', contentType:'application/json; charset=utf-8', rawBody:'{"b":1,"a":[true,null]}'},
    {name:'put-json-array', method:'PUT', url:'/api/grants', contentType:'application/json', rawBody:'[1,"two"]'},
    {name:'put-empty', method:'PUT', url:'/api/grants', contentType:'application/json', rawBody:''},
    {name:'put-nonmatching', method:'PUT', url:'/api/grants', contentType:'text/plain', rawBody:'ignored'},
    {name:'put-form', method:'PUT', url:'/api/grants/12', contentType:'application/x-www-form-urlencoded', rawBody:'role=viewer&channels[]=alpha&channels[]=beta&services[0]=chat&services[1]=events&options[scope]=read&tag=one&tag=two'},
    {name:'put-form-many-indexed', method:'PUT', url:'/api/grants/12', contentType:'application/x-www-form-urlencoded', rawBody:Array.from({length:33}, (_, i) => `permissions[${i}]=p${i}`).join('&')},
    {name:'put-form-sparse-indexed', method:'PUT', url:'/api/grants/12', contentType:'application/x-www-form-urlencoded', rawBody:'channels[3]=alpha&channels[8]=beta&channels[0]=gamma'},
    {name:'delete-ignores-body', method:'DELETE', url:'/api/session?force=1', contentType:'application/json', rawBody:'{"ignored":true}'},
    {name:'trailing-slash', method:'GET', url:'/api/session/'},
    {name:'uppercase-trace', method:'GET', url:'/api/traces/0123456789ABCDEF0123456789abcdef'},
    {name:'long-grant', method:'GET', url:'/api/grants/1234567890123456789012345678901'},
    {name:'post', method:'POST', url:'/api/session'},
    {name:'head', method:'HEAD', url:'/api/session'},
    {name:'unknown', method:'GET', url:'/api/unknown'},
    {name:'transport-error', method:'GET', url:'/api/session', throws:true},
    {name:'redirect-location', method:'GET', url:'/api/logs', upstream:{status:302,body:'',location:'/elsewhere'}},
    {name:'redirect-without-location', method:'GET', url:'/api/logs', upstream:{status:302,body:'redirect body'}},
    {name:'not-modified', method:'GET', url:'/api/grants', upstream:{status:304,body:''}},
    {name:'no-content', method:'GET', url:'/api/grants', upstream:{status:204,body:''}},
    {name:'body-failure', method:'GET', url:'/api/session', upstream:{status:200,bodyFailure:true}},
];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
(async () => {
    const upstream = http.createServer((req, res) => {
        const spec = scenario.upstream || {status:200,body:'{}'};
        if (spec.location) res.setHeader('Location', spec.location);
        if (spec.bodyFailure) {
            res.writeHead(spec.status, {'Content-Length':'100'});
            res.write('partial');
            setTimeout(() => res.destroy(), 10);
        } else { res.writeHead(spec.status); res.end(spec.body || ''); }
    });
    upstreamBase = `http://127.0.0.1:${await listen(upstream)}`;
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({extended:true}));
    app.use('/observability', moduleRecord.exports.observabilityRoute);
    const server = http.createServer(app);
    const base = `http://127.0.0.1:${await listen(server)}`;
    const results = [];
    for (const entry of cases) {
        scenario = { fetch:null, throws:!!entry.throws, upstream:entry.upstream };
        timeoutMs = null;
        const headers = {};
        if (entry.authorization) headers.authorization = entry.authorization;
        if (entry.contentType) headers['content-type'] = entry.contentType;
        const reply = await actualFetch(base + '/observability' + entry.url, {
            method:entry.method, headers, body:entry.rawBody, redirect:'manual',
        });
        results.push({name:entry.name, request:{method:entry.method,url:entry.url,
            authorization:entry.authorization ?? null,contentType:entry.contentType ?? null,rawBody:entry.rawBody ?? null},
            upstream:entry.throws ? {throws:true} : (entry.upstream || {status:200,body:'{}'}),
            expected:{status:reply.status,body:await reply.text(),cacheControl:reply.headers.get('cache-control'),
                contentType:reply.headers.get('content-type'),fetch:scenario.fetch}});
    }
    await close(server); await close(upstream);
    const text = `${JSON.stringify({source:{file:sourceFile,sha256:pinnedSourceSha256},typescript:ts.version,cases:results},null,2)}\n`;
    const [mode, directory] = process.argv.slice(2);
    assert(['--write','--check'].includes(mode) && directory && path.isAbsolute(directory));
    const target = path.join(directory, 'observability-route-reference.json');
    if (mode === '--write') fs.writeFileSync(target, text, {flag:'wx'});
    else assert.equal(fs.readFileSync(target, 'utf8'), text);
    console.log(`${mode} ${target} sha256=${crypto.createHash('sha256').update(text).digest('hex')}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
