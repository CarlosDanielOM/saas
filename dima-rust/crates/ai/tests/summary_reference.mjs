import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {STREAM_SUMMARY_JSON_SCHEMA,parseStreamSummaryResponse,sanitizeStreamSummaryResponse}=await import(pathToFileURL(process.cwd()+'/src/utils/ai/memory/stream_summary_schema.ts'));
const valid={summary:{headline:'Stream summary for test_channel',recap:'A great stream with lots of chat engagement.',highlights:['First highlight','Second highlight']},actions:[{action:'create',type:'channel_lore',confidence:0.85,risk:'low'},{action:'archive',type:'preference',targetMemoryId:'mem_abc123',confidence:0.9}]};
const cases=[];
const add=raw=>cases.push({raw,expected:parseStreamSummaryResponse(raw)});
for(const v of [valid,{summary:{headline:'OK',recap:'A recap.',highlights:[]},actions:[]},{actions:[]},[],null]) add(JSON.stringify(v));
for(const raw of ['', '```json\n'+JSON.stringify(valid)+'\n```','```\n'+JSON.stringify(valid)+'\n```','{"summary":{"headline":']) add(raw);
for(const patch of [{action:'Create'},{action:'merge'},{confidence:1.5},{confidence:-0.5},{risk:'extreme'}]) add(JSON.stringify({...valid,actions:[{...valid.actions[0],...patch}]}));
for(const headline of [12345,'','😀'.repeat(120),'x'.repeat(120),'x'.repeat(121)]) add(JSON.stringify({...valid,summary:{...valid.summary,headline}}));
const sanitized=[];
for(const v of [{summary:{headline:'H',recap:'R',highlights:['h1']},actions:[{action:'create'}]},{summary:{headline:'H',recap:'R',highlights:[]},actions:[{action:'create',type:'',confidence:5,risk:'low'},{action:'create',type:'',confidence:-2,risk:'low'}]},{summary:{headline:'H',recap:'R',highlights:['a','','b','c','d','e','f','g','h','i']},actions:[]},{summary:{headline:'',recap:'',highlights:[]},actions:[]}]) {const fallback={defaultHeadline:'FB HEADLINE',defaultRecap:'FB RECAP'};sanitized.push({input:v,fallback,expected:sanitizeStreamSummaryResponse(v,fallback)});}
await writeFile(process.argv[2],JSON.stringify({cases,sanitized},null,2)+'\n');await writeFile(process.argv[3],JSON.stringify(STREAM_SUMMARY_JSON_SCHEMA,null,2)+'\n');console.log(cases.length+' parser, '+sanitized.length+' sanitizer cases');
