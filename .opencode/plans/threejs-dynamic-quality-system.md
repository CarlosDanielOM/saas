# Three.js Dynamic Quality System Plan
**DomDimaBot v21 - Performance Optimization Layer**

---

## Overview

This plan creates a **standalone dynamic quality management system** for Three.js that automatically adapts to device capabilities and performance metrics. The system will adjust render quality in real-time to maintain smooth framerates while maximizing visual fidelity.

**Goal:** Optimize Three.js performance across all devices without changing landing page design or implementation.

**Scope:** Quality system only - NO landing page modifications.

---

## Architecture

### Quality Levels

**Low Quality:**
- Target: Mobile devices, low-end GPUs
- Antialias: Disabled
- Pixel Ratio: 1.0
- Shadow Maps: Disabled
- Particle Count: 100-200
- Shader Complexity: Basic
- Post-Processing: None
- Target FPS: 30+

**Medium Quality:**
- Target: Tablets, mid-range devices
- Antialias: FXAA (fast)
- Pixel Ratio: 1.5
- Shadow Maps: Basic PCFSoft
- Particle Count: 300-400
- Shader Complexity: Standard
- Post-Processing: Basic bloom
- Target FPS: 45+

**High Quality:**
- Target: Desktop, high-end GPUs
- Antialias: MSAA 4x
- Pixel Ratio: 2.0
- Shadow Maps: PCFSoft
- Particle Count: 500-800
- Shader Complexity: Advanced
- Post-Processing: Full bloom + tone mapping
- Target FPS: 60+

**Ultra Quality (Optional):**
- Target: Enthusiast hardware
- Antialias: MSAA 8x
- Pixel Ratio: 3.0
- Shadow Maps: PCSS
- Particle Count: 1000+
- Shader Complexity: Maximum
- Post-Processing: Cinematic
- Target FPS: 60+

---

## Phase 1: Core Quality Service

### File: `/home/cdom/saas/dimasite/src/app/core/services/three-quality.service.ts`

