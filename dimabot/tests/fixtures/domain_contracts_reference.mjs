// Offline source oracle. Only the allowlisted pure modules below may execute.
// No environment files, stores, providers, timers or network imports are loaded.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const now = Date.UTC(2026, 8, 5, 12);
const timestamp = new Date(now).toISOString();
class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const sourceFiles = [
  'src/domain_events/domain_event.types.ts',
  'src/domain_events/domain_event_contracts.ts',
  'src/domain_events/domain_event_delivery_policy.ts',
  'src/domain_events/twitch_eventsub_events.ts',
  'src/domain_events/polar_events.ts',
  'src/overlays/interaction-model.ts',
  'src/utils/raid_direction.ts',
  'src/utils/shared_chat_origin.ts',
  'src/utils/eventsub.test-data.ts',
];
const cache = new Map();
const sourceHashes = {};
function load(relative) {
  if (cache.has(relative)) return cache.get(relative).exports;
  if (relative === 'src/domain_events/domain_event_identity.ts') {
    return { resolveDomainEventOwner() { throw new Error('Offline oracle must not resolve an owner'); } };
  }
  assert(sourceFiles.includes(relative), `Non-allowlisted source: ${relative}`);
  const live=path.join(root,relative);
  const source = readFileSync(existsSync(live)?live:path.resolve(root,'../archives/dimabot-typescript/2026-10-28',relative), 'utf8');
  sourceHashes[relative] = createHash('sha256').update(source).digest('hex');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  cache.set(relative, module);
  const localRequire = name => {
    assert(name.startsWith('.'), `Non-pure import: ${name}`);
    return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), name)).replace(/\.js$/, '.ts'));
  };
  new vm.Script(`(function(exports,require,module,Date){${compiled}\n})`, { filename: relative }).runInThisContext()(module.exports, localRequire, module, FixtureDate);
  return module.exports;
}
const contracts = load('src/domain_events/domain_event_contracts.ts');
const policy = load('src/domain_events/domain_event_delivery_policy.ts');
const interactions = load('src/overlays/interaction-model.ts');
const twitchProducer = load('src/domain_events/twitch_eventsub_events.ts');
const polarProducer = load('src/domain_events/polar_events.ts');
const fixtures = load('src/utils/eventsub.test-data.ts');
const types = load('src/domain_events/domain_event.types.ts');

