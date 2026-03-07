import { Injectable, signal, computed } from '@angular/core';

type QualityTier = 'low' | 'medium' | 'high';

interface DeviceCapabilities {
  tier: QualityTier;
  supportsWebGL: boolean;
  supportsWebGL2: boolean;
  maxTextureSize: number;
  hardwareConcurrency: number;
  deviceMemory: number | undefined;
  isBatterySaving: boolean;
  prefersReducedMotion: boolean;
  isTouchDevice: boolean;
  pixelRatio: number;
}

@Injectable({
  providedIn: 'root'
})
export class DeviceCapabilityService {
  private readonly capabilities = signal<DeviceCapabilities | null>(null);

  readonly currentTier = computed(() => this.capabilities()?.tier ?? 'low');
  readonly supports3D = computed(() => {
    const caps = this.capabilities();
    if (!caps) return false;
    return caps.supportsWebGL && caps.tier !== 'low';
  });
  readonly shouldUseCSSFallback = computed(() => {
    const caps = this.capabilities();
    if (!caps) return true;
    return !caps.supportsWebGL || caps.tier === 'low' || caps.prefersReducedMotion;
  });

  constructor() {
    this.detectCapabilities();
  }

  private async detectCapabilities(): Promise<void> {
    const capabilities: DeviceCapabilities = {
      tier: 'low',
      supportsWebGL: false,
      supportsWebGL2: false,
      maxTextureSize: 0,
      hardwareConcurrency: navigator.hardwareConcurrency || 2,
      deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
      isBatterySaving: false,
      prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      isTouchDevice: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
      pixelRatio: Math.min(window.devicePixelRatio, 2)
    };

    // Detect WebGL support
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
    const gl2 = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    
    capabilities.supportsWebGL = !!gl;
    capabilities.supportsWebGL2 = !!gl2;
    
    if (gl) {
      capabilities.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    }

    // Check battery status
    try {
      if ('getBattery' in navigator) {
        const battery = await (navigator as unknown as { getBattery(): Promise<{ charging: boolean; level: number }> }).getBattery();
        capabilities.isBatterySaving = !battery.charging && battery.level < 0.2;
      }
    } catch {
      // Battery API not available
    }

    // Determine quality tier
    capabilities.tier = this.calculateTier(capabilities);
    
    this.capabilities.set(capabilities);
  }

  private calculateTier(caps: DeviceCapabilities): QualityTier {
    // Force low tier for reduced motion or battery saving
    if (caps.prefersReducedMotion || caps.isBatterySaving) {
      return 'low';
    }

    // Force low tier if no WebGL
    if (!caps.supportsWebGL) {
      return 'low';
    }

    // Check for low-end indicators
    const isLowEnd = 
      caps.hardwareConcurrency <= 2 ||
      (caps.deviceMemory !== undefined && caps.deviceMemory <= 4) ||
      caps.maxTextureSize < 4096 ||
      caps.isTouchDevice;

    if (isLowEnd) {
      return 'medium';
    }

    // Check for high-end indicators
    const isHighEnd = 
      caps.supportsWebGL2 &&
      caps.hardwareConcurrency >= 8 &&
      (caps.deviceMemory === undefined || caps.deviceMemory >= 8) &&
      caps.maxTextureSize >= 8192 &&
      !caps.isTouchDevice;

    if (isHighEnd) {
      return 'high';
    }

    return 'medium';
  }

  getCapabilities(): DeviceCapabilities | null {
    return this.capabilities();
  }
}
