'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const source='/task-tools/re2_codec_probe.cc',output='/artifacts/moderation-advanced/codec-probe/re2_codec_probe.node';
assert.equal(process.versions.modules,'137');
const args=['-std=c++20','-shared','-fPIC','-O2','-I/usr/local/include/node',source,'-o',output];
cp.execFileSync('nice',['-n','10','g++',...args],{stdio:'inherit'});
const headerFiles={};for(const file of ['node.h','node_buffer.h','node_version.h','v8-primitive.h','v8.h'])headerFiles[file]=sha(fs.readFileSync('/usr/local/include/node/'+file));
const bytes=fs.readFileSync(output);fs.writeFileSync('/artifacts/moderation-advanced/codec-probe/build-provenance.json',JSON.stringify({node:process.versions,sourceSha256:sha(fs.readFileSync(source)),binarySha256:sha(bytes),bytes:bytes.length,command:['nice','-n','10','g++',...args],headers:headerFiles,image:'sha256:a001f865dc47694124ef59a1f71cdf80e6214f64613f4e5b4d891088f71dca82',compiler:cp.execFileSync('g++',['--version'],{encoding:'utf8'})},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({probeBuilt:true,sha256:sha(bytes),bytes:bytes.length}));
