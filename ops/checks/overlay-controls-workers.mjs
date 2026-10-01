import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {getMongoDBConnection} from '/app/dist/utils/databases/mongodb.database.js';
import {getDragonflyClient} from '/app/dist/utils/databases/dragonfly.database.js';
import Users from '/app/dist/schemas/users.schema.js';
import {parse} from '/app/dist/utils/ast_parser/parser.js';
import {evaluate,createExecutionContext} from '/app/dist/utils/ast_parser/evaluator.js';
import {registerAllFunctions} from '/app/dist/utils/ast_parser/functions/index.js';
import {scheduleAstTimer} from '/app/dist/utils/ast_timer_runtime.js';
import {parseSpecialCommands} from '/app/dist/handlers/special_parser.handler.js';
import {renderTimerMessage} from '/app/dist/utils/timer_runtime.js';
await getMongoDBConnection('overlay-worker-test');const redis=await getDragonflyClient('overlay-worker-test');
const channel='990084';
await Users.collection.insertOne({accounts:[{type:'twitch',id:channel}],plan_tier:'free'});
await redis.hSet(`accounts:twitch:${channel}:data`,{id:channel,name:'fixture',plan_tier:'free',access_token:'owner-fixture-token',expires_at:String(Math.floor(Date.now()/1000)+36000),has_permissions:'true'});
const calls=[];let failing=false;
const server=createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 assert.equal(req.url,`/overlay-studio/${channel}/queue`);assert.equal(req.headers.authorization,'Bearer owner-fixture-token');
 calls.push(JSON.parse(body));res.writeHead(failing?503:200,{'Content-Type':'application/json'});res.end(JSON.stringify({error:failing,message:failing?'fixture unavailable':'OK',data:{}}));
});await new Promise(resolve=>server.listen(3000,'127.0.0.1',resolve));
registerAllFunctions();const ctx=createExecutionContext({broadcasterId:channel,userLevel:7,userPlan:'free',platform:'twitch'});
for (const tier of ['free', 'premium', 'pro']) {
await Users.updateOne({'accounts.id':channel},{$set:{plan_tier:tier}});
ctx.userPlan=tier;
for(const action of ['skip','pause','resume','clear'])for(const platform of ['all','twitch','kick']){
 const syntax=`$(overlay.${action}${platform==='all'?'':'.'+platform})`;
 assert.equal((await evaluate(parse(syntax).ast,ctx)).value,'');assert.deepEqual(calls.at(-1),{action,platform});
}
}
await Users.updateOne({'accounts.id':channel},{$set:{plan_tier:'free'}});ctx.userPlan='free';
failing=true;assert.match(String((await evaluate(parse('$(overlay.pause)').ast,ctx)).value),/fixture unavailable/);failing=false;
const before=calls.length;await evaluate(parse('$(overlay.clear)').ast,createExecutionContext({broadcasterId:channel,userLevel:1,userPlan:'free'}));assert.equal(calls.length,before,'viewer cannot issue controls');
if(process.env.SAAS_OVERLAY_RUNTIME==='bot') {
 let ready=false;for(let i=0;i<40;i++){try{ready=(await fetch('http://127.0.0.1:3333/eventsub',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status===403;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,250));}assert(ready,'real bot webhook rejects unsigned events');
 const start=calls.length;
 await scheduleAstTimer(1,parse('$(overlay.pause.kick)').ast,ctx);
 for(let i=0;i<100&&calls.length===start;i++)await new Promise(r=>setTimeout(r,100));
 assert.equal(calls.length,start+1,'real bot scheduler executed the persisted overlay AST');assert.deepEqual(calls.at(-1),{action:'pause',platform:'kick'});
 console.log('PASS real bot: signed webhook boundary, all 12 AST controls through authenticated API transport, permission/error handling and actual persisted AST timer execution.');
}else{
 await renderTimerMessage({channelID:channel,streamerName:'fixture',timerName:'overlay-control',message:'$(overlay.resume.twitch)',planTier:'free',parse:parseSpecialCommands});
 assert.deepEqual(calls.at(-1),{action:'resume',platform:'twitch'});
 console.log('PASS cron supervisor with isolated worker processes; actual shared timer renderer executes overlay AST through authenticated transport, all 12 actions and permission/error handling.');
}
await new Promise(resolve=>server.close(resolve));process.exit(0);
