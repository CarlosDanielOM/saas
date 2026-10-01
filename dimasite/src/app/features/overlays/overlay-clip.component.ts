import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { LanguageService } from '../../services/language.service';
import { OverlayMediaComponent, type TestMedia } from './overlay-media.component';
import { CLIP_DESIGN_VARIANTS, clipDesignHeight, type ClipDesignVariant } from '../clips/clips.model';

/** The same eight clip skins used by the Clips catalog, fitted to a canvas placement. */
@Component({
  selector: 'app-overlay-clip',
  imports: [OverlayMediaComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../clips/components/clip-design-skin.css', './overlay-clip.component.css'],
  template: `
    <div class="clip-frame" #frame [style.--clip-accent]="accent()">
      <div class="clip-design" [attr.data-variant]="variant()" [style.transform]="'translate(-50%, -50%) scale(' + scale() + ')'">
        <div class="skin">
          <div class="skin__video">
            @if (media(); as value) {
              <app-overlay-media [media]="value" [muted]="muted()" [showTitle]="false" fit="contain" [playLabel]="language.translate('overlayStudio.tapToPlay')"
                (started)="started.emit($event)" (ended)="ended.emit()" (failed)="failed.emit()" (playbackBlocked)="playbackBlocked.emit()" />
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
    effect(() => { this.avatar(); this.avatarFailed.set(false); });
    const destroy = inject(DestroyRef);
    let observer: ResizeObserver | undefined;
    afterNextRender(() => {
      const element = this.frame()?.nativeElement;
      if (!element) return;
      const resize = () => this.available.set({ width: element.clientWidth, height: element.clientHeight });
      resize(); observer = new ResizeObserver(resize); observer.observe(element);
    });
    destroy.onDestroy(() => observer?.disconnect());
  }
}
