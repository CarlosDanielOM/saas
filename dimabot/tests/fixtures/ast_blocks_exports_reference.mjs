#!/usr/bin/env node
// Offline oracle: only actual pure block source modules run in a VM. Runtime
// imports from the retired types.ts are frozen wire constants/error semantics;
// no parser, evaluator, service, environment, clock, or network is reachable.
// Generate/check inside an isolated test container:
//   node tests/fixtures/ast_blocks_exports_reference.mjs [--check]
//   node tests/fixtures/ast_blocks_exports_reference.mjs --benchmark /artifacts/ast-exports-ts.json
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const sourceRoot = new URL('../../src/utils/ast_blocks/', import.meta.url);
const fixturePath = new URL('ast_blocks_exports_cases.json', import.meta.url);
const sources = {};
const context = vm.createContext({});
const retiredTypes = vm.runInContext(`({ STORAGE_PREFIX: {memory:'',cache:'#',cacheUser:'##',db:'*',dbUser:'**'}, BlocksError: class BlocksError extends Error { constructor(message, blockId) { super(message); this.blockId = blockId; } } })`, context);
function load(name) {
  const live = new URL(name + '.ts', sourceRoot);
  const archived = new URL('../../../archives/dimabot-typescript/2026-10-28/src/utils/ast_blocks/'+name+'.ts', import.meta.url);
  const source = readFileSync(existsSync(live) ? live : archived, 'utf8');
  sources[name] = createHash('sha256').update(source).digest('hex');
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  const localRequire = (id) => { assert.equal(id, './types.js'); return retiredTypes; };
  new vm.Script(`(function(exports,require){${result.outputText}\n})`, { filename:name+'.ts' }).runInContext(context)(exports, localRequire);
  return exports;
}
const ast = load('from_ast'), norm = load('normalize'), source = load('to_source');
let id = 0;
const lit = value => ({id:`i${++id}`,type:'literal',value});
const node = (type, fields = {}) => ({id:`i${++id}`,type,...fields});
const a = value => ({type:'literal',value});
const root = children => ({id:'root',type:'root',children});
const cases = [];
function add(op, input) {
  let expected;
  try {
    let seq = 0;
    const operations = {
      astToBlock: () => ast.astToBlock(input, () => `n${++seq}`),
      blockShape: () => norm.blockShape(input),
      normalizeRoot: () => norm.normalizeRoot(input), normalizeValue: () => norm.normalizeValue(input),
      rootToSource: () => source.rootToSource(input), topLevel: () => source.topLevel(input),
      escapeChatText: () => source.escapeChatText(input), literal: () => source.literal(input)
    };
    expected = {ok:operations[op]()};
  } catch(error) { expected = {error:error.message}; }
  cases.push({op,input,expected});
}
for (const text of ['', 'hello', 'áé文٣_@!&¡¿', 'for', 'FOR', 'in', 'Random', 'not random', '😀', '\u0301', '\\"\n\t\r', '$(a)%(x)%del(x)*(1)^(*v)#(go)', '\\$(x)', '界'.repeat(10001)]) {
  add('literal',text); add('escapeChatText',text);
}
const astNodes = [a('hello'), a('界'.repeat(10001)), {type:'function',name:'',args:[a('x')]}, {type:'commandRef',commandName:'!go',args:[a('x')]},
  {type:'binary',operator:'+',left:a('1'),right:a('2')}, {type:'unary',operator:'-',argument:a('2')},
  {type:'ternary',test:a('1'),consequent:a('yes'),alternate:a('no')},
  {type:'template',segments:[{type:'text',value:'hello '},{type:'expr',node:{type:'function',name:'user',args:[]}}]},
  {type:'arrayLiteral',items:[a('hello'),a('two')],accessor:{type:'index',index:a('0')}},
  {type:'loopVar',name:'!not-an-editor-name'}, {type:'loopAssign',name:'i',operator:'='},
  {type:'forLoop',loopVar:'i',mode:'range',body:[a('body')],init:a('init'),condition:a('condition'),update:a('update'),iterable:a('unused')},
  {type:'forLoop',loopVar:'i',mode:'foreach',body:[]},
  {type:'root',children:[]},{type:'custom',customType:'fixture',data:{}},
  {type:'function',name:'test',args:[{type:'custom',customType:'nested',data:1}]}];
