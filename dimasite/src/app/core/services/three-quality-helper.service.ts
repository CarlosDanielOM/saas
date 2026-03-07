import { Injectable, inject } from '@angular/core';
import * as THREE from 'three';
import { ThreeQualityService } from './three-quality.service';

@Injectable({
  providedIn: 'root'
})
export class ThreeQualityHelperService {
  private readonly qualityService = inject(ThreeQualityService);

  applyQualityToRenderer(renderer: THREE.WebGLRenderer): void {
    const profile = this.qualityService.getQualityProfile();

    renderer.setPixelRatio(this.qualityService.getPixelRatio());
    renderer.shadowMap.enabled = profile.shadows !== false;
    if (profile.shadows !== false) {
      renderer.shadowMap.type = profile.shadows;
    }

    renderer.toneMapping = profile.postProcessing ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = profile.postProcessing ? 1 : 0.95;
  }

  createOptimizedMaterial<T extends THREE.Material>(baseMaterial: T): T {
    const profile = this.qualityService.getQualityProfile();
    const material = baseMaterial.clone() as T;

    if (material instanceof THREE.MeshStandardMaterial) {
      if (profile.shaderQuality === 'basic') {
        material.roughness = 1;
        material.metalness = 0;
      }

      if (profile.shaderQuality === 'standard') {
        material.roughness = Math.min(material.roughness, 0.8);
      }
    }

    return material;
  }

  shouldEnablePostProcessing(): boolean {
    return this.qualityService.isPostProcessingEnabled();
  }

  getMaxTextureSize(baseSize: number): number {
    return Math.round(baseSize * this.qualityService.getTextureResolution());
  }

  notifyPerformanceIssue(): void {
    this.qualityService.forcePerformanceCheck();
  }
}