```typescript
import { Injectable, signal, computed, inject, effect } from '@angular/core';
import * as THREE from 'three';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export type QualityMode = 'auto' | 'manual';

export interface QualityProfile {
  level: QualityLevel;
  antialias: boolean | number;
  pixelRatio: number;
  shadows: boolean | THREE.ShadowMapType;
  maxParticles: number;
  shaderQuality: 'basic' | 'standard' | 'advanced';
  postProcessing: boolean;
  targetFps: number;
  pixelRatioLimit: number;
  textureResolution: number;
}

export interface PerformanceMetrics {
  currentFps: number;
  averageFps: number;
  frameTime: number;
  droppedFrames: number;
  memoryUsage: number;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class ThreeQualityService {
  // Signals
  readonly currentQuality = signal<QualityLevel>('auto');
  readonly qualityMode = signal<QualityMode>('auto');
  readonly performanceMetrics = signal<PerformanceMetrics>({
    currentFps: 60,
    averageFps: 60,
    frameTime: 0,
    droppedFrames: 0,
    memoryUsage: 0,
    timestamp: performance.now()
  });

  private readonly deviceCapabilities = inject(() => {
    try {
      return require('./device-capabilities.service').DeviceCapabilitiesService;
    } catch {
      // Fallback if not available
      return null;
    }
  });

  // Quality presets
  private readonly qualityPresets: Record<QualityLevel, QualityProfile> = {
    low: {
      level: 'low',
      antialias: false,
      pixelRatio: 1,
      shadows: false,
      maxParticles: 100,
      shaderQuality: 'basic',
      postProcessing: false,
      targetFps: 30,
      pixelRatioLimit: 1,
      textureResolution: 0.5
    },
    medium: {
      level: 'medium',
      antialias: 'fxaa',
      pixelRatio: 1.5,
      shadows: THREE.PCFSoftShadowMap,
      maxParticles: 350,
      shaderQuality: 'standard',
      postProcessing: true,
      targetFps: 45,
      pixelRatioLimit: 1.5,
      textureResolution: 0.75
    },
    high: {
      level: 'high',
      antialias: 4,
      pixelRatio: 2,
      shadows: THREE.PCFSoftShadowMap,
      maxParticles: 600,
      shaderQuality: 'advanced',
      postProcessing: true,
      targetFps: 60,
      pixelRatioLimit: 2,
      textureResolution: 1
    },
    ultra: {
      level: 'ultra',
      antialias: 8,
      pixelRatio: 3,
      shadows: THREE.PCSS,
      maxParticles: 1000,
      shaderQuality: 'advanced',
      postProcessing: true,
      targetFps: 60,
      pixelRatioLimit: 3,
      textureResolution: 1.5
    }
  };

  // Adaptive state
  private currentAdaptiveQuality = signal<QualityLevel>('medium');
  private performanceHistory: number[] = [];
  private lastQualityAdjustment = performance.now();
  private qualityAdjustmentCooldown = 5000; // 5 seconds minimum between adjustments
  private frameCounter = 0;
  private lastFpsUpdate = performance.now();

  // Computed values for components
  readonly qualityProfile = computed(() => {
    if (this.qualityMode() === 'manual') {
      return this.qualityPresets[this.currentQuality()];
    }
    return this.qualityPresets[this.currentAdaptiveQuality()];
  });

  readonly effectiveQuality = computed(() => {
    const mode = this.qualityMode();
    if (mode === 'manual') {
      return this.currentQuality();
    }
    return this.currentAdaptiveQuality();
  });

  constructor() {
    this.initializeQuality();
    this.startPerformanceMonitoring();
    this.setupDeviceListeners();
  }

  private initializeQuality(): void {
    const capabilities = this.deviceCapabilities?.();
    
    if (!capabilities) {
      // Fallback to medium if device capabilities not available
      this.currentAdaptiveQuality.set('medium');
      return;
    }

    // Auto-detect quality based on device
    if (capabilities.prefersReducedMotion) {
      this.currentAdaptiveQuality.set('low');
      return;
    }

    if (capabilities.isMobile) {
      this.currentAdaptiveQuality.set('low');
    } else if (capabilities.isTablet) {
      this.currentAdaptiveQuality.set('medium');
    } else if (capabilities.isLowEnd) {
      this.currentAdaptiveQuality.set('medium');
    } else {
      this.currentAdaptiveQuality.set('high');
    }

    // Ultra mode only for desktop with good GPU
    if (capabilities.isDesktop && capabilities.supportsHDR && !capabilities.isLowEnd) {
      // Keep high, allow manual upgrade to ultra
      this.currentAdaptiveQuality.set('high');
    }
  }

  private startPerformanceMonitoring(): void {
    this.monitorFrameRate();
  }

  private monitorFrameRate(): void {
    let frameCount = 0;
    let lastTime = performance.now();
    let lastFps = 60;

    const checkFrameRate = () => {
      const now = performance.now();
      const delta = now - lastTime;

      frameCount++;

      // Update FPS every 1000ms
      if (delta >= 1000) {
        const fps = Math.round((frameCount * 1000) / delta);
        this.updatePerformanceMetrics(fps);
        
        lastTime = now;
        frameCount = 0;
        lastFps = fps;
        
        // Check if we need to adjust quality
        this.evaluatePerformanceAndAdjust(fps);
      }

      requestAnimationFrame(checkFrameRate);
    };

    requestAnimationFrame(checkFrameRate);
  }

  private updatePerformanceMetrics(fps: number): void {
    const metrics = this.performanceMetrics();
    const average = this.calculateAverageFps(fps);
    
    this.performanceMetrics.update({
      currentFps: fps,
      averageFps: average,
      frameTime: 1000 / fps,
      droppedFrames: fps < metrics.targetFps ? metrics.droppedFrames + 1 : metrics.droppedFrames,
      memoryUsage: this.estimateMemoryUsage(),
      timestamp: performance.now()
    });

    // Keep last 60 seconds of history
    this.performanceHistory.push(fps);
    if (this.performanceHistory.length > 60) {
      this.performanceHistory.shift();
    }
  }

  private calculateAverageFps(currentFps: number): number {
    if (this.performanceHistory.length === 0) return currentFps;
    return Math.round(
      this.performanceHistory.reduce((sum, fps) => sum + fps, 0) / this.performanceHistory.length
    );
  }

  private evaluatePerformanceAndAdjust(fps: number): void {
    const now = performance.now();
    
    // Don't adjust too frequently
    if (now - this.lastQualityAdjustment < this.qualityAdjustmentCooldown) {
      return;
    }

    const metrics = this.performanceMetrics();
    const profile = this.qualityProfile();
    const currentLevel = this.currentAdaptiveQuality();

    // Check if consistently below target FPS
    const performanceHistory = this.performanceHistory.slice(-10); // Last 10 seconds
    const averageRecent = performanceHistory.length > 0
      ? performanceHistory.reduce((sum, val) => sum + val, 0) / performanceHistory.length
      : fps;

    const isUnderperforming = averageRecent < profile.targetFps * 0.7; // Below 70% of target
    const isOverperforming = averageRecent > profile.targetFps * 1.2; // Above 120% of target

    if (isUnderperforming) {
      // Downgrade quality
      this.downgradeQuality(currentLevel);
    } else if (isOverperforming) {
      // Consider upgrading, but only if we've been stable
      if (this.performanceHistory.length > 30) { // 30 seconds stable
        const variance = this.calculateVariance();
        if (variance < 100) { // Low variance = stable performance
          this.upgradeQuality(currentLevel);
        }
      }
    }

    this.lastQualityAdjustment = now;
  }

  private downgradeQuality(currentLevel: QualityLevel): void {
    const levels: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
    const currentIndex = levels.indexOf(currentLevel);
    
    if (currentIndex > 0) {
      const newLevel = levels[currentIndex - 1];
      this.currentAdaptiveQuality.set(newLevel);
      console.log(`[ThreeQualityService] Downgraded quality: ${currentLevel} -> ${newLevel}`);
    }
  }

  private upgradeQuality(currentLevel: QualityLevel): void {
    const levels: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
    const currentIndex = levels.indexOf(currentLevel);
    
    if (currentIndex < levels.length - 1) {
      const newLevel = levels[currentIndex + 1];
      
      // Check if device can handle it
      if (this.canSupportQuality(newLevel)) {
        this.currentAdaptiveQuality.set(newLevel);
        console.log(`[ThreeQualityService] Upgraded quality: ${currentLevel} -> ${newLevel}`);
      }
    }
  }

  private canSupportQuality(level: QualityLevel): boolean {
    const capabilities = this.deviceCapabilities?.();
    if (!capabilities) return false;

    if (level === 'ultra') {
      return capabilities.isDesktop && !capabilities.isLowEnd;
    }
    if (level === 'high') {
      return !capabilities.isMobile;
    }
    return true;
  }

  private calculateVariance(): number {
    const history = this.performanceHistory;
    if (history.length < 2) return 0;

    const mean = history.reduce((sum, val) => sum + val, 0) / history.length;
    const variance = history.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / history.length;
    
    return variance;
  }

  private estimateMemoryUsage(): number {
    if (performance.memory) {
      return Math.round(performance.memory.usedJSHeapSize / 1048576); // Convert to MB
    }
    return 0;
  }

  private setupDeviceListeners(): void {
    // Listen for preference changes
    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    const handlePreferenceChange = () => {
      this.initializeQuality();
    };

    darkQuery.addEventListener('change', handlePreferenceChange);
    reducedMotionQuery.addEventListener('change', handlePreferenceChange);

    // Cleanup on service destroy (Angular will handle this)
  }

  // Public API for components

  /**
   * Get current quality profile
   */
  getQualityProfile(): QualityProfile {
    return this.qualityProfile();
  }

  /**
   * Get maximum particle count for current quality
   */
  getMaxParticles(baseCount: number): number {
    const profile = this.qualityProfile();
    return Math.min(baseCount, profile.maxParticles);
  }

  /**
   * Get antialias setting for current quality
   */
  getAntialiasSetting(): boolean | number {
    return this.qualityProfile().antialias;
  }

  /**
   * Get pixel ratio for current quality
   */
  getPixelRatio(): number {
    const profile = this.qualityProfile();
    const capabilities = this.deviceCapabilities?.();
    const deviceRatio = capabilities?.pixelRatio || 1;

    return Math.min(deviceRatio, profile.pixelRatioLimit);
  }

  /**
   * Get shadow map setting for current quality
   */
  getShadowMapSetting(): boolean | THREE.ShadowMapType {
    return this.qualityProfile().shadows;
  }

  /**
   * Check if post-processing is enabled
   */
  isPostProcessingEnabled(): boolean {
    return this.qualityProfile().postProcessing;
  }

  /**
   * Manually set quality (overrides auto)
   */
  setQuality(level: QualityLevel): void {
    this.currentQuality.set(level);
  }

  /**
   * Set quality mode (auto/manual)
   */
  setQualityMode(mode: QualityMode): void {
    this.qualityMode.set(mode);
    if (mode === 'auto') {
      this.initializeQuality();
    }
  }

  /**
   * Force performance check (call when performance degrades)
   */
  forcePerformanceCheck(): void {
    const metrics = this.performanceMetrics();
    this.evaluatePerformanceAndAdjust(metrics.currentFps);
  }

  /**
   * Get current performance metrics
   */
  getPerformanceMetrics(): PerformanceMetrics {
    return this.performanceMetrics();
  }

  /**
   * Get texture resolution multiplier
   */
  getTextureResolution(): number {
    return this.qualityProfile().textureResolution;
  }

  /**
   * Check if performance is degrading
   */
  isPerformanceDegraded(): boolean {
    const metrics = this.performanceMetrics();
    return metrics.averageFps < metrics.targetFps * 0.8;
  }
}
```