const cases = [];
function capture(name, operation, input, options = {}) {
  let expected;
  try {
    let result;
    if (operation === 'contract') contracts.validateDomainEventContract(input, options.mode ?? 'retained');
    else if (operation === 'serialize') result = contracts.serializeDomainEventProviderData(input);
    else if (operation === 'interaction') result = interactions.parseInteraction(options.type, input, options.occurredAt ?? timestamp, options.receipt ?? 'receipt');
    else if (operation === 'reduce') result = interactions.reduceInteraction(input.current, input.next);
    else if (operation === 'policy') result = policy.evaluateDomainEventDeliveryPolicy(input.policy, input.event, input.now);
    else if (operation === 'replay') result = policy.canAdminReplayDomainEvent(input.policy, input.event, input.now);
    expected = { ok: true, ...(result === undefined ? {} : { result }) };
  } catch (error) { expected = { ok: false, error: error.message }; }
  cases.push({ name, operation, input, ...options, expected });
}
const clone = value => structuredClone(value);
function twitch(type = 'channel.follow', event = { broadcaster_user_id: 'channel', user_id: 'follower' }) {
  return twitchProducer.normalizeTwitchEventsubDomainEvent({ messageId: 'receipt', subscription: { type, version: type === 'channel.follow' ? '2' : '1' }, event });
}
function polar(type = 'order.paid', data = { id: 'order', customerId: 'customer', paid: true, status: 'paid' }) {
  return polarProducer.normalizePolarDomainEvent({ webhookId: 'receipt', event: { type, timestamp: new FixtureDate(timestamp), data } });
}
for (const type of Object.keys(contracts.TWITCH_DOMAIN_EVENT_TYPES)) {
  const fixture = fixtures.generateTestPayload(['channel.cheer', 'channel.bit.use'].includes(type) ? 'channel.bits.use' : type, 'channel');
  fixture.subscription.type = type;
  const input = twitchProducer.normalizeTwitchEventsubDomainEvent({ messageId: `receipt-${type}`, messageTimestamp: timestamp, subscription: fixture.subscription, event: fixture.event, source: 'twitch-eventsub-test' });
  capture(`all-twitch/${type}`, 'contract', input, { mode: 'ingest' });
  if (type !== 'channel.raid') {
    const retained = { ...clone(input), _id: { _bsontype: 'ObjectId' }, eventKey: [input.source, input.sourceEventId, input.type].map(encodeURIComponent).join(':'), occurredAt: new FixtureDate(input.occurredAt), journaledAt: new FixtureDate(timestamp), expiresAt: new FixtureDate(now+86400000) };
    delete retained.subject;
    capture(`legacy-twitch/${type}`, 'contract', retained, { mode: 'retained', native: { objectId: Array(12).fill(1), occurredAtMillis: retained.occurredAt.getTime(), journaledAtMillis: now, expiresAtMillis: now+86400000 } });
    capture(`legacy-ingest-rejected/${type}`, 'contract', retained, { mode: 'ingest' });
  }
}
const mutations = [
  ['source', i=>i.source='polar-webhook'], ['type', i=>i.type='channel.bits.received'], ['topic', i=>i.topic='domain'],
  ['version', i=>i.schemaVersion=2], ['subject-id', i=>i.subject.id='other'], ['subject-provider', i=>i.subject.provider='polar'],
  ['subject-kind', i=>i.subject.kind='customer'], ['channel', i=>i.channelID='other'], ['original', i=>i.metadata.originalEventType='channel.raid'],
  ['missing-original', i=>delete i.metadata.originalEventType], ['metadata-version', i=>i.metadata.subscriptionVersion='99'],
  ['sub-version', i=>i.payload.subscription.version='99'], ['sub-type', i=>i.payload.subscription.type='channel.raid'],
  ['sub-condition', i=>i.payload.subscription.condition={broadcaster_user_id:'other'}], ['event-array', i=>i.payload.event=[]],
  ['user-number', i=>i.payload.event.user_id=123], ['user-empty', i=>i.payload.event.user_id=''],
  ['fractional-retry', i=>i.metadata.messageRetry=1.5], ['string-handled', i=>i.metadata.durableChatHandled='true'],
  ['wrong-owner', i=>i.ownerUserId='channel'], ['retention-long', i=>i.retentionSeconds=8e12],
];
for (const [name, mutate] of mutations) { const input=twitch(); mutate(input); capture(`twitch-invalid/${name}`, 'contract', input); }
for (const type of ['channel.subscription.gift', 'channel.bits.use', 'channel.raid']) {
  const field = type === 'channel.subscription.gift' ? 'total' : type === 'channel.bits.use' ? 'bits' : 'viewers';
  const base = type === 'channel.raid' ? { to_broadcaster_user_id:'channel', from_broadcaster_user_id:'raider' } : { broadcaster_user_id:'channel' };
  for (const value of ['1', null, -1, 1.5, Number.MAX_SAFE_INTEGER+1, Number.MAX_SAFE_INTEGER]) capture(`counts/${type}/${String(value)}`, 'contract', twitch(type,{...base,[field]:value}));
}
for (const value of ['', 'tomorrow','2026-02-30T12:00:00Z','2026-09-05','2026-09-05T24:00:00Z',123,null,'2026-09-05T12:00:00.123456789Z','0000-02-29T12:00:00Z','2024-02-29T12:00:00+23:59']) {
  capture(`follow-time/${String(value)}`, 'contract', twitch('channel.follow',{broadcaster_user_id:'channel', user_id:'follower',followed_at:value}));
}
for (const condition of [
  {to_broadcaster_user_id:'channel'}, {to_broadcaster_user_id:'channel',from_broadcaster_user_id:''},
  {from_broadcaster_user_id:'raider'}, {from_broadcaster_user_id:'raider',to_broadcaster_user_id:''},
  {to_broadcaster_user_id:'channel',from_broadcaster_user_id:'other'}, {to_broadcaster_user_id:'other',from_broadcaster_user_id:''},
  {from_broadcaster_user_id:''}, {to_broadcaster_user_id:''}, {to_broadcaster_user_id:'channel',from_broadcaster_user_id:null},
  {to_broadcaster_user_id:'channel',from_broadcaster_user_id:0}, {to_broadcaster_user_id:'channel',broadcaster_user_id:''},
]) {
  const input=twitch('channel.raid',{to_broadcaster_user_id:'channel',from_broadcaster_user_id:'raider',viewers:5});
  input.payload.subscription.condition=condition;
  capture(`raid-condition/${JSON.stringify(condition)}`,'contract',input,{mode:'ingest'});
}
for (const input of [polar(), polar('subscription.updated',{id:'sub',customerId:'customer',productId:'product',status:'canceled',recurringInterval:'year',currentPeriodEnd:null}),polar('customer.state_changed',{id:'customer',activeMeters:[{meterId:'meter',consumedUnits:12.5,creditedUnits:10,balance:-2.5}]}),polar('product.created',{id:'product'}),polar('customer.new',{id:'customer'})]) capture(`polar/${input.metadata.originalEventType}`,'contract',input);
for (const [name, mutate] of [
  ['customer',i=>i.payload.customerId='other'],['paid',i=>i.payload.paid='true'],['amount',i=>i.payload.totalAmount=-1],
  ['missing-order',i=>delete i.payload.orderId],['status',i=>i.payload.status={}],['period',i=>i.payload.periodEnd='2026-02-30T12:00:00Z'],
  ['cadence',i=>i.payload.cadence='weekly'],['subscription-cadence',i=>i.payload.subscriptionId='sub'],['channel',i=>i.channelID='fabricated'],
  ['original',i=>i.metadata.originalEventType='order.refunded'],['unmapped',i=>i.metadata.unmapped=true],['nested',i=>i.payload={data:i.payload}],
  ['meter',i=>i.payload.meters=[{meter_id:'meter',balance:'1'}]],
]) { const input=polar();mutate(input);capture(`polar-invalid/${name}`,'contract',input); }
for (const topic of ['channel','activity','telemetry','domain']) {
  const input={source:'extension',sourceEventId:'receipt',type:'extension.event',topic,channelID:'channel',subject:{provider:'extension',kind:'resource',id:'subject'},payload:{},retentionSeconds:types.DOMAIN_EVENT_RETENTION_SECONDS[topic]};
  capture(`retention/${topic}`,'contract',input);
  capture(`retention/${topic}/too-long`,'contract',{...input,retentionSeconds:input.retentionSeconds+1});
}
for (const value of [1.25,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,1e-7,1e-6,0,-0,{'__proto__':null,plain:true},JSON.parse('{"__proto__":true}'),{constructor:{}},{nested:{prototype:1}},'hello 😀\u0000\n']) capture(`json/${JSON.stringify(value)}`,'serialize',{value});
let deep={};for(let i=0;i<35;i++) deep={nested:deep};capture('json/deep','serialize',deep);
// Budget boundary is intentionally the conservative source walk budget, not
// merely JSON.stringify(...).length.
for (const n of [262100,262110,262120,262130,262140,262142,262143,262144]) {
  capture(`json/bytes/${n}`,'serialize',{value:'x'.repeat(n)});
  const c=cases.at(-1);
  c.input={};c.repeat={field:'value',character:'x',count:n};
  if(c.expected.ok)c.expected={ok:true,resultEqualsInput:true};
}

