// saas-ops candidate only: disposable Mongo/Dragonfly, external provider stubs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import mongoose from '/app/node_modules/mongoose/index.js';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import Eventsub from '/app/dist/schemas/eventsub.schema.js';
import { DomainEventSchema } from '/app/dist/schemas/domain_event.schema.js';
import { DomainEventDeliverySchema } from '/app/dist/schemas/domain_event_delivery.schema.js';
import { GoalSet, GoalContribution, GoalCustomReceipt, changeGoal, goalSnapshot, applyGoalEvent, applyCustomGoalEvent, monthlyOutcomeKey } from '/app/dist/goals/service.js';
import { settleGoalChannel } from '/app/dist/goals/completion.js';
import { goalMonthForKey, nextGoalMonth, goalMonthAt } from '/app/dist/goals/monthly.js';
import { ingestDomainEvent } from '/app/dist/domain_events/domain_event_producers.js';
import { twitchEventsubProducer } from '/app/dist/domain_events/twitch_eventsub_events.js';
import { ingestCustomGoalContribution } from '/app/dist/domain_events/goal_custom_events.js';
import { registerAllFunctions } from '/app/dist/utils/ast_parser/functions/index.js';
import { createTwitchEffectContext, scopeAstEffectContext } from '/app/dist/utils/ast_parser/effects.js';
import { createExecutionContext, evaluate } from '/app/dist/utils/ast_parser/evaluator.js';
import { parse } from '/app/dist/utils/ast_parser/parser.js';
import { simulateCommand } from '/app/dist/utils/ast_parser/simulate.js';

