// Only run through saas-ops with disposable Mongo/Redis and mocked providers.
import assert from 'node:assert/strict';
const { getDragonflyClient } = await import('/app/dist/utils/databases/dragonfly.database.js');
const { getMongoDBConnection } = await import('/app/dist/utils/databases/mongodb.database.js');
await getMongoDBConnection('alert-motion-check');
const redis=await getDragonflyClient('alert-motion-check');
const { default: Users }=await import('/app/dist/schemas/users.schema.js');
const { ALERT_TRANSITIONS, ALERT_LOOPS }=await import('/app/dist/overlays/model.js');
const { renderLayout }=await import('/app/dist/overlays/ast.js');
const channel='990211', token='alert-motion-owner';
await Users.collection.insertOne({accounts:[{type:'twitch',id:channel}],plan_tier:'free'});
await redis.hSet('token:'+token,{id:channel,login:'fixture',display_name:'Fixture'});
async function request(method,path,body,status=200){const response=await fetch('http://127.0.0.1:3000/overlay-studio/'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data.data;}
let state=await request('GET',channel);
assert(!state.designs[0].events.follow.widgets[0].motion,'legacy designs stay unchanged');
const motion={enter:'bounce',exit:'flip',loop:'float',delay:.4,enterDuration:.8,exitDuration:.6,loopDuration:1.5};
const widgets=['text','image','video','animation'].map((kind,i)=>({id:'object-'+kind,kind,x:i*150,y:50,width:120,height:120,visible:true,locked:false,...(kind==='text'?{text:'$(user)'}:{}),motion:{...motion,enter:ALERT_TRANSITIONS[i+1],loop:ALERT_LOOPS[i+1]}}));
state.designs[0].events.follow={duration:4,widgets};
state=await request('PUT',channel,state);assert.deepEqual(state.designs[0].events.follow.widgets.map(w=>w.motion),widgets.map(w=>w.motion));
for(const preset of ALERT_TRANSITIONS){state.designs[0].events.follow.widgets[0].motion={...motion,enter:preset,exit:preset};state=await request('PUT',channel,state);assert.equal(state.designs[0].events.follow.widgets[0].motion.enter,preset);}
state=await request('POST',`${channel}/scenes/${state.scenes[0].id}/publish`,{revision:state.revision});
const published=structuredClone(state.scenes[0].published),publicId=state.scenes[0].publicId;
assert.deepEqual((await request('GET','public/'+publicId)).snapshot.designs[0].events.follow.widgets,state.designs[0].events.follow.widgets);
const rendered=await renderLayout(state.designs[0].events.follow,channel,{user_name:'Motion viewer'});assert.deepEqual(rendered.widgets.map(w=>w.motion),state.designs[0].events.follow.widgets.map(w=>w.motion));assert.equal(rendered.widgets[0].text,'Motion viewer');
for(const bad of [{enter:'arbitrary-css'},{loop:'flash'},{delay:-1},{delay:121},{enterDuration:0},{exitDuration:6},{loopDuration:11},{loopDuration:'fast'}]){const invalid=structuredClone(state);Object.assign(invalid.designs[0].events.follow.widgets[0].motion,bad);await request('PUT',channel,invalid,400);}
const invalid=structuredClone(state);invalid.scenes[0].widgets[0].motion=motion;await request('PUT',channel,invalid,400);
assert.equal((await request('GET',channel)).revision,state.revision,'failed validation never mutates the draft');
state.designs[0].events.follow.widgets[0].motion.delay=2;state=await request('PUT',channel,state);assert.deepEqual(state.scenes[0].published,published,'live publication remains frozen');
const recovered=await request('POST',channel+'/recover',{...state,recoveryId:crypto.randomUUID()});assert.deepEqual(recovered.designs.find(d=>d.id.startsWith('recovered-')).events.follow.widgets[0].motion,state.designs[0].events.follow.widgets[0].motion);
// Optional object end time (motion.end, seconds from the alert's start): only type and 0.1-120 range are validated.
const hasEnd=m=>Object.prototype.hasOwnProperty.call(m,'end');
state=recovered;assert(state.designs[0].events.follow.widgets.every(w=>!hasEnd(w.motion)),'motion saved without end has no end key');
state.designs[0].events.follow.widgets[0].motion.end=2.5;state.designs[0].events.follow.widgets[1].motion.end=120;state.designs[0].events.follow.widgets[2].motion.end=.1;
state=await request('PUT',channel,state);
assert.deepEqual(state.designs[0].events.follow.widgets.map(w=>w.motion.end),[2.5,120,.1,undefined]);assert(!hasEnd(state.designs[0].events.follow.widgets[3].motion),'an unset end stays absent next to set ones');
const withEnd=state;assert.deepEqual((await request('GET',channel)).designs[0].events.follow.widgets.map(w=>w.motion),withEnd.designs[0].events.follow.widgets.map(w=>w.motion),'end is read back');
for(const end of [0,.05,-1,120.01,1000,'2',true,null,{},[]]){const invalid=structuredClone(withEnd);invalid.designs[0].events.follow.widgets[0].motion.end=end;await request('PUT',channel,invalid,400);}
const afterBad=await request('GET',channel);assert.equal(afterBad.revision,withEnd.revision,'a rejected end never mutates the draft');assert.equal(afterBad.designs[0].events.follow.widgets[0].motion.end,2.5);
const sceneEnd=structuredClone(withEnd);sceneEnd.scenes[0].widgets[0].motion={...motion,end:2};await request('PUT',channel,sceneEnd,400);
state=await request('POST',`${channel}/scenes/${withEnd.scenes[0].id}/publish`,{revision:withEnd.revision});
const publicEnd=(await request('GET','public/'+state.scenes[0].publicId)).snapshot.designs.find(d=>d.id===state.designs[0].id).events.follow.widgets;
assert.deepEqual(publicEnd.map(w=>w.motion.end),[2.5,120,.1,undefined]);assert(!hasEnd(publicEnd[3].motion),'the public snapshot has no end key for an unset end');
assert.equal((await renderLayout(state.designs[0].events.follow,channel,{user_name:'End viewer'})).widgets[0].motion.end,2.5,'rendered alert layouts keep end');
const recoveredEnd=await request('POST',channel+'/recover',{...state,recoveryId:crypto.randomUUID()});
assert.deepEqual(recoveredEnd.designs.find(d=>d.id.startsWith('recovered-')&&d.events.follow.widgets[0].motion.end!==undefined).events.follow.widgets.map(w=>w.motion.end),[2.5,120,.1,undefined],'recovered copies keep end');
state=recoveredEnd;for(const w of state.designs[0].events.follow.widgets)delete w.motion.end;
state=await request('PUT',channel,state);assert(state.designs[0].events.follow.widgets.every(w=>!hasEnd(w.motion)),'removing end saves no end key');
assert.equal(state.scenes[0].published.designs[0].events.follow.widgets[0].motion.end,2.5,'live publication keeps its end until published again');
console.log('PASS all object types and presets, legacy defaults, owner API persistence, immutable publication, rendered event contract, strict motion validation and recovered copies; optional motion end saved, read back, published, rendered, recovered, range/type checked (400, draft unchanged) and absent when unset');
process.exit(0);
