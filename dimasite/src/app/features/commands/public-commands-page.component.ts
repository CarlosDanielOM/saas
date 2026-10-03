import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { LucideAngularModule, Moon, Sun } from 'lucide-angular';
import { catchError, combineLatest, distinctUntilChanged, map, of, shareReplay, switchMap } from 'rxjs';

import { Command, whoCanUsePhrase } from '../../models/command.model';
import { AnalyticsService } from '../../services/analytics.service';
import { CommandsApiService } from '../../services/commands-api.service';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ThemeService } from '../../services/theme.service';
import { BrandLogoComponent } from '../../shared/brand-logo/brand-logo.component';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import {
  BUILTIN_GROUP_ORDER,
  ReplyPart,
  builtinInfo,
  customUsage,
  formatUsage,
  realDescription,
  replyParts
} from './builtin-commands';

/** Who a command is for, from the viewer's side. */
export type Audience = 'anyone' | 'supporters' | 'mods';
const AUDIENCES: readonly Audience[] = ['anyone', 'supporters', 'mods'];

interface ChannelProfile {
  displayName: string;
  avatar: string | null;
}

@Component({
  selector: 'app-public-commands-page',
  imports: [RouterLink, LucideAngularModule, BrandLogoComponent, LfIconComponent],
  templateUrl: './public-commands-page.component.html',
  styleUrl: './public-commands-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PublicCommandsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly analytics = inject(AnalyticsService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly themeService = inject(ThemeService);
  private readonly commandsApi = inject(CommandsApiService);

  readonly moonIcon = Moon;
  readonly sunIcon = Sun;
  readonly audiences = AUDIENCES;

  readonly searchInput = signal('');
  readonly audienceFilter = signal<Audience | 'all'>('all');
  readonly copiedId = signal<string | null>(null);

  private readonly streamerParam$ = this.route.paramMap.pipe(
    map((params) => (params.get('streamer') ?? '').trim().toLowerCase()),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private readonly channelID$ = this.streamerParam$.pipe(
    switchMap((streamer) => (streamer ? this.sessionAuth.resolveChannelID(streamer) : of(null))),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly streamer = toSignal(this.streamerParam$, { initialValue: this.route.snapshot.paramMap.get('streamer') ?? '' });
  readonly channelID = toSignal(this.channelID$, { initialValue: null });

  /** Display name and avatar; falls back to the login and a letter. */
  readonly profile = toSignal(
    this.streamerParam$.pipe(
      switchMap((streamer) => !streamer ? of(null) : this.http
        .get<{ data?: { display_name?: string; profile_image_url?: string } }>(
          `${this.links.getApiUrl()}/users?username=${encodeURIComponent(streamer)}`)
        .pipe(
          map((response): ChannelProfile => ({
            displayName: response.data?.display_name || streamer,
            avatar: response.data?.profile_image_url?.trim() || null
          })),
          catchError(() => of(null))
        ))
    ),
    { initialValue: null }
  );

  readonly displayName = computed(() => this.profile()?.displayName || this.streamer());

  private readonly commandsResult = toSignal(
    combineLatest([this.channelID$, toObservable(this.languageService.currentLanguage)]).pipe(
      switchMap(([channelID]) => (channelID ? this.commandsApi.getCommands(channelID, { limit: 1000 }) : of<Command[]>([])))
    ),
    { initialValue: [] }
  );
  private readonly refreshed = signal<Command[] | null>(null);
  /** Viewers can't use commands that are off, so they aren't listed. */
  readonly commands = computed(() =>
    (this.refreshed() ?? this.commandsResult()).filter((command) => command.enabled !== false && command.activation !== 'keyword'));

  readonly loading = computed(() => this.commandsApi.listLoading());
  readonly error = computed(() => this.commandsApi.listError());
  readonly showInitialLoading = computed(() => this.loading() && this.commands().length === 0);
  readonly streamerNotFound = computed(() => !this.loading() && !this.channelID() && !!this.streamer());
  readonly showLoadError = computed(() => this.streamerNotFound() || (!!this.error() && this.commands().length === 0));
  readonly loadErrorMessage = computed(() =>
    this.streamerNotFound() ? this.t('commands.public.errors.streamerNotFound') : this.error() || this.t('commands.public.errors.loadFailed'));

  readonly sections = computed(() => {
    const query = this.searchInput().trim().toLowerCase().replace(/^!/, '');
    const filter = this.audienceFilter();
    const matches = (command: Command) => !query ||
      [command.cmd, this.title(command), this.description(command) ?? '', command.message]
        .join(' ').toLowerCase().includes(query);
    return AUDIENCES
      .filter((audience) => filter === 'all' || filter === audience)
      .map((audience) => ({
        audience,
        items: this.sortForViewers(this.commands().filter((command) => this.audience(command) === audience && matches(command)))
      }))
      .filter((section) => section.items.length > 0);
  });

  readonly audienceCounts = computed(() => {
    const counts: Record<Audience, number> = { anyone: 0, supporters: 0, mods: 0 };
    for (const command of this.commands()) counts[this.audience(command)]++;
    return counts;
  });

  readonly resultCount = computed(() => this.sections().reduce((total, section) => total + section.items.length, 0));

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  commandTrackId(command: Pick<Command, 'id' | '_id' | 'cmd'>): string {
    return command.id || command._id || command.cmd;
  }

  audience(command: Command): Audience {
    if (command.permissionExpression != null || command.permissionMode === 'tags' || command.permissionMode === 'invalid') {
      return 'supporters';
    }
    if (command.userLevel <= 1) return 'anyone';
    if (command.userLevel <= 6) return 'supporters';
    return 'mods';
  }

  /** The streamer's own commands first, then built-ins by purpose. */
  private sortForViewers(commands: Command[]): Command[] {
    const rank = (command: Command) => command.reserved ? 1 + BUILTIN_GROUP_ORDER.indexOf(builtinInfo(command).group) : 0;
    return [...commands].sort((a, b) => rank(a) - rank(b) || a.cmd.localeCompare(b.cmd));
  }

  title(command: Command): string {
    if (!command.reserved) return command.name;
    const key = `commands.builtin.name.${command.func}`;
    const title = this.t(key);
    return title === key ? command.name : title;
  }

  /** Plain explanation; null when only the reply can explain it. */
  description(command: Command): string | null {
    if (command.reserved) {
      const key = `commands.builtin.desc.${command.func}`;
      const text = this.t(key);
      return text === key ? realDescription(command) : text;
    }
    return realDescription(command);
  }

  replyParts(command: Command): ReplyPart[] {
    return replyParts(command.message || '');
  }

  usageLine(command: Command): string | null {
    const args = command.reserved ? builtinInfo(command).usage : customUsage(command.message);
    return args ? `!${command.cmd} ${formatUsage(args, (key, params) => this.t(key, params))}` : null;
  }

  whoLabel(command: Command): string {
    if (command.permissionMode === 'invalid' || command.permissionExpression != null || command.permissionMode === 'tags') {
      return this.t('commands.public.someViewers');
    }
    return whoCanUsePhrase(command.userLevel, (key, params) => this.t(key, params));
  }

  copyCommand(command: Command): void {
    const text = `!${command.cmd}`;
    const id = this.commandTrackId(command);
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(text).then(() => {
      this.copiedId.set(id);
      window.setTimeout(() => {
        if (this.copiedId() === id) this.copiedId.set(null);
      }, 1600);
    });
  }

  setAudience(audience: Audience | 'all'): void {
    this.audienceFilter.set(this.audienceFilter() === audience ? 'all' : audience);
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

  retry(): void {
    const channelID = this.channelID();
    if (!channelID || this.loading()) return;
    this.commandsApi.refreshCommands(channelID).subscribe((commands) => this.refreshed.set(commands));
  }
}