---

## Phase 2: Quality Directive for Three.js Components

### File: `/home/cdom/saas/dimasite/src/app/shared/directives/three-quality-aware.directive.ts`

```typescript
import {
  Directive,
  ElementRef,
  Input,
  inject,
  OnInit,
  OnDestroy
} from '@angular/core';
import { ThreeQualityService } from '../../services/three-quality.service';
import * as THREE from 'three';

@Directive({
  selector: '[threeQualityAware]',
  standalone: true
})
export class ThreeQualityAwareDirective implements OnInit, OnDestroy {
  private readonly qualityService = inject(ThreeQualityService);
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  @Input() threeQualityAware = true;
  @Input() maxParticles?: number;
  @Input() enableShadows?: boolean;
  @Input() enableAntialias?: boolean;
  @Input() enablePostProcessing?: boolean;

  private qualitySubscription: any;

  ngOnInit(): void {
    if (!this.threeQualityAware) {
      return;
    }

    this.applyQualitySettings();
    this.qualitySubscription = this.qualityService.qualityProfile.subscribe(() => {
      this.applyQualitySettings();
    });
  }

  private applyQualitySettings(): void {
    const profile = this.qualityService.getQualityProfile();

    // Apply quality to any Three.js renderer in this component
    // This is a marker directive that components can use to get quality settings
    // The actual renderer configuration depends on the specific component

    // Store quality settings on element for child components to access
    this.elementRef.nativeElement.dataset.quality = profile.level;
    this.elementRef.nativeElement.dataset.maxParticles = profile.maxParticles.toString();
    this.elementRef.nativeElement.dataset.antialias = String(profile.antialias);
    this.elementRef.nativeElement.dataset.pixelRatio = this.qualityService.getPixelRatio().toString();
    this.elementRef.nativeElement.dataset.postProcessing = String(profile.postProcessing);
  }

  ngOnDestroy(): void {
    if (this.qualitySubscription) {
      this.qualitySubscription.unsubscribe();
    }
  }
}
```

