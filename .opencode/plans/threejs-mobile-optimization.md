# Three.js Quality System - Mobile Device Enhancements
**DomDimaBot v21 - Mobile Optimization Layer**

---

## Overview

This plan **updates and enhances** the Three.js dynamic quality system with **comprehensive mobile device support**. The quality system will intelligently adapt to mobile hardware, touch interactions, battery constraints, and thermal throttling scenarios.

**Status:** Enhancement of existing quality system with mobile-first considerations
**Mode:** Read-Only - No file modifications

---

## Mobile Device Categories

### Entry-Level Mobile
**Characteristics:**
- Screen: 375px - 428px (iPhone SE, Android low-end)
- RAM: 2GB - 3GB
- GPU: Adreno 505/506, Mali-450/470, PowerVR GE8100
- CPU: 4-6 cores, <2GHz
- Network: 3G/4G optional

**Quality Presets:**
- Ultra-Low Quality (default)
  - Antialias: Disabled
  - Pixel Ratio: 0.75
  - Shadows: Disabled
  - Particles: 50-80
  - Shaders: Basic (fixed)
  - Post-Processing: None
  - Texture Resolution: 0.25 (256px max)
  - Target FPS: 25+
  - Power Mode: Maximum savings

### Mid-Range Mobile
**Characteristics:**
- Screen: 390px - 414px (iPhone 12, mid-range Android)
- RAM: 4GB - 6GB
- GPU: Adreno 630/640, Mali-G52/57, Apple A13 GPU
- CPU: 6-8 cores, 2-2.5GHz
- Network: 4G/5G

**Quality Presets:**
- Low Quality (default)
  - Antialias: FXAA (fast)
  - Pixel Ratio: 1.0
  - Shadows: Disabled
  - Particles: 100-150
  - Shaders: Standard
  - Post-Processing: Disabled
  - Texture Resolution: 0.5 (512px max)
  - Target FPS: 30+
  - Power Mode: Balanced

### Flagship Mobile
**Characteristics:**
- Screen: 428px - 476px (iPhone 14 Pro, Galaxy S23)
- RAM: 8GB - 12GB
- GPU: Adreno 730/740, Mali-G710/720, Apple A16/A17 GPU
- CPU: 8+ cores, 2.5-3.5GHz
- Network: 5G/Wi-Fi

**Quality Presets:**
- Medium Quality (default)
  - Antialias: FXAA (quality)
  - Pixel Ratio: 1.5
  - Shadows: Basic PCFSoft
  - Particles: 200-300
  - Shaders: Standard
  - Post-Processing: Basic bloom
  - Texture Resolution: 0.75 (1024px max)
  - Target FPS: 45+
  - Power Mode: Performance

### Mobile-Specific Considerations

**Touch vs Mouse:**
- Touch interactions have higher latency (50-100ms)
- Touch has no hover state, only active/press
- Multi-touch support required
- Touch ripple effects can be expensive

**Battery Constraints:**
- High drain during 3D rendering
- Device thermal throttling after 5-10 minutes intense 3D
- Background throttling when device locked
- Battery percentage should influence quality

**Mobile GPU Limitations:**
- Limited vertex shader support
- Fragment shader complexity limits
- Texture size restrictions (4096x4096 common)
- Draw call limits per frame
- Limited buffer sizes

**Network Awareness:**
- 3G: Minimal textures, no high-res assets
- 4G: Moderate textures
- 5G/Wi-Fi: Full quality
- Offline: Cache aggressively

---

## Phase 1: Enhanced Device Detection

### File: `/home/cdom/saas/dimasite/src/app/core/services/mobile-device-capabilities.service.ts`

