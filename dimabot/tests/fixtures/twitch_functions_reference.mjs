#!/usr/bin/env node
// Execute ONLY inside a task-owned Node container. Actual TypeScript functions
// run in a closed VM with fixture credentials, Redis, schemas and HTTP fetch.
// No source can import application configuration, providers or live services.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');
const root=fileURLToPath(new URL('../../',import.meta.url));
const BOT='698614112',sources={};
const allowed=new Set([
 'functions/moderation/ban.moderation.ts','functions/moderation/warn.moderation.ts',
 'functions/moderation/get_moderators.moderation.ts','functions/moderation/moderator_helpers.moderation.ts',
 'functions/moderation/execute_action.moderation.ts','functions/chats/delete_message.chat.ts','functions/chats/send_message.chat.ts',
 'functions/polls/get.poll.ts','functions/polls/create.poll.ts','functions/polls/end.poll.ts',
 'functions/predictions/get.prediction.ts','functions/predictions/create.prediction.ts','functions/predictions/end.prediction.ts',
]);
const clone=value=>JSON.parse(JSON.stringify(value));
const poll=(id,status)=>({id,title:`Poll ${id}`,choices:[{id:'a',title:'One',votes:3,channel_points_votes:2},{id:'b',title:'Two',votes:1}],broadcaster_id:'channel',broadcaster_login:'cdom201',status});
const prediction=(id,status)=>({id,title:`Prediction ${id}`,outcomes:[{id:'yes',title:'Yes',users:2,channel_points:30,top_predictors:[],color:'blue'},{id:'no',title:'No',users:1,channel_points:20,top_predictors:[],color:'pink'}],broadcaster_id:'channel',broadcaster_login:'cdom201',status,...(status==='RESOLVED'?{winning_outcome_id:'yes'}:{})});
const moderators=[{user_id:'m1',user_login:'modone',user_name:'Mod One'},{user_id:'m2',user_login:'modtwo',user_name:'Mod Two'}];
const base={channel:'channel',user:'viewer',username:'cdom201',title:'Pick',choices:[{title:'One'},{title:'Two'}],duration:'60',cache:false,id:null,status:'ARCHIVED'};
const cases=[];
function add(name,operation,changes={}){cases.push({name,operation,input:{...clone(base),...(operation==='ban'?{duration:null}:{}),...changes}});}
for(const kind of ['poll','prediction']) {
 const data=kind==='poll'?[poll('old','ARCHIVED'),poll('current','ACTIVE')]:[prediction('old','RESOLVED'),prediction('current','LOCKED')];
 add(`${kind}-active-selection`,`get_${kind}`,{response:{data}});
 add(`${kind}-explicit-id`,`get_${kind}`,{id:'old',response:{data}});
 add(`${kind}-empty`,`get_${kind}`,{response:{data:[]}});
 add(`${kind}-404`,`get_${kind}`,{httpStatus:404,response:{data}});
 add(`${kind}-provider-error`,`get_${kind}`,{httpStatus:403,response:{error:'Forbidden',message:'fixture denied',status:403}});
 add(`${kind}-cache-hit`,`get_${kind}`,{cache:true,initial:{[`twitch:channel:${kind}s`]:{fixture:'cached'}},authError:'unused'});
 add(`${kind}-cache-write`,`get_${kind}`,{cache:true,response:{data}});
 add(`${kind}-cache-unavailable`,`get_${kind}`,{cache:true,cacheError:true});
 add(`${kind}-uncached-no-cache-dependency`,`get_${kind}`,{cacheError:true,response:{data}});
 add(`${kind}-invalid-json`,`get_${kind}`,{rawResponse:'broken'});
 add(`${kind}-auth-denied`,`get_${kind}`,{authError:'fixture permissions'});
 const first=kind==='poll'?poll('created','ACTIVE'):prediction('created','ACTIVE');
 for(const duration of ['60','0x10','',null,'not-a-number',2.5])add(`${kind}-create-duration-${JSON.stringify(duration)}`,`create_${kind}`,{duration,response:{data:[first]}});
 add(`${kind}-create-cache-write`,`create_${kind}`,{cache:true,response:{data:[first]}});
 add(`${kind}-create-cache-required`,`create_${kind}`,{cacheError:true});
 add(`${kind}-create-auth-denied`,`create_${kind}`,{authError:'fixture permissions'});
 const endStatus=kind==='poll'?'ARCHIVED':'RESOLVED';
 const ended=kind==='poll'?poll('ended','ARCHIVED'):prediction('ended','RESOLVED');
 add(`${kind}-end`,`end_${kind}`,{id:'ended',status:endStatus,winner:'yes',response:{data:[ended]}});
 add(`${kind}-end-cache-failure`,`end_${kind}`,{id:'ended',status:endStatus,cacheError:true,response:{data:[ended]}});
 add(`${kind}-invalid-end-status`,`end_${kind}`,{status:'INVALID',authError:'unused'});
}
for(const value of [-1,0.5,1000001])add(`poll-invalid-points-${value}`,'create_poll',{points:value});
add('poll-enabled-points','create_poll',{points:15,response:{data:[poll('created','ACTIVE')]}});
add('ban-success','ban',{duration:60,reason:'fixture reason',response:{data:[{user_id:'viewer',moderator_id:BOT}]},headers:{'ratelimit-remaining':'0','ratelimit-reset':'123','retry-after':'5'}});
add('ban-non-json-429','ban',{httpStatus:429,rawResponse:'busy',headers:{'retry-after':'30'}});
add('ban-auth-denied','ban',{authError:'fixture permissions'});
add('ban-cancelled','ban',{cancelled:true});
add('ban-no-retry-401','ban',{httpStatus:401,response:{error:'Unauthorized',message:'expired'}});
add('warn-success','warn',{reason:'x'.repeat(505),response:{data:[{user_id:'viewer'}]}});
add('warn-non-json-500','warn',{httpStatus:500,rawResponse:'broken'});
add('warn-auth-denied','warn',{authError:'fixture permissions'});
add('moderators-read','moderators',{response:{data:moderators}});
add('moderators-cache-write','moderators',{cache:true,response:{data:moderators}});
add('moderators-filtered-request','moderators',{userIds:['m1','m2'],response:{data:moderators}});
add('moderators-empty-cache','moderators',{cache:true,response:{data:[]}});
add('moderators-cache-hit','moderators',{cache:true,initial:{'twitch:channel:moderators':{data:moderators,ids:['m1','m2'],logins:['modone','modtwo'],displayNames:['Mod One','Mod Two']}}});
add('moderators-auth-denied','moderators',{authError:'fixture permissions'});
add('moderators-cache-required','moderators',{cacheError:true});
add('moderator-ids-hit','moderator_ids',{sets:{'twitch:channel:moderators:ids':['m1','m2']}});
add('moderator-ids-fallback','moderator_ids',{response:{data:moderators}});
add('moderator-ids-skip-still-inner-cache','moderator_ids',{skip:true,initial:{'twitch:channel:moderators':{ids:['cached']}}});
for(const by of ['id','login']) {
 const suffix=by==='id'?'ids':'logins';const user=by==='id'?'m1':'modone';
 add(`moderator-${by}-hit`,`moderator_${by}`,{user,sets:{[`twitch:channel:moderators:${suffix}`]:[user]}});
 add(`moderator-${by}-negative-existing`,`moderator_${by}`,{user,sets:{[`twitch:channel:moderators:${suffix}`]:['other']},authError:'unused'});
 add(`moderator-${by}-fetch`,`moderator_${by}`,{user,response:{data:moderators}});
 add(`moderator-${by}-auth-denied`,`moderator_${by}`,{user,authError:'fixture permissions'});
}
for(const action of ['off','warn','delete','timeout','ban','unknown'])add(`execute-${action}`,'execute',{action,reason:'fixture reason',response:{data:[{user_id:'viewer',is_sent:true,message_id:'notice'}]},httpStatus:action==='delete'?204:200});
add('execute-throttled-notice','execute',{action:'warn',noticeAcquired:false,response:{data:[{}]}});
add('execute-no-notice-on-failure','execute',{action:'warn',httpStatus:403,response:{error:'Forbidden',message:'fixture denied'}});

