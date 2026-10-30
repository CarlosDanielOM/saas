// Node built-in Unicode lowercase ASCII projection. No application I/O.
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const nodeSha='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
const versions={node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode};
if(JSON.stringify(versions)!==JSON.stringify({node:'24.22.1',v8:'13.6.233.17-node.58',icu:'78.3',unicode:'17.0'})||sha(fs.readFileSync(process.execPath))!==nodeSha)throw Error('wrong Node toolchain');
const [mode,dir,...extra]=process.argv.slice(2);
if(!['--write','--check'].includes(mode)||!dir||extra.length||fs.realpathSync(dir)!==path.resolve(dir)||!fs.lstatSync(dir).isDirectory()||dir===path.dirname(root)||dir.startsWith(path.dirname(root)+path.sep))throw Error('external canonical directory required');
const target=path.join(dir,'js_unicode_ascii_lower.json');
const files=['src/utils/js_unicode.rs','src/utils/js_unicode_data.rs','src/utils/js_string.rs','src/schemas/channel_fish_voice_favorites.schema.rs','tests/js_unicode_ascii_lower.rs','tests/channel_fish_voice_favorites.rs','tests/support/sha256.rs','tests/fixtures/js_unicode_ascii_lower_reference.cjs','Cargo.toml','Cargo.lock','rust-toolchain.toml'];
const outputFor=(text,bound)=>{const lower=text.toLowerCase();return text.isWellFormed()&&lower.length<=bound&&Array.from(lower).every(c=>c.codePointAt(0)<128)?lower:null};
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const scalars=[];let count=0;
for(let cp=0;cp<=0x10ffff;cp++){if(cp>=0xd800&&cp<=0xdfff)continue;count++;const output=outputFor(String.fromCodePoint(cp),40);if(output!==null)scalars.push({cp,output});}
const mixed=['','A','K','K'.repeat(40),'K'.repeat(41),'İ','Σ','AΣ','AΣA','\0','😀','é','\ufeff A \u2028','\ud800','\udc00','\ud800\udc00','\ud800A\udc00','ABC','ß'];
const cases=mixed.flatMap(text=>[0,1,2,40].map(bound=>({units:units(text),bound,output:outputFor(text,bound),wellFormed:text.isWellFormed()})));
const output=JSON.stringify({schema:1,versions,nodeSha,count,hashes:Object.fromEntries(files.map(f=>[f,sha(fs.readFileSync(path.join(root,f)))])),scalars,cases},null,2)+'\n';
if(mode==='--write'){if(fs.readdirSync(dir).length)throw Error('empty directory required');fs.writeFileSync(target,output,{flag:'wx'});}else if(fs.readFileSync(target,'utf8')!==output)throw Error('oracle mismatch');
