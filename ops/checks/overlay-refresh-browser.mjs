import assert from 'node:assert/strict';
import { chromium } from '/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs';
const base=process.env.SAAS_PREVIEW_URL;assert(base);const publicId='d'.repeat(48), ns='/overlay-studio/'+publicId;
const browser=await chromium.launch({args:['--no-sandbox']});
try {
 const context=await browser.newContext();let sockets=[],requests=[],ended=[];const errors=[];
 const layer={id:'text',kind:'text',x:0,y:0,width:800,height:240,visible:true,locked:false,text:'Recovery test'};
 const snapshot={width:1920,height:1080,waitFor:['follow'],widgets:[{...layer,id:'alert',kind:'alert',designId:'design',events:['follow']}],designs:[{id:'design',width:800,height:240}]};
 const send=(socket,name,data)=>socket.ws.send(`42${ns},${JSON.stringify([name,data])}`);
 await context.routeWebSocket('**/*',ws=>{
  if(!ws.url().includes('/socket.io/'))return ws.close();const socket={ws,clientId:null};sockets.push(socket);
  ws.send('0{"sid":"refresh","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');
  ws.onMessage(message=>{const m=String(message);if(m.startsWith('40'+ns)){socket.clientId=JSON.parse(m.slice(m.indexOf(',')+1)).clientId;ws.send(`40${ns},{"sid":"refresh"}`);send(socket,'overlay-state',{revision:1,snapshot,controls:{revision:1,all:false,platforms:{}}});}
   if(m.startsWith('42'+ns)){const [name,data]=JSON.parse(m.slice(m.indexOf(',')+1));if(name==='overlay-ended')ended.push(data);}
  });
 });
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===new URL(base).origin)return route.continue();if(url.pathname.includes('/events/')){const id=url.pathname.split('/').at(-1);requests.push(id);return route.fulfill({json:{data:{id,kind:'follow',snapshot,layouts:{design:{duration:.05,widgets:[layer]}}}}});}return route.abort();});
 const until=async fn=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timeout');};
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/overlays/'+publicId);await until(()=>sockets[0]?.clientId);
 const initial=sockets[0].clientId;send(sockets[0],'overlay-event',{id:'completed',kind:'follow'});await until(()=>ended.includes('completed'));
 const stored=await page.evaluate(key=>sessionStorage.getItem(key),'overlay-playback:'+publicId);assert(JSON.parse(stored).completed.includes('completed'));
 await page.reload();await until(()=>sockets[1]?.clientId);assert.equal(sockets[1].clientId,initial);
 send(sockets[1],'overlay-event',{id:'completed',kind:'follow'});await until(()=>ended.filter(id=>id==='completed').length===2);assert.equal(requests.filter(id=>id==='completed').length,1,'refresh does not replay completed event');
 // New pending item after refresh still plays.
 send(sockets[1],'overlay-event',{id:'pending',kind:'follow'});await until(()=>ended.includes('pending'));
 // Simulate duplicated-tab session storage: both sources must remain independent.
 const duplicate=await context.newPage();await duplicate.addInitScript(({key,stored})=>sessionStorage.setItem(key,stored),{key:'overlay-playback:'+publicId,stored});await duplicate.goto(base+'/overlays/'+publicId);await until(()=>sockets[2]?.clientId);assert.notEqual(sockets[2].clientId,initial);
 // Thousands of receipts cannot accumulate indefinitely in a long-running source.
 send(sockets[1],'overlay-expired',Array.from({length:1500},(_,i)=>'expired-'+i));
 await until(async()=>JSON.parse(await page.evaluate(key=>sessionStorage.getItem(key),'overlay-playback:'+publicId)).completed.includes('expired-1499'));
 assert.equal(JSON.parse(await page.evaluate(key=>sessionStorage.getItem(key),'overlay-playback:'+publicId)).completed.length,512);
 assert.deepEqual(errors,[]);await context.close();console.log('PASS refresh identity, completed receipts, pending playback, independent duplicated sources and bounded long-session receipt storage');
} finally {await browser.close();}
