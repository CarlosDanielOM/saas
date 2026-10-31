'use strict';
// Actual-source site route oracle. Run only in the pinned isolated toolchain:
//   node tests/fixtures/site_analytics_reference.cjs --write <absolute-empty-dir>
//   node tests/fixtures/site_analytics_reference.cjs --check <absolute-dir>
// Requires Node 24.22.1, TypeScript 5.9.3, Mongoose 8.24.2, BSON 6.10.4,
// and the workspace's Express. Writes site-analytics-reference.json.
// Express and body-parser run for real over loopback; Mongo model persistence,
// Redis, logger and auth middleware are in-memory boundaries. No real database,
// cache or Twitch endpoint is contacted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const Module = require('node:module');
const http = require('node:http');
const root = fs.realpathSync(process.env.DIMA_SITE_ANALYTICS_ROUTE_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript');
const express = local('express');
const mongoose = local('mongoose');
const bsonRequire = Module.createRequire(local.resolve('mongoose'));
const bsonPath = bsonRequire.resolve('bson');
const bsonVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(bsonPath), '..', 'package.json'), 'utf8')).version;
assert.equal(process.versions.node, '24.22.1');
assert.equal(ts.version, '5.9.3');
assert.equal(mongoose.version, '8.24.2');
assert.equal(bsonVersion, '6.10.4');
const sourceFile = 'src/server/routes/site.route.ts';
const sourceBytes = fs.readFileSync(path.join(root, sourceFile));
const sha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
const pinnedSourceSha256 = '8a0854361b66f0759d885f8fe8aab12d075cf99faa36dc42de763d72d413c706';
assert.equal(sha256, pinnedSourceSha256, 'route source changed');
function compile(text, file) {
    const result = ts.transpileModule(text, {fileName: file, reportDiagnostics: true,
        compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true}});
    assert(!result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error));
    return result.outputText;
}
function load(text, file, resolve) {
    const moduleRecord = {exports: {}};
    new Function('require', 'module', 'exports', compile(text, file))(resolve, moduleRecord, moduleRecord.exports);
    return moduleRecord.exports;
}
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
// These are the actual EventSub declarations, extracted to avoid importing
// unrelated provider modules. Their bodies and constants are not reimplemented.
const eventsubFile = 'src/utils/eventsub.ts';
const eventsubSource = read(eventsubFile);
const ast = ts.createSourceFile(eventsubFile, eventsubSource, ts.ScriptTarget.ES2022, true);
const wanted = new Set(['CANONICAL_BITS_EVENT_TYPE', 'LEGACY_BITS_EVENT_TYPES', 'isLegacyBitsEventType', 'canonicalizeEventsubType', 'getEquivalentEventsubTypes']);
const selected = ast.statements.filter(statement => {
    if (ts.isFunctionDeclaration(statement)) return wanted.has(statement.name?.text);
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(d => wanted.has(d.name.getText(ast)));
    return false;
});
assert.equal(selected.length, wanted.size);
const eventsub = load(selected.map(statement => statement.getText(ast)).join('\n'), eventsubFile, local);
const defaultsFile = 'src/utils/chat_notification_defaults.ts';
const defaults = load(read(defaultsFile), defaultsFile, local);
const catalogFile = 'src/utils/chat_event_catalog.ts';
const catalog = load(read(catalogFile), catalogFile, id => {
    if (id.endsWith('chat_notification_defaults.js')) return defaults;
    throw Error(`unexpected catalog import ${id}`);
});
const instance = new mongoose.Mongoose();
instance.set('autoCreate', false);
instance.set('autoIndex', false);
const schemaFile = 'src/schemas/event.schema.ts';
const schemaApi = load(read(schemaFile), schemaFile, id => {
    assert.equal(id, 'mongoose');
    return {Schema: instance.Schema, model: instance.model.bind(instance), Types: instance.Types};
});
const RealEvent = schemaApi.EventSchema;
const FIXED_ID = '507f1f77bcf86cd799439011';
const FIXED_TIME = new Date('2026-01-01T00:00:00.000Z');
RealEvent.schema.path('createdAt').default(() => FIXED_TIME);
RealEvent.schema.path('updatedAt').default(() => FIXED_TIME);
const rows = [];
function lean(value) { return {sort() { return this; }, async lean() { return value; }}; }
function EventModel(input) {
    const doc = new RealEvent({...input, _id: FIXED_ID});
    doc.save = async () => { await doc.validate(); doc.__v = 0; rows.push(doc.toObject()); return doc; };
    return doc;
}
EventModel.findOne = async filter => rows.find(row => filter.type.$in.includes(row.type)) || null;
EventModel.find = filter => lean(filter?.type?.$in ? rows.filter(row => filter.type.$in.includes(row.type)) : [...rows].reverse());
EventModel.findByIdAndUpdate = (id, update) => {
    const row = rows.find(value => String(value._id) === id);
    if (row) Object.assign(row, update);
    return lean(row || null);
};
const errors = [];
const routeApi = load(sourceBytes.toString('utf8'), sourceFile, id => {
    if (id === 'express') return express;
    if (id === 'mongoose') return instance;
    if (id.endsWith('/schemas/event.schema.js')) return {EventSchema: EventModel};
    if (id.endsWith('/databases/dragonfly.database.js')) return {getDragonflyClient: async () => ({})};
    if (id.endsWith('/middleware/auth.middleware.js')) return {authMiddleware: (_req, _res, next) => next()};
    if (id.endsWith('/utils/logger.js')) return {error: async (value, options) => { errors.push({value, options}); }};
    if (id.endsWith('/utils/eventsub.js')) return eventsub;
    if (id.endsWith('/utils/chat_event_catalog.js')) return catalog;
    throw Error(`unexpected route import ${id}`);
});
const input = {name:'Fixture',type:'fixture.event',version:'1',condition:{broadcaster_user_id:'user'},icon:'Star',color:'#fff',textColor:'#000',plan_tier:'free',description:{EN:'English',ES:'Español'},config:[{_id:'507f1f77bcf86cd799439012',id:'message',label:{EN:'Message',ES:'Mensaje'},type:'text',value:'hi'}]};
// Exercise the actual Mongoose constructor and update caster independently
// from the route persistence double. Normalize generated IDs and clocks only.
function normalized(value) {
    return JSON.parse(JSON.stringify(value), (_key, v) => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v) ? '<object-id>' : typeof v === 'string' && /^\d{4}-.*T.*Z$/.test(v) ? '<date>' : v);
}
const schemaSpecs = [
    ['empty-mixed', {...input,condition:{},config:[{id:'x',label:{EN:'E',ES:'S'},value:{},showIf:{controlId:'x',is:{}}}]}],
    ['defaults', {...input, version:undefined, plan_tier:undefined, config:undefined}],
    ['casting', {...input, name:123, enabled:'yes', tierLimits:{free:'3'}, config:[{id:' id ',label:{EN:' E ',ES:' S '},value:false}]}],
    ['generated-id-showif', {...input,config:[{id:'x',label:{EN:'E',ES:'S'},value:0,showIf:{controlId:'flag',is:false}}]}],
    ['missing-condition', {...input,condition:undefined}],
    ['missing-nested-description', {...input,description:{EN:'E'}}],
    ['missing-showif', {...input,config:[{id:'x',label:{EN:'E',ES:'S'},value:0,showIf:{controlId:'flag'}}]}],
    ['invalid-enum', {...input,releaseStage:'invalid'}],
    ['null-config', {...input,config:null}],
];
const schemaCases=schemaSpecs.map(([name, raw]) => {
    const input=JSON.parse(JSON.stringify(raw));const doc=new RealEvent(input);const err=doc.validateSync();
    return {name,input,valid:!err,expected:err ? null : normalized(doc.toObject())};
});
const patchSpecs = [
    ['trim-number-bool',{name:' New ',version:3,enabled:'false',unknown:'discard'}],
    ['no-validation',{releaseStage:'invalid',name:''}],
    ['nested',{description:{EN:' E ',ES:' S '},tierLimits:{free:'3'}}],
    ['dotted',{'description.EN':' E ','tierLimits.free':'3'}],
    ['cast-error',{enabled:'invalid'}],
    ['null',{description:null}],
];
const patchCases=patchSpecs.map(([name,input]) => {
    const query=RealEvent.findByIdAndUpdate(FIXED_ID,input,{new:true});
    try { return {name,input,valid:true,expected:normalized(query._castUpdate(query.getUpdate()))}; }
    catch(err) {return {name,input,valid:false,expected:null};}
});