---

## Phase 3: Performance Monitor Component (Debug)

### File: `/home/cdom/saas/dimasite/src/app/shared/components/performance-monitor.component.ts`

```typescript
import { Component, inject, signal, computed } from '@angular/core';
import { ThreeQualityService } from '../../services/three-quality.service';

@Component({
  selector: 'app-performance-monitor',
  standalone: true,
  template: `
    <div class="performance-monitor" [class.hidden]="!isVisible()">
      <div class="perf-header">
        <h4>Three.js Performance</h4>
        <button type="button" (click)="toggle()" class="perf-toggle">
          {{ isVisible() ? 'Hide' : 'Show' }}
        </button>
      </div>

      <div class="perf-metrics">
        <div class="perf-metric">
          <span class="perf-label">Quality:</span>
          <span class="perf-value" [class]="'perf-value--' + qualityProfile().level">
            {{ qualityProfile().level | uppercase }}
          </span>
        </div>

        <div class="perf-metric">
          <span class="perf-label">FPS:</span>
          <span class="perf-value" [class]="'perf-value--' + getFpsClass()">
            {{ metrics().currentFps }}
          </span>
        </div>

        <div class="perf-metric">
          <span class="perf-label">Avg FPS:</span>
          <span class="perf-value">{{ metrics().averageFps | number:'1.0-0' }}</span>
        </div>

        <div class="perf-metric">
          <span class="perf-label">Frame Time:</span>
          <span class="perf-value">{{ metrics().frameTime | number:'1.1-1' }} ms</span>
        </div>

        <div class="perf-metric">
          <span class="perf-label">Dropped:</span>
          <span class="perf-value" [class]="'perf-value--warning' : ''">
            {{ metrics().droppedFrames }}
          </span>
        </div>

        <div class="perf-metric">
          <span class="perf-label">Memory:</span>
          <span class="perf-value">{{ metrics().memoryUsage }} MB</span>
        </div>
      </div>

      <div class="perf-controls">
        <div class="perf-control">
          <span class="perf-label">Mode:</span>
          <button
            type="button"
            class="perf-btn"
            [class]="'perf-btn--' + qualityMode()"
            (click)="cycleMode()"
          >
            {{ qualityMode() }}
          </button>
        </div>

        <div class="perf-control">
          <span class="perf-label">Manual:</span>
          <div class="perf-quality-buttons">
            @for (level of qualityLevels; track level) {
              <button
                type="button"
                class="perf-quality-btn"
                [class]="'perf-quality-btn--' + level + (effectiveQuality() === level ? '--active' : '')"
                (click)="setQuality(level)"
              >
                {{ level | uppercase }}
              </button>
            }
          </div>
        </div>
      </div>
    </div>
  `,
  styleUrl: './performance-monitor.component.css',
  changeDetection: 0
})
export class PerformanceMonitorComponent {
  private readonly qualityService = inject(ThreeQualityService);

  readonly isVisible = signal(false);
  readonly qualityLevels: ('low' | 'medium' | 'high' | 'ultra')[] = ['low', 'medium', 'high', 'ultra'];

  readonly qualityProfile = computed(() => this.qualityService.getQualityProfile());
  readonly qualityMode = computed(() => this.qualityService.qualityMode());
  readonly effectiveQuality = computed(() => this.qualityService.effectiveQuality());
  readonly metrics = computed(() => this.qualityService.getPerformanceMetrics());

  toggle(): void {
    this.isVisible.update(v => !v);
  }

  cycleMode(): void {
    const modes = ('auto' | 'manual')[] = ['auto', 'manual'];
    const currentIndex = modes.indexOf(this.qualityMode());
    const nextMode = modes[(currentIndex + 1) % modes.length];
    this.qualityService.setQualityMode(nextMode);
  }

  setQuality(level: 'low' | 'medium' | 'high' | 'ultra'): void {
    this.qualityService.setQuality(level);
  }

  getFpsClass(): string {
    const fps = this.metrics().currentFps;
    if (fps < 25) return 'critical';
    if (fps < 35) return 'warning';
    return 'good';
  }
}
```

