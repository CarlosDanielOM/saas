'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const [fixture,destination]=process.argv.slice(2),root='/source/dimabot';
const metadata=JSON.parse(fs.readFileSync(fixture,'utf8')).metadata;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const files=new Map(Object.entries(metadata.dependencies));
for(const [relative,digest] of Object.entries(metadata.hashes??{})) if(relative.startsWith('node_modules/')) files.set(relative,digest);
for(const pkg of Object.values(metadata.packages)) {
 for(const [name,hash] of [[pkg.entry??pkg.entryPath,pkg.entrySha256],[pkg.package??pkg.packagePath,pkg.packageSha256]]) {if(files.has(name))assert.equal(files.get(name),hash);files.set(name,hash);}
}
fs.mkdirSync(destination);
for(const [relative,expected] of files) {assert(relative.startsWith('node_modules/')&&!relative.split('/').includes('..'));const bytes=fs.readFileSync(path.join(root,relative));assert.equal(sha(bytes),expected);const out=path.join(destination,'root',relative);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,bytes,{flag:'wx',mode:0o444});}
const reused='/artifacts/posthog-receipt/attempt1/node-provenance/node';assert.equal(sha(fs.readFileSync(reused)),metadata.nodeSha256);assert.equal(sha(fs.readFileSync(process.execPath)),metadata.nodeSha256);
fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify({files:Object.fromEntries(files),nodeSha256:metadata.nodeSha256,reusedReadOnlyNodeBinary:reused,scope:'Public dependency bytes and reused exact binary for read-only hash verification; never executed by Rust'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({copiedPackageFiles:files.size,reusedPinnedNodeBinary:true}));
