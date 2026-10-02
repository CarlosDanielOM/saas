// Runs against task-owned databases and mocked external providers only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getMongoDBConnection } from '/app/dist/utils/databases/mongodb.database.js';
import { getDragonflyClient } from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import { getChannelTtsSettings, upsertChannelTtsSettings } from '/app/dist/schemas/channel_tts_settings.schema.js';
import { trackTtsUsage, calculateTtsUsage } from '/app/dist/utils/tts_usage.js';
await getMongoDBConnection('KokoroCheck');
const redis = await getDragonflyClient('KokoroCheck');
const channel = '99118801';
const customer = '11111111-1111-4111-8111-111111111111';
const credits = async balance => {
  await redis.del([`twitch:${channel}:ai:exhaust`,`${channel}:ai:exhaust`]);
  return redis.set(`twitch:${channel}:ai:credits`, JSON.stringify({
  version: 3, used: 0, limit: 10000, balance, available: true, status: balance > 0 ? 'available' : 'exhausted'
}), { EX: 300 });
};
await Users.create({ name: 'existing', accounts: [{type:'twitch',id:channel,name:'existing'}] });
assert.equal((await getChannelTtsSettings(channel)).provider, 'piper', 'existing user with no settings remains Piper');
const newChannel = '99118802';
await Users.create({ name: 'new', tts_default_provider: 'kokoro', accounts: [{type:'twitch',id:newChannel,name:'new'}] });
assert.equal((await getChannelTtsSettings(newChannel)).provider, 'kokoro', 'new user defaults to Kokoro');
for (const provider of ['piper', 'fish']) {
  await upsertChannelTtsSettings(newChannel, { provider });
  assert.equal((await getChannelTtsSettings(newChannel)).provider, provider, 'saved choice wins over new-user marker');
}
assert.equal(new Users({name:'legacy'}).tts_default_provider, undefined, 'hydration never assigns the marker');
await redis.hSet(`accounts:twitch:${channel}:data`, { id:channel,name:'existing',polar_sh_customer_id:customer,plan_tier:'free' });
await credits(10000);
const usage = await trackTtsUsage({ channelID:channel,streamer:{polar_sh_customer_id:customer},provider:'kokoro',characters:16,
  text:'0123456789abcdef',usage:{entryId:'kokoro-test-debit'} });
assert.equal(usage.creditsConsumed,2);
assert.equal(JSON.parse(await redis.get(`twitch:${channel}:ai:credits`)).balance,9998);
assert.equal(await redis.hGet(`${channel}:tts:usage`,'kokoro_credits'),'2');
for (const [characters,cost] of [[1,1],[15,1],[16,2],[30,2],[31,3],[45,3],[46,4]]) {
  assert.equal(calculateTtsUsage('kokoro',characters).creditsConsumed,cost);
}
fs.mkdirSync('/dimasite/src/app/models',{recursive:true});
fs.copyFileSync('/tmp/saas-fixtures/tts-settings.model.ts','/dimasite/src/app/models/tts-settings.model.ts');
const unitFiles = ['server/services/tts/kokoro_tts.test.js','server/services/tts/fish_tts_backend.test.js',
  'utils/tts_usage.test.js','utils/ast_parser/tts_settings.test.js','handlers/tts_credit_fallback.test.js',
  'handlers/tts_queue_credits.test.js','utils/tts/expressive_tts_tags.test.js'];
