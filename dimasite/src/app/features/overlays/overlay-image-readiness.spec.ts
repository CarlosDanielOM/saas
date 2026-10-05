import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForOverlayImages } from './overlay-image-readiness';
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
    const result=waitForOverlayImages(f.root,controller.signal).then(value=>{done=true;return value;});
    await vi.advanceTimersByTimeAsync(1000); expect(done).toBe(false);
    f.set({complete:false,naturalWidth:0,currentSrc:'image',decode:()=>new Promise(r=>decode=r)});
    await vi.advanceTimersByTimeAsync(1000); expect(done).toBe(false);
    f.set({complete:true,naturalWidth:10,currentSrc:'image',decode:()=>new Promise(r=>decode=r)});
    await vi.advanceTimersByTimeAsync(25); expect(done).toBe(false);
    decode(); expect(await result).toBe(true);
  });
  it('cancels a superseded preview without starting it later', async () => {
    const f=fixture(), controller=new AbortController();
    const result=waitForOverlayImages(f.root,controller.signal); controller.abort();
    expect(await result).toBe(false);
  });
  it('fails boundedly when image lookup stalls and rejects failed images', async () => {
    vi.useFakeTimers(); const f=fixture();
    const result=waitForOverlayImages(f.root,new AbortController().signal);
    await vi.advanceTimersByTimeAsync(8000); expect(await result).toBe(false);
    f.set({complete:true,naturalWidth:0,currentSrc:'broken',decode:async()=>{}});
    expect(await waitForOverlayImages(f.root,new AbortController().signal)).toBe(false);
  });
});
