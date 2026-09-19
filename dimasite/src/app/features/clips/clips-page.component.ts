import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { UpgradeService } from '../../services/upgrade.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { ClipDesignMockComponent } from './components/clip-design-mock.component';
import { ClipTestModalComponent } from './components/clip-test-modal.component';
import { ClipDesign, ClipDesignStatus, UserClipSettings } from './clips.model';
import { ClipsService } from './clips.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

@Component({
  selector: 'app-clips-page',
  imports: [RouterLink, ClipDesignMockComponent, ClipTestModalComponent, LfIconComponent],
  styleUrl: './clips-page.component.css',
  templateUrl: './clips-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:resize)': 'onViewportResize()'
  }
})
export class ClipsPageComponent {
  private readonly languageService = inject(LanguageService);
  private readonly route = inject(ActivatedRoute);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toastService = inject(ToastService);
  private readonly upgradeService = inject(UpgradeService);
  private readonly clipsService = inject(ClipsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly trackRef = viewChild<ElementRef<HTMLElement>>('track');

  readonly config = signal({ timeoutSeconds: 30 });

  readonly activeIndex = signal(0);
  readonly urlCopied = signal(false);
  readonly showTestModal = signal(false);

  readonly userSettings = computed<UserClipSettings>(() => {
    const session = this.sessionAuth.session();
    const tier = session?.appUser?.plan_tier || 'free';
    return {
      channelID: session?.appUser?.twitch_user_id || session?.twitchUser?.id || '',
      login: (session?.twitchUser?.login || session?.appUser?.name || '').trim().toLowerCase(),
      planTier: tier === 'premium' || tier === 'pro' ? tier : 'free'
    };
  });

  readonly planTier = computed(() => this.userSettings().planTier);

  readonly streamer = computed(() => {
    const routeStreamer = getRouteParam(this.route, 'streamer');
    return (routeStreamer || this.userSettings().login || '').trim().toLowerCase();
  });

  readonly designs = computed(() => this.clipsService.getDesigns(this.userSettings()));

  readonly premiumDesignCount = computed(
    () => this.designs().filter((design) => design.premium || design.premiumPlus).length
  );

  readonly selectedIndex = computed(() =>
    Math.min(this.activeIndex(), Math.max(this.designs().length - 1, 0))
  );

  readonly selectedDesign = computed<ClipDesign | null>(
    () => this.designs()[this.selectedIndex()] ?? null
  );

  readonly isFirstDesign = computed(() => this.selectedIndex() === 0);
  readonly isLastDesign = computed(() => this.selectedIndex() >= this.designs().length - 1);

  readonly previewUrl = computed(() => {
    const design = this.selectedDesign();
    if (!design) {
      return '';
    }

    return this.clipsService.getClipUrl(
      this.userSettings().channelID,
      design.id,
      this.config().timeoutSeconds
    );
  });

  readonly canTest = computed(() => {
    const design = this.selectedDesign();
    if (!design) {
      return false;
    }
    return Boolean(this.userSettings().channelID);
  });

  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    afterNextRender(() => this.bindTrackResize());
    this.destroyRef.onDestroy(() => this.resizeObserver?.disconnect());
  }

  t(key: string): string {
    return this.languageService.translate(key);
  }

  planTierLabel(): string {
    const tier = this.planTier();
    if (tier === 'pro') return this.t('navbar.planPro');
    if (tier === 'premium') return this.t('navbar.planPremium');
    return this.t('navbar.planFree');
  }

  statusLabel(status: ClipDesignStatus): string {
    switch (status) {
      case 'stable':
        return this.t('clips.statusStable');
      case 'beta':
        return this.t('clips.statusBeta');
      case 'alpha':
        return this.t('clips.statusAlpha');
      case 'coming_soon':
        return this.t('clips.statusComingSoon');
      default:
        return status;
    }
  }

  isDesignLocked(design: ClipDesign): boolean {
    return this.clipsService.isDesignLocked(design, this.userSettings().planTier);
  }

  goTo(index: number, behavior: ScrollBehavior = 'smooth'): void {
    const lastIndex = Math.max(this.designs().length - 1, 0);
    const clamped = Math.max(0, Math.min(index, lastIndex));
    const track = this.trackRef()?.nativeElement;
    this.activeIndex.set(clamped);

    if (!track) {
      return;
    }

    if (this.prefersReducedMotion()) {
      behavior = 'auto';
    }

    track.scrollTo({ left: this.slideOffset(clamped), behavior });
  }

  prev(): void {
    this.goTo(this.selectedIndex() - 1);
  }

  next(): void {
    this.goTo(this.selectedIndex() + 1);
  }

  onTrackScroll(): void {
    const track = this.trackRef()?.nativeElement;
    if (!track) {
      return;
    }
    const slides = Array.from(track.children) as HTMLElement[];
    let closest = 0;
    let minDistance = Number.POSITIVE_INFINITY;

    slides.forEach((slide, index) => {
      const distance = Math.abs(slide.offsetLeft - track.scrollLeft);
      if (distance < minDistance) {
        minDistance = distance;
        closest = index;
      }
    });

    if (closest !== this.activeIndex()) {
      this.activeIndex.set(closest);
    }
  }

  onViewportResize(): void {
    const track = this.trackRef()?.nativeElement;
    if (!track) {
      return;
    }
    track.scrollTo({ left: this.slideOffset(this.selectedIndex()), behavior: 'auto' });
  }

  openUpgrade(): void {
    void this.upgradeService.promptUpgradeForAnyPlan('clips_design');
  }

  updateTimeout(event: Event): void {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    this.config.update((cfg) => ({
      ...cfg,
      timeoutSeconds: Math.max(1, Math.min(30, value || 1))
    }));
  }

  async copyUrl(): Promise<void> {
    const url = this.previewUrl();
    if (!url) {
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      this.urlCopied.set(true);
      this.toastService.success(this.t('clips.copiedTitle'), this.t('clips.copiedMessage'));
      window.setTimeout(() => this.urlCopied.set(false), 2000);
    } catch {
      this.toastService.error(this.t('clips.copyFailed'), this.t('clips.copyFailedMessage'));
    }
  }

  openTestModal(): void {
    if (!this.canTest()) {
      return;
    }
    this.showTestModal.set(false);
    queueMicrotask(() => {
      this.showTestModal.set(true);
    });
  }

  private bindTrackResize(): void {
    const track = this.trackRef()?.nativeElement;
    if (!track || typeof ResizeObserver === 'undefined') {
      return;
    }
    this.resizeObserver = new ResizeObserver(() => this.onViewportResize());
    this.resizeObserver.observe(track);
  }

  private slideOffset(index: number): number {
    const track = this.trackRef()?.nativeElement;
    if (!track) {
      return 0;
    }
    const slide = track.children.item(index) as HTMLElement | null;
    return slide ? slide.offsetLeft : index * track.clientWidth;
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }
}
