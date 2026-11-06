import { Injectable, inject, signal } from '@angular/core';
import type { OverlayWidget } from '../overlay.model';
import { CustomWidgetsService } from '../custom-widgets.service';
import type { DimaAlert, DimaChat, DimaEvent, DimaSession, DimaSignal, DimaState } from './dima-events';
import { sessionAfterAlert } from './session-preview';
import { STATE_TESTS, testAlert, testChat, type AlertTest, type ChatTest } from './test-events';
import { WidgetEventBus, storeNamespace, type CustomWidgetEnv, type RuntimeBundle, type WidgetLogEntry, type WidgetStatus, type WidgetTarget } from './widget-env';

export interface LayerLog { status: WidgetStatus; errors: number; entries: WidgetLogEntry[] }
const MAX_ENTRIES = 200, MAX_VALUE_BYTES = 64_000;
/** Copied-file links last 12 h; new frames get fresh ones once the cached links are an hour old. */
const MEDIA_LINKS_MS = 60 * 60_000;

/**
 * Studio's environment for custom widget frames: owner bundles, test events from the Test drawer and setting
 * buttons, and a preview store (reads the channel's real values; writes stay in this browser tab).
 */
@Injectable()
export class EditorWidgetEnv implements CustomWidgetEnv {
  readonly mode = 'editor' as const;
  private readonly widgets = inject(CustomWidgetsService);
  private readonly bus = new WidgetEventBus();
  private readonly bundles = new Map<string, Promise<RuntimeBundle>>();
  private readonly linked = new Map<string, { at: number; bundle: Promise<RuntimeBundle> }>();
  private readonly previewStore = new Map<string, unknown>();
  private sessionData: DimaSession | null = null;
  /** OBS's session totals after this tab's test alerts to OBS (tests aren't journaled, so the server can't count them). */
  private obsSession: DimaSession | null = null;
  /** The server's snapshot as loaded (preview tests change `sessionData`, never this). */
  private serverSession: DimaSession | null = null;
  private lastChat: DimaChat | null = null;
  readonly logs = signal<Record<string, LayerLog>>({});
  /** Which goal on the Goals page feeds each StreamElements "manual" goal (`follower-goal`…), from the owner snapshot. */
  readonly goalSources = signal<Record<string, { id: string; name: string; status: string }> | null>(null);
  /** The overlay's current layers (the Commands block checks which other widgets listen to signals). */
  readonly sceneLayers = signal<readonly OverlayWidget[]>([]);

