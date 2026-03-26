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
  Search,
  SearchX,
  Sparkles,
  Video,
  X,
  Zap,
  type LucideIconData
} from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { ParticleFieldComponent } from '../../components/particle-field/particle-field.component';
import { ModuleCardComponent, Module } from '../../components/module-card/module-card.component';
import { LoadingIndicatorComponent } from '../../components/loading';
import { getRouteParam } from '../../shared/utils/route-param.util';

type Category = 'all' | 'engagement' | 'automation' | 'content';
type PlanTier = 'free' | 'premium' | 'pro';

interface ModuleCategoryOption {
  id: Category;
  icon: LucideIconData;
  labelKey: string;
}

@Component({
  selector: 'app-modules-page',
  imports: [
    LucideAngularModule,
    ParticleFieldComponent,
    ModuleCardComponent,
    LoadingIndicatorComponent
  ],
  templateUrl: './modules-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ModulesPageComponent {
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toastService = inject(ToastService);
  private readonly route = inject(ActivatedRoute);

  readonly sparklesIcon = Sparkles;
  readonly searchIcon = Search;
  readonly clearIcon = X;
  readonly featuredIcon = Zap;
  readonly gridIcon = LayoutGrid;
  readonly emptyIcon = SearchX;

  readonly userPlanTier = computed<PlanTier>(() => this.sessionAuth.session()?.appUser.plan_tier ?? 'free');
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
    { id: 'content', icon: Video, labelKey: 'modules.categories.content' }
  ];

  readonly modules = computed<Module[]>(() => {
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
        status: 'stable',
        isPremium: false,
        isPro: false,
        isLocked: false
      },
      {
        id: 'chat-events',
        name: 'Chat Events',
        description: this.t('modules.chatEvents.description'),
        icon: MessageSquare,
        path: streamerName ? `/${streamerName}/modules/chat-events` : null,
        category: 'engagement',
        status: 'stable',
        isPremium: false,
        isPro: false,
        isLocked: false
      },
      {
        id: 'triggers',
        name: 'Triggers',
        description: this.t('modules.triggers.description'),
        icon: Zap,
        path: streamerName ? `/${streamerName}/modules/triggers` : null,
        category: 'automation',
        status: 'beta',
        isPremium: false,
        isPro: false,
        isLocked: false
      },
      {
        id: 'referrals',
        name: 'Referrals',
        description: this.t('modules.referrals.description'),
        icon: CreditCard,
        path: streamerName ? `/${streamerName}/modules/referrals` : null,
        category: 'engagement',
        status: 'stable',
        isPremium: false,
        isPro: false,
        isLocked: false
      },
      {
        id: 'redemptions',
        name: 'Redemptions',
        description: this.t('modules.redemptions.description'),
        icon: Gift,
        path: streamerName ? `/${streamerName}/modules/redemptions` : null,
        category: 'engagement',
        status: 'beta',
        isPremium: false,
        isPro: false,
        isLocked: false
      },
      {
        id: 'ai-personality',
        name: 'AI Personality',
        description: this.t('modules.aiPersonality.description'),
        icon: Brain,
        path: null,
        category: 'automation',
        status: 'coming_soon',
        isPremium: true,
        isPro: false,
        isLocked: false
      },
      {
        id: 'analytics',
        name: 'Analytics',
        description: this.t('modules.analytics.description'),
        icon: BarChart3,
        path: streamerName ? `/${streamerName}/modules/analytics` : null,
        category: 'engagement',
        status: 'beta',
        isPremium: true,
        isPro: false,
        isLocked: userPlanTier === 'free'
      }
    ];
  });

  readonly filteredModules = computed(() => {
    let filtered = this.modules();

    // Filter by category
    if (this.selectedCategory() !== 'all') {
      filtered = filtered.filter(module => module.category === this.selectedCategory());
    }

    // Filter by search query
    const query = this.searchQuery().toLowerCase().trim();
    if (query) {
      filtered = filtered.filter(module => 
        module.name.toLowerCase().includes(query) ||
        module.description.toLowerCase().includes(query)
      );
    }

    return filtered;
  });

  readonly featuredModule = computed(() => {
    const actionableModules = this.filteredModules().filter(
      (module) => module.status === 'stable' && !module.isLocked && Boolean(module.path)
    );

    if (actionableModules.length <= 1) {
      return null;
    }

    return actionableModules[0] ?? null;
  });

  readonly displayedModules = computed(() => {
    const featured = this.featuredModule();
    if (!featured || this.searchQuery() || this.selectedCategory() !== 'all') {
      return this.filteredModules();
    }

    return this.filteredModules().filter((module) => module.id !== featured.id);
  });

  t(key: string): string {
    return this.languageService.translate(key);
  }

  getAccessText(module: Module): string {
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

  onCategoryChange(category: Category): void {
    this.selectedCategory.set(category);
  }

  onSearchChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchQuery.set(value);
  }

  onUpgradeClick(module: Module): void {
    this.toastService.warning(this.t('common.premiumFeature'), this.t('common.premiumSubscriptionRequired'));
  }

  resetFilters(): void {
    this.searchQuery.set('');
    this.selectedCategory.set('all');
  }
}
