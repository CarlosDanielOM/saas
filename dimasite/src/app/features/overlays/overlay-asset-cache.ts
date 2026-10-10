/** Encoded alert media retained by one OBS page; decoded/active media are separate. */
export const OVERLAY_ASSET_CACHE_BYTES = 64 * 1024 * 1024;
/** Larger files use normal eager HTTP loading instead of local bytes. */
export const OVERLAY_ASSET_MAX_BYTES = 16 * 1024 * 1024;
/** A download is abandoned only when no bytes arrive for this long, so large GIFs can finish. */
export const OVERLAY_ASSET_STALL_MS = 8000;
export interface PreparedAsset { url: string; release(): void }

export class OverlayAssetCache {
  private readonly entries = new Map<string, Blob>();
  private readonly pending = new Map<string, Promise<Blob | undefined>>();
  private readonly controllers = new Set<AbortController>();
  private bytes = 0;
  private generation = 0;
  private sources = new Set<string>();

  /** Only published, uploaded image/audio/video URLs belong here, never trigger/clip URLs. */
  warm(sources: string[]): void {
    const next = new Set(sources);
    if (next.size === this.sources.size && [...next].every(url => this.sources.has(url))) return;
    this.sources = next;
    for (const [url, blob] of this.entries) if (!next.has(url)) {
      this.entries.delete(url); this.bytes -= blob.size;
    }
    const generation = ++this.generation;
    void (async () => {
      // Sequential warming limits background bandwidth and transient memory.
      for (const url of next) {
        if (generation !== this.generation || this.bytes >= OVERLAY_ASSET_CACHE_BYTES) break;
        await this.load(url);
      }
    })();
  }

  /**
   * Resolves local bytes for playback. After `waitMs` the alert continues with HTTP
   * loading, while the download keeps going so the next alert uses local bytes.
   */
  async prepare(url: string, waitMs = 6000): Promise<PreparedAsset | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const blob = await Promise.race([this.load(url), new Promise<undefined>(resolve => { timer = setTimeout(resolve, waitMs); })]).finally(() => clearTimeout(timer));
    if (!blob) return undefined;
    const source = URL.createObjectURL(blob);
    const prepared = { url: source, release: () => URL.revokeObjectURL(source) };
    if (!blob.type.startsWith('image/')) return prepared;
    const image = new Image();
    image.src = source;
    try {
      await Promise.race([image.decode(), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
      // A slow decode still paints from local bytes; it never needs the network again.
      return prepared;
    } catch {
      URL.revokeObjectURL(source);
      const cached = this.entries.get(url);
      if (cached) { this.entries.delete(url); this.bytes -= cached.size; }
      return undefined;
    } finally { clearTimeout(timer); }
  }

  private load(url: string): Promise<Blob | undefined> {
    const hit = this.entries.get(url);
    if (hit) {
      this.entries.delete(url); this.entries.set(url, hit);
      return Promise.resolve(hit);
    }
    const existing = this.pending.get(url);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), OVERLAY_ASSET_STALL_MS); };
    stalled();
    const request = (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal, referrerPolicy: 'no-referrer' });
        const type = response.headers.get('Content-Type') ?? '';
        if (!response.ok || !/^(image|audio|video)\//.test(type)) return undefined;
        if (Number(response.headers.get('Content-Length')) > OVERLAY_ASSET_MAX_BYTES) return undefined;
        const reader = response.body?.getReader();
        if (!reader) return undefined;
        const chunks: BlobPart[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stalled();
          size += value.byteLength;
          if (size > OVERLAY_ASSET_MAX_BYTES) { await reader.cancel(); return undefined; }
          chunks.push(value);
        }
        if (!size || controller.signal.aborted) return undefined;
        const blob = new Blob(chunks, { type });
        // A publication can remove the asset while its download is in progress.
        if (this.sources.has(url)) {
          while (this.entries.size && this.bytes + size > OVERLAY_ASSET_CACHE_BYTES) {
            const oldest = this.entries.keys().next().value!;
            this.bytes -= this.entries.get(oldest)!.size; this.entries.delete(oldest);
          }
          this.entries.set(url, blob); this.bytes += size;
        }
        return blob;
      } catch { return undefined; }
      finally {
        clearTimeout(timer); controller.abort(); this.controllers.delete(controller);
      }
    })().finally(() => { if (this.pending.get(url) === request) this.pending.delete(url); });
    this.pending.set(url, request);
    return request;
  }

  clear(): void {
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear(); this.pending.clear(); this.entries.clear(); this.sources.clear(); this.bytes = 0;
  }
}
