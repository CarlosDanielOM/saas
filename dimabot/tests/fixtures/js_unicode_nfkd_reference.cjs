// Pinned Node's built-in Unicode NFKD; no application imports or external I/O.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const pin='569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
const versions={node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode};
if(JSON.stringify(versions)!==JSON.stringify({node:'24.22.1',v8:'13.6.233.17-node.58',icu:'78.3',unicode:'17.0'})||sha(fs.readFileSync(process.execPath))!==pin)throw Error('wrong Node toolchain');
const files=['src/utils/js_unicode.rs','src/utils/js_unicode_data.rs','src/utils/js_string.rs','tests/js_unicode_nfkd.rs','tests/support/sha256.rs','tests/fixtures/js_unicode_nfkd_reference.cjs','Cargo.toml','Cargo.lock','rust-toolchain.toml'];
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const mixed=[[],[65,66,67],[0xfb03],[0xff21,0x212a,0x130],[0x61,0x0315,0x0300],[0x61,0x0315,0x0378,0x0300],[0x61,0x0315,0xd800,0x0300],[0xd800,0x301,0xdc00],[0xd83d,0xde00,0x0301,0x0327],[0x61,0x1ab0,0x301],[0xd800],[0xdc00],[0xd800,0xdc00],[0xdbff,0xdfff]];
const cases=mixed.map(input=>({input,output:units(String.fromCharCode(...input).normalize('NFKD'))}));
const chunks=[];
for(let start=0;start<0x110000;start+=0x1000){
 const end=Math.min(start+0x1000,0x110000), hash=crypto.createHash('sha256');let count=0;
 for(let cp=start;cp<end;cp++){
  if(cp>=0xd800&&cp<=0xdfff)continue;
  const result=units(String.fromCodePoint(cp).normalize('NFKD'));
  const record=Buffer.allocUnsafe(6+result.length*2);record.writeUInt32LE(cp,0);record.writeUInt16LE(result.length,4);result.forEach((u,i)=>record.writeUInt16LE(u,6+i*2));hash.update(record);count++;
 }
 chunks.push({start,end,count,sha256:hash.digest('hex')});
}
const [mode,dir,...extra]=process.argv.slice(2);if(!['--write','--check'].includes(mode)||!dir||extra.length||fs.realpathSync(dir)!==path.resolve(dir)||dir===path.dirname(root)||dir.startsWith(path.dirname(root)+path.sep))throw Error('external canonical directory required');
const output=JSON.stringify({schema:1,versions,nodeSha:pin,record:'u32le code point, u16le length, u16le UTF-16 units',count:chunks.reduce((n,c)=>n+c.count,0),hashes:Object.fromEntries(files.map(f=>[f,sha(fs.readFileSync(path.join(root,f)))])),cases,chunks},null,2)+'\n';
const target=path.join(dir,'js_unicode_nfkd.json');if(mode==='--write'){if(fs.readdirSync(dir).length)throw Error('empty directory required');fs.writeFileSync(target,output,{flag:'wx'})}else if(fs.readFileSync(target,'utf8')!==output)throw Error('oracle mismatch');
