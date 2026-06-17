import { 
  Component, 
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { SafeUrlPipe } from '../../pipes/safe-url.pipe';
import { 
  LucideAngularModule, 
  Video, 
  Copy, 
  Zap, 
  Check, 
  Clock,
  ArrowLeft,
  Sparkles,
  Play,
  Settings2,
  ExternalLink,
  AlertCircle
} from 'lucide-angular';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { UpgradeService } from '../../services/upgrade.service';
import { LinksService } from '../../services/links.service';
import { ClipsService } from './clips.service';
import { ClipDesign, ClipConfig, UserClipSettings } from './clips.model';
import { ClipTestModalComponent } from './components/clip-test-modal.component';
import { getRouteParam } from '../../shared/utils/route-param.util';

@Component({
  selector: 'app-clips-page',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    LucideAngularModule,
    SafeUrlPipe,
    ClipTestModalComponent
  ],
  styleUrl: './clips-page.component.css',
  template: `
    <div class="clips-shell">
      <!-- Hero Section -->
      <section class="clips-hero">
        <div class="clips-hero__content">
          <a [routerLink]="['/', streamer(), 'modules']" class="clips-hero__back-link">
            <lucide-icon [name]="arrowLeftIcon" class="clips-hero__back-icon"></lucide-icon>
            <span>{{ t('clips.backToModules') }}</span>
          </a>
          
          <div class="clips-hero__badge">
            <lucide-icon [name]="sparklesIcon" class="clips-hero__badge-icon"></lucide-icon>
            <span>{{ t('clips.headerBadge') }}</span>
          </div>
          
          <div class="clips-hero__copy">
            <div>
              <h1 class="clips-hero__title">
                <span class="gradient-text">{{ t('clips.title') }}</span>
              </h1>
              <p class="clips-hero__subtitle">{{ t('clips.description') }}</p>
            </div>
          </div>
        </div>
      </section>

      <!-- Design Selection -->
      <section class="designs-section">
        <h2 class="section-title">
          <lucide-icon [name]="videoIcon" class="section-icon"></lucide-icon>
          {{ t('clips.chooseDesign') }}
        </h2>

        @if (isMobile()) {
          <!-- Mobile: Showcase + Selector Row -->
          <div class="mobile-selector-section">
            @if (heroDesign()) {
              <div class="mobile-showcase" [style.--hero-accent]="heroDesign()!.accentColor">
                <div class="mobile-showcase__backdrop"></div>
                <div class="mobile-showcase__content">
                  <div class="mobile-showcase__label">Design {{ heroDesign()!.designNumber }}</div>
                  <h3 class="mobile-showcase__title">{{ heroDesign()!.name }}</h3>
                  <p class="mobile-showcase__description">{{ heroDesign()!.description }}</p>
                </div>
              </div>
            }

            <div class="mobile-selector-row">
              @for (design of designs(); track design.id) {
                <button
                  type="button"
                  class="mobile-selector-button"
                  [class.active]="selectedDesign()?.id === design.id"
                  [class.locked]="isDesignLocked(design)"
                  [style.--selector-accent]="design.accentColor"
                  (click)="selectDesign(design)"
                >
                  <span class="mobile-selector-button__eyebrow">Design {{ design.designNumber }}</span>
                  <span class="mobile-selector-button__label">{{ design.name }}</span>
                </button>
              }
            </div>
          </div>
        } @else {
          <!-- Desktop: Design Cards Grid -->
          <div class="designs-grid">
            @for (design of designs(); track design.id; let i = $index) {
              <div 
                class="design-card"
                [class.selected]="selectedDesign()?.id === design.id"
                [class.locked]="isDesignLocked(design)"
                [style.--accent-color]="design.accentColor"
                (click)="selectDesign(design)"
              >
                <div class="card-glow"></div>
                
                <div class="card-content">
                  <div class="badge-group">
                    <div class="status-badge" [class]="'status-' + design.status">
                      <span class="status-dot"></span>
                      <span class="status-text">{{ design.status }}</span>
                    </div>

                    @if (design.premium || design.premiumPlus) {
                      <div class="tier-badge tier-premium">
                        <span class="tier-dot"></span>
                        <span>Premium</span>
                      </div>
                    }
                  </div>

                  <div class="design-number" [style.--accent-color]="design.accentColor">
                    {{ design.designNumber }}
                  </div>

                  <div class="design-info">
                    <h3 class="design-name">{{ design.name }}</h3>
                    <p class="design-description">{{ design.description }}</p>

                    <div class="design-features">
                      @for (feature of design.features.slice(0, 2); track feature) {
                        <span class="feature-tag">{{ feature }}</span>
                      }
                    </div>
                  </div>

                  @if (selectedDesign()?.id === design.id) {
                    <div class="selection-indicator">
                      <lucide-icon [name]="checkIcon" class="check-icon"></lucide-icon>
                    </div>
                  }
                </div>
              </div>
            }
          </div>
        }
      </section>

      <!-- Configuration Panel -->
      @if (selectedDesign()) {
        <section class="config-section">
          <h2 class="section-title">
            <lucide-icon [name]="settingsIcon" class="section-icon"></lucide-icon>
            {{ t('clips.configuration') }}
          </h2>

          <div class="config-panel">
            <div class="config-row">
              <div class="config-field">
                <label class="config-label">
                  <lucide-icon [name]="clockIcon"></lucide-icon>
                  {{ t('clips.timeoutLabel') }}
                </label>
                
                <div class="timeout-control">
                  <input 
                    type="range" 
                    class="timeout-slider"
                    min="1" 
                    max="30" 
                    [value]="config().timeoutSeconds"
                    (input)="updateTimeout($event)"
                  >
                  <div class="timeout-display">
                    <span class="timeout-value">{{ config().timeoutSeconds }}</span>
                    <span class="timeout-unit">{{ t('clips.seconds') }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      }

      <!-- Preview Section -->
      @if (selectedDesign()) {
        <section class="preview-section">
          <h2 class="section-title">
            <lucide-icon [name]="playIcon" class="section-icon"></lucide-icon>
            {{ t('clips.preview') }}
          </h2>

          <div class="preview-container">
            <div class="preview-frame-wrapper">
              <iframe 
                [src]="previewUrl() | safeUrl"
                class="preview-frame"
                allow="autoplay"
                frameborder="0"
              ></iframe>

              <div class="preview-overlay">
                <span class="preview-label">{{ t('clips.livePreview') }}</span>
              </div>
            </div>

            <div class="preview-actions">
              <button 
                class="action-btn primary copy-btn"
                (click)="copyUrl()"
                [class.copied]="urlCopied()"
              >
                @if (urlCopied()) {
                  <lucide-icon [name]="checkIcon"></lucide-icon>
                  <span>{{ t('clips.copied') }}</span>
                } @else {
                  <lucide-icon [name]="copyIcon"></lucide-icon>
                  <span>{{ t('clips.copyUrl') }}</span>
                }
              </button>

              <button 
                class="action-btn secondary test-btn"
                (click)="openTestModal()"
                [disabled]="!canTest()"
              >
                <lucide-icon [name]="zapIcon"></lucide-icon>
                <span>{{ t('clips.testDesign') }}</span>
              </button>

              <a 
                [href]="previewUrl()"
                target="_blank"
                class="action-btn secondary"
              >
                <lucide-icon [name]="externalLinkIcon"></lucide-icon>
                <span>{{ t('clips.openInNewTab') }}</span>
              </a>
            </div>

            @if (!canTest()) {
              <div class="test-warning">
                <lucide-icon [name]="alertIcon"></lucide-icon>
                <span>{{ t('clips.testWarning') }}</span>
              </div>
            }
          </div>
        </section>
      }

      <!-- Empty State -->
      @if (!selectedDesign()) {
        <div class="empty-state">
          <div class="empty-illustration">
            <lucide-icon [name]="videoIcon"></lucide-icon>
          </div>
          <h3>{{ t('clips.selectDesignTitle') }}</h3>            
          <p>{{ t('clips.selectDesignDescription') }}</p>
        </div>
      }

      <!-- Test Modal -->
      @if (showTestModal()) {
        <app-clip-test-modal
          [channelID]="userSettings().channelID"
          [streamer]="userSettings().login"
          [design]="selectedDesign()!"
          [timeout]="config().timeoutSeconds"
          (closed)="showTestModal.set(false)"
        ></app-clip-test-modal>
      }
    </div>
  `,

  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ClipsPageComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly languageService = inject(LanguageService);
  private readonly route = inject(ActivatedRoute);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly toastService = inject(ToastService);
  private readonly upgradeService = inject(UpgradeService);
  private readonly linksService = inject(LinksService);
  private readonly clipsService = inject(ClipsService);

  // Icons
  readonly videoIcon = Video;
  readonly copyIcon = Copy;
  readonly zapIcon = Zap;
  readonly checkIcon = Check;
  readonly clockIcon = Clock;
  readonly arrowLeftIcon = ArrowLeft;
  readonly sparklesIcon = Sparkles;
  readonly playIcon = Play;
  readonly settingsIcon = Settings2;
  readonly externalLinkIcon = ExternalLink;
  readonly alertIcon = AlertCircle;

  // State signals
  readonly config = signal<ClipConfig>({
    timeoutSeconds: 30,
    selectedDesignId: null
  });

  readonly selectedDesign = signal<ClipDesign | null>(null);
  readonly urlCopied = signal(false);
  readonly showTestModal = signal(false);
  readonly isMobile = signal(typeof window !== 'undefined' ? window.innerWidth <= 768 : false);

  // Computed values
  readonly userSettings = computed<UserClipSettings>(() => {
    const session = this.sessionAuth.session();
    return {
      channelID: session?.appUser?.twitch_user_id || '',
      login: session?.appUser?.name || '',
      planTier: session?.appUser?.plan_tier || 'free'
    };
  });

  readonly streamer = computed(() => {
    const routeStreamer = getRouteParam(this.route, 'streamer');
    return routeStreamer || this.userSettings().login;
  });
  
  readonly designs = computed(() => this.clipsService.getDesigns(this.userSettings()));
  
  readonly heroDesign = computed(() => this.selectedDesign() ?? this.designs()[0] ?? null);

  readonly previewUrl = computed(() => {
    const design = this.selectedDesign();
    if (!design) return '';
    
    return this.clipsService.getClipUrl(
      this.userSettings().channelID,
      design.id,
      this.config().timeoutSeconds
    );
  });

  readonly canTest = computed(() => {
    const design = this.selectedDesign();
    // Can't test premium designs - under construction
    if (!design || design.premium || design.premiumPlus) return false;
    return true;
  });

  ngOnInit(): void {
    window.addEventListener('resize', this.onViewportResize);
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onViewportResize);
  }

  private onViewportResize = (): void => {
    this.isMobile.set(window.innerWidth <= 768);
  };

  t(key: string): string {
    return this.languageService.translate(key);
  }

  isDesignLocked(design: ClipDesign): boolean {
    // All premium designs are under construction - lock them all
    if (design.premium || design.premiumPlus) return true;
    return false;
  }

  selectDesign(design: ClipDesign): void {
    if (this.isDesignLocked(design)) {
      const userPlan = this.userSettings().planTier;
      if (userPlan === 'premium' || userPlan === 'pro') {
        // User has premium but design is under construction
        this.toastService.info(
          this.t('clips.underConstructionTitle'),
          this.t('clips.underConstructionMessage')
        );
      } else {
        void this.upgradeService.promptUpgradeForModule({
          moduleId: 'clips',
          source: 'clips_design'
        });
      }
      return;
    }

    this.selectedDesign.set(design);
    this.config.update(cfg => ({
      ...cfg,
      selectedDesignId: design.id
    }));
  }

  updateTimeout(event: Event): void {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    this.config.update(cfg => ({
      ...cfg,
      timeoutSeconds: Math.max(1, Math.min(30, value))
    }));
  }

  async copyUrl(): Promise<void> {
    const url = this.previewUrl();
    if (!url) return;

    try {
      await navigator.clipboard.writeText(url);
      this.urlCopied.set(true);
      
      this.toastService.success(
        this.t('clips.copiedTitle'),
        this.t('clips.copiedMessage')
      );

      setTimeout(() => {
        this.urlCopied.set(false);
      }, 2000);
    } catch (error) {
      this.toastService.error(
        this.t('clips.copyFailed'),
        this.t('clips.copyFailedMessage')
      );
    }
  }

  openTestModal(): void {
    this.showTestModal.set(false);
    queueMicrotask(() => {
      this.showTestModal.set(true);
    });
  }
}
