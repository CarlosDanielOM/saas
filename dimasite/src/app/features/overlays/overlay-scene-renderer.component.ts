import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, computed, inject, input, output, signal, untracked } from '@angular/core';
import type { Snapshot } from './overlay-api.service';
import { OverlayLayerComponent } from './overlay-layer.component';
import { OverlayWidgetHostComponent } from './overlay-widget-host.component';
import { OverlayMediaComponent, type OverlaySpeechPlayback } from './overlay-media.component';
import { OverlayClipComponent } from './overlay-clip.component';
import { OverlaySoundComponent, type AlertTransport } from './overlay-sound.component';
import { widgetModuleFor } from './overlay-widget-registry';
import { stateForWidget } from './overlay-widget-state';
import type { WidgetPlacement, WidgetStates } from './overlay-widget-contract.generated';
import type { AlertSound, OverlayWidget } from './overlay.model';
import type { PreparedAsset } from './overlay-asset-cache';
import { ALERT_READY_LIMIT_MS, sceneScale, waitsForPictures, type OverlayPlacementReport, type OverlayPlaybackId, type OverlayRenderJob } from './overlay-playback';
import { waitForOverlayMedia } from './overlay-image-readiness';
import { LanguageService } from '../../services/language.service';
import { LucideAngularModule, Volume2, Zap } from 'lucide-angular';

