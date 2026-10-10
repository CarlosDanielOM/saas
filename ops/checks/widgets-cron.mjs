// Run only with saas-ops, disposable Mongo/Redis, and widgets-fixtures (cron target).
// The full widgets-backend check exceeds the cron candidate's memory limit next to every
// supervised worker, so this drives the real widgets worker through poll launches and mini roulettes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const svc=await import('/app/dist/widgets/service.js');
const domain=await import('/app/dist/widgets/model.js');
const {catalog}=await import('/app/dist/widgets/catalog.js');
const {getMongoDBConnection}=await import('/app/dist/utils/databases/mongodb.database.js');
const {getDragonflyClient}=await import('/app/dist/utils/databases/dragonfly.database.js');
await getMongoDBConnection('widgets-joker-test');const redis=await getDragonflyClient('widgets-joker-test');
const {default:Users}=await import('/app/dist/schemas/users.schema.js');
const {encrypt}=await import('/app/dist/utils/crypto.js');
await svc.WidgetChannel.init();
const channel='991811';
await Users.collection.insertOne({accounts:[{id:channel,type:'twitch',name:'jokerfixture',has_permissions:true,up_to_date_permissions:true,actived:true,chat_enabled:false,access_token:encrypt('fixture'),refresh_token:encrypt('fixture-refresh'),access_token_expires_at:Math.floor(Date.now()/1000)+3600}],plan_tier:'pro'});
await redis.hSet('accounts:twitch:'+channel+':data',{id:channel,name:'jokerfixture',has_permissions:'true',access_token:'fixture',expires_at:String(Math.floor(Date.now()/1000)+3600),userPlan:'pro'});
const polls=()=>JSON.parse(readFileSync('/tmp/saas-fixtures/polls.json','utf8'));
// Persist a challenge whose character result is due, so the worker's own settle launches the poll.
async function launch(config){
 const state=domain.initial();state.config=domain.config({...state.config,...config,pollSeconds:15});
 domain.start(state,Date.now(),'challenge');
 state.phase='character-result';state.run.characterId=state.run.draw.itemId;state.nextAt=0;
 await svc.WidgetChannel.deleteMany({_id:channel});
 await svc.WidgetChannel.create({_id:channel,revision:0,state,dueAt:0,receipts:[]});
 for(let i=0;i<100;i++){
  const doc=await svc.WidgetChannel.findById(channel).lean();
  if(doc.state.phase==='polling'||doc.state.phase==='poll-error'){assert.equal(doc.state.phase,'polling',doc.state.run.error);return {run:doc.state.run,poll:polls().polls[0]};}
  if(i%10===0)execFileSync('node',['/app/dist/workers/widgets.worker.js','--once'],{encoding:'utf8'});
  await new Promise(r=>setTimeout(r,200));
 }
 throw new Error('Cron worker did not launch the widget poll');
}
async function close(){const store=polls();store.polls.forEach(p=>p.status='COMPLETED');(await import('node:fs')).writeFileSync('/tmp/saas-fixtures/polls.json',JSON.stringify(store));}
let result=await launch({channelPointsVoting:false,jokerChance:100,jokerPointsPerVote:40});
assert.equal(result.run.joker,true);assert(result.poll.title.includes(result.run.id.slice(0,8)));
assert.equal(result.poll.channel_points_voting_enabled,true);assert.equal(result.poll.channel_points_per_vote,40,'cron launches joker polls at the joker price');
await close();
result=await launch({channelPointsVoting:true,channelPointsPerVote:300,jokerChance:0,jokerPointsPerVote:40});
assert.equal(result.run.joker,undefined);assert.equal(result.poll.channel_points_per_vote,300,'normal polls keep the normal price');
await close();
result=await launch({channelPointsVoting:false,jokerChance:0});
assert.equal(result.poll.channel_points_voting_enabled,false,'normal free polls stay one vote per viewer');
await close();
// Mini roulette: the worker turns a slice win into a spin of its own wheel.
const perks=catalog.entries.filter(e=>e.role==='killer'&&e.kind==='perk'&&e.available).map(e=>e.id),inside=perks.slice(0,3);
const mini=domain.initial();mini.config=domain.config({...mini.config,excludedIds:perks.slice(3),subWheels:[{id:'bad',role:'killer',name:'Bad',perkIds:inside,copies:1,weight:1}]});
domain.start(mini,Date.now(),'perks');assert.equal(mini.run.draw.itemId,'wheel:bad');mini.nextAt=0;
await svc.WidgetChannel.deleteMany({_id:channel});await svc.WidgetChannel.create({_id:channel,revision:0,state:mini,dueAt:0,receipts:[]});
async function waitPhase(check,label){for(let i=0;i<100;i++){const doc=await svc.WidgetChannel.findById(channel).lean();if(check(doc.state))return doc.state;if(i%10===0)execFileSync('node',['/app/dist/workers/widgets.worker.js','--once'],{encoding:'utf8'});await new Promise(r=>setTimeout(r,200));}throw new Error('Cron worker did not reach '+label);}
let miniState=await waitPhase(s=>s.phase==='perk-result','slice result');assert.deepEqual(miniState.run.perkIds,[]);
await svc.WidgetChannel.updateOne({_id:channel},{$set:{'state.nextAt':0,dueAt:0}});
miniState=await waitPhase(s=>s.phase==='perk-spin'&&s.run.draw.wheelId==='bad','inner wheel');assert(miniState.run.draw.poolIds.every(id=>inside.includes(id)));
execFileSync(process.execPath,['--experimental-test-module-mocks','--test','/app/dist/widgets/model.test.js'],{stdio:'inherit',timeout:30000});
console.log('PASS widgets cron: worker launches joker polls at the joker price, normal paid and free polls unchanged, mini roulette slice opens its own wheel');
process.exit(0);
