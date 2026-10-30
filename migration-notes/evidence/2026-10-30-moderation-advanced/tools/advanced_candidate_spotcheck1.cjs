'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const lib=require('/source/dimabot/tests/fixtures/moderation_advanced_source.cjs');
const api=lib.realm({}).api;
const pattern={id:'dog',source:'dog',boundary:'anywhere',ignoreCase:true};
const rows=[];
for(const terms of [[],[' \t']]) for(const text of ['\ud800dog','\ud800dog!']) {
 const result=api.findBlacklistMatches(text,terms,[pattern]);
 rows.push({units:Array.from({length:text.length},(_,i)=>text.charCodeAt(i)),terms,result});
 assert.equal(result.length,text.endsWith('!')?1:0);
 if(result.length) assert.deepEqual(result[0],{matcherID:'dog',text:'dog',start:1,end:4});
}
const bytes=Buffer.from(JSON.stringify({sourcePins:lib.pins,runtime:lib.re2Runtime,rows},null,2)+'\n');
fs.writeFileSync('/artifacts/moderation-advanced/candidate-spotcheck1.json',bytes,{flag:'wx'});
console.log(JSON.stringify({cases:rows.length,sha256:lib.sha(bytes),passed:true}));
