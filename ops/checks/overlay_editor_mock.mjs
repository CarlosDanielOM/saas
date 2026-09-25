/** Run with SAAS_PREVIEW_URL and PLAYWRIGHT_MODULE pointing to an installed Playwright entry. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base=process.env.SAAS_PREVIEW_URL;
assert(base, 'SAAS_PREVIEW_URL required');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const errors=[];
const screenshots=process.env.SAAS_SCREENSHOT_DIR;
if(screenshots)await mkdir(screenshots,{recursive:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1080},reducedMotion:'reduce'});
 await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${base}/mocks/dev/overlay-editor`);
 await page.locator('.stage').waitFor();
 const saved=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('domdimabot-overlay-editor-mock-v2')));
 const change=async(label,value)=>{await page.getByLabel(label,{exact:true}).fill(String(value));await page.getByLabel(label,{exact:true}).blur();};
 const click=async(name)=>page.getByRole('button',{name,exact:true}).click();
 assert.equal(await page.locator('.widget').count(),4);
 // Canvas edits retain the complete layer rectangles, including those now off canvas.
 await click('Save draft');const initial=await saved();
 await change('Canvas width',800);await click('Save draft');
 assert.deepEqual((await saved()).scenes[0].widgets,initial.scenes[0].widgets);
 assert(await page.locator('.off-canvas').isVisible());
 await change('Canvas width',1920);
 // Dragging and resizing use scene coordinates at the displayed scale.
 const widget=page.locator('.widget[data-kind="alert"]');const before=await widget.boundingBox();
 await page.mouse.move(before.x+50,before.y+35);await page.mouse.down();await page.mouse.move(before.x+80,before.y+55);await page.mouse.up();
 const moved=await widget.boundingBox();assert(moved.x>before.x+20);
 const handle=await widget.locator('.resize-handle').boundingBox();
 await page.mouse.move(handle.x+6,handle.y+6);await page.mouse.down();await page.mouse.move(handle.x+35,handle.y+24);await page.mouse.up();
 assert((await widget.boundingBox()).width>moved.width+15);
 // Event choices belong to this instance and persist independently.
 await page.locator('.alert-properties').getByLabel('Follows',{exact:true}).check();
 await click('Save draft'); assert((await saved()).scenes[0].widgets.find(w=>w.kind==='alert').events.includes('follow'));
 // Save a reusable design with independent follow/bits layouts and sample variable rendering.
 await click('Edit design');
 await change('Design name','Shared celebration');
 await page.getByLabel('Text template',{exact:true}).fill('Welcome $(user)!');
 await change('Sample user','Mika');
 assert.equal(await page.locator('.text-preview').innerText(),'Welcome Mika!');
 await page.locator('.design-event-tabs').getByRole('button',{name:'Bits',exact:true}).click();
 await page.getByLabel('Text template',{exact:true}).fill('$(user) sent $(amount) bits');
 await change('Sample amount',250);
 assert.equal(await page.locator('.text-preview').innerText(),'Mika sent 250 bits');
 await click('Save design');
 const first=await saved();
 assert.equal(first.designs[0].events.follow.widgets[1].text,'Welcome $(user)!');
 assert.equal(first.designs[0].events.bits.widgets[1].text,'$(user) sent $(amount) bits');
 // Saving a copy does not rebind existing instances.
 await click('Save as a new design');
 assert.equal((await saved()).designs.length,2);
 await click('← Save & back to overlay');
 await page.getByLabel('Global overlay',{exact:true}).selectOption('chatting');
 assert.equal(await page.locator('.widget[data-kind="alert"] strong').innerText(),'Welcome Mika!');
 await page.getByRole('button',{name:/Alert design library/}).click();
 await page.locator('.design-card').nth(1).waitFor(); assert.equal(await page.locator('.design-card').count(),2);
 await page.locator('.design-card').filter({has:page.getByRole('heading',{name:'Shared celebration',exact:true})}).getByRole('button',{name:'Add to overlay',exact:true}).click();
 await page.locator('.widget[data-kind="alert"]').nth(1).waitFor(); assert.equal(await page.locator('.widget[data-kind="alert"]').count(),2);
 await click('Save draft');
 assert.equal((await saved()).scenes[1].widgets.filter(w=>w.designId==='aurora').length,2);
 // Published snapshots remain stable when the shared draft changes.
 await page.getByRole('button',{name:/Publish preview/}).click();
 const published=(await saved()).scenes[1].published;
 await click('Edit design');
 await page.getByLabel('Text template',{exact:true}).fill('Updated $(user)');
 await click('Save design'); await click('← Save & back to overlay');
 assert.deepEqual((await saved()).scenes[1].published,published);
 assert.equal(await page.locator('.widget[data-kind="alert"] strong').first().innerText(),'Updated Mika');
 // A large queue is preserved on publish. An error advances exactly one active job.
 await page.clock.install({time:new Date("2026-09-25T00:00:00Z")}); await page.clock.pauseAt(new Date("2026-09-25T00:00:01Z"));
 const events=page.locator('.event-tester__actions');
 await events.getByRole('button',{name:'Text to speech',exact:true}).dispatchEvent('click');
 await events.getByRole('button',{name:'Bits',exact:true}).evaluate(button=>{for(let i=0;i<100;i++)button.click();});
 await page.clock.runFor(32);
 assert.match(await page.locator('.queue-heading').innerText(),/100 waiting/);
 await events.getByRole('button',{name:'Clips',exact:true}).dispatchEvent('click');await page.clock.runFor(32);
 assert.match(await page.locator('.queue-status').innerText(),/1 playing independently/);
 await page.getByRole('button',{name:/Publish preview/}).dispatchEvent('click');await page.clock.runFor(32);
 assert.match(await page.locator('.queue-heading').innerText(),/100 waiting/);
 await page.getByRole('button',{name:'Simulate media error',exact:true}).dispatchEvent('click');await page.clock.runFor(32);
 assert.match(await page.locator('.queue-heading').innerText(),/99 waiting/);
 assert.match(await page.locator('.queue-status').innerText(),/Playing: Bits/);
 await page.clock.runFor(2500);
 assert.match(await page.locator('.queue-heading').innerText(),/98 waiting/);
 await page.clock.runFor(250000);
 assert.match(await page.locator('.queue-heading').innerText(),/0 waiting/);
 assert.match(await page.locator('.queue-status').innerText(),/Playing: Ready/);
 await page.clock.resume();
 await page.locator('summary').click();const oldUrl=await page.locator('.url-row code').innerText();
 await click('Regenerate URL');await page.waitForFunction(old=>document.querySelector('.url-row code').textContent!==old,oldUrl);assert.notEqual(await page.locator('.url-row code').innerText(),oldUrl);
 await click('Save draft');assert.equal((await saved()).sceneId,'chatting');await page.reload();await page.locator('.stage').waitFor();await page.getByRole('button',{name:'Saved locally',exact:true}).waitFor();
 await page.waitForFunction(()=>document.querySelector('.scene-picker select')?.value==='chatting');assert.equal(await page.getByLabel('Global overlay',{exact:true}).inputValue(),'chatting');
 await page.getByRole('button',{name:/Alert design library/}).click();await page.locator('.design-card').nth(1).waitFor(); assert.equal(await page.locator('.design-card').count(),2);
 // Desktop/mobile, light/dark, language switching and nested touch editing.
 if(screenshots)await page.screenshot({path:`${screenshots}/desktop.png`,fullPage:true});
 await page.getByRole('button',{name:/Alert design library/}).click();
 for(const width of [320,375,768,1024,1440]){
   await page.setViewportSize({width,height:900});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow at ${width}`);
 }
 await page.setViewportSize({width:375,height:900});
 await page.locator('.mobile-tabs').getByRole('button',{name:'Properties',exact:true}).click();
 await page.locator('.mobile-tabs').getByRole('button',{name:'Library',exact:true}).click();
 await page.locator('.layer').filter({hasText:'Alerts'}).first().click();
 await click('Edit design');
 await page.locator('.mobile-tabs').getByRole('button',{name:'Properties',exact:true}).click();
 await page.getByLabel('Text template',{exact:true}).fill('Mobile $(user)');
 await page.locator('.mobile-tabs').getByRole('button',{name:'Canvas',exact:true}).click();
 assert.equal(await page.locator('.text-preview').innerText(),'Mobile Luna');
 if(screenshots)await page.screenshot({path:`${screenshots}/mobile-design.png`,fullPage:true});
 await page.getByRole('button',{name:'Switch theme',exact:true}).click();
 if(screenshots)await page.screenshot({path:`${screenshots}/mobile-light.png`,fullPage:true});
 await page.getByRole('button',{name:'Switch language',exact:true}).click();await page.waitForFunction(()=>document.querySelector('h1').textContent==='Tus alertas, tu estilo.');
 assert.equal(await page.locator('h1').innerText(),'Tus alertas, tu estilo.');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert(!/overlayMock\./.test(await page.locator('.editor').innerText()),'missing translations');
 assert.deepEqual(errors,[]);
 console.log('PASS: reusable designs, independent event layouts, instance filters, drag/resize, canvas preservation, publish snapshots, 100-event queue, media error, URL rotation, persistence, mobile, themes, Spanish.');
}finally{await browser.close();}
