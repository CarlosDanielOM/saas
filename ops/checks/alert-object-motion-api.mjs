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
console.log('PASS all object types and presets, legacy defaults, owner API persistence, immutable publication, rendered event contract, strict motion validation and recovered copies');
process.exit(0);
