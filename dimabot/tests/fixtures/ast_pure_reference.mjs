// Actual-source parity oracle for the 27 pure AST functions. No function barrel,
// network, services or production context. Timed workloads belong to the lead.
// node dimabot/tests/fixtures/ast_pure_reference.mjs [--check]
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ts from '../../node_modules/typescript/lib/typescript.js';
import {
  buildSourceBundle, createPreparedSourceOracle, preparedSourceLoaderTransport,
  normalizeObservation
} from './ast_evaluator_reference.mjs';
export { normalizeObservation };

const output = new URL('ast_pure_cases.json', import.meta.url);
const oldOutput = new URL('ast_evaluator_cases.json', import.meta.url);
const base = 'dimabot/src/utils/ast_parser/functions/';
const names = ['string','user','random','eventsub'];
const registrations = names.map(name => ({path:`${base}${name}.functions.ts`,exportName:{
  string:'registerStringFunctions',user:'registerUserFunctions',random:'registerRandomFunctions',eventsub:'registerEventsubFunctions'
}[name]}));
const extraSources = ['string.test','user.functions.test','eventsub.test'].map(n=>`${base}${n}.ts`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const EXPECTED_EXTRA_HASHES = {
  [`${base}string.functions.ts`]:'b5aee3e3d2bbfb4722d25591f1ee8a33304bcfe8451b26cc54add036c7bed78d',
  [`${base}user.functions.ts`]:'a92299968379dd8e88cb940b65d7c6b30f7ad539fc333316a06d1f09e59782d7',
  [`${base}random.functions.ts`]:'f5c0e911e9edea325554120cf428accb375096d0e13a4fcbddd8762a512f767b',
  [`${base}eventsub.functions.ts`]:'708d87c8250bdfd7fe2a6c8c2bdb2c991097854f2a7254d27fd66819ed1bde32',
  [`${base}string.test.ts`]:'da657d5f3fe1d835cd7c1f330d627925c9482466dadecd222e072e48b5a1e35e',
  [`${base}user.functions.test.ts`]:'a209bb9844b4403961b08f270f2a88c3d8b1003f5163053be073f9b6399fac4b',
  [`${base}eventsub.test.ts`]:'0b5e5643f8d56f90ebb9280082972f329ecf622a02854583da71eb4139f42b6c'
};
const STRING_NAMES = ['upper','lower','title','capitalize','trim','length','slice','replace'];
const EVENT_NAMES = ['twitch.modiversary','twitch.streak','raid.channel','raid.login','raid.viewers','cheer.amount','cheer.message','sub.tier','sub.months','gifted.user','hypetrain.progress','hypetrain.level','hypetrain.end','shoutout.channel','reward.input','redemption.input'];
export const PURE_NAMES = [...STRING_NAMES,'user','touser','random',...EVENT_NAMES];
assert.equal(PURE_NAMES.length,27);

// AST selection preserves every pure helper, constant, type, metadata object and
// registration in user.ts. Only the ChatFunctions import, randomuserHandler and
// its registerFunction statement are omitted; there is no replacement handler.
function selectPureUserSource(path,text) {
  if (path !== `${base}user.functions.ts`) return text;
  const ast = ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
  const removed = [];
  const statements = [];
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === '../../../functions/chats/index.js') {
      assert.equal(statement.importClause?.namedBindings?.name?.text,'ChatFunctions');
      removed.push('ChatFunctions import'); continue;
    }
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(d=>d.name.getText(ast)==='randomuserHandler')) {
      assert.equal(statement.declarationList.declarations.length,1);
      removed.push('randomuserHandler'); continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'registerUserFunctions') {
      const kept = statement.body.statements.filter(s=>{
        if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)
          && s.expression.expression.getText(ast)==='registerFunction'
          && s.expression.arguments[0]?.text === 'randomuser') {
          assert.equal(s.expression.arguments[1].getText(ast),'randomuserHandler');
          removed.push('randomuser registration'); return false;
        }
        return true;
      });
      assert.equal(kept.length,2,'all actual pure user registrations retained');
      statements.push(ts.factory.updateFunctionDeclaration(statement,statement.modifiers,statement.asteriskToken,statement.name,statement.typeParameters,statement.parameters,statement.type,ts.factory.updateBlock(statement.body,kept)));
    } else statements.push(statement);
  }
  assert.deepEqual(removed,['ChatFunctions import','randomuserHandler','randomuser registration']);
  const selected = ts.createPrinter().printFile(ts.factory.updateSourceFile(ast,statements));
  assert(!/ChatFunctions|randomuserHandler|registerFunction\('randomuser'/.test(selected));
  return selected;
}
async function sourceBundle() {
  const bundle = await buildSourceBundle({extraModules:registrations.map(r=>r.path),extraSources,transformSource:selectPureUserSource});
  assert.deepEqual(Object.fromEntries(Object.keys(EXPECTED_EXTRA_HASHES).map(path=>[path,bundle.hashes[path]])),EXPECTED_EXTRA_HASHES,'pure source/test drift: review actual source before changing guards');
  assert(!Object.values(bundle.code).some(code=>/require\(["'][^"']*functions\/chats\//.test(code)));
  return bundle;
}
export async function createSourceOracle() {
  return createPreparedSourceOracle((await sourceBundle()).code,{registrations});
}
export async function sourceLoaderTransport() {
  return preparedSourceLoaderTransport((await sourceBundle()).code,{registrations});
}
export async function prepareBenchmark(definition,oracle) {
  return (oracle ?? await createSourceOracle()).prepareBenchmark(definition);
}

const lit = value=>({type:'literal',value});
const fn = (name,...args)=>({type:'function',name,args});
const root = (...children)=>({type:'root',children});
const special = $value=>({$value});
const units = (...$utf16)=>({$utf16});
const write = (key,value)=>fn('fixture.write',lit(key),value);
const setMemory = (name,value)=>({type:'setVar',name,storage:'memory',value});
// Actual fixture.value host handler transports typed values, including malformed
// UTF16, into a valid AST. Literals themselves always remain well-formed strings.
function callInput(name,args = [],context = {},host = {}) {
  let hasValue = false, returnValue;
  const nodes = args.map(value=>{
    if (typeof value === 'string' && value.isWellFormed()) return lit(value);
    if (hasValue) assert.deepEqual(value,returnValue,'one typed host return value per case');
    hasValue=true; returnValue=value; return fn('fixture.value');
  });
  return {operation:'evaluate',pureBuiltins:true,ast:fn(name,...nodes),context,host:{...host,...(hasValue?{returnValue}:{})}};
}
const textAtoms = [
  '', ' ', '\t\r\n', '\uFEFF', '\u0085', '\u00a0', '\u2003', 'hello WORLD', 'a  b',
  '0','-0','12.5','0x10','1e3','123_abc', 'a\0b','a\r\nb', '$%*',
  'ß', 'ﬁ', 'İ', 'Iİıi', 'ΣΟΣ ΟΣ', 'ΟΣA', 'Σ\u0301', 'é e\u0301',
  '𐐨𐐀', '😀a😀', '你好 世界', 'العَرَبِيَّة ٢٣', 'Ⅻ²𝟘', 'a\uFEFFb', 'a\u0085b',
  '!a b', '1abc _DEF', '\u0301a b', 'a-b c_d', 'A'.repeat(257)+'ß',
  units(0xD800),units(0xDC00),units(65,0xD800,32,98),units(0xD800,0xD800,0xDC00)
];
const typedAtoms = [null,special('undefined'),true,false,0,1,-1,1.5,special('-0'),special('NaN'),special('Infinity'),special('-Infinity'),[],['$x'],[null,'',1,'😀'],{z:1,a:2},{$object:[['10','ten'],['2','two'],['z',null],['a','😀']]}];
const valueAtoms = [...textAtoms,...typedAtoms];

function caseDefinitions() {
  const cases = [];
  const add = (category,input,label='',invariant) => {
    assert.equal(input.pureBuiltins,true);
    cases.push({id:`pure-${category}-${String(cases.length).padStart(4,'0')}${label?`-${label}`:''}`,category,input,...(invariant===undefined?{}:{invariant:{type:'string',value:invariant}})});
  };
  const call = (category,name,args=[],context={},host={},label='',expected)=>add(category,callInput(name,args,context,host),label,expected);
  const parse = (text,context={},label='',expected)=>add('parser',{operation:'parseEvaluate',pureBuiltins:true,text,context,host:{}},label,expected);
  // Joining must preserve empty/null gaps; it uses String(arg ?? ''), not JSON.
  for (const name of STRING_NAMES.slice(0,6)) {
    call(`string-${name}`,name,[],{}, {},'empty');
    for (const value of valueAtoms) {
      call(`string-${name}`,name,[value]);
      call(`string-${name}`,name,['a',value,'b']);
      call(`string-${name}`,name,[value,value,'']);
    }
  }
  call('edge','length',['😀'],{},{},'utf16-length','2');
  call('edge','capitalize',['𐐨abc'],{},{},'first-unit-not-codepoint','𐐨abc');
  call('edge','title',['ΟΣ ΟΣ'],{},{},'whole-lower-final-sigma','Ος Ος');
  call('edge','title',['a\uFEFFb\u0085C'],{},{},'bom-not-nel','A\uFEFFB\u0085c');
  call('edge','upper',['ß ﬁ'],{},{},'uppercase-expansion','SS FI');
  call('edge','lower',['İ'],{},{},'dot-expansion','i\u0307');
  call('edge','trim',['\uFEFFa\u0085'],{},{},'trim-js-whitespace','a\u0085');
  call('edge','length',['a',null,'b'],{},{},'joined-null-gap','4');

  const sliceTokens = ['', '0','1','2','-1','-2','-99','99','01','-0','+1','1.0','1.5','1e2','0x1','1x','١','１',' 1 ','\uFEFF-1\uFEFF','-', '--1','-'.repeat(2), '9'.repeat(400), '-'+ '9'.repeat(400),null,0,1,-1,[],['1'],special('Infinity'),special('NaN')];
  const sliceTexts = ['hello world','😀ab','𐐨ßﬁ', '', '0123456789', 'a\uFEFFb'];
  call('slice','slice',[],{},{},'empty','');
  for (const token of sliceTokens) for (const text of sliceTexts) {
    call('slice','slice',[token,text]);
    call('slice','slice',[token,'2',text]);
  }
  for (const args of [['-','1','abc'],['-','-2','abc'],['-','0','2','abc'],['0','-','1','😀ab'],['-','2','-','1','abc'],['0','1','😀'],['1','2','😀'],['0','2','😀']]) call('slice-fold','slice',args);
  for (const text of [units(0xD800),units(0xDC00),units(0xD83D,0xDE00,0xD800)]) for (const start of ['0','1','-1']) call('slice-utf16','slice',[start,'2',text]);
  call('edge','slice',['0','1','😀'],{},{},'slice-high-half');
  call('edge','slice',['1','2','😀'],{},{},'slice-low-half');
  for (const search of ['a','aa','aba','aaaaab','','$','%','*','😀',' ','İ','ß','\0']) for (const replacement of ['x','$&','$$','aa','']) {
    call('replace','replace',[search,replacement,'aaba aaaaaab 😀 $%* İß\0 aaaba']);
  }
  for (const value of typedAtoms) {
    call('replace-typed','replace',[value,'$&','0 null undefined false true [object Object] $x']);
    call('replace-typed','replace',['a',value,'banana']);
    call('replace-typed','replace',['a','x',value]);
  }
  call('edge','replace',['aa','aaa','aaaa'],{},{},'nonoverlap-no-rescan','aaaaaa');
  call('edge','replace',['a','$&$$','aba'],{},{},'literal-dollars','$&$$b$&$$');
  call('edge','replace',['','x','abc'],{},{},'empty-search','abc');

  const filterPlans = [[],['ignore'],['ignore','symbols'],['ignore','numbers'],['ignore','symbols','numbers'],['ignore','numbers','symbols'],['IGNORE SYMBOLS NUMBERS'],['ignore','symbols','symbols'],['ignore','numbers','numbers'],['ignore','symbols','invalid'],['ignore','constructor'],['ignore','__proto__'],['ignore','toString'],['symbols','numbers'],['ignore\uFEFFsymbols\t numbers'],['ignore\u0085symbols'],[' ignore  symbols  ']];
  const userNames = ['cdom201','the_mighty_$kill201','Jose\u0301_Á','CDOM_201','cdom٢٣٤','cdomⅫ','a²𝟘','𐐨_123','Ⅻ','\u0301','!!!','123_!!!','_😀_','a\u200db','a\uFEFFb','漢字_١','a\0b','ßﬁİΣ',units(0xD800),units(97,0xDC00,0xD800,50)];
  for (const userName of userNames) for (const plan of filterPlans) call('user-filter','user',plan,{eventData:{chatter_user_name:userName}});
  const fallbacks = [
    {},{eventData:{chatter_user_name:'event',chatter_user_login:'event-login'},extraContext:{userName:'extra',userLogin:'extra-login'}},
    {eventData:{chatter_user_name:0,chatter_user_login:'event-login'},extraContext:{userName:'extra'}},
    {eventData:{chatter_user_name:false,chatter_user_login:''},extraContext:{userName:'extra',userLogin:'extra-login'}},
    {extraContext:{userName:0,userLogin:'extra-login'}},{extraContext:{userName:[],userLogin:'ignored'}},
    {eventData:{chatter_user_name:{z:1}}},{eventData:{chatter_user_name:[]}},
    {userDisplayName:'',userLogin:'context-login'},{userDisplayName:'',userLogin:''},
    {userDisplayName:null,userLogin:'context-login'}, {eventData:{chatter_user_name:'   '}},
    {eventData:{chatter_user_name:null,chatter_user_login:42}},{extraContext:{userName:true}}
  ];
  for (const context of fallbacks) for (const args of [[],['ignore','symbols'],['ignore','numbers']]) call('user-fallback','user',args,context);
  const targets = [...typedAtoms,'','$x%*','\uFEFF $%* ',units(0xD800,36,37,42)];
  for (const target of targets) for (const argument of ['', 'arg$%*',0,false,[],['$x'],null]) call('touser-target','touser',[target],{argument,eventData:{chatter_user_name:'caller$%*'}});
  for (const context of fallbacks) call('touser-fallback','touser',[],context);
  call('edge','touser',['$x%*'],{},{},'string-escape','\\$x\\%\\*');
  call('edge','touser',[['$x']],{},{},'array-unescaped','$x');

  // These ordinary own-key objects are fully inside the plain-data domain.
  // Object.prototype.valueOf cannot rescue a non-callable own toString property.
  const badObjects=[{toString:null},{toString:3},{toString:special('undefined')}];
  for (const [i,bad] of badObjects.entries()) for (const [shape,value] of [['object',bad],['nested-array',[bad]]]) {
    const label=`${i}-${shape}`;
    for (const name of ['upper','lower','title','capitalize','trim','length','random','touser']) call('ordinary-coercion-throws',name,[value],{},{randomSeed:19},`${name}-${label}`);
    call('ordinary-coercion-throws','replace',[value,'x','text'],{},{},`replace-search-${label}`);
    call('ordinary-coercion-throws','replace',['',value,'text'],{},{},`replace-empty-search-replacement-${label}`);
    call('ordinary-coercion-throws','replace',['','replacement','prefix',value],{},{},`replace-empty-search-text-${label}`);
    call('ordinary-coercion-throws','replace',['','replacement',value,value],{},{},`replace-empty-search-joined-${label}`);
    call('ordinary-coercion-throws','user',['not-ignore','symbols',value,'later'],{eventData:{chatter_user_name:'Caller'}},{},`user-all-tokens-before-prefix-${label}`);
    call('ordinary-coercion-throws','user',['ignore','not-an-option',value,'later'],{eventData:{chatter_user_name:'Caller'}},{},`user-all-tokens-before-option-${label}`);
    call('ordinary-coercion-throws','user',[],{eventData:{chatter_user_name:value}},{},`user-context-name-${label}`);
    call('ordinary-coercion-throws','user',['ignore','symbols'],{extraContext:{userName:value}},{},`user-extra-name-${label}`);
    call('ordinary-coercion-throws','touser',[],{argument:value},{},`touser-context-argument-${label}`);
    call('ordinary-coercion-throws','touser',[],{eventData:{chatter_user_name:value}},{},`touser-context-name-${label}`);
    call('ordinary-coercion-throws','slice',['0',value,'text'],{},{},`slice-second-token-${label}`);
    call('ordinary-coercion-throws','slice',['0','nonnumeric',value],{},{},`slice-used-text-${label}`);
    call('ordinary-uncoerced-tail','slice',['notnumber','unused',value],{},{},`slice-unused-third-${label}`,'');
    call('ordinary-uncoerced-tail','slice',['notnumber',value,'unused','tail'],{},{},`slice-unused-second-${label}`,'');
    call('ordinary-uncoerced-tail','slice',[],{eventData:{chatter_user_name:value}},{},`slice-unused-context-${label}`,'');
    // Event getters type-check each candidate before any conversion. They do
    // not apply String to arbitrary object fields, even with hostile own keys.
    for (const name of EVENT_NAMES) call('ordinary-event-type-filter',name,[],{eventData:{
      viewers:value,bits:value,cheer:{bits:value},message:{text:value},tier:value,
      sub_tier:'2000',cumulative_months:value,streak_months:'3',watch_streak:{streak_count:value},modiversary:{months:value},
      recipient_user_name:value,recipient_user_login:'fallback',progress:value,total:'7',level:value,
      ends_at:value,ended_at:' later ',user_input:value,reward_input:' input ',from_broadcaster_user_name:value,from_broadcaster_user_login:'from'
    }},{},`${name}-${label}`);
  }
  const harmless={valueOf:3};
  for (const name of ['upper','lower','title','capitalize','trim','length','random','touser']) call('ordinary-coercion-control',name,[harmless],{},{randomSeed:19},name);
  call('ordinary-coercion-control','replace',['Object','DATA',harmless],{},{},'replace','[object DATA]');
  call('ordinary-coercion-control','user',[],{eventData:{chatter_user_name:harmless}},{},'user','[object Object]');

  const numericValues = ['', ' ', '\uFEFF', '0','-0','1','12.5','0x10','1e3','1e309','NaN','Infinity','12x',null,special('undefined'),false,true,0,1,-1,1.5,9007199254740991,9007199254740992,special('NaN'),special('Infinity'),special('-Infinity'),[],{},['2']];
  const payloads = [undefined,null,false,0,'',[],{},
    {viewers:12,bits:34,cheer:{bits:56},message:{text:'nested'},tier:'2000',cumulative_months:8,watch_streak:{streak_count:9},modiversary:{months:24},recipient_user_name:'Recipient',progress:15,level:2,ends_at:' end ',user_input:' input ',from_broadcaster_user_name:'From',from_broadcaster_user_login:'from',to_broadcaster_user_name:'To',to_broadcaster_user_login:'to'},
    {raid_direction:'outgoing',to_broadcaster_user_name:' To ',to_broadcaster_user_login:'to',from_broadcaster_user_name:'From',from_broadcaster_user_login:'from'},
    {raid_direction:'OUTGOING',from_broadcaster_user_name:'From',from_broadcaster_user_login:'from'},
    {raid_direction:true,to_broadcaster_user_name:'To',from_broadcaster_user_name:'From'},
    ...numericValues.map(value=>({viewers:value,bits:value,cumulative_months:value,streak_months:'17',months:19,progress:value,total:'23',goal:29,level:value,watch_streak:{streak_count:value},modiversary:{months:value}})),
    ...numericValues.map(value=>({cheer:{bits:value},bits:71,message:{text:value},tier:value,user_input:value,reward_input:' fallback ',recipient_user_name:value,recipient_user_login:'fallback-login',from_broadcaster_user_name:value,from_broadcaster_user_login:'from-login',to_broadcaster_user_name:value,to_broadcaster_user_login:'to-login',ends_at:value,ended_at:' later '})),
    ...['1000',' tier_2 ','Tier-3',' PRIME ','weird raw tier ','','  '].map(tier=>({tier,sub_tier:'3000',subscription_tier:'1000'})),
    ...[true,false,'true',' TRUE ','false',' false ',1,0,null,'yes'].map(is_prime=>({tier:'1000',is_prime,prime:'true',sub_plan_name:'not prime indeed'})),
    {tier:' raw tier ',is_prime:false,prime:false,sub_plan_name:'Regular'},
    {tier:'1000',is_prime:false,prime:true,sub_plan_name:'Regular'},
    {tier:'1000',is_prime:'false',prime:'true',sub_plan_name:'Regular'},
    {tier:'1000',is_prime:'invalid',prime:true,sub_plan_name:'Regular'},
    {tier:'1000',sub_plan_name:' ',plan_name:'Prime Plan'},
    {tier:'',sub_tier:'',subscription_tier:'custom'}, {message:{text:'   '},user_input:'   ',reward_input:' fallback '},
    {message:' plain ',user_input:units(0xD800),reward_input:'x'},
    {watch_streak:[],modiversary:[],streak_months:999,cumulative_months:888},
    {watch_streak:'8',modiversary:true},{watch_streak:{streak_count:-0},modiversary:{months:-0}},
    {$object:[[{utf16:[0xD800]},'key'],['user_input',' exact whitespace \t ']]}
  ];
  for (const name of EVENT_NAMES) {
    for (const eventData of payloads) call(`event-${name}`,name,[],eventData===undefined?{}:{eventData});
    // Ignored arguments still execute before source handlers and can consume RNG.
    add('event-argument-effects',{operation:'evaluate',pureBuiltins:true,ast:fn(name,write('argument-first',lit('done')),fn('random',lit('1'))),context:{eventData:{viewers:3,user_input:'ok'}},host:{randomSeed:19}},name);
  }
  const bounds = [...valueAtoms,'-2','-100','+5','0.5','-0.5','10abc',' 25px','1e9','0x10','0b10','9999999999999999999999999999999999999999999','9'.repeat(400),'-'+'9'.repeat(400)];
  for (const bound of bounds) for (const randomSeed of [0,1,19,0xffffffff]) call('random','random',[bound],{}, {randomSeed});
  for (const randomSeed of [0,1,19,0xffffffff]) call('random','random',[],{}, {randomSeed},'default');
  add('random-sequence',{operation:'evaluate',pureBuiltins:true,ast:root(...['1','0','-1','2','-100','9'.repeat(400)].map(x=>fn('random',lit(x)))),context:{},host:{randomSeed:7}});
  add('random-order',{operation:'evaluate',pureBuiltins:true,ast:fn('random',fn('random',lit('100')),write('after-first-random',lit('done'))),context:{},host:{randomSeed:7}});

  // Existing permission metadata defaults to level 1. Arguments execute before
  // both the gate and unknown-function boundary; no new source-only exclusion.
  for (const name of PURE_NAMES) {
    for (const [userLevel,enforceFunctionPermissions] of [[0,true],[1,true],[0,false],[8,true]]) add('permission-argument-order',{
      operation:'evaluate',pureBuiltins:true,ast:fn(name,setMemory('arg-1',lit('first')),setMemory('arg-2',fn('random',lit('10')))),context:{userLevel,enforceFunctionPermissions,eventData:{viewers:7}},host:{randomSeed:3}
    },name);
  }
  add('unknown-boundary',{operation:'evaluate',pureBuiltins:true,ast:fn('missing-pure',write('arg-before-unknown',lit('ran'))),context:{},host:{}},'same-existing-domain');

  // Lift literal-string inputs/expectations from the actual tests' AST. Tests are
  // source evidence only; imports and unrelated TTS helpers never execute.
  return {cases,parse,call,add};
}

async function appendActualTestCases(definitions) {
  const {parse,call,add} = definitions;
  for (const name of PURE_NAMES) {
    parse(`$(${name})`,{},`declared-${name}`);
    add('flags-independent',{...callInput(name,[]),contextBuiltins:true},name);
  }
  for (const source of ['$(slice - 2 - 1 abc)','$(slice - -2 abc)','$(upper \"hello world\")','$(user \"ignore symbols numbers\")','$(replace \"a a\" \"$&$$\" \"a a a a\")']) parse(source,{},'quoted-folding');
  for (const path of extraSources) {
    const text = await readFile(new URL(`../../../${path}`,import.meta.url),'utf8');
    const ast = ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
    const unavailable=Symbol('not a statically known test value');
    const staticValue=(node,seen=new Set())=>{
      if (!node) return unavailable;
      if (ts.isStringLiteral(node)) return node.text;
      if (ts.isNumericLiteral(node)) return Number(node.text);
      if (node.kind===ts.SyntaxKind.NullKeyword) return null;
      if (node.kind===ts.SyntaxKind.TrueKeyword) return true;
      if (node.kind===ts.SyntaxKind.FalseKeyword) return false;
      if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return node.operator===ts.SyntaxKind.MinusToken?-Number(node.operand.text):Number(node.operand.text);
      if (ts.isArrayLiteralExpression(node)) {
        const values=node.elements.map(element=>staticValue(element,seen));
        return values.includes(unavailable)?unavailable:values;
      }
      if (ts.isObjectLiteralExpression(node)) {
        const value={};
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property)) return unavailable;
          const key=ts.isIdentifier(property.name)||ts.isStringLiteral(property.name)?property.name.text:unavailable;
          const item=staticValue(property.initializer,seen);
          if (key===unavailable||item===unavailable) return unavailable;
          value[key]=item;
        }
        return value;
      }
      if (ts.isIdentifier(node)) {
        if (node.text==='undefined') return special('undefined');
        if (node.text==='NaN'||node.text==='Infinity') return special(node.text);
        // Resolve local const fixtures in the enclosing test body only. Never
        // execute a test helper, module import or expression to obtain data.
        for (let scope=node.parent;scope;scope=scope.parent) {
          if ((ts.isForOfStatement(scope)||ts.isForInStatement(scope))&&ts.isVariableDeclarationList(scope.initializer)&&scope.initializer.declarations.some(d=>d.name.getText(ast)===node.text)) return unavailable;
          if ((ts.isFunctionDeclaration(scope)||ts.isArrowFunction(scope)||ts.isFunctionExpression(scope))&&scope.parameters.some(parameter=>parameter.name.getText(ast)===node.text)) return unavailable;
          if (!ts.isBlock(scope)&&!ts.isSourceFile(scope)) continue;
          for (const statement of scope.statements) if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
              if (declaration.name.getText(ast)!==node.text) continue;
              if (!declaration.initializer||seen.has(declaration)) return unavailable;
              return staticValue(declaration.initializer,new Set([...seen,declaration]));
            }
          }
        }
      }
      return unavailable;
    };
    const testExpected=node=>{
      const awaited=ts.isAwaitExpression(node.parent)?node.parent:node;
      const parent=awaited.parent;
      if (ts.isCallExpression(parent)&&parent.expression.getText(ast)==='assert.equal'&&parent.arguments[0]===awaited&&ts.isStringLiteral(parent.arguments[1])) return parent.arguments[1].text;
      if (ts.isVariableDeclaration(parent)&&parent.initializer===awaited) {
        const binding=parent.name.getText(ast);
        for (let scope=parent.parent;scope;scope=scope.parent) if (ts.isBlock(scope)) {
          for (const statement of scope.statements) if (ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)) {
            const assertion=statement.expression;
            if (assertion.expression.getText(ast)==='assert.equal'&&assertion.arguments[0]?.getText(ast)===`${binding}.value`&&ts.isStringLiteral(assertion.arguments[1])) return assertion.arguments[1].text;
          }
          break;
        }
      }
      return undefined;
    };
    const visit = node=>{
      if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0])) {
        const callee = node.expression.getText(ast);
        if (['evaluateInput','render','renderAsChatter'].includes(callee)) {
          const source = node.arguments[0].text;
          // A nested TTS test is outside the explicitly selected pure modules.
          if (!source.includes('$(tts')) {
            let context={};
            let supported=true;
            if (callee==='renderAsChatter') {
              const chatter=staticValue(node.arguments[1]);
              const login=node.arguments[2]?staticValue(node.arguments[2]):'chatter_login';
              supported=typeof chatter==='string'&&typeof login==='string';
              if (supported) context.eventData={chatter_user_name:chatter,chatter_user_login:login};
            } else if (callee==='render') {
              const argument=node.arguments[1]?staticValue(node.arguments[1]):{};
              supported=argument!==unavailable;
              if (supported) context=path.endsWith('eventsub.test.ts')?{eventData:argument}:{
                userDisplayName:argument.displayName??'',userLogin:argument.login??'user_login',
                ...(argument.eventData===undefined?{}:{eventData:argument.eventData}),
                ...(argument.extraContext===undefined?{}:{extraContext:argument.extraContext})
              };
            }
            if (supported) parse(source,context,`${path.split('/').at(-1)}-${node.pos}`,testExpected(node));
          }
        }
      }
      ts.forEachChild(node,visit);
    };
    visit(ast);
  }
  // Seeded mixed composition, distinct from the explicit edge matrices above.
  let seed = 0x514e1c2d;
  const draw = n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/4294967296*n);};
  for (let i=0;i<192;i++) {
    const name=STRING_NAMES[draw(6)],value=textAtoms[draw(textAtoms.length)];
    call('seeded-mixed',name,[value,'',value],{userPlan:['free','premium','pro'][draw(3)]},{randomSeed:draw(0x100000000)},String(i));
  }
}

