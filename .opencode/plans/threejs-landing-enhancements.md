# Three.js Landing Page Enhancements Plan
**DomDimaBot v21 - Enhancement Phase**

---

## Overview

This plan covers adding Three.js enhancements to the existing landing page at `dimasite/`. The goal is to create visual depth, interactivity, and premium feel without sacrificing performance.

**Target:** `/home/cdom/saas/dimasite/src/app/features/landing/`
**Three.js Version:** `^0.183.2` (already installed)
**Implementation Status:** Enhancement layer on top of existing landing page

---

## Enhancement Scope

### Phase A: MVP (Week 1) - Foundation & Hero
1. **Enhanced Interactive Hero Orb** - Upgrade existing HeroOrbComponent
2. **Floating Particles Background** - Subtle ambient effect
3. **Device Detection & Performance Tuning** - Adaptive quality

### Phase B: Polish (Week 2) - Interactive Elements
4. **3D Pricing Card Tilt Effect** - Premium feel for pricing section
5. **Live Channel 3D Avatars** - Visual enhancement for live channels

### Phase C: Delight (Future) - Advanced Effects
6. **Feature Section 3D Icons** - Thematic 3D representations
7. **Scroll-Triggered 3D Effects** - Section reveal animations

---

## Phase A: MVP Foundation (Week 1)

### Enhancement 1: Interactive Hero Orb

**File:** `/home/cdom/saas/dimasite/src/app/features/landing/hero-orb.component.ts`

**Current Implementation:**
- Basic 3D sphere with gradient
- Simple rotation animation
- Static appearance

