import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import { AdminCandidate, AdminRecord } from '../../models/admin.model';
import { AdminApiService } from '../../services/admin-api.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly adminApi = inject(AdminApiService);
  private readonly toastService = inject(ToastService);

  readonly admins = signal<AdminRecord[]>([]);
  readonly candidates = signal<AdminCandidate[]>([]);
  readonly searchQuery = signal('');
  readonly loading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly pendingAddIDs = signal<string[]>([]);
  readonly pendingDeleteIDs = signal<string[]>([]);

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
  readonly planTier = computed(() => {
    const tier = this.session()?.appUser.plan_tier ?? 'free';
    if (tier === 'premium' || tier === 'pro') {
      return tier;
    }
    return 'free';
  });
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

  async retryLoad(): Promise<void> {
    const channelID = this.channelID();
    if (!channelID) {
      return;
    }

    this.adminApi.clearCache(channelID);
    await this.loadSettingsData(channelID, this.isOwnerView());
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
    await this.loadAdminData(channelID, includeCandidates);
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
}
