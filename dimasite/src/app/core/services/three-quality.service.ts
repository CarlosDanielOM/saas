import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import * as THREE from 'three';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export type QualityMode = 'auto' | 'manual';
export type AntialiasMode = 'none' | 'fxaa' | 'msaa4' | 'msaa8';

export interface QualityProfile {
  level: QualityLevel;
  antialias: AntialiasMode;
  pixelRatioLimit: number;
  shadows: false | THREE.ShadowMapType;
  maxParticles: number;
  shaderQuality: 'basic' | 'standard' | 'advanced';
  postProcessing: boolean;
  targetFps: number;
  textureResolution: number;
}

export interface PerformanceMetrics {
  currentFps: number;
  averageFps: number;
  frameTime: number;
  droppedFrames: number;
  memoryUsage: number;
  targetFps: number;
  timestamp: number;
}

interface DeviceCapabilities {
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  isLowEnd: boolean;
  prefersReducedMotion: boolean;
  prefersReducedData: boolean;
  pixelRatio: number;
}

type MobileTier = 'entry' | 'mid' | 'flagship' | 'none';
type ConnectionQuality = 'slow' | 'medium' | 'fast' | 'unknown';
type ThermalState = 'normal' | 'warm' | 'hot';

interface MobileContext {
  tier: MobileTier;
  batteryLevel: number | null;
  isCharging: boolean;
  connection: ConnectionQuality;
  isPageVisible: boolean;
  thermalState: ThermalState;
}

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize: number;
  };
}

interface NavigatorWithDeviceMemory extends Navigator {
  deviceMemory?: number;
}

interface BatteryManagerLite {
  level: number;
  charging: boolean;
  addEventListener(type: 'levelchange' | 'chargingchange', listener: () => void): void;
  removeEventListener(type: 'levelchange' | 'chargingchange', listener: () => void): void;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManagerLite>;
}

interface NetworkInformationLite extends EventTarget {
  effectiveType?: string;
  type?: string;
  saveData?: boolean;
}

interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformationLite;
  mozConnection?: NetworkInformationLite;
  webkitConnection?: NetworkInformationLite;
}

