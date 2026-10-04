// Actual public overlay renderer; network events and assets use disposable browser fixtures only.
import assert from 'node:assert/strict';
const {chromium}=await import('/tmp/saas-cooldown-browser/node_modules/playwright/index.mjs');
const base=process.env.SAAS_PREVIEW_URL;assert(base);
const browser=await chromium.launch({args:['--no-sandbox']}),errors=[];
const id='d'.repeat(48),point=(offset,value)=>({offset,value,easing:'linear'}),track=(property,values)=>({property,points:values.map((v,i)=>point(i/(values.length-1),v))});
const keyframes={enter:{tracks:[track('x',[-100,0]),track('opacity',[0,1])]},loop:{tracks:[track('y',[0,-20,0]),track('scale',[1,1.2,1]),track('rotation',[0,10,0])]},exit:{tracks:[track('x',[0,100]),track('opacity',[1,0])]}};
const motion={enter:'none',loop:'none',exit:'none',delay:.2,enterDuration:1,exitDuration:1,loopDuration:1.7};
const shape={id:'animated',kind:'shape',x:200,y:50,width:200,height:100,visible:true,locked:false,color:'#a78bfa',radius:12,motion,keyframes};
const layout={duration:6,widgets:[shape,{...shape,id:'independent',x:450,keyframes:{enter:{tracks:[track('rotation',[-45,0])]}}}]};
const snapshot={width:1280,height:720,waitFor:['follow'],widgets:[{id:'alert',kind:'alert',designId:'design',events:['follow'],x:50,y:50,width:800,height:240,visible:true,locked:false}],designs:[{id:'design',width:800,height:240,events:{follow:layout}}]};
async function until(fn,label){for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw Error(label);}
try{
 const context=await browser.newContext({viewport:{width:1280,height:720}});let socket;const ended=[];
 const send=(name,value)=>socket.send(`42/overlay-studio/${id},${JSON.stringify([name,value])}`);
 await context.routeWebSocket('**/*',ws=>{if(!ws.url().includes('/socket.io/'))return ws.close();socket=ws;ws.send('0{"sid":"fixture","upgrades":[],"pingInterval":1000000000,"pingTimeout":1000000000}');ws.onMessage(m=>{m=String(m);if(m.startsWith('40/overlay-studio/')){ws.send(`40/overlay-studio/${id},{"sid":"fixture"}`);send('overlay-state',{revision:1,snapshot});}if(m.includes('overlay-ended'))ended.push(JSON.parse(m.slice(m.indexOf(',')+1))[1]);});});
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===new URL(base).origin)return route.continue();if(url.pathname.includes('/events/'))return route.fulfill({json:{data:{id:url.pathname.split('/').at(-1),kind:'follow',snapshot,layouts:{design:layout}}}});return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/overlays/'+id);await page.locator('.canvas').waitFor();await until(()=>!!socket,'socket');
 send('overlay-event',{id:'keyframe-1',kind:'follow'});const playing=page.locator('[data-event=follow]');await playing.waitFor();const layer=playing.locator('app-overlay-layer').first();
 await until(()=>layer.evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-keyframe')).length===7),'all property animations');
 const read=async(time)=>layer.evaluate(async(e,t)=>{e.getAnimations({subtree:true}).forEach(a=>{a.pause();a.currentTime=t*1000;});await new Promise(requestAnimationFrame);return e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-keyframe')).map(a=>{const target=a.effect.target,style=getComputedStyle(target),m=new DOMMatrixReadOnly(style.transform);return{id:a.id,x:m.m41/target.clientWidth,y:m.m42/target.clientHeight,scale:Math.hypot(m.m11,m.m12),opacity:+style.opacity,timing:a.effect.getTiming(),rotation:Math.atan2(m.m12,m.m11)*180/Math.PI};});},time);
 let values=await read(.7);const get=(phase,p)=>values.find(v=>v.id===`alert-keyframe-${phase}-${p}`);
 assert(Math.abs(get('enter','x').x+.5)<.005);assert(Math.abs(get('enter','opacity').opacity-.5)<.005);
 assert.equal(get('loop','y').timing.iterations,2,'cycles fit the idle window');assert(Math.abs(get('loop','y').timing.duration-1900)<.001);
 values=await read(2.15);assert(Math.abs(get('loop','y').y+.2)<.005);assert(Math.abs(get('loop','scale').scale-1.2)<.005);assert(Math.abs(get('loop','rotation').rotation-10)<.005);
 values=await read(3.1);assert(Math.abs(get('loop','y').y)<.005,'closed cycle returns to rest');
 values=await read(5.5);assert(Math.abs(get('exit','x').x-.5)<.005);assert(Math.abs(get('exit','opacity').opacity-.5)<.005);
 // Relative translations survive a browser-source size change.
 await page.setViewportSize({width:640,height:360});values=await read(.7);assert(Math.abs(get('enter','x').x+.5)<.005);await page.setViewportSize({width:1280,height:720});
 assert.equal(await playing.locator('app-overlay-layer').nth(1).evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-keyframe')).length),1);
 await page.waitForTimeout(1300);await page.emulateMedia({reducedMotion:'reduce'});await until(()=>layer.evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-keyframe')).length===2),'reduced motion');
 const reduced=await layer.evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-keyframe')).map(a=>({id:a.id,timing:a.effect.getTiming(),time:a.currentTime})));
 assert(reduced.every(a=>a.id.endsWith('-opacity') && a.timing.duration<=150 && a.time>=1000),'reduced motion skips spatial tracks and preserves elapsed time');
 await page.emulateMedia({reducedMotion:'no-preference'});await until(()=>layer.evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.id.startsWith('alert-keyframe')).length===7),'restore motion');
 await until(()=>ended.includes('keyframe-1'),'event completes');assert.equal(await page.locator('app-overlay-layer').count(),0);assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.id.startsWith('alert-')).length),0,'event cleanup');
 // Dense layout and a very short alert still use finite timings and bounded cycles.
 layout.duration=.5;layout.widgets=Array.from({length:24},(_,i)=>({...shape,id:'dense-'+i,x:i%8*90,y:Math.floor(i/8)*70,width:80,height:60}));
 send('overlay-event',{id:'dense',kind:'follow'});await playing.waitFor();await until(()=>playing.locator('app-overlay-layer').count().then(n=>n===24),'dense objects');
 const timing=await playing.evaluate(e=>e.getAnimations({subtree:true}).map(a=>a.effect.getTiming()));assert(timing.every(t=>Number.isFinite(t.duration) && t.duration>=0 && Number.isFinite(t.iterations)));assert(timing.every(t=>Number(t.delay)+Number(t.duration)*t.iterations<=501));
 await until(()=>ended.includes('dense'),'short event cleanup');assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.id.startsWith('alert-')).length),0);
 assert.deepEqual(errors,[]);await context.close();console.log('PASS public keyframe renderer: independent properties/objects, precise seeking, proportional scaling, whole loops, reduced motion toggles, 24-layer short alerts and animation cleanup');
}finally{await browser.close();}
