import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { OverlayMediaComponent, type TestMedia } from './overlay-media.component';
import { CLIP_DESIGN_VARIANTS, clipDesignHeight, type ClipDesignVariant } from '../clips/clips.model';
import { CLIP_MOTION, clipPlaybackLimit } from './overlay-clip-motion';

/** The same eight clip skins used by the Clips catalog, fitted to a canvas placement. */
@Component({
  selector: 'app-overlay-clip',
  imports: [OverlayMediaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../clips/components/clip-design-skin.css', './overlay-clip.component.css', './overlay-clip-motion.css'],
  template: `
    <div class="clip-frame" #frame [style.--clip-accent]="accent()">
      <div class="clip-design" #motion [attr.data-variant]="variant()" [class.has-media]="!!media()" [class.is-in]="phase() === 'playing'" [class.is-out]="phase() === 'exiting'" [class.is-blocked]="blocked()" [style.transform]="'translate(-50%, -50%) scale(' + scale() + ')'">
        <div class="skin">
          <div class="skin__video">
            @if (media(); as value) {
              <app-overlay-media [media]="value" [muted]="muted()" [showTitle]="false" fit="contain" [playLabel]="language.translate('overlayStudio.tapToPlay')"
                (started)="onStarted($event)" (ended)="onMediaEnded()" (failed)="onFailed()" (playbackBlocked)="onBlocked()" />
            } @else { <span class="clip-placeholder" aria-hidden="true"></span> }
          </div>
          <div class="skin__avatar" aria-hidden="true">
            @if (avatar() && !avatarFailed()) { <img [src]="avatar()" alt="" (error)="avatarFailed.set(true)" /> }
            @else { <span class="skin__initials">{{ initials() }}</span> }
          </div>
          <div class="skin__meta">
            <p class="skin__kicker">{{ game() }}</p><h3 class="skin__name">{{ name() }}</h3>
            <p class="skin__copy">{{ caption() }}</p><p class="skin__title">{{ title() }}</p>
          </div>
        </div>
      </div>
    </div>
  `
})
export class OverlayClipComponent {
  readonly design = input<ClipDesignVariant>('classic');
  readonly media = input<TestMedia | null>(null);
  readonly muted = input(false);
  readonly streamer = input('');
  readonly started = output<number | undefined>();
  readonly ended = output<void>();
  readonly failed = output<void>();
  readonly playbackBlocked = output<void>();
  readonly language = inject(LanguageService);
  private readonly frame = viewChild<ElementRef<HTMLElement>>('frame');
  private readonly motion = viewChild<ElementRef<HTMLElement>>('motion');
  readonly phase = signal<'loading' | 'playing' | 'exiting'>('loading');
  readonly blocked = signal(false);
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly frames = new Set<number>();
  private hideTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private startedAt = 0;
  private hasStarted = false;
  private endingRequested = false;
  private completed = false;
  private disposed = false;
  private timing = CLIP_MOTION.classic;
  private readonly available = signal({ width: 0, height: 0 });
  readonly scale = computed(() => Math.max(0, Math.min(this.available().width / 800, this.available().height / clipDesignHeight(this.variant()))));
  readonly avatarFailed = signal(false);
  readonly variant = computed(() => CLIP_DESIGN_VARIANTS.includes(this.design()) ? this.design() : 'classic');
  readonly name = computed(() => this.media()?.clip?.streamer || this.streamer() || (this.media() ? '' : this.language.translate('clips.mock.streamer')));
  readonly game = computed(() => this.media() ? this.media()?.clip?.game || '' : this.language.translate('clips.mock.game'));
  readonly title = computed(() => this.media() ? this.media()!.title : this.language.translate('clips.mock.title'));
  readonly caption = computed(() => this.media() ? this.media()?.clip?.description || this.media()?.title || '' : this.language.translate('clips.mock.caption'));
  readonly accent = computed(() => /^#[0-9a-f]{6}$/i.test(this.media()?.clip?.streamerColor || '') ? this.media()!.clip!.streamerColor : '#8b5cf6');
  readonly avatar = computed(() => {
    const value = this.media()?.clip?.profileImage;
    if (!value || !/^https:\/\//i.test(value)) return '';
    try { const url = new URL(value); return url.username || url.password ? '' : value; } catch { return ''; }
  });
  readonly initials = computed(() => this.name().trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || 'CL');
  constructor() {
    effect(onCleanup => {
      this.media();
      this.generation++;
      this.clearMotion(); this.hasStarted = false; this.endingRequested = false; this.completed = false;
      this.phase.set('loading'); this.blocked.set(false);
      onCleanup(() => this.clearMotion());
    });
    effect(() => { this.avatar(); this.avatarFailed.set(false); });
    const destroy = inject(DestroyRef);
    let observer: ResizeObserver | undefined;
    afterNextRender(() => {
      const element = this.frame()?.nativeElement;
      if (!element) return;
      const resize = () => this.available.set({ width: element.clientWidth, height: element.clientHeight });
      resize(); observer = new ResizeObserver(resize); observer.observe(element);
    });
    destroy.onDestroy(() => { this.disposed = true; this.clearMotion(); observer?.disconnect(); });
  }

  onStarted(duration?: number): void {
    if (this.hasStarted || this.completed || this.disposed) return;
    this.hasStarted = true; this.startedAt = performance.now(); this.blocked.set(false);
    this.timing = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? { enter: 0, exit: 0 } : CLIP_MOTION[this.variant()];
    this.started.emit(duration);
    // Render the initial state before setting transition targets.
    this.nextFrame(() => this.nextFrame(() => {
      if (!this.completed && this.phase() !== 'exiting') this.phase.set('playing');
    }));
    const hideAt = Math.max(this.timing.enter + 400, clipPlaybackLimit(this.media() ?? undefined, duration) * 1000 - 500);
    this.hideTimer = this.later(() => this.beginExit(), hideAt);
  }

  onMediaEnded(): void {
    if (!this.hasStarted || this.endingRequested || this.completed || this.disposed) return;
    this.endingRequested = true;
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.timers.delete(this.hideTimer); }
    // Very short clips keep their last frame until the entrance has settled.
    const remaining = this.timing.enter ? Math.max(0, this.startedAt + this.timing.enter + 400 - performance.now()) : 0;
    this.hideTimer = this.later(() => this.beginExit(), remaining);
  }

  onBlocked(): void { this.blocked.set(true); this.playbackBlocked.emit(); }
  onFailed(): void {
    if (this.completed || this.disposed) return;
    this.completed = true; this.clearMotion(); this.failed.emit();
  }

  private beginExit(): void {
    if (this.completed || this.disposed || this.phase() === 'exiting') return;
    this.phase.set('exiting');
    const generation = this.generation;
    const finish = () => {
      if (generation !== this.generation || this.completed || this.disposed) return;
      this.completed = true; this.clearMotion(); this.ended.emit();
    };
    // Keep the placement and queue slot until every exit transition finishes.
    // Start the fallback outside RAF so background tabs still release the slot.
    this.later(finish, this.timing.exit + 250);
    this.nextFrame(() => this.nextFrame(() => {
      const animations = this.motion()?.nativeElement.getAnimations({ subtree: true }) ?? [];
      void Promise.allSettled(animations.map(animation => animation.finished)).then(finish);
    }));
  }

  private later(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, milliseconds);
    this.timers.add(timer); return timer;
  }
  private nextFrame(callback: () => void): void {
    const frame = requestAnimationFrame(() => { this.frames.delete(frame); if (!this.disposed && !this.completed) callback(); });
    this.frames.add(frame);
  }
  private clearMotion(): void {
    this.timers.forEach(clearTimeout); this.timers.clear();
    this.frames.forEach(cancelAnimationFrame); this.frames.clear();
  }
}
