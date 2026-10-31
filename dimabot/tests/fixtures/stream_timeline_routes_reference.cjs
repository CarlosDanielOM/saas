'use strict';
// Actual-source oracle with in-memory adapters, in an isolated toolchain.
//   node tests/fixtures/stream_timeline_routes_reference.cjs --write <absolute-empty-dir>
//   node tests/fixtures/stream_timeline_routes_reference.cjs --check <absolute-dir>
// Node 24.22.1, TypeScript 5.9.3 and the project's Express/Mongoose are required.
// Output: stream-timeline-routes-reference.json. No external provider or database is used.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), Module = require('node:module'), http = require('node:http');
const root = fs.realpathSync(process.env.DIMA_STREAM_TIMELINE_ROUTES_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript'), express = local('express'), mongoose = local('mongoose');
assert.equal(process.versions.node, '24.22.1'); assert.equal(ts.version, '5.9.3');
const sources = {
    timeline: ['src/server/routes/stream_timeline.route.ts', '83f34a5e0c1f3ee8e2bd5d99350c7a99684a528bd17dfbaa260e457a3e44bef0'],
    summary: ['src/server/routes/stream-summary.route.ts', '83acda0cd5b66fa6580c93354ae5473fb2bf7fa4f6c6084f6af90b4d03cabd2f'],
    analytics: ['src/server/routes/analytics.route.ts', 'f8cdeefd0854df6269e5bc5eed293391a9b81ebfa8e5420747ac9c563ee457e0'],
};
const read = file => fs.readFileSync(path.join(root, file));
for (const [file, pin] of Object.values(sources)) assert.equal(crypto.createHash('sha256').update(read(file)).digest('hex'), pin, `${file} changed`);
const chain = value => ({select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, maxTimeMS() { return this; }, lean() { return this; }, exec: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }});
// Match the early missing-token branch of src/middleware/auth.middleware.ts:
// 188-212. x-user is the deterministic stand-in for a cached-token identity.
const auth = (req, res, next) => {
    const header = req.headers.authorization || req.headers.Authorization;
    if (!header || typeof header !== 'string') {
        res.status(401).json({error:true, message:'No token provided', status:401, type:'no_token'});
        return;
    }
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!token) {
        res.status(401).json({error:true, message:'No token provided', status:401, type:'no_token'});
        return;
    }
    if (req.headers['x-user']) req.user = {id: String(req.headers['x-user'])};
    next();
};
let currentCase = '';
const model = {findOne: () => chain(null), find: () => chain([]), countDocuments: () => chain(0), updateOne: async (_filter, update) => {
    const date = update.$setOnInsert?.occurredAt;
    if (date instanceof Date && !Number.isFinite(date.getTime())) throw new Error('Mongoose Date cast failed');
    if (currentCase === 'marker-fraction-inside') assert.equal(date.toISOString(), '2026-01-01T00:59:59.000Z');
    if (currentCase === 'marker-fraction-end') assert.equal(date.toISOString(), '2026-01-01T01:00:00.000Z');
    return {};
}, deleteOne: async () => ({})};
const summaryModel = {...model, findOne: () => chain(currentCase === 'summary-detail-ok' ? {_id:'507f1f77bcf86cd799439011', channelID:'123'} : null)};
const owner = {findOne: () => chain({plan_tier: currentCase.endsWith('-free') ? 'free' : 'pro', polar_sh_customer_id: 'fixture-customer'})};
const dependencies = id => {
    if (id === 'express') return express;
    if (id === 'mongoose') return mongoose;
    if (id.endsWith('/middleware/auth.middleware.js')) return {authMiddleware: auth};
    if (id.endsWith('/middleware/admin.middleware.js')) return {getChannelAccessDecisions: async () => ({permissions: {'analytics:view': currentCase !== 'access-denied', 'billing:view': true}}), getChannelAccessContext: async () => ({allowed:currentCase !== 'follow-forbidden', role:'owner'}), hasGlobalChannelOwnerAccess: async () => false};
    if (id.endsWith('/schemas/users.schema.js')) return {default: owner, __esModule: true};
    if (id.endsWith('/schemas/stream_activity.schema.js')) return {StreamActivityAggregateSchema: model};
    if (id.endsWith('/schemas/ai_usage_receipt.schema.js')) return {default: model, __esModule: true};
    if (id.endsWith('/schemas/stream_timeline.schema.js')) return {StreamMarkerSchema: model};
    if (id.endsWith('/schemas/admin.schema.js')) return {AdminSchema: model};
    if (id.endsWith('/schemas/channel_stream_summary.schema.js')) return {ChannelStreamSummarySchema: summaryModel};
    if (id.endsWith('/schemas/follow_relationship_ledger.schema.js')) return {FollowRelationshipLedgerSchema: model};
    if (id.endsWith('/classes/twitch_streamers.class.js')) return {default: {getTwitchAccountById: async () => currentCase === 'follow-missing' ? null : {name:'fixture'}}, __esModule: true};
    if (id.endsWith('/utils/stream_timeline.js')) return {TIMELINE_RETENTION_MS: 90 * 86400000, listTimelineStreams: async (_channel, page) => ({streams:[], page, hasMore:false}), getTimelineSession: async (_channel,id) => ({_id:new mongoose.Types.ObjectId(id), started_at:new Date('2026-01-01T00:00:00.000Z'), ended_at:new Date('2026-01-01T01:00:00.000Z')}), getStreamTimeline: async () => currentCase === 'missing-stream' ? null : {points:[]}};
    if (id.endsWith('/stream_timeline.route.js')) return timeline;
    throw Error(`unexpected import ${id}`);
};
function load([file]) {
    const compiled = ts.transpileModule(read(file).toString('utf8'), {fileName:file, reportDiagnostics:true, compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}});
    assert(!compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error));
    const module = {exports:{}}; new Function('require','module','exports',compiled.outputText)(dependencies,module,module.exports); return module.exports;
}
const timeline = load(sources.timeline), summary = load(sources.summary), analytics = load(sources.analytics);
const specs = [
    ['missing-token','GET','/analytics/streams/123',null],
    ['bad-channel','GET','/analytics/streams/abc','123'],
    ['access-denied','GET','/analytics/streams/123','456'],
    ['bad-page','GET','/analytics/streams/123?page=0','123'],
    ['list','GET','/analytics/streams/123','123'],
    ['invalid-stream','GET','/analytics/streams/123/not-an-id','123'],
    ['details-ok','GET','/analytics/streams/123/507f1f77bcf86cd799439011','123'],
    ['missing-stream','GET','/analytics/streams/123/507f1f77bcf86cd799439011','123'],
    ['compare-free','GET','/analytics/streams/123/507f1f77bcf86cd799439011/compare/507f1f77bcf86cd799439012','123'],
    ['compare-ok','GET','/analytics/streams/123/507f1f77bcf86cd799439011/compare/507f1f77bcf86cd799439012','123'],
    ['people-ok','GET','/analytics/streams/123/507f1f77bcf86cd799439011/people?kind=command&key=test','123'],
    ['people-free','GET','/analytics/streams/123/507f1f77bcf86cd799439011/people','123'],
    ['moments-ok','GET','/analytics/streams/123/507f1f77bcf86cd799439011/moments','123'],
    ['moments-invalid','GET','/analytics/streams/123/507f1f77bcf86cd799439011/moments?kind=invalid','123'],
    ['credits-ok','GET','/analytics/streams/123/507f1f77bcf86cd799439011/credits','123'],
    ['credits-free','GET','/analytics/streams/123/507f1f77bcf86cd799439011/credits','123'],
    ['marker-put-ok','PUT','/analytics/streams/123/507f1f77bcf86cd799439011/markers/abcdefghijklmnop','123','{"label":"note","offsetSeconds":3}'],
    ['marker-fraction-inside','PUT','/analytics/streams/123/507f1f77bcf86cd799439011/markers/abcdefghijklmnop','123','{"label":"note","offsetSeconds":3599.0005}'],
    ['marker-fraction-end','PUT','/analytics/streams/123/507f1f77bcf86cd799439011/markers/abcdefghijklmnop','123','{"label":"note","offsetSeconds":3600.0005}'],
    ['marker-invalid-date','PUT','/analytics/streams/123/507f1f77bcf86cd799439011/markers/abcdefghijklmnop','123','{"label":"note","offsetSeconds":1e20}'],
    ['marker-put-invalid','PUT','/analytics/streams/123/507f1f77bcf86cd799439011/markers/no','123','{}'],
    ['marker-put-malformed','PUT','/analytics/streams/123/507f1f77bcf86cd799439011/markers/abcdefghijklmnop','123','{'],
    ['marker-delete-ok','DELETE','/analytics/streams/123/507f1f77bcf86cd799439011/markers/507f1f77bcf86cd799439012','123'],
    ['marker-delete-invalid','DELETE','/analytics/streams/123/507f1f77bcf86cd799439011/markers/no','123'],
    ['summary-list-ok','GET','/stream-summaries/123','123'],
    ['summary-forbidden','GET','/stream-summaries/123','456'],
    ['summary-detail-ok','GET','/stream-summaries/123/507f1f77bcf86cd799439011','123'],
    ['summary-invalid-id','GET','/stream-summaries/123/not-an-id','123'],
    ['follow-missing','GET','/analytics/follows/123','123'],
    ['follow-ok','GET','/analytics/follows/123','123'],
    ['follow-forbidden','GET','/analytics/follows/123','123'],
];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
(async () => {
    const [mode, dir, ...extra] = process.argv.slice(2);
    assert(['--write','--check'].includes(mode) && dir && path.isAbsolute(dir) && !extra.length);
    assert.equal(fs.realpathSync(dir), dir); assert(dir !== root && !dir.startsWith(root + path.sep));
    if (mode === '--write') assert.deepEqual(fs.readdirSync(dir), []);
    const app = express(); app.use(express.json()); app.use('/analytics', analytics.analyticsRoute); app.use('/stream-summaries', summary.streamSummaryRoute);
    const server = http.createServer(app);
    try {
        const port = await listen(server), cases = [];
        for (const [name, method, url, user, body] of specs) {
            currentCase = name;
            const headers = user ? {'x-user':user, authorization:'Bearer fixture-token'} : {};
            if (body !== undefined) headers['content-type'] = 'application/json';
            const response = await fetch(`http://127.0.0.1:${port}${url}`, {method, headers, body});
            const text = await response.text();
            const isJson = response.headers.get('content-type')?.includes('application/json');
            cases.push({name, request:{method,url,user,...(body === undefined ? {} : {body})}, expected:{status:response.status, body:isJson ? JSON.parse(text) : null, bodyText:isJson ? text : null, contentType:response.headers.get('content-type'), cacheControl:response.headers.get('cache-control')}});
        }
        const text = JSON.stringify({metadata:{sources,node:process.versions.node,typescript:ts.version,scope:'route operations with in-memory data adapters'},cases},null,2)+'\n';
        const target = path.join(dir,'stream-timeline-routes-reference.json');
        if (mode === '--write') fs.writeFileSync(target,text,{flag:'wx'}); else assert.equal(fs.readFileSync(target,'utf8'),text);
        console.log(`${mode} ${target} sha256=${crypto.createHash('sha256').update(text).digest('hex')}`);
    } finally { await close(server); }
})().catch(error => { console.error(error); process.exitCode = 1; });
