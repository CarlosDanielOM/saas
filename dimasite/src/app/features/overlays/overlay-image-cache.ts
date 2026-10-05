/** Encoded image bytes retained by one OBS page; decoded/active images are separate. */
export const OVERLAY_IMAGE_CACHE_BYTES = 2 * 1024 * 1024;
export interface PreparedImage { url: string; release(): void }

export class OverlayImageCache {
  private readonly entries = new Map<string, Blob>();
  private readonly pending = new Map<string, Promise<Blob | undefined>>();
  private readonly controllers = new Set<AbortController>();
  private bytes = 0;
  private generation = 0;
  private sources = new Set<string>();

  /** Only published, uploaded image URLs belong here, never trigger/video URLs. */
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
        if (generation !== this.generation || this.bytes >= OVERLAY_IMAGE_CACHE_BYTES) break;
        await this.load(url);
      }
    })();
  }

  async prepare(url: string): Promise<PreparedImage | undefined> {
    const blob = await this.load(url);
    if (!blob) return undefined; // Oversized/unavailable images use normal eager HTTP loading.
    const source = URL.createObjectURL(blob);
    const image = new Image();
    image.src = source;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([image.decode(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Image decode timeout')), 2000);
      })]);
      return { url: source, release: () => URL.revokeObjectURL(source) };
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
    const timer = setTimeout(() => controller.abort(), 4000);
    const request = (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal, referrerPolicy: 'no-referrer' });
        if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/')) return undefined;
        if (Number(response.headers.get('Content-Length')) > OVERLAY_IMAGE_CACHE_BYTES) return undefined;
        const reader = response.body?.getReader();
        if (!reader) return undefined;
        const chunks: BlobPart[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > OVERLAY_IMAGE_CACHE_BYTES) { await reader.cancel(); return undefined; }
          chunks.push(value);
        }
        if (!size || controller.signal.aborted) return undefined;
        const blob = new Blob(chunks, { type: response.headers.get('Content-Type')! });
        // A publication can remove the asset while its download is in progress.
        if (this.sources.has(url)) {
          while (this.bytes + size > OVERLAY_IMAGE_CACHE_BYTES) {
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
