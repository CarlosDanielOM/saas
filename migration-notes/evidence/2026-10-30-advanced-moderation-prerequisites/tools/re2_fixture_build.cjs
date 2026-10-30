'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const base='/artifacts/moderation-advanced/re2-node24',root=base+'/re2';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
assert.equal(process.versions.node,'24.22.1');assert.equal(process.versions.modules,'137');
const binarySha=sha(fs.readFileSync(process.execPath));assert.equal(binarySha,'569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108');
const manifestBytes=fs.readFileSync(base+'/source-manifest.json'),manifest=JSON.parse(manifestBytes);
const verify=()=>{for(const [f,h]of Object.entries(manifest)){assert.equal(sha(fs.readFileSync(path.join(root,f))),h,f);assert.equal(sha(fs.readFileSync(path.join('/source/dimabot/node_modules/re2',f))),h,f);}};
verify();
const run=(file,args)=>cp.execFileSync(file,args,{encoding:'utf8'}).trim();
const tools={compiler:run('g++',['--version']),make:run('make',['--version']),python:run('python3',['--version'])};
const headers={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.isFile())headers[path.relative('/usr/local/include/node',f)]=sha(fs.readFileSync(f));}}
walk('/usr/local/include/node');assert(Object.keys(headers).length>10);
const kernelHeaderFiles={};function walkKernel(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walkKernel(f);else if(e.isFile())kernelHeaderFiles[f]=sha(fs.readFileSync(f));}}
for(const dir of ['/usr/include/linux','/usr/include/asm','/usr/include/asm-generic'])if(fs.existsSync(dir))walkKernel(dir);assert(Object.keys(kernelHeaderFiles).length>10);
tools.kernelHeaders=run('apk',['info','-v','linux-headers']);
const args=['/source/dimabot/node_modules/node-gyp/bin/node-gyp.js','rebuild','--nodedir=/usr/local','--jobs=2'];
const env={...process.env,NODE_PATH:'/source/dimabot/node_modules',MAKEFLAGS:'-j2'};
cp.execFileSync('nice',['-n','10',process.execPath,...args],{cwd:root,env,stdio:'inherit'});
verify();const output=root+'/build/Release/re2.node',bytes=fs.readFileSync(output);
const provenance={format:1,node:{version:process.versions.node,abi:process.versions.modules,binarySha256:binarySha},image:'sha256:a001f865dc47694124ef59a1f71cdf80e6214f64613f4e5b4d891088f71dca82',sourceManifestSha256:sha(manifestBytes),binary:{relativePath:'build/Release/re2.node',sha256:sha(bytes),bytes:bytes.length},build:{command:['nice','-n','10',process.execPath,...args],jobs:2,headers,kernelHeaderFiles,tools,nodeGypEntrySha256:sha(fs.readFileSync(args[0])),nanPackageSha256:sha(fs.readFileSync('/source/dimabot/node_modules/nan/package.json'))}};
fs.writeFileSync(base+'/build-provenance.json',JSON.stringify(provenance,null,2)+'\n',{flag:'wx'});
const sdk=require(root);assert.equal(typeof sdk,'function');assert.equal(new sdk('a','u').exec('😀 a').index,3);console.log(JSON.stringify({built:true,sha256:provenance.binary.sha256,bytes:bytes.length,sourceFiles:Object.keys(manifest).length,headerFiles:Object.keys(headers).length,abi:process.versions.modules}));
