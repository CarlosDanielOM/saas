import { OverlayKeyframePhaseComponent } from './overlay-keyframe-phase.component';
import { Component, ChangeDetectionStrategy, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, computed, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { defaultMotion, playObjectMotion } from './overlay-object-motion';
import type { OverlayWidget } from './overlay.model';
import { AssetPreviewComponent } from '../../shared/asset-library/asset-preview.component';
import { LinksService } from '../../services/links.service';
@Component({
  selector: 'app-overlay-layer', imports: [AssetPreviewComponent, OverlayKeyframePhaseComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-overlay-image]': "layer().kind === 'image' && (layer().assetId || layer().mediaUrl) ? '' : null" },
  template: `<div #entrance class="motion-shell"><app-overlay-keyframe-phase phase="enter" [keyframes]="layer().keyframes" [motion]="resolvedMotion()" [duration]="duration()" [playbackKey]="playbackKey()" [seekTime]="seekTime()"><div #exit class="motion-shell"><app-overlay-keyframe-phase phase="exit" [keyframes]="layer().keyframes" [motion]="resolvedMotion()" [duration]="duration()" [playbackKey]="playbackKey()" [seekTime]="seekTime()"><div #loop class="motion-shell"><app-overlay-keyframe-phase phase="loop" [keyframes]="layer().keyframes" [motion]="resolvedMotion()" [duration]="duration()" [playbackKey]="playbackKey()" [seekTime]="seekTime()"><div class="layer-content" [style.width.px]="layer().width" [style.height.px]="layer().height" [style.transform]="scale()" [style.opacity]="layer().opacity ?? 1" [style.filter]="shadow()">@switch (layer().kind) {
    @case ('text') { <span #textElement [style.color]="layer().color || '#ffffff'" [style.font-family]="font()" [style.font-weight]="layer().fontWeight ?? 400" [style.font-style]="layer().italic ? 'italic' : 'normal'" [style.text-align]="layer().textAlign ?? 'center'">{{ text() ?? layer().text }}</span> }
    @case ('shape') { <div class="shape" [style.background]="layer().color ?? '#7c3aed'" [style.border-color]="layer().borderColor ?? '#ffffff'" [style.border-width.px]="layer().borderWidth ?? 0" [style.border-radius]="layer().shape === 'ellipse' ? '50%' : (layer().radius ?? 0) + 'px'"></div> }
    @case ('image') { @if (preparedImage(); as source) { <img [src]="source" alt="" loading="eager" (error)="failed.emit()" /> } @else if (layer().assetId; as id) { <app-asset-preview [assetId]="id" [owner]="owner()" [accessUrl]="publicAssetUrl()" [eager]="!!publicId() || !!owner()" (failed)="failed.emit()" /> } @else if (layer().mediaUrl) { <img [src]="layer().mediaUrl" alt="" (error)="failed.emit()" /> } }
    @case ('video') { @if (layer().assetId; as id) { <app-asset-preview [assetId]="id" [owner]="owner()" [accessUrl]="publicAssetUrl()" kind="video" [seekTime]="seekTime()" (failed)="failed.emit()" /> } @else if (layer().mediaUrl) { <video [src]="layer().mediaUrl" [autoplay]="seekTime() === null" muted loop playsinline (loadedmetadata)="seekVideo()" (error)="failed.emit()"></video> } }
    @case ('animation') { <span class="spark" [class.spark--custom]="!!layer().motion || !!layer().keyframes" [style.color]="layer().color || '#a78bfa'">✦</span> }
  }</div></app-overlay-keyframe-phase></div></app-overlay-keyframe-phase></div></app-overlay-keyframe-phase></div>`,
  styles: `:host { position:relative; display:block; width:100%; height:100%; overflow:visible } .motion-shell { width:100%; height:100%; transform-origin:center } .spark.spark--custom { animation:none } .layer-content { position:absolute; top:0; left:0; display:flex; align-items:center; justify-content:center; transform-origin:top left; overflow:visible } img,video { width:100%; height:100%; object-fit:contain } span { width:100%; max-width:100%; white-space:pre-wrap; overflow-wrap:anywhere; text-align:center; font-family:inherit; font-weight:400; line-height:1.2 } .shape { width:100%; height:100%; box-sizing:border-box; border-style:solid } .spark { font-size:100px; animation:pulse 1s ease-in-out infinite alternate } @keyframes pulse { to { transform:scale(.7) rotate(20deg); opacity:.5 } } @media(prefers-reduced-motion:reduce){ .spark { animation:none } }`
})
export class OverlayLayerComponent {
  readonly layer = input.required<OverlayWidget>();
  readonly text = input<string>();
  readonly resolvedMotion = computed(() => this.layer().motion ?? defaultMotion(this.layer().kind));
  readonly font = computed(() => ({sans: "'Plus Jakarta Sans', sans-serif", serif: 'Georgia, serif', mono: "'Courier New', monospace"})[this.layer().fontFamily ?? 'sans']);
  readonly shadow = computed(() => { const s = this.layer().shadow; return s ? `drop-shadow(${s.x}px ${s.y}px ${s.blur}px ${s.color})` : 'none'; });
  readonly playbackKey = input<string | number>(0);
  readonly duration = input(5);
  readonly seekTime = input<number | null>(null);
  private readonly host = inject(ElementRef<HTMLElement>);
  private legacySeek = false;
  private videoWasControlled = false;
  private motionPlayer?: ReturnType<typeof playObjectMotion>;
  private readonly entrance = viewChild<ElementRef<HTMLElement>>('entrance');
  private readonly exit = viewChild<ElementRef<HTMLElement>>('exit');
  private readonly loop = viewChild<ElementRef<HTMLElement>>('loop');
  readonly owner = input('');
  readonly publicId = input('');
  readonly preparedImage = input('');
  readonly failed = output<void>();
  private readonly textElement = viewChild<ElementRef<HTMLSpanElement>>('textElement');
  private readonly size = signal({ width: 0, height: 0 });
  readonly scale = computed(() => `scale(${this.size().width / this.layer().width}, ${this.size().height / this.layer().height})`);
  private readonly base = inject(LinksService).getApiUrl();
  readonly publicAssetUrl = computed(() => this.publicId() && this.layer().assetId
    ? `${this.base}/overlay-studio/public/${encodeURIComponent(this.publicId())}/assets/${encodeURIComponent(this.layer().assetId!)}` : '');
  seekVideo(): void {
    const time = this.seekTime(), video = this.host.nativeElement.querySelector('.layer-content > video');
    if (time === null) { if (this.videoWasControlled && video instanceof HTMLVideoElement) void video.play().catch(() => {}); this.videoWasControlled = false; return; }
    this.videoWasControlled = true;
    if (!(video instanceof HTMLVideoElement) || !Number.isFinite(video.duration) || !video.duration) return;
    video.pause(); video.currentTime = time % video.duration;
  }
  constructor() {
    const host = inject(ElementRef<HTMLElement>).nativeElement;
    const destroy = inject(DestroyRef);
    afterRenderEffect(cleanup => {
      const key = this.playbackKey(), motion = this.layer().motion ?? (this.layer().keyframes ? this.resolvedMotion() : undefined) ?? (untracked(this.seekTime) !== null ? defaultMotion() : undefined), duration = this.duration();
      const entrance = this.entrance()?.nativeElement, exit = this.exit()?.nativeElement, loop = this.loop()?.nativeElement;
      if (!key || !motion || !entrance || !exit || !loop) return;
      const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
      let player = playObjectMotion({ entrance, exit, loop }, motion, duration, preference.matches, this.layer().keyframes);
      this.motionPlayer = player;
      const seek = () => { const time = untracked(this.seekTime); if (time !== null) player.seek(time); }; seek();
      const changed = () => { const time = untracked(this.seekTime), elapsed = time ?? player.time(); player.cancel(); player = playObjectMotion({ entrance, exit, loop }, motion, duration, preference.matches, this.layer().keyframes); this.motionPlayer = player; player.seek(elapsed, time !== null); };
      preference.addEventListener('change', changed);
      cleanup(() => { player.cancel(); this.motionPlayer = undefined; preference.removeEventListener('change', changed); });
    });
    afterRenderEffect(() => {
      const time = this.seekTime();
      if (time !== null) this.motionPlayer?.seek(time);
      for (const animation of this.host.nativeElement.querySelector('.spark')?.getAnimations() ?? []) {
        if (time !== null) { animation.pause(); animation.currentTime = time * 1000; }
        else if (this.legacySeek) animation.play();
      }
      this.legacySeek = time !== null; this.seekVideo();
    });
    afterRenderEffect(cleanup => {
      const element = this.textElement()?.nativeElement, layer = this.layer();
      this.text();
      if (!element) return;
      const fit = () => {
        const requested = layer.fontSize || 40;
        const fits = () => element.offsetHeight <= layer.height && element.scrollWidth <= layer.width;
        element.style.fontSize = `${requested}px`;
        if (fits()) return;
        // Event names vary in length. Treat the chosen size as a maximum and
        // fit at design resolution, before applying the placement scale.
        let low = 1, high = requested;
        while (high - low > .25) {
          const middle = (low + high) / 2;
          element.style.fontSize = `${middle}px`;
          if (fits()) low = middle; else high = middle;
        }
        element.style.fontSize = `${low}px`;
      };
      fit();
      const observer = new ResizeObserver(fit);
      observer.observe(element);
      cleanup(() => observer.disconnect());
    });
    afterNextRender(() => {
      // Lay out text at design resolution, then scale the entire layer. This
      // preserves wrapping in thumbnails, the editor and resized OBS alerts.
      const observer = new ResizeObserver(([entry]) => this.size.set({ width: entry.contentRect.width, height: entry.contentRect.height }));
      observer.observe(host);
      destroy.onDestroy(() => observer.disconnect());
    });
  }
}
