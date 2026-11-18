// Chat sound against the real API candidate: settings routes, the private OBS link, the OBS socket fed by the bot's
// chat feed (Redis "widget-feed"), filters, cooldown, tests, demand marking and link replacement.
// Disposable Mongo/Dragonfly and the duel provider fixtures only:
//   scripts/saas-ops verify api-RUN --dependency mongo --dependency redis \
//     --test-env ops/checks/duel-fixtures/test-env.json --fixtures ops/checks/duel-fixtures --check ops/checks/chat-sound-api.mjs
import assert from 'node:assert/strict';
assert.equal(process.env.SAAS_TARGET,'api','run against an api candidate');
const {getMongoDBConnection}=await import('/app/dist/utils/databases/mongodb.database.js');
const {getDragonflyClient}=await import('/app/dist/utils/databases/dragonfly.database.js');
await getMongoDBConnection('chat-sound-test');const redis=await getDragonflyClient('chat-sound-test');
const {default:Users}=await import('/app/dist/schemas/users.schema.js');
const {encrypt}=await import('/app/dist/utils/crypto.js');
const channel='991901',other='991902',gone='991903',bot='698614112',base='http://127.0.0.1:3000';
for(const [id,name,tier] of [[channel,'soundfixture','free'],[other,'othersound','free'],[gone,'gonesound','free']]){
  await Users.collection.insertOne({accounts:[{id,type:'twitch',name,has_permissions:true,up_to_date_permissions:true,actived:true,chat_enabled:true,access_token:encrypt('fixture'),refresh_token:encrypt('fixture-refresh'),access_token_expires_at:Math.floor(Date.now()/1000)+3600}],plan_tier:tier});
  await redis.hSet('accounts:twitch:'+id+':data',{id,name,has_permissions:'true',access_token:'fixture',expires_at:String(Math.floor(Date.now()/1000)+3600),userPlan:tier});
}
await redis.hSet('token:cs-owner',{id:channel,login:'soundfixture',display_name:'Sound Fixture'});
await redis.hSet('token:cs-other',{id:other,login:'othersound',display_name:'Other'});
await redis.hSet('token:cs-gone',{id:gone,login:'gonesound',display_name:'Gone'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(check,message,ms=6000){const end=Date.now()+ms;for(;;){if(await check())return;if(Date.now()>end)throw new Error(message);await sleep(40);}}
async function request(method,path,body,status=200,token='cs-owner',headers={}){
  const response=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(data)}`);return data.status===200?data.data:data;
}
const root='/chat-sound/'+channel;
const put=(settings,revision)=>request('PUT',root+'/settings',settings,200,'cs-owner',{'If-Match':String(revision)});
/** Raw Socket.IO v4 client for the OBS namespace (the page uses socket.io-client with websocket transport). */
function connect(token,target=channel){
  const ns='/overlays/chat-sound',ws=new WebSocket(base.replace('http:','ws:')+'/socket.io/?EIO=4&transport=websocket'),events=[];let state='opening';
  ws.addEventListener('message',e=>{const t=String(e.data);
    if(t.startsWith('0{'))ws.send('40'+ns+','+JSON.stringify({channel:target,token}));
    else if(t==='2')ws.send('3');
    else if(t.startsWith('40'+ns))state='connected';
    else if(t.startsWith('44'+ns)){state='refused';events.push(['connect_error',JSON.parse(t.slice(t.indexOf(',')+1))]);}
    else if(t.startsWith('41'+ns))state='kicked';
    else if(t.startsWith('42'+ns))events.push(JSON.parse(t.slice(t.indexOf(',')+1)));
  });
  ws.addEventListener('close',()=>{if(state==='connected')state='closed';});
  return {events,get state(){return state;},emit:(event,data)=>ws.send('42'+ns+','+JSON.stringify([event,data])),close:()=>ws.close(),
    pops:()=>events.filter(e=>e[0]==='chat-sound-pop').map(e=>e[1]),settings:()=>events.filter(e=>e[0]==='chat-sound-settings').map(e=>e[1])};
}
let n=0;
/** What the bot publishes for each chat message (src/widget_feed/publisher.ts). */
const chat=(patch={},target=channel)=>redis.publish('widget-feed',JSON.stringify({channel:target,type:'chat',timestamp:Date.now(),...(patch.test?{test:true}:{}),data:{
  id:'m'+(++n),platform:'twitch',at:Date.now(),user:{id:patch.id??'555',login:patch.login??'viewer',name:patch.login??'viewer',color:null,badges:[],roles:{broadcaster:false},subMonths:null},
  text:patch.text??'hello chat',parts:[],kind:'text',action:false,firstMessage:false,bits:0,rewardId:null,reply:null,sharedChat:patch.shared?{channelId:patch.shared,messageId:'x'}:null}}));
async function expectPops(socket,count,message,ms=1500){await wait(()=>socket.pops().length===count,`${message} (have ${socket.pops().length}, want ${count})`,ms);}
async function expectNoNewPop(socket,count,message){await sleep(700);assert.equal(socket.pops().length,count,message);}

// Access: signed-in owner or full-access admin only.
await request('GET',root,undefined,401,'');
await request('GET',root,undefined,403,'cs-other');
let state=await request('GET',root);
assert.deepEqual(state.settings,{enabled:true,volume:70,ignoreBots:true,ignoreSelf:true,ignoreCommands:false,ignoreSharedChat:false,cooldownSeconds:1,quietMinutes:0},'defaults');
assert.equal(state.revision,0);assert.equal(state.linked,false);assert.deepEqual(state.status,{sources:0,ready:0,obsPlaying:0,tabPlaying:0,obsSilent:0,tabSilent:0,outdated:0});
assert.equal(await Users.db.collection('chat_sound_channels').countDocuments({_id:channel}),0,'reading creates nothing');
// Strict saves with the revision the page loaded.
await request('PUT',root+'/settings',state.settings,400);
for(const bad of [{...state.settings,volume:101},{...state.settings,extra:true},{...state.settings,cooldownSeconds:0.1},{...state.settings,quietMinutes:2.5},{...state.settings,enabled:'yes'}])
  await request('PUT',root+'/settings',bad,400,'cs-owner',{'If-Match':'0'});
state=await put({...state.settings,cooldownSeconds:0.25},0);assert.equal(state.revision,1);assert.equal(state.settings.cooldownSeconds,0.25);
await request('PUT',root+'/settings',state.settings,409,'cs-owner',{'If-Match':'0'});
// The private OBS link: created once, read back unchanged, never by another channel.
assert.equal((await request('GET',root+'/overlay-token')).exists,false);
const link=await request('POST',root+'/overlay-token',{});assert.match(link.token,/^[\w-]{43}$/);
assert.equal((await request('GET',root+'/overlay-token')).token,link.token);assert.equal((await request('POST',root+'/overlay-token',{})).token,link.token,'creating again returns the same link');
await request('GET',root+'/overlay-token',undefined,403,'cs-other');
assert.equal((await request('GET',root)).linked,true);
assert.equal((await request('GET',root)).revision,1,'a link does not bump the settings revision');

// Sockets: wrong token, another channel, an unknown channel and a malformed channel are refused.
for(const [token,target] of [['x'.repeat(43),channel],[link.token,other],[link.token,'123'],[link.token,'../991901'],[link.token,'']]){
  const s=connect(token,target);await wait(()=>s.state==='refused','refused '+target);assert.match(s.events[0][1].message,/Invalid chat sound link/);s.close();
}
const obs=connect(link.token);await wait(()=>obs.state==='connected','OBS source connects');
await wait(()=>obs.settings().length>0,'settings arrive on connect');assert.deepEqual(obs.settings()[0],{v:1,revision:1,enabled:true,volume:70});
// Chat flows: the bot is told someone listens for this channel (demand key with a TTL).
await wait(async()=>await redis.exists('widget-feed:demand:'+channel)===1,'demand marked');
const ttl=await redis.ttl('widget-feed:demand:'+channel);assert(ttl>0&&ttl<=60,'demand expires: '+ttl);
// Status: connected but not reporting yet, then an OBS source that can play.
assert.equal((await request('GET',root)).status.sources,1);assert.equal((await request('GET',root)).status.ready,0);
obs.emit('chat-sound-ready',{v:1,audio:'running',obs:true});
await wait(async()=>(await request('GET',root)).status.ready===1,'ready report counted');
assert.deepEqual((await request('GET',root)).status,{sources:1,ready:1,obsPlaying:1,tabPlaying:0,obsSilent:0,tabSilent:0,outdated:0});

// A viewer message pops; a burst inside the cooldown does not; the payload carries no chat text.
await chat();await expectPops(obs,1,'viewer message pops');
const pop=obs.pops()[0];assert.deepEqual(Object.keys(pop).sort(),['at','id']);assert.equal(JSON.stringify(pop).includes('hello'),false,'no chat text reaches OBS');
await chat();await expectNoNewPop(obs,1,'cooldown holds back the burst');
await sleep(300);
// Filters (defaults): our bot, a service bot and the streamer stay silent; commands and other users pop.
await chat({id:bot,login:'domdimabot'});await chat({login:'Nightbot',id:'19264788'});await chat({id:channel,login:'soundfixture'});
await expectNoNewPop(obs,1,'bots and own messages are skipped');
await chat({text:'!duel @friend'});await expectPops(obs,2,'commands pop by default');
await sleep(300);await chat({},other);await expectNoNewPop(obs,2,'another channel never reaches this source');
await chat({shared:'42424242'});await expectPops(obs,3,'shared chat pops by default');
// Chat from a manual EventSub test (marked by the publisher) never pops.
await sleep(300);await chat({test:true});await expectNoNewPop(obs,3,'EventSub test chat stays silent');

// A save reaches open sources right away (not only on the 2 s loop) and changes what pops.
state=await put({...state.settings,ignoreCommands:true,ignoreSharedChat:true,ignoreSelf:false,volume:55},state.revision);
await wait(()=>obs.settings().some(s=>s.revision===state.revision&&s.volume===55),'new settings reach OBS at once',800);
await sleep(300);await chat({text:'!lurk'});await chat({shared:'42424242'});await expectNoNewPop(obs,3,'commands and shared chat skipped now');
await chat({id:channel,login:'soundfixture'});await expectPops(obs,4,'own messages pop once allowed');

// "Test in OBS": every filter skipped, draft volume carried, bad volume refused.
let test=await request('POST',root+'/test',{volume:30});assert.equal(test.sent,1);await expectPops(obs,5,'test pop');
assert.equal(obs.pops()[4].test,true);assert.equal(obs.pops()[4].volume,30);
test=await request('POST',root+'/test',{});assert.equal(test.sent,1);await expectPops(obs,6,'test without volume');assert.equal(obs.pops()[5].volume,undefined);
await request('POST',root+'/test',{volume:150},400);await request('POST',root+'/test',{volume:'loud'},400);
await request('POST','/chat-sound/'+other+'/test',{},403);

// Off: the source stays connected and silent; tests still reach it.
state=await put({...state.settings,enabled:false},state.revision);
await wait(()=>obs.settings().some(s=>s.revision===state.revision&&s.enabled===false),'off reaches OBS',5000);
await sleep(300);await chat();await expectNoNewPop(obs,6,'off = no pops');
// Quiet mode: chat that keeps going does not pop again until it was quiet for the chosen minutes.
state=await put({...state.settings,enabled:true,quietMinutes:1},state.revision);
await wait(()=>obs.settings().some(s=>s.revision===state.revision&&s.enabled===true),'on again',5000);
await chat();await expectNoNewPop(obs,6,'chat a moment ago, so quiet mode holds the pop');

// A silent page is reported; a second source of the same channel gets the same pops.
obs.emit('chat-sound-ready',{v:1,audio:'suspended',obs:false});
await wait(async()=>(await request('GET',root)).status.tabSilent===1,'silent tab reported');
state=await put({...state.settings,quietMinutes:0},state.revision);
const second=connect(link.token);await wait(()=>second.state==='connected','second source');
await wait(()=>obs.settings().some(s=>s.revision===state.revision),'every mode back',5000);await sleep(400);
await chat();await expectPops(obs,7,'first source');await expectPops(second,1,'second source');

// Replacing the link drops open sources at once (revoked + disconnect) and the old link stops working.
const current=await request('GET',root+'/overlay-token');
const replaced=await request('POST',root+'/overlay-token',{rotate:true,version:current.version});assert.notEqual(replaced.token,link.token);
await wait(()=>obs.events.some(e=>e[0]==='chat-sound-revoked')&&obs.state!=='connected','old source revoked at once',800);
await wait(()=>second.state!=='connected','second old source dropped',5000);
await wait(async()=>(await request('GET',root)).status.sources===0,'status empties');
const stale=connect(link.token);await wait(()=>stale.state==='refused','old link refused');stale.close();
const fresh=connect(replaced.token);await wait(()=>fresh.state==='connected','new link works');
await wait(()=>fresh.settings().length>0,'new source gets settings');await sleep(1200);
await chat();await expectPops(fresh,1,'new source pops');
for(const s of [obs,second,fresh])s.close();
await wait(async()=>(await request('GET',root)).status.sources===0,'closed sources leave the status');
// After account deletion an open settings tab keeps polling: reads return defaults without bringing data back,
// and saves or new links are refused.
await Users.collection.deleteOne({'accounts.id':gone});
const goneState=await request('GET','/chat-sound/'+gone,undefined,200,'cs-gone');assert.equal(goneState.revision,0);
await request('PUT','/chat-sound/'+gone+'/settings',goneState.settings,404,'cs-gone',{'If-Match':'0'});
await request('POST','/chat-sound/'+gone+'/overlay-token',{},404,'cs-gone');
assert.equal((await request('GET','/chat-sound/'+gone+'/overlay-token',undefined,200,'cs-gone')).exists,false);
assert.equal(await Users.db.collection('chat_sound_channels').countDocuments({_id:gone}),0,'nothing recreated');
console.log('chat sound api check passed');
process.exit(0);