**Enhanced Implementation:**
```typescript
import {
  Component,
  ElementRef,
  inject,
  AfterViewInit,
  OnDestroy,
  signal,
  computed
} from '@angular/core';
import * as THREE from 'three';

export interface EnhancedOrbConfig {
  baseColor: string;
  accentColor: string;
  particleCount: number;
  rotationSpeed: number;
}

@Component({
  selector: 'app-hero-orb',
  standalone: true,
  template: '<canvas #orbCanvas class="hero-orb-canvas"></canvas>',
  styleUrl: './hero-orb.component.css',
  changeDetection: 0
})
export class HeroOrbComponent implements AfterViewInit, OnDestroy {
  private elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  // Config
  readonly config: EnhancedOrbConfig = {
    baseColor: '#8b5cf6',
    accentColor: '#a855f7',
    particleCount: 1500,
    rotationSpeed: 0.005
  };

  // State
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private orbMesh!: THREE.Group;
  private particleMesh!: THREE.Points;
  private ambientLight!: THREE.AmbientLight;
  private pointLight!: THREE.PointLight;
  private animationFrameId!: number;

  // Interaction state
  readonly mousePosition = signal({ x: 0, y: 0 });
  readonly isHovered = signal(false);
  readonly rippleActive = signal(false);
  readonly rippleIntensity = signal(0);

  // Performance
  private isReducedMotion = false;
  private frameCount = 0;
  private lastFpsTime = performance.now();

  ngAfterViewInit(): void {
    this.checkReducedMotion();
    this.initThreeJS();
    this.createOrb();
    this.createParticles();
    this.setupLights();
    this.setupEventListeners();
    this.animate();
  }

  private checkReducedMotion(): void {
    this.isReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private initThreeJS(): void {
    const canvas = this.elementRef.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    const container = this.elementRef.nativeElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      75,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    this.camera.position.z = 5;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: !this.isReducedMotion,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: true
    });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }

  private createOrb(): void {
    // Main sphere with gradient shader
    const geometry = new THREE.SphereGeometry(2, 64, 64);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        baseColor: { value: new THREE.Color(this.config.baseColor) },
        accentColor: { value: new THREE.Color(this.config.accentColor) }
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        uniform float time;
        
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        uniform vec3 baseColor;
        uniform vec3 accentColor;
        uniform float time;
        
        void main() {
          vec3 normal = normalize(vNormal);
          vec3 viewDir = normalize(cameraPosition - vPosition);
          float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 3.0);
          
          vec3 color = mix(baseColor, accentColor, fresnel + sin(time * 0.5) * 0.5 + 0.5);
          gl_FragColor = vec4(color, 0.9 + fresnel * 0.4);
        }
      `,
      transparent: true
    });

    this.orbMesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.orbMesh);
  }

  private createParticles(): void {
    const count = this.isReducedMotion ? 300 : this.config.particleCount;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = 2.5 + Math.random() * 1.5;

      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.sin(phi) * Math.sin(theta);
      const z = radius * Math.cos(phi);

      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      // Mix purple colors
      const colorMix = Math.random();
      colors[i * 3] = 0.545; // R (purple)
      colors[i * 3 + 1] = 0.361 + colorMix * 0.2; // G
      colors[i * 3 + 2] = 0.965 - colorMix * 0.15; // B
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: 0.03,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      sizeAttenuation: true
    });

    this.particleMesh = new THREE.Points(geometry, material);
    this.scene.add(this.particleMesh);
  }

  private setupLights(): void {
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(this.ambientLight);

    this.pointLight = new THREE.PointLight(0x8b5cf6, 1, 10);
    this.pointLight.position.set(3, 3, 3);
    this.scene.add(this.pointLight);
  }

  private setupEventListeners(): void {
    const canvas = this.elementRef.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    const container = this.elementRef.nativeElement;

    // Mouse move for parallax effect
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mousePosition.set({
        x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((e.clientY - rect.top) / rect.height) * 2 + 1
      });
    });

    canvas.addEventListener('mouseenter', () => this.isHovered.set(true));
    canvas.addEventListener('mouseleave', () => this.isHovered.set(false));
    canvas.addEventListener('click', () => this.triggerRipple());

    // Touch support
    canvas.addEventListener('touchmove', (e) => {
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      this.mousePosition.set({
        x: ((touch.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((touch.clientY - rect.top) / rect.height) * 2 + 1
      });
    }, { passive: true });

    // Resize
    window.addEventListener('resize', () => this.onResize());
  }

  private triggerRipple(): void {
    if (this.isReducedMotion) return;
    
    this.rippleActive.set(true);
    this.rippleIntensity.set(1);
    
    // Create ripple particles
    const rippleGeometry = new THREE.SphereGeometry(2.1, 32, 32);
    const rippleMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.3
    });
    const ripple = new THREE.Mesh(rippleGeometry, rippleMaterial);
    this.scene.add(ripple);

    // Animate and remove ripple
    const animateRipple = () => {
      const current = this.rippleIntensity();
      if (current > 0) {
        ripple.scale.multiplyScalar(1.02);
        rippleMaterial.opacity = current;
        this.rippleIntensity.update(v => v * 0.92);
        requestAnimationFrame(animateRipple);
      } else {
        this.scene.remove(ripple);
        rippleGeometry.dispose();
        rippleMaterial.dispose();
        this.rippleActive.set(false);
      }
    };
    animateRipple();
  }

  private animate(): void {
    const time = performance.now() * 0.001;

    // Update shader uniform
    if (this.orbMesh.material instanceof THREE.ShaderMaterial) {
      this.orbMesh.material.uniforms.time.value = time;
    }

    // Orb rotation - faster on hover
    const hoverMultiplier = this.isHovered() ? 2.5 : 1;
    this.orbMesh.rotation.x += this.config.rotationSpeed * hoverMultiplier;
    this.orbMesh.rotation.y += this.config.rotationSpeed * hoverMultiplier * 0.7;

    // Particle rotation
    this.particleMesh.rotation.y += 0.001;

    // Parallax effect based on mouse position
    const mouse = this.mousePosition();
    this.orbMesh.position.x = mouse.x * 0.3;
    this.orbMesh.position.y = mouse.y * 0.3;

    // Render
    this.renderer.render(this.scene, this.camera);

    // FPS calculation
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsTime >= 1000) {
      // Can use this for adaptive quality
      this.frameCount = 0;
      this.lastFpsTime = now;
    }

    this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
  }

  private onResize(): void {
    const container = this.elementRef.nativeElement;
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animationFrameId);
    this.renderer.dispose();
  }
}
```

**Styles (`hero-orb.component.css`):**
```css
:host {
  display: block;
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: auto;
}

.hero-orb-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