```typescript
import { Injectable, signal } from '@angular/core';

export type MobileTier = 'entry' | 'mid' | 'flagship' | 'unknown';
export type NetworkType = 'unknown' | '2g' | '3g' | '4g' | '5g' | 'wifi' | 'offline';

export interface MobileDeviceCapabilities {
  // Device classification
  mobileTier: MobileTier;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  
  // Hardware
  gpuVendor: string;
  gpuRenderer: string;
  maxTextureSize: number;
  estimatedGpuTier: 'low' | 'medium' | 'high' | 'unknown';
  
  // Performance
  estimatedCores: number;
  estimatedRam: number;
  supportsHardwareAcceleration: boolean;
  supportsWebGL2: boolean;
  
  // Mobile-specific
  isMobile: boolean;
  isTouchDevice: boolean;
  hasStylus: boolean;
  supportsHaptics: boolean;
  supportsVibration: boolean;
  
  // Power & thermal
  supportsBatteryAPI: boolean;
  supportsThermalAPI: boolean;
  currentBatteryLevel: number | null;
  isCharging: boolean;
  isThermallyThrottled: boolean;
  
  // Network
  networkType: NetworkType;
  effectiveConnectionType: 'slow' | 'medium' | 'fast' | 'unknown';
  
  // User preferences
  prefersReducedMotion: boolean;
  prefersReducedData: boolean;
  prefersHighContrast: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class MobileDeviceCapabilitiesService {
  readonly capabilities = signal<MobileDeviceCapabilities>({
    mobileTier: 'unknown',
    screenWidth: 0,
    screenHeight: 0,
    devicePixelRatio: 1,
    gpuVendor: '',
    gpuRenderer: '',
    maxTextureSize: 0,
    estimatedGpuTier: 'unknown',
    estimatedCores: 0,
    estimatedRam: 0,
    supportsHardwareAcceleration: false,
    supportsWebGL2: false,
    isMobile: false,
    isTouchDevice: false,
    hasStylus: false,
    supportsHaptics: false,
    supportsVibration: false,
    supportsBatteryAPI: false,
    supportsThermalAPI: false,
    currentBatteryLevel: null,
    isCharging: false,
    isThermallyThrottled: false,
    networkType: 'unknown',
    effectiveConnectionType: 'unknown',
    prefersReducedMotion: false,
    prefersReducedData: false,
    prefersHighContrast: false
  });

  // Mobile tier detection benchmarks
  private readonly mobileBenchmarks = {
    entry: {
      width: 428,
      height: 926,
      ram: 2048,
      maxTexture: 2048
    },
    mid: {
      width: 393,
      height: 852,
      ram: 4096,
      maxTexture: 4096
    },
    flagship: {
      width: 430,
      height: 932,
      ram: 8192,
      maxTexture: 4096
    }
  };

  // GPU vendor detection patterns
  private readonly gpuPatterns = {
    adreno: {
      patterns: ['adreno', 'qualcomm'],
      estimatedTier: 'medium'
    },
    mali: {
      patterns: ['mali', 'arm', 'mediatek'],
      estimatedTier: 'low'
    },
    apple: {
      patterns: ['apple', 'metal', 'a[0-9]', 'a[1-9]'],
      estimatedTier: 'high'
    },
    powervr: {
      patterns: ['powervr', 'imagination', 'sgx'],
      estimatedTier: 'low'
    }
  };

  constructor() {
    this.detectScreen();
    this.detectGPU();
    this.detectMobileFeatures();
    this.detectBatterySupport();
    this.detectNetwork();
    this.detectUserPreferences();
  }

  private detectScreen(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    this.capabilities.update(cap => ({
      ...cap,
      screenWidth: width,
      screenHeight: height,
      devicePixelRatio: dpr
    }));

    // Determine mobile tier based on screen
    const isSmall = width < 400;
    const isMedium = width >= 400 && width < 428;

    let tier: MobileTier = 'unknown';
    if (this.isMobileDevice()) {
      if (isSmall) {
        tier = 'entry';
      } else if (isMedium) {
        tier = 'mid';
      } else {
        tier = 'flagship';
      }
    }

    this.capabilities.update(cap => ({
      ...cap,
      mobileTier: tier
    }));

    window.addEventListener('resize', () => this.detectScreen());
  }

  private detectMobileFeatures(): void {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    this.capabilities.update(cap => ({
      ...cap,
      isMobile,
      isTouchDevice: isTouch,
      hasStylus: isMobile && 'onmspointerenter' in window,
      supportsHaptics: 'vibrate' in navigator,
      supportsVibration: 'vibrate' in navigator
    }));
  }

  private detectGPU(): void {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    
    if (!gl) {
      this.capabilities.update(cap => ({
        ...cap,
        supportsWebGL2: false
      }));
      return;
    }

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = gl.getParameter(gl.RENDERER);
    const renderer = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);

    let gpuVendor = '';
    let gpuRenderer = '';

    if (debugInfo) {
      gpuVendor = debugInfo.UNMASKED_VENDOR_WEBGL || '';
      gpuRenderer = debugInfo.UNMASKED_RENDERER_WEBGL || '';
    }

    // Try to get from WebGL params if debugInfo unavailable
    if (!gpuVendor && vendor) {
      gpuVendor = this.extractVendorFromRenderer(vendor);
    }

    // Determine estimated GPU tier
    let estimatedGpuTier: 'low' | 'medium' | 'high' | 'unknown' = 'unknown';
    for (const [vendorKey, vendorData] of Object.entries(this.gpuPatterns)) {
      const patterns = vendorData.patterns as string[];
      if (patterns.some(pattern => gpuVendor.toLowerCase().includes(pattern))) {
        estimatedGpuTier = vendorData.estimatedTier as 'low' | 'medium' | 'high';
        break;
      }
    }

    // Check max texture size
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;

    // Estimate RAM from device memory API (Chrome)
    let estimatedRam = 0;
    if ((navigator as any).deviceMemory) {
      estimatedRam = (navigator as any).deviceMemory * 1024; // Convert GB to MB
    }

    // Estimate cores
    const estimatedCores = navigator.hardwareConcurrency || 4;

    this.capabilities.update(cap => ({
      ...cap,
      gpuVendor,
      gpuRenderer,
      maxTextureSize,
      estimatedGpuTier,
      estimatedRam,
      estimatedCores,
      supportsWebGL2: !!canvas.getContext('webgl2'),
      supportsHardwareAcceleration: true // If we're here, WebGL worked
    }));
  }

  private extractVendorFromRenderer(renderer: string): string {
    // Extract GPU vendor from renderer string
    const lowerRenderer = renderer.toLowerCase();
    
    if (lowerRenderer.includes('adreno')) return 'Qualcomm Adreno';
    if (lowerRenderer.includes('mali')) return 'ARM Mali';
    if (lowerRenderer.includes('apple')) return 'Apple';
    if (lowerRenderer.includes('powervr')) return 'PowerVR';
    if (lowerRenderer.includes('intel')) return 'Intel';
    if (lowerRenderer.includes('nvidia')) return 'NVIDIA';
    
    return 'Unknown';
  }

  private isMobileDevice(): boolean {
    return this.capabilities().isMobile;
  }

  private detectBatterySupport(): void {
    const batteryAPI = 'getBattery' in navigator;
    
    if (batteryAPI) {
      this.capabilities.update(cap => ({
        ...cap,
        supportsBatteryAPI: true
      }));

      // Monitor battery level
      const battery = navigator.getBattery();
      battery.then((batteryManager) => {
        const updateBattery = () => {
          this.capabilities.update(cap => ({
            ...cap,
            currentBatteryLevel: Math.round(batteryManager.level * 100),
            isCharging: batteryManager.charging
          }));
        };

        batteryManager.addEventListener('levelchange', updateBattery);
        batteryManager.addEventListener('chargingchange', updateBattery);
        updateBattery();
      });
    }
  }

  private detectNetwork(): void {
    const connection = (navigator as any).connection;
    
    if (!connection) {
      return;
    }

    this.capabilities.update(cap => ({
      ...cap,
      networkType: this.mapNetworkType(connection.effectiveType)
    }));

    const updateNetwork = () => {
      this.capabilities.update(cap => ({
        ...cap,
        networkType: this.mapNetworkType(connection.effectiveType),
        effectiveConnectionType: this.calculateEffectiveConnection(connection)
      }));
    };

    connection.addEventListener('change', updateNetwork);
    updateNetwork();
  }

  private mapNetworkType(effectiveType: string): NetworkType {
    const type = effectiveType?.toLowerCase() || 'unknown';
    
    const typeMap: Record<string, NetworkType> = {
      '2g': '2g',
      '3g': '3g',
      '4g': '4g',
      'cellular': '4g',
      'wifi': 'wifi',
      'ethernet': 'wifi',
      'unknown': 'unknown'
    };
    
    return typeMap[type] || 'unknown';
  }

  private calculateEffectiveConnection(connection: any): 'slow' | 'medium' | 'fast' | 'unknown' {
    const type = connection.effectiveType;
    const rtt = connection.rtt || 0;
    const downlink = connection.downlink || 0;

    // Map effective connection to quality tiers
    if (type === 'wifi' || type === 'ethernet') {
      return 'fast';
    }

    if (type === '4g' || type === 'cellular') {
      if (rtt < 100) return 'fast';
      if (rtt < 200) return 'medium';
      return 'slow';
    }

    if (type === '3g' || type === '2g') {
      return 'slow';
    }

    return 'unknown';
  }

  private detectUserPreferences(): void {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const prefersReducedData = window.matchMedia('(prefers-reduced-data: reduce)').matches;
    const prefersHighContrast = window.matchMedia('(prefers-contrast: high)').matches;

    this.capabilities.update(cap => ({
      ...cap,
      prefersReducedMotion,
      prefersReducedData,
      prefersHighContrast
    }));

    // Listen for changes
    const queries = [
      { media: '(prefers-reduced-motion: reduce)', property: 'prefersReducedMotion' },
      { media: '(prefers-reduced-data: reduce)', property: 'prefersReducedData' },
      { media: '(prefers-contrast: high)', property: 'prefersHighContrast' }
    ];

    queries.forEach(query => {
      query.media.addEventListener('change', () => {
        this.capabilities.update(cap => ({
          ...cap,
          [query.property]: query.media.matches
        }));
      });
    });
  }

  // Public API

  getCapabilities(): MobileDeviceCapabilities {
    return this.capabilities();
  }

  getMobileTier(): MobileTier {
    return this.capabilities().mobileTier;
  }

  shouldUseUltraLowQuality(): boolean {
    const cap = this.capabilities();
    return cap.mobileTier === 'entry' || cap.effectiveConnectionType === 'slow' || cap.currentBatteryLevel < 20;
  }

  shouldUseLowQuality(): boolean {
    const cap = this.capabilities();
    return cap.mobileTier === 'mid' || cap.effectiveConnectionType === 'medium' || cap.currentBatteryLevel < 50;
  }

  shouldUseMediumQuality(): boolean {
    const cap = this.capabilities();
    return cap.mobileTier === 'flagship' && cap.effectiveConnectionType === 'fast' && (cap.currentBatteryLevel || 100) > 50;
  }

  shouldDisableShadows(): boolean {
    const cap = this.capabilities();
    return cap.mobileTier === 'entry' || cap.isThermallyThrottled;
  }

  shouldLimitParticleCount(): boolean {
    const cap = this.capabilities();
    return cap.mobileTier === 'entry' || cap.isThermallyThrottled || cap.currentBatteryLevel < 30;
  }

  getOptimizedParticleMultiplier(): number {
    const cap = this.capabilities();
    
    if (cap.isThermallyThrottled) {
      return 0.3; // Severe reduction
    }
    if (cap.currentBatteryLevel && cap.currentBatteryLevel < 30) {
      return 0.5; // High reduction
    }
    if (cap.mobileTier === 'entry') {
      return 0.6; // Medium reduction
    }
    if (cap.mobileTier === 'mid') {
      return 0.8; // Slight reduction
    }
    if (cap.mobileTier === 'flagship') {
      return 1.0; // No reduction
    }
    
    return 1.0;
  }

  getTouchInteractionLatency(): number {
    const cap = this.capabilities();
    
    // Touch has higher latency than mouse
    if (cap.isTouchDevice) {
      return 100; // 100ms base latency
    }
    
    return 16; // 16ms base latency for mouse
  }
}
```

