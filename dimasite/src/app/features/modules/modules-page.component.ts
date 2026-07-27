import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

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
}

@Component({
  selector: 'app-modules-page',
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
    const tier = this.sessionAuth.session()?.appUser.plan_tier ?? 'free';
    if (tier === 'premium' || tier === 'pro') {
      return tier;
    }
    return 'free';
  });

  readonly streamer = computed(() => {
    const routeStreamer = getRouteParam(this.route, 'streamer');
    const sessionStreamer =
      this.sessionAuth.session()?.twitchUser.login || this.sessionAuth.session()?.appUser?.name;
    return (routeStreamer || sessionStreamer || '').trim().toLowerCase();
  });

  readonly searchQuery = signal('');
  readonly selectedCategory = signal<Category>('all');

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
    ];
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

  moduleInitial(name: string): string {
    const trimmed = name.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
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

  categoryLabel(category: Exclude<Category, 'all'>): string {
    return this.t(`modules.categories.${category}`);
  }

  accessText(module: ModuleDisplay): string {
    if (!module.path) {
      if (module.status === 'coming_soon') {
        return this.t('modules.comingSoon');
      }
      return this.t('modules.unavailable');
    }

    if (module.isLocked) {
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
    return Boolean(module.path) && module.status !== 'coming_soon' && module.isLocked;
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

  onUpgradeClick(module: ModuleDisplay): void {
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
      isLocked: !isModuleAccessible(req, userPlanTier)
    };
  }
}
