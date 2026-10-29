'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const [fixture,destination]=process.argv.slice(2),root='/source/dimabot';
const parsed=JSON.parse(fs.readFileSync(fixture,'utf8'));
const metadata=parsed.metadata??parsed;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const files=new Map(Object.entries(metadata.dependencies));
for(const [relative,digest] of Object.entries({...metadata.hashes,...metadata.pins}))if(relative.startsWith('node_modules/')){if(files.has(relative))assert.equal(files.get(relative),digest);files.set(relative,digest);}
for(const pkg of Object.values(metadata.packages??{}))for(const [p,h] of [['entry','entrySha256'],['package','packageSha256']]){if(files.has(pkg[p]))assert.equal(files.get(pkg[p]),pkg[h]);files.set(pkg[p],pkg[h]);}
fs.mkdirSync(destination);
for(const [relative,expected] of files){assert(relative.startsWith('node_modules/')&&!relative.split('/').includes('..'));const bytes=fs.readFileSync(path.join(root,relative));assert.equal(sha(bytes),expected,relative);const target=path.join(destination,'root',relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx',mode:0o444});}
const reusedNode='/artifacts/posthog-receipt/attempt1/node-provenance/node';assert.equal(sha(fs.readFileSync(reusedNode)),(metadata.nodeSha256??metadata.nodeHash));assert.equal(sha(fs.readFileSync(process.execPath)),(metadata.nodeSha256??metadata.nodeHash));
fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify({files:Object.fromEntries(files),nodeSha256:(metadata.nodeSha256??metadata.nodeHash),reusedReadOnlyNodeBinary:reusedNode,scope:'Public package bytes and existing exact executable for independent hash verification, never executed by Rust tests.'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({copiedPackageFiles:files.size,reusedPinnedNodeBinary:true}));