function benchmarkDefinitions() {
  const defs=[];
  const add=(id,description,name,args,context={},host={})=>defs.push({id,description,input:callInput(name,args,context,host),costs:{
    prepare:'Load/transpile selected actual source and prepare AST plus scalar baseline once outside timing.',
    evaluate:'Fresh context, fake host stores, ordered trace and seeded RNG per operation; actual registered source handler and evaluator. No normalization, serialization, assertions or checksum.',
    compile:'No parse/compile in timed operation.'
  }});
  const short='hello WORLD 0123 mixed words';
  const long=(short+' ').repeat(256);
  for (const [size,text] of [['short','😀ab𐐨cd'],['long',('😀ab𐐨cd').repeat(512)]]) {
    add(`utf16-length-${size}`,'Actual JS UTF16 string length','length',[text]);
    add(`utf16-slice-${size}`,'Slice through UTF16 code units','slice',['1','-1',text]);
  }
  for (const name of ['upper','lower','title','capitalize']) {
    for (const [size,text] of [['short',short],['long',long]]) add(`ascii-${name}-${size}`,`Actual ${name}, ${size} ASCII`,name,[text]);
    add(`unicode-${name}`,'Mixed Unicode casing, expansions, final sigma and supplementary letters',name,[('ß ﬁ İ ΣΟΣ 𐐨 😀 e\u0301\uFEFFnext\u0085TAIL ').repeat(16)]);
    add(`unicode-tail-${name}`,'Long ASCII prefix followed by Unicode tail',name,[long+' ß ﬁ İ ΣΟΣ 𐐨']);
  }
  add('replace-hit','Literal replace all hits','replace',['ab','$&$$',('ab'.repeat(16)+'x').repeat(128)]);
  add('replace-nohit','Literal replace no match','replace',['missing','x',long]);
  add('replace-prefix-adversarial','Repeated prefix mismatch without regex or rescan','replace',['a'.repeat(127)+'b','aa',('a'.repeat(256)+'c').repeat(32)]);
  add('touser-escaping','Escape string dollars percents stars','touser',[('a$%*b').repeat(256)]);
  add('user-filters-ascii','Actual user filter plan and scan','user',['ignore','symbols','numbers'],{eventData:{chatter_user_name:('Some_User123! ').repeat(256)}});
  add('user-filters-unicode','Unicode letter/mark/number filters','user',['ignore','symbols','numbers'],{eventData:{chatter_user_name:('Jose\u0301_Ⅻ٢𝟘𐐨😀 ').repeat(128)}});
  add('eventsub-normal','Normal subscription tier lookup','sub.tier',[],{eventData:{tier:'2000',is_prime:false,sub_plan_name:'Tier 2'}});
  add('eventsub-fallback-wide','Wide object with blank primary fields and later fallback','gifted.user',[],{eventData:{...Object.fromEntries(Array.from({length:256},(_,i)=>[`irrelevant${i}`,i])),recipient_user_name:' ',recipient_user_login:'',user_name:'\t',user_login:' fallback '}});
  add('rng-default','One seeded random draw with default max','random',[],{},{randomSeed:19});
  add('rng-negative','One seeded draw with negative decimal parseInt bound','random',['-100tail'],{},{randomSeed:19});
  assert(defs.length<=32);
  return defs;
}

