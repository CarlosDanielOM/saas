import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { SafeUrlPipe } from '../../pipes/safe-url.pipe';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { UpgradeService } from '../../services/upgrade.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { ClipTestModalComponent } from './components/clip-test-modal.component';
import { ClipConfig, ClipDesign, ClipDesignStatus, UserClipSettings } from './clips.model';
import { ClipsService } from './clips.service';

@Component({
  selector: 'app-clips-page',
  imports: [RouterLink, SafeUrlPipe, ClipTestModalComponent],
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

  readonly config = signal<ClipConfig>({
    timeoutSeconds: 30,
    selectedDesignId: null
  });

  readonly selectedDesign = signal<ClipDesign | null>(null);
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

  selectDesign(design: ClipDesign): void {
    this.selectedDesign.set(design);
    this.config.update((cfg) => ({
      ...cfg,
      selectedDesignId: design.id
    }));
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
}