@Injectable({
  providedIn: 'root'
})
export class ThreeQualityService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly storageModeKey = 'three-quality-mode';
  private readonly storageLevelKey = 'three-quality-level';
  private readonly storageEnabledKey = 'three-quality-enabled';

  readonly qualityMode = signal<QualityMode>(this.getStoredMode());
  readonly manualQuality = signal<QualityLevel>(this.getStoredLevel());
  readonly enabled = signal<boolean>(this.getStoredEnabled());

  private readonly adaptiveQuality = signal<QualityLevel>('medium');
  private readonly capabilities = this.detectCapabilities();
  private readonly mobileContext = signal<MobileContext>(this.detectInitialMobileContext());

  private readonly qualityPresets: Record<QualityLevel, QualityProfile> = {
    low: {
      level: 'low',
      antialias: 'none',
      pixelRatioLimit: 1,
      shadows: false,
      maxParticles: 150,
      shaderQuality: 'basic',
      postProcessing: false,
      targetFps: 30,
      textureResolution: 0.5
    },
    medium: {
      level: 'medium',
      antialias: 'fxaa',
      pixelRatioLimit: 1.5,
      shadows: THREE.PCFSoftShadowMap,
      maxParticles: 350,
      shaderQuality: 'standard',
      postProcessing: true,
      targetFps: 45,
      textureResolution: 0.75
    },
    high: {
      level: 'high',
      antialias: 'msaa4',
      pixelRatioLimit: 2,
      shadows: THREE.PCFSoftShadowMap,
      maxParticles: 600,
      shaderQuality: 'advanced',
      postProcessing: true,
      targetFps: 60,
      textureResolution: 1
    },
    ultra: {
      level: 'ultra',
      antialias: 'msaa8',
      pixelRatioLimit: 3,
      shadows: THREE.VSMShadowMap,
      maxParticles: 1000,
      shaderQuality: 'advanced',
      postProcessing: true,
      targetFps: 60,
      textureResolution: 1.5
    }
  };

  readonly effectiveQuality = computed<QualityLevel>(() => {
    if (!this.enabled()) {
      return 'high';
    }
    return this.qualityMode() === 'manual' ? this.manualQuality() : this.adaptiveQuality();
  });

  readonly qualityProfile = computed<QualityProfile>(() => this.qualityPresets[this.effectiveQuality()]);

  readonly performanceMetrics = signal<PerformanceMetrics>({
    currentFps: 60,
    averageFps: 60,
    frameTime: 16.7,
    droppedFrames: 0,
    memoryUsage: 0,
    targetFps: 60,
    timestamp: performance.now()
  });

  private readonly fpsHistory: number[] = [];
  private animationFrameId = 0;
  private frameCount = 0;
  private frameWindowStart = performance.now();
  private lastQualityAdjustment = performance.now();
  private readonly qualityAdjustmentCooldownMs = 5000;

  constructor() {
    this.initializeQuality();
    this.startPerformanceMonitoring();
    this.setupRuntimeListeners();
    this.destroyRef.onDestroy(() => {
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
      }
    });
  }

  getQualityProfile(): QualityProfile {
    return this.qualityProfile();
  }

  getPerformanceMetrics(): PerformanceMetrics {
    return this.performanceMetrics();
  }

  getMaxParticles(baseCount: number): number {
    return Math.min(baseCount, this.qualityProfile().maxParticles);
  }

  getPixelRatio(): number {
    const mobile = this.mobileContext();
    const profileLimit = this.qualityProfile().pixelRatioLimit;
    const deviceLimit = mobile.tier === 'entry' ? 1 : mobile.tier === 'mid' ? 1.5 : profileLimit;
    return Math.min(this.capabilities.pixelRatio, profileLimit, deviceLimit);
  }

  getShadowMapSetting(): false | THREE.ShadowMapType {
    return this.qualityProfile().shadows;
  }

  isPostProcessingEnabled(): boolean {
    return this.qualityProfile().postProcessing;
  }

  getTextureResolution(): number {
    return this.qualityProfile().textureResolution;
  }

  getRendererAntialias(): boolean {
    return this.qualityProfile().antialias === 'msaa4' || this.qualityProfile().antialias === 'msaa8';
  }

  getRendererSamples(): number {
    const mode = this.qualityProfile().antialias;
    if (mode === 'msaa8') {
      return 8;
    }
    if (mode === 'msaa4') {
      return 4;
    }
    return 0;
  }

  isPerformanceDegraded(): boolean {
    const metrics = this.performanceMetrics();
    return metrics.averageFps < metrics.targetFps * 0.8;
  }

  setQuality(level: QualityLevel): void {
    this.manualQuality.set(level);
    this.qualityMode.set('manual');
    this.persistPreferences();
  }

  setQualityMode(mode: QualityMode): void {
    this.qualityMode.set(mode);
    if (mode === 'auto') {
      this.initializeQuality();
    }
    this.persistPreferences();
  }

  setEnabled(enabled: boolean): void {
    this.enabled.set(enabled);
    this.persistPreferences();
  }

  forcePerformanceCheck(): void {
    this.evaluatePerformanceAndAdjust(this.performanceMetrics().currentFps);
  }

  private initializeQuality(): void {
    const initial = this.selectInitialQuality();
    this.adaptiveQuality.set(initial);
  }

  private selectInitialQuality(): QualityLevel {
    if (this.capabilities.prefersReducedMotion || this.capabilities.prefersReducedData) {
      return 'low';
    }

    if (this.capabilities.isMobile) {
      const mobile = this.mobileContext();
      if (mobile.tier === 'flagship' && mobile.connection === 'fast' && this.isBatteryHealthy()) {
        return 'medium';
      }
      return 'low';
    }

    if (this.capabilities.isTablet || this.capabilities.isLowEnd) {
      return 'medium';
    }

    return 'high';
  }

  private startPerformanceMonitoring(): void {
    const tick = () => {
      if (!this.mobileContext().isPageVisible) {
        this.animationFrameId = requestAnimationFrame(tick);
        return;
      }

      this.frameCount += 1;
      const now = performance.now();
      const delta = now - this.frameWindowStart;

      if (delta >= 1000) {
        const fps = Math.round((this.frameCount * 1000) / delta);
        this.frameWindowStart = now;
        this.frameCount = 0;
        this.updatePerformanceMetrics(fps);
        this.evaluatePerformanceAndAdjust(fps);
      }

      this.animationFrameId = requestAnimationFrame(tick);
    };

    this.animationFrameId = requestAnimationFrame(tick);
  }

  private updatePerformanceMetrics(fps: number): void {
    this.fpsHistory.push(fps);
    if (this.fpsHistory.length > 60) {
      this.fpsHistory.shift();
    }

    const profile = this.qualityProfile();
    const averageFps = Math.round(this.fpsHistory.reduce((sum, value) => sum + value, 0) / this.fpsHistory.length);
    const frameTime = Number((1000 / Math.max(fps, 1)).toFixed(1));

    this.updateThermalState(frameTime);

    this.performanceMetrics.update((current) => ({
      currentFps: fps,
      averageFps,
      frameTime,
      droppedFrames: fps < profile.targetFps ? current.droppedFrames + 1 : current.droppedFrames,
      memoryUsage: this.estimateMemoryUsage(),
      targetFps: profile.targetFps,
      timestamp: performance.now()
    }));
  }

  private evaluatePerformanceAndAdjust(fps: number): void {
    if (!this.enabled() || this.qualityMode() !== 'auto') {
      return;
    }

    if (!this.mobileContext().isPageVisible) {
      return;
    }

    const now = performance.now();
    if (now - this.lastQualityAdjustment < this.qualityAdjustmentCooldownMs) {
      return;
    }

    const profile = this.qualityProfile();
    const current = this.adaptiveQuality();
    const recent = this.fpsHistory.slice(-10);
    const averageRecent = recent.length
      ? recent.reduce((sum, value) => sum + value, 0) / recent.length
      : fps;

    const downgradeThreshold = this.isMobileConstrained() ? 0.92 : 0.85;
    const upgradeThreshold = this.isMobileConstrained() ? 1.28 : 1.2;

    if (averageRecent < profile.targetFps * downgradeThreshold) {
      this.downgradeQuality(current);
      this.lastQualityAdjustment = now;
      return;
    }

    if (averageRecent > profile.targetFps * upgradeThreshold && this.fpsHistory.length >= 30 && this.calculateVariance() < 64) {
      this.upgradeQuality(current);
      this.lastQualityAdjustment = now;
    }
  }

  private downgradeQuality(current: QualityLevel): void {
    const levels: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
    const index = levels.indexOf(current);
    if (index > 0) {
      this.adaptiveQuality.set(levels[index - 1]);
    }
  }

  private upgradeQuality(current: QualityLevel): void {
    const levels: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
    const index = levels.indexOf(current);
    if (index < 0 || index >= levels.length - 1) {
      return;
    }

    const next = levels[index + 1];
    if (levels.indexOf(next) <= levels.indexOf(this.getDeviceMaxQuality())) {
      this.adaptiveQuality.set(next);
    }
  }

  private getDeviceMaxQuality(): QualityLevel {
    if (this.capabilities.prefersReducedMotion || this.capabilities.prefersReducedData) {
      return 'low';
    }

    if (this.capabilities.isMobile) {
      const mobile = this.mobileContext();
      if (!this.isBatteryHealthy() || mobile.connection === 'slow' || mobile.thermalState === 'hot') {
        return 'low';
      }

      if (mobile.tier === 'flagship') {
        return 'medium';
      }

      return 'low';
    }

    if (this.capabilities.isTablet || this.capabilities.isLowEnd) {
      return 'medium';
    }

    if (this.capabilities.isDesktop && !this.capabilities.isLowEnd && this.capabilities.pixelRatio >= 2) {
      return 'ultra';
    }

    return 'high';
  }

  private calculateVariance(): number {
    if (this.fpsHistory.length < 2) {
      return 0;
    }

    const mean = this.fpsHistory.reduce((sum, value) => sum + value, 0) / this.fpsHistory.length;
    return this.fpsHistory.reduce((sum, value) => sum + (value - mean) ** 2, 0) / this.fpsHistory.length;
  }

  private estimateMemoryUsage(): number {
    const memory = (performance as PerformanceWithMemory).memory;
    if (!memory) {
      return 0;
    }
    return Math.round(memory.usedJSHeapSize / 1048576);
  }

  private detectCapabilities(): DeviceCapabilities {
    const ua = navigator.userAgent;
    const isMobile = /Android|iPhone|iPod|Mobile/i.test(ua);
    const isTablet = /iPad|Tablet|Nexus 7|Nexus 10|Kindle/i.test(ua);
    const isDesktop = !isMobile && !isTablet;

    const deviceMemory = (navigator as NavigatorWithDeviceMemory).deviceMemory;
    const memory = typeof deviceMemory === 'number' ? deviceMemory : 4;
    const cores = typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : 4;
    const pixelRatio = window.devicePixelRatio || 1;

    return {
      isMobile,
      isTablet,
      isDesktop,
      isLowEnd: memory <= 4 || cores <= 4,
      prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      prefersReducedData: this.getMediaQueryMatches('(prefers-reduced-data: reduce)'),
      pixelRatio
    };
  }

  private detectInitialMobileContext(): MobileContext {
    const connection = this.getConnectionQuality();
    return {
      tier: this.detectMobileTier(),
      batteryLevel: null,
      isCharging: false,
      connection,
      isPageVisible: !document.hidden,
      thermalState: 'normal'
    };
  }

  private detectMobileTier(): MobileTier {
    if (!this.capabilities.isMobile) {
      return 'none';
    }

    const width = Math.min(window.screen.width, window.screen.height);
    const memory = (navigator as NavigatorWithDeviceMemory).deviceMemory ?? 4;
    const cores = navigator.hardwareConcurrency ?? 4;

    if (memory <= 3 || cores <= 4 || width <= 390) {
      return 'entry';
    }

    if (memory <= 6 || width < 430) {
      return 'mid';
    }

    return 'flagship';
  }

  private setupRuntimeListeners(): void {
    const reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reducedDataMedia = window.matchMedia('(prefers-reduced-data: reduce)');

    const onMotionChange = () => {
      this.capabilities.prefersReducedMotion = reducedMotionMedia.matches;
      this.initializeQualityIfAuto();
    };
    const onDataChange = () => {
      this.capabilities.prefersReducedData = reducedDataMedia.matches;
      this.initializeQualityIfAuto();
    };

    reducedMotionMedia.addEventListener('change', onMotionChange);
    reducedDataMedia.addEventListener('change', onDataChange);

    const onVisibilityChange = () => {
      this.mobileContext.update((current) => ({
        ...current,
        isPageVisible: !document.hidden
      }));
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const onResize = () => {
      this.mobileContext.update((current) => ({
        ...current,
        tier: this.detectMobileTier()
      }));
      this.initializeQualityIfAuto();
    };
    window.addEventListener('resize', onResize);

    this.setupBatteryListener();
    this.setupNetworkListener();

    this.destroyRef.onDestroy(() => {
      reducedMotionMedia.removeEventListener('change', onMotionChange);
      reducedDataMedia.removeEventListener('change', onDataChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('resize', onResize);
    });
  }

  private setupBatteryListener(): void {
    const navigatorWithBattery = navigator as NavigatorWithBattery;
    if (!navigatorWithBattery.getBattery) {
      return;
    }

    void navigatorWithBattery.getBattery().then((battery) => {
      const updateBattery = () => {
        this.mobileContext.update((current) => ({
          ...current,
          batteryLevel: Math.round(battery.level * 100),
          isCharging: battery.charging
        }));
        this.initializeQualityIfAuto();
      };

      battery.addEventListener('levelchange', updateBattery);
      battery.addEventListener('chargingchange', updateBattery);
      updateBattery();

      this.destroyRef.onDestroy(() => {
        battery.removeEventListener('levelchange', updateBattery);
        battery.removeEventListener('chargingchange', updateBattery);
      });
    });
  }

  private setupNetworkListener(): void {
    const navConnection = navigator as NavigatorWithConnection;
    const connection = navConnection.connection ?? navConnection.mozConnection ?? navConnection.webkitConnection;
    if (!connection) {
      return;
    }

    const updateConnection = () => {
      const mapped = this.mapConnectionType(connection);
      this.mobileContext.update((current) => ({
        ...current,
        connection: mapped
      }));
      this.initializeQualityIfAuto();
    };

    connection.addEventListener('change', updateConnection as EventListener);
    updateConnection();

    this.destroyRef.onDestroy(() => {
      connection.removeEventListener('change', updateConnection as EventListener);
    });
  }

  private mapConnectionType(connection: NetworkInformationLite): ConnectionQuality {
    const explicitSaveData = connection.saveData === true;
    if (explicitSaveData) {
      return 'slow';
    }

    const effectiveType = connection.effectiveType?.toLowerCase();
    if (effectiveType === 'slow-2g' || effectiveType === '2g' || effectiveType === '3g') {
      return 'slow';
    }
    if (effectiveType === '4g') {
      return 'medium';
    }

    const type = connection.type?.toLowerCase();
    if (type === 'wifi' || type === 'ethernet') {
      return 'fast';
    }

    return 'unknown';
  }

  private getConnectionQuality(): ConnectionQuality {
    const navConnection = navigator as NavigatorWithConnection;
    const connection = navConnection.connection ?? navConnection.mozConnection ?? navConnection.webkitConnection;
    if (!connection) {
      return 'unknown';
    }
    return this.mapConnectionType(connection);
  }

  private updateThermalState(frameTime: number): void {
    if (!this.capabilities.isMobile) {
      return;
    }

    const thermalState: ThermalState = frameTime >= 38 ? 'hot' : frameTime >= 28 ? 'warm' : 'normal';
    if (this.mobileContext().thermalState === thermalState) {
      return;
    }

    this.mobileContext.update((current) => ({
      ...current,
      thermalState
    }));
  }

  private isBatteryHealthy(): boolean {
    const mobile = this.mobileContext();
    if (mobile.batteryLevel === null) {
      return true;
    }
    if (mobile.isCharging) {
      return mobile.batteryLevel >= 15;
    }
    return mobile.batteryLevel >= 35;
  }

  private isMobileConstrained(): boolean {
    const mobile = this.mobileContext();
    return this.capabilities.isMobile && (
      mobile.connection === 'slow' ||
      !this.isBatteryHealthy() ||
      mobile.thermalState !== 'normal'
    );
  }

  private initializeQualityIfAuto(): void {
    if (this.qualityMode() === 'auto') {
      this.initializeQuality();
    }
  }

  private getMediaQueryMatches(query: string): boolean {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  }

  private getStoredMode(): QualityMode {
    const mode = localStorage.getItem(this.storageModeKey);
    return mode === 'manual' ? 'manual' : 'auto';
  }

  private getStoredLevel(): QualityLevel {
    const level = localStorage.getItem(this.storageLevelKey);
    if (level === 'low' || level === 'medium' || level === 'high' || level === 'ultra') {
      return level;
    }
    return 'high';
  }

  private getStoredEnabled(): boolean {
    const value = localStorage.getItem(this.storageEnabledKey);
    return value !== 'false';
  }

  private persistPreferences(): void {
    localStorage.setItem(this.storageModeKey, this.qualityMode());
    localStorage.setItem(this.storageLevelKey, this.manualQuality());
    localStorage.setItem(this.storageEnabledKey, String(this.enabled()));
  }
}
