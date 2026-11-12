// Load only pure exports of the frozen reference; no client, network, timer or
// store is constructed. Source bodies are transpiled without modification.
// DIMABOT_DIR=/home/dom/Projects/saas/dimabot TZ=UTC <DIMABOT_DIR>/node_modules/.bin/tsx this-file output
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root=process.env.DIMABOT_DIR!;const require=createRequire(`${root}/package.json`);const ts=require('typescript');
const sources:Record<string,string>={};
async function source(file:string){const text=await readFile(`${root}/src/${file}`,'utf8');sources[file]=createHash('sha256').update(text).digest('hex');return text;}
function load(text:string,params:Record<string,any>={}){const exports:any={};const js=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;new Function('exports',...Object.keys(params),js)(exports,...Object.values(params));return exports;}
const tags=load(await source('utils/tts/expressive_tts_tags.util.ts'));
const moods=load((await source('pets/moods.ts')).replace(/^import .*;$/gm,''),{...tags,warnPetMood:()=>{}});
const kokoro=load(await source('utils/tts/kokoro_voices.util.ts'));
const fishSource=await source('server/services/tts/fish_tts.service.ts');
const fish=load(fishSource.match(/export const FISH_VOICES:[\s\S]*?\n} as const;/)![0]);
const settingsSource=await source('server/services/pet_settings.service.ts');
const settings=load(settingsSource.slice(settingsSource.indexOf('export const PET_VOICES'),settingsSource.indexOf('export async function getPetConfiguration')),{...moods,...kokoro,...fish,PET_DEFAULT_QUEUE_SIZE:5,PET_MAX_QUEUE_SIZE:10,warnPetMood:()=>{},PetSettingsError:class extends Error{constructor(public code:string,public status=400){super(code)}}});
const stateSource=await source('pets/state.ts');
const state=load(stateSource.slice(stateSource.indexOf('export function requestView'),stateSource.indexOf('export async function finishRequest')),{MOOD_NAMES:moods.MOOD_NAMES,warnPetMood:()=>{}});
const clone=(v:any)=>JSON.parse(JSON.stringify(v));const cases:any[]=[];
function record(fn:string,input:any,call:()=>any){let result;try{result={ok:call()}}catch(e:any){result={error:e.code??e.message}}cases.push({fn,input:clone(input),result:clone(result)});}
const base=settings.defaultPetSettings();
record('default',null,()=>base);
record('settings',base,()=>settings.validatePetSettings(base));
for(const [path,values] of [
 ['name',['','  ',' Dima ','a'.repeat(40),'a'.repeat(41),'é עברית','\u0000','\u0009']],
 ['tts.provider',['piper','fish','kokoro','other',null]],['tts.language',['en','es','fr',null]],['tts.voice',['en_US-ryan-medium','es_MX-ald-medium','af_heart','ef_dora','f'.repeat(32),'https://bad','']],
 ['personality.source',['custom','profile','bad',null]],['personality.profileId',['','x'.repeat(101),null]],['personality.prompt',['','x'.repeat(4000),'x'.repeat(4001),null]],
 ['behavior.cooldownSeconds',[-1,0,3600,3601,1.5,null,'1']],['behavior.maxReplyLength',[29,30,500,501,1.5,null]],['behavior.queueSize',[0,1,10,11,null]],['behavior.askLane',['independent','tts','bad',null]],
 ['ttsAudio',['pet','overlay','bad',null]],['appearance.kind',['png','vts','bad']],['playback.target',['browser','desktop','bad']],
 ['appearance.idleAssetId',[null,'A'.repeat(24),'bad','']],['playback.desktopSessionId',[null,'1'.repeat(24),'bad']],
 ['rules',[[],['ok'],Array(21).fill('x'),[''],['a'.repeat(301)],null]],
 ['enabled',[true,false,0,null]],['sources.independent',[true,false,0,null]],['sources.readTts',[true,false,0,null]],['tts.enabled',[true,false,0,null]],['behavior.respondToChat',[true,false,0,null]],['behavior.respondToEvents',[true,false,0,null]],
 ] as any){for(const value of values){const v=clone(base);const keys=path.split('.');let obj=v;for(const key of keys.slice(0,-1))obj=obj[key];obj[keys.at(-1)!]=value;record('settings',v,()=>settings.validatePetSettings(v));}}
