// Actual TypeScript + Mongoose oracle. Run only in the owner's isolated container:
// node tests/fixtures/channel_tts_settings_reference.mjs --write|--check DIR [--mongo]
// --mongo requires the explicit owner, fixture-only URI and a fresh named DB.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const files = {
  schema:'src/schemas/channel_tts_settings.schema.ts', users:'src/schemas/users.schema.ts',
  tags:'src/utils/tts/expressive_tts_tags.util.ts', voices:'src/utils/tts/kokoro_voices.util.ts'
};
const archiveRoot = path.resolve(root, '../archives/dimabot-typescript/2026-10-28');
const exists = async file => {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
export async function loadSource() {
  assert.equal(process.versions.node, '24.22.1');
  assert.equal(process.versions.v8, '13.6.233.17-node.58');
  const ts = require('typescript'), mongoose = require('mongoose');
  assert.equal(ts.version, '5.9.3'); assert.equal(mongoose.version, '8.24.2');
  const instance = new mongoose.Mongoose();
  // Fixture setup creates collections/indexes explicitly after freshness checks.
  instance.set("autoCreate", false);
  instance.set("autoIndex", false);
  const schemaPaths = [path.join(root, files.schema), path.join(archiveRoot, files.schema)];
  const schemaPresence = await Promise.all(schemaPaths.map(exists));
  if (schemaPresence.filter(Boolean).length !== 1) throw new Error('channel TTS settings schema must exist at exactly one source or archive path');
  const resolvedPaths = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, key === 'schema' ? schemaPaths[schemaPresence.indexOf(true)] : path.join(root, file)]));
  const sourcePaths = Object.fromEntries(Object.entries(resolvedPaths).map(([key, file]) => [files[key], path.relative(root, file)]));
  const sources = Object.fromEntries(await Promise.all(Object.entries(resolvedPaths).map(async ([key,file]) => [key,await fs.readFile(file,'utf8')])));
  const hashes = Object.fromEntries(Object.entries(files).map(([k,p]) => [p,hash(sources[k])]));
  for (const p of ['package.json','package-lock.json','node_modules/typescript/package.json','node_modules/mongoose/package.json']) hashes[p] = hash(await fs.readFile(path.join(root,p)));
  for (const p of ['typescript','mongoose']) hashes[`${p}-entry`] = hash(await fs.readFile(require.resolve(p)));
  hashes['node-executable'] = hash(await fs.readFile(process.execPath));
  hashes['tests/fixtures/channel_tts_settings_reference.mjs'] = hash(await fs.readFile(fileURLToPath(import.meta.url)));
  const loaded = {};
  const localMongoose = {Schema:instance.Schema,model:instance.model.bind(instance),Types:instance.Types};
  const compile = key => {
    if (loaded[key]) return loaded[key];
    const exports = {}; loaded[key] = exports;
    const imports = {'mongoose':() => localMongoose,'./users.schema.js':() => compile('users'),
      '../utils/tts/expressive_tts_tags.util.js':() => compile('tags'),
      '../utils/tts/kokoro_voices.util.js':() => compile('voices')};
    const source = ts.transpileModule(sources[key],{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new vm.Script(`(function(exports,require){${source}\n})`,{filename:files[key]}).runInThisContext()(exports,id => {
      if (!Object.hasOwn(imports,id)) throw Error(`forbidden import ${id} from ${key}`);
      return imports[id]();
    });
    return exports;
  };
  const api = compile('schema');
  return {api,instance,users:compile('users'),tags:compile('tags'),hashes,sourcePaths};
}
// Input JSON is stored as a string so escaped lone UTF-16 surrogates survive the
// outer fixture reader. Special numeric values use explicit path + token pairs.
export function pureCases(tags) {
  const cases = [];
  const add = (name,input,opts={}) => cases.push({name,inputJson:input === undefined ? null : JSON.stringify(input),...opts});
  add('undefined',undefined); add('null',null); add('empty',{});
  add('nested-null',{voices:null,filters:null,queue:null}); add('nested-empty',{voices:{},filters:{},queue:{}});
  for (const value of [null,false,0,'','  ',true,1,[],[' x '],{}, {toString:5},'  😀\ud800\udc00\udfff  ']) add(`channel-${cases.length}`,{channel:value});
  for (const value of ['piper','fish','kokoro','xai','openrouter','Fish',null,7]) add(`provider-${String(value)}`,{provider:value});
  for (const value of ['en','es','EN',null,0]) add(`language-${String(value)}`,{defaultLanguage:value});
  for (const value of [null,false,0,'yes',[],{}]) add(`flags-${cases.length}`,{enabled:value,filters:{skipEmotes:value,stripLinks:value,normalizeWhitespace:value}});
  for (const value of [null,false,0,'',true,42,[],['  a  '],{}, {toString:null},'  😀\ud800  ']) add(`voices-${cases.length}`,{voices:{en:value,es:value,cloneDefault:value,kokoroDefault:value}});
  for (const value of [' AF_BELLA ','ef_dora','Ef_Dora','nope','\ud800']) add(`kokoro-${cases.length}`,{voices:{kokoroDefault:value}});
  for (const value of [null,false,true,0,-100,1,29.9,30,280,500,501,1e10,'',' ','12.9','-12.9','0x20','0b101','0o77','1e3','Infinity','abc',[],[9],[1,2],{},[null]]) add(`number-${cases.length}`,{filters:{maxLength:value},queue:{maxItems:value}});
  for (const value of ['NaN','Infinity','-Infinity','-0']) add(`special-${value}`,{filters:{maxLength:null},queue:{maxItems:null}},{special:[['filters.maxLength',value],['queue.maxItems',value]]});
  for (const tag of tags) {
    const key = tag === 'long-pause' ? 'longPause' : tag;
    add(`tag-${tag}`,{filters:{expressiveTags:{[tag]:null,inline:{[key]:false},wrapping:{[key]:true}}}});
    add(`tag-block-${tag}`,{filters:{expressiveTags:{[tag]:'false',inline:{[key]:false}}}});
    add(`tag-wrap-${tag}`,{filters:{expressiveTags:{inline:{[key]:null},wrapping:{[key]:false}}}});
  }
  return cases;
}
export function decodeCase(c) {
  const input = c.inputJson === null ? undefined : JSON.parse(c.inputJson);
  for (const [key,token] of c.special ?? []) { const [a,b] = key.split('.'); input[a][b] = token === '-0' ? -0 : Number(token); }
  return input;
}
function result(fn) { try {return {ok:true,outputJson:JSON.stringify(fn())};} catch(e) {return {ok:false,error:{name:e.name}};} }
const schemaInputs = [
  {},{channelID:'x'}, {channelID:''},{channelID:null},{channelID:42},
  {channelID:'x',provider:'bad',defaultLanguage:'bad'},
  {channelID:'x',enabled:'false',voices:{en:123},filters:{maxLength:'31',expressiveTags:{happy:'false'}},queue:{maxItems:'8'}},
  {channelID:'x',enabled:null,voices:{en:null},filters:{maxLength:null},queue:{maxItems:null}},
  {channelID:'x',enabled:'bad',filters:{maxLength:'bad'},queue:{maxItems:{}}},
  {channelID:'x',voices:null,filters:null,queue:null},
  {channelID:'x',voices:{},filters:{},queue:{}}
];
function schemaCase(model,input) {
  const doc = new model({...input,_id:'507f1f77bcf86cd799439011'});
  const error = doc.validateSync();
  if (error) return {errors:Object.keys(error.errors).sort().map(path => ({path,name:error.errors[path].name,kind:error.errors[path].kind}))};
  return {document:doc.toObject({versionKey:true})};
}
async function mongoCases(source) {
  assert.equal(process.env.DIMA_RUST_TEST_RESOURCE_OWNER,'dimabot-migration');
  const uri = process.env.APPLICATION_SCHEMAS_TEST_MONGO_URI;
  const name = process.env.APPLICATION_SCHEMAS_TEST_DATABASE;
  assert.ok(/^rust_schema_fixture_[a-zA-Z0-9_]+$/.test(name ?? ''));
  // Explicit fixture host list only; credentials, SRV, multiple hosts and query overrides are forbidden.
  assert.ok(/^mongodb:\/\/(?:127\.0\.0\.1|localhost|keyword-mongo|(?:dima|rust)[a-z0-9-]*mongo[a-z0-9-]*):[0-9]+\/?$/.test(uri ?? ''),'fixture-only Mongo URI required');
  const dbName = `${name}_channel_tts_source`;
  let fixtureNow = 1900000000000;
  source.instance.now = () => new Date(fixtureNow);
  await source.instance.connect(uri,{dbName,autoIndex:false,autoCreate:false});
  const db = source.instance.connection.db;
  let fresh = false;
  try {
    assert.equal((await db.listCollections().toArray()).length,0,'fixture DB must be fresh');
    fresh = true;
    const model = source.api.ChannelTtsSettingsSchema;
    await model.createIndexes();
    const users = db.collection(source.users.default.collection.name);
    const records = db.collection(model.collection.name);
    const outcomes = {};
    outcomes.missing = await source.api.getChannelTtsSettings('missing','fallback');
    outcomes.missingCount = await records.countDocuments({});
    await users.insertMany([{accounts:[{type:'youtube',id:'mismatch'}],tts_default_provider:'kokoro'},
      {accounts:[{type:'twitch',id:'marked'}],tts_default_provider:'kokoro'},
      {accounts:[{type:'twitch',id:'unmarked'}]}]);
    for (const id of ['mismatch','marked','unmarked']) outcomes[id] = await source.api.getChannelTtsSettings(id,'channel');
    await source.api.upsertChannelTtsSettings('marked',{provider:'fish',voices:{en:'custom'},filters:{maxLength:99}},'first');
    outcomes.saved = await source.api.getChannelTtsSettings('marked','ignored');
    fixtureNow += 1000;
    await source.api.upsertChannelTtsSettings('marked',{provider:'piper',voices:{es:'nuevo'}},'second');
    outcomes.updated = await source.api.getChannelTtsSettings('marked','ignored');
    const savedRaw = await records.findOne({channelID:'marked'});
    delete savedRaw._id; outcomes.savedRaw = savedRaw;
    await records.updateOne({channelID:'marked'},{$set:{sentinel:'keep', 'voices.en':'before', 'filters.maxLength':123}});
    await Promise.all([source.api.setChannelFishVoice('marked','voice','ignored'), records.updateOne({channelID:'marked'},{$set:{'voices.en':'concurrent','queue.maxItems':11}})]);
    outcomes.fishExisting = await source.api.getChannelTtsSettings('marked','ignored');
    outcomes.fishExistingRaw = await records.findOne({channelID:'marked'},{projection:{_id:0}});
    await source.api.setChannelFishVoice('fish-new','new-voice','new-channel');
    outcomes.fishInserted = await source.api.getChannelTtsSettings('fish-new','ignored');
    outcomes.fishRaw = await records.findOne({channelID:'fish-new'},{projection:{_id:0}});
    await source.api.setChannelFishVoice('', 'empty-voice', 'empty-channel');
    outcomes.emptyFishRaw = await records.findOne({channelID:''},{projection:{_id:0}});
    try { await source.api.upsertChannelTtsSettings('', {}, ''); outcomes.emptySaveError = null; } catch(e) { outcomes.emptySaveError = {name:e.name,errors:Object.keys(e.errors ?? {}).sort().map(path=>({path,name:e.errors[path].name,kind:e.errors[path].kind}))}; }
    await source.api.upsertChannelTtsSettings('no-op',{},'same');
    outcomes.noopBefore = await records.findOne({channelID:'no-op'},{projection:{_id:0}});
    fixtureNow += 1000;
    await source.api.upsertChannelTtsSettings('no-op',{},'same');
    outcomes.noopAfter = await records.findOne({channelID:'no-op'},{projection:{_id:0}});
    await records.insertOne({channelID:'legacy',channel:'legacy-channel',voices:{en:'legacy',unknown:'nested'},filters:{maxLength:88,unknown:'nested-filter'},sentinel:'legacy-top',createdAt:new Date(1899999999000),updatedAt:new Date(1899999999000),__v:0});
    outcomes.legacyBefore = await records.findOne({channelID:'legacy'},{projection:{_id:0}});
    const legacyInput = await source.api.getChannelTtsSettings('legacy','legacy-channel');
    fixtureNow += 1000;
    await source.api.upsertChannelTtsSettings('legacy',legacyInput,'legacy-channel');
    outcomes.legacyAfter = await records.findOne({channelID:'legacy'},{projection:{_id:0}});
    try { await records.insertOne({channelID:'marked'}); outcomes.uniqueError=false; } catch(e) { outcomes.uniqueError=e.code === 11000; }
    return outcomes;
  } finally { if (fresh) await db.dropDatabase(); await source.instance.disconnect(); }
}
export async function generate(withMongo=false) {
  const source = await loadSource();
  const {api,tags} = source;
  const cases = pureCases(tags.EXPRESSIVE_TTS_TAGS).map(c => ({...c,...result(() => api.normalizeChannelTtsSettings(decodeCase(c),'id-😀\ud800',' fallback '))}));
  const a = api.createDefaultChannelTtsSettings('a',''); const b = api.createDefaultChannelTtsSettings('b','');
  a.voices.en='mutated'; a.filters.expressiveTags.happy=false; a.queue.maxItems=99;
  const model=api.ChannelTtsSettingsSchema;
  const metadata={model:model.modelName,collection:model.collection.name,indexes:model.schema.indexes().map(([keys,options])=>({keys,unique:!!options.unique})),timestamps:model.schema.options.timestamps};
  return {schema:1,provenance:{node:process.version,v8:process.versions.v8,typescript:'5.9.3',mongoose:'8.24.2',hashes:source.hashes,sourcePaths:source.sourcePaths,loader:'actual source with restricted imports and real isolated Mongoose instance',projection:'schema: fixed _id; Mongo: omit generated _id only; Mongoose clock controlled at 1900000000000ms and explicit +1000/+2000/+3000ms steps'},metadata,defaultAfterMutation:b,cases,schemaCases:schemaInputs.map(input=>({input,expected:schemaCase(model,input)})),...(withMongo ? {mongo:await mongoCases(source)} : {})};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode,dir,...flags]=process.argv.slice(2);
  assert.ok(['--write','--check'].includes(mode) && dir && (flags.length===0 || (flags.length===1 && flags[0]==='--mongo')),'usage: --write|--check DIR [--mongo]');
  const doc=JSON.stringify(await generate(flags.length===1),null,2)+'\n';
  const target=path.join(path.resolve(dir),flags.length ? 'channel-tts-settings-mongo.json':'channel-tts-settings-reference.json');
  if(mode==='--write'){await fs.mkdir(path.resolve(dir),{recursive:true});await fs.writeFile(target,doc);} else {const previous=await fs.readFile(target,'utf8');assert.ok(previous.length>0);assert.equal(previous,doc,'fixture differs');}
  console.log(JSON.stringify({cases:JSON.parse(doc).cases.length,schemaCases:schemaInputs.length,mongo:flags.length===1}));
}
