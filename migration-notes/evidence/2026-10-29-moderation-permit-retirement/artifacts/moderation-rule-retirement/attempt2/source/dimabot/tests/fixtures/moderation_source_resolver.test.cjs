'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveModerationSource,overlaySource}=require('./moderation_source_resolver.cjs');
const names=['src/utils/moderation/rules/caps.rule.ts','src/utils/moderation/rules/emote_spam.rule.ts'];
for(const name of names) test(`strict live/archive resolution: ${name}`,t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'moderation-resolver-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'dimabot'),live=path.join(root,name),archive=path.join(base,'archives/dimabot-typescript/2026-10-28',name);
 fs.mkdirSync(path.dirname(live),{recursive:true});fs.mkdirSync(path.dirname(archive),{recursive:true});
 assert.throws(()=>resolveModerationSource(root,name),/exactly one/);
 fs.writeFileSync(live,'live');let actual=resolveModerationSource(root,name);assert.equal(actual.bytes.toString(),'live');assert.equal(actual.relativePath,`dimabot/${name}`);assert.equal(actual.virtualPath,live);
 const host={readFile:()=>undefined,fileExists:()=>false,getSourceFile:()=>undefined};const ts={ScriptKind:{TS:3},createSourceFile:(file,text)=>({file,text})};overlaySource(host,ts,actual);assert.equal(host.readFile(live),'live');assert(host.fileExists(live));assert.deepEqual(host.getSourceFile(live,0),{file:live,text:'live'});
 fs.writeFileSync(archive,'archive');assert.throws(()=>resolveModerationSource(root,name),/exactly one/);fs.unlinkSync(live);
 actual=resolveModerationSource(root,name);assert.equal(actual.bytes.toString(),'archive');assert.equal(actual.relativePath,`archives/dimabot-typescript/2026-10-28/${name}`);assert.equal(actual.virtualPath,live);
 const archivedHost={readFile:()=>undefined,fileExists:()=>false,getSourceFile:()=>undefined};overlaySource(archivedHost,ts,actual);assert.equal(archivedHost.readFile(live),'archive');assert(archivedHost.fileExists(live));assert.deepEqual(archivedHost.getSourceFile(live,0),{file:live,text:'archive'});
 fs.unlinkSync(archive);fs.mkdirSync(archive);assert.throws(()=>resolveModerationSource(root,name),/regular file/);fs.rmdirSync(archive);
 fs.symlinkSync(live,archive);assert.throws(()=>resolveModerationSource(root,name),/regular file/);
 assert.throws(()=>resolveModerationSource(root,'../caps.rule.ts'),/unsupported/);
});
