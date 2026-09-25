import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import { CommandsSchema } from '/app/dist/schemas/commands.schema.js';
import { createCommand, editCommand } from '/app/dist/commands/command_manager.command.js';
import { ensureReservedCommands } from '/app/dist/server/services/command_defaults.service.js';
import { commandHandler } from '/app/dist/handlers/commands.handler.js';
import Commands from '/app/dist/classes/command.class.js';
import { createUserIdentity } from '/app/dist/utils/permissions/index.js';
import { readFileSync } from 'node:fs';
import { upsertChannelTtsSettings } from '/app/dist/schemas/channel_tts_settings.schema.js';

const mongo = await getMongoDBConnection('modular-tts-check');
const redis = await getDragonflyClient('modular-tts-check');
let apiReady = false, botReady = false;
const cronReady = readFileSync('/proc/1/cmdline', 'utf8').includes('dist/workers/cron.index.js');
for (let n = 0; n < 60; n++) {
  try { apiReady = (await fetch('http://127.0.0.1:3000/commands')).ok; } catch {}
  try { botReady = (await fetch('http://127.0.0.1:3333/eventsub', { method:'POST', headers:{'Content-Type':'application/json'},body:'{}' })).status === 403; } catch {}
  if (apiReady || botReady || cronReady) break;
  await new Promise(r => setTimeout(r, 500));
}
assert.ok(apiReady || botReady || cronReady, 'candidate actual entrypoint ready');
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
assert.equal(seeded.message,'$(tts $(user) dice: &t)');
assert.equal(seeded.reserved,false);
assert.equal(seeded.cooldown,0);
const messages=[];
const chatMessages=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async (input,options)=> {
  const url=String(input);
  if(url===`http://127.0.0.1:3000/speech/${channel}`) {
    messages.push(JSON.parse(options.body));
    return new Response(JSON.stringify({error:false,message:'queued'}),{headers:{'Content-Type':'application/json'}});
  }
  if(url==='https://api.twitch.tv/helix/chat/messages') {
    chatMessages.push(JSON.parse(options.body).message);
    return new Response(JSON.stringify({data:[{is_sent:true,message_id:'fixture'}]}),{headers:{'Content-Type':'application/json'}});
  }
  return originalFetch(input,options);
};
const event={chatter_user_id:'viewer',chatter_user_login:'alice',chatter_user_name:'Alice',message:{fragments:[{type:'emote',text:'Kappa'}]}};
const authorization={origin:'chat',identity:createUserIdentity(1,[])};
const run=async(template,argument='Hello',name='s')=>{
  assert.equal((await Commands.updateCommandInDB(channel,name,{message:template,enabled:true})).error,false);
  return commandHandler(channel,event,name,argument,authorization);
};
for(const [template,expected] of [['$(tts $(user) dice: &t)','Alice dice : Hello'],['$(tts &t)','Hello'],['$(tts $(user) says: &t)','Alice says : Hello']]) {
  const size=messages.length;
  const result=await run(template);
  assert.equal(result.error,false,JSON.stringify(result));
  assert.equal(result.message,'','tts AST returns no chat response');
  assert.equal(messages.length,size+1,'exactly one synthesis per AST invocation');
  assert.equal(messages.at(-1).text,expected);
  assert.equal(messages.at(-1).meta.source,'ast');
}
let size=messages.length;
assert.equal((await run('$(user) says: &t')).message,'Alice says: Hello');
assert.equal(messages.length,size,'plain text no longer triggers implicit speech');
await CommandsSchema.create({channelID:channel,channel,cmd:'ordinary',func:'ordinary',name:'Ordinary',enabled:true,userLevel:1,cooldown:5,message:''});
await run('$(tts $(user) dice: &t)','Hello','ordinary');
assert.equal(messages.at(-1).text,'Alice dice : Hello','any normal command can invoke TTS');
assert.equal((await run('Before $(tts &t) after')).message,'Before  after','normal commands can combine speech and chat text');
assert.equal((await run('First: &p1; rest: &t','one two three')).message,'First: one; rest: two three');
await upsertChannelTtsSettings(channel, { filters: { stripLinks: false } }, channel);
const injected='$(set.title hacked) %(secrets)';
await run('$(tts $(user) says: &t)',injected);
assert.equal(messages.at(-1).text,`Alice says : ${injected}`,'viewer AST stays literal in the ordinary command pipeline');
assert.equal((await run('Echo &t',injected)).message,`Echo ${injected}`);
await run('$(tts &t)','Hello Kappa');
assert.equal(messages.at(-1).text,'Hello','AST TTS preserves the emote filter');
if(botReady) {
  const {messageHandler}=await import('/app/dist/handlers/message.handler.js');
  const {ChannelModerationSettingsSchema}=await import('/app/dist/schemas/channel_moderation_settings.schema.js');
  await ChannelModerationSettingsSchema.create({channelID:channel,channel,enabled:false});
  await redis.set('app:twitch:token','test-only');
  const chatEvent={...event,badges:[],message_id:'normal-tts-dispatch',message:{text:'!s Hello',fragments:[]}};
  await Commands.updateCommandInDB(channel,'s',{message:'$(tts $(user) dice: &t)'});
  size=messages.length;
  await messageHandler(channel,chatEvent);
  assert.equal(messages.length,size+1,'real message dispatcher executes the normal TTS AST');
  assert.equal(messages.at(-1).text,'Alice dice : Hello');
  await Commands.updateCommandInDB(channel,'s',{message:'Plain &t'});
  size=messages.length;
  await messageHandler(channel,{...chatEvent,message_id:'normal-plain-dispatch'});
  for(let i=0;i<100&&!chatMessages.includes('Plain Hello');i++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(chatMessages.includes('Plain Hello'),'plain body reaches chat through the same dispatcher');
  assert.equal(messages.length,size,'no implicit synthesis in the actual message dispatcher');
}
size=messages.length;
await upsertChannelTtsSettings(channel,{enabled:false},channel);
assert.match((await run('$(tts &t)')).message,/disabled/);
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
  let response=await api('PUT',`/commands/${channel}/${seeded._id}`,{message:'$(tts $(user) says: &t)',cmd:'say',cooldown:0});
  assert.equal(response.status,200,await response.text());
  assert.equal(await redis.get(`${channel}:commands:s`),null,'old cache invalidated');
  const list=await (await api('GET',`/commands/${channel}`)).json();
  const saved=list.commands.find(x=>x._id===String(seeded._id));
  assert.equal(saved.message,'$(tts $(user) says: &t)');assert.equal(saved.cmd,'say');assert.equal(saved.func,'speach');assert.equal(saved.cooldown,0);
  const plain=await api('PUT',`/commands/${channel}/${seeded._id}`,{message:'Just text &t'});
  assert.equal((await plain.json()).command.message,'Just text &t');
  const reread=await (await api('GET',`/commands/${channel}`)).json();
  assert.equal(reread.commands.find(x=>x._id===String(seeded._id)).message,'Just text &t','API neither wraps nor rewrites normal command bodies');
  assert.equal((await api('PUT',`/commands/${channel}/${seeded._id}`,{cooldown:null})).status,400);
}
const legacyFree=await CommandsSchema.create({channelID:'legacy-free-slot',channel:'legacy',cmd:'s',func:'speach',message:'',reserved:true,cooldown:0});
const legacy=await CommandsSchema.create({channelID:'legacy-migration',channel:'legacy',cmd:'s',func:'speach',message:'$(user) dice: &t',reserved:true,cooldown:0});
await CommandsSchema.create({channelID:'legacy-migration',cmd:'custom',func:'custom',message:'hello',reserved:false,cooldown:0});
await redis.set('legacy-migration:commands:s',JSON.stringify(legacy));
const migration='/app/dist/scripts/migrate_speech_ast.script.js';
const backup='/tmp/speech-ast-test-backup.json';
const migrate=mode=>execFileSync(process.execPath,[migration,mode,backup],{timeout:30000,stdio:'inherit'});
migrate('--prepare');migrate('--apply');
let converted=await CommandsSchema.findById(legacy._id);
assert.equal(converted.message,'$(tts $(user) dice: &t)');assert.equal(converted.reserved,false);assert.equal(converted.cooldown,5);
assert.equal(await redis.get('legacy-migration:commands:s'),null);
assert.equal((await CommandsSchema.findById(legacyFree._id)).cooldown,0);
assert.equal((await CommandsSchema.findById(legacyFree._id)).message,'$(tts $(user) dice: &t)');
migrate('--apply');migrate('--rollback');
converted=await CommandsSchema.findById(legacy._id);
assert.equal((await CommandsSchema.findById(legacyFree._id)).message,'');
assert.equal((await CommandsSchema.findById(legacyFree._id)).reserved,true);
assert.equal(converted.message,legacy.message);assert.equal(converted.reserved,true);assert.equal(converted.cooldown,0);
await CommandsSchema.updateOne({_id:legacy._id},{$set:{message:'A concurrent edit'}});
const conflict=spawnSync(process.execPath,[migration,'--apply',backup],{timeout:30000,encoding:'utf8'});
assert.equal(conflict.status,1,'migration rejects concurrent edits');
assert.equal((await CommandsSchema.findById(legacy._id)).message,'A concurrent edit');

execFileSync(process.execPath, ['--test', '--test-force-exit',
  '/app/dist/server/services/command_defaults.service.test.js',
  '/app/dist/handlers/commands.handler.test.js',
  '/app/dist/utils/tts/normalize_tts_message.util.test.js'], {
  env: { ...process.env, COMMAND_DEFAULTS_TEST_MONGO_URI: 'mongodb://mongo:27017/saas_ops_modular_defaults_unit' },
  timeout: 60000, stdio: 'inherit'
});
console.log('PASS: candidate readiness, all-tier zero-CD slot, contention, ordinary AST commands, explicit TTS only, literal viewer input, module filters, migration/rollback, API saves and cache invalidation');
process.exit(0);
