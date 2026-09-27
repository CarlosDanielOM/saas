import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { catchError, forkJoin, of, switchMap } from 'rxjs';
import {
  Bot,
  Brain,
  ChartColumn,
  FileText,
  FolderOpen,
  Gift,
  Hammer,
  Lightbulb,
  LucideAngularModule,
  MessagesSquare,
  Scissors,
  ShieldAlert,
  Sparkles,
  Users,
  Volume2,
  X,
  Zap,
  type LucideIconData
} from 'lucide-angular';

import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { getRouteParam } from '../../shared/utils/route-param.util';
import {
  type ModuleId,
  type PlanTier,
  type ModuleStatus,
  MODULE_TIER_REQUIREMENTS,
  isModuleAccessible
} from './module-tier.model';

type Category = 'all' | 'engagement' | 'automation' | 'content';

interface ModuleCategoryOption {
  id: Category;
  labelKey: string;
}

interface ModuleDisplay {
  id: ModuleId;
  name: string;
  description: string;
  path: string | null;
  category: Exclude<Category, 'all'>;
  status: ModuleStatus;
  minTier: PlanTier;
  isLocked: boolean;
  icon: LucideIconData;
  priority: number;
  featured: boolean;
}

interface ModuleGroup {
  labelKey: string | null;
  modules: ModuleDisplay[];
}

/**
 * Modules surfaced in the "Core tools" group. Priority still drives the order
 * within the group, but membership is explicit so adding a module here does not
 * silently pull in unrelated modules below a priority threshold.
 */
const CORE_MODULE_IDS: readonly ModuleId[] = [
  'chat-events',
  'moderation',
  'clips',
  'dimafx',
  'triggers',
  'tts'
];

/** Matches the page guards. Overlay Studio and Roulette are broadcaster-only. */
const MODULE_VIEW_PERMISSIONS: Readonly<Record<ModuleId, string | null>> = {
  overlays: null,
  roulette: null,
  clips: 'clips:view',
  'chat-events': 'eventsubs:view',
  triggers: 'triggers:view',
  dimafx: 'dimafx:view',
  redemptions: 'rewards:view',
  tts: 'tts:view',
  referrals: 'referrals:view',
  'ai-personality': 'ai:view',
  memories: 'memories:view',
  analytics: 'analytics:view',
  'analytics.follows': 'analytics:view',
  'follow-defense': 'moderation:view',
  moderation: 'moderation:view',
  'stream-summaries': 'summaries:view',
  library: 'triggers:view',
  'clip-recommendations': 'clips:view'
};

const MODULE_ICONS: Record<ModuleId, LucideIconData> = {
  roulette: Sparkles,
  overlays: Sparkles,
  'chat-events': MessagesSquare,
  moderation: Hammer,
  clips: Scissors,
  dimafx: Sparkles,
  redemptions: Gift,
  triggers: Zap,
  tts: Volume2,
  referrals: Users,
  'ai-personality': Bot,
  memories: Brain,
  'follow-defense': ShieldAlert,
  analytics: ChartColumn,
  'analytics.follows': ChartColumn,
  'stream-summaries': FileText,
  library: FolderOpen,
  'clip-recommendations': Lightbulb
};

