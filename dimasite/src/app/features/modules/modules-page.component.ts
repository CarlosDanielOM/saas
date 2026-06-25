import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import {
  BarChart3,
  Brain,
  CreditCard,
  Gift,
  Heart,
  LayoutGrid,
  LucideAngularModule,
  MessageSquare,
  Mic2,
  Clapperboard,
  Search,
  SearchX,
  Shield,
  Sparkles,
  Video,
  HardDrive,
  X,
  Zap,
  type LucideIconData,
} from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { UpgradeService } from '../../services/upgrade.service';
import { ParticleFieldComponent } from '../../components/particle-field/particle-field.component';
import { ModuleCardComponent, Module } from '../../components/module-card/module-card.component';
import { LoadingIndicatorComponent } from '../../components/loading';
import { getRouteParam } from '../../shared/utils/route-param.util';
import {
  type ModuleId,
  type PlanTier,
  type ModuleStatus,
  MODULE_TIER_REQUIREMENTS,
  isModuleAccessible,
} from './module-tier.model';

type Category = 'all' | 'engagement' | 'automation' | 'content';

interface ModuleCategoryOption {
  id: Category;
  icon: LucideIconData;
  labelKey: string;
}

interface ModuleDisplay {
  id: ModuleId;
  name: string;
  description: string;
  icon: LucideIconData;
  path: string | null;
  category: Category;
  status: ModuleStatus;
  minTier: PlanTier;
  isLocked: boolean;
}

