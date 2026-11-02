// Capture fixed-clock ultimate frames; DUEL_COMPARE=<baseline directory> asserts exact pixel parity.
// All external traffic is blocked. Software WebGL profiles do not establish OBS frame rates.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const require = createRequire('/tmp/saas-cooldown-browser/package.json');
const {chromium} = require('playwright');
const base=process.env.SAAS_PREVIEW_URL, dir=process.env.DUEL_EVIDENCE || '/tmp/duel-extreme-parity';
assert(base, 'SAAS_PREVIEW_URL is required');
mkdirSync(dir,{recursive:true});
const browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader']});
const c='[data-testid=duel-claude-3d-canvas]', poll={timeout:90000,polling:100};
const result=[];
try {
 const context=await browser.newContext({viewport:{width:700,height:1100},reducedMotion:'reduce'});
 await context.addInitScript(()=>{localStorage.setItem('theme','dark');localStorage.setItem('userLanguage','en');});
 await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(base).origin?r.continue():r.abort());
 await context.routeWebSocket(/.*/,ws=>ws.close());
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/mocks/dev/duel?renderer=3d&entry=claude');
 await page.waitForFunction(c=>Number(document.querySelector(c)?.dataset.frames)>0,c,poll);
 await page.addStyleTag({content:'.arena-bottom b { visibility:hidden !important; }'});
 await page.evaluate(()=>document.fonts.ready);
 const seek=async t=>{await page.getByTestId('duel-scrub').evaluate((e,t)=>{e.value=String(t);e.dispatchEvent(new Event('input',{bubbles:true}));},t);await page.waitForFunction(([c,t])=>Number(document.querySelector(c)?.dataset.elapsed)===t,[c,t],poll);};
 for(const character of (process.env.DUEL_ONLY ? [process.env.DUEL_ONLY] : ['knight','mage','ronin'])) {
  await page.getByTestId('ultimate-'+character).evaluate(e=>e.click());
  await page.getByRole('button',{name:'Pause',exact:true}).evaluate(e=>e.click());
  await page.waitForFunction(c=>Number(document.querySelector(c)?.dataset.elapsed)>=5750,c,poll);
  const session=await context.newCDPSession(page);await session.send('Profiler.enable');await session.send('Profiler.setSamplingInterval',{interval:250});await session.send('Profiler.start');
  for(const t of character==='knight'?[7800,8300,9470]:character==='mage'?[7800,8650,9470]:[7800,7851,8000,9470,10400]) {
   await seek(t);
   const name=character+'-'+t;const png=await page.locator(c).screenshot({animations:'disabled',timeout:90000});writeFileSync(dir+'/'+name+'.png',png);
   const data=await page.$eval(c,e=>({...e.dataset,frameIntervals:undefined}));result.push({name,data});
   if(process.env.DUEL_COMPARE) {
    const previous=readFileSync(process.env.DUEL_COMPARE+'/'+name+'.png');
    const difference=await page.evaluate(async ({a,b})=>{
     const load=async s=>{const i=new Image();i.src='data:image/png;base64,'+s;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d');g.drawImage(i,0,0);return {w:i.width,h:i.height,d:g.getImageData(0,0,i.width,i.height).data};};
     const x=await load(a),y=await load(b);if(x.w!==y.w||x.h!==y.h)return {size:false};let sum=0,changed=0,max=0;for(let k=0;k<x.d.length;k+=4){let delta=0;for(let j=0;j<4;j++){const d=Math.abs(x.d[k+j]-y.d[k+j]);sum+=d;delta=Math.max(delta,d);}if(delta>8)changed++;max=Math.max(max,delta);}return {size:true,mean:sum/x.d.length,changed:changed/(x.d.length/4),max};
    },{a:previous.toString('base64'),b:png.toString('base64')});
    result.at(-1).difference=difference;console.log('DIFF',name,difference);
    assert.equal(difference.size,true,name+' keeps canvas dimensions');
    assert.equal(difference.max,0,name+' matches the baseline pixel for pixel');
   }
   console.log('FRAME',name,data.drawCalls,data.triangles,'bakes',data.halvesBakeCount);
  }
  const {profile}=await session.send('Profiler.stop');writeFileSync(dir+'/'+character+'-cpu.json',JSON.stringify(profile));await session.detach();
  const nodes=profile.nodes.filter(n=>/bakeRig|setHalves|mergeGeometries|toNonIndexed|compile|WebGLProgram/.test(n.callFrame.functionName)).map(n=>({function:n.callFrame.functionName,hits:n.hitCount}));console.log('PROFILE',character,nodes);
 }
 assert.deepEqual(errors,[]);writeFileSync(dir+'/frames.json',JSON.stringify(result,null,2));
} finally { await browser.close(); }