const specs = [
    ['root','GET','/'], ['create','POST','/events',input], ['duplicate','POST','/events',input],
    ['missing','POST','/events',{}], ['bad-tier','POST','/events',{...input,type:'other',plan_tier:'invalid'}],
    ['bad-label','POST','/events',{...input,type:'other',config:[{id:'message',label:{EN:'Message'},type:'text',value:'hi'}]}],
    ['list','GET','/events'], ['get','GET','/events/fixture.event'], ['get-missing','GET','/events/fixture.missing'],
    ['patch','PATCH',`/events/${FIXED_ID}`,{name:'Updated'}], ['patch-invalid','PATCH','/events/not-an-id',{}],
    ['patch-missing','PATCH','/events/000000000000000000000000',{name:'none'}],
    ['patch-malformed','PATCH',`/events/${FIXED_ID}`,null,'{'],
];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
(async () => {
    const [mode, directory, ...extra] = process.argv.slice(2);
    assert(['--write','--check'].includes(mode) && directory && path.isAbsolute(directory) && !extra.length);
    assert.equal(fs.realpathSync(directory), directory);
    assert(directory !== root && !directory.startsWith(root + path.sep));
    if (mode === '--write') assert.deepEqual(fs.readdirSync(directory), [], 'write directory must be empty');
    const app = express();
    app.use(express.json());
    app.use('/site', routeApi.siteRoute);
    const server = http.createServer(app);
    try {
        const port = await listen(server);
        const cases = [];
        for (const [name, method, route, body, raw] of specs) {
            const rawBody = raw ?? (body === undefined ? undefined : JSON.stringify(body));
            const response = await fetch(`http://127.0.0.1:${port}/site${route}`, {method,
                headers: rawBody === undefined ? {} : {'content-type':'application/json'}, body:rawBody});
            const text = await response.text();
            const json = response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : null;
            cases.push({name, request:{method, path:route, body:body ?? null, rawBody:raw ?? null}, expected:{status:response.status, body:json}});
        }
        const rendered = JSON.stringify({metadata:{source:sourceFile, sha256:pinnedSourceSha256,
            node:process.versions.node, typescript:ts.version, mongoose:mongoose.version, bson:bsonVersion,
            malformedBody:'Express default HTML; body omitted as environment-dependent'}, cases, schemaCases, patchCases}, null, 2) + '\n';
        const target = path.join(directory, 'site-analytics-reference.json');
        if (mode === '--write') fs.writeFileSync(target, rendered, {flag:'wx'});
        else assert.equal(fs.readFileSync(target, 'utf8'), rendered);
        console.log(`${mode} ${target} sha256=${crypto.createHash('sha256').update(rendered).digest('hex')}`);
    } finally { await close(server); }
})().catch(error => { console.error(error); process.exitCode = 1; });
