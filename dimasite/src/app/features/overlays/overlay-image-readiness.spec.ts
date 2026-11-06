import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForOverlayMedia } from './overlay-image-readiness';
afterEach(() => vi.useRealTimers());
const fixture = () => {
  let image: { complete: boolean; naturalWidth: number; currentSrc: string; decode: () => Promise<void> } | null = null;
  const root = { querySelectorAll: () => [{ querySelector: () => image }] } as unknown as HTMLElement;
  const set = (value: typeof image) => { image = value; };
  return { root, set };
};
describe('displayed alert image readiness', () => {
  it('waits for signed URL resolution, loading and decoding', async () => {
    vi.useFakeTimers(); const f=fixture(); const controller=new AbortController();
    let done=false, decode!:()=>void;
    const result=waitForOverlayMedia(f.root,controller.signal).then(value=>{done=true;return value;});
    await vi.advanceTimersByTimeAsync(1000); expect(done).toBe(false);
    f.set({complete:false,naturalWidth:0,currentSrc:'image',decode:()=>new Promise(r=>decode=r)});
    await vi.advanceTimersByTimeAsync(1000); expect(done).toBe(false);
    f.set({complete:true,naturalWidth:10,currentSrc:'image',decode:()=>new Promise(r=>decode=r)});
    await vi.advanceTimersByTimeAsync(25); expect(done).toBe(false);
    decode(); expect(await result).toBe(true);
  });
  it('cancels a superseded preview without starting it later', async () => {
    const f=fixture(), controller=new AbortController();
    const result=waitForOverlayMedia(f.root,controller.signal); controller.abort();
    expect(await result).toBe(false);
  });
  it('keeps waiting for a healthy picture when another one fails', async () => {
    vi.useFakeTimers();
    type Img = { complete: boolean; naturalWidth: number; currentSrc: string; decode: () => Promise<void> };
    let healthy: Img = { complete: false, naturalWidth: 0, currentSrc: 'slow', decode: async () => {} };
    const broken: Img = { complete: true, naturalWidth: 0, currentSrc: 'broken', decode: async () => {} };
    const layers = [
      { querySelector: () => null, hasAttribute: (name: string) => name === 'data-overlay-failed' },
      { querySelector: () => broken, hasAttribute: () => false },
      { querySelector: () => healthy, hasAttribute: () => false }];
    const root = { querySelectorAll: () => layers } as unknown as HTMLElement;
    let done = false;
    const result = waitForOverlayMedia(root, new AbortController().signal).then(value => { done = true; return value; });
    await vi.advanceTimersByTimeAsync(1000); expect(done).toBe(false);
    healthy = { ...healthy, complete: true, naturalWidth: 10 };
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBe(false);
    expect(done).toBe(true);
  });
  it('waits for a video first frame, and settles a failed video', async () => {
    vi.useFakeTimers();
    const video = { readyState: 1, error: null as unknown };
    const layer = { querySelector: () => video, hasAttribute: (name: string) => name === 'data-overlay-video' };
    const root = { querySelectorAll: () => [layer] } as unknown as HTMLElement;
    let done = false;
    const result = waitForOverlayMedia(root, new AbortController().signal).then(value => { done = true; return value; });
    await vi.advanceTimersByTimeAsync(1000); expect(done).toBe(false);
    video.readyState = 2;
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBe(true);
    video.readyState = 0; video.error = { code: 4 };
    expect(await waitForOverlayMedia(root, new AbortController().signal)).toBe(false);
  });
  it('stops counting a placement that was removed while it waited', async () => {
    const root = { isConnected: false, querySelectorAll: () => [{ querySelector: () => null }] } as unknown as HTMLElement;
    expect(await waitForOverlayMedia(root, new AbortController().signal)).toBe(true);
  });
  it('fails boundedly when image lookup stalls and rejects failed images', async () => {
    vi.useFakeTimers(); const f=fixture();
    const result=waitForOverlayMedia(f.root,new AbortController().signal);
    await vi.advanceTimersByTimeAsync(8000); expect(await result).toBe(false);
    f.set({complete:true,naturalWidth:0,currentSrc:'broken',decode:async()=>{}});
    expect(await waitForOverlayMedia(f.root,new AbortController().signal)).toBe(false);
  });
});