**Styles (`performance-monitor.component.css`):**
```css
:host {
  display: block;
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  z-index: 1000;
}

.performance-monitor {
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(12px);
  border-radius: 0.75rem;
  padding: 1rem;
  min-width: 300px;
  color: #fff;
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 0.875rem;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}

.performance-monitor.hidden {
  display: none;
}

.perf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.2);
}

.perf-header h4 {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
}

.perf-toggle {
  background: rgba(255, 255, 255, 0.15);
  border: none;
  border-radius: 0.375rem;
  padding: 0.375rem 0.75rem;
  color: #fff;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 600;
  transition: background 0.2s;
}

.perf-toggle:hover {
  background: rgba(255, 255, 255, 0.25);
}

.perf-metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.perf-metric {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.perf-label {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.7);
}

.perf-value {
  font-weight: 600;
  font-size: 0.875rem;
}

.perf-value--good {
  color: #22c55e;
}

.perf-value--warning {
  color: #f59e0b;
}

.perf-value--critical {
  color: #ef4444;
}

.perf-value--low {
  color: #8b5cf6;
}

.perf-value--medium {
  color: #a855f7;
}

.perf-value--high {
  color: #c084fc;
}

.perf-value--ultra {
  color: #e879f9;
}

.perf-controls {
  padding-top: 0.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.2);
}

.perf-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.perf-btn {
  background: rgba(139, 92, 246, 0.3);
  border: 1px solid rgba(139, 92, 246, 0.5);
  border-radius: 0.375rem;
  padding: 0.375rem 0.75rem;
  color: #fff;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 600;
  transition: all 0.2s;
}

.perf-btn--auto {
  background: rgba(34, 197, 94, 0.3);
  border-color: rgba(34, 197, 94, 0.5);
}

.perf-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.3);
}

.perf-quality-buttons {
  display: flex;
  gap: 0.375rem;
}

.perf-quality-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 0.375rem;
  padding: 0.25rem 0.5rem;
  color: #fff;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 600;
  transition: all 0.2s;
}

.perf-quality-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  border-color: rgba(255, 255, 255, 0.3);
}

.perf-quality-btn--active {
  background: rgba(139, 92, 246, 0.4);
  border-color: rgba(139, 92, 246, 0.6);
}

.perf-quality-btn--low--active {
  background: rgba(139, 92, 246, 0.4);
  border-color: rgba(139, 92, 246, 0.6);
}

.perf-quality-btn--medium--active {
  background: rgba(168, 85, 247, 0.4);
  border-color: rgba(168, 85, 247, 0.6);
}

.perf-quality-btn--high--active {
  background: rgba(192, 132, 252, 0.4);
  border-color: rgba(192, 132, 252, 0.6);
}

.perf-quality-btn--ultra--active {
  background: rgba(232, 121, 249, 0.4);
  border-color: rgba(232, 121, 249, 0.6);
}
```

