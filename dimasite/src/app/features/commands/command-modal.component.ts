import { ChangeDetectionStrategy, Component, ElementRef, OnInit, OnDestroy, inject, input, output, signal, viewChild } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Command, CreateCommandRequest, USER_LEVELS, USER_LEVEL_NAMES } from '../../models/command.model';
import { LanguageService } from '../../services/language.service';
import * as THREE from 'three';

type ParticleDesign = 'particles' | 'rings' | 'spiral' | 'constellation';

interface ParticleConfig {
  count: number;
  colors: { r: number; g: number; b: number }[];
  design: ParticleDesign;
}

const PARTICLE_CONFIGS: ParticleConfig[] = [
  // Purple spiral
  {
    design: 'spiral',
    count: 120,
    colors: [
      { r: 0.55, g: 0.15, b: 0.85 },
      { r: 0.75, g: 0.25, b: 0.95 },
      { r: 0.45, g: 0.10, b: 0.75 }
    ]
  },
  // Rings
  {
    design: 'rings',
    count: 80,
    colors: [
      { r: 0.65, g: 0.20, b: 0.90 },
      { r: 0.85, g: 0.35, b: 0.95 },
      { r: 0.40, g: 0.15, b: 0.70 }
    ]
  },
  // Constellation
  {
    design: 'constellation',
    count: 100,
    colors: [
      { r: 0.70, g: 0.25, b: 0.90 },
      { r: 0.50, g: 0.15, b: 0.80 },
      { r: 0.90, g: 0.45, b: 0.95 }
    ]
  },
  // Particles (default purple)
  {
    design: 'particles',
    count: 150,
    colors: [
      { r: 0.60, g: 0.18, b: 0.88 },
      { r: 0.80, g: 0.30, b: 0.95 },
      { r: 0.35, g: 0.08, b: 0.65 }
    ]
  }
];