@media (prefers-reduced-motion: reduce) {
  .hero-orb-canvas {
    animation: none;
  }
}
```

**Performance:**
- Custom shader for GPU-accelerated rendering
- Adaptive particle count based on device
- Reduced motion support
- FPS monitoring for quality adjustment

---

### Enhancement 2: Floating Particles Background

**File:** `/home/cdom/saas/dimasite/src/app/features/landing/particles-background.component.ts`

```typescript
import {
  Component,
  ElementRef,
  inject,
  AfterViewInit,
  OnDestroy
} from '@angular/core';
import * as THREE from 'three';

@Component({
  selector: 'app-particles-background',
  standalone: true,
  template: '<canvas #particlesCanvas class="particles-canvas"></canvas>',
  styleUrl: './particles-background.component.css',
  changeDetection: 0
})
export class ParticlesBackgroundComponent implements AfterViewInit, OnDestroy {
  private elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  private scene!: THREE.Scene;
  private camera!: THREE.OrthographicCamera;
  private renderer!: THREE.WebGLRenderer;
  private particles!: THREE.Points;
  private animationFrameId!: number;
  private scrollY = 0;

  // Configuration
  readonly config = {
    particleCount: 400,
    size: 0.02,
    colors: ['#8b5cf6', '#a855f7', '#c084fc', '#c4b5fd'],
    speed: 0.3
  };

  ngAfterViewInit(): void {
    this.initThreeJS();
    this.createParticles();
    this.animate();
    this.setupScrollListener();
  }

  private initThreeJS(): void {
    const canvas = this.elementRef.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    const container = this.elementRef.nativeElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(
      -1, 1, 1, -1, -1, 1
    );
    this.camera.position.z = 10;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false // Performance
    });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  }

  private createParticles(): void {
    const count = window.innerWidth < 768 ? 200 : this.config.particleCount;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const speeds = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 20;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 20;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 10;

      const color = this.config.colors[Math.floor(Math.random() * this.config.colors.length)];
      const rgb = new THREE.Color(color);
      colors[i * 3] = rgb.r;
      colors[i * 3 + 1] = rgb.g;
      colors[i * 3 + 2] = rgb.b;

      sizes[i] = Math.random() * 0.5 + 0.5;
      speeds[i * 3] = (Math.random() - 0.5) * 0.002;
      speeds[i * 3 + 1] = (Math.random() - 0.5) * 0.002;
      speeds[i * 3 + 2] = (Math.random() - 0.5) * 0.002;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('speed', new THREE.BufferAttribute(speeds, 3));

    const material = new THREE.PointsMaterial({
      size: this.config.size,
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      sizeAttenuation: true,
      blending: THREE.AdditiveBlending
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);
  }

  private animate(): void {
    const positions = this.particles.geometry.attributes.position.array as Float32Array;
    const speeds = this.particles.geometry.attributes.speed.array as Float32Array;

    for (let i = 0; i < positions.length / 3; i++) {
      positions[i * 3] += speeds[i * 3];
      positions[i * 3 + 1] += speeds[i * 3 + 1];
      positions[i * 3 + 2] += speeds[i * 3 + 2];
    }

    this.particles.geometry.attributes.position.needsUpdate = true;

    // Scroll-based parallax
    const parallaxOffset = this.scrollY * 0.01;
    this.particles.position.y = parallaxOffset;

    this.renderer.render(this.scene, this.camera);
    this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
  }

  private setupScrollListener(): void {
    window.addEventListener('scroll', () => {
      this.scrollY = window.scrollY || window.pageYOffset;
    }, { passive: true });

    window.addEventListener('resize', () => this.onResize());
  }

  private onResize(): void {
    const container = this.elementRef.nativeElement;
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animationFrameId);
    this.renderer.dispose();
    window.removeEventListener('scroll', () => {});
    window.removeEventListener('resize', () => this.onResize());
  }
}
```

**Styles (`particles-background.component.css`):**
```css
:host {
  display: block;
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}

.particles-canvas {
  width: 100%;
  height: 100%;
  display: block;
}

