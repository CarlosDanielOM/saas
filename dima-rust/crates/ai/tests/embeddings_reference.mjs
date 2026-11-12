// Real frozen functions and fetch wrapper, isolated from logger initialization.
// Requests are redirected to our loopback recorder; original URLs never reach fetch.
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import vm from 'node:vm';
const require=createRequire(process.cwd()+'/package.json');const ts=require('typescript');
const root=process.cwd()+'/src/utils/ai/';
async function load(path,names,deps={}) {const source=await readFile(root+path,'utf8');const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);const stripped=ast.statements.filter(s=>!ts.isImportDeclaration(s)&&!ts.isExportDeclaration(s)).map(s=>s.getText(ast).replace(/^export\s+/, '')).join('\n');const code=ts.transpileModule(stripped,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;return vm.runInNewContext(code+'\n({'+names.join(',')+'})',{setTimeout,clearTimeout,AbortController,DOMException,Date,process:{env:{LFM2_EMBEDDINGS_TIMEOUT_MS:'500',LFM2_EMBEDDINGS_RETRIES:'1',OPENROUTER_API_KEY:'test-only'}},error:()=>{},...deps},{timeout:1000});}
const cases=[];let active;let answer;
const server=createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);active.requests.push({method:req.method,target:req.url,body:Buffer.concat(chunks).toString(),headers:Object.fromEntries(Object.entries(req.headers).filter(([k])=>['content-type','authorization','http-referer','x-openrouter-title','x-openrouter-description','x-openrouter-categories'].includes(k)))});if(answer.timeout) return;res.writeHead(answer.rateLimit && active.requests.length===1?429:answer.status??200,{'content-type':'application/json'});res.end(JSON.stringify(answer.body));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const fetchLocal=(url,init)=>fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`,init);
try {
 const {createFetchWithRetry}=await load('fetch.utils.ts',['createFetchWithRetry'],{fetch:fetchLocal});
 const {OPENROUTER_APP_HEADERS}=await load('openrouter/app_attribution.util.ts',['OPENROUTER_APP_HEADERS']);
 for(const service of ['lfm2','openrouter']) {
 const c=await load(service==='lfm2'?'lfm2_embeddings/lfm2_embeddings.client.ts':'openrouter/embeddings.ai.ts',['generateEmbedding','generateEmbeddings'],{createFetchWithRetry,fetchWithRetry:createFetchWithRetry({}),OPENROUTER_APP_HEADERS,EMBEDDING_API_URL:'https://openrouter.ai/api/v1/embeddings',EMBEDDING_DIMENSIONS:{'lfm2.5-embedding-350m':1024}});
 for(const [texts,reply] of [[[],{body:{}}],[['rate'],{rateLimit:true,body:{data:[{embedding:[1],index:0}]}}],[['hi 😀'],{body:{data:[{embedding:[0.1,0.2],index:0}],usage:{total_tokens:3.125}}}],[['a','b'],{body:{data:[{embedding:[2],index:1},{embedding:[1],index:0}],usage:{total_tokens:42}}}],[['x'],{status:400,body:{error:{message:'bad'}}}],[['x'],{body:{error:{message:'bad model'}}}],[['x'],{body:{data:[]}}],...(service==='lfm2'?[[['x'],{timeout:true}]]:[])]) {
  answer=reply;active={service,texts,model:'lfm2.5-embedding-350m',kind:'document',channel:'c',reply,requests:[]};
  active.expected=await c.generateEmbeddings(texts,active.model,service==='lfm2'?'document':'c');cases.push(active);
 }
 }
 await writeFile(process.argv[2],JSON.stringify(cases,null,2)+'\n');console.log(cases.length+' embedding recordings');
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