@Component({
  selector: 'app-command-modal',
  imports: [ReactiveFormsModule],
  template: `
    @if (isOpen()) {
      <div class="command-modal-overlay" (click)="onOverlayClick($event)">
        <div class="command-modal-container" [class.command-modal-visible]="isVisible()" #modalContainer>
          <div class="command-modal-canvas-container">
            <canvas #particleCanvas class="particle-canvas"></canvas>
          </div>

          <div class="command-modal-content">
            <div class="command-modal-header">
              <h2 class="command-modal-title">
                {{ isEditMode() ? t('commands.modal.editTitle') : t('commands.modal.createTitle') }}
              </h2>
              <button type="button" class="command-modal-close" (click)="onCancel()">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <form [formGroup]="commandForm" class="command-modal-form" (ngSubmit)="onSubmit()">
              <div class="command-modal-field">
                <label for="cmdName">{{ t('commands.placeholder.name') }}</label>
                <input
                  type="text"
                  id="cmdName"
                  class="command-input"
                  [placeholder]="t('commands.placeholder.name')"
                  formControlName="name"
                >
              </div>

              <div class="command-modal-field">
                <label for="cmdTrigger">{{ t('commands.placeholder.command') }}</label>
                <div class="command-input-prefix">
                  <span>!</span>
                  <input
                    type="text"
                    id="cmdTrigger"
                    class="command-input"
                    [placeholder]="t('commands.placeholder.command')"
                    formControlName="cmd"
                  >
                </div>
              </div>

              <div class="command-modal-field">
                <label for="cmdMessage">{{ t('commands.placeholder.function') }}</label>
                <input
                  type="text"
                  id="cmdMessage"
                  class="command-input"
                  [placeholder]="t('commands.placeholder.function')"
                  formControlName="message"
                >
              </div>

              <div class="command-modal-field">
                <label for="cmdDescription">{{ t('commands.placeholder.description') }}</label>
                <input
                  type="text"
                  id="cmdDescription"
                  class="command-input"
                  [placeholder]="t('commands.placeholder.description')"
                  formControlName="description"
                >
              </div>

              <div class="command-modal-row">
                <div class="command-modal-field command-modal-field--half">
                  <label for="cmdCooldown">{{ t('commands.placeholder.cooldown') }}</label>
                  <div class="command-input-suffix">
                    <input
                      type="number"
                      id="cmdCooldown"
                      class="command-input"
                      min="5"
                      max="60"
                      formControlName="cooldown"
                    >
                    <span>s</span>
                  </div>
                </div>

                <div class="command-modal-field command-modal-field--half">
                  <label for="cmdUserLevel">{{ t('commands.placeholder.userLevel') }}</label>
                  <select id="cmdUserLevel" class="command-select" formControlName="userLevel">
                    @for (level of [1,2,3,4,5,6,7,8,9,10]; track level) {
                      <option [value]="level">
                        {{ level }} - {{ t(getUserLevelName(level)) }}
                      </option>
                    }
                  </select>
                </div>
              </div>

              <div class="command-modal-field command-modal-field--checkbox">
                <label class="command-checkbox">
                  <input type="checkbox" formControlName="enabled">
                  <span>{{ t('common.enabled') }}</span>
                </label>
              </div>
            </form>

            <div class="command-modal-actions">
              <button
                type="button"
                class="command-modal-btn command-modal-btn--cancel"
                (click)="onCancel()"
              >
                {{ t('common.cancel') }}
              </button>
              <button
                type="button"
                class="command-modal-btn command-modal-btn--submit"
                [disabled]="commandForm.invalid || isSaving()"
                (click)="onSubmit()"
              >
                @if (isSaving()) {
                  <span class="command-modal-spinner"></span>
                } @else {
                  {{ isEditMode() ? t('common.save') : t('commands.modal.createButton') }}
                }
              </button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CommandModalComponent implements OnInit, OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly languageService = inject(LanguageService);

  private readonly modalContainer = viewChild<ElementRef<HTMLElement>>('modalContainer');
  private readonly particleCanvas = viewChild<ElementRef<HTMLCanvasElement>>('particleCanvas');

  private animationId: number | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private particles: THREE.Points | null = null;
  private lines: THREE.LineSegments | null = null;
  private currentConfig: ParticleConfig | null = null;
  private time = 0;

  readonly isOpen = input.required<boolean>();
  readonly command = input<Command | null>(null);

  readonly isEditMode = signal(false);
  readonly isSaving = signal(false);
  readonly isVisible = signal(false);

  readonly save = output<CreateCommandRequest>();
  readonly cancel = output<void>();

  commandForm: FormGroup = this.fb.group({
    name: ['', [Validators.required]],
    cmd: ['', [Validators.required]],
    message: ['', [Validators.required]],
    description: [''],
    cooldown: [10, [Validators.required, Validators.min(5), Validators.max(60)]],
    userLevel: [1, [Validators.required, Validators.min(1), Validators.max(10)]],
    enabled: [true]
  });

  ngOnInit() {
    this.setupForm();
  }

  ngOnDestroy() {
    this.cleanupThreeJS();
  }

  private setupForm() {
    const cmd = this.command();
    this.isEditMode.set(!!cmd);

    if (cmd) {
      this.commandForm.patchValue({
        name: cmd.name,
        cmd: cmd.cmd,
        message: cmd.message,
        description: cmd.description || '',
        cooldown: cmd.cooldown,
        userLevel: cmd.userLevel,
        enabled: cmd.enabled
      });
    } else {
      this.commandForm.reset({
        name: '',
        cmd: '',
        message: '',
        description: '',
        cooldown: 10,
        userLevel: 1,
        enabled: true
      });
    }
  }

  t(key: string): string {
    return this.languageService.translate(key);
  }

  getUserLevelName(level: number): string {
    return USER_LEVEL_NAMES[level] || 'commands.userLevels.everyone';
  }

  onOverlayClick(event: Event) {
    if (event.target === event.currentTarget) {
      this.onCancel();
    }
  }

  onCancel() {
    this.cancel.emit();
  }

  onSubmit() {
    if (this.commandForm.invalid) return;

    this.isSaving.set(true);

    const formValue = this.commandForm.value;

    // If editing, the parent will handle the actual update
    // For create, we emit the full request
    const request: CreateCommandRequest = {
      name: formValue.name,
      cmd: formValue.cmd,
      func: formValue.cmd,
      message: formValue.message,
      description: formValue.description || null,
      cooldown: formValue.cooldown,
      userLevel: formValue.userLevel,
      userLevelName: USER_LEVELS[formValue.userLevel],
      enabled: formValue.enabled,
      channel: '' // Will be set by parent
    };

    this.save.emit(request);

    // Reset saving state after a short delay (parent will close modal on success)
    setTimeout(() => {
      this.isSaving.set(false);
    }, 500);
  }

  ngAfterViewInit() {
    if (this.isOpen()) {
      queueMicrotask(() => this.showModal());
    }
  }

  ngOnChanges() {
    if (this.isOpen()) {
      this.setupForm();
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

  private initThreeJS() {
    const canvas = this.particleCanvas()?.nativeElement;
    if (!canvas) return;

    const container = this.modalContainer()?.nativeElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();

    // Cleanup existing
    this.cleanupThreeJS();

    // Pick random config
    this.currentConfig = PARTICLE_CONFIGS[Math.floor(Math.random() * PARTICLE_CONFIGS.length)];

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

    // Create particles based on design
    this.createParticles(this.currentConfig);

    this.animate();
  }

  private createParticles(config: ParticleConfig) {
    if (!this.scene || !this.camera) return;

    const { count, colors, design } = config;

    if (design === 'rings') {
      this.createRingDesign(count, colors);
    } else if (design === 'spiral') {
      this.createSpiralDesign(count, colors);
    } else if (design === 'constellation') {
      this.createConstellationDesign(count, colors);
    } else {
      this.createParticleDesign(count, colors);
    }
  }

  private createParticleDesign(count: number, colors: { r: number; g: number; b: number }[]) {
    if (!this.scene) return;

    const positions = new Float32Array(count * 3);
    const colorArray = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 4;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 5;

      const color = colors[Math.floor(Math.random() * colors.length)];
      colorArray[i * 3] = color.r + (Math.random() - 0.5) * 0.2;
      colorArray[i * 3 + 1] = color.g + (Math.random() - 0.5) * 0.2;
      colorArray[i * 3 + 2] = color.b + (Math.random() - 0.5) * 0.2;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));

    const material = new THREE.PointsMaterial({
      size: 0.06,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);
  }

  private createRingDesign(count: number, colors: { r: number; g: number; b: number }[]) {
    if (!this.scene) return;

    const ringCount = 3;
    const pointsPerRing = Math.floor(count / ringCount);
    const positions = new Float32Array(count * 3);
    const colorArray = new Float32Array(count * 3);

    for (let r = 0; r < ringCount; r++) {
      const radius = 1.5 + r * 0.8;
      const baseColor = colors[r % colors.length];

      for (let i = 0; i < pointsPerRing; i++) {
        const idx = r * pointsPerRing + i;
        const angle = (i / pointsPerRing) * Math.PI * 2;

        positions[idx * 3] = Math.cos(angle) * radius + (Math.random() - 0.5) * 0.1;
        positions[idx * 3 + 1] = Math.sin(angle) * radius + (Math.random() - 0.5) * 0.1;
        positions[idx * 3 + 2] = (Math.random() - 0.5) * 0.5;

        colorArray[idx * 3] = baseColor.r;
        colorArray[idx * 3 + 1] = baseColor.g;
        colorArray[idx * 3 + 2] = baseColor.b;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));

    const material = new THREE.PointsMaterial({
      size: 0.08,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);
  }

  private createSpiralDesign(count: number, colors: { r: number; g: number; b: number }[]) {
    if (!this.scene) return;

    const positions = new Float32Array(count * 3);
    const colorArray = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const t = i / count;
      const angle = t * Math.PI * 6; // 3 full rotations
      const radius = 0.5 + t * 2;

      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = Math.sin(angle) * radius * 0.4;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 0.3;

      const color = colors[Math.floor(t * colors.length)];
      colorArray[i * 3] = color.r;
      colorArray[i * 3 + 1] = color.g;
      colorArray[i * 3 + 2] = color.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));

    const material = new THREE.PointsMaterial({
      size: 0.07,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);
  }

  private createConstellationDesign(count: number, colors: { r: number; g: number; b: number }[]) {
    if (!this.scene) return;

    const positions = new Float32Array(count * 3);
    const colorArray = new Float32Array(count * 3);
    const nodeIndices: number[] = [];

    // Create nodes (bright points)
    const nodeCount = Math.floor(count * 0.2);
    for (let i = 0; i < nodeCount; i++) {
      nodeIndices.push(i);
      positions[i * 3] = (Math.random() - 0.5) * 8;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 3;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 2;

      const color = colors[Math.floor(Math.random() * colors.length)];
      colorArray[i * 3] = color.r + 0.2;
      colorArray[i * 3 + 1] = color.g + 0.2;
      colorArray[i * 3 + 2] = color.b + 0.2;
    }

    // Create connections (dimmer points)
    for (let i = nodeCount; i < count; i++) {
      const fromNode = nodeIndices[Math.floor(Math.random() * nodeIndices.length)];
      const toNode = nodeIndices[Math.floor(Math.random() * nodeIndices.length)];

      const from = new THREE.Vector3(
        positions[fromNode * 3],
        positions[fromNode * 3 + 1],
        positions[fromNode * 3 + 2]
      );
      const to = new THREE.Vector3(
        positions[toNode * 3],
        positions[toNode * 3 + 1],
        positions[toNode * 3 + 2]
      );

      const t = Math.random();
      positions[i * 3] = from.x + (to.x - from.x) * t + (Math.random() - 0.5) * 0.2;
      positions[i * 3 + 1] = from.y + (to.y - from.y) * t + (Math.random() - 0.5) * 0.2;
      positions[i * 3 + 2] = from.z + (to.z - from.z) * t + (Math.random() - 0.5) * 0.2;

      const color = colors[0];
      colorArray[i * 3] = color.r * 0.6;
      colorArray[i * 3 + 1] = color.g * 0.6;
      colorArray[i * 3 + 2] = color.b * 0.6;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));

    const material = new THREE.PointsMaterial({
      size: 0.05,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);
  }

  private animate() {
    if (!this.scene || !this.camera || !this.renderer || !this.particles) return;

    this.animationId = requestAnimationFrame(() => this.animate());
    this.time += 0.01;

    // Rotate based on design
    if (this.currentConfig?.design === 'spiral') {
      this.particles.rotation.y += 0.003;
      this.particles.rotation.x += 0.001;
    } else if (this.currentConfig?.design === 'rings') {
      this.particles.rotation.z += 0.002;
      this.particles.rotation.y += 0.001;
    } else if (this.currentConfig?.design === 'constellation') {
      this.particles.rotation.y += 0.001;
      // Pulse effect
      const scale = 1 + Math.sin(this.time * 2) * 0.05;
      this.particles.scale.set(scale, scale, scale);
    } else {
      // Default particles
      this.particles.rotation.y += 0.002;
      this.particles.rotation.x += 0.001;
    }

    // Floating animation
    const positions = this.particles.geometry.attributes['position'].array as Float32Array;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i + 1] += Math.sin(this.time + i * 0.1) * 0.001;
    }
    this.particles.geometry.attributes['position'].needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }

  private cleanupThreeJS() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this.particles) {
      this.particles.geometry.dispose();
      (this.particles.material as THREE.Material).dispose();
      this.scene?.remove(this.particles);
      this.particles = null;
    }

    if (this.lines) {
      this.lines.geometry.dispose();
      (this.lines.material as THREE.Material).dispose();
      this.scene?.remove(this.lines);
      this.lines = null;
    }

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }

    this.scene = null;
    this.camera = null;
  }
}