---

## Phase 2: Mobile-Optimized Quality Profiles

### File: `/home/cdom/saas/dimasite/src/app/core/services/mobile-quality-profiles.service.ts`

```typescript
import { Injectable } from '@angular/core';
import { MobileDeviceCapabilitiesService } from './mobile-device-capabilities.service';
import { MobileDeviceCapabilities, MobileTier } from './mobile-device-capabilities.service';

export interface MobileQualityProfile {
  level: 'ultra-low' | 'low' | 'medium' | 'high';
  antialias: boolean | number;
  pixelRatio: number;
  shadows: boolean;
  shadowResolution: number;
  maxParticles: number;
  shaderComplexity: 'minimal' | 'basic' | 'standard' | 'advanced';
  postProcessing: boolean;
  postProcessingQuality: 'disabled' | 'low' | 'medium' | 'high';
  targetFps: number;
  frameBudgetMs: number;
  powerMode: 'max-savings' | 'balanced' | 'performance';
  textureMaxSize: number;
  enableInstancing: boolean;
  touchOptimized: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class MobileQualityProfilesService {
  constructor(
    private deviceCapabilities: MobileDeviceCapabilitiesService
  ) {}

  // Mobile-specific quality profiles
  private readonly profiles: Record<MobileTier, Record<string, MobileQualityProfile>> = {
    entry: {
      'ultra-low': {
        level: 'ultra-low',
        antialias: false,
        pixelRatio: 0.75,
        shadows: false,
        shadowResolution: 256,
        maxParticles: 50,
        shaderComplexity: 'minimal',
        postProcessing: false,
        postProcessingQuality: 'disabled',
        targetFps: 25,
        frameBudgetMs: 40,
        powerMode: 'max-savings',
        textureMaxSize: 256,
        enableInstancing: false,
        touchOptimized: true
      },
      'low': {
        level: 'low',
        antialias: false,
        pixelRatio: 0.75,
        shadows: false,
        shadowResolution: 256,
        maxParticles: 80,
        shaderComplexity: 'minimal',
        postProcessing: false,
        postProcessingQuality: 'disabled',
        targetFps: 28,
        frameBudgetMs: 35,
        powerMode: 'max-savings',
        textureMaxSize: 512,
        enableInstancing: false,
        touchOptimized: true
      },
      'medium': {
        level: 'medium',
        antialias: false,
        pixelRatio: 1.0,
        shadows: false,
        shadowResolution: 512,
        maxParticles: 120,
        shaderComplexity: 'basic',
        postProcessing: false,
        postProcessingQuality: 'disabled',
        targetFps: 30,
        frameBudgetMs: 33,
        powerMode: 'balanced',
        textureMaxSize: 512,
        enableInstancing: false,
        touchOptimized: true
      },
      'high': {
        level: 'high',
        antialias: 'fxaa',
        pixelRatio: 1.25,
        shadows: true,
        shadowResolution: 512,
        maxParticles: 150,
        shaderComplexity: 'basic',
        postProcessing: true,
        postProcessingQuality: 'low',
        targetFps: 35,
        frameBudgetMs: 28,
        powerMode: 'performance',
        textureMaxSize: 1024,
        enableInstancing: true,
        touchOptimized: true
      }
    },
    mid: {
      'ultra-low': {
        level: 'ultra-low',
        antialias: 'fxaa',
        pixelRatio: 1.0,
        shadows: false,
        shadowResolution: 512,
        maxParticles: 100,
        shaderComplexity: 'minimal',
        postProcessing: false,
        postProcessingQuality: 'disabled',
        targetFps: 30,
        frameBudgetMs: 33,
        powerMode: 'max-savings',
        textureMaxSize: 512,
        enableInstancing: false,
        touchOptimized: true
      },
      'low': {
        level: 'low',
        antialias: 'fxaa',
        pixelRatio: 1.0,
        shadows: false,
        shadowResolution: 512,
        maxParticles: 150,
        shaderComplexity: 'basic',
        postProcessing: false,
        postProcessingQuality: 'disabled',
        targetFps: 32,
        frameBudgetMs: 31,
        powerMode: 'balanced',
        textureMaxSize: 1024,
        enableInstancing: false,
        touchOptimized: true
      },
      'medium': {
        level: 'medium',
        antialias: 'fxaa',
        pixelRatio: 1.5,
        shadows: true,
        shadowResolution: 1024,
        maxParticles: 200,
        shaderComplexity: 'standard',
        postProcessing: true,
        postProcessingQuality: 'low',
        targetFps: 40,
        frameBudgetMs: 28,
        powerMode: 'balanced',
        textureMaxSize: 1024,
        enableInstancing: true,
        touchOptimized: true
      },
      'high': {
        level: 'high',
        antialias: 'fxaa',
        pixelRatio: 2.0,
        shadows: true,
        shadowResolution: 1024,
        maxParticles: 300,
        shaderComplexity: 'standard',
        postProcessing: true,
        postProcessingQuality: 'low',
        targetFps: 45,
        frameBudgetMs: 25,
        powerMode: 'performance',
        textureMaxSize: 2048,
        enableInstancing: true,
        touchOptimized: true
      }
    },
    flagship: {
      'ultra-low': {
        level: 'ultra-low',
        antialias: 'fxaa',
        pixelRatio: 1.5,
        shadows: true,
        shadowResolution: 1024,
        maxParticles: 150,
        shaderComplexity: 'basic',
        postProcessing: false,
        postProcessingQuality: 'disabled',
        targetFps: 30,
        frameBudgetMs: 33,
        powerMode: 'max-savings',
        textureMaxSize: 1024,
        enableInstancing: true,
        touchOptimized: true
      },
      'low': {
        level: 'low',
        antialias: 'fxaa',
        pixelRatio: 1.5,
        shadows: true,
        shadowResolution: 1024,
        maxParticles: 200,
        shaderComplexity: 'basic',
        postProcessing: false,
        postProcessingQuality: 'disabled',
        targetFps: 35,
        frameBudgetMs: 28,
        powerMode: 'balanced',
        textureMaxSize: 1024,
        enableInstancing: true,
        touchOptimized: true
      },
      'medium': {
        level: 'medium',
        antialias: 'fxaa',
        pixelRatio: 2.0,
        shadows: true,
        shadowResolution: 1024,
        maxParticles: 400,
        shaderComplexity: 'standard',
        postProcessing: true,
        postProcessingQuality: 'low',
        targetFps: 50,
        frameBudgetMs: 20,
        powerMode: 'balanced',
        textureMaxSize: 2048,
        enableInstancing: true,
        touchOptimized: true
      },
      'high': {
        level: 'high',
        antialias: 'fxaa',
        pixelRatio: 2.0,
        shadows: true,
        shadowResolution: 1024,
        maxParticles: 500,
        shaderComplexity: 'advanced',
        postProcessing: true,
        postProcessingQuality: 'medium',
        targetFps: 60,
        frameBudgetMs: 16,
        powerMode: 'performance',
        textureMaxSize: 4096,
        enableInstancing: true,
        touchOptimized: true
      },
      'ultra': {
        level: 'high', // No ultra for mobile
        antialias: 'fxaa',
        pixelRatio: 2.0,
        shadows: true,
        shadowResolution: 1024,
        maxParticles: 500,
        shaderComplexity: 'advanced',
        postProcessing: true,
        postProcessingQuality: 'medium',
        targetFps: 60,
        frameBudgetMs: 16,
        powerMode: 'performance',
        textureMaxSize: 4096,
        enableInstancing: true,
        touchOptimized: true
      }
    }
  };

  // Get profile based on mobile tier and current condition
  getProfile(tier: MobileTier, level: 'ultra-low' | 'low' | 'medium' | 'high' | 'auto' = 'auto'): MobileQualityProfile {
    const deviceCap = this.deviceCapabilities.getCapabilities();
    
    if (level !== 'auto') {
      return this.profiles[tier][level];
    }

    // Auto-detect appropriate level based on conditions
    let autoLevel: 'ultra-low' | 'low' | 'medium' | 'high' = 'medium';
    
    if (deviceCap.isThermallyThrottled) {
      autoLevel = 'ultra-low';
    } else if (deviceCap.currentBatteryLevel && deviceCap.currentBatteryLevel < 20) {
      autoLevel = 'ultra-low';
    } else if (deviceCap.effectiveConnectionType === 'slow') {
      autoLevel = 'ultra-low';
    } else if (deviceCap.prefersReducedMotion) {
      autoLevel = 'ultra-low';
    } else if (deviceCap.mobileTier === 'entry') {
      autoLevel = 'low';
    } else if (deviceCap.mobileTier === 'mid' && deviceCap.effectiveConnectionType !== 'fast') {
      autoLevel = 'low';
    } else if (deviceCap.mobileTier === 'mid') {
      autoLevel = 'medium';
    } else if (deviceCap.mobileTier === 'flagship') {
      autoLevel = 'high';
    }
    
    return this.profiles[tier][autoLevel];
  }

  // Get adaptive profile based on runtime conditions
  getAdaptiveProfile(tier: MobileTier): MobileQualityProfile {
    const deviceCap = this.deviceCapabilities.getCapabilities();
    const baseProfile = this.getProfile(tier, 'auto');

    // Apply battery-aware adjustments
    if (deviceCap.currentBatteryLevel !== null) {
      if (deviceCap.currentBatteryLevel < 30) {
        // Low battery: downgrade to ultra-low
        return this.getProfile(tier, 'ultra-low');
      } else if (deviceCap.currentBatteryLevel < 50) {
        // Medium battery: stay at low or medium
        const currentLevel = baseProfile.level;
        if (currentLevel === 'high') {
          return this.getProfile(tier, 'medium');
        }
      }
    }

    // Apply thermal throttling adjustments
    if (deviceCap.isThermallyThrottled) {
      return this.getProfile(tier, 'ultra-low');
    }

    return baseProfile;
  }
}
```

