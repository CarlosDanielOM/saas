// Run in an isolated checkout: node tests/fixtures/eventsub_remote_reference.cjs OUTPUT.json
// The functions below are extracted from the actual TypeScript AST, not copies.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const ts = requireFromRoot('typescript');
const mongoose = requireFromRoot('mongoose');
const bson = requireFromRoot('bson');
const setDefaultsOnInsert = requireFromRoot('mongoose/lib/helpers/setDefaultsOnInsert');
// The TypeScript schema was retired; use its preserved actual source.
const schemaPath = path.resolve(root, '../archives/dimabot-typescript/2026-10-28/src/schemas/eventsub.schema.ts');
const schemaJs = ts.transpileModule(fs.readFileSync(schemaPath, 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.CommonJS}}).outputText;
const schemaModule = {exports:{}};
new Function('require', 'module', 'exports', schemaJs)(requireFromRoot, schemaModule, schemaModule.exports);
const Model = schemaModule.exports.default;
function castActualQuery(filter, update) {
  // Mirrors _findOneAndUpdate in installed mongoose/lib/query.js, without executing I/O.
  // Model.findOneAndUpdate adds __v before query casting.
  const query = Model.findOneAndUpdate(filter, update, {upsert:true, new:true, setDefaultsOnInsert:true});
  query._castConditions();
  if (query.error()) throw query.error();
  const cast = query._castUpdate(query.getUpdate());
  const updated = setDefaultsOnInsert(query.getFilter(), Model.schema, cast, {upsert:true, setDefaultsOnInsert:true});
  // The installed driver defaults ignoreUndefined to false: preserve its wire result.
  const wire = bson.deserialize(bson.serialize({filter:query.getFilter(), update:updated}, {ignoreUndefined:false}));
  return {queryIdUndefined: Object.hasOwn(query.getFilter(), 'id') && query.getFilter().id === undefined, filter:wire.filter, update:wire.update};
}
const sourcePath = path.join(root, 'src/utils/eventsub.ts');
const scopePath = path.join(root, 'src/functions/users/get_scopes.users.ts');
function extract(file, names) {
  const text = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const declaration = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
    if (!declaration) throw Error(`missing actual source declaration ${name}`);
    return declaration.getText(ast).replace(/^export\s+/, '');
  }).join('\n');
}
const code = extract(sourcePath, ['sortValueDeep', 'serializeCondition', 'toEventsubResponse', 'findExistingEventsub', 'subscribeTwitchEvent', 'unsubscribeTwitchEvent']) + '\n' + extract(scopePath, ['getScopes']);
const js = ts.transpileModule(code, {compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.None}}).outputText;
let rows = [], incoming, calls = [], responseStatus = 202, token = 'token', captureMongoose = false;
const context = vm.createContext({
  process: {env:{TWITCH_EVENTSUB_SECRET:'secret', CLIENT_ID:'client'}},
  console: {error() {}}, URLSearchParams, Date,
  TwitchStreamers: {getTwitchAccountById: async () => ({name:'channel-name'})},
  getTwitchStreamerHeaderById: async () => ({header:{}}),
  getAppToken: async () => token,
  getTwitchHelixUrl: (endpoint, query) => `https://fixture/${endpoint}${query ? '?' + query : ''}`,
  raidConfigType: (type) => type,
  EventsubSchema: {
    find: () => ({lean: async () => rows}),
    findOneAndUpdate: (filter, update) => ({lean: async () => { calls.push(captureMongoose ? castActualQuery(filter, update) : {filter, set:update.$set}); return update.$set; }}),
    deleteOne: async filter => { calls.push({delete:filter}); },
  },
  fetch: async (url, options) => {calls.push({url, method:options.method || 'GET', body: options.body && JSON.parse(options.body)}); return {status:responseStatus, ok:responseStatus >= 200 && responseStatus < 300, json:async () => incoming};},
});
vm.runInContext(js, context);
async function run() {
  const conditions = [
    [{x:false, nested:{'\ue000':1,'😀':2}, '10':'a', '2':'b'}, {nested:{'😀':2,'\ue000':1},x:false,'2':'b','10':'a'}],
    ['ab', {'0':'a','1':'b'}], [[false,0], {'0':false,'1':0}], [42, {}],
    [{extra:''}, {}], [{extra:[]}, {}],
  ];
  const matches = [];
  for (const [stored, requested] of conditions) {
    rows = [{id:'existing', condition:stored}]; calls = [];
    const result = await context.subscribeTwitchEvent('channel','type','1',requested);
    matches.push({stored,requested,matched:result.id === 'existing'});
  }
  rows = []; calls = []; incoming = {data:[true]};
  const primitiveResult = await context.subscribeTwitchEvent('channel','type','1',{extra:{nested:true}},undefined,{ignoreExisting:true});
  const primitive = {result:primitiveResult,calls};
  const upserts = [];
  for (const [name, remote, config] of [
    ['absent', {}, undefined], ['null', {id:null}, undefined],
    ['overridden', {id:'source'}, {id:'override'}], ['normal', {id:'normal'}, undefined],
  ]) {
    calls = []; incoming = {data:[remote]}; captureMongoose = true;
    await context.subscribeTwitchEvent('channel','type','1',{},config,{ignoreExisting:true});
    upserts.push({name, ...calls.find(call => call.filter)});
  }
  captureMongoose = false;
  calls = []; responseStatus = 404;
  const deleted = await context.unsubscribeTwitchEvent('a&other=b#fragment');
  const unsubscribe = {status:deleted.status, ok:deleted.ok, calls};
  calls = []; incoming = null; responseStatus = 200;
  const scopesNull = await context.getScopes('u');
  const artifact = {implementation:'actual-typescript-ast', sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'), scopesSha256:crypto.createHash('sha256').update(fs.readFileSync(scopePath)).digest('hex'), node:process.version, typescript:ts.version, mongoose:mongoose.version, schemaSha256:crypto.createHash('sha256').update(fs.readFileSync(schemaPath)).digest('hex'), matches, primitive, upserts, unsubscribe, scopesNull};
  fs.writeFileSync(process.argv[2], JSON.stringify(artifact,null,2)+'\n', {flag:'wx'});
}
run().catch(error => {console.error(error);process.exitCode=1});
