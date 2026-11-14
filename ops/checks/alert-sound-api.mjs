// Run only with saas-ops disposable databases and mocked providers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
await getMongoDBConnection('alert-sound-check');
const redis=await getDragonflyClient('alert-sound-check');
const { default: Users }=await import('/app/dist/schemas/users.schema.js');
const { renderLayout }=await import('/app/dist/overlays/ast.js');
const owner='990221', foreign='990222';
for(const id of [owner,foreign]){await Users.collection.insertOne({accounts:[{type:'twitch',id}],plan_tier:'pro'});await redis.hSet('token:sound-'+id,{id,login:'fixture',display_name:'Fixture'});}
async function req(method,path,body,status=200,id=owner,headers={}){const r=await fetch('http://127.0.0.1:3000'+path,{method,headers:{...(id?{Authorization:'Bearer sound-'+id}:{}),...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})});assert.equal(r.status,status,`${method} ${path}: ${r.status===status?'':await r.text()}`);return r;}
const data=async(...args)=>(await(await req(...args)).json()).data;
const form=(bytes,name)=>{const f=new FormData();f.append('file',new Blob([bytes]),name);return f;};
const clips=[];
for(const [ext,codec] of [['wav','pcm_s16le'],['mp3','libmp3lame'],['ogg','libopus']]){
 const path='/tmp/sound-fixture.'+ext;execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-c:a',codec,path]);
 const bytes=await readFile(path),asset=await data('POST','/asset-library/'+owner,form(bytes,'Chime.'+ext));
 assert.equal(asset.kind,'audio');assert(asset.duration>=2 && asset.duration<2.2);assert.equal(asset.bytes,bytes.length);clips.push({asset,bytes});
}
assert.equal((await data('GET','/asset-library/'+owner)).usedBytes,clips.reduce((n,c)=>n+c.bytes.length,0));
await req('POST','/asset-library/'+owner,form(Buffer.from('ID3fake'),'bad.mp3'),415);
await req('POST','/asset-library/'+owner,form(clips[0].bytes.subarray(0,32),'truncated.wav'),415);
execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','anullsrc=r=8000:cl=mono','-t','601','-c:a','pcm_u8','/tmp/long.wav']);
await req('POST','/asset-library/'+owner,form(await readFile('/tmp/long.wav'),'long.wav'),415);
const other=await data('POST','/asset-library/'+foreign,form(clips[0].bytes,'Foreign.wav'),200,foreign);
const path='/overlay-studio/'+owner;let state=await data('GET',path);assert.equal(state.designs[0].events.follow.sound,undefined);
const sound={assetId:clips[0].asset.id,name:'Chime.wav',volume:.65,delay:.4,fadeIn:.2,fadeOut:1};
state.designs[0].events.follow.sound=sound;
for(const bad of [{assetId:'bad'},{assetId:other.id},{volume:1.1},{volume:-1},{delay:121},{fadeIn:-.1},{fadeOut:11},{volume:'1'},{fadeIn:null}]){const copy=structuredClone(state);Object.assign(copy.designs[0].events.follow.sound,bad);await req('PUT',path,copy,bad.assetId===other.id?404:400);}
const visual=structuredClone(state);visual.scenes[0].widgets.push({id:'bad-kind',kind:'image',assetId:sound.assetId,x:0,y:0,width:100,height:100,visible:true,locked:false});await req('PUT',path,visual,400);
state=await data('PUT',path,state);assert.deepEqual(state.designs[0].events.follow.sound,sound);assert.equal(state.designs[0].events.sub.sound,undefined);
assert.deepEqual((await renderLayout(state.designs[0].events.follow,owner,{user_name:'Listener'})).sound,sound);
const scene=state.scenes[0],assetPath='/overlay-studio/public/'+scene.publicId+'/assets/';
await req('GET',assetPath+sound.assetId,null,404,'');await req('DELETE','/asset-library/'+owner+'/'+sound.assetId,null,409);
state=await data('POST',path+'/scenes/'+scene.id+'/publish',{revision:state.revision});
assert.deepEqual((await data('GET','/overlay-studio/public/'+scene.publicId)).snapshot.designs[0].events.follow.sound,sound);
const audio=await req('GET',assetPath+sound.assetId,null,206,'',{Range:'bytes=0-43'});assert.equal(audio.headers.get('content-type'),'audio/wav');assert.deepEqual(Buffer.from(await audio.arrayBuffer()),clips[0].bytes.subarray(0,44));
await req('GET',assetPath+clips[1].asset.id,null,404,'');await req('GET',assetPath+other.id,null,404,'');
state.designs[0].events.follow.sound={...sound,volume:.2};state=await data('PUT',path,state);assert.deepEqual(state.scenes[0].published.designs[0].events.follow.sound,sound);
delete state.designs[0].events.follow.sound;state=await data('PUT',path,state);await req('DELETE','/asset-library/'+owner+'/'+sound.assetId,null,409);
state=await data('POST',path+'/scenes/'+scene.id+'/publish',{revision:state.revision});await req('GET',assetPath+sound.assetId,null,404,'');await req('DELETE','/asset-library/'+owner+'/'+sound.assetId);
// Optional end times: sound.end (sound has stopped) and an object's motion.end, seconds from the alert's start, 0.1-120.
const hasEnd=o=>Object.prototype.hasOwnProperty.call(o,'end');
assert(!hasEnd(sound),'the sound saved above had no end');
state=await data('GET',path);
const endingSound={assetId:clips[1].asset.id,name:'Chime.mp3',volume:.5,delay:.2,fadeIn:0,fadeOut:.5,end:3};
const endingMotion={enter:'fade',exit:'fade',loop:'none',delay:0,enterDuration:.5,exitDuration:.5,loopDuration:2,end:2.5};
state.designs[0].events.follow.sound=endingSound;state.designs[0].events.follow.widgets[0].motion=endingMotion;
state=await data('PUT',path,state);
assert.deepEqual(state.designs[0].events.follow.sound,endingSound);assert.deepEqual(state.designs[0].events.follow.widgets[0].motion,endingMotion);
const readBack=await data('GET',path);assert.deepEqual(readBack.designs[0].events.follow.sound,endingSound);assert.deepEqual(readBack.designs[0].events.follow.widgets[0].motion,endingMotion);
for(const end of [0,.05,-1,120.01,'3',true,null,{}])for(const target of ['sound','motion']){
 const copy=structuredClone(state),layout=copy.designs[0].events.follow;(target==='sound'?layout.sound:layout.widgets[0].motion).end=end;await req('PUT',path,copy,400);
}
const unchanged=await data('GET',path);assert.equal(unchanged.revision,state.revision,'a rejected end never mutates the draft');
assert.deepEqual(unchanged.designs[0].events.follow.sound,endingSound);assert.deepEqual(unchanged.designs[0].events.follow.widgets[0].motion,endingMotion);
assert.equal((await renderLayout(state.designs[0].events.follow,owner,{user_name:'Listener'})).sound.end,3,'rendered alert layouts keep the sound end');
state=await data('POST',path+'/scenes/'+scene.id+'/publish',{revision:state.revision});
const publicFollow=(await data('GET','/overlay-studio/public/'+scene.publicId)).snapshot.designs.find(d=>d.id===state.designs[0].id).events.follow;
assert.deepEqual(publicFollow.sound,endingSound,'the public overlay state has the sound end');assert.deepEqual(publicFollow.widgets[0].motion,endingMotion,'the public overlay state has the object end');
const {end:_soundEnd,...plainSound}=endingSound,{end:_motionEnd,...plainMotion}=endingMotion;
state.designs[0].events.follow.sound=plainSound;state.designs[0].events.follow.widgets[0].motion=plainMotion;state=await data('PUT',path,state);
assert(!hasEnd(state.designs[0].events.follow.sound)&&!hasEnd(state.designs[0].events.follow.widgets[0].motion),'a save without end returns no end key');
assert.deepEqual(state.designs[0].events.follow.sound,plainSound);assert.deepEqual(state.scenes[0].published.designs[0].events.follow.sound,endingSound,'live publication keeps its end until published again');
state=await data('POST',path+'/scenes/'+scene.id+'/publish',{revision:state.revision});
const publicPlain=(await data('GET','/overlay-studio/public/'+scene.publicId)).snapshot.designs.find(d=>d.id===state.designs[0].id).events.follow;
assert(!hasEnd(publicPlain.sound)&&!hasEnd(publicPlain.widgets[0].motion),'republishing without end serves no end key');
console.log('PASS MP3/WAV/Ogg uploads and duration/quota; invalid/overlong files; sound settings validation, owner isolation, rendered sound, immutable publication, scoped range playback and deletion guards; optional sound/object end saved, read back, published to the public state, range/type checked (400, draft unchanged) and absent when unset');process.exit(0);