---

## Phase 3: Mobile Touch Interaction Service

### File: `/home/cdom/saas/dimasite/src/app/core/services/mobile-touch-interaction.service.ts`

```typescript
import { Injectable, signal } from '@angular/core';

export interface TouchEvent {
  type: 'tap' | 'double-tap' | 'long-press' | 'scroll';
  x: number;
  y: number;
  timestamp: number;
  force: number;
  radius: number;
  touches: number;
}

export interface TouchGesture {
  type: 'swipe' | 'pinch' | 'rotate' | 'pan';
  deltaX: number;
  deltaY: number;
  distance: number;
  angle: number;
  scale: number;
  touches: number;
  timestamp: number;
}

@Injectable({
  providedIn: 'root'
})
export class MobileTouchInteractionService {
  readonly isTouchDevice = signal(false);
  readonly lastTouch = signal<TouchEvent | null>(null);
  readonly activeGestures = signal<TouchGesture[]>([]);
  readonly touchLatency = signal<number>(0);

  private touchHistory: TouchEvent[] = [];
  private maxHistorySize = 10;
  private tapThreshold = 200; // ms
  private longPressThreshold = 500; // ms
  private swipeThreshold = 30; // pixels
  private lastTapTime = 0;

  constructor() {
    this.detectTouchCapability();
    if (this.isTouchDevice()) {
      this.setupTouchListeners();
    }
  }

  private detectTouchCapability(): void {
    this.isTouchDevice.set('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }

  private setupTouchListeners(): void {
    const element = document.documentElement;

    element.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: true });
    element.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: true });
    element.addEventListener('touchend', this.onTouchEnd.bind(this));
    element.addEventListener('touchcancel', this.onTouchCancel.bind(this));
  }

  private onTouchStart(event: TouchEvent): void {
    const touches = Array.from(event.touches);
    const timestamp = event.timeStamp;
    
    touches.forEach(touch => {
      this.touchHistory.push({
        type: 'tap',
        x: touch.clientX,
        y: touch.clientY,
        timestamp,
        force: touch.force || 0,
        radius: touch.radius || 0,
        touches: event.touches.length
      });
    });

    // Trim history
    if (this.touchHistory.length > this.maxHistorySize) {
      this.touchHistory = this.touchHistory.slice(-this.maxHistorySize);
    }

    this.lastTouch.set({
      type: 'tap',
      x: touches[0]?.clientX || 0,
      y: touches[0]?.clientY || 0,
      timestamp,
      force: touches[0]?.force || 0,
      radius: touches[0]?.radius || 0,
      touches: event.touches.length
    });

    // Measure touch latency
    this.touchLatency.set(100); // Base latency for touch start
  }

  private onTouchMove(event: TouchEvent): void {
    const touches = Array.from(event.touches);
    const timestamp = event.timeStamp;

    // Detect gestures
    this.detectGestures(touches, timestamp);
  }

  private onTouchEnd(event: TouchEvent): void {
    const timestamp = event.timeStamp;
    const lastTouch = this.lastTouch();

    if (!lastTouch) return;

    // Check for tap
    const timeDiff = timestamp - lastTouch.timestamp;
    if (timeDiff < this.tapThreshold) {
      // Update as tap event
      this.touchHistory.push({
        ...lastTouch,
        timestamp
      });

      // Check for double-tap
      const tapHistory = this.touchHistory.filter(e => e.type === 'tap');
      if (tapHistory.length >= 2) {
        const lastTwoTaps = tapHistory.slice(-2);
        const lastTapDiff = lastTwoTaps[1].timestamp - lastTwoTaps[0].timestamp;
        if (lastTapDiff < this.tapThreshold && lastTapDiff > 0) {
          // Double-tap detected
          this.touchHistory.push({
            type: 'double-tap',
            x: lastTouch.x,
            y: lastTouch.y,
            timestamp
          });
        }
      }
    } else {
      // Long-press detected
      this.touchHistory.push({
        ...lastTouch,
        type: 'long-press',
        timestamp
      });
    }

    this.lastTouch.set(null);
    this.touchHistory = [];
  }

  private onTouchCancel(event: TouchEvent): void {
    this.lastTouch.set(null);
    this.touchHistory = [];
    this.activeGestures.set([]);
  }

  private detectGestures(touches: TouchEvent[], timestamp: number): void {
    const gestures: TouchGesture[] = [];
    const history = this.touchHistory.slice(-5); // Last 5 events

    // Detect swipe
    if (history.length >= 2) {
      const dx = touches[0].clientX - history[0].x;
      const dy = touches[0].clientY - history[0].y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > this.swipeThreshold) {
        const angle = Math.atan2(dy, dx) * (180 / Math.PI);
        
        gestures.push({
          type: 'swipe',
          deltaX: dx,
          deltaY: dy,
          distance,
          angle,
          touches: touches.length,
          timestamp
        });
      }
    }

    // Detect pinch
    if (touches.length === 2) {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      const currentDistance = Math.sqrt(dx * dx + dy * dy);

      // Compare with history to detect zoom
      if (history.length >= 2 && history[0].type === 'pinch') {
        const lastDistance = Math.sqrt(
          Math.pow(history[0].x - history[0].y, 2) +
          Math.pow(history[0].deltaX, 2)
        );

        gestures.push({
          type: 'pinch',
          distance: currentDistance,
          scale: currentDistance / lastDistance,
          touches: 2,
          timestamp
        });
      }
    }

    if (gestures.length > 0) {
      this.activeGestures.set(gestures);
    }
  }

  // Public API

  isTouch(): boolean {
    return this.isTouchDevice();
  }

  getLastTouch(): TouchEvent | null {
    return this.lastTouch();
  }

  getActiveGestures(): TouchGesture[] {
    return this.activeGestures();
  }

  getTouchHistory(): TouchEvent[] {
    return this.touchHistory;
  }

  getEstimatedLatency(): number {
    return 100; // Touch typically has higher latency
  }
}
```

