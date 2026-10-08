import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const originalFetch = globalThis.fetch;
const path = '/tmp/saas-fixtures/polls.json';
const read = () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { polls: [], creates: 0 }; } };
const json = (data, status=200) => new Response(JSON.stringify(data), { status, headers:{'Content-Type':'application/json'} });
globalThis.fetch = async (input, options={}) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
 if (url.hostname === '127.0.0.1') return originalFetch(input,options);
 if (url.hostname === 'qdrant.test') return json(url.pathname === '/' ? {version:'1.18.0'} : {status:'ok',time:0,result:url.pathname.endsWith('/exists')?{exists:true}:{collections:[]}});
 if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/polls') {
  let store=read();const body=options.body?JSON.parse(options.body):null;
  if (options.method==='POST') {
   const countPath='/tmp/saas-fixtures/poll-posts.json';let posts=0;try{posts=JSON.parse(readFileSync(countPath,'utf8'));}catch{}writeFileSync(countPath,JSON.stringify(posts+1));
   if(existsSync('/tmp/saas-fixtures/delay-poll')) { await new Promise(resolve=>setTimeout(resolve,1200));store=read(); }

   if(existsSync('/tmp/saas-fixtures/fail-poll')) return json({error:'Forbidden',message:'Fixture poll permission missing'},403);
   if(store.polls.some(p=>p.broadcaster_id===body.broadcaster_id&&p.status==='ACTIVE')) return json({error:'Conflict',message:'A poll is already active'},409);
   const poll={id:'poll-'+ ++store.creates,title:body.title,broadcaster_id:body.broadcaster_id,broadcaster_login:'widgetfixture',status:'ACTIVE',channel_points_voting_enabled:body.channel_points_voting_enabled??false,channel_points_per_vote:body.channel_points_per_vote??0,choices:body.choices.map((c,i)=>({id:'choice-'+store.creates+'-'+i,title:c.title,votes:0,channel_points_votes:0}))};
   store.polls.unshift(poll);writeFileSync(path,JSON.stringify(store));return json({data:[poll]});
  }
  if(options.method==='PATCH'){const poll=store.polls.find(p=>p.id===body.id);if(!poll)return json({error:'Not found',message:'Missing poll'},404);poll.status=body.status;writeFileSync(path,JSON.stringify(store));return json({data:[poll]});}
  return json({data:store.polls.filter(p=>p.broadcaster_id===url.searchParams.get('broadcaster_id')&&(!url.searchParams.get('id')||p.id===url.searchParams.get('id')))});
 }
 if(url.hostname==='api.twitch.tv'&&url.pathname==='/helix/users')return json({data:[]});
 throw new Error('External request blocked in widget test: '+url.origin+url.pathname);
};
