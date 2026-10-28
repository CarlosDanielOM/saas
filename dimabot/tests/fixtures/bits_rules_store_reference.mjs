#!/usr/bin/env node
// Source oracle: actual Mongoose store and schema against an explicitly owned,
// disposable MongoDB. No env files, production connections, or network mocks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const mongoose = require('mongoose');
assert.equal(process.env.DIMA_RUST_TEST_RESOURCE_OWNER, 'dimabot-migration');
assert.ok(process.env.DIMA_TEST_MONGO_URI, 'isolated fixture URI required');
const base = new URL('../../src/', import.meta.url);
const paths = ['bits_rules/model.ts','bits_rules/store.ts','schemas/eventsub.schema.ts','utils/eventsub.ts'];
const sources = Object.fromEntries(paths.map(path => {
  const content = readFileSync(new URL(path,base),'utf8');
  return [path,{content,sha256:createHash('sha256').update(content).digest('hex')}];
}));
function load(path, localRequire) {
  const output = ts.transpileModule(sources[path].content,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  // Trusted source allowlist in this process's realm: Mongoose schema arrays
  // and Mixed values must use the same intrinsic Array/Object as Mongoose.
  new vm.Script(`(function(exports,require){${output}\n})`,{filename:path}).runInThisContext()(exports,localRequire);
  return exports;
}
const eventSource = sources['utils/eventsub.ts'].content;
const canonical = eventSource.match(/export const CANONICAL_BITS_EVENT_TYPE = '([^']+)'/);
const legacy = eventSource.match(/export const LEGACY_BITS_EVENT_TYPES = \[([^\]]+)\] as const/);
assert.ok(canonical && legacy, 'source Bits constants changed');
const eventConstants = { CANONICAL_BITS_EVENT_TYPE:canonical[1], LEGACY_BITS_EVENT_TYPES:[...legacy[1].matchAll(/'([^']+)'/g)].map(m=>m[1]) };
const model = load('bits_rules/model.ts',()=>{ throw new Error('unexpected model import'); });
const eventSchema = load('schemas/eventsub.schema.ts',id=>{ assert.equal(id,'mongoose'); return mongoose; });
const store = load('bits_rules/store.ts', id=>{
  switch (id) {
    case 'mongoose': return mongoose;
    case '../schemas/eventsub.schema.js': return eventSchema;
    case '../utils/databases/mongodb.database.js': return {getMongoDBConnection:async()=>{}};
    case '../utils/eventsub.js': return eventConstants;
    case './model.js': return model;
    default: throw new Error(`unexpected import ${id}`);
  }
});
const database = `bits_rule_source_${randomUUID().replaceAll('-','')}`;
await mongoose.connect(process.env.DIMA_TEST_MONGO_URI,{dbName:database});
try {
  const db = mongoose.connection.db;
  const events = db.collection('eventsubs'), rules = db.collection('bits_rules');
  await events.insertMany([
    {channelID:'c',type:eventConstants.LEGACY_BITS_EVENT_TYPES[0],cheerTiers:[{minAmount:1,maxAmount:10,message:'old'}]},
    {channelID:'c',type:eventConstants.CANONICAL_BITS_EVENT_TYPE,cheerTiers:[{minAmount:5,maxAmount:6,message:'new'}]},
  ]);
  const initial = await store.loadBitsRules('c');
  const explicitNull = await store.loadBitsRules('c',null);
  const created = await store.changeBitsRules('c','user',list=>{
    list[0].extra={number:4,decimal:1.5,large:2147483648,nested:[2,2.5]}; return list;
  });
  const [createdTypes] = await rules.aggregate([
    {$match:{_id:'c'}},
    {$project:{_id:0,revision:{$type:'$revision'},number:{$type:{$arrayElemAt:['$rules.extra.number',0]}},decimal:{$type:{$arrayElemAt:['$rules.extra.decimal',0]}},large:{$type:{$arrayElemAt:['$rules.extra.large',0]}},nested:{$map:{input:{$arrayElemAt:['$rules.extra.nested',0]},as:'n',in:{$type:'$$n'}}}}},
  ]).toArray();
  const persisted = await store.loadBitsRules('c');
  await rules.insertOne({_id:'fraction',revision:1.5,rules:[]});
  const fraction = await store.changeBitsRules('fraction','user',list=>list);
  const [fractionType] = await rules.aggregate([{$match:{_id:'fraction'}},{$project:{_id:0,revision:{$type:'$revision'}}}]).toArray();
  await rules.insertOne({_id:'stuck',revision:0,rules:[]});
  let attempts=0, conflict;
  try { await store.changeBitsRules('stuck','user',list=>{attempts++;return list;}); }
  catch (error) { conflict={message:error.message,status:error.status,attempts}; }
  assert.ok(conflict,'expected duplicate-key retry exhaustion');
  const snapshot={sourceHashes:Object.fromEntries(Object.entries(sources).map(([path,value])=>[path,value.sha256])),initial,explicitNull,created,persisted,createdTypes,fraction,fractionType,conflict};
  console.log(JSON.stringify(snapshot));
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
