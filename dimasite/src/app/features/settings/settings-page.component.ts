import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { distinctUntilChanged, firstValueFrom, map, of, shareReplay, startWith, switchMap } from 'rxjs';

import { AdminCandidate, AdminRecord } from '../../models/admin.model';
import { AdminApiService } from '../../services/admin-api.service';
import { LanguageService } from '../../services/language.service';
import { LinksService } from '../../services/links.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { LfIconComponent } from '../../shared/lf-icon/lf-icon.component';
import { AssetLibraryDialogComponent } from '../../shared/asset-library/asset-library-dialog.component';
import { CHANNEL_ADMIN_PERMISSION_GROUPS, ChannelAdminPermissionGroup } from './channel-admin-permissions';

type AreaLevel = 'off' | 'view' | 'manage';

/** Website areas grouped by what the helper will do, in the order streamers think about them. */
const AREA_SECTIONS: readonly { key: string; areas: readonly string[] }[] = [
  { key: 'stream', areas: ['commands', 'triggers', 'tts', 'rewards', 'dimafx', 'clips', 'eventsubs', 'moderation'] },
  { key: 'ai', areas: ['ai', 'memories', 'summaries'] },
  { key: 'insights', areas: ['analytics', 'billing', 'referrals'] },
  { key: 'channel', areas: ['dashboard', 'settings', 'admins'] }
];

interface ChannelResolutionState {
  streamer: string;
  channelID: string | null;
  status: 'idle' | 'loading' | 'resolved';
}

@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.css',
  imports: [LfIconComponent, AssetLibraryDialogComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'handleEscape()'
  }
})
export class SettingsPageComponent {
  readonly assetsOpen = signal(false);
  private readonly route = inject(ActivatedRoute);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly adminApi = inject(AdminApiService);
  private readonly toastService = inject(ToastService);
  private readonly http = inject(HttpClient);
  private readonly links = inject(LinksService);
  private readonly editorDialog = viewChild<ElementRef<HTMLElement>>('editorDialog');
  private readonly confirmDialog = viewChild<ElementRef<HTMLElement>>('confirmDialog');

  readonly admins = signal<AdminRecord[]>([]);
  readonly candidates = signal<AdminCandidate[]>([]);
  readonly searchQuery = signal('');
  readonly loading = signal(true);
  readonly errorMessage = signal<string | null>(null);
  readonly pendingAddIDs = signal<string[]>([]);
  readonly pendingDeleteIDs = signal<string[]>([]);
  readonly permissionPills = CHANNEL_ADMIN_PERMISSION_GROUPS
    .filter((group) => group.key !== 'chat')
    .flatMap((group) => [
      ...group.view.map((key) => ({ key, group: group.key, kind: 'view' as const })),
      ...group.manage.map((key) => ({ key, group: group.key, kind: 'manage' as const }))
    ]);
  readonly editingAdmin = signal<AdminRecord | null>(null);
  readonly editingCandidate = signal<AdminCandidate | null>(null);
  readonly fullAccess = signal(true);
  readonly draftPermissions = signal<string[]>(['chat:admin']);
  readonly chatAdminEnabled = computed(() => this.fullAccess() || this.draftPermissions().includes('chat:admin'));
  readonly hasWebsiteFeatureGrant = computed(() =>
    this.draftPermissions().some((permission) => permission !== 'chat:admin' && permission !== 'dashboard:view')
  );
  readonly canSavePermissions = computed(() => this.fullAccess() || this.draftPermissions().length > 0);
  readonly savingPermissions = signal(false);
  readonly confirmingRemoval = signal<AdminRecord | null>(null);
  readonly avatars = signal<Record<string, string>>({});
  readonly editorOpen = computed(() => Boolean(this.editingCandidate() || this.editingAdmin()));
  readonly editorName = computed(
    () => this.editingCandidate()?.display_name || this.editingCandidate()?.login || this.editingAdmin()?.adminName || ''
  );
  readonly isNewAdmin = computed(() => Boolean(this.editingCandidate()));
  readonly areaSections = AREA_SECTIONS.map((section) => ({
    key: section.key,
    areas: section.areas
      .map((key) => CHANNEL_ADMIN_PERMISSION_GROUPS.find((group) => group.key === key))
      .filter((group): group is ChannelAdminPermissionGroup => Boolean(group))
  }));
  readonly draftAreaCount = computed(() => this.grantedAreas(this.draftPermissions()).length);
  readonly draftSummary = computed(() => {
    if (this.fullAccess()) return this.t('settings.team.summary.full');
    return this.summaryFor(this.chatAdminEnabled(), this.draftAreaCount());
  });

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
    return this.sessionAuth.getPlanTierForStreamer(this.streamer());
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
  readonly backPath = computed(() => ['/', this.streamer(), 'dashboard']);

