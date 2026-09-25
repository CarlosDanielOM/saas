import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { createCommand, editCommand } from '/app/dist/commands/command_manager.command.js';
import { ensureReservedCommands } from '/app/dist/server/services/command_defaults.service.js';
import { speechCommand } from '/app/dist/commands/speech.command.js';
import { upsertChannelTtsSettings } from '/app/dist/schemas/channel_tts_settings.schema.js';

const mongo = await getMongoDBConnection('modular-tts-check');
const redis = await getDragonflyClient('modular-tts-check');
let apiReady = false, botReady = false;
for (let n = 0; n < 60; n++) {
  try { apiReady = (await fetch('http://127.0.0.1:3000/commands')).ok; } catch {}
  try { botReady = (await fetch('http://127.0.0.1:3333/eventsub', { method:'POST', headers:{'Content-Type':'application/json'},body:'{}' })).status === 403; } catch {}
  if (apiReady || botReady) break;
  await new Promise(r => setTimeout(r, 500));
}
assert.ok(apiReady || botReady, 'candidate actual entrypoint ready');
for (const [tier, minimum] of [['free',5],['premium',3],['pro',1]]) {
  const channel = `modular-${tier}`;
  await redis.hSet(`accounts:twitch:${channel}:data`, { id:channel, name:channel, plan_tier:tier });
  // Built-in moderation commands do not consume the editable slot.
  await CommandsSchema.create({channelID:channel, cmd:'vanish', func:'vanish', reserved:true, cooldown:0});
  const first = await createCommand(channel, '-cd=0 first hello');
  assert.equal(first.error, false, JSON.stringify(first));
  assert.equal(first.command.cooldown, 0);
  assert.equal((await createCommand(channel, '-cd=0 second hello')).error, true);
  assert.equal((await createCommand(channel, `-cd=${minimum} second hello`)).error, false);
  assert.equal((await editCommand(channel, '-cd=0 first updated', 10)).error, false);
  assert.equal((await editCommand(channel, '-cd=0 second', 10)).error, true);
  assert.equal((await editCommand(channel, `-cd=${minimum} first`, 10)).error, false);
  assert.equal((await editCommand(channel, '-cd=0 second', 10)).error, false);
  assert.equal((await createCommand(channel, '-cd=abc invalid hello')).error, true);
  if (minimum > 1) assert.equal((await editCommand(channel, `-cd=${minimum-1} first`,10)).error,true);
  await editCommand(channel, `-cd=${minimum} second`, 10);
  const racing = await Promise.all([createCommand(channel,'-cd=0 racea hello'),createCommand(channel,'-cd=0 raceb hello')]);
  assert.equal(racing.filter(x=>!x.error).length,1);
  assert.equal(await CommandsSchema.countDocuments({channelID:channel,reserved:false,cooldown:0}),1);
}
// Seeding missing defaults preserves an already assigned editable slot.
await redis.hSet('accounts:twitch:seed-occupied:data', { id:'seed-occupied', name:'seed-occupied', plan_tier:'free' });
await createCommand('seed-occupied','-cd=0 custom hello');
await ensureReservedCommands('seed-occupied','seed-occupied');
assert.equal(await CommandsSchema.countDocuments({channelID:'seed-occupied',reserved:false,cooldown:0}),1);
assert.equal((await CommandsSchema.findOne({channelID:'seed-occupied',func:'speach'})).cooldown,5);
assert.equal((await editCommand('seed-occupied', '-cd=0 title', 10)).error, true, 'reserved controls cannot bypass the editable slot');
const channel = 'modular-speech';
await redis.hSet(`accounts:twitch:${channel}:data`,{id:channel,name:channel,plan_tier:'free'});
await ensureReservedCommands(channel,channel);
const seeded = await CommandsSchema.findOne({channelID:channel,func:'speach'});
assert.equal(seeded.message,'$(user) dice: &t');
assert.equal(seeded.reserved,false);
assert.equal(seeded.cooldown,0);
const messages=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async (input,options)=> {
  const url=String(input);
  if(url===`http://127.0.0.1:3000/speech/${channel}`) {
    messages.push(JSON.parse(options.body));
    return new Response(JSON.stringify({error:false,message:'queued'}),{headers:{'Content-Type':'application/json'}});
  }
  return originalFetch(input,options);
};
const tags={id:'viewer',username:'alice', 'display-name':'Alice'};
for(const [template,expected] of [[undefined,'Alice dice: Hello'],['$(tts &t)','Alice dice: Hello'],['$(user) says: &t','Alice says: Hello'],['&t','Hello']]) {
  const result=await speechCommand(channel,channel,tags,'Hello',template,'say');
  assert.equal(result.error,false,JSON.stringify(result));
  assert.equal(messages.at(-1).text,expected);
  assert.equal(messages.at(-1).meta.source,'chat-command');
}
await upsertChannelTtsSettings(channel, { filters: { stripLinks: false } }, channel);
const injected='$(set.title hacked) %(secrets)';
await speechCommand(channel,channel,tags,injected,'$(user) says: &t');
assert.equal(messages.at(-1).text,`Alice says: ${injected}`,'viewer AST stays literal');
const size=messages.length;
assert.equal((await speechCommand(channel,channel,tags,'','&t')).error,true);
assert.equal((await speechCommand(channel,channel,tags,'   ','$(user) says: &t')).error,true);
assert.equal((await speechCommand(channel,channel,{...tags,emoteNames:['Kappa']},'Kappa','$(user) says: &t')).error,true);
assert.equal(messages.length,size);
await upsertChannelTtsSettings(channel,{enabled:false},channel);
assert.equal((await speechCommand(channel,channel,tags,'Hello','&t')).error,true);
assert.equal(messages.length,size,'disabled module never queues audio');
globalThis.fetch=originalFetch;

