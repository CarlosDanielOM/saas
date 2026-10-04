// The production renderer, with public events/socket/assets mocked.
import assert from 'node:assert/strict';
const {chromium}=await import('/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base=process.env.SAAS_PREVIEW_URL;assert(base);
const browser=await chromium.launch({args:['--no-sandbox']});const errors=[];
const publicId='d'.repeat(48),shape={id:'shape',kind:'shape',x:0,y:0,width:400,height:200,visible:true,locked:false,shape:'rectangle',color:'#123456',borderColor:'#ffffff',borderWidth:4,radius:20,opacity:.6,shadow:{color:'#000000',blur:12,x:3,y:5}};
const text={id:'text',kind:'text',x:50,y:60,width:350,height:80,visible:true,locked:false,text:'Tier 2 · Ada',fontFamily:'mono',fontWeight:700,italic:true,textAlign:'right'};
const motion={enter:'fade',exit:'fade',loop:'float',delay:0,enterDuration:.5,exitDuration:.5,loopDuration:1};
const layout={duration:3,widgets:[{...shape,motion},text]};
const snapshot={width:1280,height:720,waitFor:['sub'],widgets:[{...shape,id:'permanent',x:850,y:400},{id:'alert',kind:'alert',designId:'design',events:['sub'],x:0,y:0,width:800,height:240,visible:true,locked:false}],designs:[{id:'design',width:800,height:240,events:{sub:{duration:1,widgets:[]}},variants:{sub:[{id:'tier2',name:'Tier 2',enabled:true,tier:'2000',layout}]}}]};
async function until(fn,label){for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw Error(label);}
try {
 const context=await browser.newContext({viewport:{width:1280,height:720}});let socket;const ended=[];
 const send=(name,value)=>socket.send(`42/overlay-studio/${publicId},${JSON.stringify([name,value])}`);
 await context.routeWebSocket('**/*',ws=>{if(!ws.url().includes('/socket.io/'))return ws.close();socket=ws;ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');ws.onMessage(m=>{m=String(m);if(m.startsWith('40/overlay-studio/')){ws.send(`40/overlay-studio/${publicId},{"sid":"fixture"}`);send('overlay-state',{revision:1,snapshot});}if(m.includes('overlay-ended'))ended.push(JSON.parse(m.slice(m.indexOf(',')+1))[1]);});});
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===new URL(base).origin)return route.continue();if(url.pathname.includes('/events/'))return route.fulfill({json:{data:{id:url.pathname.split('/').at(-1),kind:'sub',snapshot,layouts:{design:layout}}}});return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/overlays/'+publicId);await page.locator('.canvas .shape').waitFor();
 assert.equal(await page.locator('.shape').evaluate(e=>getComputedStyle(e).borderRadius),'20px','permanent shape');
 send('overlay-event',{id:'variant',kind:'sub'});const playing=page.locator('[data-event=sub]');await playing.waitFor();
 const style=await playing.locator('span').evaluate(e=>({font:getComputedStyle(e).fontFamily,weight:getComputedStyle(e).fontWeight,italic:getComputedStyle(e).fontStyle,align:getComputedStyle(e).textAlign,text:e.textContent}));assert.deepEqual({...style,font:undefined},{font:undefined,weight:'700',italic:'italic',align:'right',text:'Tier 2 · Ada'});assert(style.font.includes('Courier New'));
 assert.equal(await playing.locator('.shape').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(18, 52, 86)');
 assert.equal(await playing.locator('.layer-content').first().evaluate(e=>getComputedStyle(e).opacity),'0.6');
 assert.match(await playing.locator('.layer-content').first().evaluate(e=>getComputedStyle(e).filter),/drop-shadow/);
 assert.equal(await playing.locator('.art').first().evaluate(e=>getComputedStyle(e).overflow),'visible','shadow not clipped at object box');
 await until(()=>playing.locator('app-overlay-layer').first().evaluate(e=>e.getAnimations({subtree:true}).some(a=>a.id==='alert-object-enter')),'shape animation');
 await until(()=>ended.includes('variant'),'variant duration completes');assert.equal(await playing.count(),0);assert.equal(await page.locator('.shape').count(),1,'static shape stays');
 assert.deepEqual(errors,[]);await context.close();console.log('PASS published renderer: permanent/animated shapes, text fonts/styles, shadows/opacity and selected variant lifetime');
}finally{await browser.close();}
