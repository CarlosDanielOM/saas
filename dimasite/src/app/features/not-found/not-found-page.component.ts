import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Moon, Sun } from 'lucide-angular';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';

type DashboardLink = ['/', string, 'dashboard'] | ['/login'];

@Component({
  selector: 'app-not-found-page',
  imports: [RouterLink, LucideAngularModule],
  templateUrl: './not-found-page.component.html',
  styleUrl: './not-found-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class NotFoundPageComponent {
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly themeService = inject(ThemeService);

  readonly sunIcon = Sun;
  readonly moonIcon = Moon;

  readonly session = this.sessionAuth.session;
  readonly lastViewedStreamer = this.sessionAuth.lastViewedStreamer;

  readonly isAdminViewer = computed(() => Boolean(this.session()?.appUser.administrating.length));

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
    return streamer ? ['/', streamer, 'dashboard'] : ['/login'];
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
    return streamer ? ['/', streamer, 'dashboard'] : ['/login'];
  });

  readonly lastViewedDashboardName = computed(() =>
    this.resolveDashboardName(this.lastViewedDashboardStreamer())
  );

  readonly messageKey = computed(() =>
    this.session()
      ? this.isAdminViewer() && this.hasSeparateLastViewedDashboard()
        ? 'notFound.messageAdminAuthenticated'
        : 'notFound.messageAuthenticated'
      : 'notFound.message'
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

  ownDashboardLabel(): string {
    const name = this.ownDashboardName();
    return name
      ? this.t('notFound.actions.dashboardNamed', { name })
      : this.t('notFound.actions.dashboard');
  }

  lastViewedDashboardLabel(): string {
    const name = this.lastViewedDashboardName();
    return name
      ? this.t('notFound.actions.lastViewedDashboardNamed', { name })
      : this.t('notFound.actions.lastViewedDashboard');
  }

  myDashboardLabel(): string {
    const name = this.ownDashboardName();
    return name
      ? this.t('notFound.actions.myDashboardNamed', { name })
      : this.t('notFound.actions.myDashboard');
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
