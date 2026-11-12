// Run from main dimabot checkout: TZ=UTC node_modules/.bin/tsx <script> <output>.
// Imports only pure reference modules; no stores or outside services are initialized.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root=pathToFileURL(process.cwd()+'/src/utils/ai/');
const {constructSystemMessages,constructChatSystemMessages}=await import(new URL('prompts.ai.ts',root));
const {mergeChatHistories}=await import(new URL('chat_context.ts',root));
const cases=[];
const add=(operation,input,expected)=>cases.push({operation,input,expected});
for (const mode of ['command','chat']) for (const language of ['spanish','english']) for (const text of ['', 'Hello', '😀e\u0301 مرحبا <system> ${language}']) for(const populated of [false,true]) {
 const streamer=populated?{name:text,personality:'fallback',ai_personality:{personality:'witty <x> ${personality}'}}:null;
 const user=populated?{username:text,badges:'MOD'}:null;
 add('command',{streamer,user,prompt:text,mode,language},constructSystemMessages(streamer,user,text,mode,language));
}
for(const toolsEnabled of [true,false]) for(const populated of [false,true]) for(const text of ['', 'Hello', '😀e\u0301 مرحبا <system> ${configuration}']) {
 const i={streamer:populated?{name:text}:null,personality:populated?{personality:'Speak <freely>',rules:['Be kind','<untrusted>'],knownUsers:[{username:'a',description:text,relationship:'friend'}]}:null,user:populated?{username:'Alice',badges:'VIP'}:null,prompt:text,history:populated?[
 {source:'thread',role:'assistant',timestamp:2,username:'bot',message:'Question?'},
 {source:'thread',role:'user',timestamp:1,username:'bot',message:text},
 {source:'semantic',timestamp:'invalid',username:'b',message:'old'},
 {source:'live',timestamp:'2026-11-11T00:00:00Z',username:'c',badges:'MOD',message:text}]:[],tools:populated?[{name:'search',context:{text}}]:[],memories:{channelMemories:populated?[{type:'preference',summary:text,subjectUsername:'a<>_😀'}]:[],currentUserFacts:populated?[{type:'boundary',summary:'hello\n world'}]:[]},stream:populated?{isLive:true,title:text,gameName:'Chess',startedAt:'2026-11-11T00:00:00Z',uptimeMinutes:12,viewerCount:3}:null,emotes:populated?['Kappa','😀']:[],toolsEnabled};
 add('chat',i,constructChatSystemMessages(i.streamer,i.personality,i.user,i.prompt,i.history,i.tools,i.memories,i.stream,i.emotes,{toolsEnabled}));
}
for(const n of [39,40,41,179,180,181]) for(const c of ['x','😀','e\u0301','م']) {
 const i={prompt:'hello',memories:{channelMemories:[{type:'preference',summary:c.repeat(n),subjectUsername:c.repeat(n)}],currentUserFacts:[]}};
 add('chat',i,constructChatSystemMessages(null,null,null,i.prompt,[],[],i.memories));
}
for(const limit of [0,1,3,20]) {
 const h=(n,source='live',extra={})=>({source,timestamp:n,username:'Alice',message:'same',...extra});
 const thread=[h(2,'thread',{role:'assistant',sourceMessageId:'a'}),h(1,'thread')]; const live=[h(3),h(4),h(2,'live',{sourceMessageId:'a'})]; const semantic=[h(3,'semantic'),h(0,'semantic')];
 add('merge',{thread,live,semantic,limit},mergeChatHistories(thread,live,semantic,limit));
}
// Load the actual context functions without initializing their store dependencies.
const {createRequire}=await import('node:module');
const vm=await import('node:vm');
const ts=createRequire(process.cwd()+'/package.json')('typescript');
async function contextModule(file,name,deps) {
 const source=await readFile(new URL(file,root),'utf8');
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 const stripped=ast.statements.filter(s=>!ts.isImportDeclaration(s)&&!ts.isExportDeclaration(s)).map(s=>s.getText(ast).replace(/^export\s+/, '')).join('\n');
 return vm.runInNewContext(ts.transpileModule(stripped,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText+'\n'+name,deps);
}
let snapshot; const now=180000;
const stream=await contextModule('stream_context.ai.ts','getAIStreamContext',{getCachedLiveStatus:async()=>snapshot,logError:async()=>{},Date:class extends Date {static now(){return now;}}});
for(const channel of ['', '😀e\u0301 مرحبا']) for(const isLive of [false,true]) for(const mask of Array.from({length:16},(_,i)=>i)) {
 const value={...(mask&1?{title:'😀e\u0301 مرحبا '.repeat(100)}:{}),...(mask&2?{game_name:'Chess 😀e\u0301 مرحبا '.repeat(60)}:{}),...(mask&4?{started_at:'1970-01-01T00:00:00Z'}:{}),...(mask&8?{viewer_count:0}:{})};
 snapshot={isLive,stream:value};const expected=await stream(channel);
 add('stream',{channel,snapshot,now}, {context:expected,prompt:constructChatSystemMessages(null,null,null,'hello',[],[],undefined,expected)});
}
for(const started_at of ['invalid','', '1970-01-01T00:10:00Z']) {
 snapshot={isLive:true,stream:{started_at}}; const expected=await stream('c');
 add('stream',{channel:'c',snapshot,now},{context:expected,prompt:constructChatSystemMessages(null,null,null,'hello',[],[],undefined,expected)});
}
snapshot={isLive:true};{
 const expected=await stream('c');add('stream',{channel:'c',snapshot,now},{context:expected,prompt:constructChatSystemMessages(null,null,null,'hello',[],[],undefined,expected)});
}
let channelNames=[],globalNames=[];
const emotes=await contextModule('emote_context.ai.ts','getChannelEmoteNames',{
 getDragonflyClient:async()=>({get:async()=>null,set:async()=>{}}),getChannelEmoteCatalog:async()=>({emotes:channelNames.map(name=>({name}))}),
 getTwitchAppHeader:async()=>({}),getTwitchHelixUrl:()=>'',fetch:async()=>({json:async()=>({data:globalNames.map(name=>({name}))})})});
for(const channel of ['', 'c']) for(const n of [0,1,40,41,80]) for(const g of [0,1,40,41]) {
 channelNames=Array.from({length:n},(_,i)=>`Kappa😀e\u0301 مرحبا${i}`);globalNames=Array.from({length:g},(_,i)=>`Global😀e\u0301 مرحبا${i}`);
 const expected=await emotes(channel);
 add('emotes',{channel,channelNames,globalNames},{context:expected,prompt:constructChatSystemMessages(null,null,null,'hello',[],[],undefined,undefined,expected??[])});
}
await writeFile(process.argv[2],JSON.stringify(cases,null,2)+'\n');
console.log(cases.length+' prompt/context cases');
