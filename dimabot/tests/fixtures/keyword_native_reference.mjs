// Run in a disposable Node container. Real schema hydration, no DB connection.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync,mkdirSync,readFileSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import ts from '../../node_modules/typescript/lib/typescript.js';

const directory=dirname(fileURLToPath(import.meta.url));
const root=resolve(directory,'../../..');
const require=createRequire(import.meta.url);
const mongoose=require('mongoose');
const now=1700000000123;
const FixedDate=class Date extends globalThis.Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
};
const sources={};
const compiledSources={};
function source(relative) {
    const path=[resolve(root,'dimabot',relative),resolve(root,'archives/dimabot-typescript/2026-10-28',relative)].find(existsSync);
    assert.ok(path,relative);
    const text=readFileSync(path,'utf8');
    sources[relative]=createHash('sha256').update(text).digest('hex');
    return text;
}
function load(relative,imports) {
    const js=ts.transpileModule(source(relative),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    compiledSources[relative.replace(/\.ts$/,'.js')]=js;
    const module={exports:{}};
    const requireSource=id=>{assert.ok(Object.hasOwn(imports,id),`forbidden source import ${id}`);return imports[id];};
    new vm.Script(`(function(module,exports,require,Date){${js}\n})`).runInThisContext()(module,module.exports,requireSource,FixedDate);
    return module.exports;
}
const availability=load('src/utils/availability/schema.ts',{'node:crypto':require('node:crypto'),mongoose});
const {CommandsSchema}=load('src/schemas/commands.schema.ts',{'../utils/availability/schema.js':availability,mongoose});
const id={$oid:'0123456789abcdef01234567'};
const date={$date:'2024-01-02T03:04:05.000Z'};
const base={_id:id,activation:'keyword',channelID:'channel',cmd:'Hello'};
const inputs=[
    base,
    {...base,keywordSettings:{}},
    {...base,keywordSettings:{matchMode:null},date:{day:null}},
    {...base,date:null,variables:null,permissions:null,createdAt:null},
    {...base,enabled:false,paused:true,message:'Hi',count:7,cooldown:0,variables:{name:'Dima',amount:42,flag:false,missing:null},permissions:{moderator:true}},
    {...base,keywordSettings:{matchMode:'anywhere'},responses:['a',{}, {empty:{},keep:1}],permissionExpression:{},custom:{empty:{},present:[{}]},createdAt:date},
    {...base,blocks:{version:1,root:{}},availability:{token:'hidden'},availabilityLease:{token:'hidden'}},
    {...base,permissionExpression:{op:'tag',tag:'vip'},date:{month:6},createdAt:{$date:'1969-12-31T23:59:59.999Z'}},
    {...base,variables:{},permissions:{},keywordSettings:null,responses:[],unknown:{}},
    {...base,unknownId:{$oid:'fedcba987654321001234567'},unknownDate:{$date:'2024-12-31T23:59:59.123Z'},unknownBinary:{$binary:{base64:'AAEC/w==',subType:'00'}}},
];
const cases=inputs.map(input=>{
    const row=mongoose.mongo.BSON.EJSON.parse(JSON.stringify(input),{relaxed:true});
    for(const name of ['blocks','availability','availabilityLease']) delete row[name];
    const document=CommandsSchema.hydrate(row,{blocks:0,availability:0,availabilityLease:0});
    return {input,uncached:JSON.parse(JSON.stringify(document.toObject({minimize:false,flattenMaps:true}))),cached:JSON.parse(JSON.stringify(document))};
});
source('src/utils/keywords.ts'); source('src/utils/keyword_cache.ts');
const fixture={schemaVersion:1,now,timeZone:process.env.TZ||'system',sources,cases};
const output=resolve(directory,'keyword_native_cases.json');
const text=JSON.stringify(fixture,null,2)+'\n';
if(process.argv.includes('--prepare-benchmark')) {
    const outputDir=process.argv[process.argv.indexOf('--prepare-benchmark')+1];
    assert.ok(outputDir?.startsWith('/'),'explicit absolute task-owned artifact directory required');
    for(const relative of ['src/utils/keywords.ts','src/utils/keyword_cache.ts']) {
        compiledSources[relative.replace(/\.ts$/,'.js')]=ts.transpileModule(source(relative),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    }
    compiledSources['src/utils/databases/dragonfly.database.js']='exports.getDragonflyClient=async()=>globalThis.__keywordFixtureRedis;\n';
    compiledSources['src/classes/pubsub_manager.class.js']='exports.pubSubManager={subscribe(){throw new Error("PubSub lifecycle is verified separately, not in storage benchmark");}};\n';
    for(const [relative,code] of Object.entries(compiledSources)) {const path=resolve(outputDir,relative);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,code);}
    writeFileSync(resolve(outputDir,'package.json'),JSON.stringify({type:'commonjs'}));
    writeFileSync(resolve(outputDir,'sources.json'),JSON.stringify(sources));
    if(!existsSync(resolve(outputDir,'node_modules')))symlinkSync(resolve(root,'dimabot/node_modules'),resolve(outputDir,'node_modules'),'dir');
    writeFileSync(resolve(outputDir,'benchmark.mjs'),readFileSync(resolve(directory,'keyword_native_benchmark.mjs'),'utf8'));
    console.log(`Prepared clean keyword benchmark: ${resolve(outputDir,'benchmark.mjs')}`);
} else if(process.argv.includes('--check')) {assert.equal(readFileSync(output,'utf8'),text);console.log(`Keyword native schema oracle: ${cases.length} uncached/cache pairs match; no connection.`);}
else {writeFileSync(output,text);console.log(`Keyword native schema oracle wrote ${cases.length} uncached/cache pairs; no connection.`);}