const basePoll={id:'poll',title:'Pick one',choices:[{id:'a',title:'A',votes:4,channel_points_votes:1},{id:'b',title:'B',votes:2}],started_at:timestamp,ends_at:new FixtureDate(now+60000).toISOString()};
const basePrediction={id:'prediction',title:'Who wins',outcomes:[{id:'a',title:'A',users:2,channel_points:20,color:'pink'},{id:'b',title:'B',users:1,channel_points:5,color:'other'}],started_at:timestamp,locks_at:new FixtureDate(now+60000).toISOString(),locked_at:timestamp,ended_at:timestamp,status:'resolved',winning_outcome_id:'a'};
for (const type of Object.keys(interactions.INTERACTION_EVENT_TYPES)) {
  const event=type.startsWith('channel.poll')?{...clone(basePoll),status:'completed',ended_at:timestamp}:clone(basePrediction);
  capture(`interaction/${type}`,'interaction',event,{type});
}
for (const [name, mutate] of [
  ['bad-count',e=>e.choices[0].votes='4'],['points-over-votes',e=>e.choices[0].channel_points_votes=5],['duplicate',e=>e.choices[1].id='a'],
  ['missing-votes',e=>delete e.choices[0].votes],['bad-id',e=>e.id=''],['long-title',e=>e.title='x'.repeat(201)],['missing-end',e=>delete e.ends_at],
]) {const event=clone(basePoll);mutate(event);capture(`interaction-invalid/${name}`,'interaction',event,{type:'channel.poll.progress'});}
for(const started_at of ['2026-02-30T00:00Z','2026-01-01T00:00','2026-01-01T00:00:00z','2026-01-01T00:00:00+0100','2026-01-01T24:00:00.00000001Z','2026-01-01T00:00:00.1234567890123456789Z']) capture(`interaction-time/${started_at}`,'interaction',{...basePoll,started_at},{type:'channel.poll.progress'});
const current=interactions.parseInteraction('channel.poll.progress',basePoll,timestamp,'current');
for(const [name,changes] of [['duplicate',{receipt:'current'}],['older',{occurredAt:new FixtureDate(now-1).toISOString()}],['new',{receipt:'new'}],['older-other-id',{id:'older',startedAt:new FixtureDate(now-1).toISOString()}],['newer-other-id',{id:'newer',startedAt:new FixtureDate(now+1).toISOString()}]]) capture(`reduce/${name}`,'reduce',{current,next:{...clone(current),receipt:'next',...changes}});
capture('reduce/terminal-keeps-end','reduce',{current:{...current,phase:'completed',endedAt:timestamp},next:{...clone(current),phase:'archived',endedAt:new FixtureDate(now+1).toISOString(),receipt:'next'}});
capture('reduce/terminal-no-regression','reduce',{current:{...current,phase:'completed'},next:{...clone(current),receipt:'next'}});
const deliveryPolicy={consumer:'ephemeral',schemaVersions:[1],adminReplay:false,maxEventAgeMs:300000};
const policyEvent={schemaVersion:1,occurredAt:timestamp,expiresAt:new FixtureDate(now+90*86400000).toISOString()};
for(const delta of [0,299999,300000]) capture(`policy/age/${delta}`,'policy',{policy:deliveryPolicy,event:policyEvent,now:now+delta});
capture('policy/future-journal-age','policy',{policy:deliveryPolicy,event:{...policyEvent,occurredAt:new FixtureDate(now+90*86400000).toISOString(),journaledAt:timestamp},now:now+300000});
capture('policy/incompatible-before-stale','policy',{policy:deliveryPolicy,event:{...policyEvent,schemaVersion:2},now:now+300000});
capture('policy/invalid-time','policy',{policy:deliveryPolicy,event:{...policyEvent,occurredAt:'invalid'},now});
capture('policy/uncapped-invalid-time','policy',{policy:{consumer:'generic'},event:{...policyEvent,occurredAt:'invalid'},now});
for(const schemaVersion of [1e21,1e-7,-0]) capture(`policy/version-number-format/${String(schemaVersion)}`,'policy',{policy:deliveryPolicy,event:{...policyEvent,schemaVersion},now});
for(const maxEventAgeMs of [1e-7,-0]) capture(`policy/age-number-format/${String(maxEventAgeMs)}`,'policy',{policy:{...deliveryPolicy,maxEventAgeMs},event:policyEvent,now:now+1});
for(const [name,p,e] of [['no-policy',undefined,policyEvent],['denied',deliveryPolicy,policyEvent],['allowed',{...deliveryPolicy,adminReplay:true},policyEvent],['expired',{...deliveryPolicy,adminReplay:true},{...policyEvent,expiresAt:timestamp}],['no-event',{...deliveryPolicy,adminReplay:true},null]]) capture(`replay/${name}`,'replay',{policy:p,event:e,now});

