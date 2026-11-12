// Compact real-TypeScript feed recording. All external services are replaced before imports;
// signal counters run against own prefix in local Dragonfly DB 9 and are removed in finally.
// eval "$(dima-rust/tools/test-env)"; DIMABOT_DIR=/home/dom/Projects/saas/dimabot TZ=UTC tsx this-file output.jsonl
import {createRequire,registerHooks} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
const root=process.env.DIMABOT_DIR!,require=createRequire(`${root}/package.json`),prefix=`dima_test_features_feed_${randomUUID()}:`;
if(!root||!process.argv[2]||!process.env.DIMA_TEST_DRAGONFLY)throw Error('local store and output required');
const now=1794355200000;Date.now=()=>now;
const g=globalThis as any;g.__feed=[];
const moods=/export const MOOD_NAMES = (\[[^;]+?\]) as const/.exec(await readFile(`${root}/src/pets/moods.ts`,'utf8'))![1];
registerHooks({resolve(spec:string,ctx:any,next:any){
 if(ctx.parentURL?.includes('/src/widget_feed/')){
  if(spec.endsWith('/pubsub_manager.class.js'))return {url:'data:text/javascript,'+encodeURIComponent(`export const pubSubManager={publish:async(topic,message)=>globalThis.__feed.push({topic,message:{...message,timestamp:Date.now()}})};`),format:'module',shortCircuit:true};
  if(spec.endsWith('/pets/moods.js'))return {url:'data:text/javascript,'+encodeURIComponent(`export const MOOD_NAMES=${moods};`),format:'module',shortCircuit:true};
 }return next(spec,ctx);
}});
const redis=require('redis').createClient({url:`redis://${process.env.DIMA_TEST_DRAGONFLY}/9`});redis.on('error',()=>{});
const cases:any[]=[];const clone=(v:any)=>JSON.parse(JSON.stringify(v));
const row=(op:string,input:any,result:any)=>cases.push(clone({op,input,result}));
try {
 await redis.connect();
 const chat=await import(`${root}/src/widget_feed/chat-normalize.ts`),signals=await import(`${root}/src/widget_feed/signals.ts`),bot=await import(`${root}/src/widget_feed/bot-events.ts`),session=await import(`${root}/src/widget_feed/session-refresh.ts`),replay=await import(`${root}/src/widget_feed/chat-replay.ts`),sub=await import(`${root}/src/widget_feed/subscriptions.ts`),publisher=await import(`${root}/src/widget_feed/publisher.ts`),badge=await import(`${root}/src/widget_feed/badges.ts`);
 const lookup=new Map([['subscriber/1',{title:'Subscriber',images:{'1x':'one','2x':'two','4x':'four'}}]]);
 const base={broadcaster_user_id:'1001',chatter_user_id:'2001',chatter_user_login:'viewer',chatter_user_name:'Viewer',message_id:'message',message:{text:'hello',fragments:[{type:'text',text:'hello'}]},message_type:'text',badges:[],color:'',cheer:{bits:0}};
 const variations:any[]=[base];
 for(const kind of ['channel_points_highlighted','channel_points_sub_only','user_intro','power_ups_message_effect','power_ups_gigantify_emote'])variations.push({...base,message_type:kind});
 for(const set of ['moderator','subscriber','broadcaster','founder','vip','artist-badge','staff','partner','turbo','premium'])variations.push({...base,badges:[{set_id:set,id:'1',info:set==='subscriber'?'12':'3'}]});
 variations.push({...base,message:{text:'hi Kappa Dance Cheer100 @Friend',fragments:[{type:'text',text:'hi '},{type:'emote',text:'Kappa',emote:{id:'25',format:['static']}},{type:'emote',text:'Dance',emote:{id:'dance',format:['static','animated']}},{type:'cheermote',text:'Cheer100',cheermote:{prefix:'Cheer',bits:100,tier:100}},{type:'mention',text:'@Friend',mention:{user_id:'2002',user_login:'friend',user_name:'Friend'}}]},cheer:{bits:100},color:'#00ff00'});
 variations.push({...base,message:{text:'@Old',fragments:[{type:'mention',text:'@Old',mention:{user:{user_id:'2',user_login:'old',user_name:'Old'}}}]}});
 variations.push({...base,message:{text:'\x01ACTION waves\x01',fragments:[{type:'text',text:'\x01ACTION waves\x01'}]}});
 variations.push({...base,reply:{parent_message_id:'parent',parent_user_id:'2',parent_user_login:'friend',parent_user_name:'Friend',parent_message_body:'reply'},source_broadcaster_user_id:'1002',source_message_id:'shared',channel_points_custom_reward_id:'reward'});
 variations.push({...base,message:{text:'a'.repeat(2001),fragments:[]}});
 variations.push({...base,message:{text:'abc',fragments:Array.from({length:201},()=>({type:'text',text:'x'}))}});
 variations.push({...base,message:{text:'مرحبا é 👋',fragments:[{type:'text',text:'مرحبا é 👋'}]}});
 variations.push({...base,message:{text:'👋'.repeat(1001)+'X',fragments:[{type:'text',text:'👋'.repeat(1001)+'X'}]}});
 for(const e of variations)row('chat',{event:e,badges:Object.fromEntries(lookup),scalar_limit:e.message.text==='👋'.repeat(1001)+'X'},chat.normalizeChatMessage(e,lookup,now));
 for(const e of [{message_id:'m',target_user_id:'v',user_id:'reader'},{message_id:'m'},null,{message_id:3,target_user_id:''}])row('delete',e,chat.normalizeChatDelete(e));
 for(const type of ['channel.chat.clear','channel.chat.clear_user_messages'])for(const event of [{target_user_id:'v',user_id:'reader'},{}])row('clear',{type,event},chat.normalizeChatClear(type,event));
 for(const value of ['hello','  12  ','true','false','null','"quoted"','[1,2]','{"a":1}','1e999','invalid {','👋 é שלום','a\ufeffb\u0085c']){const input={name:'points',value,user:null,source:{kind:'command',name:'test'},target:null,id:'fixed-signal',at:now};row('signal',input,signals.buildSignal(input));}
 for(const [name,value,target]of [['bad name','',null],['ok','a'.repeat(501),null],['ok','', ' '],['ok','', 'x'.repeat(81)],['ok','', 'Layer']])row('signal_error',{name,value,target},signals.signalError(name,value,target));
 const history=[{username:'Viewer',message:'new',messageID:'new',timestamp:now,badges:['[MOD]','[SUB 12M]']},{username:'שלום',message:'old',timestamp:now-100,badges:['[STREAMER]','[FOUNDER 3M]']},{username:'',message:'skip'}];row('replay',{entries:history,limit:20},replay.replayChat(history));
 for(const phase of ['speaking','done'])for(const status of ['completed','stopped']){const request={_id:'pet-id',channelId:'1001',operation:'reply',outputText:'Hi 👋',mood:'happy'};g.__feed=[];bot.petWidgetEvent(request,phase,status);await session.flushWidgetPublishes();row('pet',{request,phase,status},g.__feed);}
 for(const request of [{_id:'p',channelId:'1001',origin:{kind:'oauth_desktop'}},{_id:'p',channelId:''},{_id:'p',channelId:'1001',operation:'reply',mood:'invalid',outputText:null}]){g.__feed=[];bot.petWidgetEvent(request,'done');await session.flushWidgetPublishes();row('pet',{request,phase:'done',status:null},g.__feed);}
 for(const winner of ['left','right'])for(const phase of ['started','ended']){const run={id:'duel-id',challenger:'left',opponent:'right',mode:'classic',winner,endsAt:now+1000};g.__feed=[];bot.duelWidgetEvent('1001',run,phase);await session.flushWidgetPublishes();row('duel',{channel:'1001',run,phase},g.__feed);}
 g.__feed=[];session.requestWidgetSessionRefresh('1001');await session.flushWidgetPublishes();row('session',{},g.__feed);
 // Cold badge requests cannot let local clears overtake chat. Failed delivery frees the tail.
 for(const fail of [false,true]){const messages:any[]=[];const send=publisher.createWidgetChatPublisher({readDemand:async()=>true,badges:async()=>lookup,now:()=>now,publish:async(topic,message)=>{if(fail&&message.type==='chat')throw Error('injected');messages.push({topic,message:{...message,timestamp:now}});}});await Promise.all([send('1001','chat',base),send('1001','chat.delete',{message_id:'message'}),send('1001','chat.clear',{})]);row('publisher',{fail,event:base,badges:Object.fromEntries(lookup)},messages);}
 // Real local Dragonfly counters; exact TS Lua is executed against prefix-owned keys.
 const signal=signals.buildSignal({name:'points',value:'1',user:null,source:{kind:'command',name:'test'},target:null,id:'fixed-signal',at:now});
 const client={eval:(script:any,options:any)=>redis.eval(script,{keys:options.keys.map((k:string)=>prefix+k),arguments:options.arguments}),set:(key:string,value:string,opts:any)=>redis.set(prefix+key,value,opts)};
 let fail=false;const messages:any[]=[];const publishSignal=signals.createSignalPublisher({redis:async()=>client,publish:async(topic,message)=>{if(fail)throw Error('publish failure');messages.push({topic,message:{...message,timestamp:now}});}});
 const statuses=[];for(let i=0;i<31;i++)statuses.push(await publishSignal('1001',signal,`action-${i}`));statuses.push(await publishSignal('1001',signal,'action-0'));
 fail=true;statuses.push(await publishSignal('1002',signal,'failed'));fail=false;statuses.push(await publishSignal('1002',signal,'failed'));
 row('signal_publish',{signal}, {statuses,messages,rate:await redis.get(prefix+'widget-signal:rate:1001'),skipped:await redis.get(prefix+'widget-signal:skipped:1001'),seenLimited:await redis.get(prefix+'widget-signal:seen:action-30')});
 // Moderation remote lifecycle: creation, adoption, stale removal, 409, auth/inspection failure.
 const remote=(type:string,status='enabled',id=type)=>({id,type,status,version:'1',condition:{broadcaster_user_id:'1001',user_id:'bot'},transport:{method:'webhook',callback:'https://subscriptions.domdimabot.com/eventsub'},created_at:'2026-11-12T00:00:00Z',cost:0});
 for(const variant of ['empty','existing','stale','conflict','forbidden','incomplete','remove-failed','missing-account']){
  let remotes=variant==='existing'?sub.CHAT_MODERATION_EVENT_TYPES.map(t=>remote(t)):variant==='stale'||variant==='remove-failed'?[remote(sub.CHAT_MODERATION_EVENT_TYPES[0],'authorization_revoked','stale'),{...remote(sub.CHAT_MODERATION_EVENT_TYPES[1],'authorization_revoked','foreign'),condition:{broadcaster_user_id:'1001',user_id:'other'}}]:[];const seed=clone(remotes),calls:any[]=[];
  const ensure=sub.createChatModerationEnsurer({botAccountId:'bot',account:async c=>{calls.push(['account',c]);return variant==='missing-account'?null:{name:'Channel'};},inspect:async c=>{calls.push(['inspect',c]);return {data:clone(remotes),complete:variant!=='incomplete'};},remove:async id=>{calls.push(['remove',id]);return variant==='remove-failed'?{error:true}:{};},adopt:async(r,c,name)=>{calls.push(['adopt',r,c,name]);},subscribe:async(c,type,version,condition,config,options)=>{calls.push(['subscribe',c,type,version,condition,config??null,options]);if(variant==='forbidden')return {error:true,status:403};const r=remote(type,variant==='conflict'?'enabled':'webhook_callback_verification_pending',variant==='conflict'?`conflict-${type}`:type);remotes.push(r);return variant==='conflict'?{error:true,status:409}:r;}});
  const first=await ensure('1001');const second=variant==='existing'?await ensure('1001'):null;row('moderation',{variant,seed},{first,second,calls});
 }
 // Badge override, cache hit, stale refresh failure retains the last good versions.
 const bodies:any={global:{data:[{set_id:'subscriber',versions:[{id:'1',title:'Global',image_url_1x:'g1',image_url_2x:'g2',image_url_4x:'g4'}]}]},channel:{data:[{set_id:'subscriber',versions:[{id:'1',title:'Local',image_url_1x:'l1',image_url_2x:'l2',image_url_4x:'l4'}]}]}};
 let badgeNow=now,failed=false;const fetches:any[]=[];const badgeCache=badge.createBadgeCache({now:()=>badgeNow,header:async()=>({}),fetch:async(url:any)=>{const global=String(url).includes('/global');fetches.push(global?'global':'channel');return {ok:!failed,json:async()=>bodies[global?'global':'channel']};}} as any);const results=[];results.push(Object.fromEntries(await badgeCache('1001')));results.push(Object.fromEntries(await badgeCache('1001')));badgeNow+=3600001;failed=true;results.push(Object.fromEntries(await badgeCache('1001')));row('badges',{bodies},{results,fetches});
 const sources:any={};for(const f of ['types','chat-normalize','chat-replay','signals','session-refresh','publisher','subscriptions','badges','bot-events'])sources[`widget_feed/${f}.ts`]=createHash('sha256').update(await readFile(`${root}/src/widget_feed/${f}.ts`)).digest('hex');sources['pets/moods.ts']=createHash('sha256').update(await readFile(`${root}/src/pets/moods.ts`)).digest('hex');
 await writeFile(process.argv[2],[{sources,now},...cases].map(v=>JSON.stringify(v)).join('\n')+'\n');
} finally {if(redis.isOpen){const keys=[];for await(const group of redis.scanIterator({MATCH:prefix+'*',COUNT:100}))keys.push(...group);if(keys.length)await redis.del(keys);await redis.quit();}}
