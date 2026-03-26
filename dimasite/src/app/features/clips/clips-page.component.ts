import { 
  Component, 
  ChangeDetectionStrategy, 
  inject, 
  signal,
  computed,
  viewChild,
  ElementRef,
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
  Crown, 
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
import * as THREE from 'three';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ToastService } from '../../services/toast.service';
import { LinksService } from '../../services/links.service';
import { ClipsService } from './clips.service';
import { ClipDesign, ClipConfig, UserClipSettings } from './clips.model';
import { DesignShowcase3DComponent } from './components/design-showcase-3d.component';
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
    DesignShowcase3DComponent,
    ClipTestModalComponent
  ],
  template: `
    <div class="clips-page">
      <!-- 3D Particle Background -->
      <div class="particle-background" #particleBg></div>

      <div class="clips-container">
        <!-- Header -->
        <header class="clips-header">
          <a [routerLink]="['/', streamer(), 'modules']" class="back-link">
            <lucide-icon [name]="arrowLeftIcon" class="back-icon"></lucide-icon>
            <span>{{ t('clips.backToModules') }}</span>
          </a>
          
          <div class="header-content">
            <div class="header-badge">
              <lucide-icon [name]="sparklesIcon" class="badge-icon"></lucide-icon>
              <span>{{ t('clips.headerBadge') }}</span>
            </div>
            
            <h1 class="header-title">
              <span class="gradient-text">{{ t('clips.title') }}</span>
            </h1>            
            <p class="header-description">{{ t('clips.description') }}</p>
          </div>
        </header>

        @if (isMobile()) {
          <section class="mobile-selector-section">
            <h2 class="section-title">
              <lucide-icon [name]="videoIcon" class="section-icon"></lucide-icon>
              {{ t('clips.chooseDesign') }}
            </h2>

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
          </section>
        } @else {
          <!-- 3D Design Showcase -->
          <section class="showcase-section">
            <h2 class="section-title">
              <lucide-icon [name]="videoIcon" class="section-icon"></lucide-icon>
              {{ t('clips.chooseDesign') }}
            </h2>

            <app-design-showcase-3d
              [designs]="designs()"
              [selectedDesignId]="selectedDesign()?.id ?? null"
              (designSelect)="selectDesign($event)"
            ></app-design-showcase-3d>
          </section>
        }

        <!-- Design Selection Grid -->
        @if (!isMobile()) {
          <section class="designs-section">
            <div class="designs-grid">
              @for (design of designs(); track design.id; let i = $index) {
                <div 
                  class="design-card"
                  [class.selected]="selectedDesign()?.id === design.id"
                  [class.locked]="isDesignLocked(design)"
                  [class.premium]="design.premium"
                  [style.--card-index]="i"
                  (click)="selectDesign(design)"
                  @cardEnter
                >
                  <div class="card-glow"></div>
                  
                  <div class="card-content">
                    <div class="status-badge" [class]="'status-' + design.status">
                      <span class="status-dot"></span>
                      <span class="status-text">{{ design.status }}</span>
                    </div>

                    @if (design.premium || design.premiumPlus) {
                      <div class="premium-badge">
                        <lucide-icon [name]="crownIcon"></lucide-icon>
                        @if (design.premiumPlus) {
                          <span class="plus-indicator">+</span>
                        }
                      </div>
                    }

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

                    <div class="selection-indicator">
                      @if (selectedDesign()?.id === design.id) {
                        <lucide-icon [name]="checkIcon" class="check-icon"></lucide-icon>
                      } @else if (isDesignLocked(design)) {
                        <lucide-icon [name]="crownIcon" class="lock-icon"></lucide-icon>
                      }
                    </div>
                  </div>
                </div>
              }
            </div>
          </section>
        }

        <!-- Configuration Panel -->
        @if (selectedDesign()) {
          <section class="config-section" @slideIn
>
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
          <section class="preview-section" @slideIn
>
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
      </div>

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
  private readonly linksService = inject(LinksService);
  private readonly clipsService = inject(ClipsService);
  private readonly particleBg = viewChild<ElementRef>('particleBg');

  // Icons
  readonly videoIcon = Video;
  readonly crownIcon = Crown;
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

  // 3D scene
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private particles!: THREE.Points;
  private animationId!: number;

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
    // Check if OBS is connected (this would need real implementation)
    return true; // Placeholder - should check WebSocket connection status
  });

  ngOnInit(): void {
    window.addEventListener('resize', this.onViewportResize);
    this.initParticleBackground();
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onViewportResize);
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
  }

  private initParticleBackground(): void {
    const container = this.particleBg()?.nativeElement;
    if (!container) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    this.camera.position.z = 50;

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.appendChild(this.renderer.domElement);

    // Create floating particles
    const particleCount = 50;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    const color1 = new THREE.Color(0x7c3aed);
    const color2 = new THREE.Color(0x3b82f6);

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 100;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 100;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 50;

      const mixRatio = Math.random();
      const mixedColor = color1.clone().lerp(color2, mixRatio);
      colors[i * 3] = mixedColor.r;
      colors[i * 3 + 1] = mixedColor.g;
      colors[i * 3 + 2] = mixedColor.b;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 2,
      vertexColors: true,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);

    this.animate();
  }

  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);

    if (this.particles) {
      this.particles.rotation.y += 0.0002;
      this.particles.rotation.x += 0.0001;
    }

    this.renderer.render(this.scene, this.camera);
  };

  private onViewportResize = (): void => {
    this.isMobile.set(window.innerWidth <= 768);
  };

  t(key: string): string {
    return this.languageService.translate(key);
  }

  isDesignLocked(design: ClipDesign): boolean {
    const userPlan = this.userSettings().planTier;
    if (!design.premium && !design.premiumPlus) return false;
    if (design.premiumPlus && userPlan !== 'pro') return true;
    if (design.premium && userPlan === 'free') return true;
    return false;
  }

  selectDesign(design: ClipDesign): void {
    if (this.isDesignLocked(design)) {
      this.toastService.error(
        this.t('clips.premiumRequired'),
        this.t('clips.upgradeToAccess')
      );
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
