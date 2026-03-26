import { 
  ChangeDetectionStrategy, 
  Component, 
  OnInit, 
  OnDestroy, 
  computed, 
  inject, 
  signal, 
  viewChild,
  ElementRef
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule, MessageSquare, ArrowLeft, Sparkles } from 'lucide-angular';
import * as THREE from 'three';
import { firstValueFrom, map } from 'rxjs';

import { LoadingIndicatorComponent } from '../../components/loading';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';
import { ChatEventsService } from './chat-events.service';
import { ToastService } from '../../services/toast.service';
import { EventCardComponent } from './components/event-card.component';
import { ChatEvent, ChatEventPendingAction, ConfigControl, PlanTier, UserAccess } from './chat-events.model';
import { getRouteParam } from '../../shared/utils/route-param.util';
import { getConfigPersistenceKey, serializeConfigControlValue } from './chat-events.contract';

@Component({
  selector: 'app-chat-events-page',
  imports: [
    LucideAngularModule,
    EventCardComponent,
    LoadingIndicatorComponent
  ],
  template: `
    <div class="chat-events">
      <!-- Three.js Hero Canvas -->
      <div class="chat-events__hero">
        <canvas #heroCanvas class="chat-events__hero-canvas"></canvas>
        <div class="chat-events__hero-content">
          <button
            type="button"
            class="chat-events__back-btn"
            (click)="goBack()">
            <lucide-icon [name]="arrowLeftIcon" class="chat-events__back-icon"></lucide-icon>
            {{ t('chatEvents.backToModules') }}
          </button>

          <div class="chat-events__hero-badge">
            <lucide-icon [name]="sparklesIcon" class="chat-events__hero-badge-icon"></lucide-icon>
            {{ t('chatEvents.heroBadge') }}
          </div>

          <h1 class="chat-events__title">{{ t('chatEvents.title') }}</h1>
          <p class="chat-events__subtitle">{{ t('chatEvents.subtitle') }}</p>
        </div>
      </div>

      <!-- Events Grid -->
      <div class="chat-events__content">
        @if (isLoading()) {
          <div class="chat-events__loading">
            <loading-indicator
              [loading]="true"
              [message]="t('chatEvents.loading')"
              size="lg" />
          </div>
        } @else {
          <div 
            class="chat-events__grid">
            @for (event of events(); track event.type) {
              <app-event-card
                [event]="event"
                [userPlan]="userPlan()"
                [userAccess]="getUserAccess(event)"
                [pendingAction]="getPendingAction(event.type)"
                (configure)="toggleConfigure(event)"
                (toggle)="toggleFeature(event)"
                (save)="saveConfiguration(event)"
                (delete)="deleteEvent(event)"
                (upgrade)="onUpgrade()" />
            }
          </div>
        }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChatEventsPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly chatEventsService = inject(ChatEventsService);
  private readonly toastService = inject(ToastService);

  private readonly heroCanvas = viewChild<ElementRef<HTMLCanvasElement>>('heroCanvas');
  private cleanupResize: (() => void) | null = null;
  private threeScene: {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    particles: THREE.Points;
    animationId: number;
  } | null = null;

  readonly messageSquareIcon = MessageSquare;
  readonly arrowLeftIcon = ArrowLeft;
  readonly sparklesIcon = Sparkles;

  readonly streamer = toSignal(
    this.route.paramMap.pipe(map((params) => getRouteParam(this.route, 'streamer'))),
    { initialValue: getRouteParam(this.route, 'streamer') }
  );
  readonly channelID = signal<string | null>(null);

  readonly events = signal<ChatEvent[]>([]);
  readonly isLoading = signal(true);
  readonly configuringEvent = signal<string | null>(null);
  readonly pendingActions = signal<Record<string, ChatEventPendingAction>>({});

  readonly userPlan = computed<PlanTier>(() => {
    const tier = this.sessionAuth.session()?.appUser?.plan_tier ?? 'none';
    return tier === 'free' ? 'none' : (tier === 'pro' ? 'premium_plus' : 'premium');
  });

  readonly configuringEventType = computed(() => {
    const configuringName = this.configuringEvent();
    if (!configuringName) return null;
    return this.events().find(e => e.name === configuringName)?.type ?? null;
  });

  async ngOnInit(): Promise<void> {
    const routeStreamer = this.streamer() ?? '';
    const resolvedChannelId = routeStreamer
      ? await firstValueFrom(this.sessionAuth.resolveChannelID(routeStreamer))
      : this.sessionAuth.getPrimaryChannelID();

    if (!resolvedChannelId) {
      this.isLoading.set(false);
      this.toastService.error(
        this.t('chatErrors.loadTitle'),
        this.t('chatErrors.loadMessage')
      );
      return;
    }

    this.channelID.set(resolvedChannelId);
    this.loadEvents(resolvedChannelId);
    this.initThreeJs();
  }

  ngOnDestroy(): void {
    this.destroyThreeJs();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  loadEvents(channelId = this.channelID()): void {
    if (!channelId) {
      this.isLoading.set(false);
      return;
    }

    this.isLoading.set(true);
    
    this.chatEventsService.getEvents(channelId).subscribe({
      next: (events) => {
        // Mark the currently configuring event
        const configuringName = this.configuringEvent();
        const eventsWithConfigState = events.map(event => ({
          ...event,
          isConfiguring: event.name === configuringName
        }));
        
        this.events.set(eventsWithConfigState);
        this.isLoading.set(false);
      },
      error: () => {
        this.toastService.error(
          this.t('chatErrors.loadTitle'),
          this.t('chatErrors.loadMessage')
        );
        this.isLoading.set(false);
      }
    });
  }

  getUserAccess(event: ChatEvent): UserAccess {
    // Free events are always accessible
    if (!event.premium && !event.pro) {
      return { canAccess: true };
    }

    const userPlan = this.userPlan();

    // Pro required
    if (event.pro && userPlan !== 'premium_plus') {
      return { 
        canAccess: false, 
        reason: userPlan === 'premium' ? 'needs_pro' : 'needs_premium'
      };
    }

    // Premium required
    if (event.premium && userPlan === 'none') {
      return { canAccess: false, reason: 'needs_premium' };
    }

    return { canAccess: true };
  }

  toggleConfigure(event: ChatEvent): void {
    if (this.getPendingAction(event.type) !== 'none') {
      return;
    }

    const currentlyConfiguring = this.configuringEvent();
    
    if (currentlyConfiguring === event.name) {
      // Close if already open
      this.configuringEvent.set(null);
    } else {
      // Open this one, close others
      this.configuringEvent.set(event.name);
    }

    // Update events with new configuring state
    this.events.update(events => 
      events.map(e => ({
        ...e,
        isConfiguring: e.name === this.configuringEvent()
      }))
    );
  }

  toggleFeature(event: ChatEvent): void {
    const channelId = this.channelID();
    if (!channelId) {
      return;
    }

    if (this.getPendingAction(event.type) !== 'none') {
      return;
    }

    const newStatus = !event.enabled;
    this.setPendingAction(event.type, newStatus ? 'enabling' : 'disabling');

    this.chatEventsService.updateEventStatus(channelId, event.type, newStatus).subscribe({
      next: (response) => {
        this.chatEventsService.clearCache(channelId);
        const nextSubscriptionId = response.data?._id ?? event.subscriptionId;

        this.events.update(events => 
          events.map(e => 
            e.type === event.type
              ? {
                  ...e,
                  enabled: newStatus,
                  isSubscribed: newStatus ? true : e.isSubscribed,
                  subscriptionId: nextSubscriptionId,
                  isConfiguring: newStatus ? e.isConfiguring : false
                }
              : e
          )
        );
        this.clearPendingAction(event.type);
      },
      error: () => {
        this.clearPendingAction(event.type);
        // Error is handled by service toast
      }
    });
  }

  saveConfiguration(event: ChatEvent): void {
    const channelId = this.channelID();
    if (!channelId) {
      return;
    }

    if (this.getPendingAction(event.type) !== 'none') {
      return;
    }

    if (!event.config) {
      this.toastService.error(
        this.t('chatEvents.toasts.noConfigurationTitle'),
        this.t('chatEvents.toasts.noConfigurationMsg')
      );
      return;
    }
    
    const payload = this.prepareConfigForSave(event.config);
    this.setPendingAction(event.type, 'saving');

    this.chatEventsService.saveEventConfiguration(channelId, event.type, payload).subscribe({
      next: () => {
        this.chatEventsService.clearCache(channelId);
        this.clearPendingAction(event.type);
        this.toggleConfigure(event);
      },
      error: () => {
        this.clearPendingAction(event.type);
        // Error is handled by service toast
      }
    });
  }

  deleteEvent(event: ChatEvent): void {
    const channelId = this.channelID();
    if (!channelId) {
      return;
    }

    if (this.getPendingAction(event.type) !== 'none') {
      return;
    }

    const confirmed = confirm(
      `${this.t('chatEvents.deleteConfirmation.areYouSure')} "${event.name}"?\n\n${this.t('chatEvents.deleteConfirmation.warning')}`
    );

    if (!confirmed) {
      return;
    }

    this.setPendingAction(event.type, 'deleting');
    
    this.chatEventsService.deleteEvent(channelId, event.type).subscribe({
      next: () => {
        this.chatEventsService.clearCache(channelId);
        this.configuringEvent.update((current) => (current === event.name ? null : current));
        this.events.update(events =>
          events.map(e =>
            e.type === event.type
              ? {
                  ...e,
                  enabled: false,
                  isSubscribed: false,
                  subscriptionId: undefined,
                  isConfiguring: false
                }
              : e
          )
        );
        this.toastService.success(
          this.t('chatEvents.toasts.eventUnsubscribedTitle'),
          this.t('chatEvents.toasts.eventUnsubscribedMsg', { eventName: event.name })
        );
        this.clearPendingAction(event.type);
      },
      error: () => {
        this.clearPendingAction(event.type);
      }
    });
  }

  getPendingAction(eventType: string): ChatEventPendingAction {
    return this.pendingActions()[eventType] ?? 'none';
  }

  private setPendingAction(eventType: string, action: ChatEventPendingAction): void {
    this.pendingActions.update((state) => ({
      ...state,
      [eventType]: action
    }));
  }

  private clearPendingAction(eventType: string): void {
    this.pendingActions.update((state) => {
      const nextState = { ...state };
      delete nextState[eventType];
      return nextState;
    });
  }

  onUpgrade(): void {
    // Navigate to billing or pricing page
    const streamer = this.streamer();
    if (streamer) {
      void this.router.navigate([streamer, 'settings']);
    }
  }

  goBack(): void {
    const streamer = this.streamer();
    if (streamer) {
      void this.router.navigate([streamer, 'modules']);
    }
  }

  private prepareConfigForSave(configControls: ConfigControl[]): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const control of configControls) {
      const key = getConfigPersistenceKey(control);
      if (key && control.value !== undefined) {
        payload[key] = serializeConfigControlValue(control);
      }
    }
    return payload;
  }

  private initThreeJs(): void {
    const canvas = this.heroCanvas()?.nativeElement;
    if (!canvas) return;

    // Scene setup
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Create floating particles
    const particleCount = 100;
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    
    const colorPalette = [
      new THREE.Color('#8b5cf6'), // Purple
      new THREE.Color('#6366f1'), // Indigo
      new THREE.Color('#ec4899'), // Pink
      new THREE.Color('#3b82f6'), // Blue
    ];

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 10;

      const color = colorPalette[Math.floor(Math.random() * colorPalette.length)];
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.05,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending
    });

    const particles = new THREE.Points(geometry, material);
    scene.add(particles);

    camera.position.z = 5;

    // Animation loop
    let animationId = 0;
    const animate = () => {
      animationId = requestAnimationFrame(animate);

      // Rotate particles slowly
      particles.rotation.x += 0.0005;
      particles.rotation.y += 0.001;

      // Float effect
      const positionsArray = particles.geometry.attributes['position'].array as Float32Array;
      for (let i = 0; i < particleCount; i++) {
        positionsArray[i * 3 + 1] += Math.sin(Date.now() * 0.001 + i) * 0.002;
      }
      particles.geometry.attributes['position'].needsUpdate = true;

      renderer.render(scene, camera);
    };

    animate();

    // Handle resize
    const handleResize = () => {
      if (!canvas.parentElement) return;
      const width = canvas.parentElement.clientWidth;
      const height = canvas.parentElement.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };

    window.addEventListener('resize', handleResize);

    this.threeScene = {
      scene,
      camera,
      renderer,
      particles,
      animationId
    };

    // Store cleanup function
    this.cleanupResize = () => {
      window.removeEventListener('resize', handleResize);
    };
  }

  private destroyThreeJs(): void {
    if (this.threeScene) {
      cancelAnimationFrame(this.threeScene.animationId);
      this.threeScene.renderer.dispose();
      this.threeScene.particles.geometry.dispose();
      (this.threeScene.particles.material as THREE.PointsMaterial).dispose();
      
      // Call cleanup if it exists
      this.cleanupResize?.();
      this.cleanupResize = null;
      
      this.threeScene = null;
    }
  }
}
