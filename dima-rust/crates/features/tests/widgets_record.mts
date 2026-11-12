// Pure widget model recording. No service imports, clients, timers, network or stores.
// DIMABOT_DIR=/home/dom/Projects/saas/dimabot TZ=UTC <DIMABOT_DIR>/node_modules/.bin/tsx this-file output.json
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
const root = process.env.DIMABOT_DIR;
if (!root || !process.argv[2]) throw Error('DIMABOT_DIR and output required');
const crypto = createRequire(`${root}/package.json`)('node:crypto');
let choice = 0;
crypto.randomInt = (upper: number) => choice % upper;
crypto.randomUUID = () => '00000000-0000-4000-8000-000000000000';
syncBuiltinESMExports();
const m = await import(`${root}/src/widgets/model.ts`);
const { catalog } = await import(`${root}/src/widgets/catalog.ts`);
const clone = (v: any) => JSON.parse(JSON.stringify(v));
const cases: any[] = [];
function record(fn: string, input: any, name: string) {
  let result: any;
  try { const value = m[fn](clone(input)); result = { ok: value === undefined ? null : value }; }
  catch (e: any) { result = { error: { code: e.code, message: e.message, status: e.status } }; }
  cases.push(clone({ name, fn, input, result }));
}
const base = m.initial().config;
record('config', base, 'default configuration');
record('layout', m.defaultLayout(), 'default layout');
for (const language of ['en','es','xx',null,3]) record('config',{...base,language},`language ${language}`);
for (const characterDesign of ['cards','reel','wheel','elimination','x',null,3]) record('config',{...base,characterDesign},`design ${characterDesign}`);
for (const [field,min,max] of [['spinSeconds',1,15],['pollSeconds',15,180],['channelPointsPerVote',1,1000000],['jokerChance',0,100],['jokerPointsPerVote',1,1000000]] as const)
  for (const value of [min-1,min,max,max+1,1.5,null,'1']) record('config',{...base,[field]:value},`${field} ${value}`);
