'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const lib=require('./moderation_advanced_source.cjs');
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const bits=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b.toString('hex');};
// Tagged encoding retains undefined, UTF-16 including lone surrogates, and all
// IEEE-754 bits. Object keys here are ordinary fixture keys, not arbitrary JSON.
function enc(v){
  if(v===undefined)return {kind:'undefined'};
  if(v===null)return {kind:'null'};
  if(typeof v==='string')return {kind:'string',utf16:units(v)};
  if(typeof v==='number')return {kind:'number',bits:bits(v)};
  if(typeof v==='boolean')return {kind:'boolean',value:v};
  if(Array.isArray(v))return {kind:'array',items:Array.from({length:v.length},(_,i)=>i in v?enc(v[i]):{kind:'hole'})};
  if(typeof v==='object')return {kind:'object',entries:Object.keys(v).map(k=>[units(k),enc(v[k])])};
  throw new Error(`out of fixture boundary: ${typeof v}`);
}
function wire(v){const s=JSON.stringify(v);return s===undefined?null:units(s);}
function result(fn){try{const value=fn();return {ok:true,value:enc(value),wire:wire(value)};}catch(e){return {ok:false,name:units(e.name),message:units(e.message)};}}
const uuidA='00000000-0000-4000-8000-000000000001',uuidB='00000000-0000-4000-8000-000000000002';
const cases=[];
function parse(id,input,queue=[uuidA,uuidB,uuidA,uuidB]){
  const r=lib.realm({uuidQueue:queue,observe:true});
  const out=result(()=>r.api.parseAdvancedRule(input));
  cases.push({kind:'parse',id,input:enc(input),result:out,uuidQueue:queue.map(units),draws:r.draws.map(x=>x===null?null:units(x)),constructors:enc(r.constructions)});
}
const base={type:'blacklist'};
for(const [id,input] of [
 ['empty',{}],['null-input',null],['array-input',[]],['scalar-input',7],['blacklist',base],
 ['patterns-null',{...base,patterns:null}],['patterns-scalar',{...base,patterns:1}],['patterns-object',{...base,patterns:{}}],['patterns-string',{...base,patterns:'a'}],['patterns-empty',{...base,patterns:[]}],
 ['pattern-null',{...base,patterns:[null]}],['pattern-scalar',{...base,patterns:[1]}],['pattern-array',{...base,patterns:[[]]}],['pattern-object',{...base,patterns:[{}]}],
 ['ten',{...base,patterns:Array.from({length:10},(_,i)=>({id:`id${i}`,source:'x'}))}],['eleven',{...base,patterns:Array.from({length:11},()=>({source:'x'}))}],
 ['duplicate',{...base,patterns:[{id:'same',source:'x'},{id:'same',source:'y'}]}],['generated-duplicate',{...base,patterns:[{source:'x'},{source:'y'},{source:'z'}]}],
 ['invalid-before-duplicate',{...base,patterns:[{id:'same',source:'x'},{id:'same',source:'('}]}],['source-before-id',{...base,patterns:[{source:'',id:'!'}]}],
 ['duplicate-before-regex',{...base,patterns:[{id:'same',source:'x'},{id:'same',source:'('}]}],['regex-before-semantic',{...base,patterns:[{source:'('}],semantic:null}],
 ['pattern-before-type',{type:'caps',patterns:[{source:'('}]}],['semantic-before-type',{type:'caps',semantic:{enabled:true,policy:''}}],
 ['fallback-queue-exhaustion',{...base,patterns:[{source:'x'}]}],
])parse(id,input,id==='fallback-queue-exhaustion'?[]:undefined);
for(const [name,source] of [['empty',''],['space',' \t\n'],['trim-feff','\ufeff'],['zero-width','\u200b'],['one','x'],['250','a'.repeat(250)],['251','a'.repeat(251)],['astral-250','😀'.repeat(125)],['astral-252','😀'.repeat(126)],['leading',' x '],['lone-high','\ud800'],['lone-low','\udc00'],['pair','\ud800\udc00'],['replacement','\ufffd'],['private','\ue000'],['null',null],['number',5],['undefined',undefined],['empty-match','a*'],['alternation-empty','x|'],['lookahead','x(?=y)'],['backref','(x)\\1'],['unterminated','('],['wrapper-invalid','a|'],['captures','(a)(b)'],['anchor','^a$'],['escaped-high','\\uD800'],['escaped-low','\\uDC00'],['escaped-pair','\\uD800\\uDC00']]) parse('source-'+name,{...base,patterns:[{id:'x',source}]});
for(const [name,id] of [['missing',undefined],['null',null],['number',42],['empty',''],['hyphen','-'],['underscore','_'],['digits','123'],['ascii','a_Z-9'],['unicode','é'],['space','x y'],['64','a'.repeat(64)],['65','a'.repeat(65)],['line','a\n'],['astral','😀']])parse('id-'+name,{...base,patterns:[{id,source:'x'}]});
for(const boundary of [undefined,null,'whole_word','anywhere','Whole_word','',0,true,[]])for(const ignoreCase of [undefined,null,true,false,0,'false'])parse(`options-${String(boundary)}-${String(ignoreCase)}`,{...base,patterns:[{id:'x',source:'x',boundary,ignoreCase}]});
for(const semantic of [undefined,null,0,false,'x',[],{}, {enabled:true}, {enabled:false,policy:' \ufeff '}, {enabled:true,policy:' x '}, {enabled:'true',policy:'x'}, {thresholdPercent:null}, {policy:null}, {onUncertain:null}, {examples:null}, {categories:['spam'],broadcasterInvitation:true}, {junk:1}])parse('semantic-shape-'+cases.length,{...base,semantic});
for(const semantic of [
  {enabled:'bad',thresholdPercent:-1,policy:3,onUncertain:'ban',examples:null},
  {enabled:true,thresholdPercent:-1,policy:3,onUncertain:'ban',examples:null},
  {enabled:true,thresholdPercent:50,policy:3,onUncertain:'ban',examples:null},
  {enabled:true,thresholdPercent:50,policy:'',onUncertain:'ban',examples:null},
  {enabled:true,thresholdPercent:50,policy:'ok',onUncertain:'ban',examples:null},
  {enabled:true,thresholdPercent:50,policy:'ok',onUncertain:'allow_and_log',examples:null},
  {enabled:false,policy:'ok',examples:[{message:'',label:'bad'}]},
])parse('semantic-error-order-'+cases.length,{...base,semantic});
for(const thresholdPercent of [-Infinity,-1,-0,0,Number.MIN_VALUE,0.1,85,85.5,100,100.00000000000001,101,Infinity,NaN,'85',null,true])parse('threshold-'+cases.length,{...base,semantic:{thresholdPercent}});
for(const policy of ['', ' ', '\ufeffx\ufeff','😀'.repeat(1000),'😀'.repeat(1001),'x'.repeat(2000),'x'.repeat(2001), '\ud800', 3, null])for(const enabled of [false,true])parse('policy-'+cases.length,{...base,semantic:{enabled,policy}});
for(const example of [null,0,[],{}, {message:'',label:'allow'}, {message:'  ',label:'allow'}, {message:' x ',label:'allow'}, {message:'x',label:'violation'}, {message:'x',label:'ALLOW'}, {message:'x'.repeat(500),label:'allow'}, {message:'x'.repeat(501),label:'allow'}, {message:'😀'.repeat(250),label:'allow'}, {message:'😀'.repeat(251),label:'allow'}, {message:'\ud800',label:'allow'}])parse('example-'+cases.length,{...base,semantic:{examples:[example]}});
for(const n of [0,1,10,11])parse('example-count-'+n,{...base,semantic:{examples:Array.from({length:n},()=>({message:' x ',label:'allow'}))}});
for(const onUncertain of [undefined,'allow_and_log','allow','ban',null,false])parse('uncertain-'+String(onUncertain),{...base,semantic:{onUncertain}});
for(const type of [undefined,null,'blacklist','caps','links','BLACKLIST',0])for(const variant of [{},{patterns:[{id:'x',source:'x'}]},{semantic:{enabled:true,policy:'x'}},{semantic:{enabled:false,policy:'text'}}])parse('type-'+cases.length,{type,...variant});
function match(id,text,terms,patterns){const r=lib.realm({observe:true});cases.push({kind:'match',id,input:enc({text,terms,patterns}),result:result(()=>r.api.findBlacklistMatches(text,terms,patterns)),constructors:enc(r.constructions)});}
const p=(source,boundary='whole_word',ignoreCase=true,id='p')=>({id,source,boundary,ignoreCase});
for(const [id,text,terms,patterns] of [
 ['order','cat dog cat',['dog','cat'],[p('dog','anywhere',true,'r1'),p('cat','anywhere',true,'r2')]],['literal-only-first','cat cat',['cat'],[]],['fold-accent','🎉 CAFÉ scam',['cafe'],[]],['combining','!e\u0301!',['é'],[]],['fold-expansion','!İ!',['i'],[]],['fold-mark','!\u0345!',['ι'],[]],['spaces','!a \t b!',['a b'],[]],['literal-and-regex','café CAFE',['cafe'],[p('cafe','anywhere')]],
 ['captures','!ab! ',[],[p('(a)(b)')]],['nested','!ab! ',[],[p('((a)b)')]],['empty-capture','!b!',[],[p('(a*)b')]],['empty-whole','!a!',[],[p('a*')]],['empty-anywhere','!a!',[],[p('a*','anywhere')]],['alternation','!ab!',[],[p('a|ab','anywhere')]],['later','!a!a!',[],[p('a')]],['case-no','!Ab!',[],[p('ab','anywhere',false)]],['case-yes','!Ab!',[],[p('ab','anywhere',true)]],['astral-offset','😀 !ab!',[],[p('ab')]],['multi-pattern','cat dog cat',['cat'],[p('cat','anywhere',true,'a'),p('cat','anywhere',true,'b')]],['invalid','abc',[],[p('(')]],
])match(id,text,terms,patterns);
for(const source of ['a','(a)','a+','a|ab','[a-z]+','\\p{L}+','😀','\ud800','\udc00','\ud800\udc00','\ufffd','\ue000','\\uD800','\\uDC00','\\uD800\\uDC00'])for(const text of ['!a!','😀 a','!\ud800!','!\udc00!','!\ud800\udc00!','!\ufffd!','!\ue000!'])for(const boundary of ['whole_word','anywhere'])match(`unicode-${cases.length}`,text,[],[p(source,boundary,false)]);
// Direct addon evidence exposes capture contents and reported indices, including
// cases that parseAdvancedRule rejects. No alternate regexp engine is involved.
const re2Cases=[];
for(const source of ['\ud800','\udc00','\ud800\udc00','\ufffd','\ue000','\\uD800','\\uDC00','\\uD800\\uDC00','(.)','(.*?)','(\ud800)','(\udc00)','(\ufffd)'])for(const text of ['\ud800','\udc00','\ud800\udc00','\ufffd','\ue000','A\ud800B','😀\udc00Z']){
  const out=result(()=>{const re=new lib.RE2(source,'du'),m=re.exec(text);return m?{index:m.index,groups:Array.from(m),indices:Array.from(m.indices),input:m.input}:null;});re2Cases.push({source:units(source),text:units(text),result:out});
}
// Direct engine probes deliberately do not predict how V8/addon UTF-8
// conversion handles malformed UTF-16, or which Unicode tables RE2 accepts.
const regexBehaviorCases=[];
function addonObservation(kind,source,flags,text){
  regexBehaviorCases.push({kind,source:units(source),flags:units(flags),text:units(text),result:result(()=>{
    const m=new lib.RE2(source,flags).exec(text);
    return m?{index:m.index,groups:Array.from(m),indices:Array.from(m.indices),input:m.input}:null;
  })});
}
for(const source of ['.','[^a]','\\P{L}','[\\s\\S]','a*','.*','^.*$'])for(const text of [
  '\ud800','\udc00','\ud800A','A\ud800','\udc00A','A\udc00',
  '\ud800\ud800','\udc00\udc00','\udc00\ud800','\ud800\udc00',
  'A\ud800B\udc00C','\ud800\ufffd\udc00','😀\ud800😀\udc00', '\ue000\ud800\ufffd'
]) addonObservation('malformed-utf16',source,'du',text);
const propertyTexts=[
  'A','a','7','_', 'Σ','σ','ς','ſ','S','K','k',
  '\u0264','\ua7cb','\u1c89','\u1c8a','\u{11db0}','\u{11de1}',
  '😀','\ufffd','\ud800','!\u{11db0}!', '!\u{11de1}!'
];
for(const source of ['\\p{L}','\\p{N}','\\p{Lu}','\\p{Letter}','\\p{Cyrillic}','\\p{Tolong_Siki}'])
  for(const flags of ['du','diu'])for(const text of propertyTexts)addonObservation('unicode-property',source,flags,text);