function assertSourceFacts(cases) {
  const edge=label=>cases.find(c=>c.id.endsWith(`-${label}`));
  assert.deepEqual(edge('slice-high-half').source.value,{type:'string',utf16:[0xD83D]});
  assert.deepEqual(edge('slice-low-half').source.value,{type:'string',utf16:[0xDE00]});
  const events=c=>c.source.host.events.map(event=>event.value.map(v=>v.value));
  for (const c of cases) {
    if (c.invariant) assert.deepEqual(c.source.value,c.invariant,c.id);
    if (c.category==='ordinary-coercion-throws') {
      assert.deepEqual(c.source.error,{name:'TypeError',message:'Cannot convert object to primitive value'},c.id);
      assert.equal(c.source.outcome,'thrown',c.id);
      assert.equal(events(c).filter(e=>e[0]==='random').length,0,'coercion failure precedes random draw');
    }
    if (['ordinary-uncoerced-tail','ordinary-event-type-filter','ordinary-coercion-control'].includes(c.category)) assert.equal(c.source.outcome,'returned',c.id);
    if (c.input.operation==='parseEvaluate') assert.equal(c.source.outcome,'returned',`actual source test parser input: ${c.id}`);
    for (const event of events(c)) assert(!(event[0]==='handler' && PURE_NAMES.includes(event[1])),'actual source registrations must never emit fake pure handler events');
    if (c.category==='random') assert.equal(events(c).filter(e=>e[0]==='random').length,1,'exactly one draw including zero/negative/infinite bounds');
    if (c.category==='event-argument-effects') {
      assert.deepEqual(c.source.context.maps.variables,[['argument-first',{type:'string',value:'done'}]]);
      assert.equal(events(c).filter(e=>e[0]==='random').length,1);
    }
    if (c.category==='permission-argument-order') {
      assert.deepEqual(c.source.context.maps.variables[0],['arg-1',{type:'string',value:'first'}]);
      assert.equal(events(c).filter(e=>e[0]==='random').length,c.input.context.userLevel===0&&c.input.context.enforceFunctionPermissions?0:c.input.ast.name==='random'?2:1,'argument RNG runs before gate; source random draws only if admitted');
    }
  }
  const alias=cases.filter(c=>c.category==='event-redemption.input');
  const canonical=cases.filter(c=>c.category==='event-reward.input');
  assert.equal(alias.length,canonical.length);
  alias.forEach((c,i)=>assert.deepEqual(c.source,canonical[i].source,'actual alias facts match including context/trace'));
}

