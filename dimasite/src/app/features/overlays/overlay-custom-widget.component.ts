import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { LucideAngularModule, Puzzle } from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { resolveFieldData, type JsonObject } from './custom-widget-format.generated';
import { CustomWidgetsService } from './custom-widgets.service';
import type { WidgetRenderContext } from './overlay-widget-module';
import { eventUse, type DimaEvent } from './widget-runtime/dima-events';
import { buildFrameDocument, restrictedPolicy, rewriteValues } from './widget-runtime/frame-document';
import { OverlayApi } from './overlay-api.service';
import { CUSTOM_WIDGET_ENV, frameScripts, storeNamespace, type RuntimeBundle, type WidgetTarget } from './widget-runtime/widget-env';

const HEARTBEAT_LIMIT_MS = 10_000, PROBE_MS = 5_000;
const MAX_RELOADS = 3, RELOAD_WINDOW_MS = 5 * 60_000;
/** On stream: how long a frame whose widget reads session data waits for the server's first snapshot before starting. */
const SESSION_WAIT_MS = 2500;
const MAX_BUFFERED = 100, MAX_RPC_PER_SECOND = 30, MAX_LOGS_PER_MINUTE = 200, MAX_RPC_BYTES = 64_000;
const LEVELS = new Set(['info', 'warn', 'error', 'debug']);

/**
 * Hosts one custom widget layer in a sandboxed frame (scripts only, opaque origin): no access to the site, its login
 * or other layers. Messages are accepted only from this frame's window. OBS gives every frame its page-control API
 * (`window.obsstudio`, limited by the browser source's Page permissions); the SDK removes it before the widget runs,
 * but an inner frame or a page the widget opens would get a fresh copy. "Block outside connections" also blocks inner
 * frames, outside loads and stops a widget that opens another page (frame-document.ts).
 */