assert.equal(process.env.SAAS_CURRENCY_GOALS_FIXTURE,'yes');
assert.equal(new URL(process.env.MONGO_URI).hostname,'mongo'); assert.equal(process.env.DRAGONFLY_HOST,'redis');
await getMongoDBConnection('currency-goals-check'); assert.equal(mongoose.connection.name,'saas_ops_currency_goals_test');
const redis=await getDragonflyClient('currency-goals-check');
await Promise.all([GoalSet.init(),GoalContribution.init(),GoalCustomReceipt.init(),DomainEventSchema.init(),DomainEventDeliverySchema.init()]);
const target=process.env.SAAS_TARGET; assert(['api','bot','cron'].includes(target));
const until=async(fn,label,timeout=35000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error(`Timeout ${label}`);};
if(target==='api') assert.equal((await fetch('http://127.0.0.1:3000/config/site/analytics')).status,200);
if(target==='bot') await until(async()=>{try{return(await fetch('http://127.0.0.1:3333/eventsub',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status===403;}catch{return false;}},'bot ready');
const channel='992001',other='992002',monthlyChannel='992003';
for(const id of [channel,other,monthlyChannel]){
 await Users.collection.insertOne({plan_tier:id===other?'free':'premium',accounts:[{type:'twitch',id,name:`currency${id}`,actived:true,chat_enabled:false}]});
 await redis.hSet('token:fixture-'+id,{id,login:`currency${id}`,display_name:'Fixture'});
 await redis.hSet(`accounts:twitch:${id}:data`,{id,name:`currency${id}`,plan_tier:id===other?'free':'premium',actived:'true',chat_enabled:'false'});
}
const request=async(method,id,body,revision,status=200,actor=channel)=>{
 const res=await fetch(`http://127.0.0.1:3000/goals/${id}`,{method,headers:{Authorization:`Bearer fixture-${actor}`,'Content-Type':'application/json',...(revision===undefined?{}:{'If-Match':String(revision)})},...(body?{body:JSON.stringify(body)}:{})});
 const json=await res.json(); assert.equal(res.status,status,JSON.stringify(json)); return json.data;
};
const currency={code:'USD',subscriptionValue:175,bitValue:1,items:[{key:'chest',unitAmount:250,feeBasisPoints:1000}]};
const goal={name:'Currency',metric:'currency',mode:'total',target:25000,currency};
if(target==='api'){
 await request('POST',other,goal,0,403,other);
 await request('POST',channel,{...goal,currency:{...currency,code:'JPY'}},0,400);
 await request('POST',channel,{...goal,currency:{...currency,items:[{key:'x',unitAmount:250,feeBasisPoints:10001}]}},0,400);
 let result=await request('POST',channel,goal,0); const id=result.goals[0].id;
 await request('PATCH',`${channel}/${id}`,{name:'edit',target:1000,currency},1,400);
 result=await request('PATCH',`${channel}/${id}`,{name:'edited',target:26000},1); assert.equal(result.goals[0].target,26000);
 await request('DELETE',`${channel}/${id}`,null,2); await GoalSet.deleteOne({_id:channel});
}
await changeGoal(channel,'create',goal,0);
await changeGoal(channel,'create',{...goal,name:'different fee',currency:{code:'USD',subscriptionValue:0,bitValue:0,items:[{key:'chest',unitAmount:250,feeBasisPoints:2000}]}},1);
await changeGoal(channel,'create',{...goal,name:'round once',currency:{code:'USD',subscriptionValue:0,bitValue:0,items:[{key:'chest',unitAmount:1,feeBasisPoints:5000}]}},2);
await assert.rejects(()=>changeGoal(channel,'create',goal,3),e=>e.code==='limit');
const initial=await goalSnapshot(channel); const [main,fee,round]=initial.goals;
async function twitch(type,raw={}){
 const result=await ingestDomainEvent(twitchEventsubProducer,{messageId:crypto.randomUUID(),messageTimestamp:new Date().toISOString(),subscription:{type,version:'1'},event:{broadcaster_user_id:channel,user_id:'99',...raw}});
 assert(result?.event);
 if(target==='cron') await until(async()=>(await DomainEventDeliverySchema.findOne({consumer:'channel-goals-v1',eventKey:result.event.eventKey}).lean())?.status==='succeeded','Twitch consumer');
 else await applyGoalEvent(result.event);
 return result.event;
}
await twitch('channel.subscription.gift',{total:3}); await twitch('channel.subscribe',{is_gift:true});
const bits=await twitch('channel.bits.use',{bits:250});
await Eventsub.collection.insertOne({channelID:channel,type:'channel.bits.use',enabled:true,created_at:new Date(0).toISOString()});
await twitch('channel.cheer',{bits:250}); await applyGoalEvent(bits);
let state=await goalSnapshot(channel); assert.deepEqual(state.goals.map(g=>g.current),[775,0,0]);
console.log('PASS currency API/plan and gift/bits dedupe: 3 x 175 + 250 x 1 = 775 cents.');
registerAllFunctions({startWorkers:false});
const effect=(actor,badges,origin='message-1')=>scopeAstEffectContext(createTwitchEffectContext({channelId:channel,
 origin:{kind:'chat-command',id:origin,occurredAt:new Date().toISOString()},
 actor:{userId:actor,displayName:'Fixture',chat:{login:'fixture',message:'!goal',badges:badges.map(set_id=>({set_id,id:'1',info:''}))}}}),channel,'command:fixture');
const context=(authority)=>createExecutionContext({broadcasterId:channel,platform:'twitch',effectContext:authority,enforceFunctionPermissions:false,userLevel:10,
 authorization:{origin:'authored',identity:{level:10,tags:['broadcaster']}},scopeType:'command',scopeName:'fixture'});
const evaluateGoal=async(text,authority)=>String((await evaluate(parse(text).ast,context(authority))).value);
const beforeCount=await DomainEventSchema.countDocuments({source:'goals-custom'});
const forged=context(effect('999',[])); forged.eventData={badges:[{set_id:'moderator'}],chatter_user_id:channel};
assert.match(String((await evaluate(parse('$(goal.add chest 3)').ast,forged)).value),/permission_required/);
const simulation=await simulateCommand({body:'$(goal.add chest 3)',runs:[{role:'mod'}]});
assert.deepEqual(simulation.runs[0].actions,[{function:'goal.add',args:['chest','3']}]);
assert.equal(await DomainEventSchema.countDocuments({source:'goals-custom'}),beforeCount);
const values=await Promise.all(Array.from({length:32},()=>evaluateGoal('$(goal.add chest 3 sale_42)',effect('999',['moderator']))));
assert(values.every(value=>value===''),JSON.stringify(values));
const customEvents=await DomainEventSchema.find({source:'goals-custom',channelID:channel}).lean(); assert.equal(customEvents.length,1);
const custom=customEvents[0];
if(target==='cron') await until(async()=>{const delivery=await DomainEventDeliverySchema.findOne({consumer:'goal-custom-contributions-v1',eventKey:custom.eventKey}).lean();if(delivery?.status==='retry'||delivery?.status==='dead')throw Error('Custom consumer failed: '+JSON.stringify(delivery));return delivery?.status==='succeeded';},'custom consumer');
else await Promise.all(Array.from({length:32},()=>applyCustomGoalEvent(custom)));
state=await goalSnapshot(channel); assert.deepEqual(state.goals.map(g=>g.current),[1450,600,2]);
assert.equal(await GoalCustomReceipt.countDocuments({channel}),1);
assert.equal(await GoalContribution.countDocuments({channel,goal:main.id}),3);
assert.equal(await GoalContribution.countDocuments({channel,goal:fee.id}),1);
assert.equal(await GoalContribution.countDocuments({channel,goal:round.id}),1);
assert.match(await evaluateGoal('$(goal.add chest 4 sale_42)',effect('999',['moderator'],'message-2')),/goal_contribution_failed/);
await Users.updateOne({'accounts.id':channel},{$set:{plan_tier:'pro'}});
await changeGoal(channel,'create',{...goal,name:'Created after receipt',currency:{...currency,bitValue:0,subscriptionValue:0}},3);
const laterGoal=(await goalSnapshot(channel)).goals.at(-1);
await DomainEventDeliverySchema.deleteMany({eventKey:custom.eventKey});
await DomainEventSchema.deleteOne({_id:custom._id});
assert.equal(await evaluateGoal('$(goal.add chest 3 sale_42)',effect('999',['moderator'],'message-3')),'');
const replay=await DomainEventSchema.findOne({source:'goals-custom',channelID:channel}).lean(); assert(replay);
if(target==='cron') await until(async()=>(await DomainEventDeliverySchema.findOne({consumer:'goal-custom-contributions-v1',eventKey:replay.eventKey}).lean())?.status==='succeeded','custom consumer after journal TTL'); else await applyCustomGoalEvent(replay);
const replayState=await goalSnapshot(channel);
assert.deepEqual(replayState.goals.slice(0,3).map(g=>g.current),[1450,600,2]);
assert.equal(replayState.goals.find(g=>g.id===laterGoal.id).current,0,'old receipt cannot backfill a newly created goal');
assert.equal(await GoalCustomReceipt.countDocuments({channel}),1);
const foreign=await ingestCustomGoalContribution({channelID:other,receiptIdentity:'same-receipt',itemKey:'chest',quantity:3,occurredAt:new Date()});
assert.notEqual(foreign.event.eventKey,custom.eventKey);
console.log('PASS real AST authority, simulation, 32 duplicate deliveries, scoped receipts, fee rounding and post-journal replay.');

const march=goalMonthForKey('2026-03','America/New_York'), november=goalMonthForKey('2026-11','America/New_York');
assert.equal((march.endsAt-march.startsAt)/3600000,743); assert.equal((november.endsAt-november.startsAt)/3600000,721);
assert.equal(nextGoalMonth('2026-12','America/New_York').key,'2027-01');
await redis.set('app:twitch:token','fixture-app-token');
const messages=()=>fs.existsSync('/tmp/saas-fixtures/goal-messages.jsonl')?fs.readFileSync('/tmp/saas-fixtures/goal-messages.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
await changeGoal(monthlyChannel,'create',{...goal,name:'monthly',mode:'monthly',timeZone:'America/New_York',target:100,
 actions:{completion:{type:'message',text:'fixture month complete'},failure:{type:'message',text:'fixture month failed'}}},0);
const monthly=(await goalSnapshot(monthlyChannel)).goals[0], current=goalMonthAt(Date.now(),'America/New_York'), next=nextGoalMonth(current.key,'America/New_York');
const monthlyEvent=await ingestDomainEvent(twitchEventsubProducer,{messageId:crypto.randomUUID(),messageTimestamp:new Date().toISOString(),subscription:{type:'channel.bits.use',version:'1'},event:{broadcaster_user_id:monthlyChannel,user_id:'99',bits:1}});
assert(monthlyEvent?.event); await applyGoalEvent(monthlyEvent.event); await applyGoalEvent(monthlyEvent.event);
assert.equal((await goalSnapshot(monthlyChannel,next.startsAt+1)).goals[0].current,0,'late replay stays in original month');
await GoalContribution.create({_id:'fixture-month-one',channel:monthlyChannel,goal:monthly.id,occurredAt:Date.now(),amount:100});
await Promise.all(Array.from({length:8},()=>settleGoalChannel(monthlyChannel)));
await until(async()=>(await GoalSet.findById(monthlyChannel).lean())?.outcomes?.[monthlyOutcomeKey(monthly.id,current.key)]?.actionStatus==='finished','monthly completion action');
let monthState=await GoalSet.findById(monthlyChannel).lean();
assert.equal(monthState.outcomes[monthlyOutcomeKey(monthly.id,current.key)].phase,'completed');
assert.equal(monthState.outcomes[monthlyOutcomeKey(monthly.id,current.key)].sequence,1);
assert.equal(messages().filter(m=>m.message==='fixture month complete').length,1);
await settleGoalChannel(monthlyChannel,next.endsAt+1);
await settleGoalChannel(monthlyChannel,next.endsAt+1);
monthState=await GoalSet.findById(monthlyChannel).lean();
assert.equal(monthState.outcomes[monthlyOutcomeKey(monthly.id,next.key)].phase,'failed');
assert.equal(messages().filter(m=>m.message==='fixture month failed').length,1);
const following=nextGoalMonth(next.key,'America/New_York');
await GoalContribution.create({_id:'fixture-month-next',channel:monthlyChannel,goal:monthly.id,occurredAt:following.startsAt+1,amount:100});
await settleGoalChannel(monthlyChannel,following.startsAt+2);
assert.equal((await goalSnapshot(monthlyChannel,following.startsAt+2)).goals[0].outcome.phase,'completed');
assert.equal(messages().filter(m=>m.message==='fixture month complete').length,2);
assert.equal((await goalSnapshot(monthlyChannel,next.startsAt+1)).goals[0].current,0);
const beforeRevision=monthState.revision;
const stale=await GoalSet.updateOne({_id:monthlyChannel,revision:beforeRevision-1,[`monthlyCursors.${monthly.id}`]:next.key},{$set:{[`monthlyCursors.${monthly.id}`]:current.key}});
assert.equal(stale.modifiedCount,0);
console.log('PASS Mongo monthly outcomes, prior-month isolation, cursor CAS, DST and year rollover.');
// Fixed end is exclusive even when a valid earlier event is replayed later.
await changeGoal(monthlyChannel,'create',{...goal,name:'fixed',mode:'fixed',startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+60000).toISOString()},1);
const fixed=(await goalSnapshot(monthlyChannel)).goals.find(g=>g.name==='fixed');
const now=new Date();
const fixedEvent=await ingestDomainEvent(twitchEventsubProducer,{messageId:crypto.randomUUID(),messageTimestamp:now.toISOString(),subscription:{type:'channel.bits.use',version:'1'},event:{broadcaster_user_id:monthlyChannel,user_id:'99',bits:10}});
assert(fixedEvent?.event);
await GoalSet.updateOne({_id:monthlyChannel,'goals.id':fixed.id},{$set:{'goals.$.endsAt':now.getTime()+1}});
await applyGoalEvent(fixedEvent.event);
const late={...fixedEvent.event,eventKey:'fixed-late-fixture',sourceEventId:'fixed-late-fixture'};
await applyGoalEvent(late);
await applyGoalEvent({...late,eventKey:'fixed-end-fixture',occurredAt:new Date(now.getTime()+1)});
assert.equal((await goalSnapshot(monthlyChannel)).goals.find(g=>g.id===fixed.id).current,20);
console.log('PASS fixed goal exclusive end and late event replay.');

const testFiles=[
 'src/goals/model.test.ts','src/goals/currency_monthly.test.ts','src/goals/service_monthly.test.ts',
 'src/domain_events/goal_custom_events.test.ts','src/domain_events/goal_required_delivery.test.ts',
 'src/utils/ast_parser/goal_contribution.test.ts','src/utils/ast_parser/permission_gate_authored.test.ts',
 'src/utils/ast_parser/pet_triggers.test.ts','src/utils/ast_parser/simulate.test.ts'
];
const tests=spawnSync(process.execPath,['--experimental-test-module-mocks','--import','tsx','--test',...testFiles],{cwd:'/app',encoding:'utf8',timeout:120000,maxBuffer:10*1024*1024,env:{...process.env,NODE_OPTIONS:''}});
if(tests.status!==0){process.stdout.write(tests.stdout||'');process.stderr.write(tests.stderr||'');}
assert.equal(tests.status,0,`focused candidate tests ${tests.error||''}`);
assert.match(tests.stdout,/ℹ tests [1-9][0-9]*/);assert.match(tests.stdout,/ℹ fail 0/);assert.match(tests.stdout,/ℹ skipped 0/);
console.log(tests.stdout.split('\n').filter(line=>/ℹ (tests|pass|fail|skipped) /.test(line)).join(' '));
console.log(`PASS exact candidate currency goals target=${target}`);
process.exit(0);
