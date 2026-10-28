#!/usr/bin/env node
// Source-backed schema oracle. Run only in the lead's task-owned Node container.
// Disconnected Mongoose owns casting/defaults/validation/indexes; the allowlist
// contains schema modules only and refuses every application/service import.
// TZ=UTC node tests/fixtures/additional_schemas_reference.mjs [--check]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const mongoose = require('mongoose');
const fixedNow = 1_900_000_000_000;
const rootId = '507f1f77bcf86cd799439011';
const secondaryId = '507f1f77bcf86cd799439012';
const at = '2030-03-17T17:46:40.000Z';
const until = '2030-04-17T17:46:40.000Z';
const FixedDate = class Date extends globalThis.Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
};
const sources = {};
const instance = new mongoose.Mongoose();
instance.now = () => new globalThis.Date(fixedNow);
const names = [
    'ai_usage_daily','ai_usage_dashboard','ai_usage_ledger_state','ai_usage_receipt',
    'ast_variables','chat_logs','command_timer','command_user_variables',
    'countdown_timer','countdown_timer_config','custom_timer','dashboard_activity',
    'dashboard_insights','domain_event','domain_event_checkpoint','domain_event_delivery',
    'raid_analytics','raid_session','raid_subscription_preference','stream_activity',
    'stream_session','stream_subscription_ledger','stream_timeline','stream_viewer_snapshot',
];
for (const name of names) {
    const source = readFileSync(new URL(`../../src/schemas/${name}.schema.ts`,import.meta.url),'utf8');
    sources[name] = createHash('sha256').update(source).digest('hex');
    const code = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports = {};
    const allowed = {Schema:instance.Schema,model:instance.model.bind(instance),Types:instance.Types};
    const localRequire = name => { assert.equal(name,'mongoose','schema oracle cannot import services'); return allowed; };
    new vm.Script(`(function(exports,require,Date){${code}\n})`,{filename:`${name}.schema.ts`}).runInThisContext()(exports,localRequire,FixedDate);
}
function normalize(value,input) {
    if (value instanceof globalThis.Date) return {$date:value.getTime()};
    if (value?._bsontype === 'ObjectId') return {$oid:input === undefined ? 'generated' : value.toHexString()};
    if (Array.isArray(value)) return value.map((child,index) => normalize(child,input?.[index]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key],input?.[key])]));
    return value;
}
function errors(error) {
    return error ? Object.keys(error.errors).sort().map(path=>({path,kind:error.errors[path].name==='CastError'?'cast':error.errors[path].kind})) : [];
}
const cases=[];
function add(model,input,operation='construct') {
    const document = new instance.models[model](input);
    const error = document.validateSync();
    const expected = error ? {errors:errors(error)} : {document:normalize(document.toObject({minimize:true,depopulate:true,flattenMaps:true}),input)};
    cases.push({model,operation,input,expected});
}
const valid = {
    ai_usage_daily:{channelID:'channel',customerId:'customer',date:'2030-03-17',dayStart:at,retentionTier:'free',expiresAt:until},
    ai_usage_dashboards:{key:'report',channelID:'channel',customerId:'customer',planTier:'free',request:{period:'day'},data:{balance:3},refreshedAt:at,expiresAt:until},
    ai_usage_ledger_states:{channelID:'channel',customerId:'customer',coverageStart:at,backfilledAt:at},
    ai_usage_receipts:{channelID:'channel',customerId:'customer',entryId:'entry',occurredAt:at,entryKind:'usage',category:'chat',operation:'completion',provider:'fixture',credits:3,itemized:true,retentionTier:'premium',expiresAt:until},
    AstVariables:{channelID:'channel',userId:'user',userLogin:'cdom201'},
    Chat_Log:{channel:'channel',username:'cdom201',message:'fixture'},
    timer_command:{command:'test',timer:3,channel:'cdom201',channelID:'channel'},
    CommandUserVariables:{commandId:secondaryId,channelID:'channel',userId:'user'},
    Countdowntimer:{channel:'cdom201',channelID:'channel',startTime:10},
    Countdowntimerconfig:{channel:'cdom201',channelID:'channel',bits:1,tier1:2,tier2:3,tier3:4,follows:5,raids:6,viewers:7,donations:8},
    custom_timer:{name:'Notice',message:'Hello',frequency:1,channel:'cdom201',channelID:'channel'},
    dashboard_activity_daily:{channelID:'channel',day:at,kind:'command',expiresAt:until},
    dashboard_activity_summary:{}, dashboard_insights:{},
    domain_event:{eventKey:'source:event:type',source:'fixture',sourceEventId:'event',type:'stream.started',topic:'channel',channelID:'channel',occurredAt:at,payload:{value:1},expiresAt:until},
    domain_event_checkpoint:{consumer:'fixture',topic:'channel',lastEventID:secondaryId},
    domain_event_delivery:{consumer:'fixture',topic:'channel',eventID:secondaryId,eventKey:'source:event:type',expiresAt:until},
    raid_analytics_history:{channelID:'channel',direction:'incoming',occurredAt:at,expiresAt:until},
    raid_analytics_summary:{},
    raid_session:{channelID:'channel',eventID:'raid-event',raiderID:'raider',startedAt:at,captureUntil:until,retentionHours:24,expiresAt:until,purgeAt:until,backfillUntil:until},
    raid_follower:{channelID:'channel',sessionID:'session',eventID:'follow-event',userID:'user',followedAt:at,purgeAt:until},
    raid_moderation_request:{channelID:'channel',sessionID:'session',actorID:'actor',requestedAt:at,expiresAt:until,purgeAt:until},
    raid_subscription_preference:{channelID:'channel',direction:'outgoing'},
    stream_activity:{channelID:'channel',session_id:secondaryId,occurredAt:at,kind:'message',expiresAt:until},
    stream_activity_aggregate:{expiresAt:until}, stream_activity_state:{},
    StreamSession:{channelID:'channel',stream_id:'stream',started_at:at},
    stream_subscription_ledger:{streamer_id:'channel',user_id:'user'},
    stream_participant:{channelID:'channel',session_id:secondaryId,bucket:1,user_id:'user',expiresAt:until},
    stream_marker:{channelID:'channel',session_id:secondaryId,key:'key',kind:'note',label:'Label',occurredAt:at,expiresAt:until},
    StreamViewerSnapshot:{channelID:'channel',session_id:secondaryId,stream_id:'stream',captured_at:at,viewers:3},
};
const definitions={};
for (const [model,definition] of Object.entries(instance.models)) {
    const stringId = definition.schema.path('_id').instance === 'String';
    const id = stringId ? 'fixture-id' : rootId;
    add(model,{_id:id});
    add(model,{_id:id,...valid[model]});
    add(model,{_id:id,...valid[model],unknown:'discarded'});
    add(model,{_id:id,...Object.fromEntries(Object.keys(valid[model]).map(key=>[key,null]))});
    const hidden = Object.keys(definition.schema.paths).filter(key=>definition.schema.path(key).selected===false).sort();
    const immutable = Object.keys(definition.schema.paths).filter(key=>definition.schema.path(key).options.immutable===true).sort();
    definitions[model] = {
        collection:definition.collection.name,stringId,
        versionKey:definition.schema.options.versionKey!==false,
        journaled:definition.schema.options.writeConcern?.w===1 && definition.schema.options.writeConcern?.j===true,
        hidden,immutable,
        indexes:definition.schema.indexes().map(([keys,options])=>({keys,keyOrder:Object.keys(keys),unique:options.unique===true,sparse:options.sparse===true,ttl:options.expireAfterSeconds??null,partial:options.partialFilterExpression??null})),
    };
}
// Clock defaults and map-of-string casting, including empty map preservation.
for (const model of ['AstVariables','CommandUserVariables']) {
    for (const variables of [{},{counter:42,flag:true,empty:null},null,'invalid',{object:{nested:true}}]) add(model,{_id:rootId,...valid[model],variables});
}
for (const date of [{day:1,month:'2',year:'2030'},null,{day:null,month:null,year:null},{day:'invalid'}]) add('timer_command',{_id:rootId,...valid.timer_command,date});
for (const extra of [
    {name:'  Notice  ',message:'\ufeff Hello \u00a0'}, {name:' '}, {message:' '},
    {frequency:0},{frequency:1441},{frequency:1.5},{frequency:'3'},{frequency:1440},
    {name:'🎮'.repeat(15)},{name:'🎮'.repeat(16)},{message:'x'.repeat(351)}, {frequencyUnit:'seconds'},
]) add('custom_timer',{_id:rootId,...valid.custom_timer,...extra});
for (const extra of [{topic:'activity',channelID:undefined},{topic:'channel',channelID:undefined},{topic:'other'},{subject:{}},{subject:{provider:'twitch',kind:'streaming-account',id:'channel'}},{schemaVersion:'2'},{metadata:{}},{metadata:null},{payload:{}}]) add('domain_event',{_id:rootId,...valid.domain_event,...extra});
for (const extra of [{status:'bad'},{attempts:'2',replayCount:0},{lastAttemptDurationMs:-1},{lastErrorCode:'unknown'},{lastPrerequisiteKind:'invalid'}]) add('domain_event_delivery',{_id:rootId,...valid.domain_event_delivery,...extra});
for (const extra of [{viewers:-1},{messages:-1},{commands:-1},{viewers:'4',messages:'2'},{viewers:0}]) add('StreamViewerSnapshot',{_id:rootId,...valid.StreamViewerSnapshot,...extra});
for (const extra of [{status:'stopped'},{ended_at:null,applied_domain_event_keys:['a',2]},{consecutive_offline_checks:'3'},{last_seen_live_at:'not-a-date'}]) add('StreamSession',{_id:rootId,...valid.StreamSession,...extra});
for (const extra of [{emotes:[{key:'emote',label:'Label',count:'2',_id:secondaryId}]},{emotes:[]},{emotes:null},{kind:'invalid'},{dashboardProcessed:null}]) add('stream_activity',{_id:'fixture-id',...valid.stream_activity,...extra});
for (const active of [{},{seq:'3'},{ids:'one',seq:2},null]) add('stream_activity_state',{_id:'fixture-id',active});
for (const tier of ['free','premium','pro','invalid',null]) add('ai_usage_receipts',{_id:rootId,...valid.ai_usage_receipts,retentionTier:tier});
for (const extra of [{origin:'other'},{status:'active'},{status:'unknown'},{includeFuture:'true'},{lockedUntil:0,nextAttemptAt:0}]) add('raid_moderation_request',{_id:'fixture-id',...valid.raid_moderation_request,...extra});
add('stream_subscription_ledger',{_id:rootId,...valid.stream_subscription_ledger,platform:'other',status:'invalid',sub_tier_normalized:'tier4'});
add('stream_marker',{_id:rootId,...valid.stream_marker,label:'🎮'.repeat(61)});
const output = new URL('additional_schemas_cases.json',import.meta.url);
const text = JSON.stringify({fixedNow,timeZone:process.env.TZ||'system',sources,definitions,cases},null,2)+'\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(output,'utf8'),text,'additional schema source corpus is stale');
else writeFileSync(output,text);
console.log(`Additional schema oracle: ${Object.keys(definitions).length} models, ${cases.length} cases; disconnected Mongoose only`);
