import { ChangeDetectionStrategy, Component, ElementRef, input, output, signal, viewChild } from '@angular/core';
import * as THREE from 'three';

export interface ConfirmationModalData {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  variant: 'danger' | 'warning' | 'info';
}

@Component({
  selector: 'app-confirmation-modal',
  template: `
    @if (isOpen()) {
      <div class="modal-overlay" (click)="onOverlayClick($event)">
        <div class="modal-container" [class.modal-visible]="isVisible()" #modalContainer>
          <div class="modal-canvas-container">
            <canvas #particleCanvas class="particle-canvas"></canvas>
          </div>
          <div class="modal-content">
            <div class="modal-icon" [class]="'modal-icon--' + variant()">
              @switch (variant()) {
                @case ('danger') {
                  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                }
                @case ('warning') {
                  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
                }
                @case ('info') {
                  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                }
              }
            </div>
            <h2 class="modal-title">{{ title() }}</h2>
            <p class="modal-message">{{ message() }}</p>
            <div class="modal-actions">
              <button type="button" class="modal-btn modal-btn--cancel" (click)="onCancel()">
                {{ cancelText() }}
              </button>
              <button type="button" class="modal-btn modal-btn--confirm" [class]="'modal-btn--' + variant()" (click)="onConfirm()">
                {{ confirmText() }}
              </button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ConfirmationModalComponent {
  private readonly modalContainer = viewChild<ElementRef<HTMLElement>>('modalContainer');
  private readonly particleCanvas = viewChild<ElementRef<HTMLCanvasElement>>('particleCanvas');
  private animationId: number | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private particles: THREE.Points | null = null;

  readonly isOpen = input.required<boolean>();
  readonly title = input.required<string>();
  readonly message = input.required<string>();
  readonly confirmText = input<string>('Confirm');
  readonly cancelText = input<string>('Cancel');
  readonly variant = input<'danger' | 'warning' | 'info'>('info');

  readonly confirm = output<void>();
  readonly cancel = output<void>();

  readonly isVisible = signal(false);

  ngAfterViewInit() {
    if (this.isOpen()) {
      this.initThreeJS();
      this.showModal();
    }
  }

  ngOnChanges() {
    if (this.isOpen()) {
      this.initThreeJS();
      queueMicrotask(() => this.showModal());
    } else {
      this.isVisible.set(false);
      this.cleanupThreeJS();
    }
  }

  private showModal() {
    requestAnimationFrame(() => {
      this.isVisible.set(true);
    });
  }

  ngOnDestroy() {
    this.cleanupThreeJS();
  }

  private initThreeJS() {
    const canvas = this.particleCanvas()?.nativeElement;
    if (!canvas) return;

    const container = this.modalContainer()?.nativeElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(75, rect.width / 200, 0.1, 1000);
    this.camera.position.z = 5;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true
    });
    this.renderer.setSize(rect.width, 200);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Particles
    const particleCount = 100;
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    const variant = this.variant();
    const baseColor = variant === 'danger' ? { r: 0.8, g: 0.2, b: 0.2 } :
                      variant === 'warning' ? { r: 0.9, g: 0.6, b: 0.1 } :
                      { r: 0.4, g: 0.3, b: 0.9 };

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 4;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 5;

      colors[i * 3] = baseColor.r + (Math.random() - 0.5) * 0.3;
      colors[i * 3 + 1] = baseColor.g + (Math.random() - 0.5) * 0.3;
      colors[i * 3 + 2] = baseColor.b + (Math.random() - 0.5) * 0.3;
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

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);

    this.animate();
  }

  private animate() {
    if (!this.scene || !this.camera || !this.renderer || !this.particles) return;

    this.animationId = requestAnimationFrame(() => this.animate());

    this.particles.rotation.y += 0.002;
    this.particles.rotation.x += 0.001;

    const positions = this.particles.geometry.attributes['position'].array as Float32Array;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i + 1] += Math.sin(Date.now() * 0.001 + i) * 0.002;
    }
    this.particles.geometry.attributes['position'].needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }

  private cleanupThreeJS() {
    if (this.animationId) {
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

  onOverlayClick(event: Event) {
    if (event.target === event.currentTarget) {
      this.onCancel();
    }
  }

  onConfirm() {
    this.confirm.emit();
  }

  onCancel() {
    this.cancel.emit();
  }
}