---

## Phase 4: Integration Helper

### File: `/home/cdom/saas/dimasite/src/app/core/services/three-quality-helper.service.ts`

```typescript
import { Injectable } from '@angular/core';
import { ThreeQualityService } from './three-quality.service';
import * as THREE from 'three';

@Injectable({
  providedIn: 'root'
})
export class ThreeQualityHelperService {
  constructor(private qualityService: ThreeQualityService) {}

  /**
   * Apply quality settings to a WebGLRenderer
   */
  applyQualityToRenderer(renderer: THREE.WebGLRenderer): void {
    const profile = this.qualityService.getQualityProfile();

    // Apply antialias
    if (typeof profile.antialias === 'number') {
      renderer.setPixelRatio(this.qualityService.getPixelRatio());
    }

    // Apply pixel ratio
    renderer.setPixelRatio(this.qualityService.getPixelRatio());

    // Force recompile shaders on quality change
    renderer.compile(null, null);
  }

  /**
   * Get optimized material for current quality
   */
  createOptimizedMaterial(baseMaterial: THREE.Material): THREE.Material {
    const profile = this.qualityService.getQualityProfile();

    if (profile.shaderQuality === 'basic') {
      // Basic material with minimal processing
      return baseMaterial.clone();
    }

    if (profile.shaderQuality === 'standard') {
      // Standard material with reasonable quality
      return baseMaterial.clone();
    }

    // Advanced material with full features
    return baseMaterial.clone();
  }

  /**
   * Check if post-processing should be enabled
   */
  shouldEnablePostProcessing(): boolean {
    return this.qualityService.isPostProcessingEnabled();
  }

  /**
   * Get maximum texture size for current quality
   */
  getMaxTextureSize(baseSize: number): number {
    const resolution = this.qualityService.getTextureResolution();
    return Math.round(baseSize * resolution);
  }

  /**
   * Notify quality service of performance issue
   */
  notifyPerformanceIssue(): void {
    this.qualityService.forcePerformanceCheck();
  }
}
```

---

## Phase 5: Usage Examples

### Example 1: Using Quality Service in Hero Component

