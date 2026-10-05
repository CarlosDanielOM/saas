import { OverlayImageCache, type PreparedImage } from './overlay-image-cache';
import { OverlaySoundComponent } from './overlay-sound.component';
import type { QueueState, QueueCommand, OverlayPlatform } from './overlay-queue.model';
import { Component, ChangeDetectionStrategy, DestroyRef, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TimeoutError } from 'rxjs';
import { DOCUMENT } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { io } from 'socket.io-client';
import { OverlayApi, Snapshot } from './overlay-api.service';
import { OverlayClipComponent } from './overlay-clip.component';
import { OverlayMediaComponent, TestMedia } from './overlay-media.component';
import { OverlayLayerComponent } from './overlay-layer.component';
import { LanguageService } from '../../services/language.service';
import { matchesTrigger, type AlertEvent, type AlertLayout, type EventKind, type OverlayWidget } from './overlay.model';
import { clipPlaybackLimit } from './overlay-clip-motion';
import { placeTrigger } from './overlay-trigger-placement';
interface Event { platform?: OverlayPlatform; serialized?: boolean; id: string; kind: EventKind; triggerId?: string; media?: TestMedia; text?: string; layouts?: Record<string, AlertLayout>; snapshot?: Snapshot; revision?: number }
interface Retry { attempts: number; timer?: ReturnType<typeof setTimeout> }
const retryDelay = (attempt: number) => Math.min(1000 * 2 ** Math.min(attempt, 5), 30000);
const retryable = (error: unknown) => error instanceof TimeoutError || error instanceof HttpErrorResponse && (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);
interface Playing { images: Map<string, PreparedImage>; event: Event; widgets: OverlayWidget[]; snapshot: Snapshot; pending: Set<string>; timers: Map<string, ReturnType<typeof setTimeout>> }
@Component({
  selector: 'app-overlay-runtime', imports: [OverlaySoundComponent, OverlayMediaComponent, OverlayLayerComponent, OverlayClipComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (snapshot(); as scene) {
    <div class="canvas" [style.width.px]="scene.width" [style.height.px]="scene.height">
      @for (w of scene.widgets; track w.id) { @if (w.visible && ['image','video','text','shape'].includes(w.kind)) {
        <div class="placement art" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="scene.widgets.indexOf(w)"><app-overlay-layer [publicId]="publicId" [layer]="w" (failed)="reportIssue('media')" /></div>
      } }
      @for (job of playing(); track job.event.id) {
        @for (sound of soundsFor(job); track sound.id) { <app-overlay-sound [sound]="sound.config" [duration]="sound.duration" [playbackKey]="job.event.id" [publicId]="publicId" (failed)="reportIssue('media')" (playbackBlocked)="reportIssue('autoplay')" (started)="soundStarted()" /> }
        @for (w of job.widgets; track w.id) {
          <div class="placement" [attr.data-event]="job.event.kind" [attr.data-platform]="job.event.platform ?? 'twitch'" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="job.snapshot.widgets.findIndex(indexOfId(w.id))">
            @if (job.event.media; as media) {
              @if (job.event.kind === 'clip') {
                <app-overlay-clip [design]="w.clipDesign ?? 'classic'" [media]="media" [muted]="job.widgets[0].id !== w.id"
                  (started)="started(job.event.id, w.id, $event)" (playbackBlocked)="reportIssue('autoplay')" (ended)="finishPlacement(job.event.id,w.id)" (failed)="failedPlacement(job.event.id,w.id)" />
              } @else {
              <app-overlay-media [media]="media" [muted]="job.widgets[0].id !== w.id" [showTitle]="job.event.kind !== 'tts'" [showAudioLabel]="job.event.kind !== 'tts'" [playLabel]="playLabel()" (started)="started(job.event.id, w.id, $event)" (playbackBlocked)="reportIssue('autoplay')" (ended)="finishPlacement(job.event.id,w.id)" (failed)="failedPlacement(job.event.id,w.id)" />
              }
              @if (job.event.kind === 'tts' && w.showTtsText === true) { <div class="speech-text">{{ job.event.text }}</div> }
            } @else {
              @if (job.event.layouts?.[w.designId || '']; as layout) {
                @for (part of layout.widgets; track part.id) { @if(part.visible) {
                  <div class="placement art" [style.left.%]="part.x / designWidth(job,w) * 100" [style.top.%]="part.y / designHeight(job,w) * 100" [style.width.%]="part.width / designWidth(job,w) * 100" [style.height.%]="part.height / designHeight(job,w) * 100"><app-overlay-layer [publicId]="publicId" [layer]="part" [preparedImage]="job.images.get(part.assetId || '')?.url || ''" [playbackKey]="job.event.id" [duration]="layout.duration" (failed)="reportIssue('media')" /></div>
                } }
              }
            }
          </div>
        }
      }
    </div>
  }`,
  styles: `:host { display:block; margin:0; padding:0; background:transparent } .canvas { position:relative; overflow:hidden; font-family:'Plus Jakarta Sans',sans-serif } .placement { position:absolute; overflow:hidden } .placement.art { overflow:visible } app-overlay-sound { position:relative; z-index:1000 } app-overlay-media { background:transparent } .speech-text { position:absolute; inset:0; display:grid; place-content:center; color:white; background:#171a21cc; font-size:28px; padding:12px; text-align:center; white-space:pre-wrap; overflow-wrap:anywhere; pointer-events:none }`
})
export class OverlayRuntimeComponent {
  readonly snapshot = signal<Snapshot | null>(null);
  readonly playing = signal<Playing[]>([]);
  private readonly api = inject(OverlayApi);
  private readonly imageCache = new OverlayImageCache();
  private readonly language = inject(LanguageService);
  readonly publicId = inject(ActivatedRoute).snapshot.paramMap.get('publicId') || '';
  private readonly receiptKey = 'overlay-playback:' + this.publicId;
  private readonly receipts = this.readReceipts();
  private clientId = this.receipts.clientId;
  private releaseIdentity?: () => void;
  private readonly socket = io(`${this.api.base}/overlay-studio/${this.publicId}`, { auth: { clientId: this.clientId }, transports: ['websocket'], autoConnect: false });
  private queue: Event[] = [];
  private inFlight = new Map<string, Event>();
  private eventRetries = new Map<string, Retry>();
  private queueState: QueueState = { revision: -1, all: false, platforms: {} };
  private commands = new Set<string>();
  private batching = false;
  private seen = new Set<string>();
  private completed = new Set<string>(this.receipts.completed);
  private active: string | null = null;
  private disposed = false;
  private revision = -1;
  private targetRevision = -1;
  private refreshing = false;
  private snapshotRetry: Retry = { attempts: 0 };
  private generation = 0;
  private issue: 'snapshot' | 'event' | 'media' | 'autoplay' | null = null;
  constructor() {
    const doc = inject(DOCUMENT); const oldBody = doc.body.style.background, oldRoot = doc.documentElement.style.background;
    doc.body.style.background = 'transparent'; doc.documentElement.style.background = 'transparent';
    const referrer = doc.createElement('meta'); referrer.name = 'referrer'; referrer.content = 'no-referrer'; doc.head.append(referrer);
    this.socket.on('overlay-state', state => {
      this.batching = true;
      if (state.revision >= this.revision) { this.revision = state.revision; this.snapshot.set(state.snapshot); this.warmImages(state.snapshot); this.snapshotRecovered(); }
      if (Array.isArray(state.pendingIds)) {
        const retained = new Set<string>(state.pendingIds);
        for (const event of [...this.queue, ...this.inFlight.values()]) if (!retained.has(event.id)) this.finish(event.id);
      }
      this.applyQueueState(state.controls);
      for (const command of state.commands ?? []) this.applyControl(command);
      this.batching = false; this.next(); this.reportHealth(); this.reportPlayback();
    });
    this.socket.on('overlay-queue-state', (state: QueueState) => this.applyQueueState(state));
    this.socket.on('overlay-control', (command: QueueCommand) => this.applyControl(command));
    this.socket.on('overlay-updated', (state?: { revision: number }) => {
      this.targetRevision = Math.max(this.targetRevision, state?.revision ?? this.revision + 1);
      void this.refresh();
    });
    this.socket.on('overlay-event', (event: Event) => this.enqueue(event));
    this.socket.on('overlay-expired', (ids: string[]) => { for (const id of ids) this.finish(id); });
    this.socket.on('overlay-revoked', () => this.clear());
    this.socket.on('disconnect', reason => { if (reason === 'io server disconnect') this.clear(); });
    this.saveReceipts();
    const healthTimer = setInterval(() => { this.saveReceipts(); this.reportHealth(); this.reportPlayback(); }, 15000);
    if (/^[a-f0-9]{48}$/.test(this.publicId)) this.connectSource();
    inject(DestroyRef).onDestroy(() => { this.disposed = true; this.releaseIdentity?.(); clearInterval(healthTimer); this.clear(); this.socket.disconnect(); doc.body.style.background = oldBody; doc.documentElement.style.background = oldRoot; referrer.remove(); });
  }
  private connectSource(): void {
    // Duplicated tabs inherit sessionStorage. A live tab holds its identity;
    // refreshing releases the lock, while a second source receives a fresh ID.
    if (!navigator.locks) { this.socket.connect(); return; }
    void navigator.locks.request('overlay-source:' + this.clientId, { ifAvailable: true }, async lock => {
      if (this.disposed) return;
      if (!lock) {
        this.clientId = crypto.randomUUID(); this.completed.clear(); this.seen.clear();
        this.socket.auth = { clientId: this.clientId }; this.saveReceipts(); this.connectSource(); return;
      }
      await new Promise<void>(resolve => { this.releaseIdentity = resolve; this.saveReceipts(); this.socket.connect(); });
    }).catch(() => { if (!this.disposed) this.socket.connect(); });
  }
  private readReceipts(): { clientId: string; completed: string[] } {
    try {
      const value = JSON.parse(sessionStorage.getItem(this.receiptKey) || 'null');
      if (value && typeof value.clientId === 'string' && /^[a-f0-9-]{36}$/.test(value.clientId) && Array.isArray(value.completed)
        && Date.now() - value.at < 30 * 60 * 1000) return { clientId: value.clientId, completed: value.completed.filter((id: unknown) => typeof id === 'string').slice(-512) };
    } catch { /* Storage is optional; live reconnect still works. */ }
    return { clientId: crypto.randomUUID(), completed: [] };
  }
  private saveReceipts(): void {
    try { sessionStorage.setItem(this.receiptKey, JSON.stringify({ clientId: this.clientId, completed: [...this.completed], at: Date.now() })); } catch { /* Restricted browser storage. */ }
  }
  private reportHealth(): void {
    if (this.socket.connected && this.revision >= 0) this.socket.emit('overlay-health', { revision: this.revision, issue: this.issue });
  }
  reportIssue(issue: 'snapshot' | 'event' | 'media' | 'autoplay'): void { this.issue = issue; this.reportHealth(); }
  failedPlacement(id: string, widget: string): void { this.reportIssue('media'); this.finishPlacement(id, widget); }
  playLabel() { return this.language.translate('overlayStudio.tapToPlay'); }
  indexOfId(id: string) { return (w: OverlayWidget) => w.id === id; }
  designWidth(job: Playing, w: OverlayWidget) { return job.snapshot.designs.find(d => d.id === w.designId)?.width || 800; }
  designHeight(job: Playing, w: OverlayWidget) { return job.snapshot.designs.find(d => d.id === w.designId)?.height || 240; }
  private snapshotRecovered(): void {
    if (this.revision < this.targetRevision) return;
    clearTimeout(this.snapshotRetry.timer);
    this.snapshotRetry = { attempts: 0 };
    if (this.issue === 'snapshot') this.issue = null;
  }
  private async refresh() {
    if (this.disposed || this.refreshing || this.revision >= this.targetRevision) return;
    clearTimeout(this.snapshotRetry.timer);
    this.refreshing = true;
    const generation = this.generation;
    let shouldRetry = true;
    try {
      const state = await this.api.request<{ revision: number; snapshot: Snapshot }>('GET', `public/${this.publicId}`);
      if (this.disposed || generation !== this.generation) return;
      if (state.revision >= this.revision) {
        this.revision = state.revision; this.snapshot.set(state.snapshot); this.warmImages(state.snapshot);
        this.snapshotRecovered(); this.reportHealth();
      }
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      if (this.revision < this.targetRevision) this.reportIssue('snapshot');
      shouldRetry = retryable(error);
    } finally {
      if (!this.disposed && generation === this.generation) {
        this.refreshing = false;
        // A newer publication can arrive while the previous request is still running.
        if (shouldRetry && this.revision < this.targetRevision) {
          this.snapshotRetry.timer = setTimeout(() => void this.refresh(), retryDelay(this.snapshotRetry.attempts++));
        }
      }
    }
  }
  private reportPlayback(): void {
    if (this.socket.connected) this.socket.emit('overlay-playback', { active: [...this.inFlight.keys(), ...this.playing().map(job => job.event.id)].slice(0, 5000), queued: this.queue.map(event => event.id).slice(0, 5000) });
  }
  private paused(event: Event): boolean { return this.queueState.platforms[event.platform ?? 'twitch'] ?? this.queueState.all; }
  private applyQueueState(state?: QueueState): void {
    if (state && state.revision >= this.queueState.revision) this.queueState = { ...state, all: state.all ?? false, platforms: state.platforms ?? {} };
    this.next(); this.reportPlayback();
  }
  private applyControl(command: QueueCommand): void {
    if (!command || !['skip', 'clear'].includes(command.action) || !Array.isArray(command.eventIds)) return;
    if (!this.commands.has(command.id)) {
      this.commands.add(command.id);
      if (this.commands.size > 512) this.commands.delete(this.commands.values().next().value!);
      const previous = this.batching; this.batching = true;
      const ids = new Set(command.eventIds);
      const active = new Set([...this.inFlight.keys(), ...this.playing().map(job => job.event.id)]);
      // Commands carry only IDs captured by the server for this source and platform.
      // A delayed/replayed clear must never discard a later arrival.
      const affected = command.action === 'skip' ? [...active].filter(id => ids.has(id)) : [...ids].filter(id => !active.has(id));
      for (const id of affected) this.finish(id);
      this.batching = previous;
      this.next(); this.reportPlayback();
    }
    this.socket.emit('overlay-control-ack', command.id);
  }
  private enqueue(event: Event) {
    if (this.completed.has(event.id)) { this.socket.emit('overlay-ended', event.id); return; }
    if (this.seen.has(event.id)) return; this.seen.add(event.id);
    this.queue.push({ ...event, platform: event.platform ?? 'twitch', serialized: this.snapshot()?.waitFor.includes(event.kind) ?? false });
    this.next(); this.reportPlayback();
  }
  private next() {
    if (this.batching || this.disposed) return;
    // A paused platform does not block eligible events from another platform.
    let index: number;
    while ((index = this.queue.findIndex(event => !this.paused(event) && (!event.serialized || !this.active))) >= 0) {
      const [event] = this.queue.splice(index, 1);
      if (event.serialized) this.active = event.id;
      this.inFlight.set(event.id, event);
      void this.start(event);
    }
    this.reportPlayback();
  }
  private async start(event: Event) {
    const generation = this.generation;
    try {
      const full = await this.api.request<Event>('GET', `public/${this.publicId}/events/${event.id}`);
      if (this.disposed || generation !== this.generation || this.completed.has(event.id)) return;
      this.cancelEventRetry(event.id);
      if (this.issue === 'event' && !this.eventRetries.size) { this.issue = null; this.reportHealth(); }
      const snapshot = full.snapshot ?? this.snapshot(); if (!snapshot) { this.finish(event.id); return; }
      const widgets = snapshot.widgets.filter(w => w.visible && (w.kind === event.kind && (event.kind !== 'trigger' || matchesTrigger(w, full.triggerId)) || w.kind === 'alert' && w.events?.includes(event.kind as AlertEvent)))
        .map(w => placeTrigger(w, snapshot, full.id));
      if (!widgets.length) { this.finish(event.id); return; }
      if (full.media?.url.startsWith('/')) full.media.url = this.api.base + full.media.url;
      const images = new Map<string, PreparedImage>();
      if (!full.media) {
        const ids = new Set(widgets.flatMap(w => full.layouts?.[w.designId || '']?.widgets ?? [])
          .filter(part => part.visible && part.kind === 'image' && part.assetId).map(part => part.assetId!));
        await Promise.all([...ids].map(async id => {
          const image = await this.imageCache.prepare(this.imageUrl(id));
          if (image) images.set(id, image);
        }));
      }
      if (this.disposed || generation !== this.generation || this.completed.has(event.id)) {
        images.forEach(image => image.release()); return;
      }
      this.inFlight.delete(event.id);
      const job: Playing = { images, event: full, snapshot, widgets, pending: new Set(widgets.map(w => w.id)), timers: new Map() };
      this.playing.update(all => [...all, job]); this.reportPlayback();
      for (const w of widgets) {
        const seconds = full.media ? 30 : full.layouts?.[w.designId || '']?.duration || 5;
        job.timers.set(w.id, setTimeout(() => this.finishPlacement(event.id, w.id), seconds * 1000));
      }
    } catch (error) {
      if (this.disposed || generation !== this.generation || this.completed.has(event.id)) return;
      this.reportIssue('event');
      if (!retryable(error)) { this.finish(event.id); return; }
      // Keep the serial slot and server receipt until playback succeeds or the user skips it.
      const retry = this.eventRetries.get(event.id) ?? { attempts: 0 };
      this.eventRetries.set(event.id, retry);
      retry.timer = setTimeout(() => {
        if (generation === this.generation && this.inFlight.has(event.id)) void this.start(event);
      }, retryDelay(retry.attempts++));
    }
  }
  private imageUrl(id: string): string {
    return `${this.api.base}/overlay-studio/public/${encodeURIComponent(this.publicId)}/assets/${encodeURIComponent(id)}`;
  }
  private warmImages(snapshot: Snapshot): void {
    const layouts = snapshot.widgets.filter(w => w.visible && w.kind === 'alert').flatMap(w => {
      const design = snapshot.designs.find(d => d.id === w.designId);
      return design ? (w.events ?? []).flatMap(event => [design.events?.[event],
        ...(design.variants?.[event] ?? []).filter(v => v.enabled).map(v => v.layout)]) : [];
    });
    this.imageCache.warm(layouts.flatMap(layout => layout?.widgets ?? [])
      .filter(w => w.visible && w.kind === 'image' && w.assetId).map(w => this.imageUrl(w.assetId!)));
  }
  private cancelEventRetry(id: string): void {
    clearTimeout(this.eventRetries.get(id)?.timer);
    this.eventRetries.delete(id);
  }
  started(id: string, widget: string, duration?: number) {
    const job = this.playing().find(p => p.event.id === id); if (!job) return;
    if (this.issue === 'media' || this.issue === 'autoplay') { this.issue = null; this.reportHealth(); }
    clearTimeout(job.timers.get(widget));
    const seconds = job.event.kind === 'clip' ? clipPlaybackLimit(job.event.media, duration) + 4
      : job.event.media?.type === 'image' ? 5 : job.event.media?.duration ?? (Number.isFinite(duration) && duration! > 0 ? duration! + 15 : 300);
    job.timers.set(widget, setTimeout(() => this.finishPlacement(id, widget), seconds * 1000));
  }
  soundsFor(job: Playing) {
    return [...new Set(job.widgets.filter(w => w.kind === 'alert').map(w => w.designId!))].flatMap(id => {
      const layout = job.event.layouts?.[id]; return layout?.sound ? [{ id, config: layout.sound, duration: layout.duration }] : [];
    });
  }
  soundStarted(): void { if (this.issue === 'media' || this.issue === 'autoplay') { this.issue = null; this.reportHealth(); } }
  finishPlacement(id: string, widget: string) {
    const job = this.playing().find(p => p.event.id === id); if (!job) return;
    job.pending.delete(widget); clearTimeout(job.timers.get(widget));
    if (!job.pending.size) this.finish(id);
  }
  private finish(id: string) {
    if (this.completed.has(id)) return;
    this.cancelEventRetry(id);
    this.seen.add(id); this.inFlight.delete(id); this.queue = this.queue.filter(event => event.id !== id);
    const job = this.playing().find(p => p.event.id === id); job?.timers.forEach(clearTimeout); job?.images.forEach(image => image.release());
    this.playing.update(all => all.filter(p => p.event.id !== id)); this.completed.add(id);
    while (this.completed.size > 512) { const oldest = this.completed.values().next().value!; this.completed.delete(oldest); this.seen.delete(oldest); }
    this.saveReceipts(); this.socket.emit('overlay-ended', id);
    // Retain receipts for this connection; reconnect replay must not play completed events twice.
    if (this.active === id) this.active = null;
    this.next(); this.reportPlayback();
  }
  private clear() { this.generation++; this.imageCache.clear(); this.playing().forEach(p => p.images.forEach(image => image.release())); clearTimeout(this.snapshotRetry.timer); this.snapshotRetry = { attempts: 0 }; this.targetRevision = -1; this.refreshing = false; this.eventRetries.forEach(retry => clearTimeout(retry.timer)); this.eventRetries.clear(); this.playing().forEach(p => p.timers.forEach(clearTimeout)); this.playing.set([]); this.queue = []; this.inFlight.clear(); this.active = null; this.snapshot.set(null); }
}
