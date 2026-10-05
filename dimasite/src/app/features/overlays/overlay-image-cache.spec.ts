import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayImageCache, OVERLAY_IMAGE_CACHE_BYTES } from './overlay-image-cache';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('OBS image byte cache', () => {
  function setup(size = 1024) {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(size), { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('Image', class { src = ''; decode() { return Promise.resolve(); } });
    const cache = new OverlayImageCache();
    return { cache, fetcher };
  }
  it('deduplicates concurrent loads and retains two MiB with LRU eviction', async () => {
    const { cache, fetcher } = setup(OVERLAY_IMAGE_CACHE_BYTES / 2);
    cache.warm(['a', 'b', 'c']); await tick();
    expect(fetcher.mock.calls.length).toBe(2);
    const a = await cache.prepare('a'); a?.release();
    const [c1,c2] = await Promise.all([cache.prepare('c'),cache.prepare('c')]); c1?.release();c2?.release();
    expect(fetcher.mock.calls.length).toBe(3);
    (await cache.prepare('a'))?.release(); expect(fetcher.mock.calls.length).toBe(3);
    (await cache.prepare('b'))?.release(); expect(fetcher.mock.calls.length).toBe(4);
    cache.clear();
  });
  it('does not retain oversized, failed or undecodable responses', async () => {
    const { cache, fetcher } = setup(OVERLAY_IMAGE_CACHE_BYTES + 1);
    cache.warm(['large']); await tick();
    expect(await cache.prepare('large')).toBeUndefined();
    expect(fetcher.mock.calls.length).toBe(2);
    fetcher.mockImplementation(async () => new Response('', { status: 404 }));
    expect(await cache.prepare('missing')).toBeUndefined();
    fetcher.mockImplementation(async () => new Response('image', { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('Image', class { src=''; decode() { return Promise.reject(new Error('invalid')); } });
    expect(await cache.prepare('broken')).toBeUndefined();
    cache.clear();
  });
  it('drops unpublished images and clears cached bytes on revocation', async () => {
    const { cache, fetcher } = setup();
    cache.warm(['a']); await tick();
    cache.warm(['b']); await tick();
    (await cache.prepare('a'))?.release(); expect(fetcher.mock.calls.length).toBe(3);
    cache.clear(); cache.warm(['b']); await tick();
    expect(fetcher.mock.calls.length).toBe(4);cache.clear();
  });
  it('does not repopulate a cleared cache from an interrupted download', async () => {
    const { cache, fetcher } = setup();
    let resolve!: (r: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(r => { resolve=r; }));
    cache.warm(['a']); cache.clear();
    resolve(new Response('late', { headers: { 'Content-Type': 'image/png' } })); await tick();
    cache.warm(['a']); await tick();
    expect(fetcher.mock.calls.length).toBe(2); cache.clear();
  });
  it('times out stalled requests so an alert can fall back instead of blocking', async () => {
    vi.useFakeTimers();
    const { cache, fetcher } = setup();
    fetcher.mockImplementation((_url?: unknown, options?: RequestInit) => new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const result = cache.prepare('stalled');
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toBeUndefined(); cache.clear();
  });

});
