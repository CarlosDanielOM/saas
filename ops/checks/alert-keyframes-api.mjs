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

const {validKeyframes}=await import('/app/dist/overlays/keyframes.js');
const point=(offset,value,easing='smooth')=>({offset,value,easing});
const track=(property,values)=>({property,points:values.map((v,i)=>point(i/(values.length-1),v))});
const keyframes={enter:{tracks:[track('x',[-60,4,0]),track('opacity',[0,1])]},loop:{tracks:[track('y',[0,-8,0]),track('scale',[1,1.1,1])]},exit:{tracks:[track('rotation',[0,90]),track('opacity',[1,0])]}};
let state=await request('GET',channel);assert(!state.designs[0].events.follow.widgets[0].keyframes);
const motion={enter:'none',exit:'none',loop:'none',delay:.3,enterDuration:1,exitDuration:.5,loopDuration:2};
const widgets=['text','image','video','animation','shape'].map((kind,i)=>({id:'kf-'+kind,kind,x:i*100,y:20,width:100,height:100,visible:true,locked:false,...(kind==='text'?{text:'$(user)'}:{}),motion,keyframes}));
state.designs[0].events.follow={duration:5,widgets};
state.designs[0].variants={bits:[{id:'large',name:'Large',enabled:true,min:500,layout:{duration:8,widgets:structuredClone(widgets)}}]};
state=await request('PUT',channel,state);assert.deepEqual(state.designs[0].events.follow.widgets.map(w=>w.keyframes),widgets.map(w=>w.keyframes));assert.deepEqual(state.designs[0].variants.bits[0].layout.widgets[0].keyframes,keyframes);
const invalid=[null,[],{other:{tracks:[]}},{enter:{tracks:[]}},{enter:{tracks:[track('filter',[0,1])]}},{enter:{tracks:[track('x',[0,1]),track('x',[0,1])]}},{loop:{tracks:[track('x',[0,1])]}},{enter:{tracks:[{property:'x',points:[point(0,1)]}]}}];
for(const property of ['x','y','scale','rotation','opacity']) for(const value of [property==='scale'?4.1:property==='opacity'?1.1:property==='rotation'?1441:401,'1',null]) invalid.push({enter:{tracks:[track(property,[0,value])]}});
for(const points of [[point(.1,0),point(1,1)],[point(0,0),point(.9,1)],[point(0,0),point(.5,1),point(.5,2),point(1,0)],[point(0,0),point(.7,1),point(.6,2),point(1,0)],[point(0,0,'cubic-bezier(evil)'),point(1,1)],Array.from({length:25},(_,i)=>point(i/24,i))])invalid.push({enter:{tracks:[{property:'x',points}]}});
for(const value of invalid){assert.equal(validKeyframes(value),false);const copy=structuredClone(state);copy.designs[0].events.follow.widgets[0].keyframes=value;await request('PUT',channel,copy,400);}
assert(!validKeyframes({enter:{tracks:[track('x',[0,NaN])]}}));assert(!validKeyframes({enter:{tracks:[track('x',[0,Infinity])]}}));
for(const [property,values] of [['x',[-400,400]],['y',[-400,400]],['scale',[0,4]],['rotation',[-1440,1440]],['opacity',[0,1]]])assert(validKeyframes({enter:{tracks:[track(property,values)]}}));
const badVariant=structuredClone(state);badVariant.designs[0].variants.bits[0].layout.widgets[0].keyframes={loop:{tracks:[track('x',[0,4])]}};await request('PUT',channel,badVariant,400);
const badScene=structuredClone(state);badScene.scenes[0].widgets[0].keyframes=keyframes;await request('PUT',channel,badScene,400);
assert.equal((await request('GET',channel)).revision,state.revision);
// Round-trip all curve identifiers and strip unknown fields instead of forwarding arbitrary style data.
for(const easing of ['linear','smooth','ease-in','ease-out','soft','snappy','sine-in','sine-out','hold']){
 state.designs[0].events.follow.widgets[0].keyframes.enter.tracks[0].points[0].easing=easing;
 state.designs[0].events.follow.widgets[0].keyframes.enter.tracks[0].points[0].css='unsafe';
 state=await request('PUT',channel,state);assert.equal(state.designs[0].events.follow.widgets[0].keyframes.enter.tracks[0].points[0].easing,easing);assert(!('css' in state.designs[0].events.follow.widgets[0].keyframes.enter.tracks[0].points[0]));
}
state=await request('POST',`${channel}/scenes/${state.scenes[0].id}/publish`,{revision:state.revision});
const published=structuredClone(state.scenes[0].published),publicId=state.scenes[0].publicId;
assert.deepEqual((await request('GET','public/'+publicId)).snapshot.designs[0].events.follow.widgets,state.designs[0].events.follow.widgets);
const rendered=await renderLayout(state.designs[0].events.follow,channel,{user_name:'Keyframe viewer'});assert.deepEqual(rendered.widgets.map(w=>w.keyframes),state.designs[0].events.follow.widgets.map(w=>w.keyframes));assert.equal(rendered.widgets[0].text,'Keyframe viewer');
state.designs[0].events.follow.widgets[0].keyframes.enter.tracks[0].points[0].value=-120;state=await request('PUT',channel,state);assert.deepEqual(state.scenes[0].published,published);
const recovered=await request('POST',channel+'/recover',{...state,recoveryId:crypto.randomUUID()});assert.deepEqual(recovered.designs.find(d=>d.id.startsWith('recovered-')).events.follow.widgets[0].keyframes,state.designs[0].events.follow.widgets[0].keyframes);
console.log('PASS keyframe API: all 5 object types, property bounds and curves, invalid/oversized data, variants, sanitization, AST, frozen publication and recovery');process.exit(0);
