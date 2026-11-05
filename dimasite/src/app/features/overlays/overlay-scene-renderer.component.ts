import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, output, signal } from '@angular/core';
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
import { sceneScale, type OverlayPlacementReport, type OverlayRenderJob } from './overlay-playback';
import { LanguageService } from '../../services/language.service';

/** The OBS visual composition. The editor supplies draft/sample data to this same renderer. */
@Component({
  selector: 'app-overlay-scene-renderer',
  imports: [OverlayLayerComponent, OverlayWidgetHostComponent, OverlayMediaComponent, OverlayClipComponent, OverlaySoundComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="canvas" [style.width.px]="scene().width" [style.height.px]="scene().height" [style.transform]="'scale(' + scale() + ')'" [attr.data-scene-scale]="scale()">
    @for (epoch of [staticPlaybackKey()]; track epoch) { @for (w of scene().widgets; track w.id) { @if (w.visible && delivery(w) === 'static') {
      <div class="placement art" [attr.data-widget-id]="w.id" [attr.data-kind]="w.kind" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="$index"><app-overlay-layer [owner]="owner()" [publicId]="publicId()" [layer]="w" [preparedSource]="staticAssets().get(w.assetId || '')?.url || ''" [text]="texts()[w.text || ''] ?? w.text" [playbackKey]="staticPlaybackKey()" [duration]="staticDuration()" [seekTime]="transport()?.time ?? null" (failed)="issue.emit('media')" /></div>
    } } }
    @for (w of scene().widgets; track w.id) { @if (w.visible && (delivery(w) === 'state' || delivery(w) === 'code')) {
      <div class="placement" [class.interaction]="delivery(w) === 'state'" [attr.data-widget-id]="w.id" [attr.data-kind]="w.kind" [attr.data-interaction]="delivery(w) === 'state' ? w.kind : null" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="$index"><app-overlay-widget-host [widget]="w" [placement]="placement()" [state]="widgetState(w)" [clockOffset]="clockOffset()" [preview]="preview()" [previewFixture]="previewFixtures()[w.id] || ''" /></div>
    } }
    @if (preview()) { @for (w of scene().widgets; track w.id) { @if (w.visible && w.kind === 'clip' && !hasPlaying(w.id)) {
      <div class="placement" [attr.data-widget-id]="w.id" data-kind="clip" data-idle="" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="$index"><app-overlay-clip [design]="w.clipDesign ?? 'classic'" [streamer]="streamer()" /></div>
    } } }
    @if (designSound(); as sound) { @if (staticPlaybackKey()) { <app-overlay-sound [sound]="sound" [duration]="staticDuration()" [playbackKey]="staticPlaybackKey()" [transport]="transport()" [preparedSource]="staticAssets().get(sound.assetId)?.url || ''" [owner]="owner()" [publicId]="publicId()" (failed)="issue.emit('media')" (playbackBlocked)="issue.emit('autoplay')" (started)="soundStarted.emit()" /> } }
    @for (job of jobs(); track job.event.id) {
      @for (sound of soundsFor(job); track sound.id) { <app-overlay-sound [sound]="sound.config" [duration]="sound.duration" [playbackKey]="job.playbackKey ?? job.event.id" [owner]="owner()" [publicId]="publicId()" [preparedSource]="job.assets?.get(sound.config.assetId)?.url || ''" (failed)="issue.emit('media')" (playbackBlocked)="issue.emit('autoplay')" (started)="soundStarted.emit()" /> }
      @for (w of renderWidgets(job); track w.id) {
        <div class="placement" [attr.data-widget-id]="w.id" [attr.data-kind]="w.kind" [attr.data-event]="job.event.kind" [attr.data-idle]="job.idle ? '' : null" [attr.data-playback-key]="job.playbackKey ?? job.event.id" [attr.data-platform]="job.event.platform ?? 'twitch'" [style.left.px]="w.x" [style.top.px]="w.y" [style.width.px]="w.width" [style.height.px]="w.height" [style.z-index]="layerIndex(job,w)">
          @if (mediaFor(job,w.id); as media) {
            @if (job.event.kind === 'clip') {
              <app-overlay-clip [design]="w.clipDesign ?? 'classic'" [media]="media" [muted]="audioWidget(job) !== w.id" (started)="started.emit({id:job.event.id,widgetId:w.id,duration:$event})" (playbackBlocked)="issue.emit('autoplay')" (ended)="ended.emit({id:job.event.id,widgetId:w.id})" (failed)="failed.emit({id:job.event.id,widgetId:w.id})" />
            } @else {
              <app-overlay-media [media]="media" [muted]="audioWidget(job) !== w.id" [reportSpeech]="!!job.event.tts && audioWidget(job) === w.id" (speechPlayback)="speechPlayback.emit({id:job.event.id,widgetId:w.id,report:$event})" [showTitle]="job.event.kind !== 'tts'" [showAudioLabel]="job.event.kind !== 'tts'" [playLabel]="language.translate('overlayStudio.tapToPlay')" (started)="started.emit({id:job.event.id,widgetId:w.id,duration:$event})" (playbackBlocked)="issue.emit('autoplay')" (ended)="ended.emit({id:job.event.id,widgetId:w.id})" (failed)="failed.emit({id:job.event.id,widgetId:w.id})" />
            }
          } @else if (!job.event.tts) {
            @if (job.event.layouts?.[w.designId || '']; as layout) {
              @for (part of layout.widgets; track part.id) { @if (part.visible) {
                <div class="placement art" [attr.data-layer-id]="part.id" [attr.data-kind]="part.kind" [style.left.%]="part.x / designWidth(job,w) * 100" [style.top.%]="part.y / designHeight(job,w) * 100" [style.width.%]="part.width / designWidth(job,w) * 100" [style.height.%]="part.height / designHeight(job,w) * 100"><app-overlay-layer [owner]="owner()" [publicId]="publicId()" [layer]="part" [preparedSource]="job.assets?.get(part.assetId || '')?.url || ''" [playbackKey]="job.playbackKey ?? job.event.id" [duration]="layout.duration" (failed)="issue.emit('media')" /></div>
              } }
            }
          }
          @if (job.event.kind === 'tts' && w.showTtsText === true) { <div class="speech-text">{{ job.event.text }}</div> }
        </div>
      }
    }
  </div>`,
  styles: `:host { position:absolute; inset:0; width:100%; height:100%; display:block; margin:0; padding:0; background:transparent; pointer-events:none } .canvas { position:relative; overflow:hidden; transform-origin:top left; font-family:'Plus Jakarta Sans',sans-serif } .placement { position:absolute; overflow:hidden } .placement.art { overflow:visible } app-overlay-sound { position:relative; z-index:1000; pointer-events:auto } app-overlay-media,app-overlay-clip { background:transparent; pointer-events:auto } .speech-text { position:absolute; inset:0; display:grid; place-content:center; color:white; background:#171a21cc; font-size:28px; padding:12px; text-align:center; white-space:pre-wrap; overflow-wrap:anywhere; pointer-events:none }`
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
  readonly language = inject(LanguageService);
  private readonly measured = signal({ width:0,height:0 });
  readonly scale = computed(() => sceneScale(this.scene(),this.viewport() ?? this.measured()));
  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement, destroy = inject(DestroyRef);
    afterNextRender(() => {
      const observer = new ResizeObserver(([entry]) => this.measured.set({ width:entry.contentRect.width,height:entry.contentRect.height }));
      observer.observe(host); destroy.onDestroy(() => observer.disconnect());
    });
  }
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
    if (job.idle || job.event.tts) return [];
    return [...new Set(job.widgets.filter(w => w.kind === 'alert').map(w => w.designId!))].flatMap(id => {
      const layout = job.event.layouts?.[id]; return layout?.sound ? [{ id,config:layout.sound,duration:layout.duration }] : [];
    });
  }
}
