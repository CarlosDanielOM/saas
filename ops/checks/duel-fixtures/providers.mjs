import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
const original=globalThis.fetch,root='/tmp/saas-fixtures/';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const read=()=>{try{return JSON.parse(readFileSync(root+'mods.json','utf8'));}catch{return [];}};
globalThis.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url),method=options.method??'GET';
 if(url.hostname==='127.0.0.1')return original(input,options);
 if(url.hostname==='qdrant.test')return json(url.pathname==='/'?{version:'1.18.0'}:{status:'ok',time:0,result:url.pathname.endsWith('/exists')?{exists:true}:{collections:[]}});
 if(url.hostname==='api.twitch.tv'){
  const body=options.body?JSON.parse(options.body):null;
  appendFileSync(root+'calls.jsonl',JSON.stringify({path:url.pathname,query:Object.fromEntries(url.searchParams),method,body,at:Date.now()})+'\n');
  if(url.pathname==='/helix/users'){const login=url.searchParams.get('login');return json({data:login?[{id:login==='alice'?'991811':'991812',login,display_name:login}]:[]});}
  if(url.pathname==='/helix/chat/messages')return json({data:[{is_sent:true,message_id:crypto.randomUUID()}]});
  if(url.pathname==='/helix/moderation/moderators'){
   const user=url.searchParams.get('user_id'),mods=read();
   if(method==='GET')return json({data:mods.filter(id=>!user||id===user).map(id=>({user_id:id,user_login:id==='991811'?'alice':'bob',user_name:'Fixture'}))});
   if(method==='DELETE'){if(!options.signal)throw new Error('Duel moderator removal must be bounded');writeFileSync(root+'mods.json',JSON.stringify(mods.filter(id=>id!==user)));if(existsSync(root+'fail-remove-response'))return json({error:'Unavailable',message:'Fixture lost demotion response'},503);}
   if(method==='POST')writeFileSync(root+'mods.json',JSON.stringify([...new Set([...mods,user])]));
   return new Response(null,{status:204});
  }
  if(url.pathname==='/helix/moderation/bans'){if(existsSync(root+'fail-ban'))return json({error:'Forbidden',message:'Fixture missing permission'},403);return json({data:[{broadcaster_id:url.searchParams.get('broadcaster_id'),user_id:body.data.user_id}]});}
 }
 throw new Error('External request blocked in duel test: '+url.origin+url.pathname);
};
