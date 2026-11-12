// Real frozen service, scratch Mongo only, deterministic clock and random byte stream.
// eval "$(dima-rust/tools/test-env)"; DIMABOT_DIR=/home/dom/Projects/saas/dimabot TZ=UTC tsx this-file output.jsonl
import {createRequire,registerHooks,syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
process.env.SECRET_KEY='widgets-recorder-test-key';
const root=process.env.DIMABOT_DIR!,require=createRequire(`${root}/package.json`),mongoose=require('mongoose'),{EJSON}=require('bson'),crypto=require('node:crypto');
if(!process.env.DIMA_TEST_MONGO_URI||!process.argv[2])throw Error('scratch Mongo URI and output required');
const dbName=`dima_test_features_${crypto.randomUUID().replaceAll('-','')}`;
const uri=new URL(process.env.DIMA_TEST_MONGO_URI);uri.pathname=`/${dbName}`;
let block=0,pool=Buffer.alloc(0);function take(n:number){while(pool.length<n)pool=Buffer.concat([pool,createHash('sha256').update(`dima-widgets-stream:${block++}`).digest()]);const out=Buffer.from(pool.subarray(0,n));pool=pool.subarray(n);return out;}
const realInt=crypto.randomInt,realUUID=crypto.randomUUID;
const ours=()=>new Error().stack?.includes('/src/widgets/');
crypto.randomInt=(...a:any[])=>{if(!ours()||a.length!==1)return realInt(...a);const range=a[0],max=0xffffffffffff,limit=max-max%range;for(;;){const x=take(6).readUIntBE(0,6);if(x<limit)return x%range;}};
crypto.randomUUID=(...a:any[])=>{if(!ours())return realUUID(...a);const b=take(16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};syncBuiltinESMExports();
const g=globalThis as any;g.__widgets={poll:null,calls:[],fail:null};
registerHooks({resolve(spec:string,ctx:any,next:any){if(ctx.parentURL?.includes('/src/widgets/service')){
 const stubs:any={
  '../utils/databases/mongodb.database.js':'export async function getMongoDBConnection(){}',
  '../schemas/users.schema.js':'export default globalThis.__widgetsUsers;',
  '../functions/polls/get.poll.js':`export async function getPoll(c,id){const w=globalThis.__widgets;w.calls.push(['get',c,id]);return w.fail==='get'?{error:true}:{error:false,data:w.poll};}`,
  '../handlers/special_parser.handler.js':`export async function parseSpecialCommands(source,scope){const w=globalThis.__widgets;w.calls.push(['create',source,scope]);if(w.fail==='create')return {parsedText:'mock poll failed'};const args=JSON.parse(source.slice(13,-1)).split(';');w.poll={id:'poll-fixed',title:args[0],status:'ACTIVE',choices:[0,1,2,3,4].map(n=>({id:'choice-'+n,votes:0,channelPointsVotes:0}))};return {parsedText:''};}`
 };if(spec in stubs)return {url:`data:text/javascript,${encodeURIComponent(stubs[spec])}`,format:'module',shortCircuit:true};}return next(spec,ctx);}});
const RealDate=Date;let now=1794355200000;
class FixedDate extends RealDate{constructor(...a:any[]){super(...(a.length?a:[now]) as [any]);return new RealDate(...(a.length?a:[now]) as [any]);}static now(){return now;}static [Symbol.hasInstance](v:any){return v instanceof RealDate;}}
const clone=(v:any)=>JSON.parse(JSON.stringify(v));
const bson=(v:any)=>{const saved=globalThis.Date;globalThis.Date=RealDate;try{return EJSON.serialize(v,{relaxed:false});}finally{globalThis.Date=saved;}};
const lines:any[]=[];
try{
 await mongoose.connect(uri.toString(),{serverSelectionTimeoutMS:5000});
 g.__widgetsUsers=mongoose.model('WidgetsRecorderUsers',new mongoose.Schema({},{strict:false,collection:'users'}));
 await mongoose.connection.db.collection('users').insertMany(['1001','1002','1003','1004','1005','1006'].map(id=>({_id:'user-'+id,accounts:[{type:'twitch',id}],plan_tier:id==='1002'?'free':id==='1003'?'pro':'premium'})));
 const service=await import(`${root}/src/widgets/service.ts`);const model=await import(`${root}/src/widgets/model.ts`);const eventModel=await import(`${root}/src/widgets/event-model.ts`);
 globalThis.Date=FixedDate as any;
 const docs=async()=>bson(await mongoose.connection.db.collection('widget_channels').find({},{promoteValues:false}).sort({_id:1}).toArray());
 async function step(op:string,args:any[],run:()=>Promise<any>,script:any={}){g.__widgets.calls=[];g.__widgets.fail=script.fail??null;if('poll' in script)g.__widgets.poll=script.poll;let result:any;try{const value=await run();result={ok:value===undefined?null:value};}catch(e:any){result={error:{code:e.code??null,message:e.message,status:e.status??null}};}lines.push(clone({op,args,now,script,result,calls:g.__widgets.calls,documents:await docs()}));}
 const exec=async(id:string,action:string,data:any,key:string,revision:number)=>step('execute',[id,action,data,key,revision],()=>service.execute(id,action,data,key,revision));
 await step('snapshot',['1001'],()=>service.snapshot('1001'));
 await exec('1002','show',{},'free',0);await exec('bad','show',{},'bad',0);
 await exec('1001','configure',{spinSeconds:1},'config',0);
 await exec('1001','configure',{spinSeconds:1},'config',0);
 await exec('1001','hide',{},'config',1);
 await exec('1001','show',{},'stale',0);
 for(const [action,data] of [['select',{packId:'bad'}],['configure',{spinSeconds:0}],['role',{role:'bad'}],['progress',{role:'killer',delta:2}],['hide',{extra:true}],['retry-poll',{}],['unknown',{}],['start',{mode:'bad'}]])await exec('1001',action as string,data,'invalid-'+action,1);
 await exec('1001','progress',{role:'killer',delta:1},'win1',1);
 await exec('1001','start',{mode:'characters'},'char',2);
 await exec('1001','reset',{},'busy',3);
 await step('snapshot',['1001'],()=>service.snapshot('1001'));
 now+=1000;await step('settle_due',[],()=>service.settleDue());
 await exec('1001','role',{role:'survivor'},'role',4);
 await exec('1001','layout',model.defaultLayout(),'layout',5);
 await exec('1001','select',{packId:'dbd-killer-challenge'},'select',6);
 await exec('1001','start',{mode:'challenge'},'challenge',7);
 now+=1000;await step('settle_due',[],()=>service.settleDue());now+=3000;await step('settle_due',[],()=>service.settleDue());
 await step('snapshot',['1001'],()=>service.snapshot('1001'));
 const completed={...g.__widgets.poll,status:'COMPLETED',choices:g.__widgets.poll.choices.map((c:any,n:number)=>({...c,votes:n===0?10:0,channelPointsVotes:n===0?2:0}))};
 now+=3000;await step('snapshot',['1001'],()=>service.snapshot('1001'),{poll:completed});now+=3500;await step('settle_due',[],()=>service.settleDue());
 await exec('1003','start',{mode:'poll'},'poll-error',0); // Existing poll title differs; creates its own.
 await step('snapshot',['1003'],()=>service.snapshot('1003'),{fail:'get'});
 now+=5000;await step('snapshot',['1003'],()=>service.snapshot('1003'),{poll:{...g.__widgets.poll,status:'TERMINATED'}});
 await exec('1003','retry-poll',{},'retry',4);
 // Failed create is persisted, never retried implicitly.
 await step('execute',['1004','start',{mode:'poll'},'create-fail',0],()=>service.execute('1004','start',{mode:'poll'},'create-fail',0),{poll:null,fail:'create'});
 await exec('1004','reset',{},'reset',2);
 // Every event action, ordered matching rules, duplicate, wrong channel and expiry.
 const rules=['remove-wins','reset-wins','set-win-target','add-win-target','add-perks','remove-perks'].map((type,n)=>({id:'rule'+n,enabled:true,event:'channel.bits.received',minBits:1,maxBits:null,action:{type,role:n%2?'both':'current',...(type==='reset-wins'?{}:{amount:2}),...(['add-perks','remove-perks'].includes(type)?{perkIds:[]}: {})}}));
 const settings={enabled:true,active:true,allowTestEvents:false,rules};
 await exec('1005','events',settings,'events',0);
 const event=(key:string,channel='1005',at=now)=>({eventKey:key,channelID:channel,source:'twitch-eventsub',type:'channel.bits.received',topic:'channel',schemaVersion:1,occurredAt:new RealDate(at),journaledAt:new RealDate(at),payload:{event:{bits:100}}});
 for(const [key,ch,at] of [['evt1','1005',now],['evt1','1005',now],['wrong','1006',now],['old','1005',now-300001]] as any[]){const e=event(key,ch,at);await step('event',['1005',{...e,occurredAt:at,journaledAt:at}],()=>service.applyWidgetEvent('1005',e));}
 await step('event_settings',['1005'],()=>service.widgetEventSettings('1005'));await step('targets',['1005'],()=>service.activeWidgetEventTargets('1005'));await step('targets',['1006'],()=>service.activeWidgetEventTargets('1006'));
 // Selected perks affect their own role, including when the configured role is current.
 const chosen=model.pool(model.initial(),'perk').slice(0,2).map((e:any)=>e.id);
 for(const type of ['add-perks','remove-perks']){
  const rev=(await service.WidgetChannel.findById('1005').lean()).revision;
  await exec('1005','events',{...settings,rules:[{...rules[4],action:{type,role:'survivor',amount:2,perkIds:chosen}}]},'chosen-'+type,rev);
  const e=event('chosen-'+type);await step('event',['1005',{...e,occurredAt:now,journaledAt:now}],()=>service.applyWidgetEvent('1005',e));
 }
 for(const bad of [null,[],{...settings,extra:true},{...settings,enabled:'yes'},{...settings,rules:Array(101).fill(rules[0])},{...settings,rules:[{...rules[0],event:'unknown'}]},{...settings,rules:[{...rules[0],id:''}]},{...settings,rules:[rules[0],rules[0]]},{...settings,rules:[{...rules[0],minBits:0}]},{...settings,rules:[{...rules[0],maxBits:0}]},{...settings,rules:[{...rules[0],action:{type:'unknown',role:'both'}}]},{...settings,rules:[{...rules[0],action:{type:'remove-wins',role:'unknown',amount:1}}]},{...settings,rules:[{...rules[4],action:{type:'add-perks',role:'both',amount:6,perkIds:chosen}}]}])await step('validate_events',[bad],async()=>eventModel.eventSettings(bad,now));
 // Token encryption/management belongs to the overlay package; record precisely this
 // service's raw read/save seam, using the real Node token helper to prepare its fields.
 const {storedOverlayToken}=await import(`${root}/src/utils/overlay-token.ts`);
 const token='A'.repeat(43),stored=storedOverlayToken(token);
 async function saveToken(expected:string|null,replace:boolean){await step('token_save',['1001',expected,stored.tokenHash,stored.overlayToken,replace],async()=>{const d=await service.WidgetChannel.findById('1001').lean();const r=await service.WidgetChannel.updateOne({_id:'1001',revision:d.revision,tokenHash:expected},{$set:stored,...(replace?{$inc:{revision:1}}:{})});return r.matchedCount===1;});}
 await saveToken(null,true);await saveToken(null,true);await saveToken(stored.tokenHash,false);
 await step('token_document',['1001'],async()=>{const d=await service.WidgetChannel.findById('1001').select('tokenHash +overlayToken').lean();return {tokenHash:d.tokenHash,overlayToken:d.overlayToken};});
 for(const [id,t] of [['1001',token],['1001','B'.repeat(43)],['1002',token],['invalid',token],['1001','short']])await step('authorize',[id,t],()=>service.authorizeOverlay(id,t));
 // Recovery reads a matching accepted poll without creating another, after a process loss.
 await step('execute',['1006','start',{mode:'poll'},'start6',0],()=>service.execute('1006','start',{mode:'poll'},'start6',0),{poll:null,fail:'create'});
 // Simulate a crash after Twitch accepted a poll but before savePoll committed.
 const interrupted=await service.WidgetChannel.findById('1006').lean();
 const resume={...interrupted.state,phase:'poll-starting',nextAt:now};
 await service.WidgetChannel.updateOne({_id:'1006'},{$set:{state:resume,dueAt:now}});
 const accepted={id:'accepted-poll',title:resume.run.pollTitle,status:'ACTIVE',choices:[0,1,2,3,4].map(n=>({id:'recovered-'+n,votes:0,channelPointsVotes:0}))};
 await step('recover_poll',['1006',resume],()=>service.snapshot('1006'),{poll:accepted});
 await step('snapshot',['1006'],()=>service.snapshot('1006'),{poll:{...accepted,id:'unexpected-id',status:'COMPLETED'}});
 // Premium expiry does not delete the active run; only its next scan is postponed.
 await mongoose.connection.db.collection('users').updateOne({_id:'user-1006'},{$set:{plan_tier:'free'}});
 const seed=model.initial();seed.phase='character-spin';seed.nextAt=now;seed.run={id:'expired-run'};
 await service.WidgetChannel.updateOne({_id:'1006'},{$set:{state:seed,dueAt:now}});
 await step('expired_advance',['1006',seed],()=>service.snapshot('1006'));
 // Receipt truncation and expiry are different cases, not a large repeated table.
 const seededReceipts=Array.from({length:200},(_,n)=>({key:'seed-'+n,fingerprint:'seed',at:now}));
 await service.WidgetChannel.updateOne({_id:'1005'},{$set:{receipts:seededReceipts}});
 let receiptRevision=(await service.WidgetChannel.findById('1005').lean()).revision;
 await step('receipt_window',['1005',seededReceipts,receiptRevision],()=>service.execute('1005','hide',{},'receipt-window',receiptRevision));
 now+=86400001;await exec('1005','show',{},'receipt-window',receiptRevision+1);
 const fresh=event('fresh-after-expiry');await step('event',['1005',{...fresh,occurredAt:now,journaledAt:now}],()=>service.applyWidgetEvent('1005',fresh));
 for(const [key,rev] of [['',0],['x'.repeat(129),0],['invalid-revision',0.5],['negative-revision',-1]] as any[])await exec('1001','show',{},key,rev);
 // Legacy Mixed values follow the real driver rewrite, including BSON numeric promotion.
 const legacyRevision=(await service.WidgetChannel.findById('1001').lean()).revision;
 await mongoose.connection.db.collection('widget_channels').updateOne({_id:'1001'},{$set:{future:'keep','state.futureDate':new RealDate(1234567),'state.futureNumber':require('bson').Long.fromNumber(7)},$unset:{'state.config.layout':'','state.wins':''}});
 await step('legacy_show',['1001',legacyRevision],()=>service.execute('1001','show',{},'legacy-show',legacyRevision));
 const sources:any={};for(const f of ['widgets/service.ts','widgets/events.ts','widgets/event-model.ts'])sources[f]=createHash('sha256').update(await readFile(`${root}/src/${f}`)).digest('hex');
 // Reuse the compact backward-reference node format, with one JSON value per line.
 const nodes:any[]=[],seen=new Map<string,number>();function intern(v:any):any{if(v===null||typeof v!=='object')return v;const node=Array.isArray(v)?{array:v.map(intern)}:{object:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,intern(v)]))};const key=JSON.stringify(node);let id=seen.get(key);if(id===undefined){id=nodes.length;nodes.push(node);seen.set(key,id);}return {$ref:id};}
 const recordedRoot=intern({sources,steps:lines});await writeFile(process.argv[2],nodes.concat([{root:recordedRoot}]).map(v=>JSON.stringify(v)).join('\n')+'\n');
}finally{globalThis.Date=RealDate;if(mongoose.connection.db)await mongoose.connection.db.dropDatabase();await mongoose.disconnect();}
