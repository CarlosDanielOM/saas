import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  inject,
  input,
  output,
  signal,
  viewChild
} from '@angular/core';
import { LucideAngularModule, Gift, X } from 'lucide-angular';
import * as THREE from 'three';

interface PromoConfig {
  shapeColor: number;
  glowColor: number;
  particleColor: number;
  rotationSpeed: number;
  floatAmplitude: number;
}

const PROMO_CONFIG: PromoConfig = {
  shapeColor: 0x8b5cf6,
  glowColor: 0x7c3aed,
  particleColor: 0xa78bfa,
  rotationSpeed: 0.015,
  floatAmplitude: 0.12
};

@Component({
  selector: 'app-referral-promo-banner',
  imports: [LucideAngularModule],
  template: `
    <article
      class="referral-promo-banner"
      [class.referral-promo-banner--entering]="isEntering()"
      [class.referral-promo-banner--exiting]="isExiting()"
      [style.--mouse-x.px]="mouseX()"
      [style.--mouse-y.px]="mouseY()"
      (mousemove)="onMouseMove($event)"
      (mouseleave)="onMouseLeave()"
      role="alert"
      aria-live="polite"
    >
      <div class="referral-promo-canvas-container">
        <canvas #canvas class="referral-promo-canvas"></canvas>
        <div class="referral-promo-glow"></div>
      </div>

      <div class="referral-promo-content">
        <div class="referral-promo-icon" aria-hidden="true">
          <lucide-icon [name]="giftIcon" class="referral-promo-icon-svg"></lucide-icon>
        </div>

        <div class="referral-promo-text">
          <p class="referral-promo-title">{{ title() }}</p>
          <p class="referral-promo-message">{{ message() }}</p>
        </div>

        <a
          [href]="ctaLink()"
          class="referral-promo-cta"
        >
          {{ cta() }}
        </a>

        <button
          type="button"
          class="referral-promo-close"
          (click)="onDismiss()"
          aria-label="Dismiss referral banner"
        >
          <lucide-icon [name]="closeIcon" class="referral-promo-close-icon"></lucide-icon>
        </button>
      </div>
    </article>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReferralPromoBannerComponent implements AfterViewInit, OnDestroy {
  private readonly hostRef = inject(ElementRef);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly giftIcon = Gift;
  protected readonly closeIcon = X;

  protected readonly isEntering = signal(true);
  protected readonly isExiting = signal(false);
  protected readonly mouseX = signal(0);
  protected readonly mouseY = signal(0);

  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private mainShape: THREE.Group | null = null;
  private particles: THREE.Points | null = null;
  private glowMesh: THREE.Mesh | null = null;
  private animationId: number | null = null;
  private enterTimerId: number | null = null;
  private exitTimerId: number | null = null;
  private isDestroyed = false;

  title = input.required<string>();
  message = input.required<string>();
  cta = input.required<string>();
  ctaLink = input.required<string>();
  dismissed = output<void>();

  ngAfterViewInit(): void {
    this.enterTimerId = window.setTimeout(() => {
      if (!this.isDestroyed) {
        this.isEntering.set(false);
      }
    }, 50);

    this.initThreeJS();
  }

  ngOnDestroy(): void {
    this.isDestroyed = true;
    this.cleanup();
  }

  protected onMouseMove(event: MouseEvent): void {
    const rect = this.hostRef.nativeElement.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    this.mouseX.set(x);
    this.mouseY.set(y);
  }

  protected onMouseLeave(): void {
    this.mouseX.set(0);
    this.mouseY.set(0);
  }

  protected onDismiss(): void {
    this.startExitAnimation();
  }

  private startExitAnimation(): void {
    if (this.isDestroyed || this.isExiting()) return;

    this.isExiting.set(true);
    this.exitTimerId = window.setTimeout(() => {
      if (!this.isDestroyed) {
        this.dismissed.emit();
      }
    }, 300);
  }

  private initThreeJS(): void {
    const canvas = this.canvasRef().nativeElement;
    const container = canvas.parentElement;

    if (!container || !window.WebGLRenderingContext) {
      return;
    }

    const width = container.clientWidth;
    const height = container.clientHeight;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    this.camera.position.z = 5;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'low-power'
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.createGiftShape();
    this.createParticles();
    this.createGlow();

    this.animate();
  }

  private createGiftShape(): void {
    if (!this.scene) return;

    this.mainShape = new THREE.Group();

    const boxGeometry = new THREE.BoxGeometry(0.8, 0.6, 0.6);
    const boxMaterial = new THREE.MeshBasicMaterial({
      color: PROMO_CONFIG.shapeColor,
      transparent: true,
      opacity: 0.5,
      wireframe: true
    });
    const box = new THREE.Mesh(boxGeometry, boxMaterial);
    this.mainShape.add(box);

    const ribbonGeometry = new THREE.CylinderGeometry(0.08, 0.08, 1.0, 8);
    const ribbonMaterial = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.8,
      wireframe: true
    });
    const ribbon = new THREE.Mesh(ribbonGeometry, ribbonMaterial);
    ribbon.rotation.x = Math.PI / 2;
    ribbon.position.y = 0.3;
    this.mainShape.add(ribbon);

    const bowGeometry = new THREE.TorusGeometry(0.2, 0.06, 8, 16);
    const bowMaterial = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.8,
      wireframe: true
    });
    const bow = new THREE.Mesh(bowGeometry, bowMaterial);
    bow.position.y = 0.6;
    bow.rotation.x = Math.PI / 2;
    this.mainShape.add(bow);

    this.mainShape.position.set(0, 0, 0);
    this.scene.add(this.mainShape);
  }

  private createParticles(): void {
    if (!this.scene) return;

    const particleCount = 20;
    const positions = new Float32Array(particleCount * 3);
    const velocities: THREE.Vector3[] = [];

    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;
      const radius = 1.0 + Math.random() * 0.6;

      positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i3 + 2] = radius * Math.cos(phi);

      velocities.push(new THREE.Vector3(
        (Math.random() - 0.5) * 0.008,
        (Math.random() - 0.5) * 0.008,
        (Math.random() - 0.5) * 0.008
      ));
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: PROMO_CONFIG.particleColor,
      size: 0.06,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending
    });

    this.particles = new THREE.Points(geometry, material);
    this.particles.userData = { velocities };
    this.scene.add(this.particles);
  }

  private createGlow(): void {
    if (!this.scene) return;

    const geometry = new THREE.SphereGeometry(1.2, 32, 32);
    const material = new THREE.MeshBasicMaterial({
      color: PROMO_CONFIG.glowColor,
      transparent: true,
      opacity: 0.06,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide
    });

    this.glowMesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.glowMesh);
  }

  private animate(): void {
    if (this.isDestroyed || !this.renderer || !this.scene || !this.camera) {
      return;
    }

    const time = Date.now() * 0.001;

    if (this.mainShape) {
      this.mainShape.rotation.y += PROMO_CONFIG.rotationSpeed;
      this.mainShape.rotation.x += PROMO_CONFIG.rotationSpeed * 0.5;
      this.mainShape.position.y = Math.sin(time * 2) * PROMO_CONFIG.floatAmplitude;
    }

    if (this.particles) {
      const positions = this.particles.geometry.attributes['position'].array as Float32Array;
      const velocities = this.particles.userData['velocities'] as THREE.Vector3[];

      for (let i = 0; i < velocities.length; i++) {
        const i3 = i * 3;
        positions[i3] += velocities[i].x;
        positions[i3 + 1] += velocities[i].y;
        positions[i3 + 2] += velocities[i].z;

        const dist = Math.sqrt(
          positions[i3] ** 2 + positions[i3 + 1] ** 2 + positions[i3 + 2] ** 2
        );
        if (dist > 2.0) {
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.random() * Math.PI;
          const radius = 1.0 + Math.random() * 0.4;
          positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
          positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
          positions[i3 + 2] = radius * Math.cos(phi);
        }
      }
      this.particles.geometry.attributes['position'].needsUpdate = true;
      this.particles.rotation.y -= 0.002;
    }

    if (this.glowMesh) {
      const scale = 1 + Math.sin(time * 3) * 0.08;
      this.glowMesh.scale.set(scale, scale, scale);
    }

    const tiltX = (this.mouseY() / 100) * 0.08;
    const tiltY = (this.mouseX() / 100) * 0.08;

    if (this.mainShape) {
      this.mainShape.rotation.x += tiltX;
      this.mainShape.rotation.y += tiltY;
    }

    this.renderer.render(this.scene, this.camera);
    this.animationId = requestAnimationFrame(() => this.animate());
  }

  private cleanup(): void {
    if (this.enterTimerId !== null) {
      window.clearTimeout(this.enterTimerId);
      this.enterTimerId = null;
    }

    if (this.exitTimerId !== null) {
      window.clearTimeout(this.exitTimerId);
      this.exitTimerId = null;
    }

    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }

    if (this.mainShape) {
      this.mainShape.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
        }
      });
      this.mainShape = null;
    }

    if (this.particles) {
      this.particles.geometry.dispose();
      (this.particles.material as THREE.Material).dispose();
      this.particles = null;
    }

    if (this.glowMesh) {
      this.glowMesh.geometry.dispose();
      (this.glowMesh.material as THREE.Material).dispose();
      this.glowMesh = null;
    }

    this.scene = null;
    this.camera = null;
  }
}