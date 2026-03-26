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

export type LoaderStage = 'validating' | 'syncing' | 'permissions' | 'dashboard' | 'redirecting';

interface ParticleSystem {
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  mesh: THREE.Points;
  velocities: Float32Array;
}

@Component({
  selector: 'app-login-loader-3d',
  template: `
    <div class="loader-3d-container" [attr.data-quality]="qualityTier()">
      <!-- Three.js canvas - only shown when initialized and supported -->
      <canvas #canvas 
              class="loader-3d-canvas" 
              [class.loader-3d-canvas--visible]="isThreeJsReady()"></canvas>
      
      <!-- CSS fallback - always visible while initializing or when Three.js not supported -->
      <div class="loader-css-fallback" 
           [class.loader-css-fallback--fading]="isThreeJsReady()"
           [class.loader-css-fallback--visible]="!isThreeJsReady() || shouldUseCSSFallback()">
        <div class="css-core">
          <div class="css-core__inner"></div>
          <div class="css-core__ring css-core__ring--1"></div>
          <div class="css-core__ring css-core__ring--2"></div>
          <div class="css-core__ring css-core__ring--3"></div>
        </div>
        <div class="css-particles">
          @for (i of cssParticles(); track i) {
            <div class="css-particle" [style."--i"]="i"></div>
          }
        </div>
      </div>
      
      <div class="loader-3d-overlay">
        <div class="loader-3d-glow" [class.loader-3d-glow--pulse]="isPulsing()"></div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LoginLoader3DComponent implements AfterViewInit, OnDestroy {
  private readonly deviceCapability = inject(DeviceCapabilityService);
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  
  readonly stage = input.required<LoaderStage>();
  readonly progress = input.required<number>();
  
  readonly qualityTier = computed(() => this.deviceCapability.currentTier());
  readonly shouldUseCSSFallback = computed(() => this.deviceCapability.shouldUseCSSFallback());
  readonly isPulsing = signal(true);
  readonly cssParticles = signal(Array.from({ length: 12 }, (_, i) => i));
  
  // Track Three.js initialization state
  readonly isThreeJsReady = signal(false);
  readonly isInitializing = signal(true);

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private coreMesh: THREE.Mesh | null = null;
  private orbitMeshes: THREE.Mesh[] = [];
  private particleSystem: ParticleSystem | null = null;
  private connectionLines: THREE.Line[] = [];
  private animationFrameId: number | null = null;
  private bloomPass: unknown = null;
  
  // Animation state
  private time = 0;
  private stageProgress = 0;
  private targetStageProgress = 0;

  constructor() {
    effect(() => {
      const stage = this.stage();
      this.updateStageVisuals(stage);
    });
    
    effect(() => {
      const progress = this.progress();
      this.targetStageProgress = progress / 100;
    });
  }

  ngAfterViewInit(): void {
    // Wait for capability detection, then initialize Three.js if supported
    const checkCapability = () => {
      const caps = this.deviceCapability.getCapabilities();
      if (caps) {
        // Capabilities detected
        this.isInitializing.set(false);
        if (!this.shouldUseCSSFallback()) {
          this.initThreeJS();
        }
      } else {
        // Still detecting, check again in 100ms
        setTimeout(checkCapability, 100);
      }
    };
    checkCapability();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  private initThreeJS(): void {
    const canvas = this.canvasRef().nativeElement;
    const tier = this.qualityTier();
    
    // Scene setup
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000000, 0.02);
    
    // Camera
    this.camera = new THREE.PerspectiveCamera(
      60,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      100
    );
    this.camera.position.z = 5;
    
    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: tier === 'high',
      alpha: true,
      powerPreference: tier === 'high' ? 'high-performance' : 'low-power'
    });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier === 'high' ? 2 : 1));
    this.renderer.setClearColor(0x000000, 0);
    
    // Setup scene elements based on tier
    this.setupLighting(tier);
    this.createCore(tier);
    this.createOrbits(tier);
    this.createParticles(tier);
    
    if (tier === 'high') {
      this.setupPostProcessing();
    }
    
    // Start animation loop
    this.animate();
    
    // Mark Three.js as ready
    this.isThreeJsReady.set(true);
    
    // Handle resize
    window.addEventListener('resize', this.handleResize.bind(this));
  }

  private setupLighting(tier: string): void {
    if (!this.scene) return;
    
    // Ambient light
    const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
    this.scene.add(ambientLight);
    
    // Core glow light
    const coreLight = new THREE.PointLight(0x7c3aed, 2, 10);
    coreLight.position.set(0, 0, 0);
    this.scene.add(coreLight);
    
    // Orbital lights
    const orbitLight1 = new THREE.PointLight(0x3b82f6, 1, 8);
    orbitLight1.position.set(2, 0, 0);
    this.scene.add(orbitLight1);
    
    const orbitLight2 = new THREE.PointLight(0xf59e0b, 1, 8);
    orbitLight2.position.set(-2, 0, 0);
    this.scene.add(orbitLight2);
    
    if (tier === 'high') {
      // Add more dramatic lighting for high tier
      const rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
      rimLight.position.set(5, 5, 5);
      this.scene.add(rimLight);
    }
  }

  private createCore(tier: string): void {
    if (!this.scene) return;
    
    const geometry = new THREE.IcosahedronGeometry(0.8, tier === 'high' ? 2 : tier === 'medium' ? 1 : 0);
    
    let material: THREE.Material;
    
    if (tier === 'high') {
      material = new THREE.MeshPhysicalMaterial({
        color: 0x7c3aed,
        emissive: 0x3b82f6,
        emissiveIntensity: 0.3,
        metalness: 0.8,
        roughness: 0.2,
        transmission: 0.2,
        thickness: 1,
        clearcoat: 1,
        clearcoatRoughness: 0.1
      });
    } else if (tier === 'medium') {
      material = new THREE.MeshStandardMaterial({
        color: 0x7c3aed,
        emissive: 0x3b82f6,
        emissiveIntensity: 0.4,
        metalness: 0.6,
        roughness: 0.4
      });
    } else {
      material = new THREE.MeshBasicMaterial({
        color: 0x7c3aed,
        wireframe: true
      });
    }
    
    this.coreMesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.coreMesh);
    
    // Add wireframe overlay for medium/high tiers
    if (tier !== 'low') {
      const wireframeGeometry = new THREE.IcosahedronGeometry(0.85, 1);
      const wireframeMaterial = new THREE.MeshBasicMaterial({
        color: 0xa855f7,
        wireframe: true,
        transparent: true,
        opacity: 0.3
      });
      const wireframe = new THREE.Mesh(wireframeGeometry, wireframeMaterial);
      this.coreMesh.add(wireframe);
    }
  }

  private createOrbits(tier: string): void {
    if (!this.scene) return;
    
    const orbitCount = tier === 'high' ? 3 : tier === 'medium' ? 2 : 1;
    const orbitRadii = [1.8, 2.5, 3.2];
    const orbitColors = [0x3b82f6, 0xf59e0b, 0x22c55e];
    const orbitSpeeds = [0.5, 0.3, 0.2];
    
    for (let i = 0; i < orbitCount; i++) {
      // Create orbital ring
      const ringGeometry = new THREE.TorusGeometry(orbitRadii[i], 0.02, 8, 64);
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: orbitColors[i],
        transparent: true,
        opacity: 0.3
      });
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      
      // Random rotation for each ring
      ring.rotation.x = Math.random() * Math.PI;
      ring.rotation.y = Math.random() * Math.PI;
      
      this.scene.add(ring);
      this.orbitMeshes.push(ring);
      
      // Create orbital nodes (data packets)
      const nodeCount = tier === 'high' ? 4 : 2;
      for (let j = 0; j < nodeCount; j++) {
        const nodeGeometry = new THREE.SphereGeometry(0.12, 16, 16);
        const nodeMaterial = new THREE.MeshStandardMaterial({
          color: orbitColors[i],
          emissive: orbitColors[i],
          emissiveIntensity: 0.5
        });
        const node = new THREE.Mesh(nodeGeometry, nodeMaterial);
        
        // Position on orbit
        const angle = (j / nodeCount) * Math.PI * 2;
        node.position.x = Math.cos(angle) * orbitRadii[i];
        node.position.y = Math.sin(angle) * orbitRadii[i];
        node.position.z = 0;
        
        // Store orbit data
        (node as unknown as Record<string, unknown>)['userData'] = {
          orbitRadius: orbitRadii[i],
          orbitSpeed: orbitSpeeds[i],
          orbitAngle: angle,
          orbitIndex: i
        };
        
        ring.add(node);
      }
    }
  }

  private createParticles(tier: string): void {
    if (!this.scene || tier === 'low') return;
    
    const particleCount = tier === 'high' ? 200 : 80;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const velocities = new Float32Array(particleCount * 3);
    
    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3;
      const radius = 2 + Math.random() * 3;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;
      
      positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i3 + 2] = radius * Math.cos(phi);
      
      velocities[i3] = (Math.random() - 0.5) * 0.01;
      velocities[i3 + 1] = (Math.random() - 0.5) * 0.01;
      velocities[i3 + 2] = (Math.random() - 0.5) * 0.01;
    }
    
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    
    const material = new THREE.PointsMaterial({
      color: 0xa855f7,
      size: tier === 'high' ? 0.05 : 0.03,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending
    });
    
    const mesh = new THREE.Points(geometry, material);
    this.scene.add(mesh);
    
    this.particleSystem = {
      geometry,
      material,
      mesh,
      velocities
    };
  }

  private setupPostProcessing(): void {
    // For high tier, we would add bloom effect here
    // This requires additional Three.js addons which may not be available
    // We'll simulate it with emissive materials instead
  }

  private animate(): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    
    this.time += 0.016;
    
    // Smooth stage progress
    this.stageProgress += (this.targetStageProgress - this.stageProgress) * 0.1;
    
    // Animate core
    if (this.coreMesh) {
      this.coreMesh.rotation.x += 0.005;
      this.coreMesh.rotation.y += 0.01;
      
      // Pulse effect based on stage
      const pulseScale = 1 + Math.sin(this.time * 3) * 0.05 * this.stageProgress;
      this.coreMesh.scale.setScalar(pulseScale);
    }
    
    // Animate orbits
    this.orbitMeshes.forEach((ring, index) => {
      ring.rotation.x += 0.002 * (index + 1);
      ring.rotation.y += 0.003 * (index + 1);
      
      // Animate nodes
      ring.children.forEach((child) => {
        const node = child as THREE.Mesh;
        const userData = (node as unknown as Record<string, unknown>)['userData'] as {
          orbitRadius: number;
          orbitSpeed: number;
          orbitAngle: number;
        };
        
        if (userData) {
          userData.orbitAngle += userData.orbitSpeed * 0.016;
          node.position.x = Math.cos(userData.orbitAngle) * userData.orbitRadius;
          node.position.y = Math.sin(userData.orbitAngle) * userData.orbitRadius;
        }
      });
    });
    
    // Animate particles
    if (this.particleSystem) {
      const positions = this.particleSystem.geometry.attributes['position'].array as Float32Array;
      
      for (let i = 0; i < positions.length / 3; i++) {
        const i3 = i * 3;
        positions[i3] += this.particleSystem.velocities[i3];
        positions[i3 + 1] += this.particleSystem.velocities[i3 + 1];
        positions[i3 + 2] += this.particleSystem.velocities[i3 + 2];
        
        // Reset particles that go too far
        const dist = Math.sqrt(
          positions[i3] ** 2 + 
          positions[i3 + 1] ** 2 + 
          positions[i3 + 2] ** 2
        );
        
        if (dist > 6) {
          const radius = 2 + Math.random() * 2;
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.random() * Math.PI;
          
          positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
          positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
          positions[i3 + 2] = radius * Math.cos(phi);
        }
      }
      
      this.particleSystem.geometry.attributes['position'].needsUpdate = true;
      this.particleSystem.mesh.rotation.y += 0.001;
    }
    
    // Camera movement based on stage
    if (this.camera) {
      const targetZ = 5 - this.stageProgress * 1.5;
      this.camera.position.z += (targetZ - this.camera.position.z) * 0.05;
      
      // Subtle camera sway
      this.camera.position.x = Math.sin(this.time * 0.5) * 0.2;
      this.camera.position.y = Math.cos(this.time * 0.3) * 0.2;
      this.camera.lookAt(0, 0, 0);
    }
    
    this.renderer.render(this.scene, this.camera);
    
    this.animationFrameId = requestAnimationFrame(() => this.animate());
  }

  private updateStageVisuals(stage: LoaderStage): void {
    // Update visual effects based on current stage
    switch (stage) {
      case 'validating':
        this.isPulsing.set(true);
        break;
      case 'syncing':
        this.isPulsing.set(true);
        break;
      case 'permissions':
        this.isPulsing.set(true);
        this.createConnectionEffect();
        break;
      case 'dashboard':
        this.isPulsing.set(false);
        break;
      case 'redirecting':
        this.triggerWarpEffect();
        break;
    }
  }

  private createConnectionEffect(): void {
    // Visual effect when connecting to services
    if (this.coreMesh) {
      const material = this.coreMesh.material as THREE.MeshStandardMaterial;
      if (material.emissive) {
        material.emissiveIntensity = 0.8;
      }
    }
  }

  private triggerWarpEffect(): void {
    // Speed up animations for warp effect
    if (this.particleSystem) {
      this.particleSystem.material.opacity = 1;
    }
  }

  private handleResize(): void {
    if (!this.renderer || !this.camera) return;
    
    const canvas = this.canvasRef().nativeElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private cleanup(): void {
    window.removeEventListener('resize', this.handleResize.bind(this));
    
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
    
    if (this.renderer) {
      this.renderer.dispose();
    }
    
    if (this.particleSystem) {
      this.particleSystem.geometry.dispose();
      this.particleSystem.material.dispose();
    }
    
    this.orbitMeshes.forEach(mesh => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    
    if (this.coreMesh) {
      this.coreMesh.geometry.dispose();
      (this.coreMesh.material as THREE.Material).dispose();
    }
  }
}
