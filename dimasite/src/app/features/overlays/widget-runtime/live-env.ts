import { Injectable, inject } from '@angular/core';
import type { Socket } from 'socket.io-client';
import { OverlayApi } from '../overlay-api.service';
import type { DimaEvent, DimaEventType, DimaSession } from './dima-events';
import { WidgetEventBus, type CustomWidgetEnv, type RuntimeBundle, type WidgetLogEntry, type WidgetStatus, type WidgetTarget } from './widget-env';

const FEED_TYPES = new Set<DimaEventType>(['chat', 'chat.delete', 'chat.clear', 'alert', 'storage', 'session', 'signal', 'state', 'tts', 'trigger', 'reward', 'pet', 'duel', 'roulette', 'dimafx']);

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
  private readonly stateData: Record<string, unknown> = {};
  private publicId = '';
  private socket: Socket | null = null;

  attach(publicId: string, socket: Socket): void {
    this.publicId = publicId; this.socket = socket;
    socket.on('overlay-feed', (message: unknown) => this.feed(message));
    // Load rules changed (cached per revision): drop the cached code and tell its layers to load it again.
    socket.on('overlay-widget-reload', (message: unknown) => {
      const widgetId = (message as { widgetId?: unknown } | null)?.widgetId;
      if (typeof widgetId === 'string') this.reloadWidget(widgetId);
    });
    // Sent on every (re)connect and republish: reload widgets loaded under other rules (a change made while offline).
    socket.on('overlay-widget-policies', (message: unknown) => {
      const networks = (message as { networks?: unknown } | null)?.networks;
      if (!networks || typeof networks !== 'object') return;
      for (const [widgetId, network] of Object.entries(networks as Record<string, unknown>)) {
        const loaded = this.loadedNetworks.get(widgetId);
        if (loaded !== undefined && (network === 'restricted' ? 'restricted' : 'open') !== loaded) this.reloadWidget(widgetId);
      }
    });
  }
  /** The load rules each widget's cached code was fetched with. */
  private readonly loadedNetworks = new Map<string, 'open' | 'restricted'>();
  private reloadWidget(widgetId: string): void {
    if (!/^[a-f0-9]{24}$/.test(widgetId)) return;
    for (const key of [...this.bundles.keys()]) if (key.startsWith(widgetId + ':')) this.bundles.delete(key);
    this.loadedNetworks.delete(widgetId);
    for (const listener of [...this.reloadListeners]) listener(widgetId);
  }
  private readonly reloadListeners = new Set<(widgetId: string) => void>();
  onReload(listener: (widgetId: string) => void): () => void { this.reloadListeners.add(listener); return () => { this.reloadListeners.delete(listener); }; }
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
      pending.then(bundle => { this.loadedNetworks.set(widgetId, bundle.network === 'restricted' ? 'restricted' : 'open'); }, () => this.bundles.delete(key));
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
  states(): Record<string, unknown> { return { ...this.stateData }; }
  report(layerId: string, update: { status?: WidgetStatus; entry?: WidgetLogEntry }): void {
    if (update.entry?.level === 'error') console.warn(`[custom widget ${layerId}]`, update.entry.text);
  }
  private readonly roulette = new Map<string, DimaEvent>();
  private keepRoulette(event: DimaEvent): void {
    const data = event.data as { id?: unknown; phase?: unknown };
    this.roulette.delete(`${String(data.id)}:${String(data.phase)}`); this.roulette.set(`${String(data.id)}:${String(data.phase)}`, event);
    for (const key of [...this.roulette.keys()].slice(0, Math.max(0, this.roulette.size - 40))) this.roulette.delete(key);
  }
  /** Roulette spins still running and results from the last 2 minutes (the server's replay window), oldest first. */
  recent(): DimaEvent[] {
    const now = Date.now();
    return [...this.roulette.values()].filter(event => {
      const { phase, endsAt } = event.data as { phase?: unknown; endsAt?: unknown };
      return typeof endsAt === 'number' && (phase === 'spinning' ? now < endsAt : now - endsAt <= 120_000);
    });
  }
  private feed(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const { v, type, data, layers } = message as { v?: unknown; type?: unknown; data?: unknown; layers?: unknown };
    if (v !== 1 || typeof type !== 'string' || !FEED_TYPES.has(type as DimaEventType) || !data || typeof data !== 'object') return;
    // Roulette phases are kept for frames that start later (a widget still loading when the result arrived gets it then).
    if (type === 'roulette') this.keepRoulette({ type, data } as DimaEvent);
    if (type === 'session') this.sessionData = data as DimaSession;
    if (type === 'state' && typeof (data as { name?: unknown }).name === 'string') this.stateData[(data as { name: string }).name] = (data as { value?: unknown }).value ?? null;
    // Signals name the layers they're for (the server matched uses and widget.signal.to names).
    if (Array.isArray(layers)) { for (const layer of layers) if (typeof layer === 'string') this.bus.emit({ type, data } as DimaEvent, layer); return; }
    this.bus.emit({ type, data } as DimaEvent);
  }
}
