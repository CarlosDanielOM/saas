import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, of, startWith, switchMap } from 'rxjs';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { UpgradeService } from '../../services/upgrade.service';
import { getRouteParam, watchRouteParam } from '../../shared/utils/route-param.util';
import { ClipDesignMockComponent } from './components/clip-design-mock.component';
import { ClipDesign, ClipDesignStatus, UserClipSettings, clipDesignHeight } from './clips.model';
import { ClipsService } from './clips.service';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';

type ClipTestState = 'idle' | 'connecting' | 'sending' | 'playing' | 'error';

const STORAGE_PREFIX = 'dimasite.clips.';
const MAX_TIMEOUT_SECONDS = 30;

@Component({
  selector: 'app-clips-page',
  imports: [NgTemplateOutlet, RouterLink, ClipDesignMockComponent, LfIconComponent],
  styleUrl: './clips-page.component.css',
  templateUrl: './clips-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ClipsPageComponent {
  private readonly languageService = inject(LanguageService);
  private readonly route = inject(ActivatedRoute);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toastService = inject(ToastService);
  private readonly upgradeService = inject(UpgradeService);
  private readonly clipsService = inject(ClipsService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroyRef = inject(DestroyRef);
  private readonly stageRef = viewChild<ElementRef<HTMLElement>>('stage');

  readonly config = signal({ timeoutSeconds: MAX_TIMEOUT_SECONDS });

  readonly selectedId = signal<string | null>(null);
  readonly urlCopied = signal(false);
  readonly testingDesignId = signal<string | null>(null);
  readonly liveFrameUrl = signal<SafeResourceUrl | null>(null);
  readonly testState = signal<ClipTestState>('idle');
  readonly testError = signal('');

  readonly streamer = toSignal(watchRouteParam(this.route, 'streamer'), {
    initialValue: getRouteParam(this.route, 'streamer')
  });
  readonly channelID = toSignal(
    watchRouteParam(this.route, 'streamer').pipe(
      switchMap((streamer) => streamer
        ? this.sessionAuth.resolveChannelID(streamer).pipe(startWith(null))
        : of(null))
    ),
    { initialValue: null }
  );
  readonly canManage = toSignal(
    toObservable(this.channelID).pipe(
      switchMap((channelID) => channelID
        ? this.sessionAuth.checkPermission(channelID, 'clips:manage').pipe(
            catchError(() => of(false)),
            startWith(false)
          )
        : of(false))
    ),
    { initialValue: false }
  );
  readonly isOwnerView = computed(() =>
    Boolean(this.channelID() && this.sessionAuth.session()?.appUser.twitch_user_id === this.channelID())
  );

  readonly userSettings = computed<UserClipSettings>(() => ({
    channelID: this.channelID() ?? '',
    login: this.sessionAuth.toRouteStreamer(this.channelID() ?? '', this.streamer() ?? ''),
    planTier: this.sessionAuth.getPlanTierForStreamer(this.streamer())
  }));

  readonly planTier = computed(() => this.userSettings().planTier);

  readonly designs = computed(() => this.clipsService.getDesigns(this.userSettings()));

  readonly freeDesigns = computed(() =>
    this.designs().filter((design) => !design.premium && !design.premiumPlus)
  );

  readonly selectedDesign = computed<ClipDesign | null>(() => {
    const designs = this.designs();
    return designs.find((design) => design.id === this.selectedId()) ?? designs[0] ?? null;
  });

  /** OBS browser-source size for the selected design. */
  readonly sourceSize = computed(() => {
    const design = this.selectedDesign();
    return { width: 800, height: design ? clipDesignHeight(design.variant) : 225 };
  });

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

  readonly canTest = computed(
    () => this.canManage() && Boolean(this.selectedDesign()) && Boolean(this.userSettings().channelID)
  );

  private testSendHandle: number | null = null;
  private testAttempts = 0;

  constructor() {
    // Each channel remembers the design and duration it was last set up with.
    effect(() => {
      const streamer = this.streamer();
      untracked(() => {
        this.stopLivePreview();
        this.restorePreferences(streamer);
      });
    });
    this.destroyRef.onDestroy(() => this.clearTestSendHandle());
  }

  livePreviewUrl(design: ClipDesign): SafeResourceUrl | null {
    return this.testingDesignId() === design.id ? this.liveFrameUrl() : null;
  }

  isLivePreview(design: ClipDesign): boolean {
    return this.testingDesignId() === design.id;
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
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

  isSelected(design: ClipDesign): boolean {
    return this.selectedDesign()?.id === design.id;
  }

  selectDesign(design: ClipDesign): void {
    if (this.isSelected(design)) {
      return;
    }
    this.stopLivePreview();
    this.selectedId.set(design.id);
    this.savePreference('design', design.id);

    // On narrow screens the stage sits above the gallery; bring it back into view.
    const stage = this.stageRef()?.nativeElement;
    if (stage && stage.getBoundingClientRect().top < 0) {
      stage.scrollIntoView({ behavior: this.prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }
  }

  openUpgrade(): void {
    if (!this.isOwnerView()) return;
    void this.upgradeService.promptUpgradeForAnyPlan('clips_design');
  }

  updateTimeout(event: Event): void {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    const timeoutSeconds = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, value || 1));
    this.config.update((cfg) => ({ ...cfg, timeoutSeconds }));
    this.savePreference('timeout', String(timeoutSeconds));
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

  startTest(design: ClipDesign): void {
    if (!this.canTest()) {
      return;
    }

    const switching = this.testingDesignId() !== design.id;
    this.testingDesignId.set(design.id);
    this.testError.set('');
    this.testAttempts = 0;
    this.clearTestSendHandle();

    if (switching) {
      this.testState.set('connecting');
      this.liveFrameUrl.set(
        this.sanitizer.bypassSecurityTrustResourceUrl(this.rawPreviewUrl(design))
      );
      return;
    }

    this.sendTest(design);
  }

  retryTest(): void {
    if (!this.canManage()) return;
    const design = this.testingDesign();
    if (design) {
      this.testAttempts = 0;
      this.sendTest(design);
    }
  }

  onLiveFrameLoad(): void {
    if (this.testState() !== 'connecting') {
      return;
    }
    this.scheduleTestSend(700);
  }

  stopLivePreview(): void {
    this.clearTestSendHandle();
    if (this.testingDesignId() === null) {
      return;
    }
    this.testingDesignId.set(null);
    this.liveFrameUrl.set(null);
    this.testState.set('idle');
    this.testError.set('');
  }

  private testingDesign(): ClipDesign | null {
    return this.designs().find((design) => design.id === this.testingDesignId()) ?? null;
  }

  private rawPreviewUrl(design: ClipDesign): string {
    return this.clipsService.getClipUrl(
      this.userSettings().channelID,
      design.id,
      this.config().timeoutSeconds
    );
  }

  private sendTest(design: ClipDesign): void {
    if (!this.canTest() || this.testingDesignId() !== design.id) {
      return;
    }

    this.testState.set('sending');

    this.clipsService
      .testClip({
        channelID: this.userSettings().channelID,
        streamer: this.userSettings().login,
        timeout: this.config().timeoutSeconds
      })
      .subscribe((response) => {
        if (this.testingDesignId() !== design.id) {
          return;
        }

        if (!response.error) {
          this.testState.set('playing');
          return;
        }

        if (response.status === 409 && this.testAttempts < 4) {
          this.testAttempts += 1;
          this.scheduleTestSend(600);
          return;
        }

        this.testState.set('error');
        this.testError.set(response.message || this.t('clips.test.errorFallback'));
      });
  }

  private scheduleTestSend(delay: number): void {
    this.clearTestSendHandle();
    this.testSendHandle = window.setTimeout(() => {
      this.testSendHandle = null;
      const design = this.testingDesign();
      if (design) {
        this.sendTest(design);
      }
    }, delay);
  }

  private clearTestSendHandle(): void {
    if (this.testSendHandle !== null) {
      window.clearTimeout(this.testSendHandle);
      this.testSendHandle = null;
    }
  }

  private restorePreferences(streamer: string | null | undefined): void {
    const designId = this.readPreference(streamer, 'design');
    this.selectedId.set(designId && this.designs().some((design) => design.id === designId) ? designId : null);
    const timeout = parseInt(this.readPreference(streamer, 'timeout') ?? '', 10);
    this.config.update((cfg) => ({
      ...cfg,
      timeoutSeconds: timeout >= 1 && timeout <= MAX_TIMEOUT_SECONDS ? timeout : MAX_TIMEOUT_SECONDS
    }));
  }

  private readPreference(streamer: string | null | undefined, key: string): string | null {
    if (!streamer || typeof localStorage === 'undefined') return null;
    try {
      return localStorage.getItem(`${STORAGE_PREFIX}${key}.${streamer.toLowerCase()}`);
    } catch {
      return null;
    }
  }

  private savePreference(key: string, value: string): void {
    const streamer = this.streamer();
    if (!streamer || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${key}.${streamer.toLowerCase()}`, value);
    } catch {
      // Private mode or full storage: the page still works without remembering.
    }
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }
}