@Component({
  selector: 'app-overlay-custom-widget',
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { position:relative; display:block; width:100%; height:100% }
    .frame-slot { position:absolute; inset:0 }
    .note { box-sizing:border-box; position:absolute; inset:0; display:grid; place-content:center; justify-items:center; gap:14px; padding:24px; text-align:center;
      border:3px dashed rgba(196,181,253,.75); border-radius:24px; background:rgba(23,26,33,.72); color:#f5f7fb; font-family:'Plus Jakarta Sans','Segoe UI',system-ui,sans-serif }
    .note--error { border-color:rgba(252,165,165,.85) }
    .icon { display:grid; place-items:center; width:72px; height:72px; border-radius:20px; background:rgba(139,92,246,.28); color:#c4b5fd }
    strong { font-size:30px; font-weight:800; line-height:1.15; overflow-wrap:anywhere }
    small { max-width:30ch; color:#d4d8e3; font-size:20px; font-weight:600; line-height:1.35 }
  `,
  template: `
    <div class="frame-slot" [attr.data-custom-frame]="status()"></div>
    @if (context().preview && (status() === 'loading' || status() === 'error' || status() === 'stopped' || !env)) {
      <div class="note" [class.note--error]="status() === 'error' || status() === 'stopped'" data-custom-placeholder [attr.data-status]="status()">
        <span class="icon" aria-hidden="true"><lucide-icon [img]="icon" [size]="38" /></span>
        <strong>{{ name() }}</strong>
        <small>{{ t(missing() ? 'customMissingCanvas' : status() === 'loading' ? 'customLoadingCanvas' : 'customErrorCanvas') }}</small>
      </div>
    }
  `
})
export class OverlayCustomWidgetComponent {
  readonly context = input.required<WidgetRenderContext>();
  /** Code editor preview: run this unsaved code instead of loading the layer's widget. */
  readonly draft = input<RuntimeBundle | null>(null);
  readonly env = inject(CUSTOM_WIDGET_ENV, { optional: true });
  private readonly overlayApi = inject(OverlayApi);
  private readonly widgets = inject(CustomWidgetsService);
  private readonly language = inject(LanguageService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly icon = Puzzle;
  readonly status = signal<'loading' | 'running' | 'error' | 'stopped'>('loading');

  private readonly widgetId = computed(() => String(this.context().widget.config?.['widgetId'] ?? ''));
  private readonly source = computed(() => this.widgets.widget(this.widgetId()));
  /** Published layers pin a revision; editor layers follow the widget's latest files. */
  private readonly revision = computed(() => {
    const pinned = this.context().widget.config?.['revision'];
    return typeof pinned === 'number' ? pinned : this.source()?.revision;
  });
  private readonly overrides = computed<JsonObject>(() => {
    const values = this.context().widget.config?.['values'];
    return values && typeof values === 'object' && !Array.isArray(values) ? values as JsonObject : {};
  });
  /** Editor only: copying a widget's files to storage changes this, and the frame restarts with the copies. */
  /** Editor: copied files or the "Block outside connections" choice changed → load the widget again. */
  private readonly mediaKey = computed(() => this.env?.mode === 'editor' ? JSON.stringify([this.source()?.media ?? {}, this.source()?.network ?? 'open']) : '');
  readonly missing = computed(() => this.env?.mode === 'editor' && this.widgets.list() !== null && !this.source());
  readonly name = computed(() => this.context().widget.name || this.source()?.name || this.t('customName'));

  private bundle: RuntimeBundle | null = null;
  /** ID of the current frame run; messages from older runs are ignored. */
  private exec = '';
  private frame: HTMLIFrameElement | null = null;
  private loaded = false;
  private sessionWait: { frame: HTMLIFrameElement; timer: ReturnType<typeof setTimeout> } | null = null;
  private buffered: DimaEvent[] = [];
  private probe: { token: string; answered: boolean } | null = null;
  private readonly rouletteDelivered = new Set<string>();
  private previewOverrides: JsonObject = {};
  private lastBeat = 0;
  private reloads: number[] = [];
  private rpcWindow = { at: 0, count: 0 };
  private logWindow = { at: 0, count: 0, dropped: 0 };
  private loadToken = 0;
  private fieldsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const destroy = inject(DestroyRef);
    const onMessage = (event: MessageEvent) => this.receive(event);
    window.addEventListener('message', onMessage);
    const unsubscribe = this.env?.subscribe((event, layerId) => this.deliver(event, layerId));
    // OBS: the owner changed this widget's load rules; load its code again (the published revision stays the same).
    const offReload = this.env?.onReload?.(widgetId => { if (widgetId === this.widgetId() && !this.draft()) void this.load(widgetId, this.revision()); });
    const watchdog = setInterval(() => this.checkHeartbeat(), 2000);
    destroy.onDestroy(() => {
      window.removeEventListener('message', onMessage); unsubscribe?.(); offReload?.(); clearInterval(watchdog);
      if (this.fieldsTimer) clearTimeout(this.fieldsTimer);
      this.clearSessionWait(); this.removeFrame();
    });
    // New widget, revision or copied files (or new draft code): load its code and start a fresh frame.
    effect(() => {
      const draft = this.draft();
      if (draft) { untracked(() => void this.loadDraft(draft)); return; }
      const widgetId = this.widgetId(), revision = this.revision();
      this.mediaKey();
      untracked(() => void this.load(widgetId, revision));
    });
    // Settings changed (editor): Dima widgets update live, StreamElements widgets reload like on StreamElements.
    effect(() => {
      this.overrides();
      untracked(() => this.settingsChanged());
    });
  }
  t(key: string): string { return this.language.translate('overlayStudio.' + key); }

  private target(): WidgetTarget | null {
    const bundle = this.bundle;
    return bundle ? { layerId: this.context().widget.id, widgetId: bundle.widgetId, revision: bundle.revision, engine: bundle.engine, uses: bundle.manifest.uses } : null;
  }
  private values(): JsonObject {
    const bundle = this.bundle!;
    return resolveFieldData(bundle.fields, bundle.data, { ...this.overrides(), ...this.previewOverrides });
  }
  /** Setting values as the frame sees them: copied files point at our storage. */
  private frameValues(): JsonObject { return rewriteValues(this.values(), this.bundle!.media); }
  private async load(widgetId: string, revision: number | undefined): Promise<void> {
    const token = ++this.loadToken;
    this.removeFrame(); this.bundle = null; this.previewOverrides = {}; this.buffered = [];
    if (!this.env || !/^[a-f0-9]{24}$/.test(widgetId) || (this.env.mode === 'editor' && revision === undefined)) { this.status.set('loading'); return; }
    this.status.set('loading'); this.report({ status: 'loading' });
    try {
      const [bundle, scripts] = await Promise.all([this.env.bundle(widgetId, revision), frameScripts()]);
      if (token !== this.loadToken) return;
      this.bundle = bundle;
      this.createFrame(scripts);
    } catch (error) {
      if (token !== this.loadToken) return;
      this.status.set('error');
      this.report({ status: 'error', entry: { at: Date.now(), level: 'error', text: this.t('customLoadError') + (error instanceof Error && error.message ? ` (${error.message})` : '') } });
    }
  }
  private async loadDraft(bundle: RuntimeBundle): Promise<void> {
    const token = ++this.loadToken;
    this.removeFrame(); this.bundle = bundle; this.previewOverrides = {}; this.buffered = [];
    this.status.set('loading'); this.report({ status: 'loading' });
    try {
      const scripts = await frameScripts();
      if (token === this.loadToken) this.createFrame(scripts);
    } catch (error) {
      if (token !== this.loadToken) return;
      this.status.set('error');
      this.report({ status: 'error', entry: { at: Date.now(), level: 'error', text: this.t('customLoadError') + (error instanceof Error && error.message ? ` (${error.message})` : '') } });
    }
  }
  private createFrame(scripts: Awaited<ReturnType<typeof frameScripts>>): void {
    const bundle = this.bundle; if (!bundle) return;
    this.removeFrame();
    this.exec = crypto.randomUUID();
    const boot = { exec: this.exec, origin: location.origin, apiOrigin: this.overlayApi.base };
    const restricted = bundle.network === 'restricted';
    const html = buildFrameDocument({ ...bundle, uses: bundle.manifest.uses }, this.values(), scripts, boot);
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('allow', 'autoplay');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', this.name());
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    // Matching colour schemes keeps the frame transparent on dark pages.
    Object.assign(frame.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0', background: 'transparent', colorScheme: 'normal' });
    // Restricted: the same policy on the frame itself, so a page it opens must run under it too. After each load the
    // frame must answer as the document we built (a page it opened, even before its first load, can't); a second
    // load (another page or a reload) stops the widget. Containment: the request for that page has already gone out.
    if (restricted) {
      frame.setAttribute('csp', restrictedPolicy(boot));
      let loads = 0;
      frame.addEventListener('load', () => {
        if (this.frame !== frame) return;
        if (++loads > 1) { this.stopNavigated(); return; }
        const token = crypto.randomUUID(), exec = this.exec;
        this.probe = { token, answered: false };
        this.post({ type: 'probe', token });
        setTimeout(() => { if (this.frame === frame && this.exec === exec && this.probe?.token === token && !this.probe.answered) this.stopNavigated(); }, PROBE_MS);
      });
    }
    frame.srcdoc = html;
    this.clearSessionWait(); this.loaded = false; this.lastBeat = Date.now(); this.rouletteDelivered.clear();
    this.host.nativeElement.querySelector('.frame-slot')!.append(frame);
    this.frame = frame;
  }
  private removeFrame(): void { this.clearSessionWait(); this.frame?.remove(); this.frame = null; this.loaded = false; }
  private clearSessionWait(): void { if (this.sessionWait) clearTimeout(this.sessionWait.timer); this.sessionWait = null; }
  private reload(): void {
    if (!this.bundle) return;
    void frameScripts().then(scripts => this.createFrame(scripts));
  }
  private post(message: Record<string, unknown>): void { this.frame?.contentWindow?.postMessage({ dima: 1, exec: this.exec, ...message }, '*'); }

  private settingsChanged(): void {
    if (!this.bundle || !this.frame) return;
    if (this.fieldsTimer) clearTimeout(this.fieldsTimer);
    this.fieldsTimer = setTimeout(() => {
      this.fieldsTimer = null;
      if (!this.bundle) return;
      if (this.bundle.engine === 'dima' && this.loaded) this.post({ type: 'fields', fields: this.frameValues() });
      else this.reload();
    }, this.bundle.engine === 'dima' ? 60 : 300);
  }
  private deliver(event: DimaEvent, layerId?: string): void {
    const bundle = this.bundle;
    if (!bundle || layerId !== undefined && layerId !== this.context().widget.id) return;
    const use = eventUse(event);
    if (use && !bundle.manifest.uses.includes(use as never)) return;
    // widget.signal.to: only layers with that name (OBS already got matched layer IDs; this covers Studio previews).
    if (event.type === 'signal' && event.data.target !== null && event.data.target.trim().toLocaleLowerCase() !== (this.context().widget.name ?? '').trim().toLocaleLowerCase()) return;
    // Store updates reach only widgets sharing that store (all StreamElements widgets, or this Dima widget).
    if (event.type === 'storage' && event.data.namespace !== undefined && event.data.namespace !== storeNamespace(bundle)) return;
    // StreamElements has no "whole chat cleared" event: start such widgets fresh instead.
    if (event.type === 'chat.clear' && !event.data.userId && bundle.engine === 'streamelements') { this.reload(); return; }
    // Studio's widget log notes each command signal (the widget may not log anything itself).
    if (event.type === 'signal' && this.env?.mode === 'editor') {
      const { name, value, user } = event.data;
      this.report({ entry: { at: Date.now(), level: 'info', text: this.t(user ? 'customLogSignalFrom' : 'customLogSignal')
        .replace('{{name}}', name).replace('{{value}}', value.length > 80 ? value.slice(0, 79) + '…' : value || '—').replace('{{user}}', user?.name ?? '') } });
    }
    if (!this.loaded) {
      // The snapshot a waiting frame was held for: start it now, replay what arrived meanwhile, then the snapshot itself
      // (it already counts those events, so it has the last word).
      if (event.type === 'session' && this.sessionWait?.frame === this.frame) { this.clearSessionWait(); this.started(true); this.postEvent(event); return; }
      if (this.buffered.length < MAX_BUFFERED) this.buffered.push(event);
      return;
    }
    this.postEvent(event);
  }
  /** Roulette phases can arrive twice (replayed after a restart or for a late frame): each frame gets each phase once. */
  private postEvent(event: DimaEvent): void {
    if (event.type === 'roulette') {
      const key = `${event.data.id}:${event.data.phase}`;
      if (this.rouletteDelivered.has(key)) return;
      this.rouletteDelivered.add(key);
      if (this.rouletteDelivered.size > 200) this.rouletteDelivered.delete(this.rouletteDelivered.values().next().value!);
    }
    this.post({ type: 'event', event });
  }
  private receive(event: MessageEvent): void {
    if (!this.frame || event.source !== this.frame.contentWindow) return;
    const message = event.data as Record<string, unknown> | null;
    if (!message || message['dima'] !== 1 || typeof message['type'] !== 'string' || message['exec'] !== this.exec) return;
    switch (message['type']) {
      case 'loaded': return this.started();
      case 'heartbeat': this.lastBeat = Date.now(); return;
      case 'probe-ok': if (this.probe && message['token'] === this.probe.token) this.probe.answered = true; return;
      case 'log': return this.log(String(message['level']), message['args']);
      case 'error': {
        const text = String(message['message'] ?? 'Error').slice(0, 500) + (typeof message['line'] === 'number' ? ` (line ${message['line']})` : '');
        return this.report({ entry: { at: Date.now(), level: 'error', text } });
      }
      case 'rpc': return void this.call(message);
    }
  }
  private started(waited = false): void {
    const bundle = this.bundle; if (!bundle || this.loaded || !this.frame) return;
    // StreamElements always has session data in onWidgetLoad, and many widgets read it without checking. On stream the
    // server sends it right after connecting or a republish, so a widget that's ready first waits a moment for it.
    if (!waited && this.env?.mode === 'live' && bundle.manifest.uses.includes('session') && !this.env.session()) {
      if (this.sessionWait?.frame === this.frame) return;
      this.clearSessionWait();
      const frame = this.frame;
      this.sessionWait = { frame, timer: setTimeout(() => { if (this.sessionWait?.frame === frame && this.frame === frame) { this.sessionWait = null; this.started(true); } }, SESSION_WAIT_MS) };
      return;
    }
    this.clearSessionWait();
    this.loaded = true; this.lastBeat = Date.now();
    const layer = this.context().widget;
    this.post({ type: 'init', context: {
      widget: { id: bundle.widgetId, layerId: layer.id, name: layer.name || bundle.manifest.name || '', revision: bundle.revision },
      channel: bundle.channel, fields: this.frameValues(), mode: this.env!.mode, muted: false,
      session: bundle.manifest.uses.includes('session') ? this.env!.session() : null,
      // Live state this widget may read (polls, goals), as last known.
      states: Object.fromEntries(Object.entries(this.env!.states()).filter(([name]) => bundle.manifest.uses.includes(name as never)))
    } });
    // Spins and results that arrived before this frame could take them (still loading, or reloaded).
    if (bundle.manifest.uses.includes('roulette')) for (const event of this.env!.recent?.() ?? []) this.postEvent(event);
    for (const event of this.buffered.splice(0)) this.postEvent(event);
    this.status.set('running'); this.report({ status: 'running' });
  }
  private log(level: string, args: unknown): void {
    const now = Date.now();
    if (now - this.logWindow.at > 60_000) {
      if (this.logWindow.dropped) this.report({ entry: { at: now, level: 'warn', text: this.t('customLogsDropped').replace('{{count}}', String(this.logWindow.dropped)) } });
      this.logWindow = { at: now, count: 0, dropped: 0 };
    }
    if (++this.logWindow.count > MAX_LOGS_PER_MINUTE) { this.logWindow.dropped++; return; }
    const text = (Array.isArray(args) ? args : []).map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ').slice(0, 2000);
    this.report({ entry: { at: now, level: LEVELS.has(level) ? level as 'info' : 'info', text } });
  }
  private async call(message: Record<string, unknown>): Promise<void> {
    const id = message['id'], method = String(message['method'] ?? ''), params = message['params'];
    if (typeof id !== 'number') return;
    // A reload while a request is pending must not hand its answer to the new frame.
    const frame = this.frame, exec = this.exec;
    const reply = (ok: boolean, value?: unknown, error?: string) => {
      if (this.frame === frame && this.exec === exec) this.post({ type: 'rpc-result', id, ok, value, error });
    };
    const now = Date.now();
    if (now - this.rpcWindow.at > 1000) this.rpcWindow = { at: now, count: 0 };
    if (++this.rpcWindow.count > MAX_RPC_PER_SECOND) return reply(false, undefined, 'Too many requests');
    let size = 0; try { size = JSON.stringify(params ?? {}).length; } catch { return reply(false, undefined, 'Invalid request'); }
    if (size > MAX_RPC_BYTES || !params || typeof params !== 'object' || Array.isArray(params)) return reply(false, undefined, 'Request too large');
    const target = this.target(); if (!target) return reply(false, undefined, 'Widget not ready');
    if (method === 'field.set') {
      if (this.env?.mode !== 'editor') return reply(false, undefined, 'setField only works in the editor');
      const { key, value, reload } = params as { key?: unknown; value?: unknown; reload?: unknown };
      if (typeof key !== 'string' || !key) return reply(false, undefined, 'Invalid setting');
      this.previewOverrides = { ...this.previewOverrides, [key]: value as JsonObject[string] };
      reply(true, true);
      if (reload !== false) this.reload(); else this.post({ type: 'fields', fields: this.frameValues() });
      return;
    }
    if (method === 'queue.done') return reply(true, true);
    try { reply(true, await this.env!.rpc(target, method, params as Record<string, unknown>)); }
    catch (error) { reply(false, undefined, error instanceof Error ? error.message : 'Request failed'); }
  }
  private stopNavigated(): void {
    this.removeFrame(); this.status.set('stopped');
    this.report({ status: 'stopped', entry: { at: Date.now(), level: 'error', text: this.t('customStoppedNavigated') } });
  }
  private checkHeartbeat(): void {
    if (!this.frame || !this.loaded || Date.now() - this.lastBeat < HEARTBEAT_LIMIT_MS) return;
    const now = Date.now();
    this.reloads = this.reloads.filter(at => now - at < RELOAD_WINDOW_MS);
    if (this.reloads.length >= MAX_RELOADS) {
      this.removeFrame(); this.status.set('stopped');
      this.report({ status: 'stopped', entry: { at: now, level: 'error', text: this.t('customStopped') } });
      return;
    }
    this.reloads.push(now);
    this.report({ entry: { at: now, level: 'warn', text: this.t('customRestarted') } });
    this.reload();
  }
  private report(update: Parameters<NonNullable<typeof this.env>['report']>[1]): void { this.env?.report(this.context().widget.id, update); }
}