// Direct test-file execution also emits individual subtest results on Node 26.
for (const file of unitFiles) execFileSync(process.execPath,['--experimental-test-module-mocks',`/app/dist/${file}`],{
  stdio:'inherit',timeout:60000,env:{...process.env,NODE_OPTIONS:''}
});
if (process.env.SAAS_TARGET !== 'api') {
  await upsertChannelTtsSettings(channel, {provider:'kokoro',voices:{en:'en_US-ryan-medium',es:'es_MX-ald-medium',kokoroDefault:'ef_dora'}});
  const {queueDefaultTts}=await import('/app/dist/utils/tts/queue_default_tts.util.js');
  assert.equal((await queueDefaultTts({channelID:channel,rawMessage:'Hello',source:'ast',emoteNames:[]})).error,false);
  const calls=fs.readFileSync('/tmp/saas-fixtures/calls.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(calls.filter(call=>call.speech).at(-1).speech.provider,'kokoro');
  assert.equal((await queueDefaultTts({channelID:channel,rawMessage:'Hola',source:'ast',preferredMode:'kokoro',cloneName:'em_alex',emoteNames:[]})).error,false);
  const next=fs.readFileSync('/tmp/saas-fixtures/calls.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(next.filter(call=>call.speech).at(-1).speech.voice,'em_alex');
}
if (process.env.SAAS_TARGET === 'api') {
  const token='kokoro-fixture';
  await redis.hSet(`token:${token}`,{id:channel,login:'existing',display_name:'Existing'});
  const request=async(path,method='GET',body)=>{
    const response=await fetch('http://127.0.0.1:3000'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  let response=await request(`/speech/settings/${channel}`);
  assert.equal(response.status,200);
  assert.equal(response.body.data.kokoroVoices.length,54);
  const settings=response.body.data.settings;
  settings.provider='kokoro';settings.voices.kokoroDefault='ef_dora';
  assert.equal((await request(`/speech/settings/${channel}`,'PUT',settings)).status,200);
  assert.equal((await request(`/speech/settings/${channel}`)).body.data.settings.provider,'kokoro');
  assert.equal((await request(`/speech/settings/${channel}`,'PUT',{...settings,voices:{...settings.voices,kokoroDefault:'gojo'}})).status,400);
  assert.equal((await request(`/speech/${channel}`,'POST',{provider:'kokoro',voice:'invalid',text:'Hello'})).status,400);
  assert.equal((await request(`/speech/${channel}`,'POST',{provider:'kokoro',text:' '})).status,400);
  const ws=new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket');
  const messages=[];
  ws.addEventListener('message',event=>{
    const m=String(event.data);
    if(m==='2')ws.send('3');
    else if(m.startsWith('0'))ws.send(`40/speech/${channel},`);
    else messages.push(m);
  });
  const wait=async prefix=>{
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      const i=messages.findIndex(m=>m.startsWith(prefix));
      if(i>=0)return messages.splice(i,1)[0];
      await new Promise(r=>setTimeout(r,10));
    }
    throw Error('socket timeout '+prefix);
  };
  await wait(`40/speech/${channel},`);
  ws.send(`42/speech/${channel},${JSON.stringify(['speech-overlay-ready'])}`);
  await new Promise(r=>setTimeout(r,100));
  const calls=()=>fs.existsSync('/tmp/saas-fixtures/calls.jsonl')?fs.readFileSync('/tmp/saas-fixtures/calls.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  for(const scenario of ['success','unicode','exhausted','provider-failure']){
    await credits(scenario==='exhausted'?0:10000);
    fs.writeFileSync('/tmp/saas-fixtures/state.json',JSON.stringify({fail:scenario==='provider-failure'}));
    const before=calls().filter(x=>x.kokoro).length;
    response=await request(`/speech/${channel}`,'POST',{provider:'kokoro',voice:'af_heart',text:scenario==='unicode'?'😀'.repeat(15):'0123456789abcdef',language:'en'});
    assert.equal(response.status,200,JSON.stringify(response));
    const line=await wait(`42/speech/${channel},["speech",`);
    const [,payload]=JSON.parse(line.slice(`42/speech/${channel},`.length));
    assert.equal(payload.mimeType,['success','unicode'].includes(scenario)?'audio/mpeg':'audio/wav');
    const audio=await fetch(payload.audioUrl.replace('https://api.domdimabot.com','http://127.0.0.1:3000'));
    assert.equal(audio.status,200);assert.ok((await audio.arrayBuffer()).byteLength>44);
    const newCalls=calls().filter(x=>x.kokoro).slice(before);
    assert.equal(newCalls.length,scenario==='exhausted'?0:1);
    if(newCalls.length)assert.deepEqual(newCalls[0].kokoro.provider,{only:['deepinfra'],order:['deepinfra'],allow_fallbacks:false});
    const balance=JSON.parse(await redis.get(`twitch:${channel}:ai:credits`)).balance;
    assert.equal(balance,scenario==='success'?9998:scenario==='unicode'?9999:scenario==='exhausted'?0:10000,'only successful Kokoro consumes credits');
    ws.send(`42/speech/${channel},${JSON.stringify(['speech-ended',{speechID:payload.speechID}])}`);
    await new Promise(r=>setTimeout(r,100));
  }
  ws.close();
}
console.log(`PASS ${process.env.SAAS_TARGET}: Kokoro routing, preset voices, ceil(chars/15), defaults, saved choices, durable debits, AST and Piper fallbacks`);
process.exit(0);
