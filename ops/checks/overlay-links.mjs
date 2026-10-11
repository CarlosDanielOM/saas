// Only run through saas-ops with disposable Mongo/Redis and widgets-fixtures.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
const {getMongoDBConnection}=await import('/app/dist/utils/databases/mongodb.database.js');
const {getDragonflyClient}=await import('/app/dist/utils/databases/dragonfly.database.js');
const {default:Users}=await import('/app/dist/schemas/users.schema.js');
const {AdminSchema}=await import('/app/dist/schemas/admin.schema.js');
await getMongoDBConnection('overlay-link-check');
const redis=await getDragonflyClient('overlay-link-check');
const channel='991811',admin='991812',otherAdmin='991813';
await Users.collection.insertOne({accounts:[{id:channel,type:'twitch',name:'linkfixture',actived:true,chat_enabled:false}],plan_tier:'pro'});
for(const [token,id] of [['link-owner',channel],['link-admin',admin],['link-admin-two',otherAdmin]])await redis.hSet('token:'+token,{id,login:'linkfixture'});
await AdminSchema.collection.insertMany([admin,otherAdmin].map(adminID=>({channelID:channel,adminID,actived:true,permissions:['*']})));
const headers=token=>({'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})});
async function request(path,method='GET',body,token='link-owner',status=200,extra={}){
 const response=await fetch('http://127.0.0.1:3000'+path,{method,headers:{...headers(token),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));
 if(status===200)assert.match(response.headers.get('cache-control'),/no-store/);
 return result.data;
}
const hash=token=>createHash('sha256').update(token).digest('hex');
const kinds=[['duel','/widgets/'+channel+'/duel','DuelChannel','/app/dist/duel/service.js'],['widgets','/widgets/'+channel,'WidgetChannel','/app/dist/widgets/service.js'],['roulette','/roulettes/'+channel,'RouletteChannel','/app/dist/roulette/service.js']];
function socket(kind,token,view){
 const ws=new WebSocket('ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket'),packets=[];
 ws.addEventListener('message',event=>{const text=String(event.data);if(text.startsWith('0'))ws.send('40/overlays/'+kind+'/'+channel+','+JSON.stringify({token,...(view?{view}:{})}));else if(text==='2')ws.send('3');else packets.push(text);});
 return {ws,packets,async wait(find){for(let i=0;i<100;i++){const value=packets.find(find);if(value)return value;await new Promise(r=>setTimeout(r,50));}throw new Error('Socket wait failed '+JSON.stringify(packets));}};
}
for(const [kind,root,modelName,module] of kinds){
 const svc=await import(module),model=svc[modelName],path=root+'/overlay-token';
 await request(path,'GET',undefined,'',401);
 await request(path,'GET',undefined,'unknown-session',401);
 await AdminSchema.updateOne({adminID:admin},{$set:{permissions:['dashboard:view']}});
 await request(path,'GET',undefined,'link-admin',403);await request(path,'POST',{},'link-admin',403);
 await AdminSchema.updateOne({adminID:admin},{$set:{permissions:['*']}});
 assert.deepEqual(await request(path),{token:null,exists:false,version:null});
 const starts=await Promise.all(Array.from({length:8},(_,i)=>request(path,'POST',{},i%2?'link-admin':'link-owner')));
 const first=starts[0];assert.equal(new Set(starts.map(s=>s.token)).size,1,'Concurrent creation preserves the first OBS URL');assert.equal(first.token.length,43);
 assert.equal((await request(path,'POST',{},'link-admin-two')).token,first.token,'Another admin cannot accidentally rotate');
 assert.deepEqual(await request(path,'GET',undefined,'link-admin'),first);assert.deepEqual(await request(path),first);
 const raw=await model.findById(channel).select('+overlayToken').lean();assert(raw.overlayToken);assert(!JSON.stringify(raw.overlayToken).includes(first.token),'Token is encrypted at rest');
 assert.equal((await model.findById(channel).lean()).overlayToken,undefined,'Ordinary DB reads omit ciphertext');
 const snapshot=await request(root);assert.equal(snapshot.overlayToken,undefined);assert.equal(snapshot.tokenHash,undefined);
 // Settings/state changes keep the private link intact.
 if(kind==='duel')await request(root+'/configure','POST',snapshot.settings,'link-owner',200,{'If-Match':String(snapshot.revision),'Idempotency-Key':crypto.randomUUID()});
 else await model.updateOne({_id:channel},{$inc:{revision:1}});
 assert.equal((await request(path)).token,first.token);
 await request(path,'POST',{rotate:true},'link-admin',409);
 await request(path,'POST',{rotate:'true'},'link-owner',400);
 await request(path,'POST',{unexpected:1},'link-owner',400);
 await request(path,'POST',{token:'broken'},'link-owner',400);
 await request(path,'POST',{token:'x'.repeat(43)},'link-owner',409);
 await request(path,'GET',undefined,first.token,401);await request(path,'POST',{},first.token,401);
 const source=socket(kind,first.token);await source.wait(p=>p.includes(kind==='duel'?'duel-state':kind==='widgets'?'widgets-state':'roulette-state'));
 const board=kind==='duel'?socket(kind,first.token,'leaderboard'):null;if(board)await board.wait(p=>p.includes('duel-leaderboard'));
 const rotations=await Promise.all(['link-admin','link-admin-two'].map(token=>fetch('http://127.0.0.1:3000'+path,{method:'POST',headers:headers(token),body:JSON.stringify({rotate:true,version:first.version})})));
 assert.deepEqual(rotations.map(r=>r.status).sort(),[200,409],'Only one confirmed replacement can win');
 const current=await request(path);assert.notEqual(current.token,first.token);assert.equal((await request(path,'POST',{})).token,current.token);
 await source.wait(p=>p.startsWith('41'));source.ws.close();if(board){await board.wait(p=>p.startsWith('41'));board.ws.close();}
 const authorize=svc[kind==='duel'?'authorizeDuelOverlay':'authorizeOverlay'];assert.equal(await authorize(channel,first.token),false);assert.equal(await authorize(channel,current.token),true);
 // A legacy hash-only URL is preserved, even when Create is requested from a fresh browser.
 const legacy=randomBytes(32).toString('base64url');await model.updateOne({_id:channel},{$set:{tokenHash:hash(legacy)},$unset:{overlayToken:''}});
 const legacyVersion=(await model.findById(channel).lean()).revision;
 assert.deepEqual(await request(path),{token:null,exists:true,version:hash(legacy)});
 await request(path,'POST',{},'link-owner',409);assert.equal((await model.findById(channel).lean()).tokenHash,hash(legacy),'Old dashboard cannot replace a hash-only link or receive a broken #null URL');
 const recovered=await request(path,'POST',{token:legacy},'link-admin-two');assert.equal(recovered.token,legacy);assert.equal((await model.findById(channel).lean()).revision,legacyVersion,'Saving existing link does not invalidate OBS or settings drafts');
 assert.equal((await request(path,'GET',undefined,'link-owner')).token,legacy);
 // Reconnecting an old OBS source also recovers its link automatically.
 await model.updateOne({_id:channel},{$unset:{overlayToken:''}});
 assert.equal(await authorize(channel,'z'.repeat(43)),false);assert.equal((await request(path)).token,null);
 const legacySource=socket(kind,legacy);await legacySource.wait(p=>p.includes(kind==='duel'?'duel-state':kind==='widgets'?'widgets-state':'roulette-state'));legacySource.ws.close();
 assert.equal((await request(path)).token,legacy);assert.equal((await model.findById(channel).lean()).revision,legacyVersion);
 console.log('PASS '+kind+': owner/two admins, concurrent creation/replacement, encryption, OBS revocation, legacy recovery');
}
// Roulette's existing string channel IDs remain supported by overlay authentication.
const rouletteService=await import('/app/dist/roulette/service.js'),rouletteDomain=await import('/app/dist/roulette/model.js');
const stringChannel='legacy-channel',stringToken=randomBytes(32).toString('base64url');
await Users.collection.insertOne({accounts:[{id:stringChannel,type:'twitch'}],plan_tier:'pro'});
await rouletteService.RouletteChannel.create({_id:stringChannel,revision:0,state:rouletteDomain.emptyState(),tokenHash:hash(stringToken)});
assert.equal(await rouletteService.authorizeOverlay(stringChannel,stringToken),true);
await Users.updateOne({'accounts.id':channel},{$set:{plan_tier:'free'}});
for(const [,root] of kinds){await request(root+'/overlay-token','GET',undefined,'link-owner',403);await request(root+'/overlay-token','POST',{},'link-admin',403);}
await redis.quit();await (await getMongoDBConnection('overlay-link-close')).disconnect();
console.log('PASS all overlay link access and persistence checks');process.exit(0);