async function run(testCase) {
 const input=testCase.input,requests=[],commands=[],auth=[],cacheValues=new Map(Object.entries(input.initial||{}).map(([key,value])=>[key,JSON.stringify(value)])),sets=new Map(Object.entries(input.sets||{}));
 const cache={
  async get(key){commands.push(['get',key]);return cacheValues.get(key)??null;},
  async set(key,value,options){if(options?.NX){commands.push(['setNx',key,value,options.EX]);return input.noticeAcquired===false?null:'OK';}commands.push(['set',key,JSON.parse(value),options?.EX??null]);cacheValues.set(key,value);return'OK';},
  async del(key){commands.push(['delete',key]);cacheValues.delete(key);sets.delete(key);return 1;},
  async sMembers(key){commands.push(['members',key]);return sets.get(key)??[];},
  async sIsMember(key,value){commands.push(['isMember',key,value]);return(sets.get(key)??[]).includes(value);},
  async exists(key){commands.push(['exists',key]);return sets.has(key)||cacheValues.has(key)?1:0;},
  async sAdd(key,values){commands.push(['addMembers',key,values]);sets.set(key,values);return values.length;},
  async expire(key,seconds){commands.push(['expire',key,seconds]);return true;},
  async hSet(key,mapping){commands.push(['hash',key,Object.fromEntries(Object.entries(mapping).sort())]);return Object.keys(mapping).length;},
 };
 const header=async identity=>{auth.push(identity);return input.authError?{error:true,message:input.authError}:{error:false,message:'Success',header:{Authorization:`Bearer fixture-${identity==='app'?'app':identity==='bot'?'bot':'streamer'}`,'Client-Id':'fixture-client','Content-Type':'application/json'}};};
 const modules=new Map();
 function load(relative){
  if(modules.has(relative))return modules.get(relative).exports;
  assert(allowed.has(relative),`forbidden source ${relative}`);
  const sourcePath=[path.join(root,'src',relative),path.resolve(root,'../archives/dimabot-typescript/2026-10-28/src',relative)].find(existsSync);assert(sourcePath,relative);
  const source=readFileSync(sourcePath,'utf8');sources[relative]=createHash('sha256').update(source).digest('hex');
  const module={exports:{}};modules.set(relative,module);
  const localRequire=name=>{
   if(name.endsWith('/header.js'))return{getTwitchBotHeader:()=>header('bot'),getTwitchStreamerHeaderById:id=>header(`streamer:${id}`),getTwitchModeratorHeader:()=>header('bot'),TWITCH_BOT_ACCOUNT_ID:BOT};
   if(name.endsWith('/links.js'))return{getTwitchHelixUrl:(endpoint,params)=>`http://fixture.invalid/${endpoint}${params?'?'+params:''}`};
   if(name.endsWith('/dragonfly.database.js'))return{getDragonflyClient:async()=>{if(input.cacheError)throw new Error('fixture cache unavailable');return cache;}};
   if(name.endsWith('/logger.js'))return{error:async()=>{},warn:async()=>{}};
   if(name.endsWith('/moderation_action_log.schema.js'))return{ModerationActionLogSchema:{create:async()=>{}}};
   if(name.endsWith('/moderation_decision.schema.js'))return{ModerationDecision:{updateOne:async()=>{}}};
   if(name.endsWith('/tokens.js'))return{getAppToken:async()=>{const result=await header('app');return result.error?null:'fixture-app';}};
   if(name.endsWith('/ast_command_delivery.js'))return{deliverAstMessage:async(_channel,message)=>{assert(!message.parsedText&&!message.commandReferences?.length);return{error:false,message:'AST message delivered',status:200};}};
   if(name.endsWith('/special_parser.handler.js'))return{parseSpecialCommands:()=>{throw new Error('No AST context expected in moderation notices');}};
   assert(name.startsWith('.'),`forbidden import ${name}`);return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative),name)).replace(/\.js$/,'.ts'));
  };
  const context=vm.createContext({URLSearchParams,Headers,AbortSignal,process:{env:{CLIENT_ID:'fixture-client'}},console:{error(){},log(){}},fetch:async(url,options={})=>{
   const target=new URL(url);requests.push({method:options.method||'GET',path:target.pathname+target.search,authorization:options.headers.Authorization||options.headers['Authorization'],body:options.body?JSON.parse(options.body):null});
   const notice=target.pathname==='/chat/messages';
   const status=notice?200:(input.httpStatus??200);const statusText=({200:'OK',204:'No Content',400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',429:'Too Many Requests',500:'Internal Server Error'})[status]??'';return new Response(status===204?null:input.rawResponse??JSON.stringify(input.response??{data:[]}),{status,statusText,headers:input.headers});
  }});
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  new vm.Script(`(function(exports,require,module){${compiled}\n})`,{filename:relative}).runInContext(context)(module.exports,localRequire,module);return module.exports;
 }
 const channel=input.channel;let result;
 if(testCase.operation==='get_poll')result=await load('functions/polls/get.poll.ts').getPoll(channel,input.id,input.cache);
 else if(testCase.operation==='create_poll')result=await load('functions/polls/create.poll.ts').createPoll(channel,input.title,input.choices,input.duration,input.cache,input.points??0);
 else if(testCase.operation==='end_poll')result=await load('functions/polls/end.poll.ts').endPoll(channel,input.id,input.status);
 else if(testCase.operation==='get_prediction')result=await load('functions/predictions/get.prediction.ts').getPrediction(channel,input.id,input.cache);
 else if(testCase.operation==='create_prediction')result=await load('functions/predictions/create.prediction.ts').createPrediction(channel,input.title,input.choices,input.duration,input.cache);
 else if(testCase.operation==='end_prediction')result=await load('functions/predictions/end.prediction.ts').endPrediction(channel,input.id,input.status,input.winner??null);
 else if(testCase.operation==='ban')result=await load('functions/moderation/ban.moderation.ts').ban(channel,input.user,BOT,input.duration??null,input.reason??null,input.cancelled?AbortSignal.abort():undefined);
 else if(testCase.operation==='warn')result=await load('functions/moderation/warn.moderation.ts').warnUser(channel,input.user,input.reason??'fixture');
 else if(testCase.operation==='moderators')result=await load('functions/moderation/get_moderators.moderation.ts').getChannelModerators(channel,input.userIds??[],input.cache);
 else if(testCase.operation==='moderator_ids')result=await load('functions/moderation/moderator_helpers.moderation.ts').getTwitchModeratorsIds(channel,input.skip??false);
 else if(testCase.operation==='moderator_id')result=await load('functions/moderation/moderator_helpers.moderation.ts').isTwitchModeratorById(channel,input.user,input.skip??false);
 else if(testCase.operation==='moderator_login')result=await load('functions/moderation/moderator_helpers.moderation.ts').isTwitchModeratorByLogin(channel,input.user,input.skip??false);
 else if(testCase.operation==='execute')result=await load('functions/moderation/execute_action.moderation.ts').executeModerationAction({channelID:channel,userID:input.user,username:input.username,messageID:'message',messageText:'fixture message',rule:{id:'rule',type:'caps',reason:input.reason??'fixture'},step:{action:input.action,timeoutSeconds:60},offenseNumber:2});
 else throw new Error(testCase.operation);
 await new Promise(resolve=>setImmediate(resolve));
 return{...testCase,expected:{result:clone(result),requests,commands,auth}};
}
const outputCases=[];for(const testCase of cases)outputCases.push(await run(testCase));
const text=JSON.stringify({sources,cases:outputCases},null,2)+'\n';const output=new URL('twitch_functions_cases.json',import.meta.url);
if(process.argv.includes('--check'))assert.equal(readFileSync(output,'utf8'),text);else writeFileSync(output,text);
console.log(`Twitch functions source oracle: ${outputCases.length} scenarios, no network or live resources`);