@media (prefers-reduced-motion: reduce) {
  :host {
    display: none;
  }
}
```

**Integration in `landing-page.component.html`:**
```html
<div class="landing-shell">
  <app-particles-background></app-particles-background>
  <div class="parallax-layer" data-depth="0.03"><div class="aurora-blob blob-1"></div></div>
  <div class="parallax-layer" data-depth="0.06"><div class="aurora-blob blob-2"></div></div>
  <div class="parallax-layer" data-depth="0.08"><div class="aurora-blob blob-3"></div></div>
  <!-- ... rest of landing page ... -->
</div>
```

---

### Enhancement 3: Device Detection & Performance Tuning

**File:** `/home/cdom/saas/dimasite/src/app/core/services/device-capabilities.service.ts`

```typescript
import { Injectable, signal } from '@angular/core';

export interface DeviceCapabilities {
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  isLowEnd: boolean;
  supportsWebGL2: boolean;
  supportsHDR: boolean;
  pixelRatio: number;
  maxTextureSize: number;
  prefersReducedMotion: boolean;
  preferredColorScheme: 'light' | 'dark' | 'auto';
}

@Injectable({
  providedIn: 'root'
})
export class DeviceCapabilitiesService {
  readonly capabilities = signal<DeviceCapabilities>({
    isMobile: false,
    isTablet: false,
    isDesktop: false,
    isLowEnd: false,
    supportsWebGL2: false,
    supportsHDR: false,
    pixelRatio: 1,
    maxTextureSize: 0,
    prefersReducedMotion: false,
    preferredColorScheme: 'auto'
  });

  constructor() {
    this.detectCapabilities();
  }

  private detectCapabilities(): void {
    // Device type
    const width = window.innerWidth;
    this.capabilities.update(cap => ({
      ...cap,
      isMobile: width < 768,
      isTablet: width >= 768 && width < 1024,
      isDesktop: width >= 1024
    }));

    // Reduced motion
    this.capabilities.update(cap => ({
      ...cap,
      prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches
    }));

    // Color scheme
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    this.capabilities.update(cap => ({
      ...cap,
      preferredColorScheme: dark ? 'dark' : light ? 'light' : 'auto'
    }));

    // WebGL capabilities
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const maxTexture = debugInfo.MAX_TEXTURE_SIZE;
        this.capabilities.update(cap => ({
          ...cap,
          supportsWebGL2: canvas.getContext('webgl2') !== null,
          supportsHDR: !!gl.getExtension('EXT_color_buffer_float'),
          pixelRatio: Math.min(window.devicePixelRatio, 2),
          maxTextureSize: maxTexture || 4096,
          isLowEnd: maxTexture < 2048 || (navigator as any).deviceMemory < 4
        }));
      }
    }
  }

  // Quality presets for Three.js
  getRenderQuality(): {
    pixelRatio: number;
    antialias: boolean;
    shadowMap: boolean;
    particleMultiplier: number;
  } {
    const cap = this.capabilities();
    
    if (cap.prefersReducedMotion) {
      return {
        pixelRatio: 1,
        antialias: false,
        shadowMap: false,
        particleMultiplier: 0.25
      };
    }

    if (cap.isMobile) {
      return {
        pixelRatio: Math.min(cap.pixelRatio, 1.5),
        antialias: false,
        shadowMap: false,
        particleMultiplier: 0.5
      };
    }

    if (cap.isLowEnd) {
      return {
        pixelRatio: 1,
        antialias: true,
        shadowMap: false,
        particleMultiplier: 0.6
      };
    }

    // Desktop/tablet
    return {
      pixelRatio: Math.min(cap.pixelRatio, 2),
      antialias: true,
      shadowMap: true,
      particleMultiplier: 1
    };
  }
}
```

---

## Phase B: Polish Elements (Week 2)

### Enhancement 4: 3D Pricing Card Tilt Effect

**File:** `/home/cdom/saas/dimasite/src/app/features/landing/pricing-card-tilt.directive.ts`

```typescript
import {
  Directive,
  ElementRef,
  Input,
  AfterViewInit,
  OnDestroy
} from '@angular/core';
import * as THREE from 'three';

@Directive({
  selector: '[pricingCardTilt]',
  standalone: true
})
export class PricingCardTiltDirective implements AfterViewInit, OnDestroy {
  private elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  @Input() pricingCardTilt!: 'free' | 'premium' | 'pro';

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private cardMesh!: THREE.Mesh;
  private animationFrameId!: number;

