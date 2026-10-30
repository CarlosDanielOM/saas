'use strict';
// Pinned SDK oracle. Run only in an isolated environment, with an external,
// initially empty output directory for --write; --check requires exactly the
// previously generated file in that directory.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), { createRequire } = require('node:module');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const nodeSha = '569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108';
assert.equal(sha(fs.readFileSync(process.execPath)), nodeSha);
assert.deepEqual([process.versions.node,process.versions.v8,process.versions.icu,process.versions.unicode], ['24.22.1','13.6.233.17-node.58','78.3','17.0']);
const root = fs.realpathSync(process.env.DIMA_BSON_SOURCE_ROOT);
assert.equal(root, process.env.DIMA_BSON_SOURCE_ROOT);
const [mode, dir, ...extra] = process.argv.slice(2);
assert(['--write','--check'].includes(mode) && path.isAbsolute(dir) && extra.length === 0);
assert.equal(fs.realpathSync(dir),dir);
assert(dir !== root && !dir.startsWith(root + path.sep));
const filename = 'bson-js-json-reference.json';
assert.deepEqual(fs.readdirSync(dir).sort(), mode === '--write' ? [] : [filename]);
const req = createRequire(path.join(root, 'package.json'));
const mongoose = req('mongoose'); assert.equal(mongoose.version,'8.24.2');
const mreq = createRequire(req.resolve('mongoose'));
const driverPath = mreq.resolve('mongodb/lib/bson.js');
const driver = mreq('mongodb/lib/bson.js');
const breq = createRequire(driverPath), bsonPath = breq.resolve('bson'), bson = breq('bson');
const pkg = p => JSON.parse(fs.readFileSync(p));
const mongoPackage = mreq.resolve('mongodb/package.json');
const bsonPackage = path.join(path.dirname(bsonPath), '..', 'package.json');
assert.equal(pkg(mongoPackage).version,'6.20.0'); assert.equal(pkg(bsonPackage).version,'6.10.4');
const options = driver.resolveBSONOptions({});
assert.deepEqual(options,{raw:false,useBigInt64:false,promoteLongs:true,promoteValues:true,promoteBuffers:false,ignoreUndefined:false,bsonRegExp:false,serializeFunctions:false,fieldsAsRaw:{},enableUtf8Validation:true});
const pins = {
  bson: [bsonPath,'64e5de269bbcdee96f2bebb57cc9729b72aaebde02d832005872b7e575899284'],
  bsonPackage: [bsonPackage,'ded0e42e4e1cd876a11c9f799e0692f83ee73ebc9fb7796a5bca05039b4b3e23'],
  mongodb: [driverPath,'1880a069aa02d09798a3a082d77198aafa4a2d6a1c0315691f25820b58c025ea'],
  mongodbPackage: [mongoPackage,'54edfda15c69f02c7d6ddf045f339caa1c94cef76b45c2383e1b35071024241b'],
  mongoosePackage: [req.resolve('mongoose/package.json'),'5136d95bcd0624a94096110ea21ac101b73f1839bc40726eab85649389c17dba'],
};
for (const [file,hash] of Object.values(pins)) assert.equal(sha(fs.readFileSync(file)),hash);
const records=[];
function add(name,value,unsupported=false) { addBytes(name,bson.serialize(value,{ignoreUndefined:false}),unsupported); }
function addBytes(name,bytes,unsupported=false) {
  let expected, error;
  try { expected=JSON.stringify(driver.deserialize(bytes,options)); }
  catch(e) { error=e.name; }
  records.push({name,hex:bytes.toString('hex'),expected:expected ?? null,error:error ?? null,unsupported});
}
const {Long,Double,Int32,Decimal128,ObjectId,Binary,BSONRegExp,BSONSymbol,Code,Timestamp,MinKey,MaxKey,DBRef} = bson;
add('primitive', {z:'\ud800',unicode:'😀',empty:'',b:true,n:null,a:[1,false,null,'\udfff']});
add('numbers', {i:new Int32(-2147483648),nan:new Double(NaN),inf:new Double(Infinity),ninf:new Double(-Infinity),negzero:new Double(-0),float:new Double(1.5)});
for (const n of ['-9223372036854775808','-9007199254740993','-9007199254740992','-1','9007199254740992','9007199254740993','9223372036854775807']) add('long-'+n,{v:Long.fromString(n)});
add('dates',{epoch:new Date(0),extended:new Date(8640000000000000),negative:new Date(-8640000000000000)});
add('objects',{id:new ObjectId('00112233445566778899aabb'),generic:new Binary(Buffer.from([0,1,254,255])),old:new Binary(Buffer.from([1,2,3]),2),uuid:new Binary(Buffer.from('00112233445566778899aabbccddeeff','hex'),4),shortUuid:new Binary(Buffer.from([1,2]),4),symbol:new BSONSymbol('symbol'),min:new MinKey(),max:new MaxKey()});
add('decimals',{a:Decimal128.fromString('1.23400'),b:Decimal128.fromString('-0'),c:Decimal128.fromString('1E+30'),d:Decimal128.fromString('NaN'),e:Decimal128.fromString('Infinity')});
add('code-timestamp',{plain:new Code('x + 1'),scope:new Code('x',{x:3}),ts:new Timestamp({t:4294967295,i:4294967295})});
add('regex-simple',{a:new BSONRegExp('abc','im'),b:new BSONRegExp('','x')});
add('regex-complex',{a:new BSONRegExp('a+','i')});
add('regex-invalid-reader',{a:new BSONRegExp('(','i')});
add('reference',{outer:new DBRef('db.collection',new ObjectId('00112233445566778899aabb'),null,{extra:1})});
// Preserve enumerable own __proto__ in the BSON source object, as the SDK
// reader does with defineProperty. Object.assign invokes its setter.
for (const [name,proto] of [
  ['number',1], ['null',null], ['plain',{marker:'prototype'}], ['array',[1,2]],
  ['date',new Date(0)], ['objectid',new ObjectId('00112233445566778899aabb')],
  ['binary',new Binary(Buffer.from([1,2]))],
  ['uuid',new Binary(Buffer.from('00112233445566778899aabbccddeeff','hex'),4)],
  ['long',Long.fromString('9007199254740993')], ['timestamp',new Timestamp({t:1,i:2})],
  ['decimal',Decimal128.fromString('1.25')], ['code',new Code('x')],
  ['min',new MinKey()], ['max',new MaxKey()], ['regex',new BSONRegExp('a+','i')],
  ['dbref',new DBRef('x',new ObjectId('00112233445566778899aabb'))],
]) {
  const ref={$ref:'db.collection',$id:new ObjectId('abcdefabcdefabcdefabcdef')};
  Object.defineProperty(ref,'__proto__',{value:proto,enumerable:true,writable:true,configurable:true});
  ref.tail='kept';
  add('dbref-proto-'+name,{outer:ref});
}
// BSON treats an input object's _bsontype as a serialization discriminator.
// Patch an equal-length key in real SDK bytes to create an ordinary BSON field.
function protoOrder(name, proto, key, before) {
  const marker=key==='_bsontype'?'____probe':key;
  const ref={$ref:'db.collection',$id:'id'};
  if(before) ref[marker]='prior';
  Object.defineProperty(ref,'__proto__',{value:proto,enumerable:true,writable:true,configurable:true});
  if(!before) ref[marker]='after';
  ref.tail='kept';
  let bytes=bson.serialize({outer:ref},{ignoreUndefined:false});
  if(key==='_bsontype') {
    const i=bytes.indexOf(Buffer.from(marker+'\0')); assert(i>=0);
    Buffer.from(key+'\0').copy(bytes,i);
  }
  addBytes(name,bytes);
}
for (const [name,proto,key] of [
  ['objectid',new ObjectId('00112233445566778899aabb'),'_bsontype'],
  ['binary',new Binary(Buffer.from([1])),'_bsontype'],
  ['long',Long.fromString('9007199254740993'),'__isLong__'],
  ['timestamp',new Timestamp({t:1,i:2}),'t'],
  ['regex',new BSONRegExp('a+','i'),'source'],
]) {
  protoOrder('readonly-before-'+name,proto,key,true);
  protoOrder('readonly-after-'+name,proto,key,false);
}
protoOrder('setter-objectid',new ObjectId('00112233445566778899aabb'),'id',false);
protoOrder('setter-uuid',new Binary(Buffer.from('00112233445566778899aabbccddeeff','hex'),4),'id',false);
protoOrder('setter-dbref',new DBRef('x',new ObjectId('00112233445566778899aabb')),'namespace',false);
add('ordering',{'10':'ten','2':'two','01':'leading',nested:{'9':1,'1':2,tail:3},'__proto__':'ignored'});
add('undefined-storage',{o:{x:undefined},a:[undefined]});
// Construct exact on-wire undefined, duplicate fields and out-of-TimeClip Date;
// the SDK's writer itself normalizes undefined and invalid JS Date on input.
const raw = hex => Buffer.from(hex.replace(/\s/g,''),'hex');
addBytes('legacy-undefined',raw('0b00000006780006790000'));
addBytes('duplicate-keys',raw('13000000107800010000001078000200000000'));
addBytes('invalid-date',raw('10000000096400ffffffffffffff7f00'));
// DBPointer raw scalar: its fields are private in Rust's Bson representation.
addBytes('dbpointer',raw('1a0000000c700002000000630000112233445566778899aabb00'));
// A two-component namespace becomes collection plus $db.
addBytes('dbpointer-db',raw('1d0000000c700005000000612e62630000112233445566778899aabb00'));
let depth={leaf:1}; for(let i=0;i<80;i++) depth={x:depth}; add('depth-80',depth);
const files=['src/utils/bson_js_json.rs','src/utils/js_string.rs','src/utils/lossless_json.rs','src/utils/credit_policy.rs','src/utils/json_number.rs','tests/bson_js_json.rs','Cargo.toml','Cargo.lock','rust-toolchain.toml'];
const hashes=Object.fromEntries(files.map(f=>[f,sha(fs.readFileSync(path.join(root,f)))]));
hashes.oracle=sha(fs.readFileSync(__filename));
const output=JSON.stringify({schema:1,nodeSha,versions:{...process.versions,mongoose:mongoose.version,mongodb:'6.20.0',bson:'6.10.4'},options,sdkHashes:Object.fromEntries(Object.entries(pins).map(([k,v])=>[k,v[1]])),sourceHashes:hashes,records},null,2)+'\n';
const target=path.join(dir,filename);
if(mode==='--write')fs.writeFileSync(target,output,{flag:'wx'});else assert.equal(fs.readFileSync(target,'utf8'),output);
console.log(`${filename} sha256=${sha(output)} records=${records.length}`);