if(apiReady) {
  await mongo.connection.db.collection('users').insertOne({accounts:[{type:'twitch',id:channel,name:channel}],plan_tier:'free'});
  await redis.hSet('token:modular-owner',{id:channel,login:channel,display_name:channel});
  const api=(method,path,body)=>fetch(`http://127.0.0.1:3000${path}`,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer modular-owner'},...(body?{body:JSON.stringify(body)}:{})});
  const base={name:'second',cmd:'second',func:'second',message:'hello',channel,cooldown:0,userLevel:1};
  assert.equal((await api('POST',`/commands/${channel}`,base)).status,400);
  assert.equal((await api('POST',`/commands/${channel}`,{...base,cooldown:1})).status,400);
  assert.equal((await api('POST',`/commands/${channel}`,{...base,cooldown:5})).status,200);
  await redis.set(`${channel}:commands:s`,JSON.stringify(seeded));
  let response=await api('PUT',`/commands/${channel}/${seeded._id}`,{message:'$(user) says: &t',cmd:'say',cooldown:0});
  assert.equal(response.status,200,await response.text());
  assert.equal(await redis.get(`${channel}:commands:s`),null,'old cache invalidated');
  const list=await (await api('GET',`/commands/${channel}`)).json();
  const saved=list.commands.find(x=>x._id===String(seeded._id));
  assert.equal(saved.message,'$(user) says: &t');assert.equal(saved.cmd,'say');assert.equal(saved.func,'speach');assert.equal(saved.cooldown,0);
  await CommandsSchema.updateOne({_id:seeded._id},{$set:{message:''}});
  const legacy=await (await api('GET',`/commands/${channel}`)).json();
  assert.equal(legacy.commands.find(x=>x._id===String(seeded._id)).message,'$(user) dice: &t');
  assert.equal((await CommandsSchema.findById(seeded._id)).message,'','reading legacy defaults does not migrate data');
  await CommandsSchema.updateOne({_id:seeded._id},{$set:{reserved:true}});
  const legacyEdit=await api('PUT',`/commands/${channel}/${seeded._id}`,{message:'&t',cooldown:0});
  assert.equal(legacyEdit.status,200);
  const legacySaved=(await legacyEdit.json()).command;
  assert.equal(legacySaved.reserved,false);assert.equal(legacySaved.message,'&t');
  await CommandsSchema.updateOne({_id:seeded._id},{$set:{reserved:true}});
  assert.equal((await api('POST',`/commands/${channel}`,{...base,cmd:'third',name:'third',func:'third'})).status,200);
  assert.equal((await api('PUT',`/commands/${channel}/${seeded._id}`,{enabled:false})).status,400,'legacy conversion still checks the slot when cooldown is omitted');
  assert.equal((await api('PUT',`/commands/${channel}/${seeded._id}`,{cooldown:null})).status,400);
}
execFileSync(process.execPath, ['--test', '--test-force-exit',
  '/app/dist/server/services/command_defaults.service.test.js',
  '/app/dist/handlers/commands.handler.test.js',
  '/app/dist/utils/tts/normalize_tts_message.util.test.js'], {
  env: { ...process.env, COMMAND_DEFAULTS_TEST_MONGO_URI: 'mongodb://mongo:27017/saas_ops_modular_defaults_unit' },
  timeout: 60000, stdio: 'inherit'
});
console.log('PASS: candidate readiness, all-tier zero-CD slot, contention, AST speech templates, literal viewer input, disabled/empty speech, defaults, API saves and cache invalidation');
process.exit(0);