  bundle(widgetId: string, revision?: number): Promise<RuntimeBundle> {
    // Copying files changes the media map (and the owner can block outside connections) without a new revision.
    const view = this.widgets.widget(widgetId);
    const key = `${widgetId}:${revision ?? 'latest'}:${JSON.stringify(view?.media ?? {})}:${view?.network ?? 'open'}`;
    let code = this.bundles.get(key);
    if (!code) {
      code = this.widgets.bundle(widgetId, revision);
      code.catch(() => this.bundles.delete(key));
      this.bundles.set(key, code);
    }
    const cached = this.linked.get(key);
    if (cached && Date.now() - cached.at < MEDIA_LINKS_MS) return cached.bundle;
    const bundle = code.then(raw => this.widgets.resolveMedia(raw));
    bundle.catch(() => this.linked.delete(key));
    this.linked.set(key, { at: Date.now(), bundle });
    return bundle;
  }
  subscribe(listener: (event: DimaEvent, layerId?: string) => void): () => void { return this.bus.subscribe(listener); }
  emit(event: DimaEvent, layerId?: string): void {
    this.bus.emit(event, layerId);
    // Like OBS, where the server sends fresh session data after each alert: preview alerts update the preview's
    // snapshot, so widgets that only read session totals (e.g. StreamElements goal widgets) react too.
    if (event.type === 'alert' && this.sessionData) {
      this.sessionData = sessionAfterAlert(this.sessionData, event.data);
      this.bus.emit({ type: 'session', data: this.sessionData }, layerId);
    }
  }
  async rpc(target: WidgetTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    const key = typeof params['key'] === 'string' ? params['key'] : '';
    if (method === 'store.get' || method === 'store.set') {
      if (!target.uses.includes('storage')) throw new Error('This widget did not ask for "storage" in widget.json');
      if (!key || key.length > 100) throw new Error('Store keys are 1–100 characters');
      const namespace = storeNamespace(target), scoped = `${namespace}:${key}`;
      // A widget that isn't saved yet (code editor) has no stored values: its preview store starts empty.
      const saved = namespace === 'se' || /^[a-f0-9]{24}$/.test(namespace);
      if (method === 'store.get') return this.previewStore.has(scoped) ? this.previewStore.get(scoped) : saved ? this.widgets.storeGet(namespace, key) : null;
      const value = params['value'] ?? null;
      if (JSON.stringify(value).length > MAX_VALUE_BYTES) throw new Error('Store values are limited to 64 KB');
      this.previewStore.set(scoped, structuredClone(value));
      this.bus.emit({ type: 'storage', data: { key, value, namespace: storeNamespace(target) } });
      return true;
    }
    if (method === 'counters.get') {
      if (!target.uses.includes('counters')) throw new Error('This widget did not ask for "counters" in widget.json');
      return this.widgets.counter(String(params['name'] ?? ''));
    }
    throw new Error('Unknown request: ' + method);
  }
  session(): DimaSession | null { return this.sessionData; }
  /** Live state for previews (the channel's real polls/goals when loaded, or samples from the Test drawer). */
  private readonly stateData: Record<string, unknown> = {};
  states(): Record<string, unknown> { return { ...this.stateData }; }
  /** Sets one live state for the preview and sends it to running frames. */
  setState(name: DimaState['name'], value: unknown, layerId?: string): void {
    this.stateData[name] = value;
    this.bus.emit({ type: 'state', data: { name, value } }, layerId);
  }
  /** Loads this channel's session snapshot (latest follower, recent events…) for widgets that use it. */
  async loadSession(): Promise<void> {
    try {
      const { goalSources, ...session } = await this.widgets.session();
      this.sessionData = session; this.serverSession = session; this.obsSession = null; this.goalSources.set(goalSources ?? {});
    } catch { this.sessionData = { data: {}, recents: [] }; }
    // Frames that started before the snapshot arrived get it now.
    this.bus.emit({ type: 'session', data: this.sessionData });
    // The channel's real live state for previews (a failed read leaves it unknown; hype train null = none running).
    try {
      const state = await this.widgets.liveState();
      for (const name of STATE_TESTS) if (state[name] !== undefined && (state[name] !== null || name === 'hypetrain')) this.setState(name, state[name]);
    } catch { /* unknown until a sample is sent */ }
  }
  report(layerId: string, update: { status?: WidgetStatus; entry?: WidgetLogEntry }): void {
    this.logs.update(all => {
      const current = all[layerId] ?? { status: 'loading', errors: 0, entries: [] };
      return { ...all, [layerId]: {
        status: update.status ?? current.status,
        errors: current.errors + (update.entry?.level === 'error' ? 1 : 0),
        entries: update.entry ? [...current.entries, update.entry].slice(-MAX_ENTRIES) : current.entries
      } };
    });
  }
  clearLog(layerId: string): void { this.logs.update(all => all[layerId] ? { ...all, [layerId]: { ...all[layerId], errors: 0, entries: [] } } : all); }
  /** Forget cached code after files are replaced. */
  invalidate(widgetId: string): void {
    for (const map of [this.bundles, this.linked]) for (const key of [...map.keys()]) if (key.startsWith(widgetId + ':')) map.delete(key);
  }

  /** Test events for the Test drawer; the editor sends them to the preview or to OBS. */
  chatTest(kind: ChatTest): DimaEvent {
    const message = testChat(kind, this.lastChat);
    if (kind !== 'command') this.lastChat = message;
    return { type: 'chat', data: message };
  }
  alertTest(kind: AlertTest): DimaEvent { return { type: 'alert', data: testAlert(kind) }; }
  /** The session snapshot OBS should show after a test alert sent there. */
  obsSessionAfter(alert: DimaAlert): DimaSession | null {
    const base = this.obsSession ?? this.serverSession;
    return base ? this.obsSession = sessionAfterAlert(base, alert) : null;
  }
  deleteTest(): DimaEvent | null { return this.lastChat ? { type: 'chat.delete', data: { messageId: this.lastChat.id, userId: this.lastChat.user.id } } : null; }
  clearTest(): DimaEvent { return { type: 'chat.clear', data: { userId: null } }; }
  /** A signal as a command would send it, from you (the streamer) as a Studio test. */
  signalTest(name: string, value: string, target: string | null, user: { id: string; login: string; name: string }): DimaEvent {
    const text = value.trim();
    let json: unknown = null;
    if (/^[-\d[{]|^(true|false)$/.test(text)) { try { const parsed: unknown = JSON.parse(text); json = typeof parsed === 'number' ? (Number.isFinite(parsed) ? parsed : null) : typeof parsed === 'boolean' || (parsed && typeof parsed === 'object') ? parsed : null; } catch { json = null; } }
    const signal: DimaSignal = { id: crypto.randomUUID(), name, value: text, json, args: text ? text.split(/\s+/) : [], at: Date.now(),
      user: { ...user, roles: { broadcaster: true, moderator: false, vip: false, subscriber: false } }, source: { kind: 'studio', name: 'Studio test' }, target };
    return { type: 'signal', data: signal };
  }
  pressButton(layerId: string, field: string, value: unknown): void { this.bus.emit({ type: 'button', data: { field, value } }, layerId); }
}
