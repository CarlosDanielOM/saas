// Pure catalog/contract checks. Run from any checkout with Node's TypeScript stripping support.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../../',import.meta.url),dir=new URL('dimasite/src/app/features/overlays/',root);
const source=await readFile(new URL('overlay-keyframes.model.ts',dir),'utf8');
assert.equal(source,await readFile(new URL('dimabot/src/overlays/keyframes.ts',root),'utf8'),'server and recovered-draft contracts match');
const url=s=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(s)).toString('base64');
const modelURL=url(source),model=await import(modelURL);
const presets=await import(url((await readFile(new URL('overlay-motion-presets.ts',dir),'utf8')).replace("'./overlay-keyframes.model'",JSON.stringify(modelURL))));
const {motionWindows}=await import(url(await readFile(new URL('overlay-motion-timing.ts',dir),'utf8')));
const {easeProgress}=await import(url(await readFile(new URL('overlay-keyframe-player.ts',dir),'utf8')));
assert.equal(presets.MOTION_PRESETS.length,38);assert.equal(new Set(presets.MOTION_PRESETS.map(p=>p.id)).size,38);
const en=JSON.parse(await readFile(new URL('dimasite/src/assets/i18n/en.json',root),'utf8')).overlayStudio,es=JSON.parse(await readFile(new URL('dimasite/src/assets/i18n/es.json',root),'utf8')).overlayStudio;
for(const p of presets.MOTION_PRESETS){
 for(const strength of [.25,1,2]) assert(model.validKeyframes({[p.phase]:presets.presetSequence(p,strength)}),`${p.id} at ${strength} strength must save`);
 assert(en['kfPreset_'+p.id] && es['kfPreset_'+p.id] && en['kfDesc_'+p.id] && es['kfDesc_'+p.id]);
 if(p.phase==='loop') for(const t of p.sequence.tracks) assert.equal(t.points[0].value,model.neutralValue(t.property),'preset loops start and end at rest');
}
const current=presets.presetSequence(presets.MOTION_PRESETS.find(p=>p.id==='float')),incoming=presets.presetSequence(presets.MOTION_PRESETS.find(p=>p.id==='breathe'));
const combined=presets.combineSequences(current,incoming);assert.deepEqual(combined.tracks.map(t=>t.property),['y','scale']);combined.tracks[0].points[0].value=100;assert.equal(current.tracks[0].points[0].value,0,'presets and pasted tracks cannot share mutable points');
for(const duration of [.001,.5,1,5,120])for(const delay of [0,.2,5,120]){
 const windows=motionWindows({enter:'none',loop:'none',exit:'none',delay,enterDuration:1,exitDuration:1,loopDuration:1.7},duration,{enter:{tracks:[]},loop:{tracks:[]},exit:{tracks:[]}});
 for(const w of Object.values(windows)){assert(w.start>=0 && w.duration>=0 && w.span>=0);assert(w.start+w.span<=duration+.00001);assert(Number.isFinite(w.duration));}
 assert(Number.isInteger(windows.loop.iterations));
}
for(const easing of model.MOTION_EASINGS){let previous=-1;for(let i=0;i<=100;i++){const value=easeProgress(easing,i/100);assert(Number.isFinite(value) && value>=0 && value<=1);assert(value>=previous);previous=value;}assert(Math.abs(easeProgress(easing,0))<.0001);assert(Math.abs(easeProgress(easing,1)-1)<.0001);}
console.log('PASS shared keyframe contracts, 38 preset bounds at every strength, EN/ES catalog parity, independent combinations, curve sampling and short/late timing boundaries');