---

## Phase 4: Mobile Power Management Service

### File: `/home/cdom/saas/dimasite/src/app/core/services/mobile-power-management.service.ts`

```typescript
import { Injectable, signal } from '@angular/core';

export type PowerMode = 'auto' | 'max-savings' | 'balanced' | 'performance';
export type ThermalState = 'normal' | 'warm' | 'hot' | 'critical';

export interface PowerMetrics {
  thermalState: ThermalState;
  frameTimeMs: number;
  droppedFrames: number;
  currentFps: number;
  batteryLevel: number;
  isCharging: boolean;
  estimatedDrainRate: number;
}

@Injectable({
  providedIn: 'root'
})
export class MobilePowerManagementService {
  readonly powerMode = signal<PowerMode>('auto');
  readonly thermalState = signal<ThermalState>('normal');
  readonly powerMetrics = signal<PowerMetrics>({
    thermalState: 'normal',
    frameTimeMs: 16,
    droppedFrames: 0,
    currentFps: 60,
    batteryLevel: 100,
    isCharging: false,
    estimatedDrainRate: 0
  });

  private frameHistory: number[] = [];
  private historySize = 120; // 2 seconds at 60fps
  private thermalFrameCount = 0;
  private batteryHistory: { level: number; timestamp: number }[] = [];
  private batteryHistorySize = 60; // 60 seconds

  // Thermal throttling detection
  private thermalThresholds = {
    warm: 22, // ms
    hot: 28, // ms
    critical: 33 // ms
  };

  // Battery detection thresholds
  private batteryDrainThresholds = {
    fast: 1.0, // % per minute
    normal: 0.5, // % per minute
    slow: 0.1 // % per minute
  };

  constructor() {
    this.setupThermalMonitoring();
    this.setupBatteryMonitoring();
  }

  private setupThermalMonitoring(): void {
    // Measure frame time continuously
    setInterval(() => {
      this.checkThermalState();
    }, 1000);
  }

  private checkThermalState(): void {
    const metrics = this.powerMetrics();
    const currentThermal = metrics.thermalState;
    
    // Calculate average frame time from history
    if (this.frameHistory.length < 10) return;
    
    const avgFrameTime = this.frameHistory.reduce((sum, time) => sum + time, 0) / this.frameHistory.length;

    // Determine thermal state
    let newThermal: ThermalState = 'normal';
    
    if (avgFrameTime > this.thermalThresholds.critical) {
      newThermal = 'critical';
    } else if (avgFrameTime > this.thermalThresholds.hot) {
      newThermal = 'hot';
    } else if (avgFrameTime > this.thermalThresholds.warm) {
      newThermal = 'warm';
    }

    if (newThermal !== currentThermal) {
      this.thermalState.set(newThermal);
      this.thermalFrameCount++;

      // If critical for extended time, force power mode
      if (newThermal === 'critical' && this.thermalFrameCount > 5) {
        this.powerMode.set('max-savings');
      }
    }
  }

  private setupBatteryMonitoring(): void {
    const batteryAPI = 'getBattery' in navigator;
    
    if (!batteryAPI) {
      return;
    }

    const battery = navigator.getBattery();
    battery.then((batteryManager) => {
      const updateBattery = () => {
        const level = Math.round(batteryManager.level * 100);
        const charging = batteryManager.charging;

        this.powerMetrics.update(metrics => ({
          ...metrics,
          batteryLevel: level,
          isCharging: charging
        }));

        // Calculate drain rate
        this.calculateDrainRate();

        // Adjust power mode based on battery
        this.adjustPowerModeForBattery(level, charging);
      };

      batteryManager.addEventListener('levelchange', updateBattery);
      batteryManager.addEventListener('chargingchange', updateBattery);
      updateBattery();
    });
  }

  private calculateDrainRate(): void {
    const metrics = this.powerMetrics();
    const history = this.batteryHistory;
    
    if (history.length < 2) return;

    const recent = history[history.length - 1];
    const previous = history[history.length - 2];

    const timeDiff = (recent.timestamp - previous.timestamp) / 60000; // Convert to minutes
    const levelDiff = previous.level - recent.level;

    if (timeDiff > 0) {
      const drainRate = Math.abs(levelDiff) / timeDiff;
      
      this.powerMetrics.update(metrics => ({
        ...metrics,
        estimatedDrainRate
      }));
    }
  }

  private adjustPowerModeForBattery(level: number, charging: boolean): void {
    const currentMode = this.powerMode();
    
    if (currentMode !== 'auto') {
      return; // Don't override manual mode
    }

    if (charging) {
      // When charging, can use higher power modes
      if (level > 80) {
        this.powerMode.set('performance');
      } else if (level > 50) {
        this.powerMode.set('balanced');
      } else {
        this.powerMode.set('max-savings');
      }
    } else {
      // When on battery, be more conservative
      if (level < 20) {
        this.powerMode.set('max-savings');
      } else if (level < 40) {
        this.powerMode.set('balanced');
      } else {
        this.powerMode.set('performance');
      }
    }
  }

  recordFrame(frameTimeMs: number): void {
    this.frameHistory.push(frameTimeMs);
    
    if (this.frameHistory.length > this.historySize) {
      this.frameHistory = this.frameHistory.slice(-this.historySize);
    }

    // Update power metrics
    const currentFps = 1000 / frameTimeMs;
    const previousFps = this.powerMetrics().currentFps;

    this.powerMetrics.update(metrics => ({
      ...metrics,
      frameTimeMs,
      currentFps,
      droppedFrames: previousFps - currentFps > 20 ? metrics.droppedFrames + 1 : metrics.droppedFrames
    }));
  }

  // Public API

  shouldDowngradeQuality(): boolean {
    const powerMode = this.powerMode();
    const thermalState = this.thermalState();
    const batteryLevel = this.powerMetrics().batteryLevel;
    const frameTime = this.powerMetrics().frameTimeMs;

    // Downgrade if:
    // 1. Thermal state is hot or critical
    // 2. Battery is very low (<20%)
    // 3. Frame time exceeds budget
    // 4. In max-savings mode

    return thermalState === 'hot' || 
           thermalState === 'critical' || 
           batteryLevel < 20 ||
           frameTime > 33 ||
           powerMode === 'max-savings';
  }

  shouldUpgradeQuality(): boolean {
    const powerMode = this.powerMode();
    const thermalState = this.thermalState();
    const batteryLevel = this.powerMetrics().batteryLevel;

    // Upgrade if:
    // 1. Thermal state is normal
    // 2. Battery is good (>60% and charging)
    // 3. Frame time is well within budget
    // 4. In performance mode

    return thermalState === 'normal' && 
           batteryLevel > 60 &&
           this.powerMetrics().frameTimeMs < 20 &&
           powerMode === 'performance';
  }

  getPowerMode(): PowerMode {
    return this.powerMode();
  }

  setPowerMode(mode: PowerMode): void {
    this.powerMode.set(mode);
  }

  getPowerMetrics(): PowerMetrics {
    return this.powerMetrics();
  }

  isPowerCritical(): boolean {
    return this.powerMetrics().batteryLevel < 10 || 
           this.thermalState() === 'critical' ||
           this.powerMetrics().frameTimeMs > 50;
  }
}
```