  private mouseX = 0;
  private mouseY = 0;
  private targetRotationX = 0;
  private targetRotationY = 0;

  // Tier-specific colors
  private readonly tierColors = {
    free: { primary: '#6b7280', accent: '#9ca3af' },
    premium: { primary: '#8b5cf6', accent: '#a855f7' },
    pro: { primary: '#a855f7', accent: '#c084fc' }
  };

  ngAfterViewInit(): void {
    this.initThreeJS();
    this.createCard();
    this.setupEvents();
    this.animate();
  }

  private initThreeJS(): void {
    const element = this.elementRef.nativeElement;
    const rect = element.getBoundingClientRect();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, rect.width / rect.height, 0.1, 1000);
    this.camera.position.z = 5;

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true
    });
    this.renderer.setSize(rect.width, rect.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const canvas = this.renderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.pointerEvents = 'none';
    canvas.style.borderRadius = 'inherit';
    element.style.position = 'relative';
    element.appendChild(canvas);
  }

  private createCard(): void {
    const colors = this.tierColors[this.pricingCardTilt];
    
    // Create thin 3D card representation
    const geometry = new THREE.BoxGeometry(3, 4, 0.05);
    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(colors.primary),
      metalness: 0.1,
      roughness: 0.5,
      clearcoat: 0.5,
      clearcoatRoughness: 0.1,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide
    });

    this.cardMesh = new THREE.Mesh(geometry, material);
    this.cardMesh.rotation.x = 0.15;
    this.scene.add(this.cardMesh);

    // Add edge highlight
    const edges = new THREE.EdgesGeometry(geometry);
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(colors.accent),
      transparent: true,
      opacity: 0.5
    });
    const edgeLines = new THREE.LineSegments(edges, edgeMaterial);
    this.cardMesh.add(edgeLines);
  }

  private setupEvents(): void {
    const element = this.elementRef.nativeElement;

    element.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = element.getBoundingClientRect();
      this.mouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouseY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    });

    element.addEventListener('mouseleave', () => {
      this.mouseX = 0;
      this.mouseY = 0;
    });

    window.addEventListener('resize', () => this.onResize());
  }

  private animate(): void {
    // Smooth tilt
    this.targetRotationX = this.mouseY * 0.15;
    this.targetRotationY = this.mouseX * 0.15;

    this.cardMesh.rotation.x += (this.targetRotationX - this.cardMesh.rotation.x) * 0.1;
    this.cardMesh.rotation.y += (this.targetRotationY - this.cardMesh.rotation.y) * 0.1;

    this.renderer.render(this.scene, this.camera);
    this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
  }

  private onResize(): void {
    const element = this.elementRef.nativeElement;
    const rect = element.getBoundingClientRect();
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width, rect.height);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animationFrameId);
    this.renderer.dispose();
  }
}
```

**Integration in `landing-page.component.html`:**
```html
<article
  class="glass-card card-hover metric-card text-center"
  pricingCardTilt="premium"
>
  <!-- ... card content ... -->
</article>
```

---

### Enhancement 5: Live Channel 3D Avatars

**File:** `/home/cdom/saas/dimasite/src/app/features/landing/live-channel-3d-avatar.component.ts`

```typescript
import {
  Component,
  Input,
  inject,
  AfterViewInit,
  OnDestroy,
  signal
} from '@angular/core';
import * as THREE from 'three';