/** The OBS visual composition. The editor supplies draft/sample data to this same renderer. */
@Component({
  selector: 'app-overlay-scene-renderer',
  imports: [OverlayLayerComponent, OverlayWidgetHostComponent, OverlayMediaComponent, OverlayClipComponent, OverlaySoundComponent, LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="canvas" [style.width.px]="scene().width" [style.height.px]="scene().height" [style.transform]="'scale(' + scale() + ')'" [attr.data-scene-scale]="scale()">
    @for (epoch of [staticPlaybackKey()]; track epoch) { @for (w of scene().widgets; track w.id) { @if (w.visible && delivery(w) === 'static') {
      <div class="placement art" [attr.data-widget-id]="w.id" [attr.data-kind]="w.kind" [attr.data-ready-key]="staticKey()" [attr.data-waiting]="staticShown() ? null : ''" [style.visibility]="staticShown() ? null : 'hidden'" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="$index"><app-overlay-layer [owner]="owner()" [publicId]="publicId()" [layer]="w" [preparedSource]="staticAssets().get(w.assetId || '')?.url || ''" [text]="texts()[w.text || ''] ?? w.text" [playbackKey]="staticShown() ? staticPlaybackKey() : 0" [duration]="staticDuration()" [seekTime]="transport()?.time ?? null" (failed)="issue.emit('media')" /></div>
    } } }
    @for (w of scene().widgets; track w.id) { @if (w.visible && (delivery(w) === 'state' || delivery(w) === 'code')) {
      <div class="placement" [class.interaction]="delivery(w) === 'state'" [attr.data-widget-id]="w.id" [attr.data-kind]="w.kind" [attr.data-interaction]="delivery(w) === 'state' ? w.kind : null" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="$index"><app-overlay-widget-host [widget]="w" [placement]="placement()" [state]="widgetState(w)" [clockOffset]="clockOffset()" [preview]="preview()" [previewFixture]="previewFixtures()[w.id] || ''" /></div>
    } }
    @if (preview()) { @for (w of scene().widgets; track w.id) { @if (w.visible && w.kind === 'clip' && !hasPlaying(w.id)) {
      <div class="placement" [attr.data-widget-id]="w.id" data-kind="clip" data-idle="" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="$index"><app-overlay-clip [design]="w.clipDesign ?? 'classic'" [streamer]="streamer()" /></div>
    } } }
    <!-- Studio-only cards showing where idle speech and trigger boxes are, in layer order (OBS shows nothing). -->
    @if (preview()) { @for (w of scene().widgets; track w.id) { @if (w.visible && (w.kind === 'tts' || w.kind === 'trigger') && !hasPlaying(w.id)) {
      <div class="placement placeholder" [attr.data-widget-id]="w.id" [attr.data-kind]="w.kind" data-idle="" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="$index">
        <!-- The card cancels the canvas zoom, so its text is laid out in screen pixels and stays crisp. -->
        <div class="placeholder__card" [style.width.px]="w.width * scale()" [style.height.px]="w.height * scale()" [style.transform]="'scale(' + 1 / scale() + ')'">
          <span class="placeholder__icon"><lucide-icon [img]="w.kind === 'tts' ? speechIcon : triggerIcon" [size]="18" aria-hidden="true" /></span>
          <div><small>{{ language.translate(w.kind === 'tts' ? 'overlayStudio.ttsPreviewLabel' : 'overlayStudio.triggerPreviewLabel') }}</small><strong>{{ language.translate(w.kind === 'tts' ? (w.showTtsText === true ? 'overlayStudio.ttsPreviewText' : 'overlayStudio.ttsAudioOnly') : 'overlayStudio.triggerPreviewText') }}</strong></div>
        </div>
      </div>
    } } }
    @if (designSound(); as sound) { @if (staticPlaybackKey() && staticShown()) { <app-overlay-sound [sound]="sound" [duration]="staticDuration()" [playbackKey]="staticPlaybackKey()" [transport]="transport()" [preparedSource]="staticAssets().get(sound.assetId)?.url || ''" [owner]="owner()" [publicId]="publicId()" (failed)="issue.emit('media')" (playbackBlocked)="issue.emit('autoplay')" (started)="soundStarted.emit()" /> } }
    @for (job of jobs(); track job.event.id) {
      @for (sound of soundsFor(job); track sound.id) { <app-overlay-sound [sound]="sound.config" [duration]="sound.duration" [playbackKey]="job.playbackKey ?? job.event.id" [owner]="owner()" [publicId]="publicId()" [preparedSource]="job.assets?.get(sound.config.assetId)?.url || ''" (failed)="issue.emit('media')" (playbackBlocked)="issue.emit('autoplay')" (started)="soundStarted.emit()" /> }
      @for (w of renderWidgets(job); track w.id) {
        <div class="placement" [attr.data-widget-id]="w.id" [attr.data-kind]="w.kind" [attr.data-event]="job.event.kind" [attr.data-idle]="job.idle ? '' : null" [attr.data-playback-key]="job.playbackKey ?? job.event.id" [attr.data-ready-key]="readyKey(job)" [attr.data-platform]="job.event.platform ?? 'twitch'" [attr.data-waiting]="shown(job) ? null : ''" [style.visibility]="shown(job) ? null : 'hidden'" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="layerIndex(job,w)">
          @if (mediaFor(job,w.id); as media) {
            @if (job.event.kind === 'clip') {
              <app-overlay-clip [design]="w.clipDesign ?? 'classic'" [media]="media" [muted]="audioWidget(job) !== w.id" (started)="started.emit({id:job.event.id,widgetId:w.id,duration:$event})" (playbackBlocked)="issue.emit('autoplay')" (ended)="ended.emit({id:job.event.id,widgetId:w.id})" (failed)="failed.emit({id:job.event.id,widgetId:w.id})" />
            } @else {
              <app-overlay-media [media]="media" [muted]="audioWidget(job) !== w.id" [reportSpeech]="!!job.event.tts && audioWidget(job) === w.id" (speechPlayback)="speechPlayback.emit({id:job.event.id,widgetId:w.id,report:$event})" [showTitle]="job.event.kind !== 'tts'" [showAudioLabel]="job.event.kind !== 'tts'" [playLabel]="language.translate('overlayStudio.tapToPlay')" (started)="started.emit({id:job.event.id,widgetId:w.id,duration:$event})" (playbackBlocked)="issue.emit('autoplay')" (ended)="ended.emit({id:job.event.id,widgetId:w.id})" (failed)="failed.emit({id:job.event.id,widgetId:w.id})" />
            }
          } @else if (!job.event.tts) {
            @if (job.event.layouts?.[w.designId || '']; as layout) {
              @for (part of layout.widgets; track part.id) { @if (part.visible) {
                <div class="placement art" [attr.data-layer-id]="part.id" [attr.data-kind]="part.kind" [style.left.%]="part.x / designWidth(job,w) * 100" [style.top.%]="part.y / designHeight(job,w) * 100" [style.width.%]="part.width / designWidth(job,w) * 100" [style.height.%]="part.height / designHeight(job,w) * 100"><app-overlay-layer [owner]="owner()" [publicId]="publicId()" [layer]="part" [preparedSource]="job.assets?.get(part.assetId || '')?.url || ''" [playbackKey]="shown(job) ? (job.playbackKey ?? job.event.id) : 0" [duration]="layout.duration" (failed)="issue.emit('media')" /></div>
              } }
            }
          }
          @if (job.event.kind === 'tts' && w.showTtsText === true) { <div class="speech-text">{{ job.event.text }}</div> }
        </div>
      }
    }
  </div>`,
  styles: `:host { position:absolute; inset:0; width:100%; height:100%; display:block; margin:0; padding:0; background:transparent; pointer-events:none } .canvas { position:relative; overflow:hidden; transform-origin:top left; font-family:'Plus Jakarta Sans',sans-serif } .placement { position:absolute; overflow:hidden } .placement.art { overflow:visible } app-overlay-sound { position:relative; z-index:1000; pointer-events:auto } app-overlay-media,app-overlay-clip { background:transparent; pointer-events:auto } .placeholder__card { position:absolute; top:0; left:0; box-sizing:border-box; transform-origin:top left; display:flex; align-items:center; gap:7px; padding:7px; overflow:hidden; border-radius:8px; background:rgba(33,38,55,.88); color:#fff; box-shadow:0 8px 25px rgba(0,0,0,.35) } .placeholder[data-kind=trigger] .placeholder__card { background:linear-gradient(135deg,rgba(66,42,23,.94),rgba(33,38,55,.9)) } .placeholder__card>div { display:grid; gap:2px; min-width:0; flex:1 } .placeholder__icon { flex:none; display:flex; align-items:center; justify-content:center; width:27px; height:27px; border-radius:7px; background:#7c3aed } .placeholder[data-kind=trigger] .placeholder__icon { background:#d97706 } .placeholder__icon lucide-icon { display:flex } .placeholder small,.placeholder strong { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis } .placeholder small { font-size:clamp(6px,.6vw,10px); color:#c9d1e1; font-weight:700 } .placeholder strong { font-size:clamp(8px,.8vw,13px); line-height:1.2 } .speech-text { position:absolute; inset:0; display:grid; place-content:center; color:white; background:#171a21cc; font-size:28px; padding:12px; text-align:center; white-space:pre-wrap; overflow-wrap:anywhere; pointer-events:none }`
})
export class OverlaySceneRendererComponent {
  readonly scene = input.required<Snapshot>();
  readonly jobs = input<readonly OverlayRenderJob[]>([]);
  readonly streamer = input('');
  readonly owner = input(''); readonly publicId = input(''); readonly audioOwner = input('');
  readonly viewport = input<{ width: number; height: number }>();
  readonly placement = input<WidgetPlacement>('scene');
  readonly preview = input(false); readonly previewFixtures = input<Partial<Record<string,string>>>({});
  readonly states = input<WidgetStates>({}); readonly clockOffset = input(0);
  readonly texts = input<Partial<Record<string,string>>>({});
  readonly staticAssets = input<ReadonlyMap<string,PreparedAsset>>(new Map());
  readonly staticPlaybackKey = input<string | number>(0); readonly staticDuration = input(5);
  readonly transport = input<AlertTransport | null>(null); readonly designSound = input<AlertSound>();
  readonly started = output<OverlayPlacementReport>(); readonly ended = output<OverlayPlacementReport>(); readonly failed = output<OverlayPlacementReport>();
  readonly issue = output<'media'|'autoplay'>(); readonly soundStarted = output<void>();
  readonly speechPlayback = output<OverlayPlacementReport & { report: OverlaySpeechPlayback }>();
  /** A designed alert (or a design replay, id `static:<epoch>`) is now visible with its
   * pictures decoded and videos on their first frame: its clock starts here. */
  readonly ready = output<{ id: OverlayPlaybackId }>();
  readonly language = inject(LanguageService);
  readonly speechIcon = Volume2; readonly triggerIcon = Zap;
  private readonly measured = signal({ width:0,height:0 });
  readonly scale = computed(() => sceneScale(this.scene(),this.viewport() ?? this.measured()));
  private readonly readyKeys = signal<ReadonlySet<string>>(new Set());
  private readonly waitsFor = new Map<string, AbortController>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  constructor() {
    const host = this.host, destroy = inject(DestroyRef);
    afterNextRender(() => {
      const observer = new ResizeObserver(([entry]) => this.measured.set({ width:entry.contentRect.width,height:entry.contentRect.height }));
      observer.observe(host); destroy.onDestroy(() => observer.disconnect());
    });
    // A new alert (or design replay) mounts hidden and still. Once the pictures it displays are
    // decoded and its videos have a first frame, it appears whole, and motion and sound start together.
    afterRenderEffect(() => {
      const ready = this.readyKeys(), gates = this.gates(), live = new Set(gates.map(gate => gate.key));
      for (const gate of gates) {
        if (ready.has(gate.key) || this.waitsFor.has(gate.key)) continue;
        const controller = new AbortController(); this.waitsFor.set(gate.key, controller);
        const roots = this.roots(gate.key);
        // A video that starts while its alert waits is held on its first frame (media events
        // reach ancestors in the capture phase). A timeline replay controls its own videos.
        if (this.ownsVideos(gate.key)) {
          const hold = (event: Event) => { if (event.target instanceof HTMLVideoElement) { event.target.pause(); event.target.currentTime = 0; } };
          for (const root of roots) root.addEventListener('playing', hold, true);
          controller.signal.addEventListener('abort', () => { for (const root of roots) root.removeEventListener('playing', hold, true); }, { once: true });
        }
        // A failed item settles on its own; a removed placement stops counting.
        void Promise.all(roots.map(root => waitForOverlayMedia(root, controller.signal, ALERT_READY_LIMIT_MS))).then(() => {
          if (!controller.signal.aborted) this.reveal(gate);
        });
      }
      for (const [key, controller] of this.waitsFor) if (!live.has(key)) { controller.abort(); this.waitsFor.delete(key); }
      // A departed key must never let a later playback skip its wait.
      if ([...ready].some(key => !live.has(key))) queueMicrotask(() => { const current = new Set(this.gates().map(gate => gate.key)); this.readyKeys.update(keys => new Set([...keys].filter(key => current.has(key)))); });
    });
    destroy.onDestroy(() => { this.waitsFor.forEach(controller => controller.abort()); this.waitsFor.clear(); });
  }
  /** Everything mounted that waits for its media: alert jobs, resting examples and the current design replay. */
  private gates(): { key: string; id: OverlayPlaybackId | null }[] {
    const gates = this.jobs().filter(job => this.gated(job)).map(job => ({ key: this.readyKey(job), id: job.idle ? null : job.event.id }));
    const key = this.staticKey(); if (key) gates.push({ key, id: key });
    return gates;
  }
  private reveal(gate: { key: string; id: OverlayPlaybackId | null }): void {
    const { key } = gate, current = new Set(this.gates().map(item => item.key));
    this.waitsFor.get(key)?.abort(); this.waitsFor.delete(key);
    if (this.readyKeys().has(key) || !current.has(key)) return;
    this.readyKeys.update(keys => new Set([...keys].filter(item => current.has(item))).add(key));
    if (gate.id !== null) this.ready.emit({ id: gate.id });
    // Videos were held on their first frame; every layer starts together.
    if (this.ownsVideos(key)) for (const root of this.roots(key)) for (const video of root.querySelectorAll('video')) {
      if (video.currentTime > .25) video.currentTime = 0;
      if (video.paused) void video.play().catch(() => {});
    }
  }
  /** A paused or scrubbed timeline keeps its own video frame. */
  private ownsVideos(key: string): boolean { return !key.startsWith('static:') || untracked(this.transport) === null; }
  /** A design replay (non-zero epoch) waits like an alert; the plain editing canvas (epoch 0) does not. */
  staticKey(): string | null { const epoch = this.staticPlaybackKey(); return epoch ? 'static:' + epoch : null; }
  staticShown(): boolean { const key = this.staticKey(); return !key || this.readyKeys().has(key); }
  private roots(key: string): HTMLElement[] {
    return [...this.host.querySelectorAll<HTMLElement>('.placement[data-ready-key]')].filter(root => root.dataset['readyKey'] === key);
  }
  /** Designed alerts and the Studio's resting examples of them never show a half-loaded picture. */
  private gated(job: OverlayRenderJob): boolean { return waitsForPictures(job.event); }
  /** Idle Studio examples share playback epoch 0, so their readiness is tracked per example. */
  readyKey(job: OverlayRenderJob): string { return job.idle ? 'idle:' + job.event.id : String(job.playbackKey ?? job.event.id); }
  shown(job: OverlayRenderJob): boolean { return !this.gated(job) || this.readyKeys().has(this.readyKey(job)); }
  hasPlaying(id: string): boolean { return this.jobs().some(job => !job.idle && job.widgets.some(widget => widget.id === id)); }
  delivery(widget: OverlayWidget) { return widgetModuleFor(widget,this.placement())?.definition.delivery; }
  widgetState(widget: OverlayWidget) { return stateForWidget(widget,this.states()); }
  renderWidgets(job: OverlayRenderJob): readonly OverlayWidget[] { return job.pending ? job.widgets.filter(widget => job.pending!.has(widget.id)) : job.widgets; }
  audioWidget(job: OverlayRenderJob): string | undefined { return job.audioWidgetId ?? job.widgets[0]?.id; }
  layerIndex(job: OverlayRenderJob,widget: OverlayWidget) { return job.snapshot.widgets.findIndex(w => w.id === widget.id); }
  designWidth(job: OverlayRenderJob,widget: OverlayWidget) { return job.snapshot.designs.find(d => d.id === widget.designId)?.width || 800; }
  designHeight(job: OverlayRenderJob,widget: OverlayWidget) { return job.snapshot.designs.find(d => d.id === widget.designId)?.height || 240; }
  mediaFor(job: OverlayRenderJob,widgetId: string) { return !job.event.tts || job.event.tts.ownerClientId === this.audioOwner() && this.audioWidget(job) === widgetId ? job.event.media : undefined; }
  soundsFor(job: OverlayRenderJob) {
    if (job.idle || job.event.tts || !this.shown(job)) return [];
    return [...new Set(job.widgets.filter(w => w.kind === 'alert').map(w => w.designId!))].flatMap(id => {
      const layout = job.event.layouts?.[id]; return layout?.sound ? [{ id,config:layout.sound,duration:layout.duration }] : [];
    });
  }
}
