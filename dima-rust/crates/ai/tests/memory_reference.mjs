import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const root=pathToFileURL(process.cwd()+'/src/utils/ai/memory/');
const {extractMemoryCandidate,inferMemorySourceType}=await import(new URL('memory_extractor.ts',root));
const {getMemoryPolicyViolation,resolveChatMemorySubject,selectValidatedChannelMemories}=await import(new URL('memory_policy.ts',root));
const {isPassiveMemoryRelevant}=await import(new URL('memory_relevance.ts',root));
const cases=[]; const add=(operation,input,expected)=>cases.push({operation,input,expected});
for(const message of ['😀😀😀😀 i love', '', '!i love this game','short','https://example.test love','@user i love this game','I love playing chess','my favorite game is chess','no me gusta la lluvia','never mention spoilers','en este canal siempre ganamos','lol this is so funny','I am a software developer','ordinary unremarkable sentence','😀😀😀😀😀 i love','e\u0301 مرحبا me gusta el juego','\ufeff i\n love\t chess \ufeff']) for(const identity of ['streamer','mod','chat']) {
 const input={channelID:'1',userID:identity==='streamer'?'1':'2',username:' Alice ',message,badges:identity==='mod'?[{id:'LEAD_MOD'}]:[],timestamp:123};add('extract',input,extractMemoryCandidate(input));
}
for(const type of ['preference','boundary','known_user_fact','channel_lore','running_joke']) for(const risk of ['low','medium','high']) for(const scope of ['channel','user']) for(let n=0;n<8;n++) {
 const policy={allowSensitiveMemories:!!(n&1),allowUserPreferenceMemories:!!(n&2),allowRunningJokes:!!(n&4)};
 add('policy',{type,risk,scope,policy},getMemoryPolicyViolation(type,risk,scope,policy));
}
for(const type of ['preference','known_user_fact']) for(const requestedUsername of ['','alice','Bob']) for(const triggeringUsername of ['',' Alice ']) for(const triggeringUserID of ['','123']) {
 const input={type,requestedUsername,triggeringUsername,triggeringUserID};add('subject',input,resolveChatMemorySubject(input));
}
for(const query of ['what do you remember','I like chess','مرحبا عالم','😀e\u0301 Test']) for(const summary of ['chess is fun','hello world','مرحبا عالم','test']) for(const score of [0.44,0.45,0.71,0.72]) add('relevance',{query,summary,score},isPassiveMemoryRelevant(query,summary,score));
await writeFile(process.argv[2],JSON.stringify(cases,null,2)+'\n');console.log(cases.length+' memory cases');