---

## Implementation Order

### Week 1 - Foundation

1. **Day 1-2**: MobileDeviceCapabilitiesService
   - Comprehensive device detection
   - GPU vendor detection
   - Mobile tier classification
   - Touch/haptics support detection

2. **Day 3-4**: MobileQualityProfilesService
   - Mobile-specific quality profiles
   - Battery-aware quality selection
   - Thermal throttling awareness
   - Network-aware quality selection

3. **Day 5-7**: MobileTouchInteractionService
   - Touch event handling
   - Gesture detection (swipe, pinch)
   - Double-tap detection
   - Long-press detection
   - Touch latency measurement

4. **Day 8-10**: MobilePowerManagementService
   - Thermal state monitoring
   - Battery drain tracking
   - Power mode management
   - Frame budget enforcement
   - Quality up/down triggers

### Week 2 - Integration

5. **Day 1-3**: Integrate with existing ThreeQualityService
   - Update quality service to use mobile profiles
   - Add mobile-specific adjustments
   - Test on actual mobile devices

6. **Day 4-5**: Update Three.js components
   - Apply mobile quality settings to hero orb
   - Apply mobile quality settings to particles
   - Add touch interaction handling
   - Add power mode awareness

7. **Day 6-7**: Testing & Optimization
   - Test on entry-level mobile devices
   - Test on mid-range mobile devices
   - Test on flagship mobile devices
   - Profile and optimize performance
   - Verify battery savings

