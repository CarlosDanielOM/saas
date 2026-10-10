import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayAssetCache, OVERLAY_ASSET_CACHE_BYTES, OVERLAY_ASSET_MAX_BYTES, OVERLAY_ASSET_STALL_MS } from './overlay-asset-cache';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('OBS alert media byte cache', () => {
  function setup(size = 1024, type = 'image/png') {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(size), { headers: { 'Content-Type': type } }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('Image', class { src = ''; decode() { return Promise.resolve(); } });
    const cache = new OverlayAssetCache();
    return { cache, fetcher };
  }
  it('deduplicates concurrent loads and evicts least recently used bytes', async () => {
    const { cache, fetcher } = setup(OVERLAY_ASSET_CACHE_BYTES / 4);
    cache.warm(['a', 'b', 'c', 'd', 'e']); await tick(); await tick();
    expect(fetcher.mock.calls.length).toBe(4);
    const a = await cache.prepare('a'); a?.release();
    const [e1, e2] = await Promise.all([cache.prepare('e'), cache.prepare('e')]); e1?.release(); e2?.release();
    expect(fetcher.mock.calls.length).toBe(5);
    (await cache.prepare('a'))?.release(); expect(fetcher.mock.calls.length).toBe(5);
    (await cache.prepare('b'))?.release(); expect(fetcher.mock.calls.length).toBe(6);
    cache.clear();
  });
  it('keeps multi-megabyte GIFs, sounds and videos local', async () => {
    const { cache, fetcher } = setup(8 * 1024 * 1024, 'image/gif');
    cache.warm(['gif']); await tick();
    expect((await cache.prepare('gif'))?.url).toMatch(/^blob:/);
    fetcher.mockImplementation(async () => new Response(new Uint8Array(2048), { headers: { 'Content-Type': 'audio/mpeg' } }));
    cache.warm(['gif', 'sound']); await tick();
    const decode = vi.fn(() => Promise.resolve());
    vi.stubGlobal('Image', class { src = ''; decode = decode; });
    expect((await cache.prepare('sound'))?.url).toMatch(/^blob:/);
    expect(decode).not.toHaveBeenCalled();
    (await cache.prepare('gif'))?.release();
    expect(fetcher.mock.calls.length).toBe(2);
    cache.clear();
  });
  it('does not retain oversized, failed, foreign or undecodable responses', async () => {
    const { cache, fetcher } = setup(OVERLAY_ASSET_MAX_BYTES + 1);
    cache.warm(['large']); await tick();
    expect(await cache.prepare('large')).toBeUndefined();
    expect(fetcher.mock.calls.length).toBe(2);
    fetcher.mockImplementation(async () => new Response('', { status: 404 }));
    expect(await cache.prepare('missing')).toBeUndefined();
    fetcher.mockImplementation(async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }));
    expect(await cache.prepare('page')).toBeUndefined();
    fetcher.mockImplementation(async () => new Response('image', { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('Image', class { src=''; decode() { return Promise.reject(new Error('invalid')); } });
    expect(await cache.prepare('broken')).toBeUndefined();
    cache.clear();
  });
  it('drops unpublished media and clears cached bytes on revocation', async () => {
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
  it('lets a slow alert continue over HTTP while the download finishes for the next one', async () => {
    vi.useFakeTimers();
    const { cache, fetcher } = setup();
    let resolve!: (r: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    cache.warm(['slow']);
    const first = cache.prepare('slow', 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBeUndefined();
    resolve(new Response(new Uint8Array(64), { headers: { 'Content-Type': 'image/png' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect((await cache.prepare('slow'))?.url).toMatch(/^blob:/);
    expect(fetcher.mock.calls.length).toBe(1); cache.clear();
  });
  it('aborts stalled requests so an alert can fall back instead of blocking', async () => {
    vi.useFakeTimers();
    const { cache, fetcher } = setup();
    fetcher.mockImplementation((_url?: unknown, options?: RequestInit) => new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const result = cache.prepare('stalled', OVERLAY_ASSET_STALL_MS * 2);
    await vi.advanceTimersByTimeAsync(OVERLAY_ASSET_STALL_MS);
    expect(await result).toBeUndefined(); cache.clear();
  });
});
