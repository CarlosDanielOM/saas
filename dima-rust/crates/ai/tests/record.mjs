// Run from the main dimabot checkout with TZ=UTC node_modules/.bin/tsx <script> <output>.
// Real installed SDK, loopback only. Credentials recorded as presence, never values.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
const require=createRequire(process.cwd()+'/package.json');
const {QdrantClient}=require('@qdrant/qdrant-js');
const records=[];
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const b of req)chunks.push(b);
 const text=Buffer.concat(chunks).toString();
 records.push({method:req.method,target:req.url,headers:{'content-type':req.headers['content-type'],'api-key':Boolean(req.headers['api-key'])},body:text?JSON.parse(text):null});
 let result=req.url.endsWith('/exists')?{exists:false}:req.url.endsWith('/scroll')?{points:[],next_page_offset:null}:req.url.endsWith('/query')?{points:[]}:req.method==='POST'&&req.url.endsWith('/points')?[]:req.url==='/collections'?{collections:[]}:true;
 res.setHeader('content-type','application/json');res.end(JSON.stringify({result,status:'ok',time:0}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
 const c=new QdrantClient({url:`http://127.0.0.1:${server.address().port}`,apiKey:'test-only',checkCompatibility:false});
 await c.getCollections();await c.collectionExists('twitch_chat_logs');
 await c.createCollection('twitch_chat_logs',{vectors:{size:1024,distance:'Cosine',on_disk:true},quantization_config:{scalar:{type:'int8',quantile:.99,always_ram:true}}});
 for(const [field_name,field_schema] of [['message','text'],['timestamp','integer'],['confidence','float'],['channel_id','keyword']])await c.createPayloadIndex('twitch_chat_logs',{field_name,field_schema,tokenizer:'multilingual'});
 for(const wait of [false,true])await c.upsert('twitch_chat_logs',{wait,points:[{id:42,vector:[1,0,0],payload:{channel_id:'c',message:'hello',timestamp:12}}]});
 await c.retrieve('twitch_channel_memories',{ids:[42],with_payload:true,with_vector:false});
 await c.delete('twitch_channel_memories',{wait:true,points:[42]});
 await c.delete('twitch_channel_memories',{wait:true,filter:{must:[{key:'channel_id',match:{value:'c'}}]}});
 await c.query('twitch_chat_logs',{query:[1,0,0],limit:9,with_payload:true,filter:{must:[{key:'channel_id',match:{value:'c'}}]},score_threshold:.75});
 for(const offset of [undefined,42])await c.scroll('twitch_chat_logs',{filter:{must:[{key:'channel_id',match:{value:'c'}},{key:'timestamp',range:{gte:1,lte:20}}]},with_payload:true,with_vector:false,limit:120,offset});
 await writeFile(process.argv[2],JSON.stringify(records,null,2)+'\n');
}finally{await new Promise(r=>server.close(r));}
