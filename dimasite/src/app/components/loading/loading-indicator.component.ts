/**
 * Adaptive Loading Indicator Component
 *
 * A high-performance loading indicator with automatic device capability detection.
 * Features three unique Three.js animations (Lattice, Crystals, Fractals) that
 * rotate randomly, with a CSS fallback for low-performance devices.
 *
 * Usage Examples:
 *
 * Fullscreen page loading:
 * ```html
 * <loading-indicator
 *   [loading]="isLoading()"
 *   size="fullscreen"
 *   message="common.loading_dashboard"
 *   [showProgress]="true"
 *   [progress]="loadingProgress()" />
 * ```
 *
 * Inline component loading:
 * ```html
 * <div class="card">
 *   @if (isLoading()) {
 *     <loading-indicator
 *       [loading]="true"
 *       size="md"
 *       message="common.loading_commands" />
 *   } @else {
 *     <table>...</table>
 *   }
 * </div>
 * ```
 *
 * Force CSS only (no WebGL):
 * ```html
 * <loading-indicator
 *   [loading]="isLoading()"
 *   variant="css"
 *   size="lg" />
 * ```
 *
 * Props:
 * - loading: boolean (required) - Controls visibility
 * - variant: 'auto' | 'css' | 'three' - Animation type (default: 'auto')
 * - size: 'sm' | 'md' | 'lg' | 'fullscreen' - Component size (default: 'md')
 * - message: string - Translation key for loading message
 * - showProgress: boolean - Show progress bar
 * - progress: number - Progress value 0-100
 * - centered: boolean - Center within container (default: true)
 */
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  OnDestroy,
  signal,
  viewChild
} from '@angular/core';
import * as THREE from 'three';
import { DeviceCapabilityService } from '../../services/device-capability.service';
import { LanguageService } from '../../services/language.service';
import type { LoadingSize, LoadingVariant, ThreeAnimationType, LatticeNode, Crystal, FractalBranch } from './loading-indicator.types';

