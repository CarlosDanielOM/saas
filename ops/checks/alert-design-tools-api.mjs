// saas-ops only: disposable Mongo/Redis, fixture identities and provider mocks.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const require=createRequire('/app/package.json');
const {getMongoDBConnection}=await import('/app/dist/utils/databases/mongodb.database.js');await getMongoDBConnection('design-variants-test');
const {getDragonflyClient}=await import('/app/dist/utils/databases/dragonfly.database.js');const redis=await getDragonflyClient('design-variants-test');
const {default:Users}=await import('/app/dist/schemas/users.schema.js');
const channel='990231',other='990232';
for(const id of [channel,other]){await Users.collection.insertOne({accounts:[{type:'twitch',id}],plan_tier:'pro'});await redis.hSet('token:design-'+id,{id,login:'fixture',display_name:'Fixture'});}
async function req(method,path,body,status=200,owner=channel){const response=await fetch('http://127.0.0.1:3000'+path,{method,headers:{Authorization:'Bearer design-'+owner,...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});assert.equal(response.status,status,`${method} ${path}: ${response.status===status?'':await response.text()}`);return response;}
const data=async(...args)=>(await(await req(...args)).json()).data;
execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','/tmp/variant.wav']);
const bytes=await readFile('/tmp/variant.wav');
async function upload(owner){const form=new FormData();form.append('file',new Blob([bytes]),'Variant.wav');return data('POST','/asset-library/'+owner,form,200,owner);}
const asset=await upload(channel),foreign=await upload(other);
const path='/overlay-studio/'+channel;let state=await data('GET',path),design=state.designs[0];
const shape={id:'shape',kind:'shape',x:20,y:20,width:700,height:180,visible:true,locked:false,shape:'ellipse',color:'#123456',borderColor:'#abcdef',borderWidth:4,radius:30,opacity:.75,shadow:{color:'#000000',blur:12,x:-2,y:4},motion:{enter:'fade',exit:'zoom',loop:'float',delay:.2,enterDuration:.5,exitDuration:.4,loopDuration:1}};
const text={...design.events.bits.widgets[1],fontFamily:'serif',fontWeight:700,italic:true,textAlign:'left',text:'BIG $(user)'};
const layout={duration:7,widgets:[shape,text],sound:{assetId:asset.id,name:'Variant.wav',volume:.4,delay:1,fadeIn:.3,fadeOut:.4}};
design.variants={bits:[{id:'big',name:'Big',enabled:true,min:500,max:1000,layout},{id:'broad',name:'Broad',enabled:true,min:100,layout:{duration:3,widgets:[{...text,text:'Broad'}]}}],sub:[{id:'tier2',name:'Tier 2',enabled:true,tier:'2000',layout},{id:'tier3',name:'Tier 3',enabled:true,tier:'3000',layout:{duration:8,widgets:[]}}],raid:[{id:'large-raid',name:'Large raid',enabled:true,min:50,layout}]};
state=await data('PUT',path,state);design=state.designs[0];assert.deepEqual(design.variants.bits[0].layout,layout);
const {selectAlertLayout,matchingVariant}=await import('/app/dist/overlays/model.js');
for(const [kind,raw,expected] of [['bits',{bits:499},'broad'],['bits',{bits:500},'big'],['bits',{bits:1000},'big'],['bits',{bits:1001},'broad'],['bits',{bits:99},undefined],['bits',{bits:'500'},undefined],['bits',{},undefined],['sub',{tier:'1000'},undefined],['sub',{tier:'2000'},'tier2'],['sub',{tier:'3000'},'tier3'],['raid',{viewers:49},undefined],['raid',{viewers:50},'large-raid']])assert.equal(matchingVariant(design,kind,raw)?.id,expected);
const disabled=structuredClone(design);disabled.variants.bits[0].enabled=false;assert.equal(matchingVariant(disabled,'bits',{bits:600}).id,'broad');disabled.variants.bits.reverse();assert.equal(matchingVariant(disabled,'bits',{bits:600}).id,'broad');
assert.equal(selectAlertLayout(design,'bits',{}),design.events.bits);
for(const bad of [{shape:'triangle'},{fontFamily:'url(https://evil.invalid)'},{fontWeight:900},{italic:'yes'},{opacity:2},{borderWidth:-1},{radius:501},{borderColor:'red'},{shadow:{color:'#000000',blur:101,x:0,y:0}}]){const copy=structuredClone(state);Object.assign(copy.designs[0].variants.bits[0].layout.widgets[0],bad);await req('PUT',path,copy,400);}
for(const bad of [{min:-1},{min:1.5},{max:499},{tier:'2000'},{enabled:'yes'},{layout:{duration:0,widgets:[]}}]){const copy=structuredClone(state);Object.assign(copy.designs[0].variants.bits[0],bad);await req('PUT',path,copy,400);}
for(const change of [d=>d.variants.sub[0].tier='Prime',d=>d.variants.follow=[],d=>d.variants.bits.push(d.variants.bits[0]),d=>d.variants.bits=Array.from({length:11},(_,i)=>({...d.variants.bits[0],id:'v'+i}))]){const copy=structuredClone(state);change(copy.designs[0]);await req('PUT',path,copy,400);}
const badAsset=structuredClone(state);badAsset.designs[0].variants.bits[0].layout.sound.assetId=foreign.id;await req('PUT',path,badAsset,404);
assert.equal((await data('GET',path)).revision,state.revision);
await req('DELETE','/asset-library/'+channel+'/'+asset.id,null,409);
state=await data('POST',path+'/scenes/'+state.scenes[0].id+'/publish',{revision:state.revision});
const scene=state.scenes[0],publicPath='/overlay-studio/public/'+scene.publicId;
assert.deepEqual((await data('GET',publicPath)).snapshot.designs[0].variants.bits[0].layout,layout);
const download=await req('GET',publicPath+'/assets/'+asset.id);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
await req('GET',publicPath+'/assets/'+foreign.id,null,404);
// Real delivery resolution over a disposable Socket.IO server using the exact candidate code.
const {createServer}=await import('node:http');const {Server}=require('socket.io');const server=createServer(),io=new Server(server);
const {ttsQueueHandler}=await import('/app/dist/handlers/tts_queue.handler.js');ttsQueueHandler.resumeIfIdle=async()=>{};
const {clipQueueHandler}=await import('/app/dist/handlers/clip_queue.handler.js');clipQueueHandler.subscribeToChannel=async()=>{};
const live=await import('/app/dist/overlays/live.js');live.registerStudio(io);await new Promise(r=>server.listen(3212,'127.0.0.1',r));
const ws=new WebSocket('ws://127.0.0.1:3212/socket.io/?EIO=4&transport=websocket'),ns='/overlay-studio/'+scene.publicId,events=[];
ws.addEventListener('message',e=>{const m=String(e.data);if(m.startsWith('0'))ws.send(`40${ns},${JSON.stringify({clientId:crypto.randomUUID()})}`);else if(m==='2')ws.send('3');else if(m.startsWith(`42${ns},`))events.push(JSON.parse(m.slice(m.indexOf(',')+1)));});
async function until(fn){for(let i=0;i<200;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,25));}throw Error('socket timeout');}
await until(()=>events.some(e=>e[0]==='overlay-state'));
for(const [kind,raw,textValue,duration] of [['bits',{bits:500,user_name:'Ada'},'BIG Ada',7],['bits',{bits:1001},'Broad',3],['sub',{tier:'2000',user_name:'Tier user'},'BIG Tier user',7],['raid',{viewers:50,user_name:'Raider'},'BIG Raider',7]]){
 const source=crypto.randomUUID();assert.equal(await live.publishStudioAlert(channel,kind,raw,source),1);const resolved=await live.eventFor(scene.publicId,'alert-'+source);assert.equal(resolved.layouts[design.id].widgets.find(w=>w.kind==='text').text,textValue);assert.equal(resolved.layouts[design.id].duration,duration);if(duration===7)assert.deepEqual(resolved.layouts[design.id].sound,layout.sound);
}
const largeAmount=await data('POST',path+'/preview',{kind:'bits',texts:['$(cheer.amount)'],user:'Test',amount:2000000});assert.equal(largeAmount[0],'2000000','sample text uses the same supported amount as variant matching');
const rendered=await data('POST',path+'/preview',{kind:'sub',texts:['$(sub.tier)'],user:'Test',amount:1,tier:'3000'});assert(rendered[0].includes('3'));
const frozen=structuredClone(scene.published);delete state.designs[0].variants;state=await data('PUT',path,state);assert.deepEqual(state.scenes[0].published,frozen);await req('DELETE','/asset-library/'+channel+'/'+asset.id,null,409);
const copies=await data('POST',path+'/recover',{...state,designs:[design],recoveryId:crypto.randomUUID()});assert.deepEqual(copies.designs.find(d=>d.id.startsWith('recovered-')).variants,design.variants);
ws.close();await new Promise(r=>io.close(r));
console.log('PASS styles and variants validation; tier/range boundaries and fallback; asset ownership/publication/deletion; real socket event resolution, sounds, AST, frozen snapshots and recovery');process.exit(0);
