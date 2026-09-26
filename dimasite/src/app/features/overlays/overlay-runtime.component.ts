import { Component, ChangeDetectionStrategy, DestroyRef, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { io } from 'socket.io-client';
import { OverlayApi, Snapshot } from './overlay-api.service';
import { OverlayMediaComponent, TestMedia } from './overlay-media.component';
import { OverlayLayerComponent } from './overlay-layer.component';
import { LanguageService } from '../../services/language.service';
import type { AlertEvent, AlertLayout, EventKind, OverlayWidget } from './overlay.model';
interface Event { id: string; kind: EventKind; media?: TestMedia; text?: string; layouts?: Record<string, AlertLayout>; snapshot?: Snapshot; revision?: number }
interface Playing { event: Event; widgets: OverlayWidget[]; snapshot: Snapshot; pending: Set<string>; timers: Map<string, ReturnType<typeof setTimeout>> }
@Component({
  selector: 'app-overlay-runtime', imports: [OverlayMediaComponent, OverlayLayerComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (snapshot(); as scene) {
    <div class="canvas" [style.width.px]="scene.width" [style.height.px]="scene.height">
      @for (w of scene.widgets; track w.id) { @if (w.visible && ['image','video','text'].includes(w.kind)) {
        <div class="placement" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="scene.widgets.indexOf(w)"><app-overlay-layer [publicId]="publicId" [layer]="w" /></div>
      } }
      @for (job of playing(); track job.event.id) {
        @for (w of job.widgets; track w.id) {
          <div class="placement" [attr.data-event]="job.event.kind" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="job.snapshot.widgets.findIndex(indexOfId(w.id))">
            @if (job.event.media; as media) {
              <app-overlay-media [media]="media" [muted]="job.widgets[0].id !== w.id" [playLabel]="playLabel()" (started)="started(job.event.id, w.id, $event)" (ended)="finishPlacement(job.event.id,w.id)" (failed)="finishPlacement(job.event.id,w.id)" />
              @if (job.event.kind === 'tts') { <div class="speech-text">{{ job.event.text }}</div> }
            } @else {
              @if (job.event.layouts?.[w.designId || '']; as layout) {
                @for (part of layout.widgets; track part.id) { @if(part.visible) {
                  <div class="placement" [style.left.%]="part.x / designWidth(job,w) * 100" [style.top.%]="part.y / designHeight(job,w) * 100" [style.width.%]="part.width / designWidth(job,w) * 100" [style.height.%]="part.height / designHeight(job,w) * 100"><app-overlay-layer [publicId]="publicId" [layer]="part" (failed)="finishPlacement(job.event.id,w.id)" /></div>
                } }
              }
            }
          </div>
        }
      }
    </div>
  }`,
  styles: `:host { display:block; margin:0; padding:0; background:transparent } .canvas { position:relative; overflow:hidden; font-family:'Plus Jakarta Sans',sans-serif } .placement { position:absolute; overflow:hidden } app-overlay-media { background:transparent } .speech-text { position:absolute; inset:0; display:grid; place-content:center; color:white; background:#171a21cc; font-size:28px; padding:12px; text-align:center; white-space:pre-wrap; overflow-wrap:anywhere; pointer-events:none }`
})
export class OverlayRuntimeComponent {
  readonly snapshot = signal<Snapshot | null>(null);
  readonly playing = signal<Playing[]>([]);
  private readonly api = inject(OverlayApi);
  private readonly language = inject(LanguageService);
  readonly publicId = inject(ActivatedRoute).snapshot.paramMap.get('publicId') || '';
  private readonly clientId = crypto.randomUUID();
  private readonly socket = io(`${this.api.base}/overlay-studio/${this.publicId}`, { auth: { clientId: this.clientId }, transports: ['websocket'], autoConnect: false });
  private queue: Event[] = [];
  private seen = new Set<string>();
  private completed = new Set<string>();
  private active: string | null = null;
  private disposed = false;
  private revision = -1;
  private generation = 0;
  constructor() {
    const doc = inject(DOCUMENT); const oldBody = doc.body.style.background, oldRoot = doc.documentElement.style.background;
    doc.body.style.background = 'transparent'; doc.documentElement.style.background = 'transparent';
    const referrer = doc.createElement('meta'); referrer.name = 'referrer'; referrer.content = 'no-referrer'; doc.head.append(referrer);
    this.socket.on('overlay-state', state => { if (state.revision >= this.revision) { this.revision = state.revision; this.snapshot.set(state.snapshot); } });
    this.socket.on('overlay-updated', () => void this.refresh());
    this.socket.on('overlay-event', (event: Event) => this.enqueue(event));
    this.socket.on('overlay-revoked', () => this.clear());
    this.socket.on('disconnect', reason => { if (reason === 'io server disconnect') this.clear(); });
    if (/^[a-f0-9]{48}$/.test(this.publicId)) this.socket.connect();
    inject(DestroyRef).onDestroy(() => { this.disposed = true; this.clear(); this.socket.disconnect(); doc.body.style.background = oldBody; doc.documentElement.style.background = oldRoot; referrer.remove(); });
  }
  playLabel() { return this.language.translate('overlayStudio.tapToPlay'); }
  indexOfId(id: string) { return (w: OverlayWidget) => w.id === id; }
  designWidth(job: Playing, w: OverlayWidget) { return job.snapshot.designs.find(d => d.id === w.designId)?.width || 800; }
  designHeight(job: Playing, w: OverlayWidget) { return job.snapshot.designs.find(d => d.id === w.designId)?.height || 240; }
  private async refresh() {
    try { const state = await this.api.request<{ revision: number; snapshot: Snapshot }>('GET', `public/${this.publicId}`); if (!this.disposed && state.revision >= this.revision) { this.revision = state.revision; this.snapshot.set(state.snapshot); } }
    catch { /* Keep the last published version on fetch failure. */ }
  }
  private enqueue(event: Event) {
    if (this.seen.has(event.id)) { if (this.completed.has(event.id)) this.socket.emit('overlay-ended', event.id); return; } this.seen.add(event.id);
    if (this.snapshot()?.waitFor.includes(event.kind)) { this.queue.push(event); this.next(); } else void this.start(event);
  }
  private next() { if (this.active || !this.queue.length) return; const event = this.queue.shift()!; this.active = event.id; void this.start(event); }
  private async start(event: Event) {
    const generation = this.generation;
    try {
      const full = await this.api.request<Event>('GET', `public/${this.publicId}/events/${event.id}`);
      if (this.disposed || generation !== this.generation) return;
      const snapshot = full.snapshot ?? this.snapshot(); if (!snapshot) { this.finish(event.id); return; }
      const widgets = snapshot.widgets.filter(w => w.visible && (w.kind === event.kind || w.kind === 'alert' && w.events?.includes(event.kind as AlertEvent)));
      if (!widgets.length) { this.finish(event.id); return; }
      if (full.media?.url.startsWith('/')) full.media.url = this.api.base + full.media.url;
      const job: Playing = { event: full, snapshot, widgets, pending: new Set(widgets.map(w => w.id)), timers: new Map() };
      this.playing.update(all => [...all, job]);
      for (const w of widgets) {
        const seconds = full.media ? 30 : full.layouts?.[w.designId || '']?.duration || 5;
        job.timers.set(w.id, setTimeout(() => this.finishPlacement(event.id, w.id), seconds * 1000));
      }
    } catch { if (generation === this.generation) this.finish(event.id); }
  }
  started(id: string, widget: string, duration?: number) {
    const job = this.playing().find(p => p.event.id === id); if (!job) return;
    clearTimeout(job.timers.get(widget));
    const seconds = job.event.media?.type === 'image' ? 5 : job.event.media?.duration ?? (Number.isFinite(duration) && duration! > 0 ? duration! + 15 : 300);
    job.timers.set(widget, setTimeout(() => this.finishPlacement(id, widget), seconds * 1000));
  }
  finishPlacement(id: string, widget: string) {
    const job = this.playing().find(p => p.event.id === id); if (!job) return;
    job.pending.delete(widget); clearTimeout(job.timers.get(widget));
    if (!job.pending.size) this.finish(id);
  }
  private finish(id: string) {
    const job = this.playing().find(p => p.event.id === id); job?.timers.forEach(clearTimeout);
    this.playing.update(all => all.filter(p => p.event.id !== id)); this.completed.add(id); this.socket.emit('overlay-ended', id);
    // Retain receipts for this connection; reconnect replay must not play completed events twice.
    if (this.active === id) { this.active = null; this.next(); }
  }
  private clear() { this.generation++; this.playing().forEach(p => p.timers.forEach(clearTimeout)); this.playing.set([]); this.queue = []; this.active = null; this.snapshot.set(null); }
}