@Component({
  selector: 'app-live-channel-3d-avatar',
  standalone: true,
  template: '<canvas #avatarCanvas class="avatar-canvas"></canvas>',
  styleUrl: './live-channel-3d-avatar.component.css',
  changeDetection: 0
})
export class LiveChannel3DAvatarComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) channel!: string;
  @Input() imageUrl?: string;
  @Input() viewers!: number;
  @Input() platforms: Array<'twitch' | 'kick'> = [];

  private elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private avatarMesh!: THREE.Group;
  private animationFrameId!: number;
  private isVisible = signal(false);

  ngAfterViewInit(): void {
    // Only initialize when visible (IntersectionObserver)
    const observer = new IntersectionObserver(([entry]) => {
      this.isVisible.set(entry.isIntersecting);
      if (entry.isIntersecting) {
        this.initThreeJS();
        this.createAvatar();
        this.animate();
      }
    }, { threshold: 0.1 });

    observer.observe(this.elementRef.nativeElement);
  }

  private initThreeJS(): void {
    const canvas = this.elementRef.nativeElement.querySelector('canvas') as HTMLCanvasElement;
    const container = this.elementRef.nativeElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.z = 3;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true
    });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  }

  private createAvatar(): void {
    this.avatarMesh = new THREE.Group();

    // Base sphere (avatar head)
    const headGeometry = new THREE.SphereGeometry(0.5, 16, 16);
    const headMaterial = new THREE.MeshStandardMaterial({
      color: 0x8b5cf6,
      metalness: 0.3,
      roughness: 0.4
    });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 0.3;
    this.avatarMesh.add(head);

    // Platform badges
    this.platforms.forEach(platform => {
      const badge = this.createPlatformBadge(platform);
      badge.position.x = (this.platforms.indexOf(platform) - 1) * 0.4;
      this.avatarMesh.add(badge);
    });

    this.scene.add(this.avatarMesh);
  }

  private createPlatformBadge(platform: 'twitch' | 'kick'): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(0.15, 0.15, 0.05);
    const color = platform === 'twitch' ? 0x9146ff : 0x00f59f;
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.3
    });
    return new THREE.Mesh(geometry, material);
  }

  private animate(): void {
    // Floating animation
    const time = performance.now() * 0.001;
    
    this.avatarMesh.position.y = Math.sin(time) * 0.1;
    this.avatarMesh.rotation.y = Math.sin(time * 0.7) * 0.2;

    this.renderer.render(this.scene, this.camera);
    this.animationFrameId = requestAnimationFrame(this.animate.bind(this));
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animationFrameId);
    this.renderer.dispose();
  }
}
```

**Integration in `landing-page.component.html`:**
```html
<article class="live-now-card">
  <img
    class="live-now-card__avatar 2d"
    [src]="channel.profileImageUrl || defaultAvatar"
    [alt]="channel.channel + ' avatar'"
    loading="lazy"
  />
  <app-live-channel-3d-avatar
    class="live-now-card__avatar 3d"
    [channel]="channel.channel"
    [viewers]="channel.viewers"
    [platforms]="channel.botPlatforms"
  ></app-live-channel-3d-avatar>
  <p class="live-now-card__name">{{ channel.channel }}</p>
  <p class="live-now-card__viewers">{{ channel.viewers }} {{ t('landing.liveNow.viewers') }}</p>
  <!-- ... rest of card ... -->
</article>
```

**Styles:** Hide 2D avatar when 3D is active
```css
.live-now-card__avatar.2d {
  /* Keep for fallback */
}

@media (prefers-reduced-motion: no-preference) {
  .live-now-card__avatar.3d {
    /* 3D avatar visible */
  }
}

