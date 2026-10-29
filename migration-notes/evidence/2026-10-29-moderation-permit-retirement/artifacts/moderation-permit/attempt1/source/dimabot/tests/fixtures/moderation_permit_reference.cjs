#!/usr/bin/env node
'use strict';
// Execute the complete original module; only its Redis boundary is a mock.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), vm = require('node:vm');
const {createRequire} = require('node:module');
const digest = x => crypto.createHash('sha256').update(x).digest('hex');
const nodePin = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(process.env.DIMA_PERMIT_NODE_SHA256, nodePin);
assert.equal(digest(fs.readFileSync(process.execPath)), nodePin);
assert.deepEqual([process.versions.node, process.versions.v8, process.versions.icu, process.versions.unicode], ['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const rootArg = process.env.DIMA_PERMIT_SOURCE_ROOT;
assert(rootArg && path.isAbsolute(rootArg));
const root = fs.realpathSync(rootArg);
assert.equal(rootArg, root);
const [mode, dirArg, ...extra] = process.argv.slice(2);
assert(['--write','--check'].includes(mode) && dirArg && !extra.length && path.isAbsolute(dirArg));
const dir = fs.realpathSync(dirArg);
assert.equal(dir, dirArg);
assert(fs.statSync(dir).isDirectory() && dir !== root && !dir.startsWith(root + path.sep));
const name = 'moderation-permit-reference.json';
assert.deepEqual(fs.readdirSync(dir).sort(), mode === '--write' ? [] : [name]);
if (mode === '--check') assert(fs.lstatSync(path.join(dir,name)).isFile());
const read = f => fs.readFileSync(path.join(root, f));
const localRequire = createRequire(path.join(root, 'package.json'));
const ts = localRequire('typescript');
assert.equal(ts.version, '5.9.3');
const source = read('src/utils/moderation/permit.ts');
assert.equal(digest(source), '6e6ddb3ba1fe7cb2331bf7e6c6a4464b7f6084cd133f855bd97ebaf96699c1ae', 'full source/type/AST pin');
const sf = ts.createSourceFile('permit.ts', source.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(sf.parseDiagnostics.length, 0);
const exported = sf.statements.filter(s => s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
const declared = exported.flatMap(s => ts.isVariableStatement(s) ? s.declarationList.declarations.map(d => d.name.text) : [s.name.text]);
assert.deepEqual(declared, ['PERMIT_MIN_SECONDS','PERMIT_MAX_SECONDS','PERMIT_DEFAULT_SECONDS','PermitTarget','PermitParseResult','normalizePermitLogin','PERMIT_USAGE','parsePermitArgs','permitUserKey','permitChannelKey','grantPermit','hasActivePermit']);
assert(ts.isInterfaceDeclaration(exported[3]) && ts.isTypeAliasDeclaration(exported[4]));
const units = s => Array.from({length:s.length}, (_,i) => s.charCodeAt(i));
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const bits = n => {const b = Buffer.alloc(8); b.writeDoubleBE(n); return b.toString('hex');};
let events = [], replies = {}, failures = [], now = 1700000000123, heldRead = null;
class FixedDate extends Date { static now() { return now; } }
const cache = {
  async set(key, value, options) { events.push({cmd:'set', key:units(key), keyHex:hex(key), value, exBits:bits(options.EX), exString:String(options.EX)}); if (failures.includes('set')) throw Error('set failure'); return 'OK'; },
  async get(key) {
    events.push({cmd:'get', key:units(key), keyHex:hex(key)});
    if (failures.includes(key)) throw Error('get failure');
    if (heldRead && key === heldRead.key) { await heldRead.gate; events.push({cmd:'released', key:units(key)}); heldRead.finished(); }
    return Object.hasOwn(replies,key) ? replies[key] : null;
  },
};
const sandbox = {exports:{}, Date:FixedDate, require(name) { assert.equal(name, '../databases/dragonfly.database.js'); return {getDragonflyClient: async caller => {events.push({cmd:'connect',caller}); return cache;}}; }};
const compiled = ts.transpileModule(source.toString('utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
vm.runInNewContext(compiled.outputText, sandbox, {filename:'permit.ts'});
const api = sandbox.exports;
assert.deepEqual(Object.keys(api).sort(), ['PERMIT_DEFAULT_SECONDS','PERMIT_MAX_SECONDS','PERMIT_MIN_SECONDS','PERMIT_USAGE','grantPermit','hasActivePermit','normalizePermitLogin','parsePermitArgs','permitChannelKey','permitUserKey'].sort());
assert.equal(api.PERMIT_MIN_SECONDS,1); assert.equal(api.PERMIT_MAX_SECONDS,600); assert.equal(api.PERMIT_DEFAULT_SECONDS,60);
const strings = ['', ' ', '\t\n', 'User', '@@@User', '@', 'a'.repeat(25), 'a'.repeat(26), '0', '0000', '0001', '600', '0600', '601', '9'.repeat(400), '000'.repeat(100) + '600', '1\n', '1\r\n', '1\u2028', '1\u2029', '1\n2', '-1', '+1', '1.0', '1e2', '１２', 'ſ', 'K', 'İ', 'Σ', 'user_name', 'a-b', 'a b', '\0', '\ud800', '\udc00', '\ud801\udc00', '\u00a0@HELLO\ufeff', 'a\ud800.'];
const parses = [[]];
for (const a of strings) parses.push([a]);
for (const a of strings) for (const b of ['', '1','600','601','0','0000001','bad','1\n','9'.repeat(400)]) parses.push([a,b]);
parses.push(['a','b','c'], [' ','a',' ','1',' '], ['1','2'], ['@123','1']);
const parsed = parses.map(args => { const result=api.parsePermitArgs(args); return {args:args.map(units), result: 'error' in result ? {error:result.error} : {login:result.login === null ? null : units(result.login),seconds:result.seconds}}; });
const logins = strings.map(s => ({input:units(s), output:units(api.normalizePermitLogin(s))}));
const keys = [];
for (const channel of ['', 'AbC', 'x\ud800', '😀']) for (const login of strings) {
 const user=api.permitUserKey(channel,login), all=api.permitChannelKey(channel);
 keys.push({channel:units(channel), login:units(login), user:units(user), userHex:hex(user), all:units(all), allHex:hex(all)});
}
const grants = [], reads = [], heldReads = [];
async function run() {
 for (const seconds of [0,1,60,600,-1,1.5,-0,NaN,Infinity,-Infinity,1e21,Number.MIN_VALUE,9007199254740992]) for (const login of [null,undefined,'','User','İ','x\ud800']) {
  events=[]; failures=[];
  await api.grantPermit('ch\ud800',seconds,login);
  grants.push({secondsBits:bits(seconds), nowBits:bits(now), login:login == null ? null : units(login), events});
 }
 for (const scenario of ['none','user','channel','both','empty-user','fail-user','fail-channel','fail-both']) {
  const channel='ch\ud800', login='USER', user=api.permitUserKey(channel,login), all=api.permitChannelKey(channel);
  replies={}; failures=[]; events=[];
  if (['user','both'].includes(scenario)) replies[user]='value';
  if (['channel','both'].includes(scenario)) replies[all]='value';
  if (scenario === 'empty-user') replies[user]='';
  if (['fail-user','fail-both'].includes(scenario)) failures.push(user);
  if (['fail-channel','fail-both'].includes(scenario)) failures.push(all);
  let result; try { result={active:await api.hasActivePermit(channel,login)}; } catch {result={error:true};}
  reads.push({scenario, channel:units(channel), login:units(login), events, result});
 }
 for (const failed of ['user', 'channel']) {
  const channel='held', login='USER', user=api.permitUserKey(channel,login), all=api.permitChannelKey(channel);
  replies={}; events=[]; failures=[failed === 'user' ? user : all];
  let release, finish;
  const gate = new Promise(resolve => { release=resolve; });
  const finished = new Promise(resolve => { finish=resolve; });
  heldRead={key:failed === 'user' ? all : user, gate, finished:finish};
  let settled=false, error=false;
  const operation=api.hasActivePermit(channel,login).then(() => {settled=true;}, () => {settled=true;error=true;});
  for (let i=0;i<20 && !settled;i++) await Promise.resolve();
  assert(settled && error, 'rejected read must not wait for held peer');
  assert.deepEqual(events.map(event=>event.cmd), ['connect','get','get']);
  const beforeRelease=events.map(event=>event.cmd);
  release(); await finished; await operation;
  assert.deepEqual(events.map(event=>event.cmd), ['connect','get','get','released']);
  heldReads.push({failed,beforeRelease,afterRelease:events.map(event=>event.cmd),error});
  heldRead=null;
 }
 events=[]; failures=['set']; let error=false; try {await api.grantPermit('x',1,'u');} catch {error=true;} assert(error);
 const files=['src/utils/moderation/permit.ts','src/utils/moderation/permit.rs','src/utils/databases/dragonfly.database.ts','src/utils/databases/dragonfly.database.rs','src/utils/observability/telemetry.ts','src/utils/observability/mod.rs','src/utils/js_string.rs','src/utils/js_unicode.rs','src/utils/js_unicode_data.rs','src/utils/js_compat.rs','src/utils/json_number.rs','tests/moderation_permit.rs','tests/moderation_permit_redis.rs','Cargo.toml','Cargo.lock','rust-toolchain.toml','package.json','package-lock.json'];
 const hashes=Object.fromEntries(files.map(f=>[f,digest(read(f))]));
 hashes['typescript-resolved-js']=digest(fs.readFileSync(localRequire.resolve('typescript')));
 hashes['typescript-package.json']=digest(fs.readFileSync(localRequire.resolve('typescript/package.json')));
 hashes['oracle-script']=digest(fs.readFileSync(__filename));
 hashes['permit-canonical-declarations']=digest(ts.createPrinter({removeComments:true,newLine:ts.NewLineKind.LineFeed}).printFile(sf));
 const output=JSON.stringify({format:1, implementation:'actual-typescript', versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:ts.version}, nodeExecutableSha256:nodePin, sourceSha256:hashes, constants:{min:api.PERMIT_MIN_SECONDS,max:api.PERMIT_MAX_SECONDS,default:api.PERMIT_DEFAULT_SECONDS,usage:api.PERMIT_USAGE}, parsed,logins,keys,grants,reads,heldReads,setFailure:{events,error}},null,2)+'\n';
 const target=path.join(dir,name);
 if(mode==='--write') fs.writeFileSync(target,output,{flag:'wx'}); else assert.equal(fs.readFileSync(target,'utf8'),output);
 console.log(`${name} sha256=${digest(output)} parsed=${parsed.length} keys=${keys.length} grants=${grants.length} reads=${reads.length}`);
}
run().catch(e=>{console.error(e);process.exitCode=1;});
