import { describe, expect, it } from 'vitest';
import { alertPlacementIds, placementMediaSeconds, placementStartSeconds, sceneScale, type OverlayRenderEvent } from './overlay-playback';
import type { OverlayWidget } from './overlay.model';
const widget = (id: string,designId: string): OverlayWidget => ({id,designId,kind:'alert',x:0,y:0,width:800,height:240,visible:true,locked:false,events:['follow','bits']});

describe('shared OBS playback rules',() => {
  it('uses each placement layout duration rather than the longest alert in an event',() => {
    const event: OverlayRenderEvent = {id:'one',kind:'follow',layouts:{short:{duration:1,widgets:[]},long:{duration:3,widgets:[]}}};
    expect(placementStartSeconds(event,widget('a','short'))).toBe(1);
    expect(placementStartSeconds(event,widget('b','long'))).toBe(3);
    expect(placementStartSeconds(event,widget('c','missing'))).toBe(5);
    expect(placementStartSeconds({...event,media:{type:'audio',url:'fixture.wav',title:'test',volume:1}},widget('a','short'))).toBe(30);
  });
  it('keeps media loading, caption deadlines and real playback durations distinct',() => {
    const event: OverlayRenderEvent = {id:'speech',kind:'tts',tts:{speechID:'speech',ownerClientId:null,durationMs:1600}};
    expect(placementStartSeconds(event,widget('a','short'))).toBe(1.6);
    expect(placementMediaSeconds({...event,media:{type:'image',url:'fixture.png',title:'test',volume:1}},80)).toBe(5);
    expect(placementMediaSeconds({...event,media:{type:'audio',url:'fixture.wav',title:'test',volume:1}},80)).toBe(95);
    expect(placementMediaSeconds({...event,media:{type:'audio',url:'fixture.wav',title:'test',volume:1,duration:80}},5)).toBe(80);
    expect(placementMediaSeconds(event)).toBe(300);
  });
  it('reserves overlapping alert boxes for any matching category and ignores hidden boxes',() => {
    const visible = widget('a','short'),hidden = {...widget('b','long'),visible:false};
    expect(alertPlacementIds([visible,hidden],'bits')).toEqual(['a']);
    expect(alertPlacementIds([visible,hidden],'tts')).toEqual([]);
  });
  it('scales the complete design canvas uniformly at every viewport size',() => {
    expect(sceneScale({width:1920,height:1080},{width:960,height:540})).toBe(.5);
    expect(sceneScale({width:1920,height:1080},{width:390,height:900})).toBe(390/1920);
    expect(sceneScale({width:800,height:240},{width:0,height:0})).toBe(1);
  });
});
