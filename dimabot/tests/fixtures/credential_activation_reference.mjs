#!/usr/bin/env node
// Actual TS helpers, fixture-only environment/clock/entropy; no application
// imports or credentials. Run inside a dedicated isolated Node test container:
// node tests/fixtures/credential_activation_reference.mjs [--check]
// node tests/fixtures/credential_activation_reference.mjs --benchmark /artifacts/credential-activation-ts.json
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
const require=createRequire(import.meta.url);
const ts=require('typescript'),jwt=require('jsonwebtoken');
const fixedNow=2_000_000_000;
const fixedIv=Buffer.from('000102030405060708090a0b0c0d0e0f','hex');
const fixtureSecret='fixture-activation-secret';
function reference(relative) {
  const live=new URL('../../'+relative,import.meta.url);
  return existsSync(live) ? live : new URL('../../../archives/dimabot-typescript/2026-10-28/'+relative,import.meta.url);
}
const files={crypto:reference('src/utils/crypto.ts'),activation:reference('src/utils/email/email-activation-token.ts')};
const sources=Object.fromEntries(Object.entries(files).map(([name,path])=>[name,crypto.createHash('sha256').update(readFileSync(path,'utf8')).digest('hex')]));
const compiled=Object.fromEntries(Object.entries(files).map(([name,path])=>[name,ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText]));
function load(name,env,randomBytes=()=>fixedIv) {
  const context=vm.createContext({Buffer,process:{env},console:{warn(){}}});
  const exports={};
  const sourceJwt={...jwt,sign:(payload,key,options)=>jwt.sign({...payload,iat:fixedNow},key,options),verify:(token,key)=>jwt.verify(token,key,{clockTimestamp:fixedNow})};
  const localRequire=id=>{
    if(name==='crypto') {assert.equal(id,'crypto');return {...crypto,default:{...crypto,randomBytes},randomBytes};}
    assert.equal(id,'jsonwebtoken');return {...sourceJwt,default:sourceJwt};
  };
  new vm.Script(`(function(exports,require){${compiled[name]}\n})`,{filename:String(files[name])}).runInContext(context)(exports,localRequire);
  return exports;
}
const initialize=[];
for(const key of [null,'','fixture',' ',' '.repeat(32),'x'.repeat(31),'x'.repeat(32),'x'.repeat(33),'é','é'.repeat(16),'é'.repeat(32),'😀','𐐀'.repeat(16)]) {
  let sourceInit=true,sourceCipher=true;
  try {const api=load('crypto',key===null?{}:{SECRET_KEY:key});try{api.encrypt('probe');}catch{sourceCipher=false;}}catch{sourceInit=false;sourceCipher=false;}
  initialize.push({key,sourceInit,sourceCipher,nativeReady:sourceCipher,...(sourceInit&&!sourceCipher?{approvedDifference:'invalid key rejected eagerly at native construction'}:{})});
}
const api=load('crypto',{SECRET_KEY:'fixture'});
const credentialCases=[];
for(const text of ['', 'access-token','résumé 🎮\u0000 token','x'.repeat(1024)]) {
  const envelope=api.encrypt(text);
  credentialCases.push({text,envelope,decoded:api.decrypt(envelope)});
}
const email=load('activation',{EMAIL_AUTH_JWT_SECRET:fixtureSecret});
const signCases=[];
for(const [userId,login] of [['507f1f77bcf86cd799439011','cdom201'],['',''],['用户','réçu🎮'],['u'.repeat(512),'l'.repeat(1024)]]) signCases.push({userId,login,token:email.signEmailActivationToken(userId,login)});
const secretCases=[];
for(const secret of [null,'',' ',fixtureSecret,'é😀']) {
  const source=load('activation',secret===null?{}:{EMAIL_AUTH_JWT_SECRET:secret});
  secretCases.push({secret,nativeReady:secret!==null&&secret!=='',sourceUsesFallback:secret===null||secret==='',token:source.signEmailActivationToken('fixture-user','cdom201')});
}
function rawToken(payload,algorithm='HS256',secret=fixtureSecret) {
  const header=Buffer.from(JSON.stringify({alg:algorithm,typ:'JWT'})).toString('base64url');
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const digest={HS256:'sha256',HS384:'sha384',HS512:'sha512'}[algorithm]??'sha256';
  const signature=algorithm==='none'?'':crypto.createHmac(digest,secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}
const verifyCases=[];
function addVerify(name,claims,algorithm='HS256',secret=fixtureSecret) {
  const token=rawToken(claims,algorithm,secret);
  const source=email.verifyEmailActivationToken(token);
  const requiresExpiration=source!==null&&!Object.hasOwn(claims,'exp');
  verifyCases.push({name,claims,token,source,expected:requiresExpiration?null:source,...(requiresExpiration?{approvedDifference:'native requires expiration'}:{})});
}
const base={sub:'fixture-user',login:'cdom201',exp:fixedNow+3600};
addVerify('missing-iat',base);
addVerify('no-iat-or-exp',{sub:'fixture-user',login:'cdom201'});
for(const iat of [null,'ignored',{},[],false,-1,fixedNow+7200]) addVerify(`ignored-iat-${JSON.stringify(iat)}`,{...base,iat});
for(const exp of [null,'2000003600',true,{},[],fixedNow-1,fixedNow,fixedNow+0.25,fixedNow+1,-1]) addVerify(`exp-${JSON.stringify(exp)}`,{...base,exp});
for(const nbf of [null,'1999999999',true,{},[],fixedNow-1,fixedNow,fixedNow+0.25,fixedNow+1,-1]) addVerify(`nbf-${JSON.stringify(nbf)}`,{...base,nbf});
for(const field of ['sub','login'])for(const value of [null,0,true,{},[]])addVerify(`${field}-type-${JSON.stringify(value)}`,{...base,[field]:value});
for(const algorithm of ['HS256','HS384','HS512','none','RS256'])addVerify(`algorithm-${algorithm}`,base,algorithm);
addVerify('wrong-secret',base,'HS256','wrong-fixture-secret');
addVerify('ignored-audience',{...base,aud:'other'});
for(const token of ['', 'not-a-jwt','a.b.c.d'])verifyCases.push({name:'malformed-'+token,token,source:email.verifyEmailActivationToken(token),expected:null});
const benchmarkInputs=[32,4096].map(size=>{
  const text='x'.repeat(size);const envelope=api.encrypt(text);
  const login=size===32?'cdom201':'l'.repeat(1024),userId='507f1f77bcf86cd799439011';
  return {name:size===32?'normal':'large',iterations:1000,text,envelope,userId,login,token:email.signEmailActivationToken(userId,login)};
});
const fixture={sources,fixedNow,fixedIv:fixedIv.toString('hex'),fixtureSecret,initialize,credentialCases,signCases,secretCases,verifyCases,benchmarkInputs};
const args=process.argv.slice(2);
if(args[0]==='--benchmark') {
  assert.equal(args.length,2);
  const liveCrypto=load('crypto',{SECRET_KEY:'fixture'},crypto.randomBytes);
  const runs=[];
  for(const workload of benchmarkInputs) {
    const operations={encryptEntropy:()=>liveCrypto.encrypt(workload.text).content,decrypt:()=>liveCrypto.decrypt(workload.envelope),sign:()=>email.signEmailActivationToken(workload.userId,workload.login),verify:()=>email.verifyEmailActivationToken(workload.token)};
    for(const [operation,fn]of Object.entries(operations)) {
      for(let i=0;i<100;i++)fn();const samples=[];let sink=0;
      for(let sample=0;sample<7;sample++){const start=performance.now();for(let i=0;i<workload.iterations;i++){const result=fn();sink+=typeof result==='string'?result.length:result.userId.length;}samples.push((performance.now()-start)*1e6/workload.iterations);}
      const sorted=[...samples].sort((a,b)=>a-b);runs.push({workload:workload.name,operation,iterations:workload.iterations,samplesNsPerOp:samples,medianNsPerOp:sorted[3],sink});
    }
  }
  writeFileSync(args[1],JSON.stringify({implementation:'typescript-vm-native-node-crypto-jsonwebtoken',runtime:process.version,samples:7,entropy:'real OS crypto.randomBytes for encrypt in each iteration',clock:'fixed NumericDate in sign/verify facade',runs},null,2)+'\n');
} else {
  assert.ok(args.length===0||args.length===1&&args[0]==='--check');
  const body=JSON.stringify(fixture,null,2)+'\n';
  if(args[0]==='--check')assert.equal(readFileSync(new URL('credential_activation_cases.json',import.meta.url),'utf8'),body);else writeFileSync(new URL('credential_activation_cases.json',import.meta.url),body);
  console.log(`Credential/activation oracle: ${initialize.length} key, ${credentialCases.length} cipher, ${signCases.length} sign, ${secretCases.length} config, ${verifyCases.length} verify cases`);
}