// Bench only after loading/generating fixtures. Prepared objects and the same
// validity mix are reused by native and TypeScript runners.
const benchCases=cases.filter(c=>c.operation==='contract'&&!c.native&&!c.name.startsWith('legacy-'));
function benchmark(iterations) {
  let accepted=0,rejected=0;
  const run=()=>{for(const c of benchCases){try{contracts.validateDomainEventContract(c.input,c.mode??'retained');accepted++;}catch{rejected++;}}};
  for(let i=0;i<100;i++)run();
  accepted=0;rejected=0;
  const start=performance.now();for(let i=0;i<iterations;i++)run();const elapsedMs=performance.now()-start;
  return {implementation:'typescript',workload:'domain-contracts-prepared',iterations,casesPerPass:benchCases.length,accepted,rejected,elapsedMs,nsPerOperation:elapsedMs*1e6/(iterations*benchCases.length),node:process.version};
}
if (process.argv.includes('--bench')) console.log(JSON.stringify(benchmark(Number(process.env.DOMAIN_CONTRACT_BENCH_ITERATIONS??1000))));
else {
  const output={sourceHashes,cases,benchmarkCaseNames:benchCases.map(c=>c.name)};
  writeFileSync(new URL('domain_contracts_cases.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({cases:cases.length,benchmarkCases:benchCases.length,sourceFiles:Object.keys(sourceHashes).length}));
}
