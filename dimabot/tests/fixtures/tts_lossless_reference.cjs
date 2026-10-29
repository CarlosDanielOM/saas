// Run in the isolated, pinned fixture environment: --write DIR or --check DIR.
const fs = require('node:fs');
const path = require('node:path');
const {loadSources} = require('./tts_lossless_source.cjs');
const units = s => Array.from({length:s.length}, (_,i) => s.charCodeAt(i));
const snap = r => ({error:r.error,message:r.message,text:units(r.text),originalText:units(r.originalText)});
function makeFixture() {
  const {normalizer:n,pet,expressive,creditFallback,provenance,metadata} = loadSources();
  const cases = [];
  let id = 0;
  const add = (op, body) => cases.push({id:`${op}-${++id}`,op,...body});
  const maxes = [0,-1,0.5,1,2,2.5,3,4,5,NaN,Infinity,-Infinity];
  const texts = [
    '', '  \t\n', '\ud800', '\udc00', '😀', '\ud800\ud800\udc00\udc00',
    ' Kappa  Kappa \ud800 \udc00 😀 ', '\ud800a.com/\udc00 \ud801',
    'a\ud800.com x.com/\udc00 foo\ud800bar', '😀a.com/\ud800 [happy]',
    'x\0\u0001\u0008\u000b\u000c\u000e\u001f\u007f y',
    'a\u0085b\u180ec\ufeffd', '[happy] a.com [sad]',
  ];
  const names = ['',' ',' Kappa ','Kappa','\ud800','\udc00','😀','\ud800\ud800','foo\ud800bar'];
  for (const text of texts) for (const skip of [false,true]) for (const stripLinks of [false,true]) for (const normalizeWhitespace of [false,true]) for (const maxLength of maxes) {
    const options = {skipEmotes:skip,stripLinks,normalizeWhitespace,maxLength,emoteNames:names};
    add('normalize',{input:units(text),emotes:names.map(units),skip,stripLinks,normalizeWhitespace,maxLength:String(maxLength),expected:snap(n.normalizeTtsMessage(text,options))});
  }
  // All ECMAScript whitespace, including preserved non-whitespace near misses.
  for (const code of [...Array.from({length:32},(_,i)=>i),0x7f,32,0xa0,0x1680,...Array.from({length:11},(_,i)=>0x2000+i),0x2028,0x2029,0x202f,0x205f,0x3000,0xfeff,0x85,0x180e]) {
    const text = `\ud800${String.fromCharCode(code)}Kappa${String.fromCharCode(code)}\udc00`;
    const options = {skipEmotes:true,stripLinks:false,normalizeWhitespace:true,maxLength:100,emoteNames:names};
    add('normalize',{input:units(text),emotes:names.map(units),skip:true,stripLinks:false,normalizeWhitespace:true,maxLength:'100',expected:snap(n.normalizeTtsMessage(text,options))});
  }
  const entries = [
    ['later',['0-0','3-7','0-0']],['10',['8-9','1-2']],['2',['3-7','0-0']],['first',['0-0','3-7']],
  ];
  const extractInputs = ['', '😀 Kappa \ud800 \udc00 Kappa', '\ud800\udc00\ud800abc\udc00'];
  const invalid = ['', '-', '+-0', '-1-2', '1--2', '+0-+1', '  1tail-3suffix', '0-0-extra', 'NaN-1','Infinity-1',
    '9007199254740991-9007199254740992','9007199254740993-9007199254740994', `${'9'.repeat(400)}-1`, `0-${'9'.repeat(400)}`,
    '0-0\ud800','\ud8000-1','2-1','0-99999999999999999999'];
  for (const text of extractInputs) for (const [label,pairs] of [['ordering',entries],['malformed',[['z',invalid],['1',['0-0','0-0']],['a',['1-1','2-2']]]],['empty',[]]]) {
    const obj = Object.fromEntries(pairs);
    add('extract',{label,input:units(text),groups:Object.values(obj).map(g=>g.map(units)),expected:n.extractEmoteNames(text,obj).map(units)});
  }
  for (const user of ['', '  \t\ufeff ', ' Viewer ', '\ud800', 'x\udc00']) for (const message of ['', 'hello', '\ud800😀\udc00']) for (const language of ['en','es']) for (const source of ['default','chat-command','ast','redemption']) {
    const args = [user,message,language]; if (source !== 'default') args.push(source);
    add('spoken',{user:units(user),input:units(message),language,source,expected:units(n.buildSpokenUserMessage(...args))});
  }
  const settings = [
    ['missing',undefined], ['null','null'], ['malformed','{"happy":"yes","sad":false,"inline":{"happy":true}}'],
    ['duplicates','{"happy":false,"happy":true,"sad":false,"x":"\\ud800"}'],
    ['array','[true,false]'], ['scalar','42'], ['string','"happy"'],
    ['normalized',JSON.stringify(expressive.normalizeExpressiveTtsTags({happy:true,sad:false}))],
  ];
  const petTexts = [' Kappa  [happy] Hi example.com [sad]  there ', 'Kappa example.com [happy]',
    'abcdefghijklmnopqrstuvwxyz 123456789', 'Kappa\nexample.com', 'Kappa [sad]',
    '[happy] a.com/\ud800 [sad] \udc00', '[link] example.com'];
  for (const [setting,tagsJson] of settings) for (const provider of ['fish','piper','kokoro']) for (const text of petTexts) for (const disabled of [false,true]) {
    const filters = {skipEmotes:!disabled,stripLinks:!disabled,normalizeWhitespace:!disabled,maxLength:disabled?500:30};
    if (tagsJson !== undefined) filters.expressiveTags = JSON.parse(tagsJson);
    const emotes = ['Kappa','\ud800'];
    add('pet',{setting,tagsJson:tagsJson ?? null,provider,input:units(text),emotes:emotes.map(units),skip:filters.skipEmotes,stripLinks:filters.stripLinks,normalizeWhitespace:filters.normalizeWhitespace,maxLength:String(filters.maxLength),expected:snap(pet.filterPetTalkText(text,provider,filters,emotes))});
  }
  // The captured test passes the fallback's effective provider to the helper.
  for (const status of ['available','unavailable','exhausted']) for (const tier of ['free','pro']) {
    const text = '[happy] visit example.com';
    const resolved = creditFallback.resolveTtsForCreditStatus({mode:'speak',provider:'fish',text,language:'en',voice:'test'},status,tier);
    const tagsJson = JSON.stringify(expressive.normalizeExpressiveTtsTags({happy:true,sad:false}));
    const filters = {skipEmotes:true,stripLinks:true,normalizeWhitespace:true,maxLength:30,expressiveTags:JSON.parse(tagsJson)};
    add('pet',{setting:'actual-credit-fallback',status,tier,provider:resolved.provider,input:units(text),emotes:[],skip:true,stripLinks:true,normalizeWhitespace:true,maxLength:'30',tagsJson,expected:snap(pet.filterPetTalkText(text,resolved.provider,filters,[]))});
  }
  return {schema:2,provenance,metadata,cases};
}
function main() {
  const [mode,dir,...extra] = process.argv.slice(2);
  if (!['--write','--check'].includes(mode) || !dir || extra.length) throw Error('usage: --write DIR | --check DIR');
  const output = JSON.stringify(makeFixture(),null,2)+'\n';
  const dest = path.join(dir,'tts_lossless_cases.json');
  if (mode === '--write') { fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(dest,output); }
  else if (fs.readFileSync(dest,'utf8') !== output) throw Error('fixture differs');
}
if (require.main === module) main();
module.exports = {makeFixture};