@Component({
  selector: 'app-modules-page',
  imports: [LucideAngularModule],
  templateUrl: './modules-page.component.html',
  styleUrl: './modules-page.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ModulesPageComponent {
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly upgradeService = inject(UpgradeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly userPlanTier = computed<PlanTier>(() => {
    return this.sessionAuth.getPlanTierForStreamer(this.streamer());
  });

  readonly streamer = computed(() => {
    const routeStreamer = getRouteParam(this.route, 'streamer');
    const sessionStreamer =
      this.sessionAuth.session()?.twitchUser.login || this.sessionAuth.session()?.appUser?.name;
    return (routeStreamer || sessionStreamer || '').trim().toLowerCase();
  });
  private readonly accessIdentity = computed(() => {
    const current = this.sessionAuth.session();
    return `${current?.appUser.twitch_user_id ?? ''}:${current?.twitchUser.login ?? ''}`;
  });
  readonly allowedModules = signal<ReadonlySet<ModuleId>>(new Set());
  readonly accessReady = signal(false);
  readonly isManagedChannel = computed(() => {
    const current = this.sessionAuth.session();
    const streamer = this.streamer();
    return Boolean(current && streamer && streamer !== current.twitchUser.login?.toLowerCase() && streamer !== current.appUser.twitch_user_id);
  });

  readonly searchQuery = signal('');
  readonly selectedCategory = signal<Category>('all');
  readonly closeIcon = X;

  readonly categories: ModuleCategoryOption[] = [
    { id: 'all', labelKey: 'modules.categories.all' },
    { id: 'engagement', labelKey: 'modules.categories.engagement' },
    { id: 'automation', labelKey: 'modules.categories.automation' },
    { id: 'content', labelKey: 'modules.categories.content' }
  ];

  readonly modules = computed<ModuleDisplay[]>(() => {
    this.languageService.currentLanguage();
    const userPlanTier = this.userPlanTier();
    const streamerName = this.streamer();

    return [
      this.buildModule('overlays', this.t('overlayStudio.studio'), 'overlayStudio.description', streamerName, userPlanTier),
      this.buildModule('roulette', this.t('roulette.title'), 'roulette.subtitle', streamerName, userPlanTier),
      this.buildModule('clips', 'Clips', 'modules.clips.description', streamerName, userPlanTier),
      this.buildModule(
        'chat-events',
        'Chat Events',
        'modules.chatEvents.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule(
        'triggers',
        'Triggers',
        'modules.triggers.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule('dimafx', 'DimaFX', 'modules.dimafx.description', streamerName, userPlanTier),
      this.buildModule(
        'tts',
        'Text to Speech',
        'modules.tts.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule(
        'referrals',
        'Referrals',
        'modules.referrals.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule(
        'redemptions',
        'Redemptions',
        'modules.redemptions.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule(
        'ai-personality',
        'AI Personality',
        'modules.aiPersonality.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule(
        'memories',
        'Memories',
        'modules.memories.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule(
        'analytics',
        'Analytics',
        'modules.analytics.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule(
        'follow-defense',
        'Follow Defense',
        'modules.followDefense.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule(
        'moderation',
        'Chat Moderation',
        'modules.moderation.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule(
        'stream-summaries',
        'Stream Summaries',
        'modules.streamSummaries.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule(
        'clip-recommendations',
        'Clip Recommendations',
        'modules.clipRecommendations.description',
        streamerName,
        userPlanTier
      ),
      this.buildModule(
        'library',
        'Media Library',
        'modules.library.description',
        streamerName,
        userPlanTier
      )
    ].filter((module) => this.allowedModules().has(module.id)).sort((a, b) => a.priority - b.priority);
  });

  constructor() {
    effect((onCleanup) => {
      this.accessIdentity();
      const streamer = this.streamer();
      const current = untracked(this.sessionAuth.session);
      this.accessReady.set(false);
      this.allowedModules.set(new Set());
      if (!current || !streamer) return;

      if (streamer === current.twitchUser.login?.toLowerCase() || streamer === current.appUser.twitch_user_id) {
        this.allowedModules.set(new Set(Object.keys(MODULE_VIEW_PERMISSIONS) as ModuleId[]));
        this.accessReady.set(true);
        return;
      }

      const permissions = [...new Set(Object.values(MODULE_VIEW_PERMISSIONS).filter((value): value is string => Boolean(value)))];
      const subscription = untracked(() => this.sessionAuth.resolveChannelID(streamer).pipe(
        switchMap((channelID) => channelID
          ? forkJoin(permissions.map((permission) => this.sessionAuth.checkPermission(channelID, permission).pipe(catchError(() => of(false)))))
          : of(permissions.map(() => false))),
        catchError(() => of(permissions.map(() => false)))
      ).subscribe((granted) => {
        const allowedPermissions = new Set(permissions.filter((_, index) => granted[index]));
        this.allowedModules.set(new Set(
          (Object.entries(MODULE_VIEW_PERMISSIONS) as [ModuleId, string | null][])
            .filter(([, permission]) => permission && allowedPermissions.has(permission))
            .map(([moduleID]) => moduleID)
        ));
        this.accessReady.set(true);
      }));
      onCleanup(() => subscription.unsubscribe());
    });
  }

  /** Grouped by importance on the default view; a flat list when searching or filtering. */
  readonly moduleGroups = computed<ModuleGroup[]>(() => {
    const filtered = this.filteredModules();
    const grouped = this.selectedCategory() === 'all' && !this.searchQuery().trim();

    if (!grouped) {
      return [{ labelKey: null, modules: filtered }];
    }

    const featured = filtered.filter((module) => module.featured);
    const rest = filtered.filter((module) => !module.featured);

    return [
      { labelKey: 'modules.core', modules: featured },
      { labelKey: 'modules.more', modules: rest }
    ].filter((group) => group.modules.length > 0);
  });

  readonly filteredModules = computed(() => {
    let filtered = this.modules();

    if (this.selectedCategory() !== 'all') {
      filtered = filtered.filter((module) => module.category === this.selectedCategory());
    }

    const query = this.searchQuery().toLowerCase().trim();
    if (query) {
      filtered = filtered.filter(
        (module) =>
          module.name.toLowerCase().includes(query) ||
          module.description.toLowerCase().includes(query)
      );
    }

    return filtered;
  });

  readonly availableCount = computed(
    () => this.modules().filter((module) => !module.isLocked && Boolean(module.path)).length
  );
  readonly lockedCount = computed(() => this.modules().filter((module) => module.isLocked).length);

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  planTierLabel(): string {
    const tier = this.userPlanTier();
    if (tier === 'pro') return this.t('navbar.planPro');
    if (tier === 'premium') return this.t('navbar.planPremium');
    return this.t('navbar.planFree');
  }

  statusLabel(status: ModuleStatus): string {
    switch (status) {
      case 'stable':
        return this.t('modules.status.stable');
      case 'beta':
        return this.t('modules.status.beta');
      case 'alpha':
        return this.t('modules.status.alpha');
      case 'coming_soon':
        return this.t('modules.status.comingSoon');
      case 'under_construction':
        return this.t('modules.status.underConstruction');
      case 'maintenance':
        return this.t('modules.status.maintenance');
      default:
        return status;
    }
  }

  accessText(module: ModuleDisplay): string {
    if (!module.path) {
      if (module.status === 'coming_soon') {
        return this.t('modules.comingSoon');
      }
      return this.t('modules.unavailable');
    }

    if (module.isLocked) {
      if (this.isManagedChannel()) return this.t('modules.unavailable');
      return this.t('modules.upgradeToAccess');
    }

    if (module.status === 'coming_soon') {
      return this.t('modules.comingSoon');
    }

    return this.t('modules.openModule');
  }

  lockedSubtext(module: ModuleDisplay): string | null {
    if (module.isLocked && module.status === 'coming_soon') {
      const tierName =
        module.minTier === 'pro' ? this.t('navbar.planPro') : this.t('navbar.planPremium');
      return this.t('modules.comingSoonLocked', { tier: tierName });
    }
    return null;
  }

  isOpenable(module: ModuleDisplay): boolean {
    return Boolean(module.path) && module.status !== 'coming_soon' && !module.isLocked;
  }

  isUpgradeable(module: ModuleDisplay): boolean {
    return Boolean(module.path) && module.status !== 'coming_soon' && module.isLocked && !this.isManagedChannel();
  }

  onCategoryChange(category: Category): void {
    this.selectedCategory.set(category);
  }

  onSearchChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchQuery.set(value);
  }

  clearSearch(): void {
    this.searchQuery.set('');
  }

  openModule(module: ModuleDisplay): void {
    if (!this.isOpenable(module) || !module.path) {
      return;
    }
    void this.router.navigateByUrl(module.path);
  }

  onModuleCardClick(module: ModuleDisplay): void {
    if (this.isOpenable(module)) {
      this.openModule(module);
      return;
    }

    if (this.isUpgradeable(module)) {
      this.onUpgradeClick(module);
    }
  }

  isActionable(module: ModuleDisplay): boolean {
    return this.isOpenable(module) || this.isUpgradeable(module);
  }

  onUpgradeClick(module: ModuleDisplay): void {
    if (this.isManagedChannel()) return;
    void this.upgradeService.promptUpgradeForModule({
      moduleId: module.id,
      source: 'modules_page_card'
    });
  }

  resetFilters(): void {
    this.searchQuery.set('');
    this.selectedCategory.set('all');
  }

  private buildModule(
    id: ModuleId,
    name: string,
    descriptionKey: string,
    streamerName: string,
    userPlanTier: PlanTier
  ): ModuleDisplay {
    const req = MODULE_TIER_REQUIREMENTS[id];
    return {
      id,
      name,
      description: this.t(descriptionKey),
      path: streamerName ? `/${streamerName}/modules/${id}` : null,
      category: req.category,
      status: req.defaultStatus,
      minTier: req.minTier,
      isLocked: !isModuleAccessible(req, userPlanTier),
      icon: MODULE_ICONS[id],
      priority: req.priority,
      featured: CORE_MODULE_IDS.includes(id)
    };
  }
}
