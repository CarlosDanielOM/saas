// DIMABOT_DIR=/home/dom/Projects/saas/dimabot TZ=UTC node <this file>
// Compile only the three leaf source files. Every import is allow-listed; importing the
// real token/logger/render graph would create clients/timers. No production module runs.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import vm from 'node:vm';
const root = process.env.DIMABOT_DIR;
if (!root || process.env.TZ !== 'UTC') throw Error('DIMABOT_DIR and TZ=UTC required');
const require = createRequire(`${root}/package.json`);
const ts = require('typescript');
function load(file, imports = {}, extra = {}) {
  const exports = {};
  const js = ts.transpileModule(readFileSync(`${root}/src/${file}`, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(js, {exports, require(name) { if (!(name in imports)) throw Error(`Unexpected import ${name}`); return imports[name]; }, process:{env:{CLIENT_ID:'fixture-client'}}, ...extra}, {filename:file});
  return exports;
}
const links = load('utils/links.ts');
const splitter = load('utils/twitch/chat_message_chunks.ts');
const requests = []; let mode; let attempt=0; let token = 'fixture-app';
const server = createServer(async (req,res) => {
  let body=''; for await(const chunk of req) body+=chunk;
  requests.push({method:req.method,target:req.url,headers:{authorization:req.headers.authorization,'client-id':req.headers['client-id'],'content-type':req.headers['content-type']},body:JSON.parse(body)});
  if(mode === 'timeout') { return; }
  const status = mode==='401-then-200' ? (++attempt===1 ? 401 : 200) : mode==='401-twice' ? 401 : typeof mode === 'number' ? mode : 200;
  res.writeHead(status,{'content-type':'application/json'});
  res.end(mode==='malformed' ? '{' : JSON.stringify(status>=300 ? {error:'Denied',message:'fixture denied',status} : mode==='missing' ? {} : mode==='empty-data' ? {data:[]} : {data:[{message_id:'msg',is_sent:mode!=='drop',...(mode==='drop'?{drop_reason:{code:'automod',message:'held'}}:{})}]}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const address = server.address();
const imports = {
 '../../utils/ast_command_delivery.js':{deliverAstMessage:async()=>({error:false,message:'AST message delivered',status:200})},
 '../../utils/logger.js':{error:async()=>{},warn:async()=>{}},
 '../../utils/links.js':links,
 '../../utils/tokens.js':{getAppToken:async()=>token},
 '../../handlers/special_parser.handler.js':{parseSpecialCommands:()=>{throw Error('render forbidden');}},
 '../../utils/ast_parser/required_goal_contribution_error.js':{RequiredGoalContributionError:class extends Error{}},
};
const {sendTwitchChatMessage:send} = load('functions/chats/send_message.chat.ts',imports,{fetch:async(url,opts)=>{
 if(url!=='https://api.twitch.tv/helix/chat/messages') throw Error('nonlocal request');
 // Reference has no timeout. Inject only for the timeout recording, to terminate it.
 return fetch(`http://127.0.0.1:${address.port}/helix/chat/messages`,{...opts,...(mode==='timeout'?{signal:AbortSignal.timeout(30)}:{})});
}});
const sends=[];
for(const [name,text,reply,response] of [
 ['short',' hello 🙂 ',null,200],['empty','',null,200],['blank',' \t\n\ufeff',null,200],
 ...[450,451,500,2000].map(n=>[`length-${n}`,'x'.repeat(n),null,200]),
 ...['🙂','𐀀','é','👨‍👩‍👧‍👦','🇪🇸'].flatMap(s=>[449,450,451,499,500,501].map(n=>[`${s}-${n}`,'a'.repeat(n)+s.repeat(20),null,200])),
 ['reply','reply','parent',200],['shared','shared chat',null,200],['drop','held',null,'drop'],
 ...[400,401,401,403,429,500,503].map((s,i)=>[`status-${s}-${i}`,'text',null,s]),
 ['401-then-200','text',null,'401-then-200'],['401-twice','text',null,'401-twice'],['malformed','text',null,'malformed'],['missing','text',null,'missing'],['empty-data','text',null,'empty-data'],['timeout','text',null,'timeout'],['no-token','text',null,'no-token']]) {
 mode=response;attempt=0;token=response==='no-token'?null:'fixture-app';const before=requests.length;
 const result=await send('123',text,reply);
 sends.push({name,text,reply,response,requests:requests.slice(before),result});
}
server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
let seed=0x541234; const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
const cases=[];
for(const atom of ['x','🙂','𐀀','é','👨‍👩‍👧‍👦','🇪🇸','אב','\ufeff']) for(let cut=235;cut<=505;cut++) cases.push('x'.repeat(cut)+atom+' '+atom.repeat(275));
const atoms=['a','🙂','𐀀','é','👨‍👩‍👧‍👦','🇪🇸',' ','\t','\n','אב','\ufeff'];
for(let i=0;i<3000;i++){let text='';const n=rand()%900;for(let j=0;j<n;j++)text+=atoms[rand()%atoms.length];cases.push(text);}
const mentions = [['@Alice: Hola!','Alice'],['  @alice, hola @Bob!','Alice'],['@Alice_2 hola','Alice'],['Hola @Alice!','Alice'],['mail@Alice.com','Alice'],['@Alice','Alice'],['hola',''],['@A.b: hi @a.b!','A.b']];
// Record the charter budget's cut lengths separately from the frozen splitter.
// Node's raw cut may split a surrogate pair. Move only that cut one unit earlier.
let adjustedCuts=0, adjustedInputs=0;
function budgetCuts(text) {
 let rest=text.trim(),cuts=[], changed=false;
 while(rest) {
  let n=Math.min(450,rest.length);
  if(n<rest.length && /[\uD800-\uDBFF]/.test(rest[n-1]) && /[\uDC00-\uDFFF]/.test(rest[n])) {n--;adjustedCuts++;changed=true;}
  cuts.push(n);rest=rest.slice(n);
 }
 if(changed) adjustedInputs++;
 return cuts;
}
const split=cases.map(text=>({text,parts:splitter.splitAiResponseForTwitch(text),budgetCuts:budgetCuts(text)}));
writeFileSync(new URL('chat_golden.json',import.meta.url),JSON.stringify({sends,adjustedCuts,adjustedInputs,split,mentions:mentions.map(([text,user])=>({text,user,result:splitter.removeAiReplyRecipientTag(text,user)}))})+'\n');
console.log(`recorded ${sends.length} sends, ${cases.length} splitter inputs, ${mentions.length} mentions; ${adjustedInputs} budget inputs adjusted, ${adjustedCuts} adjusted cuts`);