@Component({
  selector: 'loading-indicator',
  template: `
    @if (loading()) {
      <div class="loading-indicator"
           [class.loading-indicator--fullscreen]="isFullscreen()"
           [class.loading-indicator--inline]="!isFullscreen()"
           [class.loading-indicator--centered]="centered()"
           [attr.data-size]="effectiveSize()"
           [attr.data-quality]="qualityTier()">
        
        <div class="loading-indicator__content" [style.width.px]="containerSize()" [style.height.px]="containerSize()">
          <canvas #canvas 
                  class="loading-indicator__canvas" 
                  [class.loading-indicator__canvas--visible]="isThreeJsReady()"></canvas>
          
          <div class="loading-indicator__fallback"
               [class.loading-indicator__fallback--visible]="!isThreeJsReady() || shouldUseCSSFallback()"
               [class.loading-indicator__fallback--fading]="isThreeJsReady() && !shouldUseCSSFallback()">
            <div class="loading-indicator__core"></div>
            <div class="loading-indicator__ring loading-indicator__ring--1"></div>
            <div class="loading-indicator__ring loading-indicator__ring--2"></div>
            <div class="loading-indicator__ring loading-indicator__ring--3"></div>
          </div>
        </div>
        
        @if (message() || showProgress()) {
          <div class="loading-indicator__info">
            @if (message()) {
              <span class="loading-indicator__message">{{ translatedMessage() }}</span>
            }
            @if (showProgress()) {
              <div class="loading-indicator__progress-container">
                <div class="loading-indicator__progress-bar" [style.width.%]="clampedProgress()"></div>
                <span class="loading-indicator__progress-text">{{ clampedProgress() }}%</span>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-variant]': 'effectiveVariant()',
    '[attr.data-animation]': 'currentAnimationType()'
  }
})
export class LoadingIndicatorComponent implements AfterViewInit, OnDestroy {
  private readonly deviceCapability = inject(DeviceCapabilityService);
  private readonly languageService = inject(LanguageService);
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  readonly loading = input.required<boolean>();
  readonly variant = input<LoadingVariant>('auto');
  readonly size = input<LoadingSize>('md');
  readonly message = input<string>('');
  readonly progress = input<number>(0);
  readonly showProgress = input<boolean>(false);
  readonly centered = input<boolean>(true);
  readonly animationType = input<ThreeAnimationType | 'random'>('random');

  readonly qualityTier = computed(() => this.deviceCapability.currentTier());
  readonly shouldUseCSSFallback = computed(() => this.deviceCapability.shouldUseCSSFallback());
  readonly isThreeJsReady = signal(false);
  readonly currentAnimationType = signal<ThreeAnimationType>('lattice');

  readonly effectiveVariant = computed<LoadingVariant>(() => {
    const variant = this.variant();
    if (variant !== 'auto') return variant;
    return this.shouldUseCSSFallback() ? 'css' : 'three';
  });

  readonly effectiveSize = computed<LoadingSize>(() => {
    const size = this.size();
    if (size === 'fullscreen') return size;
    if (this.qualityTier() === 'low') {
      return size === 'lg' ? 'md' : size === 'md' ? 'sm' : 'sm';
    }
    return size;
  });

  readonly isFullscreen = computed(() => this.effectiveSize() === 'fullscreen');

  readonly containerSize = computed(() => {
    const size = this.effectiveSize();
    switch (size) {
      case 'sm': return 60;
      case 'md': return 120;
      case 'lg': return 200;
      case 'fullscreen': return 280;
      default: return 120;
    }
  });

  readonly clampedProgress = computed(() => {
    const p = this.progress();
    return Math.max(0, Math.min(100, Math.round(p)));
  });

  readonly translatedMessage = computed(() => {
    const msg = this.message();
    if (!msg) return '';
    return this.languageService.translate(msg);
  });

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private animationFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private latticeNodes: LatticeNode[] = [];
  private latticeConnections: THREE.Line[] = [];
  private crystals: Crystal[] = [];
  private fractalBranches: FractalBranch[] = [];
  private pulseLights: THREE.PointLight[] = [];

  private time = 0;
  private lastFrameTime = 0;
  private targetFrameInterval = 16;
  private startTime: number | null = null;
  private minimumDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly MINIMUM_DURATION = 1000; // 1 second minimum

  constructor() {
    effect(() => {
      if (this.loading() && this.effectiveVariant() === 'three' && !this.isThreeJsReady()) {
        queueMicrotask(() => this.initThreeJS());
      }
    });

    effect(() => {
      const isLoading = this.loading();
      if (isLoading) {
        // Record start time when loading begins
        this.startTime = Date.now();
      } else if (this.startTime !== null) {
        // When loading ends, ensure minimum duration
        const elapsed = Date.now() - this.startTime;
        const remaining = Math.max(0, this.MINIMUM_DURATION - elapsed);
        
        if (remaining > 0) {
          // Delay cleanup to meet minimum duration
          this.minimumDurationTimer = setTimeout(() => {
            this.cleanup();
          }, remaining);
        } else {
          this.cleanup();
        }
        this.startTime = null;
      }
    });
  }

  ngAfterViewInit(): void {
    if (this.loading() && this.effectiveVariant() === 'three') {
      this.initThreeJS();
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  private selectRandomAnimation(): ThreeAnimationType {
    const animations: ThreeAnimationType[] = ['lattice', 'crystals', 'fractals'];
    return animations[Math.floor(Math.random() * animations.length)];
  }

  private initThreeJS(): void {
    if (this.isThreeJsReady() || this.shouldUseCSSFallback()) return;

    const canvas = this.canvasRef().nativeElement;
    const tier = this.qualityTier();
    const size = this.containerSize();

    const requestedType = this.animationType();
    if (requestedType === 'random') {
      this.currentAnimationType.set(this.selectRandomAnimation());
    } else {
      this.currentAnimationType.set(requestedType);
    }

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000000, 0.015);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.z = 8;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: tier === 'high',
      alpha: true,
      powerPreference: tier === 'high' ? 'high-performance' : 'low-power'
    });

    const pixelRatio = Math.min(window.devicePixelRatio, tier === 'high' ? 2 : 1);
    this.renderer.setSize(size, size);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setClearColor(0x000000, 0);

    this.setupLighting(tier);

    const animationType = this.currentAnimationType();
    switch (animationType) {
      case 'lattice':
        this.createLattice(tier);
        break;
      case 'crystals':
        this.createCrystals(tier);
        break;
      case 'fractals':
        this.createFractals(tier);
        break;
    }

    this.targetFrameInterval = tier === 'high' ? 16 : tier === 'medium' ? 33 : 50;
    this.isThreeJsReady.set(true);
    this.animate();
    this.setupResizeObserver();
  }

  private setupLighting(tier: string): void {
    if (!this.scene) return;

    const ambient = new THREE.AmbientLight(0x404040, 0.4);
    this.scene.add(ambient);

    const purpleLight = new THREE.PointLight(0x7c3aed, 1.5, 15);
    purpleLight.position.set(3, 3, 3);
    this.scene.add(purpleLight);

    const cyanLight = new THREE.PointLight(0x06b6d4, 1.2, 15);
    cyanLight.position.set(-3, -2, 4);
    this.scene.add(cyanLight);

    if (tier === 'high') {
      const rimLight = new THREE.DirectionalLight(0xffffff, 0.6);
      rimLight.position.set(5, 5, 5);
      this.scene.add(rimLight);
    }
  }

  private createLattice(tier: string): void {
    if (!this.scene) return;

    const nodeCount = tier === 'high' ? 45 : tier === 'medium' ? 25 : 15;
    const connectionDistance = tier === 'high' ? 2.5 : 3;
    const maxConnections = tier === 'high' ? 4 : 3;

    this.latticeNodes = [];
    const positions: THREE.Vector3[] = [];

    for (let i = 0; i < nodeCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 1.5 + Math.random() * 2;

      const position = new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi) * 0.5
      );

      positions.push(position);
      this.latticeNodes.push({
        position: position.clone(),
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 0.01,
          (Math.random() - 0.5) * 0.01,
          (Math.random() - 0.5) * 0.005
        ),
        connections: [],
        energy: Math.random()
      });
    }

    const nodeGeometry = new THREE.SphereGeometry(0.08, 8, 8);
    const nodeMaterial = new THREE.MeshBasicMaterial({
      color: 0xa855f7,
      transparent: true,
      opacity: 0.9
    });

    this.latticeNodes.forEach((node, i) => {
      const mesh = new THREE.Mesh(nodeGeometry, nodeMaterial.clone());
      mesh.position.copy(node.position);
      (mesh.material as THREE.MeshBasicMaterial).color.setHSL(
        0.75 + Math.random() * 0.1,
        0.8,
        0.5 + node.energy * 0.3
      );
      this.scene!.add(mesh);

      for (let j = i + 1; j < this.latticeNodes.length; j++) {
        if (node.connections.length >= maxConnections) break;

        const other = this.latticeNodes[j];
        const dist = node.position.distanceTo(other.position);

        if (dist < connectionDistance && other.connections.length < maxConnections) {
          node.connections.push(j);
          other.connections.push(i);

          const lineGeometry = new THREE.BufferGeometry().setFromPoints([node.position, other.position]);
          const lineMaterial = new THREE.LineBasicMaterial({
            color: 0x7c3aed,
            transparent: true,
            opacity: 0.3
          });
          const line = new THREE.Line(lineGeometry, lineMaterial);
          this.scene!.add(line);
          this.latticeConnections.push(line);
        }
      }
    });

    if (tier !== 'low') {
      for (let i = 0; i < 3; i++) {
        const light = new THREE.PointLight(0xa855f7, 0.8, 5);
        light.position.set(
          (Math.random() - 0.5) * 4,
          (Math.random() - 0.5) * 4,
          (Math.random() - 0.5) * 2
        );
        this.scene.add(light);
        this.pulseLights.push(light);
      }
    }
  }

  private createCrystals(tier: string): void {
    if (!this.scene) return;

    const crystalCount = tier === 'high' ? 8 : tier === 'medium' ? 5 : 3;
    const geometries = [
      new THREE.OctahedronGeometry(0.4, 0),
      new THREE.TetrahedronGeometry(0.5, 0),
      new THREE.IcosahedronGeometry(0.35, 0)
    ];

    for (let i = 0; i < crystalCount; i++) {
      const geometry = geometries[i % geometries.length];
      const material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color().setHSL(0.7 + Math.random() * 0.15, 0.8, 0.5),
        metalness: 0.1,
        roughness: 0.1,
        transmission: tier === 'high' ? 0.6 : 0,
        thickness: 0.5,
        emissive: new THREE.Color(0x7c3aed),
        emissiveIntensity: 0.2
      });

      const mesh = new THREE.Mesh(geometry, material);
      const angle = (i / crystalCount) * Math.PI * 2;
      const radius = 1.5 + Math.random() * 1;
      const y = (Math.random() - 0.5) * 2;

      mesh.position.set(
        Math.cos(angle) * radius,
        y,
        Math.sin(angle) * radius * 0.5
      );

      mesh.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      );

      this.scene.add(mesh);
      this.crystals.push({
        mesh,
        rotationAxis: new THREE.Vector3(
          Math.random() - 0.5,
          Math.random() - 0.5,
          Math.random() - 0.5
        ).normalize(),
        rotationSpeed: 0.005 + Math.random() * 0.01,
        floatOffset: Math.random() * Math.PI * 2,
        originalY: y
      });
    }

    const particleCount = tier === 'high' ? 60 : 30;
    const particleGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount * 3; i++) {
      positions[i] = (Math.random() - 0.5) * 8;
    }

    particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const particleMaterial = new THREE.PointsMaterial({
      color: 0xc084fc,
      size: 0.04,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending
    });

    const particles = new THREE.Points(particleGeometry, particleMaterial);
    this.scene.add(particles);
  }

  private createFractals(tier: string): void {
    if (!this.scene) return;

    const maxDepth = tier === 'high' ? 4 : tier === 'medium' ? 3 : 2;
    const branchCount = tier === 'high' ? 5 : 3;

    const createBranch = (parentPosition: THREE.Vector3, angle: number, depth: number, scale: number): void => {
      if (depth > maxDepth) return;

      const length = 1.2 * scale;
      const endPosition = new THREE.Vector3(
        parentPosition.x + Math.cos(angle) * length,
        parentPosition.y + Math.sin(angle) * length,
        parentPosition.z + (Math.random() - 0.5) * 0.2 * scale
      );

      const curve = new THREE.QuadraticBezierCurve3(
        parentPosition,
        new THREE.Vector3(
          (parentPosition.x + endPosition.x) / 2 + (Math.random() - 0.5) * 0.3,
          (parentPosition.y + endPosition.y) / 2 + (Math.random() - 0.5) * 0.3,
          (parentPosition.z + endPosition.z) / 2
        ),
        endPosition
      );

      const tubeGeometry = new THREE.TubeGeometry(curve, 8, 0.03 * scale, 6, false);
      const tubeMaterial = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(0.75 - depth * 0.05, 0.9, 0.4 + depth * 0.1),
        emissive: new THREE.Color(0x7c3aed),
        emissiveIntensity: 0.3 - depth * 0.05,
        metalness: 0.7,
        roughness: 0.3
      });

      const tube = new THREE.Mesh(tubeGeometry, tubeMaterial);
      this.scene!.add(tube);
      this.fractalBranches.push({ mesh: tube, depth, angle, scale });

      const subBranches = depth < 2 ? 2 : 2;
      for (let i = 0; i < subBranches; i++) {
        const newAngle = angle + (Math.random() - 0.5) * Math.PI * 0.6;
        createBranch(endPosition, newAngle, depth + 1, scale * 0.7);
      }

      const jointGeometry = new THREE.SphereGeometry(0.06 * scale, 8, 8);
      const jointMaterial = new THREE.MeshBasicMaterial({
        color: 0xf0abfc,
        transparent: true,
        opacity: 0.9
      });
      const joint = new THREE.Mesh(jointGeometry, jointMaterial);
      joint.position.copy(endPosition);
      this.scene!.add(joint);
    };

    for (let i = 0; i < branchCount; i++) {
      const startAngle = (i / branchCount) * Math.PI * 2;
      createBranch(new THREE.Vector3(0, 0, 0), startAngle, 0, 1);
    }

    const centerGlow = new THREE.PointLight(0xa855f7, 2, 10);
    centerGlow.position.set(0, 0, 1);
    this.scene.add(centerGlow);
    this.pulseLights.push(centerGlow);
  }

  private animate(currentTime = 0): void {
    if (!this.loading() || !this.renderer || !this.scene || !this.camera) {
      return;
    }

    const deltaTime = currentTime - this.lastFrameTime;
    if (deltaTime < this.targetFrameInterval) {
      this.animationFrameId = requestAnimationFrame((t) => this.animate(t));
      return;
    }
    this.lastFrameTime = currentTime;

    this.time += 0.016;
    const animationType = this.currentAnimationType();

    switch (animationType) {
      case 'lattice':
        this.animateLattice();
        break;
      case 'crystals':
        this.animateCrystals();
        break;
      case 'fractals':
        this.animateFractals();
        break;
    }

    this.camera.position.x = Math.sin(this.time * 0.2) * 0.3;
    this.camera.position.y = Math.cos(this.time * 0.15) * 0.2;
    this.camera.lookAt(0, 0, 0);

    this.renderer.render(this.scene, this.camera);
    this.animationFrameId = requestAnimationFrame((t) => this.animate(t));
  }

  private animateLattice(): void {
    const time = this.time;
    
    this.latticeNodes.forEach((node, i) => {
      node.position.add(node.velocity);
      
      const dist = node.position.length();
      if (dist > 4) {
        node.velocity.multiplyScalar(-0.5);
      }

      node.energy = 0.5 + Math.sin(time * 2 + i * 0.5) * 0.3;
    });

    this.latticeConnections.forEach((line, i) => {
      const positions = line.geometry.attributes['position'].array as Float32Array;
      
      for (let j = 0; j < this.latticeNodes.length; j++) {
        const node = this.latticeNodes[j];
        positions[j * 3] = node.position.x;
        positions[j * 3 + 1] = node.position.y;
        positions[j * 3 + 2] = node.position.z;
      }
      
      line.geometry.attributes['position'].needsUpdate = true;
      
      const material = line.material as THREE.LineBasicMaterial;
      material.opacity = 0.2 + Math.sin(time * 3 + i * 0.3) * 0.15;
    });

    this.pulseLights.forEach((light, i) => {
      light.intensity = 0.5 + Math.sin(time * 4 + i * 2) * 0.3;
    });
  }

  private animateCrystals(): void {
    const time = this.time;

    this.crystals.forEach((crystal, i) => {
      crystal.mesh.rotateOnAxis(crystal.rotationAxis, crystal.rotationSpeed);
      
      crystal.mesh.position.y = crystal.originalY + Math.sin(time + crystal.floatOffset) * 0.2;
      
      const material = crystal.mesh.material as THREE.MeshPhysicalMaterial;
      const hue = 0.7 + Math.sin(time * 0.5 + i * 0.5) * 0.1;
      material.color.setHSL(hue, 0.8, 0.5);
      material.emissiveIntensity = 0.1 + Math.sin(time * 2 + i) * 0.1;
    });

    this.scene?.rotateY(0.002);
  }

  private animateFractals(): void {
    const time = this.time;

    this.fractalBranches.forEach((branch, i) => {
      const sway = Math.sin(time * 0.8 + branch.depth + i * 0.2) * 0.02;
      branch.mesh.rotation.z = sway;
      
      const material = branch.mesh.material as THREE.MeshStandardMaterial;
      const hue = 0.75 - branch.depth * 0.05 + Math.sin(time * 0.3) * 0.05;
      material.color.setHSL(hue, 0.9, 0.4 + branch.depth * 0.1);
    });

    this.pulseLights.forEach((light) => {
      light.intensity = 1.5 + Math.sin(time * 3) * 0.5;
    });
  }

  private setupResizeObserver(): void {
    if (typeof ResizeObserver === 'undefined') return;

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });

    const canvas = this.canvasRef().nativeElement;
    this.resizeObserver.observe(canvas.parentElement!);
  }

  private handleResize(): void {
    if (!this.renderer || !this.camera) return;

    const size = this.containerSize();
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(size, size);
  }

  private cleanup(): void {
    if (this.minimumDurationTimer) {
      clearTimeout(this.minimumDurationTimer);
      this.minimumDurationTimer = null;
    }

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }

    this.latticeNodes = [];
    this.latticeConnections = [];
    this.crystals = [];
    this.fractalBranches = [];
    this.pulseLights = [];

    this.scene = null;
    this.camera = null;
    this.isThreeJsReady.set(false);
  }
}