  private lastLoadedKey = '';

  constructor() {
    effect(() => {
      const target = this.confirmDialog() ?? this.editorDialog();
      if (target) queueMicrotask(() => target.nativeElement.focus());
    });

    effect(() => {
      const admins = this.admins();
      untracked(() => admins.forEach((admin) => this.loadAvatar(admin.adminName)));
    });

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

  openPermissionEditor(target: AdminRecord | AdminCandidate): void {
    if (!this.isOwnerView()) return;
    if ('adminID' in target) {
      const grants = new Set(target.permissions);
      if (grants.delete('triggers:all')) {
        for (const permission of ['triggers:view', 'triggers:upload', 'triggers:attach', 'triggers:edit', 'triggers:delete']) grants.add(permission);
      }
      if (grants.delete('dimafx:all')) {
        for (const permission of ['dimafx:view', 'dimafx:edit', 'dimafx:delete']) grants.add(permission);
      }
      for (const group of CHANNEL_ADMIN_PERMISSION_GROUPS) {
        if (group.manage.some((permission) => grants.has(permission))) {
          for (const permission of group.view) grants.add(permission);
        }
      }
      if (grants.has('admins:view')) grants.add('settings:view');
      if ([...grants].some((permission) => permission !== 'chat:admin' && permission !== '*')) {
        grants.add('dashboard:view');
      }
      this.editingAdmin.set(target);
      this.editingCandidate.set(null);
      this.fullAccess.set(target.permissions.includes('*'));
      this.draftPermissions.set(target.permissions.includes('*') ? ['chat:admin'] : [...grants]);
    } else {
      this.editingCandidate.set(target);
      this.editingAdmin.set(null);
      this.fullAccess.set(true);
      this.draftPermissions.set(['chat:admin']);
      this.clearSearch();
    }
  }

  closePermissionEditor(): void {
    if (this.savingPermissions()) return;
    this.editingAdmin.set(null);
    this.editingCandidate.set(null);
  }

  handleEscape(): void {
    if (this.confirmingRemoval()) {
      this.confirmingRemoval.set(null);
      return;
    }
    if (this.editorOpen()) this.closePermissionEditor();
  }

  /** Plain-language access summary shown on each helper row. */
  accessLabel(permissions: string[]): string {
    if (permissions.includes('*')) return this.t('settings.team.summary.full');
    return this.summaryFor(permissions.includes('chat:admin'), this.grantedAreas(permissions).length);
  }

  /** Names of the website areas a helper can open, e.g. "Commands, Text to Speech +2 more". */
  accessAreas(permissions: string[]): string {
    if (permissions.includes('*')) return this.t('settings.team.summary.fullHint');
    const names = this.grantedAreas(permissions).map((key) => this.t('settings.admins.permissions.categories.' + key));
    if (!names.length) return this.t('settings.team.summary.noPages');
    const shown = names.slice(0, 3).join(', ');
    return names.length > 3 ? this.t('settings.team.summary.more', { names: shown, count: names.length - 3 }) : shown;
  }

  areaLevel(group: ChannelAdminPermissionGroup): AreaLevel {
    const draft = this.draftPermissions();
    if (group.manage.some((key) => draft.includes(key))) return 'manage';
    if (group.view.some((key) => draft.includes(key))) return 'view';
    return 'off';
  }

  setAreaLevel(group: ChannelAdminPermissionGroup, level: AreaLevel): void {
    if (this.fullAccess()) return;
    if (level === 'off') {
      for (const key of group.view) this.toggleGrant(key, false);
      return;
    }
    for (const key of group.view) this.toggleGrant(key, true);
    if (level === 'view') {
      for (const key of group.manage) this.toggleGrant(key, false);
    } else {
      for (const key of group.manage) this.toggleGrant(key, true);
    }
  }

  isAreaLocked(group: ChannelAdminPermissionGroup): boolean {
    return group.key === 'dashboard' && this.hasWebsiteFeatureGrant();
  }

  fineLabel(key: string): string {
    return this.t('settings.team.fine.' + key.replace(':', '_'));
  }

  hasGrant(key: string): boolean {
    return this.draftPermissions().includes(key);
  }

  askRemove(admin: AdminRecord): void {
    if (!this.isOwnerView()) return;
    this.confirmingRemoval.set(admin);
  }

  async confirmRemove(): Promise<void> {
    const admin = this.confirmingRemoval();
    if (!admin) return;
    await this.deleteAdmin(admin);
    this.confirmingRemoval.set(null);
  }

  avatarFor(login: string): string | null {
    return this.avatars()[login.trim().toLowerCase()] || null;
  }

  initialFor(name: string): string {
    return (name || '?').slice(0, 1).toUpperCase();
  }

  private summaryFor(chat: boolean, areas: number): string {
    if (chat && areas) return this.t(areas === 1 ? 'settings.team.summary.chatAndOnePage' : 'settings.team.summary.chatAndPages', { count: areas });
    if (chat) return this.t('settings.team.summary.chatOnly');
    if (areas) return this.t(areas === 1 ? 'settings.team.summary.onePage' : 'settings.team.summary.pages', { count: areas });
    return this.t('settings.team.summary.dashboardOnly');
  }

  private grantedAreas(permissions: string[]): string[] {
    const prefixes = new Set(permissions.map((permission) => permission.split(':')[0]));
    return CHANNEL_ADMIN_PERMISSION_GROUPS
      .map((group) => group.key)
      .filter((key) => key !== 'chat' && key !== 'dashboard' && prefixes.has(key));
  }

  private loadAvatar(rawLogin: string): void {
    const login = rawLogin.trim().toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login) || login in this.avatars()) return;
    this.avatars.update((map) => ({ ...map, [login]: '' }));
    this.http
      .get<{ data?: { profile_image_url?: string } }>(`${this.links.getApiUrl()}/users?username=${encodeURIComponent(login)}`)
      .subscribe({
        next: (response) => {
          const url = response.data?.profile_image_url?.trim();
          if (url) this.avatars.update((map) => ({ ...map, [login]: url }));
        },
        error: () => undefined
      });
  }

  toggleGrant(key: string, enabled: boolean): void {
    if (this.fullAccess()) return;
    if (key === 'dashboard:view' && !enabled && this.hasWebsiteFeatureGrant()) return;
    const group = CHANNEL_ADMIN_PERMISSION_GROUPS.find((entry) =>
      entry.view.includes(key) || entry.manage.includes(key)
    );
    if (!group || group.key === 'chat') return;
    const next = new Set(this.draftPermissions());
    if (enabled) {
      next.add(key);
      if (group.manage.includes(key)) for (const view of group.view) next.add(view);
      if (key === 'admins:view') next.add('settings:view');
      if (key !== 'dashboard:view') next.add('dashboard:view');
    } else {
      next.delete(key);
      if (group.view.includes(key)) for (const manage of group.manage) next.delete(manage);
      if (key === 'settings:view') next.delete('admins:view');
    }
    this.draftPermissions.set([...next]);
  }

  toggleChatAdmin(enabled: boolean): void {
    if (this.fullAccess()) return;
    const next = new Set(this.draftPermissions());
    if (enabled) next.add('chat:admin');
    else next.delete('chat:admin');
    this.draftPermissions.set([...next]);
  }

  async savePermissions(): Promise<void> {
    if (this.savingPermissions() || !this.canSavePermissions()) return;
    const channelID = this.channelID();
    if (!channelID || !this.isOwnerView()) return;
    const permissions = this.fullAccess() ? ['*'] : this.draftPermissions();
    const candidate = this.editingCandidate();
    const admin = this.editingAdmin();
    if (!candidate && !admin) return;
    this.savingPermissions.set(true);
    try {
      if (candidate) {
        await this.addAdmin(candidate, permissions);
      } else if (admin) {
        const updated = await firstValueFrom(this.adminApi.updatePermissions(channelID, admin, permissions));
        this.admins.update((rows) => rows.map((row) => row.adminID === admin.adminID ? { ...row, permissions: updated } : row));
        this.toastService.success(this.t('settings.admins.permissions.saved'), admin.adminName);
      }
      this.editingCandidate.set(null);
      this.editingAdmin.set(null);
    } catch (error) {
      this.toastService.error(
        this.t('settings.admins.toasts.errorTitle'),
        error instanceof Error ? error.message : this.t('settings.admins.permissions.saveFailed')
      );
    } finally {
      this.savingPermissions.set(false);
    }
  }

  async addAdmin(candidate: AdminCandidate, permissions: string[] = ['*']): Promise<void> {
    const channelID = this.channelID();
    const channelName = this.ownerChannelLogin();

    if (!channelID || !channelName || !this.isOwnerView() || this.isAdding(candidate.id)) {
      return;
    }

    this.pendingAddIDs.update((ids) => [...ids, candidate.id]);

    try {
      await firstValueFrom(this.adminApi.addAdmin(channelID, channelName, candidate, permissions));

      this.admins.update((admins) =>
        [...admins, {
          adminName: candidate.login,
          adminID: candidate.id,
          channelName,
          channelID,
          actived: true,
          permissions
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

      throw error;
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