async function registryEvidence(bundle) {
  const plain=createPreparedSourceOracle(bundle.code,{registrations});
  const before=plain.getRegistryMetadata();
  assert(!before.some(entry=>PURE_NAMES.includes(entry.name)),'pure registrations must be opt-in');
  const withPure=createPreparedSourceOracle(bundle.code,{registrations,pureBuiltins:true});
  // Metadata is plain source data; copy its realm only, without projections.
  const entries=JSON.parse(JSON.stringify(withPure.getRegistryMetadata().filter(entry=>!before.some(old=>old.name===entry.name))));
  assert.deepEqual(entries.map(entry=>entry.name),PURE_NAMES,'all and only 27 actual names in source registration order');
  assert(!withPure.getRegistryMetadata().some(entry=>['randomuser','count','scount','bits'].includes(entry.name)));
  for (const {name,metadata} of entries) {
    assert(metadata && metadata.description && metadata.syntax && metadata.category && metadata.examples.length,`actual metadata for ${name}`);
    if (STRING_NAMES.includes(name)||EVENT_NAMES.includes(name)) assert.deepEqual(metadata.surfaces,['authoring']);
  }
  assert.equal(entries.find(e=>e.name==='redemption.input').metadata.aliasOf,'reward.input');
  assert.deepEqual(entries.find(e=>e.name==='redemption.input').metadata,{...entries.find(e=>e.name==='reward.input').metadata,aliasOf:'reward.input'});
  // The transport adapter has no registry-mutation input. Probe actual source
  // registration here; public API integration tests own matching native checks.
  for (const name of PURE_NAMES) for (const mode of ['inherit','deny','allow']) {
    const override={name,handler:'fixture.echo',...(mode==='inherit'?{}:{metadata:{description:'isolated fixture override',syntax:name,category:'fixture',examples:[],minUserLevel:7}})};
    const probe=createPreparedSourceOracle(bundle.code,{registrations,pureBuiltins:true,functionOverrides:[override]});
    const metadata=JSON.parse(JSON.stringify(probe.getRegistryMetadata().find(e=>e.name===name).metadata));
    assert.deepEqual(metadata,mode==='inherit'?entries.find(e=>e.name===name).metadata:override.metadata,'actual source override metadata inheritance');
    const input={...callInput(name),ast:fn(name,setMemory('arg-before-override',lit('raw')),lit('second')),context:{userLevel:mode==='allow'?7:1,enforceFunctionPermissions:true}};
    const observation=await probe.execute(input);
    assert.deepEqual(observation.context.maps.variables,[['arg-before-override',{type:'string',value:'raw'}]],'override arguments run before gate');
    if (mode==='deny') {assert.match(observation.value.value,/permission denied/);assert.deepEqual(observation.host.events,[]);}
    else {assert.deepEqual(observation.value,{type:'string',value:'|second'});assert.equal(observation.host.events[0].value[1].value,'fixture.echo');}
  }
  assert.deepEqual(JSON.parse(JSON.stringify(withPure.getRegistryMetadata().filter(e=>PURE_NAMES.includes(e.name)))),entries,'fresh oracle registry unaffected by override probes');
  return entries;
}

