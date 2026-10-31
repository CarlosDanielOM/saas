'use strict';
// Execute only in the pinned isolated oracle environment. No database or cache.
// node pet_settings_service_reference.cjs --write /absolute/empty/directory
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict'), Module = require('node:module');
const root = fs.realpathSync(process.env.DIMA_PET_SETTINGS_SOURCE_ROOT || path.resolve(__dirname, '../..'));
const local = Module.createRequire(path.join(root, 'package.json'));
const ts = local('typescript'), mongoose = local('mongoose');
assert.equal(process.versions.node, '24.22.1'); assert.equal(ts.version, '5.9.3'); assert.equal(mongoose.version, '8.24.2');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('src/server/services/pet_settings.service.ts');
assert.equal(crypto.createHash('sha256').update(source).digest('hex'), '58579d0f9b07434be855722add0028ec69aab17f68dfb5e64731c4064d382ee2');
function load(code, file, resolver) { const output = ts.transpileModule(code, {fileName:file, compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText; const m = {exports:{}}; new Function('require','module','exports',output)(resolver,m,m.exports); return m.exports; }
// The original catalog was retired from the active tree and is preserved in the archive.
const kokoroSource = fs.readFileSync(path.join(root, '../archives/dimabot-typescript/2026-10-28/src/utils/tts/kokoro_voices.util.ts'), 'utf8');
assert.equal(crypto.createHash('sha256').update(kokoroSource).digest('hex'), '6d06216a94959645a4ed75e82a2b68a39b329c01373f63644f7a3794afc5466b');
const kokoro = load(kokoroSource, 'kokoro.ts', id => { throw Error(id); });
// Extract only the real catalog declaration so the Fish SDK is never initialized.
const fishText = read('src/server/services/tts/fish_tts.service.ts');
const tree = ts.createSourceFile('fish.ts', fishText, ts.ScriptTarget.ES2022, true);
const fishDeclaration = tree.statements.find(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(tree) === 'FISH_VOICES'));
assert(fishDeclaration);
const fish = load(fishDeclaration.getText(tree), 'fish.ts', id => { throw Error(id); });
let state;
const query = get => ({select() { return this; }, async lean() { return get(); }});
const PetSettingsSchema = {
 findOne() { return query(() => state.record); },
 async init() { state.calls.push('index'); },
 async create(row) { state.calls.push('write'); if (state.record) { const e = new Error('duplicate'); e.code = 11000; throw e; } state.record = {...row}; },
 async findOneAndUpdate(filter, update) { state.calls.push('write'); if (!state.record || state.record.revision !== filter.revision) return null; Object.assign(state.record,update.$set); return state.record; }
};
const UsersSchema = {findOne() { return query(() => state.plan === 'denied' ? null : {plan_tier:state.plan}); }};
const ChannelAIPersonalitySchema = {findOne() { return query(() => state.personality); }, async exists(filter) { return !!state.personality?.profiles?.some(p => p.profileID === filter['profiles.profileID']); }};
const PetRuntime = {findById() { return query(() => state.runtime); }};
const library = {registerAssetConsumer(){}, async findAsset(_owner,id) { state.calls.push('asset:'+id); const asset = state.assets[id]; if (!asset) { const e = new Error('not_found'); e.code='not_found'; e.status=404; throw e; } return asset; }, async withAssetLibrary(_owner,fn) { state.calls.push('lock'); try { return await fn(); } finally { state.calls.push('unlock'); } }};
const api = load(source, 'pet_settings.service.ts', id => {
 if (id === 'mongoose') return mongoose;
 if (id.endsWith('kokoro_voices.util.js')) return kokoro;
 if (id.endsWith('fish_tts.service.js')) return fish;
 if (id.endsWith('queue_limits.js')) return {PET_DEFAULT_QUEUE_SIZE:5,PET_MAX_QUEUE_SIZE:10};
 if (id.endsWith('library.js')) return library;
 if (id.endsWith('pet_settings.schema.js')) return {PetSettingsSchema};
 if (id.endsWith('pet_runtime.schema.js')) return {PetRuntime};
 if (id.endsWith('channel_ai_personality.schema.js')) return {ChannelAIPersonalitySchema};
 if (id.endsWith('users.schema.js')) return {default:UsersSchema};
 if (id.endsWith('state.js')) return {async invalidatePet() { state.calls.push('invalidate'); if (state.invalidateError) { const e=new Error('failed'); e.code='invalidate_failed'; e.status=503; throw e; } }};
 if (id.endsWith('peers.js')) return {async validatePetSessions() { state.calls.push('sessions'); if (state.sessionError) { const e=new Error('session_unavailable'); e.code='session_unavailable'; e.status=409; throw e; } }};
 if (id.endsWith('readiness.js')) return {async hasSharedVtsReadiness() { state.calls.push('readiness'); return state.ready; }};
 throw Error(`unexpected import ${id}`);
});
const base = api.defaultPetSettings();
const specimens = [
 ['defaults', base],
 ['trim', {...base,name:'  friend  ',rules:[' a ']}],
 ['legacy', (() => { const v=structuredClone(base); delete v.sources; delete v.appearance; delete v.playback; delete v.ttsAudio; delete v.behavior.queueSize; delete v.behavior.askLane; return v; })()],
 ['invalid_voice', {...base,tts:{...base.tts,voice:'bad'}}],
 ['disabled_independent_voice', {...base,sources:{independent:false,readTts:true},tts:{...base.tts,voice:'bad'}}],
 ['invalid_rules', {...base,rules:Array(21).fill('x')}],
 ['missing_asset_id', {...base,appearance:{kind:'png',idleAssetId:null}}],
 ['bad_queue', {...base,behavior:{...base.behavior,queueSize:11}}],
 ['extra_key', {...base,extra:true}],
 ['utf16_length', {...base,name:'😀'.repeat(21)}],
 ['fish_custom', {...base,tts:{...base.tts,provider:'fish',voice:'abcdef0123456789abcdef0123456789'}}],
];
const cases = specimens.map(([name,input]) => { try { return {name,input,result:api.validatePetSettings(input)}; } catch(e) { return {name,input,error:{code:e.code,status:e.status}}; } });
const assetId = '507f1f77bcf86cd799439011';
const image = {kind:'image',mime:'image/png'};
const profile = {profileID:'p1',name:'Profile',personality:'persona',personaMode:'original',personaReference:'ref',tonePreset:'balanced',voiceProfile:{tone:'warm'}};
const withPng = {...base, enabled:true, sources:{independent:true,readTts:true}, appearance:{kind:'png',idleAssetId:assetId,talkingAssetId:assetId}};
const withVts = {...base, enabled:true, appearance:{...base.appearance,kind:'vts'},personality:{source:'profile',profileId:'p1',prompt:''}};
const legacy = structuredClone(base); delete legacy.sources; delete legacy.ttsAudio; delete legacy.appearance; delete legacy.playback; delete legacy.behavior.queueSize; delete legacy.behavior.askLane;
const scenarios = [
 {name:'read_default',operation:'get'},
 {name:'read_legacy',operation:'get',record:{settings:legacy,revision:2}},
 {name:'read_profile_ready_lease',operation:'get',record:{settings:withVts,revision:3},personality:{profiles:[profile],rules:['global']},runtime:{generation:4,lease:{expiresAt:'2099-01-01T00:00:00.000Z'}},ready:true},
 {name:'read_missing_profile_vts',operation:'get',record:{settings:withVts,revision:1}},
 {name:'read_png',operation:'get',record:{settings:withPng,revision:1},assets:{[assetId]:image}},
 {name:'save_first',operation:'save',input:{revision:0,settings:withPng},assets:{[assetId]:image}},
 {name:'save_session_error',operation:'save',input:{revision:0,settings:withPng},sessionError:true},
 {name:'save_missing_asset',operation:'save',input:{revision:0,settings:withPng}},
 {name:'save_invalid_asset',operation:'save',input:{revision:0,settings:withPng},assets:{[assetId]:{kind:'audio',mime:'audio/wav'}}},
 {name:'save_conflict',operation:'save',input:{revision:0,settings:base},record:{settings:base,revision:1}},
 {name:'save_missing_profile_before_session',operation:'save',input:{revision:0,settings:withVts},sessionError:true},
 {name:'save_invalidation_failure',operation:'save',input:{revision:0,settings:base},invalidateError:true},
 {name:'denied_before_validation',operation:'save',plan:'denied',input:{bad:true}},
];
function normalized(value) { return JSON.parse(JSON.stringify(value), (k,v) => k === 'updatedAt' && v ? '<date>' : v); }
async function runScenario(spec) {
 state = {plan:'premium',record:null,personality:null,runtime:null,assets:{},ready:false,calls:[],...structuredClone(spec)};
 if (state.runtime?.lease?.expiresAt) state.runtime.lease.expiresAt = new Date(state.runtime.lease.expiresAt);
 try { const result = spec.operation === 'get' ? await api.getPetConfiguration('507f1f77bcf86cd799439012','chan') : await api.savePetConfiguration('507f1f77bcf86cd799439012','chan',spec.input); return {...spec,result:normalized(result),calls:state.calls,persisted:!!state.record}; }
 catch(e) { return {...spec,error:{code:e.code,status:e.status},calls:state.calls,persisted:!!state.record}; }
}
async function main() {
 const serviceCases = []; for (const scenario of scenarios) serviceCases.push(await runScenario(scenario));
 assert.equal(process.argv[2], '--write'); const dir = process.argv[3]; assert(dir && path.isAbsolute(dir)); assert.deepEqual(fs.readdirSync(dir), []);
 fs.writeFileSync(path.join(dir,'pet-settings-service-reference.json'), JSON.stringify({cases,serviceCases}, null, 2)+'\n', {flag:'wx'});
}
main().catch(e => { console.error(e); process.exitCode=1; });
