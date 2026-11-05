import { Injectable, inject } from '@angular/core';
import type { Socket } from 'socket.io-client';
import { OverlayApi } from '../overlay-api.service';
import type { DimaEvent, DimaEventType, DimaSession } from './dima-events';
import { WidgetEventBus, type CustomWidgetEnv, type RuntimeBundle, type WidgetLogEntry, type WidgetStatus, type WidgetTarget } from './widget-env';

const FEED_TYPES = new Set<DimaEventType>(['chat', 'chat.delete', 'chat.clear', 'alert', 'store', 'session']);

/**
 * OBS environment for custom widget frames: code of the revision this published overlay pins, live data from the
 * overlay socket (`overlay-feed`), and store/counter requests over the same socket.
 */
@Injectable()
export class LiveWidgetEnv implements CustomWidgetEnv {
  readonly mode = 'live' as const;
  private readonly api = inject(OverlayApi);
  private readonly bus = new WidgetEventBus();
  private readonly bundles = new Map<string, Promise<RuntimeBundle>>();
  private sessionData: DimaSession | null = null;
  private publicId = '';
  private socket: Socket | null = null;

  attach(publicId: string, socket: Socket): void {
    this.publicId = publicId; this.socket = socket;
    socket.on('overlay-feed', (message: unknown) => this.feed(message));
  }
  bundle(widgetId: string, revision?: number): Promise<RuntimeBundle> {
    if (revision === undefined) return Promise.reject(new Error('Publish the overlay to run this widget'));
    const key = `${widgetId}:${revision}`;
    let pending = this.bundles.get(key);
    if (!pending) {
      pending = this.api.request<RuntimeBundle>('GET', `public/${this.publicId}/custom-widgets/${widgetId}/${revision}`, undefined, 30000).then(bundle => ({
        ...bundle,
        // Copied media load through this overlay's public asset route.
        media: Object.fromEntries(Object.entries(bundle.media ?? {}).map(([url, assetId]) => [url, `${this.api.base}/overlay-studio/public/${this.publicId}/assets/${assetId}`]))
      }));
      pending.catch(() => this.bundles.delete(key));
      this.bundles.set(key, pending);
    }
    return pending;
  }
  subscribe(listener: (event: DimaEvent, layerId?: string) => void): () => void { return this.bus.subscribe(listener); }
  async rpc(target: WidgetTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.socket?.connected) throw new Error('Overlay offline');
    const result = await this.socket.timeout(10000).emitWithAck('overlay-widget-rpc', { layerId: target.layerId, method, params }) as { ok?: boolean; value?: unknown; error?: string };
    if (!result?.ok) throw new Error(result?.error || 'Request failed');
    return result.value;
  }
  session(): DimaSession | null { return this.sessionData; }
  report(layerId: string, update: { status?: WidgetStatus; entry?: WidgetLogEntry }): void {
    if (update.entry?.level === 'error') console.warn(`[custom widget ${layerId}]`, update.entry.text);
  }
  private feed(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const { v, type, data } = message as { v?: unknown; type?: unknown; data?: unknown };
    if (v !== 1 || typeof type !== 'string' || !FEED_TYPES.has(type as DimaEventType) || !data || typeof data !== 'object') return;
    if (type === 'session') this.sessionData = data as DimaSession;
    this.bus.emit({ type, data } as DimaEvent);
  }
}