export async function buildCorpus() {
  assert.equal(sha256(await readFile(oldOutput)),'bd740c545bb9d220bab003130f4955dc58d9db1cce2832b45bc503fd0b569bf5','old evaluator corpus must remain byte-identical');
  const bundle=await sourceBundle();
  const registryMetadata=await registryEvidence(bundle);
  const oracle=createPreparedSourceOracle(bundle.code,{registrations});
  const definitions=caseDefinitions();
  await appendActualTestCases(definitions);
  assert(definitions.cases.length>=1000 && definitions.cases.length<=6000,`bounded source corpus: ${definitions.cases.length}`);
  const cases=[];
  for (const definition of definitions.cases) cases.push({...definition,source:await oracle.execute(definition.input)});
  assertSourceFacts(cases);
  const benchmarks=[];
  for (const definition of benchmarkDefinitions()) {
    const run=oracle.prepareBenchmark(definition);
    const source=oracle.normalizeObservation(await run());
    assert.equal(source.outcome,'returned',definition.id);
    assert.deepEqual(oracle.normalizeObservation(await run()),source,`fresh benchmark state: ${definition.id}`);
    benchmarks.push({...definition,source});
  }
  const jsonDepth=value=>value&&typeof value==='object'?1+Math.max(0,...Object.values(value).map(jsonDepth)):0;
  const maxInputDepth=Math.max(...[...cases,...benchmarks].map(c=>jsonDepth(c.input)));
  const maxObservationDepth=Math.max(...[...cases,...benchmarks].map(c=>jsonDepth(c.source)));
  assert(maxInputDepth<96&&maxObservationDepth<96,'plain-data corpus stays below serde_json default 128-level recursion guard');
  const categoryCounts={};
  for (const c of cases) categoryCounts[c.category]=(categoryCounts[c.category]??0)+1;
  return {schemaVersion:1,profile:'source-parity',sourceHashes:bundle.hashes,manifestHash:sha256(JSON.stringify({cases,benchmarks})),
    pureRegistry:registryMetadata,coverage:{caseCount:cases.length,benchmarkCount:benchmarks.length,declaredFunctions:PURE_NAMES,categoryCounts,serdeCompatibility:{maxInputDepth,maxObservationDepth,defaultRecursionLimit:128},sourceTestEvidence:{paths:extraSources,parsedInputs:cases.filter(c=>c.category==='parser'&&c.id.includes('.test.ts-')).length,assertedExpectedValues:cases.filter(c=>c.category==='parser'&&c.invariant).length},
      sourceOnlyBoundaries:[],limitations:[
        'Uses the existing plain-data AST domain. Unknown function dispatch remains the existing valid boundary; no new value exclusions.',
        'Only the ChatFunctions import, randomuserHandler and randomuser registration are AST-excluded from user.functions.ts; all pure source helpers/metadata/registrations are actual.',
        'Actual source test inputs and explicitly authored hand ASTs are evaluated offline. No TTS, network, production services, environment, clocks or IO handlers execute.',
        'Benchmarks contain untimed expected observations only. Lead owns the default 50 iterations / 20 warmup / 7 batches and performance decisions.'
      ],valueEncoding:'Full existing typed value/context/initialContext/ordered host trace. Unpaired UTF16 values use utf16 code-unit arrays; unpaired map/object keys use {utf16:[u16...]}. Inputs use $utf16/$value/$object transports.',
      runtimeBridge:'Generic buildSourceBundle/createPreparedSourceOracle/preparedSourceLoaderTransport exports reuse ast_evaluator_reference.mjs runtime and normalizer. Baseline corpus/hash guards unchanged. New pureBuiltins flag selects actual source registration modules; contextBuiltins remains independent.'},cases,benchmarks};
}

