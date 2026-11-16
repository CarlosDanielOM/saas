import { OverlayKeyframePhaseComponent } from './overlay-keyframe-phase.component';
import { Component, ChangeDetectionStrategy, DestroyRef, ElementRef, afterNextRender, afterRenderEffect, computed, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { defaultMotion, playObjectMotion } from './overlay-object-motion';
import { motionStop } from './overlay-motion-timing';
import { isTimedVideo, type OverlayWidget } from './overlay-model.generated';
import type { AlertTransport } from './overlay-sound.component';
import { LanguageService } from '../../services/language.service';
import { AssetPreviewComponent } from '../../shared/asset-library/asset-preview.component';
import { LinksService } from '../../services/links.service';
import { libraryUrl } from './overlay-library.generated';
@Component({
  selector: 'app-overlay-layer', imports: [AssetPreviewComponent, OverlayKeyframePhaseComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-overlay-image]': "layer().kind === 'image' && (layer().assetId || pictureUrl()) ? '' : null", '[attr.data-overlay-video]': "layer().kind === 'video' && (layer().assetId || layer().mediaUrl) ? '' : null", '[attr.data-overlay-failed]': "broken() ? '' : null", '[attr.data-timed-video]': "videoTiming() ? '' : null" },
  template: `<div #entrance class="motion-shell"><app-overlay-keyframe-phase phase="enter" [keyframes]="animationKeyframes()" [motion]="resolvedMotion()" [duration]="duration()" [playbackKey]="playbackKey()" [seekTime]="seekTime()"><div #exit class="motion-shell"><app-overlay-keyframe-phase phase="exit" [keyframes]="animationKeyframes()" [motion]="resolvedMotion()" [duration]="duration()" [playbackKey]="playbackKey()" [seekTime]="seekTime()"><div #loop class="motion-shell"><app-overlay-keyframe-phase phase="loop" [keyframes]="animationKeyframes()" [motion]="resolvedMotion()" [duration]="duration()" [playbackKey]="playbackKey()" [seekTime]="seekTime()"><div class="layer-content" [style.width.px]="layer().width" [style.height.px]="layer().height" [style.transform]="scale()" [style.opacity]="layer().opacity ?? 1" [style.filter]="shadow()">@switch (layer().kind) {
    @case ('text') { <span #textElement [style.color]="layer().color || '#ffffff'" [style.font-family]="font()" [style.font-weight]="layer().fontWeight ?? 400" [style.font-style]="layer().italic ? 'italic' : 'normal'" [style.text-align]="layer().textAlign ?? 'center'">{{ text() ?? layer().text }}</span> }
    @case ('shape') { <div class="shape" [style.background]="layer().color ?? '#7c3aed'" [style.border-color]="layer().borderColor ?? '#ffffff'" [style.border-width.px]="layer().borderWidth ?? 0" [style.border-radius]="layer().shape === 'ellipse' ? '50%' : (layer().radius ?? 0) + 'px'"></div> }
    @case ('image') { @if (preparedSource(); as source) { <img [src]="source" alt="" loading="eager" (error)="fail()" /> } @else if (layer().assetId; as id) { <app-asset-preview [assetId]="id" [owner]="owner()" [accessUrl]="publicAssetUrl()" [eager]="!!publicId() || !!owner()" (failed)="fail()" /> } @else if (pictureUrl(); as url) { <img [src]="url" alt="" (error)="fail()" /> } }
    @case ('video') { @if (layer().assetId; as id) { <app-asset-preview [assetId]="id" [owner]="owner()" [accessUrl]="preparedSource() || publicAssetUrl()" kind="video" [managed]="!!videoTiming()" [silent]="designObject()" [seekTime]="videoTiming() ? null : seekTime()" (failed)="fail()" /> } @else if (layer().mediaUrl) { @if (videoTiming()) { <video [src]="layer().mediaUrl" muted playsinline preload="auto" (error)="fail()"></video> } @else { <video [src]="layer().mediaUrl" [autoplay]="seekTime() === null" muted [muted]="designObject()" loop playsinline (loadedmetadata)="seekVideo()" (error)="fail()"></video> } } }
    @case ('animation') { <span class="spark" [class.spark--custom]="!!layer().motion || !!layer().keyframes" [style.color]="layer().color || '#a78bfa'">✦</span> }
  }</div></app-overlay-keyframe-phase></div></app-overlay-keyframe-phase></div></app-overlay-keyframe-phase></div>@if (blocked()) { <button type="button" class="enable-sound" (click)="enableSound()">{{ language.translate('overlayStudio.enableSound') }}</button> }`,
  styles: `:host { position:relative; display:block; width:100%; height:100%; overflow:visible } .motion-shell { width:100%; height:100%; transform-origin:center } .spark.spark--custom { animation:none } .layer-content { position:absolute; top:0; left:0; display:flex; align-items:center; justify-content:center; transform-origin:top left; overflow:visible } img,video { width:100%; height:100%; object-fit:contain } span { width:100%; max-width:100%; white-space:pre-wrap; overflow-wrap:anywhere; text-align:center; font-family:inherit; font-weight:400; line-height:1.2 } .shape { width:100%; height:100%; box-sizing:border-box; border-style:solid } .spark { font-size:100px; animation:pulse 1s ease-in-out infinite alternate } @keyframes pulse { to { transform:scale(.7) rotate(20deg); opacity:.5 } } @media(prefers-reduced-motion:reduce){ .spark { animation:none } } .enable-sound { position:absolute; top:0; left:0; z-index:2; min-height:44px; padding:.6rem 1rem; border:1px solid #7c3aed; border-radius:1rem; background:#7c3aed; color:white; font:inherit; cursor:pointer; pointer-events:auto } .enable-sound:focus-visible { outline:3px solid #c4b5fd; outline-offset:2px }`
})
export class OverlayLayerComponent {
  readonly layer = input.required<OverlayWidget>();
  readonly text = input<string>();
  // Geometry/text updates must not restart an existing animation. Compare only
  // the animation program, rather than subscribing its player to the whole layer.
  readonly resolvedMotion = computed(() => this.layer().motion ?? defaultMotion(this.layer().kind), {equal:(a,b) => JSON.stringify(a) === JSON.stringify(b)});
  readonly animationKeyframes = computed(() => this.layer().keyframes, {equal:(a,b) => JSON.stringify(a) === JSON.stringify(b)});
  private readonly animationMotion = computed(() => this.layer().motion ?? (this.layer().keyframes ? defaultMotion(this.layer().kind) : undefined), {equal:(a,b) => JSON.stringify(a) === JSON.stringify(b)});
  readonly font = computed(() => ({sans: "'Plus Jakarta Sans', sans-serif", serif: 'Georgia, serif', mono: "'Courier New', monospace"})[this.layer().fontFamily ?? 'sans']);
  readonly shadow = computed(() => { const s = this.layer().shadow; return s ? `drop-shadow(${s.x}px ${s.y}px ${s.blur}px ${s.color})` : 'none'; });
  readonly playbackKey = input<string | number>(0);
  readonly duration = input(5);
  readonly seekTime = input<number | null>(null);
  /** The Studio timeline's clock (design replays only); timed videos follow it like the sounds do. */
  readonly transport = input<AlertTransport | null>(null);
  /**
   * An object of an alert design. Its untimed videos are really muted: a static `muted` attribute only sets
   * defaultMuted on elements Angular creates, so they used to loop with their own sound. Overlay-level videos keep
   * their previous behaviour (they have no sound setting).
   */
  readonly designObject = input(false);
  /** Another placement of the same event plays this video's sound (audio is emitted once per event). */
  readonly muted = input(false);
  readonly playbackBlocked = output<void>();
  readonly soundStarted = output<void>();
  readonly blocked = signal(false);
  readonly language = inject(LanguageService);
  private resyncVideo?: () => void;
  /** Set for a timed video (its own sound, or played once): it starts at its start time instead of looping from mount. */
  readonly videoTiming = computed(() => { const l = this.layer(); return isTimedVideo(l) ? { volume: l.volume, loop: l.loop !== false } : null; }, {equal:(a,b) => JSON.stringify(a) === JSON.stringify(b)});
  private readonly timelineMode = computed(() => this.transport() !== null);
  private readonly host = inject(ElementRef<HTMLElement>);
  private legacySeek = false;
  private videoWasControlled = false;
  private motionPlayer?: ReturnType<typeof playObjectMotion>;
  private readonly entrance = viewChild<ElementRef<HTMLElement>>('entrance');
  private readonly exit = viewChild<ElementRef<HTMLElement>>('exit');
  private readonly loop = viewChild<ElementRef<HTMLElement>>('loop');
  readonly owner = input('');
  readonly publicId = input('');
  /** Local bytes prepared by the OBS renderer for image and video layers. */
  readonly preparedSource = input('');
  readonly failed = output<void>();
  // Marks this source as failed, so alert readiness stops waiting for it.
  private readonly failedSource = signal<string | null>(null);
  /** A picture's own URL: a typed link, or a Dima library item (OBS also receives its URL from the server). */
  readonly pictureUrl = computed(() => this.layer().mediaUrl || libraryUrl(this.layer().library));
  private readonly sourceKey = computed(() => [this.layer().assetId, this.pictureUrl(), this.preparedSource()].join('|'));
  readonly broken = computed(() => this.failedSource() === this.sourceKey());
  fail(): void { this.failedSource.set(this.sourceKey()); this.failed.emit(); }
  private readonly textElement = viewChild<ElementRef<HTMLSpanElement>>('textElement');
  private readonly size = signal({ width: 0, height: 0 });
  readonly scale = computed(() => `scale(${this.size().width / this.layer().width}, ${this.size().height / this.layer().height})`);
  private readonly base = inject(LinksService).getApiUrl();
  readonly publicAssetUrl = computed(() => this.publicId() && this.layer().assetId
    ? `${this.base}/overlay-studio/public/${encodeURIComponent(this.publicId())}/assets/${encodeURIComponent(this.layer().assetId!)}` : '');
  enableSound(): void { this.blocked.set(false); this.resyncVideo?.(); }
  seekVideo(): void {
    if (this.videoTiming()) return;
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
      const key = this.playbackKey(), motion = this.animationMotion() ?? (untracked(this.seekTime) !== null ? defaultMotion() : undefined), keyframes = this.animationKeyframes(), duration = this.duration();
      const entrance = this.entrance()?.nativeElement, exit = this.exit()?.nativeElement, loop = this.loop()?.nativeElement;
      if (!key || !motion || !entrance || !exit || !loop) return;
      const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
      let player = playObjectMotion({ entrance, exit, loop }, motion, duration, preference.matches, keyframes);
      this.motionPlayer = player;
      const seek = () => { const time = untracked(this.seekTime); if (time !== null) player.seek(time); }; seek();
      const changed = () => { const time = untracked(this.seekTime), elapsed = time ?? player.time(); player.cancel(); player = playObjectMotion({ entrance, exit, loop }, motion, duration, preference.matches, keyframes); this.motionPlayer = player; player.seek(elapsed, time !== null); };
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
    afterRenderEffect(cleanup => this.timedVideo(cleanup));
    // The timeline clock moves every frame; only the sync runs then, not a new controller.
    afterRenderEffect(() => { this.transport(); untracked(() => this.resyncVideo?.()); });
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

  /**
   * Timed videos play on the alert's clock: from their beginning at the object's start (`motion.delay`), paused at its
   * end (`motionStop`), holding the last frame when not looping. Three clocks: the Studio timeline (follows the transport:
   * scrubbing re-seeks, pausing or a hidden tab pauses), a playing alert or design replay (its own clock from the moment it
   * is shown) and the still editing canvas or a resting example (first frame, paused).
   */
  private timedVideo(cleanup: (fn: () => void) => void): void {
    const timing = this.videoTiming(); this.resyncVideo = undefined; untracked(() => this.blocked.set(false));
    if (!timing) return;
    const key = this.playbackKey(), timeline = this.timelineMode(), motion = this.resolvedMotion(), duration = Math.max(.001, this.duration()), muted = this.muted();
    const host = this.host.nativeElement as HTMLElement, delay = Math.min(motion.delay, duration - .001), stop = motionStop(motion, duration);
    const video = () => host.querySelector('video');
    let disposed = false, started: HTMLVideoElement | null = null, lastSeek = -1, unblock: (() => void) | null = null;
    const pending = new WeakSet<HTMLVideoElement>();
    const audible = () => typeof timing.volume === 'number' && timing.volume > 0 && !muted && !this.blocked();
    const block = (element: HTMLVideoElement) => {
      // Outside OBS a browser may refuse sound without a click: keep the video moving silently, and let the next
      // click (this layer's button or any other) turn its sound on.
      element.muted = true; void element.play().catch(() => {});
      if (this.blocked()) return;
      this.blocked.set(true); this.playbackBlocked.emit();
      // One pair of listeners at a time; either gesture removes both.
      unblock?.();
      const gesture = () => { release(); this.enableSound(); };
      const release = () => { document.removeEventListener('pointerdown', gesture, { capture: true }); document.removeEventListener('keydown', gesture, { capture: true }); if (unblock === release) unblock = null; };
      document.addEventListener('pointerdown', gesture, { capture: true }); document.addEventListener('keydown', gesture, { capture: true });
      unblock = release;
    };
    const run = (element: HTMLVideoElement, play: boolean) => {
      element.loop = timing.loop;
      const sound = audible();
      if (sound) element.volume = Math.max(0, Math.min(1, timing.volume!));
      const unmuted = sound && element.muted;
      if (element.muted === sound) element.muted = !sound;
      if (!play) { if (!element.paused) element.pause(); return; }
      // A fallback that kept playing muted is audible now ("Enable sound"): report the recovery like a fresh start.
      if (unmuted && !element.paused && !pending.has(element)) this.soundStarted.emit();
      if (!element.paused || pending.has(element)) return;
      pending.add(element);
      void element.play().then(() => { pending.delete(element); if (disposed) { element.pause(); return; } if (sound && !element.muted) this.soundStarted.emit(); }).catch(error => {
        pending.delete(element); if (disposed) return;
        if (error?.name === 'NotAllowedError' && !element.muted) block(element);
      });
    };
    /** Seeks to where the video is at `t` seconds into the alert; false when a video played once has nothing left. */
    const place = (element: HTMLVideoElement, t: number, force: boolean): boolean => {
      const length = element.duration, position = Math.max(0, t - delay);
      // Some recordings (MediaRecorder WebM) don't state their length: seek without wrapping and let the element loop or end.
      if (!Number.isFinite(length) || length <= 0) {
        if (force && Math.abs(element.currentTime - position) > .05) { try { element.currentTime = position; } catch { /* not seekable yet */ } }
        return !element.ended;
      }
      const target = timing.loop ? position % length : Math.min(position, Math.max(0, length - .001));
      if (force || Math.abs(element.currentTime - target) > .25) { try { element.currentTime = target; } catch { /* not seekable yet */ } }
      return timing.loop || position < length;
    };
    let sync: () => void, interval: ReturnType<typeof setInterval> | undefined;
    if (timeline) sync = () => {
      const clock = untracked(this.transport), element = video(); if (disposed || !clock || !element || element.readyState < 1) return;
      const seeked = clock.seek !== lastSeek; lastSeek = clock.seek;
      const left = place(element, clock.time, seeked || !clock.playing);
      run(element, clock.playing && !document.hidden && clock.time >= delay && clock.time < stop && left);
    };
    else if (key) {
      const began = performance.now();
      sync = () => {
        const element = video(); if (disposed || !element || element.readyState < 1) return;
        const t = (performance.now() - began) / 1000;
        if (t >= stop) { run(element, false); clearInterval(interval); return; }
        if (t < delay) { run(element, false); return; }
        if (started !== element) { started = element; run(element, place(element, t, true)); return; }
        // Once started it runs on its own; a video played once stays on its last frame.
        run(element, timing.loop || !element.ended);
      };
      interval = setInterval(() => sync(), 40);
    } else sync = () => { const element = video(); if (element && !disposed) { run(element, false); if (element.readyState >= 1 && element.currentTime > 0) element.currentTime = 0; } };
    const loaded = (event: Event) => { if (event.target instanceof HTMLVideoElement) sync(); };
    const visibility = () => sync();
    host.addEventListener('loadedmetadata', loaded, true);
    document.addEventListener('visibilitychange', visibility);
    this.resyncVideo = () => sync();
    untracked(sync);
    cleanup(() => {
      disposed = true; clearInterval(interval); unblock?.(); this.resyncVideo = undefined;
      host.removeEventListener('loadedmetadata', loaded, true); document.removeEventListener('visibilitychange', visibility);
      const element = video(); if (element && !element.paused) element.pause();
    });
  }
}