@media (prefers-reduced-motion: reduce) {
  .live-now-card__avatar.3d {
    display: none;
  }
}
```

---

## Phase C: Future Enhancements

### Enhancement 6: Feature Section 3D Icons

**Concept:**
- **AI Moderation**: Floating brain hemisphere with neural network lines
- **Automation**: Rotating gear cube with particle emission
- **Analytics**: Concentric data rings that pulse
- **Voice**: Waveform visualization using TubeGeometry

**Implementation:** Create `feature-3d-icon.component.ts` with dynamic icon type input.

---

### Enhancement 7: Scroll-Triggered 3D Effects

**Concept:**
- **Hero reveal**: Orb expands from scale 0 to 1, particles burst outward
- **Features enter**: 3D icons float up from below
- **Pricing reveal**: Cards fly in 3D perspective
- **CTA section**: 3D button press effect (depress then bounce back)

**Implementation:** Combine with `IntersectionObserver` and GSAP for sequencing.

---

## Performance Strategy

### Adaptive Quality System

```typescript
// In DeviceCapabilitiesService
getAdaptiveQuality(): {
  maxParticles: number;
  shaderComplexity: 'low' | 'medium' | 'high';
  enableShadows: boolean;
  enablePostProcessing: boolean;
} {
  const cap = this.capabilities();
  
  if (cap.isLowEnd) {
    return {
      maxParticles: 100,
      shaderComplexity: 'low',
      enableShadows: false,
      enablePostProcessing: false
    };
  }

  if (cap.isMobile) {
    return {
      maxParticles: 200,
      shaderComplexity: 'medium',
      enableShadows: false,
      enablePostProcessing: false
    };
  }

  return {
    maxParticles: 500,
    shaderComplexity: 'high',
    enableShadows: true,
    enablePostProcessing: true
  };
}
```

### Memory Management

```typescript
// In each component
ngOnDestroy(): void {
  // Always dispose Three.js resources
  this.geometry?.dispose();
  this.material?.dispose();
  this.texture?.dispose();
  this.renderer?.dispose();
  
  // Cancel animations
  cancelAnimationFrame(this.animationFrameId);
}
```

### Lazy Initialization

```typescript
// Only initialize Three.js when element enters viewport
ngAfterViewInit(): void {
  const observer = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      this.initThreeJS();
      observer.disconnect();
    }
  }, { threshold: 0.1 });

  observer.observe(this.elementRef.nativeElement);
}
```

---

## Accessibility Considerations

### Reduced Motion Support

```css
@media (prefers-reduced-motion: reduce) {
  :host {
    /* Disable 3D effects */
  }
  
  .hero-orb-canvas,
  .particles-canvas,
  .avatar-canvas {
    /* Fallback to CSS animations */
    display: none;
  }
}
```

### Fallback Content

```html
<app-hero-orb>
  <!-- 3D canvas -->
  <ng-template #fallback>
    <!-- CSS-only fallback for users without WebGL -->
    <div class="hero-orb-fallback">
      <!-- CSS sphere animation -->
    </div>
  </ng-template>
</app-hero-orb>
```

```typescript
// In component
ngAfterViewInit(): void {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  
  if (!gl) {
    // Show fallback
    this.showFallback = true;
    return;
  }
  
  // Initialize Three.js
  this.initThreeJS();
}
```

---

## Bundle Size Optimization

### Selective Imports

```typescript
// Instead of:
import * as THREE from 'three';

// Import only needed modules:
import { 
  Scene, 
  PerspectiveCamera, 
  WebGLRenderer,
  SphereGeometry,
  ShaderMaterial,
  PointsMaterial,
  AmbientLight,
  PointLight
} from 'three';
```

### Tree-Shaking with Vite/Angular

```typescript
// In angular.json
"architect": {
  "build": {
    "options": {
      "buildOptimizer": true,
      "optimization": true,
      "vendorChunk": true
    }
  }
}
```

---

## Implementation Order

### Week 1 - Foundation

1. **Day 1-2**: DeviceCapabilitiesService
   - Create service
   - Test detection logic
   - Integrate with existing components

2. **Day 3-4**: Enhanced Hero Orb
   - Rewrite HeroOrbComponent with shader
   - Add mouse/touch interaction
   - Implement ripple effect

3. **Day 5-7**: Particles Background
   - Create ParticlesBackgroundComponent
   - Integrate into landing page
   - Optimize for mobile

### Week 2 - Polish

4. **Day 1-3**: Pricing Card Tilt
   - Create directive
   - Add to all pricing cards
   - Test smooth animation

5. **Day 4-6**: Live Channel Avatars
   - Create avatar component
   - Integrate into live channel cards
   - Add fallback for non-WebGL

6. **Day 7**: Testing & Optimization
   - Test on all devices
   - Profile performance
   - Adjust quality settings

---

## Testing Checklist

Before moving to Phase C or other pages, verify:

✅ Three.js initializes without WebGL errors
✅ Fallback displays for non-WebGL browsers
✅ Reduced motion respected (no 3D when enabled)
✅ Mobile performance acceptable (>30fps)
✅ Desktop performance excellent (>60fps)
✅ Memory doesn't grow unbounded (no leaks)
✅ 3D scenes dispose properly on destroy
✅ Mouse/touch interactions work smoothly
✅ Scroll performance not degraded
✅ Text remains readable above 3D effects
✅ Contrast meets WCAG AA with 3D overlays
✅ 3D elements respond to theme changes
✅ All animations respect prefers-reduced-motion

---

## Performance Benchmarks

### Target Metrics

| Metric | Mobile (375px) | Tablet (768px) | Desktop (1920px) |
|--------|------------------|------------------|-------------------|
| Initial Load | <2s | <1.5s | <1s |
| FPS (idle) | >30fps | >45fps | >60fps |
| FPS (animation) | >25fps | >45fps | >60fps |
| Memory | <50MB | <80MB | <120MB |
| Bundle Size | <30KB | <50KB | <70KB |

### Profiling Commands

```bash
# Measure initial load
npm run build -- --stats
npm run preview