// Serialized source replay proves the artifact is self-contained and requires no
// TS compiler/source files at runtime. This executes no timed benchmark loop.
export async function verifyOfflineReplay(manifest) {
  const loader=await sourceLoaderTransport();
  const offline=await new Function(`return (${loader})()`)();
  for (const c of manifest.cases) assert.deepEqual(await offline.execute(c.input),c.source,`offline replay ${c.id}`);
  for (const definition of manifest.benchmarks) {
    const run=offline.prepareBenchmark(definition);
    for (let i=0;i<2;i++) assert.deepEqual(offline.normalizeObservation(await run()),definition.source,`offline fresh benchmark ${definition.id}`);
  }
}
async function main() {
  assert(process.argv.slice(2).every(arg=>arg==='--check'),'usage: ast_pure_reference.mjs [--check]');
  const manifest=await buildCorpus();
  const bytes=JSON.stringify(manifest)+'\n';
  assert(Buffer.byteLength(bytes)<=20*1024*1024,'bounded artifact <=20MiB');
  await verifyOfflineReplay(manifest);
  if (process.argv.includes('--check')) assert.equal(await readFile(output,'utf8'),bytes,'pure fixture drift; review actual source before regeneration');
  else await writeFile(output,bytes);
  console.log(JSON.stringify({mode:process.argv.includes('--check')?'checked':'generated',cases:manifest.cases.length,benchmarks:manifest.benchmarks.length,manifestHash:manifest.manifestHash,artifactSha256:sha256(bytes),bytes:Buffer.byteLength(bytes),offlineReplay:'all cases + fresh benchmark expectations passed'}));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) await main();
