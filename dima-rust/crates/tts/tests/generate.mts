// Run with the main checkout's tsx; import only frozen pure functions.
import {pathToFileURL} from 'node:url';
import {writeFileSync} from 'node:fs';
const root='/home/dom/Projects/saas/dimabot/src/';
const n=await import(pathToFileURL(root+'utils/tts/normalize_tts_message.util.ts').href);
const t=await import(pathToFileURL(root+'utils/tts/speech_template.util.ts').href);
const inputs=['','hello',' Kappa hi Kappa ','Kappa','Kappa! hi','@viewer heyyyy','😀','👍🏽','👨‍👩‍👧‍👦','é','مرحبا بالعالم','日本語 全角ＡＢＣ','\uFEFF hi\u00a0there\u2028','a\0b\x7fc','https://example.com/a?q=b','www.example.co.uk:80/a','example.com?x=y','ftp://example.com','a@foo.com','a.io x.c http://x.ab/path','Kappa\tKappa\nhello'];
for(const limit of [1,2,3,10,100,200,300,400,500]) for(const delta of [-1,0,1]) for(const char of ['x','😀','👍🏽','é']) inputs.push(char.repeat(Math.max(0,limit+delta)));
const tags=await import(pathToFileURL(root+'utils/tts/expressive_tts_tags.util.ts').href);
const vectors=[];
for(const raw of inputs) for(const mask of [0,1,2,3,4,5,6,7]) for(const limit of [0,1,3,100,500]) {
 const options={skipEmotes:!!(mask&1),stripLinks:!!(mask&2),normalizeWhitespace:!!(mask&4),maxLength:limit,emoteNames:['Kappa',' Kappa ','']};
 vectors.push({raw,options,result:n.normalizeTtsMessage(raw,options),billing:raw.length});
}
const spoken=[];
for(const name of ['Viewer','','  اسم 😀  ']) for(const language of ['en','es']) for(const source of ['ast','chat-command','redemption']) spoken.push({name,language,source,result:n.buildSpokenUserMessage(name,'hello',language,source)});
const templates=[null,'','  ','$(tts &t)','$(tts hi)','$(tts.clone hi)','hello',' hi '].map(input=>({input,result:t.migrateLegacySpeechTemplate(input)}));
const cues=[];
for(const tag of [...tags.EXPRESSIVE_TTS_TAGS,'anger','whispering','crowd laughing','unknown','soft tone','WHISPER']) for(const text of [`[${tag}] Hello`,`< ${tag} >word< / ${tag} >`,`[${tag}][${tag}] end`,`Viewer dice: [${tag}] first [${tag}] next`]) for(const provider of ['piper','kokoro','fish']) for(const on of [true,false]) {
 const enabledTags=tags.normalizeExpressiveTtsTags(Object.fromEntries(tags.EXPRESSIVE_TTS_TAGS.map(t=>[t,on])));
 const filtered=tags.filterExpressiveTtsTags(text,{provider,enabledTags});
 cues.push({text,provider,enabledTags,filtered,reinforced:tags.reinforceFishTtsTags(filtered)});
}
const emotes=[];
for(const text of ['Kappa hello Kappa','😀 Kappa 👍🏽','مرحبا Kappa','é Kappa']) for(const ranges of [['0-4'],['3-7'],['0-1','3-7'],['bad-x'],['0-100'],['3foo-7tail']]) emotes.push({text,ranges,result:n.extractEmoteNames(text,{a:ranges})});
writeFileSync(process.argv[2],JSON.stringify({vectors,spoken,templates,cues,emotes}));
