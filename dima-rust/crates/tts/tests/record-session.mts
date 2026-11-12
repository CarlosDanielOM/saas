// Only disposable logical database 3 and unique task-owned keys; main checkout remains read-only.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const root='/home/dom/Projects/saas/dimabot/';
const {createClient}=createRequire(root+'package.json')('redis');
const {enqueueTtsSession,popTtsSession,resetTtsSession}=await import(pathToFileURL(root+'src/utils/tts/tts_session.util.ts').href);
const client=createClient({url:'redis://127.0.0.1:6379/3',socket:{connectTimeout:3000,reconnectStrategy:false}});
await client.connect();
const channel='test-tts-node-'+randomUUID(),prefix=`twitch:${channel}:tts:`;
try {
 await enqueueTtsSession(client,channel,'first',20,JSON.stringify({speechID:'first'}));
 await enqueueTtsSession(client,channel,'minimum',5,JSON.stringify({speechID:'minimum'}));
 const ttl=await client.ttl(prefix+'queue');
 const first=await popTtsSession(client,channel);
 await resetTtsSession(client,channel,'new-session',[]);
 const marker=await client.get(prefix+'session'),markerTtl=await client.ttl(prefix+'session');
 await enqueueTtsSession(client,channel,'first',1,JSON.stringify({speechID:'first'}));
 const next=await popTtsSession(client,channel);
 writeFileSync(process.argv[2],JSON.stringify({ttl,first:{...first,payload:JSON.parse(first.payload)},marker,markerTtl,next:{...next,payload:JSON.parse(next.payload)}}));
} finally {const keys=await client.keys(prefix+'*');if(keys.length)await client.del(keys);await client.quit();}