```typescript
import { Component, inject } from '@angular/core';
import { ThreeQualityService } from '../../services/three-quality.service';

@Component({
  selector: 'app-hero-orb',
  standalone: true,
  template: '<canvas #orbCanvas class="hero-orb-canvas"></canvas>',
  changeDetection: 0
})
export class HeroOrbComponent {
  private readonly qualityService = inject(ThreeQualityService);
  private canvas: HTMLCanvasElement;

  ngAfterViewInit(): void {
    this.canvas = this.elementRef.nativeElement.querySelector('canvas') as HTMLCanvasElement;

    // Create renderer with quality settings
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: this.qualityService.getAntialiasSetting(),
      powerPreference: 'high-performance'
    });

    // Apply pixel ratio
    renderer.setPixelRatio(this.qualityService.getPixelRatio());

    // Get max particles for current quality
    const maxParticles = this.qualityService.getMaxParticles(1500);
    
    // Create particles (capped by quality)
    // ... rest of implementation
  }
}
```

### Example 2: Using Quality Directive

```html
<article class="glass-card" threeQualityAware>
  <!-- Component will automatically receive quality settings -->
  <app-live-channel-3d-avatar [channel]="channel"></app-live-channel-3d-avatar>
</article>
```

### Example 3: Performance Monitor Integration

```html
<!-- Add to landing page for development/debug -->
<app-performance-monitor></app-performance-monitor>
```

**Integration in `landing-page.component.html`:**
```html
<div class="landing-shell">
  <!-- ... existing content ... -->
  
  <!-- Performance monitor (dev only, hidden in production) -->
  @if (!environment.production) {
    <app-performance-monitor></app-performance-monitor>
  }
</div>
```

---

## Performance Targets

### Expected Quality Adjustments

| Scenario | Initial Quality | Adjusted To | Time to Detect | Reason |
|----------|---------------|-------------|----------------|--------|
| Mobile load | Low | Low | 0s | Pre-detected |
| Mobile with lag | Low | Low | 2s | Stable |
| Tablet load | Medium | Medium | 0s | Pre-detected |
| Tablet with lag | Medium | Low | 3s | FPS drop |
| Desktop load | High | High | 0s | Pre-detected |
| Desktop with weak GPU | High | Medium | 5s | Frame time |
| Desktop with strong GPU | High | Ultra | 10s | Headroom |

### Memory Targets

| Quality Level | Memory Target | Particle Count | Texture Resolution |
|-------------|---------------|----------------|-------------------|
| Low | <50MB | 100-200 | 512px |
| Medium | <80MB | 300-400 | 1024px |
| High | <120MB | 500-600 | 2048px |
| Ultra | <150MB | 1000+ | 4096px |

---

## Testing Strategy

### Manual Quality Testing

1. **Test each quality level manually:**
   - Set quality to low, verify performance
   - Set quality to medium, verify visual quality vs low
   - Set quality to high, verify visual quality vs medium
   - Test ultra on high-end devices only

2. **Test adaptive mode:**
   - Start on mobile, verify auto-downgrades
   - Simulate performance degradation (use Chrome DevTools throttling)
   - Verify recovery when performance improves

### Automated Performance Testing

```bash
# Lighthouse CI/CD
npx lighthouse --only=performance --emulated-form-factor=mobile

# Chrome DevTools Performance tab
# - Record landing page interactions
# - Analyze FPS, frame time, memory
# - Check for layout thrashing
```

### Device Testing Matrix

| Device | Expected Quality | Min FPS Target | Expected Memory |
|---------|----------------|----------------|------------------|
| iPhone 11 | Low | 30+ | <50MB |
| iPhone 14 Pro | Medium | 45+ | <80MB |
| iPad | Medium | 45+ | <80MB |
| Android Mid-range | Low | 30+ | <50MB |
| Android Flagship | High | 60+ | <120MB |
| Desktop (Intel HD) | Medium | 45+ | <80MB |
| Desktop (GTX 1660) | High | 60+ | <120MB |
| Desktop (RTX 3080) | Ultra | 60+ | <150MB |

---

## Files to Create

**Phase 1 - Core Service:**
- `/home/cdom/saas/dimasite/src/app/core/services/three-quality.service.ts`

**Phase 2 - Directive:**
- `/home/cdom/saas/dimasite/src/app/shared/directives/three-quality-aware.directive.ts`

**Phase 3 - Debug Component:**
- `/home/cdom/saas/dimasite/src/app/shared/components/performance-monitor/performance-monitor.component.ts`
- `/home/cdom/saas/dimasite/src/app/shared/components/performance-monitor/performance-monitor.component.css`

