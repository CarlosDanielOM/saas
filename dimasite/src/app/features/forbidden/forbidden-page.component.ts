import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LucideAngularModule, Moon, Sun } from 'lucide-angular';

import { BrandLogoComponent } from '../../shared/brand-logo/brand-logo.component';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';

type DashboardLink = ['/', string, 'dashboard'] | ['/'];

@Component({
  selector: 'app-forbidden-page',
  imports: [RouterLink, LucideAngularModule, BrandLogoComponent],
  templateUrl: './forbidden-page.component.html',
  styleUrl: './forbidden-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ForbiddenPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly themeService = inject(ThemeService);

  readonly sunIcon = Sun;
  readonly moonIcon = Moon;

  readonly session = this.sessionAuth.session;
  readonly lastViewedStreamer = this.sessionAuth.lastViewedStreamer;
  readonly isEmbeddedLayout = signal(Boolean(this.route.snapshot.data['embeddedLayout']));
  readonly streamer = signal(this.resolveStreamer());
  readonly requestedPermission = signal(
    this.route.snapshot.queryParamMap.get('permission') ??
      (this.route.snapshot.data['previewPermission'] as string | undefined) ??
      ''
  );
  readonly requestedRoute = signal(this.route.snapshot.queryParamMap.get('from') ?? '');

  readonly isAdminViewer = computed(() => Boolean(this.session()?.appUser.administrating.length));
  readonly showPermissionBadge = computed(
    () => Boolean(this.requestedPermission()) && (this.isAdminViewer() || !this.isEmbeddedLayout())
  );

  readonly ownDashboardStreamer = computed(() => {
    const current = this.session();
    if (!current) {
      return '';
    }

    const channelID = current.appUser.twitch_user_id || current.twitchUser.id;
    return this.sessionAuth.toRouteStreamer(channelID);
  });

  readonly ownDashboardLink = computed<DashboardLink>(() => {
    const streamer = this.ownDashboardStreamer();
    return streamer ? ['/', streamer, 'dashboard'] : ['/'];
  });

  readonly ownDashboardName = computed(() => {
    const current = this.session();
    if (!current) {
      return '';
    }

    return current.twitchUser.display_name?.trim() || current.twitchUser.login?.trim() || '';
  });

  readonly lastViewedDashboardStreamer = computed(() => {
    const current = this.session();
    const lastViewed = this.lastViewedStreamer()?.trim().toLowerCase() ?? '';
    if (!current || !lastViewed) {
      return '';
    }

    const ownerLogin = current.twitchUser.login?.trim().toLowerCase() || '';
    const ownerChannelID = current.appUser.twitch_user_id?.trim().toLowerCase() || '';
    if (lastViewed === ownerLogin || lastViewed === ownerChannelID) {
      return lastViewed;
    }

    const isManagedChannel = current.appUser.administrating.some((entry) => {
      const channelName = entry.channelName?.trim().toLowerCase() || '';
      const channelID = entry.channelID?.trim().toLowerCase() || '';
      return lastViewed === channelName || lastViewed === channelID;
    });

    return isManagedChannel ? lastViewed : '';
  });

  readonly hasSeparateLastViewedDashboard = computed(() => {
    const lastViewed = this.lastViewedDashboardStreamer();
    const ownDashboard = this.ownDashboardStreamer();
    return Boolean(lastViewed) && lastViewed !== ownDashboard;
  });

  readonly lastViewedDashboardLink = computed<DashboardLink>(() => {
    const streamer = this.lastViewedDashboardStreamer();
    return streamer ? ['/', streamer, 'dashboard'] : ['/'];
  });

  readonly lastViewedDashboardName = computed(() =>
    this.resolveDashboardName(this.lastViewedDashboardStreamer())
  );

  readonly primaryActionLink = computed<DashboardLink>(() => {
    const routeStreamer = this.streamer().trim();
    if (routeStreamer) {
      return ['/', routeStreamer, 'dashboard'];
    }

    const ownDashboardStreamer = this.ownDashboardStreamer();
    return ownDashboardStreamer ? ['/', ownDashboardStreamer, 'dashboard'] : ['/'];
  });

  readonly primaryActionLabelKey = computed(() =>
    this.session() || this.streamer() ? 'forbidden.actions.dashboard' : 'forbidden.actions.home'
  );

  readonly messageKey = computed(() =>
    this.session() && this.isAdminViewer() && this.hasSeparateLastViewedDashboard()
      ? 'forbidden.messageAdminAuthenticated'
      : 'forbidden.message'
  );

  t(key: string, params?: Record<string, string | number>): string {
    this.languageService.currentLanguage();
    return this.languageService.translate(key, params);
  }

  languageLabel(): string {
    return this.languageService.currentLanguage() === 'en' ? 'English · ES' : 'Español · EN';
  }

  isDarkMode(): boolean {
    return this.themeService.isDarkMode();
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  toggleLanguage(): void {
    this.languageService.toggleLanguage();
  }

  primaryDashboardLabel(): string {
    const routeName = this.resolveDashboardName(this.streamer());
    const ownName = this.ownDashboardName();
    const name = routeName || ownName;
    return name
      ? this.t('forbidden.actions.dashboardNamed', { name })
      : this.t(this.primaryActionLabelKey());
  }

  lastViewedDashboardLabel(): string {
    const name = this.lastViewedDashboardName();
    return name
      ? this.t('forbidden.actions.lastViewedDashboardNamed', { name })
      : this.t('forbidden.actions.lastViewedDashboard');
  }

  myDashboardLabel(): string {
    const name = this.ownDashboardName();
    return name
      ? this.t('forbidden.actions.myDashboardNamed', { name })
      : this.t('forbidden.actions.myDashboard');
  }

  requestedPermissionLabel(): string {
    return this.requestedPermission();
  }

  requestedRouteLabel(): string {
    const value = this.requestedRoute();
    if (!value) {
      return '';
    }

    return value.length > 54 ? `${value.slice(0, 51)}...` : value;
  }

  private resolveStreamer(): string {
    return (
      this.route.snapshot.paramMap.get('streamer') ??
      this.route.snapshot.parent?.paramMap.get('streamer') ??
      ''
    );
  }

  private resolveDashboardName(streamer: string): string {
    const current = this.session();
    const normalizedStreamer = streamer.trim().toLowerCase();
    if (!current || !normalizedStreamer) {
      return '';
    }

    const ownerLogin = current.twitchUser.login?.trim().toLowerCase() || '';
    const ownerChannelID = current.appUser.twitch_user_id?.trim().toLowerCase() || '';
    if (normalizedStreamer === ownerLogin || normalizedStreamer === ownerChannelID) {
      return current.twitchUser.display_name?.trim() || current.twitchUser.login?.trim() || streamer;
    }

    const managedChannel = current.appUser.administrating.find((entry) => {
      const channelName = entry.channelName?.trim().toLowerCase() || '';
      const channelID = entry.channelID?.trim().toLowerCase() || '';
      return normalizedStreamer === channelName || normalizedStreamer === channelID;
    });

    return managedChannel?.channelName?.trim() || streamer;
  }
}