---

## Mobile Quality Decision Matrix

| Scenario | Tier | Battery | Thermal | Network | Quality | FPS Target | Reason |
|----------|-------|---------|----------|---------|-----------|--------|
| Normal | Entry | >50% | Normal | Fast | Low | 28 | Balanced experience |
| Normal | Entry | 20-50% | Normal | Fast | Ultra-Low | 25 | Save battery |
| Normal | Entry | <20% | Normal | Slow | Ultra-Low | 22 | Save battery |
| Normal | Entry | Any | Warm | Any | Ultra-Low | 22 | Prevent thermal |
| Normal | Mid | >50% | Normal | Fast | Medium | 35 | Good mobile experience |
| Normal | Mid | 20-50% | Normal | Fast | Low | 30 | Save battery |
| Normal | Mid | <20% | Normal | Slow | Low | 28 | Save battery |
| Normal | Mid | Any | Hot | Any | Low | 28 | Prevent thermal |
| Normal | Flagship | >50% | Normal | Fast | High | 50+ | Best mobile experience |
| Normal | Flagship | 20-50% | Normal | Fast | Medium | 40 | Save battery |
| Normal | Flagship | <20% | Normal | Slow | Medium | 35 | Save battery |
| Normal | Flagship | Any | Warm | Any | Medium | 45 | Prevent thermal |
| Gaming | Entry | Any | Normal | Any | Medium | 30 | Boost for gameplay |

---

## Mobile Performance Benchmarks

| Device Category | Target FPS | Acceptable FPS | Min FPS | Max Memory | Particle Count | Texture Size |
|----------------|-----------|----------------|---------|-----------|---------------|---------------|
| Entry Mobile | 25-28 | 22+ | 20 | <50MB | 50-80 | 256px |
| Entry Mobile (gaming) | 30-32 | 28+ | 25 | <50MB | 80-100 | 512px |
| Mid Mobile | 35-40 | 32+ | 30 | <80MB | 150-200 | 512px |
| Mid Mobile (gaming) | 45-50 | 40+ | 35 | <80MB | 200-250 | 1024px |
| Flagship Mobile | 50-60 | 45+ | 40 | <120MB | 300-400 | 1024px |
| Flagship (gaming) | 60 | 55+ | 50 | <120MB | 400-500 | 2048px |

---

## Testing Strategy

### Mobile Device Testing Matrix

| Device | Screen | RAM | GPU | Expected Quality | FPS Target |
|--------|--------|-----|-----|----------------|-----------|
| iPhone SE | 375x667 | 3GB | PowerVR G6200 | Ultra-Low | 25 |
| iPhone 12 | 390x844 | 4GB | Apple A13 | Low | 30 |
| iPhone 14 Pro | 430x932 | 6GB | Apple A16 | Medium | 45 |
| Android Low-end | 360x640 | 2GB | Adreno 505 | Ultra-Low | 25 |
| Android Mid | 390x852 | 4GB | Adreno 640 | Low-Medium | 30-35 |
| Android Flagship | 428x926 | 8GB | Adreno 740 | High | 50+ |

### Performance Testing Checklist

- [ ] Test on actual devices, not just emulation
- [ ] Measure FPS across all device tiers
- [ ] Profile battery drain with Three.js active
- [ ] Test thermal throttling scenarios
- [ ] Test touch gestures (swipe, pinch, double-tap)
- [ ] Test quality up/down transitions
- [ ] Test network awareness (slow/fast connections)
- [ ] Test reduced motion preference
- [ ] Test in different mobile browsers (Chrome, Safari, Firefox)
- [ ] Test with various battery levels (100%, 50%, 20%, 10%)
- [ ] Verify memory doesn't grow unbounded
- [ ] Test background rendering (tab switching)
- [ ] Test device lock scenario

---

## Battery Optimization Strategies

### Mobile-Specific Optimizations