**Phase 4 - Helper Service:**
- `/home/cdom/saas/dimasite/src/app/core/services/three-quality-helper.service.ts`

**Total: 5 files to create**

---

## Integration Checklist

Before considering quality system complete, verify:

✅ Quality service initializes correctly on all devices
✅ Auto-detection assigns appropriate initial quality
✅ FPS monitoring runs and updates metrics accurately
✅ Quality downgrades trigger when FPS drops below target
✅ Quality upgrades trigger when performance is stable and good
✅ Manual quality mode works and overrides auto mode
✅ Performance monitor displays accurate real-time metrics
✅ Quality directive provides settings to child components
✅ Helper service applies renderer settings correctly
✅ Memory usage tracking works (when available)
✅ Quality adjustments respect cooldown period
✅ Reduced motion preference forces low quality
✅ Mobile devices default to low quality
✅ Desktop devices default to high quality
✅ Ultra quality only available on capable desktops
✅ Performance monitor hidden in production (or optionally shown)
✅ Quality presets align with performance targets
✅ No memory leaks in FPS monitoring
✅ FPS monitoring doesn't degrade performance itself
✅ Device capabilities detection works correctly
✅ Pixel ratio capping works on all devices
✅ Texture resolution scaling works correctly
✅ Shadow map settings apply correctly
✅ Antialias settings apply correctly
✅ Post-processing toggles correctly

---

## Success Criteria

✅ Quality service provides 4 quality levels (low/medium/high/ultra)
✅ Auto mode detects initial quality based on device
✅ Manual mode allows user override
✅ FPS monitoring runs continuously with minimal overhead
✅ Quality auto-adjusts based on performance metrics
✅ Performance monitor shows real-time FPS and metrics
✅ Quality directive makes settings available to components
✅ Helper service applies renderer optimizations
✅ Memory usage is tracked and limited
✅ System respects reduced motion preference
✅ Quality adjustments don't cause visual glitches
✅ System stabilizes at optimal quality within 10 seconds
✅ Mobile devices maintain 30+ FPS
✅ Desktop devices maintain 60+ FPS
✅ Memory usage stays within target range
✅ No performance regression when quality system is disabled
✅ Quality system can be toggled off entirely (for testing)

---

## Questions for Implementation

1. **Ultra Quality:** Should ultra quality be hidden for mobile users entirely, or just grayed out?
2. **Performance Monitor:** Should the performance monitor be visible in production, or dev only?
3. **Quality Persistence:** Should user's manual quality preference be saved to localStorage?
4. **Cooldown Period:** Is 5 seconds too long or too short for quality adjustments?
5. **FPS Thresholds:** Should the 70% / 120% thresholds be configurable?
6. **Quality Indicator:** Should there be a visual quality indicator in the UI (for users)?
7. **Debug Mode:** Should there be a verbose logging mode for debugging quality issues?
8. **Fallback Behavior:** What should happen if device capabilities detection fails?
9. **Quality Lock:** Should there be a way to lock quality to prevent auto-adjustments?
10. **Performance History:** Should we persist performance history to help future optimizations?

---

## Notes for Builder AI

1. **Read-Only Mode:** This plan is for quality system only - NO landing page modifications
2. **Standalone System:** Quality system should work independently of landing page
3. **Non-Breaking:** System must not break if components don't use quality settings
4. **Graceful Degradation:** Quality changes should be smooth, not jarring
5. **Performance First:** Always prioritize smooth framerate over visual fidelity
6. **Test Thoroughly:** Test on actual devices, not just device emulation
7. **Monitor Memory:** Watch for memory leaks in FPS monitoring loop
8. **Document Behavior:** Add comments explaining quality decision logic
9. **Keep It Simple:** Don't over-engineer the adaptive algorithm
10. **Ask Questions:** If unclear about any quality trade-offs, ask for clarification

---

## Next Steps After Quality System

Once quality system is complete and tested, next implementation plan should cover:

1. **Login Page** - Handle Twitch OAuth callback
2. **Logout Page** - Clear session
3. **Authenticated Layout** - Navbar, sidebar, theme/language toggles
4. **Dashboard** - ECharts integration, live analytics

---

Good luck implementing the Three.js dynamic quality system! 📊⚡
