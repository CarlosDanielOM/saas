import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  viewChild
} from '@angular/core';
import { LucideAngularModule, AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-angular';
import * as THREE from 'three';

import { ToastItem, ToastTone } from '../../services/toast.service';

interface Toast3DConfig {
  shapeColor: number;
  glowColor: number;
  particleColor: number;
  rotationSpeed: number;
  floatAmplitude: number;
}

const TOAST_CONFIGS: Record<ToastTone, Toast3DConfig> = {
  success: {
    shapeColor: 0x10b981,
    glowColor: 0x059669,
    particleColor: 0x34d399,
    rotationSpeed: 0.008,
    floatAmplitude: 0.15
  },
  error: {
    shapeColor: 0xef4444,
    glowColor: 0xdc2626,
    particleColor: 0xf87171,
    rotationSpeed: 0.012,
    floatAmplitude: 0.2
  },
  warning: {
    shapeColor: 0xf59e0b,
    glowColor: 0xd97706,
    particleColor: 0xfbbf24,
    rotationSpeed: 0.01,
    floatAmplitude: 0.18
  },
  info: {
    shapeColor: 0x3b82f6,
    glowColor: 0x2563eb,
    particleColor: 0x60a5fa,
    rotationSpeed: 0.006,
    floatAmplitude: 0.12
  }
};

@Component({
  selector: 'app-toast-3d-card',
  imports: [LucideAngularModule],
  template: `
    <article
      class="toast-3d-card"
      [class]="toastClass()"
      [class.toast-3d-card--entering]="isEntering()"
      [class.toast-3d-card--exiting]="isExiting()"
      [style.--mouse-x.px]="mouseX()"
      [style.--mouse-y.px]="mouseY()"
      (mousemove)="onMouseMove($event)"
      (mouseleave)="onMouseLeave()"
      role="alert"
      aria-live="polite"
      aria-atomic="true"
    >
      <div class="toast-3d-canvas-container">
        <canvas #canvas class="toast-3d-canvas"></canvas>
        <div class="toast-3d-glow" [class]="glowClass()"></div>
      </div>

      <div class="toast-3d-content">
        <div class="toast-3d-icon" aria-hidden="true">
          <lucide-icon [name]="toastIcon()" class="toast-3d-icon-svg"></lucide-icon>
        </div>

        <div class="toast-3d-text">
          <p class="toast-3d-title">{{ toast().title }}</p>
          <p class="toast-3d-message">{{ toast().message }}</p>
        </div>

        <button
          type="button"
          class="toast-3d-close"
          (click)="onDismiss()"
          aria-label="Dismiss notification"
        >
          <lucide-icon [name]="closeIcon" class="toast-3d-close-icon"></lucide-icon>
        </button>
      </div>

      <div class="toast-3d-progress" [style.animation-duration.ms]="toast().durationMs">
        <div class="toast-3d-progress-bar"></div>
      </div>
    </article>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class Toast3DCardComponent implements AfterViewInit, OnDestroy {
  toast = input.required<ToastItem>();
  dismiss = output<string>();

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly hostRef = inject(ElementRef);

  protected readonly closeIcon = X;
  protected readonly isEntering = signal(true);
  protected readonly isExiting = signal(false);
  protected readonly mouseX = signal(0);
  protected readonly mouseY = signal(0);

  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private mainShape: THREE.Mesh | null = null;
  private particles: THREE.Points | null = null;
  private glowMesh: THREE.Mesh | null = null;
  private animationId: number | null = null;
  private enterTimerId: number | null = null;
  private autoExitTimerId: number | null = null;
  private dismissTimerId: number | null = null;
  private isDestroyed = false;

  protected readonly toastClass = computed(() => `toast-3d-card--${this.toast().tone}`);
  protected readonly glowClass = computed(() => `toast-3d-glow--${this.toast().tone}`);

  protected toastIcon() {
    const tone = this.toast().tone;
    if (tone === 'success') return CheckCircle2;
    if (tone === 'error') return AlertCircle;
    if (tone === 'warning') return TriangleAlert;
    return Info;
  }

  ngAfterViewInit(): void {
    // Entrance animation
    this.enterTimerId = window.setTimeout(() => {
      if (!this.isDestroyed) {
        this.isEntering.set(false);
      }
    }, 50);

    // Initialize Three.js scene
    this.initThreeJS();

    // Auto-dismiss
    this.autoExitTimerId = window.setTimeout(() => {
      this.startExitAnimation();
    }, this.toast().durationMs - 300);
  }

  ngOnDestroy(): void {
    this.isDestroyed = true;
    this.cleanup();
  }

  private initThreeJS(): void {
    const canvas = this.canvasRef().nativeElement;
    const container = canvas.parentElement;

    if (!container || !window.WebGLRenderingContext) {
      return;
    }

    const config = TOAST_CONFIGS[this.toast().tone];
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene setup
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    this.camera.position.z = 5;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'low-power'
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Create type-specific 3D shape
    this.createMainShape(config);

    // Create particle system
    this.createParticles(config);

    // Create glow effect
    this.createGlow(config);

    // Start animation loop
    this.animate();
  }

  private createMainShape(config: Toast3DConfig): void {
    if (!this.scene) return;

    const tone = this.toast().tone;
    let geometry: THREE.BufferGeometry;

    // Type-specific shapes
    switch (tone) {
      case 'success':
        // Torus ring for success
        geometry = new THREE.TorusGeometry(0.8, 0.15, 16, 100);
        break;
      case 'error':
        // Octahedron for error
        geometry = new THREE.OctahedronGeometry(0.9, 0);
        break;
      case 'warning':
        // Cone for warning
        geometry = new THREE.ConeGeometry(0.7, 1.4, 4);
        break;
      case 'info':
      default:
        // Icosahedron for info
        geometry = new THREE.IcosahedronGeometry(0.85, 0);
    }

    const material = new THREE.MeshBasicMaterial({
      color: config.shapeColor,
      transparent: true,
      opacity: 0.6,
      wireframe: true
    });

    this.mainShape = new THREE.Mesh(geometry, material);
    this.mainShape.position.set(0, 0, 0);
    this.scene.add(this.mainShape);

    // Add inner solid shape
    const innerMaterial = new THREE.MeshBasicMaterial({
      color: config.shapeColor,
      transparent: true,
      opacity: 0.15
    });
    const innerShape = new THREE.Mesh(geometry.clone(), innerMaterial);
    innerShape.scale.set(0.7, 0.7, 0.7);
    this.mainShape.add(innerShape);
  }

  private createParticles(config: Toast3DConfig): void {
    if (!this.scene) return;

    const particleCount = 25;
    const positions = new Float32Array(particleCount * 3);
    const velocities: THREE.Vector3[] = [];

    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;
      const radius = 1.2 + Math.random() * 0.8;

      positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i3 + 2] = radius * Math.cos(phi);

      velocities.push(new THREE.Vector3(
        (Math.random() - 0.5) * 0.01,
        (Math.random() - 0.5) * 0.01,
        (Math.random() - 0.5) * 0.01
      ));
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: config.particleColor,
      size: 0.08,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending
    });

    this.particles = new THREE.Points(geometry, material);
    this.particles.userData = { velocities };
    this.scene.add(this.particles);
  }

  private createGlow(config: Toast3DConfig): void {
    if (!this.scene) return;

    const geometry = new THREE.SphereGeometry(1.5, 32, 32);
    const material = new THREE.MeshBasicMaterial({
      color: config.glowColor,
      transparent: true,
      opacity: 0.08,
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

    const config = TOAST_CONFIGS[this.toast().tone];
    const time = Date.now() * 0.001;

    // Animate main shape
    if (this.mainShape) {
      this.mainShape.rotation.x += config.rotationSpeed;
      this.mainShape.rotation.y += config.rotationSpeed * 1.5;
      this.mainShape.position.y = Math.sin(time * 2) * config.floatAmplitude;
    }

    // Animate particles
    if (this.particles) {
      const positions = this.particles.geometry.attributes['position'].array as Float32Array;
      const velocities = this.particles.userData['velocities'] as THREE.Vector3[];

      for (let i = 0; i < velocities.length; i++) {
        const i3 = i * 3;
        positions[i3] += velocities[i].x;
        positions[i3 + 1] += velocities[i].y;
        positions[i3 + 2] += velocities[i].z;

        // Reset particles that go too far
        const dist = Math.sqrt(
          positions[i3] ** 2 + positions[i3 + 1] ** 2 + positions[i3 + 2] ** 2
        );
        if (dist > 2.5) {
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.random() * Math.PI;
          const radius = 1.2 + Math.random() * 0.5;
          positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
          positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
          positions[i3 + 2] = radius * Math.cos(phi);
        }
      }
      this.particles.geometry.attributes['position'].needsUpdate = true;
      this.particles.rotation.y -= 0.002;
    }

    // Pulse glow
    if (this.glowMesh) {
      const scale = 1 + Math.sin(time * 3) * 0.1;
      this.glowMesh.scale.set(scale, scale, scale);
    }

    // Apply mouse tilt effect
    const tiltX = (this.mouseY() / 100) * 0.1;
    const tiltY = (this.mouseX() / 100) * 0.1;

    if (this.mainShape) {
      this.mainShape.rotation.x += tiltX;
      this.mainShape.rotation.y += tiltY;
    }

    this.renderer.render(this.scene, this.camera);
    this.animationId = requestAnimationFrame(() => this.animate());
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
    this.dismissTimerId = window.setTimeout(() => {
      if (!this.isDestroyed) {
        this.dismiss.emit(this.toast().id);
      }
    }, 300);
  }

  private cleanup(): void {
    if (this.enterTimerId !== null) {
      window.clearTimeout(this.enterTimerId);
      this.enterTimerId = null;
    }

    if (this.autoExitTimerId !== null) {
      window.clearTimeout(this.autoExitTimerId);
      this.autoExitTimerId = null;
    }

    if (this.dismissTimerId !== null) {
      window.clearTimeout(this.dismissTimerId);
      this.dismissTimerId = null;
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
      this.mainShape.geometry.dispose();
      (this.mainShape.material as THREE.Material).dispose();
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
