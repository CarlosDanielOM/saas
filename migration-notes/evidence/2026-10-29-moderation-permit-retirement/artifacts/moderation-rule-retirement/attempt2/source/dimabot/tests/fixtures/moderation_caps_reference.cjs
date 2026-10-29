'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const lib = require('./moderation_caps_source.cjs');
const {evaluateCapsRule, stripEmoteTexts} = lib.exports;
const fromBits = bits => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt('0x'+bits)); return b.readDoubleBE(); };
const toBits = n => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b.readBigUInt64BE().toString(16).padStart(16,'0'); };
const units = s => Array.from({length:s.length}, (_,i) => s.charCodeAt(i));
const str = a => String.fromCharCode(...a);
const cases = [];
function add(id, text, emotes = null, mode = 'count', min = 0, max = 50, length = 0) {
  const rule = {capsThresholdMode:mode, minCapsCount:min, maxCapsPercentage:max, minMessageLength:length};
  const textKind = text === undefined ? 'missing' : text === null ? 'null' : 'string';
  const input = {...(textKind === 'missing' ? {} : {text}), ...(emotes === null ? {} : {emoteTexts:emotes})};
  const result = evaluateCapsRule(rule,input), stripped = stripEmoteTexts(text ?? '',emotes === null ? undefined : emotes);
  cases.push({id, textKind, text:textKind === 'string' ? units(text) : null, emotes:emotes === null ? null : emotes.map(units), mode, min:toBits(min), max:toBits(max), length:toBits(length), stripped:units(stripped), triggered:result.triggered, capsCount:result.capsCount, letterCount:result.letterCount, percentage:toBits(result.capsPercentage), wire:JSON.stringify(result)});
}
for (let cp=0; cp<128; cp++) add(`ascii-${cp}`,String.fromCodePoint(cp));
for (const [name, table] of [['L',lib.unicode.LETTER],['Lu',lib.unicode.UPPERCASE_LETTER]]) {
  const seen = new Set();
  for (const [a,b] of table.ranges) for (const cp of [a-1,a,a+1,b-1,b,b+1]) if (cp>=0 && cp<=0x10ffff && !seen.has(cp)) { seen.add(cp); add(`${name}-${cp.toString(16)}`,String.fromCodePoint(cp)); }
}
for (const [id,text,emotes] of [
  ['unicode','AαΩ漢ǅʰe\u0301𐐀𐐨😀',null], ['empty','',[]], ['overlap','aaaaa',['aa']], ['order1','AB BA',['A','B']], ['order2','AB BA',['AB','A']], ['literal','$&.*[\\]$&',['$&','.*','[\\]']], ['spaces','A B A',[' ','A']], ['surrogates',str([0xd83d,0xde00,0xd800,65,0xdc00]),[str([0xd83d]),str([0xdc00])]], ['pair',str([0xd800,0xdc00,0xd800]),[str([0xd800,0xdc00])]], ['cross',str([65,0xd800,66,0xdc00]),[str([0xd800,66])]], ['skip','Aa',['','Z']],
]) add(id,text,emotes);
// Deliberately exercise the source's explicit runtime nullish fallback.
for (const [kind,text] of [['missing',undefined],['null',null]]) {
  for (const mode of ['count','percentage']) {
    add(`nullish-${kind}-${mode}-zero`,text,null,mode,0,0,0);
    add(`nullish-${kind}-${mode}-guarded`,text,['A',''],mode,8,70,5);
  }
}
const vals = ['0000000000000000','8000000000000000','0000000000000001','8000000000000001','3ff0000000000000','4000000000000000','4059000000000000','7fefffffffffffff','7ff0000000000000','fff0000000000000','7ff8000000000000'].map(fromBits);
for (const mode of ['count','percentage']) for (const text of ['','A','Aa','ABc','!!!']) for (const value of vals) {
  add(`threshold-${mode}-${text}-${toBits(value)}`,text,null,mode,value,value,0);
  add(`length-${mode}-${text}-${toBits(value)}`,text,null,mode,1,50,value);
}
for (const text of ['ABC','ABc','Abc','aBCdefg']) {
  const actual = evaluateCapsRule({capsThresholdMode:'percentage',minCapsCount:0,maxCapsPercentage:0,minMessageLength:0},{text}).capsPercentage;
  const bits = BigInt('0x'+toBits(actual));
  for (const delta of [-1n,0n,1n]) add(`boundary-${text}-${delta}`,text,null,'percentage',0,fromBits((bits+delta).toString(16).padStart(16,'0')),0);
}
// Prepared benchmark cases are also source-oracle validated before timing.
for (const [id,text,emotes,mode,min,max,length] of [
  ['bench-ascii','HELLO chat this is A NORMAL message 123',null,'count',8,70,5],
  ['bench-unicode','Ωmega Καλημέρα 漢字 ǅ ʰ e\u0301',null,'percentage',5,50,3],
  ['bench-astral','𐐀𐐨😀 🐱 𐐀AbC',null,'percentage',4,60,1],
  ['bench-emotes','KAPPA HELLO PogChamp world KAPPA',['KAPPA','PogChamp'],'count',3,70,3],
  ['bench-lone',str([65,0xd800,66,0xdc00,67]),[str([0xd800])],'count',2,50,1],
  ['bench-long',('THIS is a Long Message Ω漢𐐀 KAPPA '.repeat(100)),['KAPPA'],'percentage',6,40,5],
  ['bench-no-emotes','hello quiet lowercase 123',[],'count',8,70,5],
  ['bench-overlap','ABABABAABABABA',['ABA','BA'],'percentage',1,20,0],
]) add(id,text,emotes,mode,min,max,length);
const metadata = {format:1, versions:{node:process.versions.node,v8:process.versions.v8,icu:process.versions.icu,unicode:process.versions.unicode,typescript:'5.9.3'}, nodeSha:lib.nodePin, pins:lib.pins, hashes:lib.hashes, compiledSha:lib.compiledSha, unicodeReferenceSha:lib.unicodeSha, sourceResolution:lib.sourceResolution, fields:lib.fields, alias:lib.alias, total:cases.length};
const output = JSON.stringify({metadata,cases},null,2)+'\n';
const [mode,dir,...extra]=process.argv.slice(2);
assert(['--write','--check'].includes(mode) && dir && path.isAbsolute(dir) && extra.length===0,'usage: --write|--check ABSOLUTE_EXTERNAL_DIR');
const real = fs.realpathSync(dir), workspace = fs.realpathSync(path.join(lib.root,'..'));
assert(real!==workspace && !real.startsWith(workspace+path.sep));
const file=path.join(real,'moderation_caps_reference.json');
assert.deepEqual(fs.readdirSync(real),mode==='--write'?[]:['moderation_caps_reference.json']);
if (mode==='--write') fs.writeFileSync(file,output,{flag:'wx'}); else assert.equal(fs.readFileSync(file,'utf8'),output);
