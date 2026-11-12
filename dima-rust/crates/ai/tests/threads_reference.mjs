// Reference store on logical DB 5 only; all fixture keys are removed in finally.
import {readFile,writeFile} from 'node:fs/promises';import {createRequire} from 'node:module';import vm from 'node:vm';
const require=createRequire(process.cwd()+'/package.json');const ts=require('typescript');const {createClient}=require('redis');
const c=createClient({url:'redis://127.0.0.1:6379/5',socket:{connectTimeout:2000,reconnectStrategy:false}});await c.connect();
const prefix='ai-reference-'+process.pid+':';const touched=new Set();
const cache=new Proxy(c,{get(target,name){if(typeof target[name]!=='function')return target[name];return (...args)=>{if(typeof args[0]==='string'){args[0]=prefix+args[0];touched.add(args[0]);}return target[name](...args);};}});
const raw=await readFile(process.cwd()+'/src/utils/ai/threading/thread_store.ts','utf8');const ast=ts.createSourceFile('thread_store.ts',raw,ts.ScriptTarget.Latest,true);const stripped=ast.statements.filter(s=>!ts.isImportDeclaration(s)&&!ts.isExportDeclaration(s)).map(s=>s.getText(ast).replace(/^export\s+/, '')).join('\n');const js=ts.transpileModule(stripped,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
let seq=0;const store=vm.runInNewContext(js+'\n({createThread,appendThreadTurn,touchThreadIndexes,getThreadPromptContext,enforceThreadLimits})',{getDragonflyClient:async()=>cache,randomUUID:()=>`00000000-0000-4000-8000-${String(++seq).padStart(12,'0')}`,Date});
const limits={maxChannelThreads:40,maxUserThreads:3,maxTurnsStored:20,promptTurns:10};const snapshots=[];
async function snapshot(label,context=null){const values={};for(const key of [...touched].sort()){const type=await c.type(key);if(type==='none')continue;const data=type==='string'?JSON.parse(await c.get(key)):type==='list'?(await c.lRange(key,0,-1)).map(JSON.parse):await c.zRangeWithScores(key,0,-1);values[key.slice(prefix.length)]={type,data,ttl:await c.ttl(key)};}snapshots.push({label,context,values});}
try {
 const m=await store.createThread('c','u','Alice','I love chess',1700000000000);await store.touchThreadIndexes('c','u',m.threadID,1700000000000);
 for(let n=0;n<22;n++)await store.appendThreadTurn('c',m.threadID,{role:'user',userID:'u',username:'Alice',message:`message ${n}`,timestamp:1700000000000+n},limits);
 await store.appendThreadTurn('c',m.threadID,{role:'assistant',username:'DomDimaBot',message:'😀 é مرحبا',timestamp:1700000000023,delivered:false},limits);
 await snapshot('trimmed',await store.getThreadPromptContext('c',m.threadID,10));
 for(let n=1;n<=4;n++){const m=await store.createThread('c','u','Alice','seed '+n,1700000000100+n);await store.touchThreadIndexes('c','u',m.threadID,1700000000100+n);}
 const evicted=await store.enforceThreadLimits('c','u',limits);await snapshot('evicted',evicted);
 await writeFile(process.argv[2],JSON.stringify(snapshots,null,2)+'\n');console.log(snapshots.length+' Dragonfly snapshots');
}finally{if(touched.size)await c.del([...touched]);await c.quit();}
