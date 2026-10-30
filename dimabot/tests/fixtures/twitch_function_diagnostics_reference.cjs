// Actual TypeScript declarations, with only their application boundaries mocked.
// Run with the pinned isolated Node/TypeScript toolchain; outputs contain fixtures only.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), vm=require('node:vm'), ts=require('typescript');
const root=path.resolve(__dirname,'../..');
const names=['src/utils/tokens.ts','src/utils/header.ts','src/functions/chats/delete_message.chat.ts','src/functions/mod.rs','src/utils/tokens.rs','src/functions/chats/delete_message.chat.rs','src/utils/test_http.rs','tests/twitch_function_diagnostics.rs','tests/support/sha256.rs','tests/fixtures/twitch_function_diagnostics_reference.cjs','tests/fixtures/twitch_functions_cases.json','Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json'];
const files=Object.fromEntries(names.map(name=>[name,path.join(root,name)]));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function declaration(file,name) {
 const text=fs.readFileSync(file,'utf8'), source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 const matches=source.statements.filter(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(source)===name));
 if(matches.length!==1) throw Error(`missing unique declaration ${name}`);
 return matches[0].getText(source).replace(/^export\s+/, '');
}
async function run(mode) {
 const calls=[];
 const TwitchStreamers={getAccountTokenById:async (...args)=>{calls.push(['account',...args]);if(mode==='class-throw') throw Error('fixture class error');return mode==='missing'?null:'fixture-token'}};
 const getDragonflyClient=async name=>{calls.push(['client',name]); return {hSet:async (...args)=>{calls.push(['hSet',...args]);if(mode==='mirror-throw') throw Error('fixture mirror error')}}};
 const logError=async (...args)=>{calls.push(['log',...args]);return {success:false}};
 const notifyDevelopers=async (...args)=>calls.push(['notify',...args]);
 const source=`const BOT_USER_ID='698614112';\n${declaration(files['src/utils/tokens.ts'],'getBotToken')}\n${declaration(files['src/utils/header.ts'],'getTwitchBotHeader')}\n globalThis.run=getTwitchBotHeader;`;
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const context={Error,TwitchStreamers,getDragonflyClient,logError,notifyDevelopers,process:{env:{CLIENT_ID:'fixture-client'}}};
 vm.runInNewContext(code,context); const response=await context.run(); return {mode,response,calls};
}
async function main(){
 const versions={node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version};
 const nodeSha=sha(process.execPath);
 if(JSON.stringify(versions)!==JSON.stringify({node:'24.22.1',v8:'13.6.233.17-node.58',icu:'78.3',unicode:'17.0',typescript:'5.9.3'})||nodeSha!=='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108')throw Error('wrong oracle toolchain');
 const [mode,dir,...extra]=process.argv.slice(2);if(!['--write','--check'].includes(mode)||!dir||extra.length)throw Error('usage: --write DIR | --check DIR');
 if(fs.realpathSync(dir)!==path.resolve(dir)||!fs.lstatSync(dir).isDirectory()||dir===path.dirname(root)||dir.startsWith(path.dirname(root)+path.sep))throw Error('canonical external directory required');
 const output=JSON.stringify({schema:1,versions,nodeSha,boundary:'actual declarations with mocked class, cache, logger and notification boundaries; class-throw is synthetic because the real class catches lookup errors',hashes:Object.fromEntries(Object.entries(files).map(([k,v])=>[k,sha(v)])),cases:await Promise.all(['missing','success','mirror-throw','class-throw'].map(run))},null,2)+'\n';
 const target=path.join(dir,'twitch_function_diagnostics.json');if(mode==='--write'){if(fs.readdirSync(dir).length)throw Error('write directory must be empty');fs.writeFileSync(target,output,{flag:'wx'});}else if(fs.readFileSync(target,'utf8')!==output)throw Error('oracle mismatch');
}
main().catch(e=>{console.error(e);process.exitCode=1});