@Component({
  selector: 'app-modules-page',
  imports: [
    LucideAngularModule,
    ParticleFieldComponent,
    ModuleCardComponent,
    LoadingIndicatorComponent,
  ],
  templateUrl: './modules-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModulesPageComponent {
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly upgradeService = inject(UpgradeService);
  private readonly route = inject(ActivatedRoute);

  readonly sparklesIcon = Sparkles;
  readonly searchIcon = Search;
  readonly clearIcon = X;
  readonly gridIcon = LayoutGrid;
  readonly emptyIcon = SearchX;

  readonly userPlanTier = computed<PlanTier>(
    () => this.sessionAuth.session()?.appUser.plan_tier ?? 'free',
  );
  readonly streamer = computed(() => {
    const routeStreamer = getRouteParam(this.route, 'streamer');
    const sessionStreamer = this.sessionAuth.session()?.appUser?.name;
    return routeStreamer || sessionStreamer || '';
  });

  readonly searchQuery = signal('');
  readonly selectedCategory = signal<Category>('all');
  readonly isLoading = signal(false);

  readonly categories: ModuleCategoryOption[] = [
    { id: 'all', icon: LayoutGrid, labelKey: 'modules.categories.all' },
    { id: 'engagement', icon: Heart, labelKey: 'modules.categories.engagement' },
    { id: 'automation', icon: Zap, labelKey: 'modules.categories.automation' },
    { id: 'content', icon: Video, labelKey: 'modules.categories.content' },
  ];

  readonly modules = computed<ModuleDisplay[]>(() => {
    this.languageService.currentLanguage();
    const userPlanTier = this.userPlanTier();
    const streamerName = this.streamer();

    return [
      {
        id: 'clips',
        name: 'Clips',
        description: this.t('modules.clips.description'),
        icon: Video,
        path: streamerName ? `/${streamerName}/modules/clips` : null,
        category: 'content',
        status: MODULE_TIER_REQUIREMENTS['clips'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['clips'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['clips'], userPlanTier),
      },
      {
        id: 'chat-events',
        name: 'Chat Events',
        description: this.t('modules.chatEvents.description'),
        icon: MessageSquare,
        path: streamerName ? `/${streamerName}/modules/chat-events` : null,
        category: 'engagement',
        status: MODULE_TIER_REQUIREMENTS['chat-events'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['chat-events'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['chat-events'], userPlanTier),
      },
      {
        id: 'triggers',
        name: 'Triggers',
        description: this.t('modules.triggers.description'),
        icon: Zap,
        path: streamerName ? `/${streamerName}/modules/triggers` : null,
        category: 'automation',
        status: MODULE_TIER_REQUIREMENTS['triggers'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['triggers'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['triggers'], userPlanTier),
      },
      {
        id: 'dimafx',
        name: 'DimaFX',
        description: this.t('modules.dimafx.description'),
        icon: Sparkles,
        path: streamerName ? `/${streamerName}/modules/dimafx` : null,
        category: 'engagement',
        status: MODULE_TIER_REQUIREMENTS['dimafx'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['dimafx'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['dimafx'], userPlanTier),
      },
      {
        id: 'tts',
        name: 'Text to Speech',
        description: this.t('modules.tts.description'),
        icon: Mic2,
        path: streamerName ? `/${streamerName}/modules/tts` : null,
        category: 'automation',
        status: MODULE_TIER_REQUIREMENTS['tts'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['tts'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['tts'], userPlanTier),
      },
      {
        id: 'referrals',
        name: 'Referrals',
        description: this.t('modules.referrals.description'),
        icon: CreditCard,
        path: streamerName ? `/${streamerName}/modules/referrals` : null,
        category: 'engagement',
        status: MODULE_TIER_REQUIREMENTS['referrals'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['referrals'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['referrals'], userPlanTier),
      },
      {
        id: 'redemptions',
        name: 'Redemptions',
        description: this.t('modules.redemptions.description'),
        icon: Gift,
        path: streamerName ? `/${streamerName}/modules/redemptions` : null,
        category: 'engagement',
        status: MODULE_TIER_REQUIREMENTS['redemptions'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['redemptions'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['redemptions'], userPlanTier),
      },
      {
        id: 'ai-personality',
        name: 'AI Personality',
        description: this.t('modules.aiPersonality.description'),
        icon: Brain,
        path: streamerName ? `/${streamerName}/modules/ai-personality` : null,
        category: 'automation',
        status: MODULE_TIER_REQUIREMENTS['ai-personality'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['ai-personality'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['ai-personality'], userPlanTier),
      },
      {
        id: 'memories',
        name: 'Memories',
        description: this.t('modules.memories.description'),
        icon: Brain,
        path: streamerName ? `/${streamerName}/modules/memories` : null,
        category: 'automation',
        status: MODULE_TIER_REQUIREMENTS['memories'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['memories'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['memories'], userPlanTier),
      },
      {
        id: 'analytics',
        name: 'Analytics',
        description: this.t('modules.analytics.description'),
        icon: BarChart3,
        path: streamerName ? `/${streamerName}/modules/analytics` : null,
        category: 'engagement',
        status: MODULE_TIER_REQUIREMENTS['analytics'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['analytics'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['analytics'], userPlanTier),
      },
      {
        id: 'follow-defense',
        name: 'Follow Defense',
        description: this.t('modules.followDefense.description'),
        icon: Shield,
        path: streamerName ? `/${streamerName}/modules/follow-defense` : null,
        category: 'automation',
        status: MODULE_TIER_REQUIREMENTS['follow-defense'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['follow-defense'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['follow-defense'], userPlanTier),
      },
      {
        id: 'stream-summaries',
        name: 'Stream Summaries',
        description: this.t('modules.streamSummaries.description'),
        icon: Video,
        path: streamerName ? `/${streamerName}/modules/stream-summaries` : null,
        category: 'content',
        status: MODULE_TIER_REQUIREMENTS['stream-summaries'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['stream-summaries'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['stream-summaries'], userPlanTier),
      },
      {
        id: 'clip-recommendations',
        name: 'Clip Recommendations',
        description: this.t('modules.clipRecommendations.description'),
        icon: Clapperboard,
        path: streamerName ? `/${streamerName}/modules/clip-recommendations` : null,
        category: 'content',
        status: MODULE_TIER_REQUIREMENTS['clip-recommendations'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['clip-recommendations'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['clip-recommendations'], userPlanTier),
      },
      {
        id: 'library',
        name: 'Media Library',
        description: this.t('modules.library.description'),
        icon: HardDrive,
        path: streamerName ? `/${streamerName}/modules/library` : null,
        category: 'content',
        status: MODULE_TIER_REQUIREMENTS['library'].defaultStatus,
        minTier: MODULE_TIER_REQUIREMENTS['library'].minTier,
        isLocked: !isModuleAccessible(MODULE_TIER_REQUIREMENTS['library'], userPlanTier),
      },
    ];
  });

  readonly filteredModules = computed(() => {
    let filtered = this.modules();

    // Filter by category
    if (this.selectedCategory() !== 'all') {
      filtered = filtered.filter((module) => module.category === this.selectedCategory());
    }

    // Filter by search query
    const query = this.searchQuery().toLowerCase().trim();
    if (query) {
      filtered = filtered.filter(
        (module) =>
          module.name.toLowerCase().includes(query) ||
          module.description.toLowerCase().includes(query),
      );
    }

    return filtered;
  });

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  toModule(display: ModuleDisplay): Module {
    return {
      id: display.id,
      name: display.name,
      description: display.description,
      icon: display.icon,
      path: display.path,
      category: display.category as 'engagement' | 'automation' | 'content',
      status: display.status as 'stable' | 'beta' | 'alpha' | 'coming_soon',
      isPremium: display.minTier === 'premium',
      isPro: display.minTier === 'pro',
      isLocked: display.isLocked,
    };
  }

  getAccessText(display: ModuleDisplay): string {
    if (!display.path) {
      if (display.status === 'coming_soon') {
        return this.t('modules.comingSoon');
      }

      return this.t('modules.unavailable');
    }

    if (display.isLocked) {
      return this.t('modules.upgradeToAccess');
    }

    if (display.status === 'coming_soon') {
      return this.t('modules.comingSoon');
    }

    return this.t('modules.openModule');
  }

  getLockedSubtext(display: ModuleDisplay): string | null {
    if (display.isLocked && display.status === 'coming_soon') {
      const tierName =
        display.minTier === 'pro' ? this.t('navbar.planPro') : this.t('navbar.planPremium');
      return this.t('modules.comingSoonLocked', { tier: tierName });
    }
    return null;
  }

  onCategoryChange(category: Category): void {
    this.selectedCategory.set(category);
  }

  onSearchChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchQuery.set(value);
  }

  onUpgradeClick(module: Module): void {
    void this.upgradeService.promptUpgradeForModule({
      moduleId: module.id as ModuleId,
      source: 'modules_page_card',
    });
  }

  resetFilters(): void {
    this.searchQuery.set('');
    this.selectedCategory.set('all');
  }
}