# Profile memory
Chrome DevTools -> Performance tab
Monitor: JS heap size, GPU memory

# Profile FPS
Chrome DevTools -> Rendering tab
Monitor: FPS, Frame time, Layout thrashing
```

---

## Files to Create

**Phase A - Foundation:**
- `/home/cdom/saas/dimasite/src/app/core/services/device-capabilities.service.ts`
- `/home/cdom/saas/dimasite/src/app/features/landing/hero-orb.component.ts` (replace)
- `/home/cdom/saas/dimasite/src/app/features/landing/hero-orb.component.css` (update)
- `/home/cdom/saas/dimasite/src/app/features/landing/particles-background.component.ts`
- `/home/cdom/saas/dimasite/src/app/features/landing/particles-background.component.css`

**Phase B - Polish:**
- `/home/cdom/saas/dimasite/src/app/features/landing/pricing-card-tilt.directive.ts`
- `/home/cdom/saas/dimasite/src/app/features/landing/live-channel-3d-avatar.component.ts`
- `/home/cdom/saas/dimasite/src/app/features/landing/live-channel-3d-avatar.component.css`

**Phase C - Future (Optional):**
- `/home/cdom/saas/dimasite/src/app/features/landing/feature-3d-icon.component.ts`
- `/home/cdom/saas/dimasite/src/app/features/landing/feature-3d-icon.component.css`

**Updates:**
- `/home/cdom/saas/dimasite/src/app/features/landing/landing-page.component.html` (add components)
- `/home/cdom/saas/dimasite/src/app/features/landing/landing-page.component.css` (3D styles)

**Total: 8 files to create, 2 files to update**

---

## Technical Notes

### WebGL2 Fallback

```typescript
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl2');

if (!gl) {
  // Fall back to WebGL1
  const gl1 = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  // Use compatible shaders
}
```

### Cross-Browser Compatibility

**Supported Browsers:**
- Chrome 56+ (WebGL2)
- Firefox 51+ (WebGL2)
- Safari 15+ (WebGL2)
- Edge 79+ (WebGL2)

**Fallback Browsers:**
- Older Safari (WebGL1)
- IE11 (no WebGL - show CSS fallback)

---

## Questions for Implementation

1. **Hero orb:** Keep existing purple gradient colors or update to new palette?
2. **Particles:** Use purple-only palette or mix with teal/blue for depth?
3. **Performance:** What's minimum acceptable FPS on mobile? (25fps or 30fps?)
4. **Bundle size:** What's max acceptable size for Three.js additions? (50KB or 100KB?)
5. **Fallback:** Should we show CSS-only version for users with <2GB RAM?
6. **Testing:** Should we test on actual devices or rely on Chrome DevTools device emulation?

---

## Next Steps After Three.js Enhancements

Once Three.js MVP (Phase A) is complete and tested, next implementation plan should cover:

1. **Login Page** - Handle Twitch OAuth callback
2. **Logout Page** - Clear session
3. **Authenticated Layout** - Navbar, sidebar, theme/language toggles
4. **Dashboard** - ECharts integration, live analytics

---

## Success Criteria

✅ Hero orb is interactive (mouse/touch)
✅ Particles background adds depth without distraction
✅ Device detection works correctly across devices
✅ Performance meets benchmarks on all screen sizes
✅ Reduced motion users see fallback (no 3D)
✅ WebGL2 users get enhanced effects, WebGL1 get compatible version
✅ Memory usage stays within limits (no leaks)
✅ Bundle size impact is acceptable (<50KB)
✅ 3D elements integrate seamlessly with existing design
✅ Animations are smooth and don't cause jank
✅ Accessibility is maintained (WCAG AA, keyboard navigation)

---

Good luck with the Three.js enhancements! 🎨✨