const caseSources=['\u0264','\ua7cb','\u1c89','\u1c8a','Σ','σ','ς','ſ','S','K','k'];
for(const source of caseSources)for(const flags of ['du','diu'])for(const text of caseSources)
  addonObservation('unicode-case-pair',source,flags,text);
// Inspect the actual wrapper captures: the source computes start from group 1,
// so groups 1/2 indices and user capture positions must be independently visible.
const wrapperCases=[];
for(const source of ['a','(a)','(a)(b)','(a*)b','a|ab','(a|ab)','(\\ud800)','(\ud800)','(\ufffd)'])for(const text of ['!ab!','😀 !ab!', 'a ab','!\ud800!', '!\ufffd!']){
  const wrapper=`(^|[^\\p{L}\\p{N}])(${source})($|[^\\p{L}\\p{N}])`;
  wrapperCases.push({source:units(source),text:units(text),result:result(()=>{const m=new lib.RE2(wrapper,'du').exec(text);return m?{index:m.index,groups:Array.from(m),indices:Array.from(m.indices),input:m.input}:null;})});
}
function cacheEvidence(){
  const r=lib.realm({observe:true}), call=pattern=>result(()=>r.api.findBlacklistMatches('x',[],[pattern]));
  const checkpoints=[]; const mark=name=>checkpoints.push({name,count:r.constructions.length});
  const first=p('x','anywhere',true,'first'); call(first);mark('first');call({...first});mark('same-value-hit');
  call({...first,id:'other'});mark('different-id');call({...first,source:'y'});mark('different-source');call({...first,boundary:'whole_word'});mark('different-boundary');call({...first,ignoreCase:false});mark('different-case');
  call({source:'x',id:'first',boundary:'anywhere',ignoreCase:true});mark('property-order');
  call({...first,extra:1});mark('extra-property');
  const full=lib.realm({observe:true}), run=pattern=>result(()=>full.api.findBlacklistMatches('x',[],[pattern]));
  const checkpointsFull=[];const fmark=name=>checkpointsFull.push({name,count:full.constructions.length});
  for(let i=0;i<1000;i++)run(p('x','anywhere',true,'id'+i));fmark('insert-1000');
  run(p('x','anywhere',true,'id0'));fmark('hit-id0');
  run(p('x','anywhere',true,'id1000'));fmark('insert-1001-clears');
  run(p('x','anywhere',true,'id0'));fmark('old-id0-recompile');
  run(p('x','anywhere',true,'id999'));fmark('old-id999-recompile');
  run(p('x','anywhere',true,'id1000'));fmark('new-id1000-hit');
  return {keyFields:{checkpoints,constructors:enc(r.constructions)},capacity:{checkpoints:checkpointsFull,constructors:enc(full.constructions)}};
}
const defaultRealm=lib.realm();
const api=defaultRealm.api;
const singleton=api.emptySemanticPolicy(),another=api.emptySemanticPolicy(); singleton.examples.push({message:'changed',label:'allow'});singleton.policy='changed';
const constants=enc({MODERATION_RETENTION_DAYS:api.MODERATION_RETENTION_DAYS,MODERATION_VISIBLE_DAYS:api.MODERATION_VISIBLE_DAYS,SEMANTIC_MODEL:api.SEMANTIC_MODEL,DECISION_POLICY_VERSION:api.DECISION_POLICY_VERSION,SEMANTIC_DEADLINE_MS:api.SEMANTIC_DEADLINE_MS,ALLOW_THRESHOLD:api.ALLOW_THRESHOLD});
const paid=[undefined,null,false,true,0,1,'free','premium','pro','Premium','PRO',' premium ',{},[]].map(tier=>({tier:enc(tier),result:api.paidModeration(tier)}));
const randomProbe=result(()=>api.parseAdvancedRule({type:'blacklist',patterns:[{source:'x'}]}));
// UUID value is deliberately excluded: record actual crypto availability and shape
// without making output nondeterministic. Deterministic queues above are fixtures.
const cryptoProbe={available:typeof require('node:crypto').randomUUID==='function',success:randomProbe.ok,validUuid:randomProbe.ok && (()=>{const q=api.parseAdvancedRule({type:'blacklist',patterns:[{source:'x'}]}).patterns[0].id;return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(q);})()};
const reference={metadata:{format:1,sourceProvenance:lib.sourceProvenance,versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:'5.9.3',re2:'1.27.0'},nodeSha:lib.nodeSha,pins:lib.pins,re2Runtime:lib.re2Runtime,compiled:lib.compiled,evidence:lib.evidence,provenance:lib.provenance(),boundary:'Ordinary own enumerable JSON-like values plus explicitly tagged undefined/non-finite numbers; no accessors, proxies, toJSON hooks, inherited properties, symbols, functions, BigInt or cyclic objects. UUID queue and constructor observer are test-only boundaries; default realm imports actual node:crypto and real RE2.',caseCount:cases.length,re2CaseCount:re2Cases.length,wrapperCaseCount:wrapperCases.length,regexBehaviorCaseCount:regexBehaviorCases.length},constants,paid,emptyIndependence:enc({mutated:singleton,untouched:another,distinct:singleton!==another,distinctExamples:singleton.examples!==another.examples}),cryptoProbe,cases,re2Cases,regexBehaviorCases,wrapperCases,cache:cacheEvidence()};
const [mode,dir,...extra]=process.argv.slice(2);assert(['--write','--check'].includes(mode)&&dir&&path.isAbsolute(dir)&&extra.length===0,'usage: --write|--check ABSOLUTE_EXTERNAL_DIR');
const real=fs.realpathSync(dir),workspace=fs.realpathSync(path.join(lib.root,'..'));assert(real!==workspace&&!real.startsWith(workspace+path.sep),'output must be outside workspace');
const file=path.join(real,'moderation-advanced-reference.json');assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:[path.basename(file)]);
const output=JSON.stringify(reference,null,2)+'\n';if(mode==='--write')fs.writeFileSync(file,output,{flag:'wx'});else assert.equal(fs.readFileSync(file,'utf8'),output);
console.log(JSON.stringify({mode,sha256:lib.sha(output),cases:cases.length,re2Cases:re2Cases.length,regexBehaviorCases:regexBehaviorCases.length,wrapperCases:wrapperCases.length}));