for(const key of Object.keys(base)){const v=clone(base);delete v[key];record('settings',v,()=>settings.validatePetSettings(v));const extra=clone(base);if(typeof extra[key]==='object'&&!Array.isArray(extra[key])){extra[key].unknown=true;record('settings',extra,()=>settings.validatePetSettings(extra));}}
for(const v of [null,[],{}, {...base,unknown:1}])record('settings',v,()=>settings.validatePetSettings(v));
for(const provider of ['piper','kokoro','fish'])for(const language of ['en','es'])for(const voice of settings.PET_VOICES.filter((v:any)=>v.provider===provider).map((v:any)=>v.id)){const v=clone(base);Object.assign(v.tts,{provider,language,voice});record('settings',v,()=>settings.validatePetSettings(v));}
for(const holdMs of [-1,0,0.5,10000,10001,null,'2000']){const v={...moods.defaultPetMoods(),holdMs};record('moods',v,()=>moods.validatePetMoods(v));}
for(const tag of ['anger','whisper','pause','not-an-emotion','happy','laughing']){const v=moods.defaultPetMoods();v.emotions.angry=[tag];record('moods',v,()=>moods.validatePetMoods(v));}
for(const v of [null,[],{},moods.defaultPetMoods(),{...moods.defaultPetMoods(),images:null},{...moods.defaultPetMoods(),images:{happy:{idleAssetId:'A'.repeat(24),talkingAssetId:''}}}]){record('moods',v,()=>moods.validatePetMoods(v));record('saved',v,()=>moods.savedPetMoods(v));}
const minimized=moods.defaultPetMoods();delete minimized.images;record('saved',minimized,()=>moods.savedPetMoods(minimized));
for(const text of ['[whisper] [anger] hi [happy]','[pause] [sigh] [happy]','<laughing> hi','plain text','</happy> [sad]','<\ufeff happy>','[happy] שלום é 👋'])record('resolve',text,()=>moods.resolvePetMood(text,moods.defaultPetMoods()));
for(const tier of ['free','premium','pro','bad']){const v=moods.defaultPetMoods();moods.MOOD_NAMES.forEach((m:string,i:number)=>{v.images[m]={idleAssetId:String(i).repeat(24),talkingAssetId:String(i).repeat(24)}});record('images',{v,tier},()=>({slots:moods.moodImageSlots(v),active:moods.activeMoodImages(v,tier),limit:moods.moodImageLimit(tier),config:moods.moodConfiguration(v,tier)}));}
record('instruction',null,()=>moods.moodInstruction(moods.defaultPetMoods()));
for(const status of ['queued','accepted','generating','ready','playing','completed','cancelled','failed','expired'])for(const mood of [undefined,'happy','bad',null])for(const enabled of [true,false]){const v={_id:'fixed',operation:'ask',status,version:4,outputText:'hello',errorCode:'test',...(mood===undefined?{}:{mood})};record('view',{v,enabled},()=>state.requestView(v,enabled));}
// Intern repeated structures, same compact backward-node format as widgets.
const nodes:any[]=[];const seen=new Map<string,number>();function intern(v:any):any{if(v===null||typeof v!=='object')return v;const node=Array.isArray(v)?{array:v.map(intern)}:{object:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,intern(v)]))};const key=JSON.stringify(node);let id=seen.get(key);if(id===undefined){id=nodes.length;seen.set(key,id);nodes.push(node);}return {$ref:id};}
const fixture=intern({sources,cases});await writeFile(process.argv[2],nodes.map(v=>JSON.stringify(v)).concat(JSON.stringify({root:fixture})).join('\n')+'\n');console.log(`${cases.length} cases`);
