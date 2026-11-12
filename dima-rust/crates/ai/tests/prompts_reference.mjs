// Run from main dimabot checkout: TZ=UTC node_modules/.bin/tsx <script> <output>.
// Imports only pure reference modules; no stores or outside services are initialized.
import { writeFile } from 'node:fs/promises';
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
await writeFile(process.argv[2],JSON.stringify(cases,null,2)+'\n');
console.log(cases.length+' prompt/context cases');