1. **Reduce Vertex Count**
   - Use instanced rendering for repeated geometry
   - Use low-poly meshes (fewer vertices)
   - Merge similar geometries

2. **Simplify Shaders**
   - Remove complex calculations
   - Use fixed-point math where possible
   - Avoid conditional branches in fragment shaders
   - Use LDR textures instead of HDR

3. **Texture Optimization**
   - Use lower resolution textures on mobile
   - Use texture compression (ASTC/ETC2 for Android)
   - Limit texture memory usage
   - Use texture atlases to reduce draw calls

4. **Rendering Optimizations**
   - Disable expensive post-processing on battery
   - Reduce particle count when battery low
   - Use occlusion culling (frustum culling)
   - Limit draw calls per frame
   - Use requestAnimationFrame efficiently

5. **Idle Optimization**
   - Reduce frame rate when tab is hidden
   - Pause animations when screen is locked
   - Reduce quality when in background
   - Stop rendering when not visible (IntersectionObserver)

---

## Files to Create

### Phase 1 - Core Services
- `/home/cdom/saas/dimasite/src/app/core/services/mobile-device-capabilities.service.ts` (450 lines)
- `/home/cdom/saas/dimasite/src/app/core/services/mobile-quality-profiles.service.ts` (320 lines)
- `/home/cdom/saas/dimasite/src/app/core/services/mobile-touch-interaction.service.ts` (280 lines)
- `/home/cdom/saas/dimasite/src/app/core/services/mobile-power-management.service.ts` (350 lines)

### Phase 2 - Integration
- Update `/home/cdom/saas/dimasite/src/app/core/services/three-quality.service.ts` to integrate mobile profiles

**Total: 4 new services + 1 updated service**

---

## Integration Checklist

Before considering mobile quality system complete, verify:

✅ Mobile device detection works across all tested devices
✅ GPU vendor detection is accurate for common mobile GPUs
✅ Mobile tier classification is reasonable
✅ Touch interaction service detects gestures correctly
✅ Power management tracks battery drain accurately
✅ Thermal state detection prevents device overheating
✅ Quality profiles are appropriate for each mobile tier
✅ Battery-aware quality adjustments work correctly
✅ Thermal throttling triggers quality downgrades
✅ Network awareness adjusts quality based on connection
✅ Reduced motion preference is respected
✅ Touch latency is measured and accounted for
✅ Power mode can be overridden manually
✅ System works without impacting desktop performance
✅ Quality transitions are smooth and not disruptive
✅ Mobile-specific optimizations don't break desktop functionality
✅ Memory usage stays within limits on mobile
✅ FPS targets are met for each device category
✅ Battery drain is reasonable and predictable

---

## Questions for Implementation

1. **Ultra Quality:** Should we offer "ultra" quality for flagship mobile users, or cap at "high"?
2. **Gaming Mode:** Should there be a separate "gaming" power mode that maximizes performance regardless of battery?
3. **Quality Indicator:** Should there be a visible quality indicator in the UI showing current mobile quality level?
4. **User Override:** Should users be able to manually select their preferred quality mode with trade-offs explained?
5. **Debug Mode:** Should there be a verbose logging mode for debugging quality decisions on mobile?
6. **Fallback Behavior:** What should happen if mobile detection fails? Default to low quality or disable 3D?
7. **Performance Alerts:** Should there be visual alerts when performance is critically low (thermal/battery)?
8. **Background Rendering:** Should we pause rendering entirely when tab is hidden, or just reduce FPS?
9. **Quality Persistence:** Should user's quality preference be saved to localStorage?
10. **Testing Devices:** Should we focus on specific devices (iPhone vs Android) or cover the range?

---

## Success Criteria

✅ Mobile device detection classifies devices correctly (entry/mid/flagship)
✅ GPU vendor detection identifies common mobile GPUs accurately
✅ Mobile quality profiles provide 4 distinct quality levels per mobile tier
✅ Touch interaction service handles all common mobile gestures
✅ Power management tracks battery level and thermal state
✅ Quality automatically downgrades when battery is low or device is hot
✅ Quality automatically upgrades when conditions improve
✅ Network awareness adjusts quality based on connection type
✅ Reduced motion preference forces appropriate quality settings
✅ User can manually override quality mode if desired
✅ FPS targets are met on all device categories
✅ Memory usage is controlled and doesn't grow unbounded
✅ Battery drain is tracked and managed
✅ Thermal throttling is detected and responded to
✅ System doesn't negatively impact desktop performance
✅ Touch latency is measured and optimizations are applied
✅ Quality transitions are smooth and don't cause jarring visual changes
✅ System respects all user preferences (motion, data, contrast)
✅ Mobile-specific optimizations are applied without breaking functionality
✅ System provides clear feedback about power and performance state

---

## Notes for Builder AI

1. **Mobile-First Testing:** Test extensively on actual mobile devices, not just Chrome DevTools device emulation
2. **Real Device Variety:** Test across different mobile GPUs (Adreno, Mali, Apple GPU)
3. **Battery Testing:** Test with various battery levels (100%, 50%, 20%, 10%)
4. **Thermal Testing:** Allow device to heat up and verify thermal throttling works
5. **Network Testing:** Test with slow 3G/4G connections
6. **Performance Profiling:** Use Chrome DevTools Performance tab extensively on mobile
7. **Memory Profiling:** Monitor WebGL memory usage on mobile devices
8. **Touch Testing:** Test all touch gestures on real devices
9. **Cross-Browser:** Test on Safari (iOS), Chrome (Android), Firefox (Android)
10. **Ask Questions:** If any mobile scenario is unclear, ask for clarification
11. **Be Conservative:** It's better to have lower quality that's smooth than higher quality that janks
12. **Document Decisions:** Explain why quality was adjusted in comments for future reference
13. **Test in Context:** Test while device is charging and discharging
14. **Background Behavior:** Verify tab switching behavior and background rendering
15. **Battery Realism:** Don't over-estimate battery savings, be realistic

---

## Next Steps After Mobile Quality System

Once mobile quality system is complete and tested, next implementation plan should cover:

1. **Login Page** - Handle Twitch OAuth callback
2. **Logout Page** - Clear session
3. **Authenticated Layout** - Navbar, sidebar, theme/language toggles
4. **Dashboard** - ECharts integration, live analytics

---

Good luck implementing Three.js mobile quality system! 📱⚡
