import { describe, expect, it } from 'vitest';
import { ALERT_READY_LIMIT_MS, alertPlacementIds, eventLook, lookFit, placementLayout, placementMediaSeconds, placementMountSeconds, placementStartSeconds, sceneScale, waitsForPictures, type OverlayRenderEvent } from './overlay-playback';
import type { OverlayWidget } from './overlay.model';
const widget = (id: string,designId: string): OverlayWidget => ({id,designId,kind:'alert',x:0,y:0,width:800,height:240,visible:true,locked:false,events:['follow','bits']});

describe('shared OBS playback rules',() => {
  it('plays a trigger look in trigger boxes instead of its media, with the look size and duration',() => {
    const box: OverlayWidget = {id:'t',kind:'trigger',x:0,y:0,width:400,height:400,visible:true,locked:false};
    const media = {type:'video' as const,url:'fixture.mp4',title:'test',volume:1};
    const look = {width:1600,height:900,layout:{duration:7,widgets:[]}};
    const event: OverlayRenderEvent = {id:'look',kind:'trigger',media,look};
    expect(placementLayout(event,box)).toEqual({layout:look.layout,width:1600,height:900,key:'$look',look:true});
    expect(placementStartSeconds(event,box)).toBe(7);
    expect(waitsForPictures(event)).toBe(true);
    expect(placementMountSeconds(event,box)).toBe(7 + ALERT_READY_LIMIT_MS / 1000 + 2);
    expect(placementStartSeconds({id:'plain',kind:'trigger',media},box)).toBe(30);
    expect(waitsForPictures({id:'plain',kind:'trigger',media})).toBe(false);
    // A malformed look is ignored: the plain media plays.
    expect(eventLook({look:{width:0,height:900,layout:{duration:1,widgets:[]}}})).toBeUndefined();
    expect(eventLook({look:{width:10,height:10} as never})).toBeUndefined();
    // Alert boxes keep their design layout and size.
    expect(placementLayout({layouts:{d:{duration:2,widgets:[]}}},widget('a','d'),[{id:'d',width:1000,height:500}])).toMatchObject({width:1000,height:500,key:'d',look:false});
  });
  it('letterboxes a look inside a box of another aspect ratio',() => {
    expect(lookFit({width:1600,height:900},{width:400,height:400})).toEqual({left:0,top:21.875,width:100,height:56.25});
    expect(lookFit({width:400,height:400},{width:800,height:400})).toEqual({left:25,top:0,width:50,height:100});
  });
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
  it('holds only designed alerts until their pictures are ready, with a bounded deadline',() => {
    const alert: OverlayRenderEvent = {id:'follow',kind:'follow',layouts:{short:{duration:1,widgets:[]}}};
    const media = {...alert,kind:'trigger' as const,media:{type:'video' as const,url:'fixture.mp4',title:'test',volume:1}};
    const speech: OverlayRenderEvent = {id:'speech',kind:'tts',tts:{speechID:'speech',ownerClientId:null,durationMs:1600}};
    expect([alert,media,speech].map(waitsForPictures)).toEqual([true,false,false]);
    expect(placementMountSeconds(alert,widget('a','short'))).toBe(1 + ALERT_READY_LIMIT_MS / 1000 + 2);
    expect(placementMountSeconds(media,widget('a','short'))).toBe(placementStartSeconds(media,widget('a','short')));
    expect(placementMountSeconds(speech,widget('a','short'))).toBe(1.6);
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