for (const type of ['getVar','exists','deleteVar','setVar']) {
  for (const storage of ['memory','cache','cacheUser','db','dbUser']) {
    astNodes.push({type,name:retiredTypes.STORAGE_PREFIX[storage]+'文٣',storage,accessor:{type:type==='setVar'?'setIndex':type==='deleteVar'?'remove':'index',index:a('0')},userSelector:a('selector'),...(type==='setVar'?{value:a('value')}:{})});
  }
}
for (const name of ['','bad-name','𐐀'.repeat(64),'a'.repeat(65)]) astNodes.push({type:'getVar',name,storage:'memory'});
for(const input of astNodes) add('astToBlock',input);
const writerNodes = [lit('safe'),node('raw',{source:'$(opaque)'}),node('group',{children:[lit('x')]}),node('function',{name:'say',args:[lit('hi there')]}),node('commandRef',{commandName:'!go',args:[]}),node('binary',{operator:'*',left:node('binary',{operator:'+',left:lit('1'),right:lit('2')}),right:lit('3')}),node('unary',{operator:'-',argument:lit('2')}),node('ternary',{test:lit('1'),consequent:lit('yes'),alternate:lit('no')}),node('template',{parts:[lit('"\\\n'),node('function',{name:'user',args:[]})]}),node('loopVar',{name:'i'}),node('loopAssign',{name:'i',operator:'++'}),node('loopAssign',{name:'i',operator:'+='}),node('forLoop',{loopVar:'i',mode:'foreach',iterable:node('arrayLiteral',{items:[lit('a'),lit('b')]}),body:[node('loopVar',{name:'i'})]}),node('forLoop',{loopVar:'i',mode:'range',init:node('loopAssign',{name:'i',operator:'=',value:lit('0')}),condition:node('binary',{operator:'<',left:node('loopVar',{name:'i'}),right:lit('2')}),update:node('loopAssign',{name:'i',operator:'++'}),body:[lit('x')]})];
for(const type of ['getVar','exists','deleteVar','setVar','arrayLiteral']) {
  for(const kind of ['array','append','random','length','clear','index','setIndex','remove']) {
    const accessor = {type:kind,...(['index','setIndex','remove'].includes(kind)?{index:lit('0')}:{})};
    writerNodes.push(node(type,type==='arrayLiteral'?{items:[lit('hello world'),lit('x')],accessor}:{name:'文',storage:'dbUser',userSelector:lit('you'),accessor,...(type==='setVar'?{value:lit('value')}:{})}));
  }
}
for(const input of writerNodes) { add('topLevel',input); add('rootToSource',root([lit('before '),input,lit(' after')])); add('blockShape',input); }
const normalizeNodes = [node('group',{children:[lit(''),lit('hello'),node('template',{parts:[lit(' '),lit('world')]})]}),node('template',{parts:[lit(''),lit('x'),node('group',{children:[lit('y')]})]}),node('setVar',{name:'x',storage:'cacheUser',value:node('template',{parts:[lit('a'),lit('b')]}),userSelector:node('group',{children:[lit('you')]}),accessor:{type:'setIndex',index:node('template',{parts:[lit('0')]})}})];
for(const input of normalizeNodes) {add('normalizeValue',input);add('normalizeRoot',root([input,lit('tail')]));add('blockShape',root([input]));}
add('rootToSource',root([lit('$'),lit('(x)')]));
add('rootToSource',root([lit('界'.repeat(10001))]));
const benchmarkInputs = [8,256].map(size => {
  const astNode = {type:'function',name:'say',args:Array.from({length:size},(_,i)=>({type:'binary',operator:'+',left:a(String(i)),right:a('1')}))};
  let seq = 0; const block = ast.astToBlock(astNode,()=>`n${++seq}`);
  return {name:size===8?'normal':'large',iterations:size===8?1000:100,ast:astNode,root:root([block])};
});
const fixture={sources,retiredTypesContract:'STORAGE_PREFIX and BlocksError only; no application dependencies',cases,benchmarkInputs};
const argv=process.argv.slice(2);
if(argv[0]==='--benchmark') {
  assert.equal(argv.length,2);
  const runs=[];
  for(const workload of benchmarkInputs) {
    const operations={astToBlock:()=>{let seq=0;return ast.astToBlock(workload.ast,()=>`n${++seq}`);},blockShape:()=>norm.blockShape(workload.root),rootToSource:()=>source.rootToSource(workload.root)};
    for(const [operation,fn] of Object.entries(operations)) {
      for(let i=0;i<100;i++)fn();
      const samples=[]; let sink=0;
      for(let sample=0;sample<7;sample++) {const start=performance.now();for(let i=0;i<workload.iterations;i++) {const result=fn();sink += typeof result==='string'?result.length:result.args.length;}samples.push((performance.now()-start)*1e6/workload.iterations);}
      const sorted=[...samples].sort((a,b)=>a-b);runs.push({workload:workload.name,operation,iterations:workload.iterations,samplesNsPerOp:samples,medianNsPerOp:sorted[3],sink});
    }
  }
  writeFileSync(argv[1],JSON.stringify({runtime:process.version,implementation:'typescript-vm-exports',samples:7,runs},null,2)+'\n');
} else {
  assert.ok(argv.length===0 || argv.length===1 && argv[0]==='--check');
  const body=JSON.stringify(fixture,null,2)+'\n';
  if(argv[0]==='--check') assert.equal(readFileSync(fixturePath,'utf8'),body,'AST exports fixture is stale'); else writeFileSync(fixturePath,body);
  console.log(`AST export oracle: ${cases.length} cases, ${benchmarkInputs.length} benchmark workloads`);
}
