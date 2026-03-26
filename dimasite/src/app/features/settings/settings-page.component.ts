import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import {
  AlertCircle,
  Globe2,
  LucideAngularModule,
  Mic2,
  Search,
  Shield,
  ShieldPlus,
  Sparkles,
  Trash2,
  UserRound,
  Volume2,
  X
} from 'lucide-angular';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import { LoadingIndicatorComponent } from '../../components/loading';
import { AdminCandidate, AdminRecord } from '../../models/admin.model';
import { TtsRole, TtsSettings } from '../../models/tts-settings.model';
import { AdminApiService } from '../../services/admin-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { TtsSettingsApiService } from '../../services/tts-settings-api.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

@Component({
  selector: 'app-settings-page',
  imports: [LucideAngularModule, LoadingIndicatorComponent],
  templateUrl: './settings-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly adminApi = inject(AdminApiService);
  private readonly ttsSettingsApi = inject(TtsSettingsApiService);
  private readonly toastService = inject(ToastService);

  readonly searchIcon = Search;
  readonly clearIcon = X;
  readonly adminIcon = Shield;
  readonly addAdminIcon = ShieldPlus;
  readonly deleteIcon = Trash2;
  readonly userIcon = UserRound;
  readonly alertIcon = AlertCircle;
  readonly micIcon = Mic2;
  readonly languageIcon = Globe2;
  readonly voiceIcon = Volume2;
  readonly sparklesIcon = Sparkles;

  readonly admins = signal<AdminRecord[]>([]);
  readonly candidates = signal<AdminCandidate[]>([]);
  readonly searchQuery = signal('');
  readonly loading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly pendingAddIDs = signal<string[]>([]);
  readonly pendingDeleteIDs = signal<string[]>([]);
  readonly ttsSettings = signal<TtsSettings | null>(null);
  readonly initialTtsSettings = signal<TtsSettings | null>(null);
  readonly ttsRole = signal<TtsRole>('none');
  readonly ttsLoading = signal(false);
  readonly ttsSaving = signal(false);
  readonly ttsErrorMessage = signal<string | null>(null);

  private readonly streamerParam$ = this.route.paramMap.pipe(
    map(() => (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()),
    distinctUntilChanged(),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  private readonly channelID$ = this.streamerParam$.pipe(
    switchMap((streamer) => {
      if (!streamer) {
        return of<ChannelResolutionState>({
          streamer,
          channelID: null,
          status: 'idle'
        });
      }

      return this.sessionAuth.resolveChannelID(streamer).pipe(
        map((channelID) => ({
          streamer,
          channelID,
          status: 'resolved' as const
        })),
        startWith({
          streamer,
          channelID: null,
          status: 'loading' as const
        })
      );
    }),
    shareReplay({ bufferSize: 1, refCount: true })
  );

  readonly streamer = toSignal(this.streamerParam$, {
    initialValue: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase()
  });
  readonly channelResolution = toSignal(this.channelID$, {
    initialValue: {
      streamer: (getRouteParam(this.route, 'streamer') ?? '').trim().toLowerCase(),
      channelID: null,
      status: 'loading'
    } satisfies ChannelResolutionState
  });
  readonly channelID = computed(() => this.channelResolution().channelID);
  readonly isChannelResolving = computed(() => this.channelResolution().status === 'loading');
  readonly session = this.sessionAuth.session;
  readonly ownerChannelID = computed(() => this.session()?.appUser.twitch_user_id ?? '');
  readonly ownerLogin = computed(() => (this.session()?.twitchUser.login || '').trim().toLowerCase());
  readonly isOwnerView = computed(() => {
    const streamer = this.streamer().trim().toLowerCase();
    const channelID = this.channelID();
    const ownerChannelID = this.ownerChannelID();
    const ownerLogin = this.ownerLogin();

    if (streamer && ownerLogin && streamer === ownerLogin) {
      return true;
    }

    return Boolean(channelID) && channelID === ownerChannelID;
  });
  readonly ownerChannelLogin = computed(() => {
    const current = this.session();
    return (current?.twitchUser.login || this.streamer()).trim().toLowerCase();
  });
  readonly normalizedSearchQuery = computed(() => this.searchQuery().trim().toLowerCase());
  readonly filteredCandidates = computed(() => {
    const query = this.normalizedSearchQuery();
    const pool = this.candidates();

    if (!query) {
      return [];
    }

    return pool
      .filter((candidate) => {
        const haystacks = [candidate.login, candidate.display_name, candidate.id];
        return haystacks.some((value) => value.toLowerCase().includes(query));
      })
      .slice(0, 8);
  });
  readonly searchResultCount = computed(() => {
    const query = this.normalizedSearchQuery();
    if (!query) {
      return 0;
    }

    return this.candidates().filter((candidate) => {
      const haystacks = [candidate.login, candidate.display_name, candidate.id];
      return haystacks.some((value) => value.toLowerCase().includes(query));
    }).length;
  });
  readonly hasCandidateResults = computed(() => this.filteredCandidates().length > 0);
  readonly isSearchIdle = computed(() => this.normalizedSearchQuery().length === 0);
  readonly showSearchDropdown = computed(() => this.isOwnerView() && !this.isSearchIdle());
  readonly hasTtsSettings = computed(() => this.ttsSettings() !== null);
  readonly ttsReadOnly = computed(() => this.ttsRole() !== 'owner');
  readonly ttsDirty = computed(
    () => this.serializeTtsSettings(this.ttsSettings()) !== this.serializeTtsSettings(this.initialTtsSettings())
  );

  private lastLoadedKey = '';

  constructor() {
    effect(() => {
      const resolution = this.channelResolution();

      if (resolution.status === 'idle') {
        this.loading.set(false);
        this.errorMessage.set(this.t('settings.admins.errors.channelNotResolved'));
        this.admins.set([]);
        this.candidates.set([]);
        this.lastLoadedKey = '';
        return;
      }

      if (resolution.status === 'loading') {
        this.loading.set(true);
        return;
      }

      if (!resolution.channelID) {
        this.loading.set(false);
        this.errorMessage.set(this.t('settings.admins.errors.channelNotResolved'));
        this.admins.set([]);
        this.candidates.set([]);
        this.lastLoadedKey = '';
        return;
      }

      const channelID = resolution.channelID;

      const loadKey = `${channelID}:${this.isOwnerView() ? 'owner' : 'admin'}`;
      if (this.lastLoadedKey === loadKey) {
        return;
      }

      this.lastLoadedKey = loadKey;
      void this.loadSettingsData(channelID, this.isOwnerView());
    });
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  onSearchInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    this.searchQuery.set(target.value);
  }

  clearSearch(): void {
    this.searchQuery.set('');
  }

  updateTtsEnabled(enabled: boolean): void {
    this.patchTtsSettings((settings) => ({
      ...settings,
      enabled
    }));
  }

  updateTtsDefaultLanguage(language: 'en' | 'es'): void {
    this.patchTtsSettings((settings) => ({
      ...settings,
      defaultLanguage: language
    }));
  }

  updateTtsVoice(language: 'en' | 'es', event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    const value = target.value;
    this.patchTtsSettings((settings) => ({
      ...settings,
      voices: {
        ...settings.voices,
        [language]: value
      }
    }));
  }

  updateTtsFilter(filter: 'skipEmotes' | 'stripLinks' | 'normalizeWhitespace', enabled: boolean): void {
    this.patchTtsSettings((settings) => ({
      ...settings,
      filters: {
        ...settings.filters,
        [filter]: enabled
      }
    }));
  }

  updateTtsMaxLength(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    const parsed = Number.parseInt(target.value || '', 10);
    const maxLength = Number.isFinite(parsed) ? Math.max(30, Math.min(500, parsed)) : 280;

    this.patchTtsSettings((settings) => ({
      ...settings,
      filters: {
        ...settings.filters,
        maxLength
      }
    }));
  }

  async retryLoad(): Promise<void> {
    const channelID = this.channelID();
    if (!channelID) {
      return;
    }

    this.adminApi.clearCache(channelID);
    await this.loadSettingsData(channelID, this.isOwnerView());
  }

  async saveTtsSettings(): Promise<void> {
    const channelID = this.channelID();
    const settings = this.ttsSettings();

    if (!channelID || !settings || this.ttsReadOnly() || this.ttsSaving() || !this.ttsDirty()) {
      return;
    }

    this.ttsSaving.set(true);
    this.ttsErrorMessage.set(null);

    try {
      const response = await firstValueFrom(this.ttsSettingsApi.updateSettings(channelID, settings));
      this.ttsRole.set(response.role);
      this.ttsSettings.set(response.settings);
      this.initialTtsSettings.set(this.cloneTtsSettings(response.settings));

      this.toastService.success(
        this.t('settings.tts.toasts.savedTitle'),
        this.t('settings.tts.toasts.savedMessage')
      );
    } catch (error) {
      console.error('Failed to save TTS settings:', {
        channelID,
        settings,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });

      const message = error instanceof Error ? error.message : this.t('settings.tts.errors.saveFailed');
      this.ttsErrorMessage.set(message);
      this.toastService.error(
        this.t('settings.tts.toasts.errorTitle'),
        message
      );
    } finally {
      this.ttsSaving.set(false);
    }
  }

  async addAdmin(candidate: AdminCandidate): Promise<void> {
    const channelID = this.channelID();
    const channelName = this.ownerChannelLogin();

    if (!channelID || !channelName || !this.isOwnerView() || this.isAdding(candidate.id)) {
      return;
    }

    this.pendingAddIDs.update((ids) => [...ids, candidate.id]);

    try {
      await firstValueFrom(this.adminApi.addAdmin(channelID, channelName, candidate));

      this.admins.update((admins) =>
        [...admins, {
          adminName: candidate.login,
          adminID: candidate.id,
          channelName,
          channelID,
          actived: true,
          permissions: ['*']
        }].sort((left, right) => left.adminName.localeCompare(right.adminName))
      );
      this.candidates.update((candidates) => candidates.filter((entry) => entry.id !== candidate.id));

      this.toastService.success(
        this.t('settings.admins.toasts.addedTitle'),
        this.t('settings.admins.toasts.addedMessage', { name: candidate.display_name || candidate.login })
      );
      this.clearSearch();
    } catch (error) {
      console.error('Failed to add admin:', {
        channelID,
        candidate,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });

      this.toastService.error(
        this.t('settings.admins.toasts.errorTitle'),
        error instanceof Error ? error.message : this.t('settings.admins.errors.addFailed')
      );
    } finally {
      this.pendingAddIDs.update((ids) => ids.filter((id) => id !== candidate.id));
    }
  }

  async deleteAdmin(admin: AdminRecord): Promise<void> {
    const channelID = this.channelID();

    if (!channelID || !this.isOwnerView() || this.isDeleting(admin.adminID)) {
      return;
    }

    this.pendingDeleteIDs.update((ids) => [...ids, admin.adminID]);

    try {
      await firstValueFrom(this.adminApi.deleteAdmin(channelID, admin));

      this.admins.update((admins) => admins.filter((entry) => entry.adminID !== admin.adminID));
      this.candidates.update((candidates) =>
        [...candidates, {
          id: admin.adminID,
          login: admin.adminName,
          display_name: admin.adminName
        }].sort((left, right) => left.login.localeCompare(right.login))
      );

      this.toastService.success(
        this.t('settings.admins.toasts.deletedTitle'),
        this.t('settings.admins.toasts.deletedMessage', { name: admin.adminName })
      );
    } catch (error) {
      console.error('Failed to delete admin:', {
        channelID,
        admin,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });

      this.toastService.error(
        this.t('settings.admins.toasts.errorTitle'),
        error instanceof Error ? error.message : this.t('settings.admins.errors.deleteFailed')
      );
    } finally {
      this.pendingDeleteIDs.update((ids) => ids.filter((id) => id !== admin.adminID));
    }
  }

  isAdding(candidateID: string): boolean {
    return this.pendingAddIDs().includes(candidateID);
  }

  isDeleting(adminID: string): boolean {
    return this.pendingDeleteIDs().includes(adminID);
  }

  private async loadSettingsData(channelID: string, includeCandidates: boolean): Promise<void> {
    await Promise.all([
      this.loadAdminData(channelID, includeCandidates),
      this.loadTtsSettings(channelID)
    ]);
  }

  private async loadAdminData(channelID: string, includeCandidates: boolean): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);

    try {
      const [admins, candidates] = await Promise.all([
        firstValueFrom(this.adminApi.getAdmins(channelID)),
        includeCandidates ? firstValueFrom(this.adminApi.getCandidates(channelID)) : Promise.resolve([])
      ]);

      this.admins.set(admins);
      this.candidates.set(candidates);
    } catch (error) {
      console.error('Failed to load admin settings data:', {
        channelID,
        includeCandidates,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });

      this.errorMessage.set(
        error instanceof Error ? error.message : this.t('settings.admins.errors.loadFailed')
      );
      this.admins.set([]);
      this.candidates.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadTtsSettings(channelID: string): Promise<void> {
    this.ttsLoading.set(true);
    this.ttsErrorMessage.set(null);

    try {
      const response = await firstValueFrom(this.ttsSettingsApi.getSettings(channelID));
      this.ttsRole.set(response.role);
      this.ttsSettings.set(response.settings);
      this.initialTtsSettings.set(this.cloneTtsSettings(response.settings));
    } catch (error) {
      console.error('Failed to load TTS settings:', {
        channelID,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });

      this.ttsRole.set('none');
      this.ttsSettings.set(null);
      this.initialTtsSettings.set(null);
      this.ttsErrorMessage.set(
        error instanceof Error ? error.message : this.t('settings.tts.errors.loadFailed')
      );
    } finally {
      this.ttsLoading.set(false);
    }
  }

  private patchTtsSettings(updater: (settings: TtsSettings) => TtsSettings): void {
    if (this.ttsReadOnly()) {
      return;
    }

    this.ttsSettings.update((settings) => (settings ? updater(settings) : settings));
  }

  private cloneTtsSettings(settings: TtsSettings): TtsSettings {
    return {
      ...settings,
      voices: { ...settings.voices },
      filters: { ...settings.filters },
      queue: { ...settings.queue }
    };
  }

  private serializeTtsSettings(settings: TtsSettings | null): string {
    return settings ? JSON.stringify(settings) : '';
  }
}
