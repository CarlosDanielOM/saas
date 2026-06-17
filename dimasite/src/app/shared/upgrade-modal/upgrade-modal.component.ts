import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { LucideAngularModule, AlertCircle, Check, RefreshCw, Sparkles, X } from 'lucide-angular';
import * as THREE from 'three';

import { LanguageService } from '../../services/language.service';
import { DeviceCapabilityService } from '../../services/device-capability.service';
import { UpgradeModalService } from '../../services/upgrade-modal.service';

@Component({
  selector: 'app-upgrade-modal',
  imports: [LucideAngularModule],
  templateUrl: './upgrade-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UpgradeModalComponent {
  private readonly languageService = inject(LanguageService);
  private readonly deviceCaps = inject(DeviceCapabilityService);
  private readonly modalService = inject(UpgradeModalService);

  private readonly modalContainer = viewChild<ElementRef<HTMLElement>>('modalContainer');
  private readonly particleCanvas = viewChild<ElementRef<HTMLCanvasElement>>('particleCanvas');

  private animationId: number | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private particles: THREE.Points | null = null;
  private reducedMotionMediaQuery: MediaQueryList | null = null;
  private reducedMotionListener: ((event: MediaQueryListEvent) => void) | null = null;

  readonly xIcon = X;
  readonly checkIcon = Check;
  readonly sparklesIcon = Sparkles;
  readonly alertIcon = AlertCircle;
  readonly refreshIcon = RefreshCw;

  readonly prompt = this.modalService.currentPrompt;
  readonly isVisible = signal(false);
  readonly useCSSFallback = computed(() => this.deviceCaps.shouldUseCSSFallback());
  readonly useThreeJS = computed(() => !this.useCSSFallback());
  readonly isLoading = computed(() => this.prompt()?.state === 'loading');
  readonly isBusy = computed(() => {
    const state = this.prompt()?.state;
    return state === 'loading' || state === 'winback' || state === 'reactivate';
  });

  constructor() {
    effect(() => {
      const current = this.prompt();
      if (current) {
        queueMicrotask(() => this.showModal());
      } else {
        this.isVisible.set(false);
        this.cleanupThreeJS();
      }
    });

    effect(() => {
      const isOpen = this.prompt() !== null;
      const useThreeJS = this.useThreeJS();

      if (!isOpen || !useThreeJS) {
        return;
      }

      this.setupReducedMotionListener();
      const reducedMotion = this.reducedMotionMediaQuery?.matches ?? false;
      if (reducedMotion) {
        this.renderCSSFallbackBackdrop();
        return;
      }

      queueMicrotask(() => this.initThreeJS());
    });
  }

  ngOnDestroy(): void {
    this.cleanupThreeJS();
    this.teardownReducedMotionListener();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  tierName(tier: 'free' | 'premium' | 'pro'): string {
    if (tier === 'pro') {
      return this.t('upgradeModal.tiers.pro.name');
    }
    if (tier === 'premium') {
      return this.t('upgradeModal.tiers.premium.name');
    }
    return this.t('navbar.planFree');
  }

  subtitleFor(currentTier: 'free' | 'premium' | 'pro'): string {
    if (currentTier === 'free') {
      return this.t('upgradeModal.subtitle.free');
    }
    if (currentTier === 'premium') {
      return this.t('upgradeModal.subtitle.premium');
    }
    return this.t('upgradeModal.subtitle.pro');
  }

  onOverlayClick(event: Event): void {
    if (event.target === event.currentTarget) {
      this.onCancel();
    }
  }

  onSubscribe(tier: 'premium' | 'pro'): void {
    if (this.isBusy()) {
      return;
    }
    this.modalService.emitChoice({ kind: 'subscribe', tier });
  }

  onAlreadySubscribed(): void {
    this.modalService.emitChoice({ kind: 'already_subscribed' });
  }

  onRetry(): void {
    this.modalService.emitChoice({ kind: 'retry' });
  }

  onCancel(): void {
    if (this.isBusy()) {
      return;
    }
    this.modalService.emitChoice({ kind: 'cancel' });
  }

  private showModal(): void {
    requestAnimationFrame(() => {
      this.isVisible.set(true);
    });
  }

  private setupReducedMotionListener(): void {
    if (this.reducedMotionMediaQuery || typeof window === 'undefined') {
      return;
    }
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotionMediaQuery = query;
    this.reducedMotionListener = (event: MediaQueryListEvent) => {
      if (event.matches) {
        this.cleanupThreeJS();
      } else {
        queueMicrotask(() => this.initThreeJS());
      }
    };
    query.addEventListener('change', this.reducedMotionListener);
  }

  private teardownReducedMotionListener(): void {
    if (this.reducedMotionMediaQuery && this.reducedMotionListener) {
      this.reducedMotionMediaQuery.removeEventListener('change', this.reducedMotionListener);
    }
    this.reducedMotionMediaQuery = null;
    this.reducedMotionListener = null;
  }

  private renderCSSFallbackBackdrop(): void {
    this.cleanupThreeJS();
  }

  private initThreeJS(): void {
    const canvas = this.particleCanvas()?.nativeElement;
    const container = this.modalContainer()?.nativeElement;
    if (!canvas || !container) {
      return;
    }

    if (this.reducedMotionMediaQuery?.matches) {
      return;
    }

    this.cleanupThreeJS();

    const rect = container.getBoundingClientRect();
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, rect.width / 240, 0.1, 1000);
    this.camera.position.z = 5;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true
    });
    this.renderer.setSize(rect.width, 240);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const particleCount = 80;
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 4;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 5;

      colors[i * 3] = 0.95 + (Math.random() - 0.5) * 0.05;
      colors[i * 3 + 1] = 0.75 + (Math.random() - 0.5) * 0.1;
      colors[i * 3 + 2] = 0.2 + (Math.random() - 0.5) * 0.1;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.06,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);

    this.animate();
  }

  private animate(): void {
    if (!this.scene || !this.camera || !this.renderer || !this.particles) {
      return;
    }
    if (this.reducedMotionMediaQuery?.matches) {
      this.cleanupThreeJS();
      return;
    }

    this.animationId = requestAnimationFrame(() => this.animate());

    this.particles.rotation.y += 0.0015;
    this.particles.rotation.x += 0.0008;

    const positions = this.particles.geometry.attributes['position'].array as Float32Array;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i + 1] += Math.sin(Date.now() * 0.0008 + i) * 0.0015;
    }
    this.particles.geometry.attributes['position'].needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }

  private cleanupThreeJS(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.scene = null;
    this.camera = null;
    this.particles = null;
  }
}
