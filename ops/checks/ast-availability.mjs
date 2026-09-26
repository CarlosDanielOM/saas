// Disposable Mongo/Dragonfly only; provider calls are intercepted by
// ast-timer-fixtures. Recovery is also run in a fresh process to test durability.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { RedemptionRewardSchema } from '/app/dist/schemas/redemption_reward.schema.js';
import Commands from '/app/dist/classes/command.class.js';
import { setAvailability, recoverAvailability, getAvailabilityAdapter, synchronizeAvailability } from '/app/dist/utils/availability/service.js';
import { internalWrite, availabilityState } from '/app/dist/utils/availability/schema.js';
import { enableCommandCommand } from '/app/dist/commands/enable_command.command.js';
import { disableCommandCommand } from '/app/dist/commands/disable_command.command.js';
import { parse } from '/app/dist/utils/ast_parser/parser.js';
import { evaluate, createExecutionContext } from '/app/dist/utils/ast_parser/evaluator.js';
import { registerAvailabilityFunctions } from '/app/dist/utils/ast_parser/functions/availability.functions.js';

assert.equal(new URL(process.env.MONGO_URI).hostname, 'mongo');
assert.equal(process.env.DRAGONFLY_HOST, 'redis');
const mongo = await getMongoDBConnection('availability-check');
const redis = await getDragonflyClient('availability-check');
const channelID = '998877';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = cmd => CommandsSchema.findOne({ channelID, cmd }).select('+availability +availabilityLease').lean();
const readReward = id => RedemptionRewardSchema.findOne({ channelID, rewardID: id }).select('+availability +availabilityLease').lean();
async function until(predicate, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(100); }
  assert.fail(label);
}
if (process.env.SAAS_TARGET === 'api' || process.env.SAAS_TARGET === 'bot') {
  const bot = process.env.SAAS_TARGET === 'bot';
  await until(async()=>{
    try {
      const response = await fetch(bot ? 'http://127.0.0.1:3333/eventsub' : 'http://127.0.0.1:3000/config/site/analytics',
        bot ? {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'} : {});
      return response.status === (bot ? 403 : 200);
    } catch { return false; }
  }, 'normal service entrypoint must become ready');
}
await redis.hSet(`accounts:twitch:${channelID}:data`, { id: channelID, name: 'availabilityfixture',
  plan_tier: 'pro', has_permissions: 'true', access_token: 'fixture-token', expires_at: String(Math.floor(Date.now()/1000)+3600) });
for (const cmd of ['discord', 'initiallyoff', 'cancel', 'renamed', 'deleted', 'race', 'recovery']) {
  await CommandsSchema.create({ channelID, channel: 'availabilityfixture', cmd, name: cmd,
    enabled: cmd !== 'initiallyoff', message: 'Hello', cooldown: 0 });
}
for (const [id,title] of [['r1','Hydrate please'],['r2','Retry reward'],['r3','Ambiguous'],['r4','Ambiguous']]) {
  await RedemptionRewardSchema.create({ channelID, channel: 'availabilityfixture', rewardID: id, title,
    eventsubID: 'fixture', originalCost: 10, cost: 10, isEnabled: true, createdFor: 'twitch' });
  await redis.set(`test:availability:reward:${id}`, 'true');
}
registerAvailabilityFunctions();
async function ast(source, level=7) {
  return String((await evaluate(parse(source).ast,createExecutionContext({broadcasterId:channelID,userLevel:level}))).value);
}
assert.equal((await Commands.getCommandFromDB(channelID,'discord')).command.enabled,true);
assert.equal(await ast('$(disable.command discord 30)'), '');
assert.equal((await Commands.getCommandFromDB(channelID,'discord')).command.enabled,false,'cached command must be invalidated immediately');
let doc=await read('discord');
assert.equal(doc.availability.previousEnabled,true);
const firstToken=doc.availability.token;
await setAvailability('command',channelID,'!discord',false,60);
doc=await read('discord');
assert.equal(doc.availability.previousEnabled,true,'extending must preserve the original state');
assert.notEqual(doc.availability.token,firstToken);
assert.equal((await internalWrite(CommandsSchema.updateOne({_id:doc._id,'availability.token':firstToken},{$set:{enabled:true}}))).matchedCount,0,'stale work must not overwrite a newer timer');
assert.equal((await disableCommandCommand(channelID,'discord')).error,false,'same-value permanent command cancels its timer');
assert.equal((await read('discord')).availability,undefined);
assert.equal((await enableCommandCommand(channelID,'discord')).error,false);
assert.equal((await read('discord')).enabled,true);
assert.equal((await enableCommandCommand(channelID,'missing-command')).status,404);
assert.equal((await disableCommandCommand(channelID,'missing-command')).status,404);

// Real expiry and startup recovery from another Node process, with no local JS timer.
await setAvailability('command',channelID,'recovery',false,1);
await sleep(1200);
execFileSync(process.execPath,['--input-type=module','-e',`
  const {getMongoDBConnection}=await import('/app/dist/utils/databases/mongodb.database.js');
  await getMongoDBConnection('availability-restarted');
  const {recoverAvailability}=await import('/app/dist/utils/availability/service.js');
  await recoverAvailability(); process.exit(0);
`],{stdio:'inherit',timeout:20000});
await until(async()=> (await read('recovery')).enabled===true,'restart must restore expired command');

await setAvailability('command',channelID,'initiallyoff',false,1);
await sleep(1100); await recoverAvailability();
assert.equal((await read('initiallyoff')).enabled,false,'already-disabled commands must remain disabled');
await setAvailability('command',channelID,'initiallyoff',true,1);
await sleep(1100); await recoverAvailability();
await until(async()=> (await read('initiallyoff')).enabled===false,'temporary enable must restore disabled');

// Dashboard-style updates cancel old restoration; unrelated edits do not.
await setAvailability('command',channelID,'cancel',false,60);
await CommandsSchema.findOneAndUpdate({channelID,cmd:'cancel'},{$set:{enabled:false,availability:{token:'client-supplied',restoreAt:new Date(0)}}});
const cancelledState=(await read('cancel')).availability;
assert.equal(cancelledState?.restoreAt ?? null,null);
assert.notEqual(cancelledState?.token,'client-supplied');
assert.equal((await CommandsSchema.findOne({channelID,cmd:'cancel'}).lean()).availability,undefined);
await recoverAvailability();
assert.equal((await read('cancel')).enabled,false);
await setAvailability('command',channelID,'renamed',false,60);
const renameId=(await read('renamed'))._id;
await CommandsSchema.findOneAndUpdate({_id:renameId},{$set:{cmd:'newname',message:'Edited'}});
assert.ok((await read('newname')).availability.restoreAt);
await internalWrite(CommandsSchema.updateOne({_id:renameId},{$set:{'availability.restoreAt':new Date(0),'availability.nextAt':new Date(0)}}));
await recoverAvailability();
await until(async()=> (await read('newname')).enabled===true,'renames preserve stable target identity');
await setAvailability('command',channelID,'deleted',false,60);
await CommandsSchema.deleteOne({channelID,cmd:'deleted'});
await CommandsSchema.create({channelID,cmd:'deleted',enabled:false});
await recoverAvailability();
assert.equal((await read('deleted')).enabled,false,'recreated names never inherit deleted deadlines');

assert.equal(await ast('$(disable.redemption "Hydrate please" 60)'), '');
assert.equal(await redis.get('test:availability:reward:r1'),'false');
assert.equal((await readReward('r1')).isEnabled,false);
await setAvailability('redemption',channelID,'r1',true);
assert.equal(await redis.get('test:availability:reward:r1'),'true');
assert.equal((await readReward('r1')).availability,undefined);
await assert.rejects(setAvailability('redemption',channelID,'Ambiguous',false),/ambiguous/);
await assert.rejects(setAvailability('command','other-channel','discord',false),/not found/);
await assert.rejects(setAvailability('redemption',channelID,'missing',false),/not found/);
for(const seconds of [0,-1,1.5,NaN,604801]) await assert.rejects(setAvailability('command',channelID,'discord',false,seconds),/Duration/);
assert.match(await ast('$(disable.command discord)',1),/permission denied/i);
assert.equal((await read('discord')).enabled,true);

// A failed remote write remains durable, and retries converge to the requested state.
await redis.set('test:availability:fail:r2','1');
await assert.rejects(setAvailability('redemption',channelID,'r2',false,60),/retry automatically/);
assert.equal((await readReward('r2')).availability.pending,true);
assert.equal(await redis.get('test:availability:reward:r2'),'true');
await redis.del('test:availability:fail:r2');
await internalWrite(RedemptionRewardSchema.updateOne({channelID,rewardID:'r2'},{$set:{'availability.nextAt':new Date(0)}}));
await recoverAvailability();
await until(async()=>await redis.get('test:availability:reward:r2')==='false','Twitch retry must succeed');
await internalWrite(RedemptionRewardSchema.updateOne({channelID,rewardID:'r2'},{$set:{'availability.restoreAt':new Date(0),'availability.nextAt':new Date(0)}}));
await recoverAvailability();
await until(async()=>await redis.get('test:availability:reward:r2')==='true','restoration must also synchronize Twitch');

// Long downtime is recovered without a TTL or grace-period cutoff.
await internalWrite(CommandsSchema.updateOne({channelID,cmd:'recovery'},{$set:{enabled:false,
  availability:{...availabilityState(true,new Date(0)),pending:false,nextAt:new Date(0)},
  availabilityLease:{token:'crashed-owner',until:new Date(0)}}}));
await recoverAvailability();
await until(async()=> (await read('recovery')).enabled===true,'expired leases and old deadlines recover');

// A manual edit during an in-flight external call is eventually authoritative.
const adapter=getAvailabilityAdapter('redemption');
const originalSync=adapter.sync;
let edited=false;
adapter.sync=async document=>{
  await originalSync(document);
  if(!edited){ edited=true; await RedemptionRewardSchema.findOneAndUpdate({_id:document._id},{$set:{isEnabled:true}}); }
};
const raceReward=await readReward('r1');
await internalWrite(RedemptionRewardSchema.updateOne({_id:raceReward._id},{$set:{isEnabled:false,
  availability:{...availabilityState(true,new Date(Date.now()+60000)),nextAt:new Date(Date.now()+60000)}}}));
await synchronizeAvailability(adapter,String(raceReward._id),channelID);
adapter.sync=originalSync;
await recoverAvailability();
await until(async()=>await redis.get('test:availability:reward:r1')==='true','newer manual state wins over an in-flight request');
assert.equal((await readReward('r1')).availability,undefined);
await Promise.all([setAvailability('command',channelID,'race',false,60),setAvailability('command',channelID,'race',true,60)]);
await setAvailability('command',channelID,'race',false);
await recoverAvailability();
assert.equal((await read('race')).enabled,false);
assert.equal((await read('race')).availability,undefined);

if(process.env.SAAS_TARGET==='cron'){
  await setAvailability('command',channelID,'recovery',false,1);
  await until(async()=> (await read('recovery')).enabled===true,'normal cron entrypoint must restore without test-driven recovery');
}
execFileSync(process.execPath,['--experimental-test-module-mocks','--test',
  'dist/utils/ast_parser/availability.test.js','dist/utils/ast_parser/channel_actions.test.js',
  'dist/utils/ast_parser/command_references.test.js'],{stdio:'inherit',timeout:30000});
await mongo.connection.close(); await redis.quit();
console.log(`PASS ${process.env.SAAS_TARGET}: AST availability, cached commands, Twitch rewards, timed restore, overlap, manual overrides, identity, failures, restart recovery and real cron scheduling`);
process.exit(0);