for (const field of ['includeUnavailable','channelPointsVoting']) for (const value of [true,false,null,0,'yes']) record('config',{...base,[field]:value},`${field} ${value}`);
for (const field of ['sequences','targets','layout','perkTuning','subWheels','characterDesign','channelPointsVoting','channelPointsPerVote','jokerChance','jokerPointsPerVote']) {const v=clone(base);delete v[field];record('config',v,`missing ${field}`);}
for (const input of [null,[],0,'x',{...base,unknown:true},{...base,toString:true},{...base,excludedIds:null},{...base,excludedIds:['unknown']},{...base,excludedIds:[catalog.entries[0].id,catalog.entries[0].id]}]) record('config',input,'object or exclusions');
for (const [field,min,max] of [['cameraWidth',320,800],['cameraHeight',180,640]] as const) for(const value of [min-1,min,max,max+1,1.5,null,'320']) record('layout',{...m.defaultLayout(),[field]:value},`${field} ${value}`);
for(const field of ['cameraCorner','loadoutMode','progressStyle','autoCompact','showActive','showInfo','showProgress','hideActiveDuringGameplay']) {
  record('layout',{...m.defaultLayout(),[field]:'bad'},`bad layout ${field}`);
  const v=m.defaultLayout();delete v[field];record('layout',v,`missing layout ${field}`);
}
record('layout',{...m.defaultLayout(),toString:true},'prototype name refused');
const perks=catalog.entries.filter((e:any)=>e.role==='killer'&&e.kind==='perk').slice(0,3).map((e:any)=>e.id);
const chars=catalog.entries.filter((e:any)=>e.kind==='character');
for (const tuning of [{[perks[0]]:{copies:1,weight:1}},{[perks[0]]:{copies:5,weight:10}},{[perks[0]]:{copies:6,weight:1}},{[perks[0]]:{copies:1,weight:11}},{[perks[0]]:{copies:2,weight:1,extra:true}},{unknown:{copies:2,weight:1}},{[chars[0].id]:{copies:2,weight:1}},null]) record('config',{...base,perkTuning:tuning},'perk tuning');
const wheel={id:'mini',role:'killer',name:'  שלום é 👋  ',perkIds:perks.slice(0,2),copies:2,weight:3};
for(const subWheels of [[wheel],[{...wheel,id:'bad space'}],[{...wheel,name:'a'.repeat(41)}],[{...wheel,name:'👋'.repeat(40)}],[{...wheel,name:'é'.repeat(21)}],[{...wheel,perkIds:[perks[0]]}],[{...wheel,perkIds:[perks[0],perks[0]]}],[{...wheel,role:'survivor'}],[wheel,{...wheel,id:'other'}],[wheel,wheel],Array(21).fill(wheel),null]) record('config',{...base,subWheels},'mini wheels');
for(const role of ['killer','survivor']) {
  for(const fixed of [null,chars.find((c:any)=>c.role===role).id,chars.find((c:any)=>c.role!==role).id,'bad']) for(const character of [true,false]) record('config',{...base,sequences:{...base.sequences,[role]:{...m.defaultSequence(),character,fixedCharacterId:fixed}}},'fixed character');
  for(const perkCount of [-1,0,4,5,null]) record('config',{...base,sequences:{...base.sequences,[role]:{...m.defaultSequence(),perkCount}}},'sequence perk count');
  for(const count of [0,1,20,21,1.5,null]) record('config',{...base,targets:{...base.targets,[role]:count}},'target bound');
}
for(const sequences of [{killer:m.defaultSequence()}, {...base.sequences,unknown:true},null]) record('config',{...base,sequences},'sequence structure');
for(const phase of ['idle','complete','poll-error','character-spin','character-result','polling','reveal','perk-spin','perk-result']) {const s=m.initial();s.phase=phase;record('idle',s,phase);record('active',s,phase);}
for (const id of catalog.packs.map((p:any)=>p.id).concat(['unknown',''])) record('pack',id,'pack lookup');
for (const phase of ['character-result','perk-result','polling','complete']) for(const winningCard of [null,0]) {
  const s=m.initial();s.phase=phase;s.run={id:'fixed',characterId:chars[0].id,perkIds:perks,cards:[0,1,2,3,4],winningCard,choiceIds:['private']};
  record('publicState',s,'public privacy and result alias');
  delete s.config.layout;delete s.config.sequences;delete s.config.targets;delete s.config.perkTuning;delete s.config.subWheels;delete s.loadouts;delete s.wins;
  s.config.future='preserve';s.future='preserve';record('normalize',s,'legacy fields and active run');record('publicState',s,'legacy public');
}
const transitions: any[] = [];
function scenario(name: string, state: any, mode: string, ticket = 0, votes = [0,0,0,0,1]) {
  choice = ticket;
  const input = clone(state), steps: any[]=[];
  function step(op: string, now: number, fn: () => any) {
    let result: any;
    try { const value=fn();result={ok:value===undefined?null:value}; }
    catch(e:any) { result={error:{code:e.code,message:e.message,status:e.status}}; }
    steps.push({op,now,result,state:clone(state),public:m.publicState(clone(state)),price:m.pollPointsPerVote(state)});
  }
  step('start',1000,()=>m.start(state,1000,mode));
  for(let i=0;i<25 && state.nextAt!==null;i++) {
    const now=state.nextAt;
    if(state.phase==='poll-starting') { step('reveal',now,()=>m.reveal(state,votes,now));continue; }
    step('early',now-1,()=>m.settle(state,now-1));
    step('settle',now,()=>m.settle(state,now));
    if(!steps[steps.length-1].result.ok) break;
  }
  transitions.push({name,input,mode,ticket,votes,steps});
}
for(const role of ['killer','survivor']) for(const mode of ['challenge','characters','perks','poll']) for(const design of ['cards','reel','wheel','elimination']) {
  const state=m.initial();state.packId=`dbd-${role}-challenge`;state.config.characterDesign=design;
  scenario(`${role} ${mode} ${design}`,state,mode);
}
for(const character of [false,true]) for(const poll of [false,true]) for(const perks of [false,true]) for(const perkCount of [0,2,4]) {
  const state=m.initial();state.config.sequences.killer={character,fixedCharacterId:chars.find((c:any)=>c.role==='killer').id,poll,perks,perkCount};
  scenario(`sequence ${character} ${poll} ${perks} ${perkCount}`,state,'challenge');
}
for(const ticket of [0,1,3,9,10]) {
  const state=m.initial();state.config.jokerChance=10;state.config.jokerPointsPerVote=50;
  scenario(`joker tie ${ticket}`,state,'poll',ticket,[3,12,4,12,0]);
}
for(const mode of ['challenge','perks']) {
  const state=m.initial();state.config.subWheels=[{...wheel,name:'Mini'}];
  scenario(`mini wheel ${mode}`,state,mode);
}
const sources:any={};for(const file of ['widgets/model.ts','widgets/catalog.ts','widgets/dbd.json','roulette/model.ts']) sources[file]=createHash('sha256').update(await readFile(`${root}/src/${file}`)).digest('hex');
// Intern repeated compound values. Each line is one compact JSON node; references
// only point backwards. Expanding the last root reconstructs the full recording.
const nodes:any[] = [], seen = new Map<string, number>();
function intern(value:any):any {
  if(value===null || typeof value!=='object') return value;
  const node = Array.isArray(value) ? {array:value.map(intern)}
    : {object:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,intern(v)]))};
  const key=JSON.stringify(node);let id=seen.get(key);
  if(id===undefined) {id=nodes.length;seen.set(key,id);nodes.push(node);}
  return {$ref:id};
}
const recordedRoot=intern({sources,catalog,initial:m.initial(),cases,transitions});
await writeFile(process.argv[2],nodes.concat([{root:recordedRoot}]).map(v=>JSON.stringify(v)).join('\n')+'\n');
await writeFile(new URL('../src/widgets/dbd.json',import.meta.url),JSON.stringify(JSON.parse(await readFile(`${root}/src/widgets/dbd.json`,'utf8')))+'\n');
