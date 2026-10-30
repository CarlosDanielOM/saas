'use strict';
// Limited to these two frozen files; injectable IO lets negative checks avoid
// touching any real workspace or temporary filesystem.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const pins = Object.freeze({'src/utils/permissions/error_rate_limit.ts':'4e840093ef500738588ea7990f4303ea18f9368abd4d9e898557af73e08e8d56','src/utils/permissions/error_rate_limit.test.ts':'95bee599c425783a84f093c637624eb1ceed5713669c21da596557e95981f0fa'});
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function regular(io, p, optional=false) {
  let st; try { st=io.lstatSync(p); } catch(e) { if(optional && e.code==='ENOENT') return null; throw e; }
  assert(st.isFile(), `not a regular file: ${p}`); assert.equal(io.realpathSync(p),p, `noncanonical file: ${p}`);
  return io.readFileSync(p);
}
function resolve(root, archive, io=fs) {
  assert(path.isAbsolute(root) && path.isAbsolute(archive));
  const manifestPath=path.join(archive,'manifest.json'), manifestBytes=regular(io,manifestPath), manifest=JSON.parse(manifestBytes);
  assert(Array.isArray(manifest.files));
  const sources={};
  for(const [name,hash] of Object.entries(pins)) {
    const live=path.join(root,name), archived=path.join(archive,name);
    const a=regular(io,live,true), b=regular(io,archived,true);
    assert((a===null)!==(b===null), `exactly one live/archive: ${name}`);
    const entries=manifest.files.filter(x=>x.source===name);
    if(b!==null) {assert.equal(entries.length,1,`archive manifest: ${name}`);assert.equal(entries[0].sha256,hash);}
    else assert.equal(entries.length,0,`live source has archive entry: ${name}`);
    const bytes=a===null?b:a; assert.equal(sha(bytes),hash,`source hash: ${name}`);
    sources[name]={location:a===null?'archive':'live',sha256:hash,bytes};
  }
  return {sources,manifestSha256:sha(manifestBytes)};
}
function selfTest(sources) {
  const root='/virtual/root', archive='/virtual/archive', entries=Object.keys(pins);
  // Synthetic pins are injected by temporarily constructing a test fixture
  // around the same regular-file and exact-one validation logic below.
  const makeIo=files=>({lstatSync(p){if(!Object.hasOwn(files,p)){const e=new Error('missing');e.code='ENOENT';throw e;}return {isFile:()=>!files[p].symlink};},realpathSync:p=>p,readFileSync:p=>files[p].bytes});
  const missing=makeIo({}); assert.throws(()=>regular(missing,'/missing')); assert.equal(regular(missing,'/missing',true),null);
  assert.throws(()=>regular(makeIo({'/link':{symlink:true,bytes:Buffer.from('x')}}),'/link',true));
  // Exercise the actual resolver with real frozen source bytes, but only fake IO.
  const files={};
  for(const name of entries) files[path.join(root,name)]={bytes:sources[name].bytes};
  const manifest={files:[]}; files[path.join(archive,'manifest.json')]={bytes:Buffer.from(JSON.stringify(manifest))};
  const io=()=>makeIo(files); resolve(root,archive,io());
  for(const name of entries) {
    const live=path.join(root,name), archived=path.join(archive,name), original=files[live];
    delete files[live]; assert.throws(()=>resolve(root,archive,io())); files[live]=original;
    files[archived]=original; assert.throws(()=>resolve(root,archive,io())); delete files[archived];
    files[live]={symlink:true,bytes:original.bytes}; assert.throws(()=>resolve(root,archive,io())); files[live]=original;
    files[live]={bytes:Buffer.from('tampered')}; assert.throws(()=>resolve(root,archive,io())); files[live]=original;
    delete files[live]; files[archived]=original; assert.throws(()=>resolve(root,archive,io()));
    manifest.files=[{source:name,sha256:pins[name]}]; files[path.join(archive,'manifest.json')].bytes=Buffer.from(JSON.stringify(manifest)); resolve(root,archive,io());
    files[archived]={symlink:true,bytes:original.bytes}; assert.throws(()=>resolve(root,archive,io()));
    files[archived]={bytes:Buffer.from('tampered')}; assert.throws(()=>resolve(root,archive,io())); files[archived]=original;
    manifest.files[0].sha256='0'.repeat(64); files[path.join(archive,'manifest.json')].bytes=Buffer.from(JSON.stringify(manifest)); assert.throws(()=>resolve(root,archive,io()));
    manifest.files=[{source:name,sha256:pins[name]},{source:name,sha256:pins[name]}]; files[path.join(archive,'manifest.json')].bytes=Buffer.from(JSON.stringify(manifest)); assert.throws(()=>resolve(root,archive,io()));
    delete files[archived]; files[live]=original; manifest.files=[]; files[path.join(archive,'manifest.json')].bytes=Buffer.from(JSON.stringify(manifest));
  }
}
module.exports={resolve,selfTest,pins};
