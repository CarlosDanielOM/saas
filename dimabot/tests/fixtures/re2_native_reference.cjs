'use strict';
// Independent direct node-re2 syntax oracle. No expected outcomes are authored here.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const lib=require('./moderation_advanced_source.cjs');
assert.equal(lib.re2Runtime.kind,'node24-fixture');
assert.equal(lib.re2Runtime.sourceFileCount,1762);
const units=s=>Array.from({length:s.length},(_,i)=>s.charCodeAt(i));
const cases=[],counts={};
function add(category,source,text,ignoreCase=false){
  assert(source.length<=250,`pattern too long: ${category}`);
  assert(text.length<=32,`text too long: ${category}`);
  let re;
  try { re=new lib.RE2(source,ignoreCase?'diu':'du'); }
  catch(e) { re=null; }
  const m=re===null?null:re.exec(text);
  const result=re===null?{compiled:false}:{compiled:true,match:m===null?null:{index:m.index,captures:Array.from(m,x=>x===undefined?null:units(x)),indices:Array.from(m.indices,x=>x===undefined?null:Array.from(x))}};
  cases.push({category,source:units(source),text:units(text),ignoreCase,result});
  counts[category]=(counts[category]||0)+1;
}
function matrix(category,patterns,texts,flags=[false,true]){
  for(const pattern of patterns)for(const text of texts)for(const flag of flags)add(category,pattern,text,flag);
}
const basic=['','a','A','ab','a\nb','\n','\r\n',' ','\0','😀','\ud800','\udc00','\ufffd'];
matrix('literals-escapes',[
 'a','A','.', '\\.', '\\*','\\+','\\?','\\(','\\)','\\[','\\]','\\{','\\}','\\|','\\^','\\$','\\\\',
 '\\x41','\\x{41}','\\x{1F600}','\\u0041','\\u{41}','\\u{1F600}','\\101','\\0','\\00','\\000','\\377','\\400',
 '\\a','\\f','\\n','\\r','\\t','\\v','\\cA','\\Q.a*\\E','\\Qabc','\\E','\\-','\\_','\\/','\\ ', '\0','\n','😀'
],basic);
matrix('case-folds',['k','K','K','s','S','ſ','Σ','σ','ς','\u0264','\ua7cb','[k]','[^k]','[Σ]','(?i:k)','(?i:Σ)'],['k','K','K','s','S','ſ','Σ','σ','ς','\u0264','\ua7cb','x']);
matrix('classes',[
 '\\d','\\D','\\s','\\S','\\w','\\W','[\\d]','[^\\d]','[\\D]','[\\s\\S]',
 '[[:alpha:]]','[[:^alpha:]]','[[:digit:]]','[[:word:]]','[[:space:]]','[[:ascii:]]','[[:bogus:]]',
 '[]','[^]','[]a]','[^]a]','[[]','[a[b]','[a&&b]','[a--b]','[a~~b]','[a||b]','[a-z]','[z-a]','[-a]','[a-]','[a\\-z]'
],['','a','b','A','1','_',' ','\n',']','[','-','&','é','😀']);
matrix('properties',[
 '\\pL','\\PL','\\p{L}','\\P{L}','\\p{Letter}','\\p{Lu}','\\p{Greek}','\\p{Greek_Extended}',
 '\\p{Script=Greek}','\\p{General_Category=Letter}','\\p{Any}','\\p{ASCII}','\\p{Emoji}','\\p{Tolong_Siki}',
 '[\\p{L}]','[^\\p{L}]','[\\P{L}]','[\\p{Greek}a]','\\p{}','\\p{bogus}','\\p','\\P'
],['A','a','1','Σ','ς','é','😀','\u{11db0}','\ud800']);
matrix('inline-flags',[
 '(?i)a','(?i:a)b','(?i:a(?-i:b)c)','(?i)a(?-i)b','(?-i:a)','(?m)^a$','(?s).','(?U)a+','(?U:a+)',
 '(?im-s:a.)','(?i-m:a)','(?u:a)','(?x:a)','(?-u:a)','(?i)','(?i-i:a)','(?z:a)','(?i:a','(?i::a)'
],['a','A','Ab','AB','a\nb','\n','aaa','x\na\ny']);
matrix('anchors-boundaries',['^a$','a$','a\\z','\\Aa','\\Z','\\b','\\B','\\ba\\b','\\bΣ\\b','(?m)^a$','(?m)a$'],['a','a\n','a\r\n','ba',' a ','Σ','a_','\na\n','']);
matrix('groups-alternation',[
 '(a)(b)','(?:a)(b)','(?<name>a)','(?P<name>a)','(?\'name\'a)','(?<1>a)','(?<a-b>a)','(?<x>a)(?<x>b)',
 '((a)?)b','a|ab','ab|a','(a|ab)','(ab|a)','a|','|a','(?:)','(?=a)','(?!a)','(?<=a)','(?<!a)','(a)\\1','\\k<x>','(a)\\g1'
],['','a','ab','b','aa','xab']);
matrix('quantifiers',[
 'a?','a*','a+','a??','a*?','a+?','a{0}','a{1}','a{0,1}','a{1,}','a{2,3}','a{1000}','a{1001}',
 'a{0,1000}','a{0,1001}','a{1001,}','a{2,1}','a{}','a{,1}','a{01}','a**','a++','a*+','a?+','a{1}*','*a','{1}a'
],['','a','aa','aaa','baaa']);
matrix('malformed',['\\','\\x','\\x0','\\x{','\\x{}','\\x{110000}','\\u','\\u1','\\u{','\\u{}','\\8','\\9','[','[^','[a','[a-','[\\','(',')','(?:','(?','(?<x','(?P<x>','a{','a{1','\\p{'],['','a','😀']);
matrix('surrogates',[
 '\ud800','\udc00','[\ud800]','[^\ud800]','[\udc00]','[a-\ud800]','[\ud800-z]','[\ud800-\udc00]',
 '\\uD800','\\uDC00','[\\uD800]','[a-\\uD800]','[\\uD800-z]','\\x{D800}','[\\x{D800}]',
 '(\ud800)','\ud800\udc00','[\ud800\udc00]'
],['','\ud800','\udc00','\ud800\udc00','\ufffd','a','😀','x\ud800y']);
assert(cases.length>=2000&&cases.length<=5000,`case budget ${cases.length}`);
const metadata={format:1,node:{version:process.versions.node,abi:process.versions.modules,sha256:lib.nodeSha},runtime:lib.re2Runtime,pins:lib.pins,compiled:lib.compiled,loaderSha256:lib.sha(fs.readFileSync(require.resolve('./moderation_advanced_source.cjs'))),readerSha256:lib.sha(fs.readFileSync(__filename)),counts,total:cases.length};
const bytes=Buffer.from(JSON.stringify({metadata,cases})+'\n');
assert(bytes.length<=8*1024*1024,'fixture exceeds byte budget');
const [mode,dir,...extra]=process.argv.slice(2);
assert(['--write','--check'].includes(mode)&&dir&&!extra.length,'usage: --write|--check EXTERNAL_DIR');
assert(path.isAbsolute(dir),'directory must be absolute');
const canonical=fs.realpathSync(dir),root=fs.realpathSync(lib.root);
assert(canonical!==root&&!canonical.startsWith(root+path.sep),'directory must be outside source tree');
const file=path.join(canonical,'re2-native-syntax.json');
if(mode==='--write'){
  assert.deepEqual(fs.readdirSync(canonical),[],'write directory must be empty');
  fs.writeFileSync(file,bytes,{flag:'wx'});
}else assert.deepEqual(fs.readFileSync(file),bytes,'reference differs');
process.stdout.write(JSON.stringify({file,sha256:lib.sha(bytes),bytes:bytes.length,total:cases.length,counts})+'\n');
