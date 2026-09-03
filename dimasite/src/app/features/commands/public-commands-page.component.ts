import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LucideAngularModule, List, Moon, Sun, LayoutGrid } from 'lucide-angular';
import { combineLatest, distinctUntilChanged, map, of, shareReplay, switchMap } from 'rxjs';

import { Command, USER_LEVELS } from '../../models/command.model';
import { AnalyticsService } from '../../services/analytics.service';
import { CommandsApiService } from '../../services/commands-api.service';
import { BrandLogoComponent } from '../../shared/brand-logo/brand-logo.component';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';

type ViewMode = 'table' | 'card';

@Component({
  selector: 'app-public-commands-page',
  imports: [RouterLink, LucideAngularModule, BrandLogoComponent],
  templateUrl: './public-commands-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PublicCommandsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly analytics = inject(AnalyticsService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly themeService = inject(ThemeService);
  private readonly commandsApi = inject(CommandsApiService);

  readonly listIcon = List;
  readonly gridIcon = LayoutGrid;
  readonly moonIcon = Moon;
  readonly sunIcon = Sun;

  readonly viewMode = signal<ViewMode>('table');
  readonly currentPage = signal(1);
  readonly itemsPerPage = signal(10);
  readonly itemsPerPageOptions = [5, 10, 15, 20];
  readonly commands = signal<Command[]>([]);

  private readonly streamerParam$ = this.route.paramMap.pipe(
    map((params) => (params.get('streamer') ?? '').trim().toLowerCase()),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private readonly channelID$ = this.streamerParam$.pipe(
    switchMap((streamer) => {
      if (!streamer) {
        return of(null);
      }

      return this.sessionAuth.resolveChannelID(streamer);
    }),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly streamer = toSignal(this.streamerParam$, { initialValue: this.route.snapshot.paramMap.get('streamer') ?? '' });
  readonly channelID = toSignal(this.channelID$, { initialValue: null });

  private readonly commandsResult = toSignal(
    combineLatest([this.channelID$, toObservable(this.languageService.currentLanguage)]).pipe(
      switchMap(([channelID]) => {
        if (!channelID) {
          return of<Command[]>([]);
        }

        return this.commandsApi.getCommands(channelID);
      })
    ),
    { initialValue: [] }
  );

  readonly loading = computed(() => this.commandsApi.listLoading());
  readonly error = computed(() => this.commandsApi.listError());
  readonly showInitialLoading = computed(() => this.loading() && this.commands().length === 0);
  readonly streamerNotFound = computed(() => !this.loading() && !this.channelID() && !!this.streamer());
  readonly showLoadError = computed(() => this.streamerNotFound() || (!!this.error() && this.commands().length === 0));
  readonly loadErrorMessage = computed(() => {
    if (this.streamerNotFound()) {
      return this.t('commands.public.errors.streamerNotFound');
    }

    return this.error() || this.t('commands.public.errors.loadFailed');
  });
  readonly refreshButtonLabel = computed(() =>
    this.loading() ? this.t('commands.refreshing') : this.t('commands.refresh')
  );
  readonly totalCommands = computed(() => this.commands().length);
  readonly enabledCommands = computed(() => this.commands().filter((command) => command.enabled !== false).length);
  readonly disabledCommands = computed(() => this.totalCommands() - this.enabledCommands());
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.commands().length / this.itemsPerPage())));
  readonly paginatedCommands = computed(() => {
    const start = (this.currentPage() - 1) * this.itemsPerPage();
    const end = start + this.itemsPerPage();
    return this.commands().slice(start, end);
  });
  readonly pages = computed(() => {
    const total = this.totalPages();
    const current = this.currentPage();

    if (total <= 5) {
      return Array.from({ length: total }, (_, index) => index + 1);
    }

    let start = current - 2;
    let end = current + 2;

    if (start < 1) {
      start = 1;
      end = 5;
    } else if (end > total) {
      end = total;
      start = total - 4;
    }

    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });

  private readonly syncCommandsEffect = effect(() => {
    this.commands.set(this.commandsResult());
  });

  private readonly clampCurrentPageEffect = effect(() => {
    const totalPages = this.totalPages();
    const currentPage = this.currentPage();

    if (currentPage > totalPages) {
      this.currentPage.set(totalPages);
    }
  });

  private readonly resetPageOnSourceChangeEffect = effect(() => {
    this.streamer();
    this.languageService.currentLanguage();
    this.currentPage.set(1);
  });

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  commandTrackId(command: Pick<Command, 'id' | '_id'>): string {
    return command.id || command._id || '';
  }

  getUserLevelLabel(command: Command): string {
    const normalizedLevel = command.userLevelName || USER_LEVELS[command.userLevel] || 'everyone';
    return this.t(`commands.userLevels.${normalizedLevel}`);
  }

  languageLabel(): string {
    return this.languageService.currentLanguage() === 'en' ? 'EN' : 'ES';
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

  loginWithTwitch(): void {
    this.analytics.capture('public_commands_login_clicked', {
      source: 'public_commands',
      target_streamer: this.streamer(),
      channel_id: this.channelID() ?? undefined,
    });
    this.analytics.capture('auth_started', {
      source: 'public_commands',
      target_streamer: this.streamer(),
      channel_id: this.channelID() ?? undefined,
    });
    this.sessionAuth.startTwitchLogin();
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode.set(mode);
  }

  changePage(page: number): void {
    if (page < 1 || page > this.totalPages()) {
      return;
    }

    this.currentPage.set(page);
  }

  onItemsPerPageChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }

    const nextValue = Number(target.value);
    if (!Number.isFinite(nextValue) || nextValue <= 0) {
      return;
    }

    this.itemsPerPage.set(nextValue);
    this.currentPage.set(1);
  }

  hardRefreshCommands(): void {
    const channelID = this.channelID();
    if (!channelID || this.loading()) {
      return;
    }

    this.commandsApi.refreshCommands(channelID).subscribe((commands) => {
      this.commands.set(commands);
    });
  }
}
