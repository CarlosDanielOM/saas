import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  inject,
  viewChild
} from '@angular/core';
import * as THREE from 'three';

import { ThreeQualityHelperService } from '../../core/services/three-quality-helper.service';
import { ThreeQualityService } from '../../core/services/three-quality.service';

@Component({
  selector: 'app-dashboard-ambient',
  template: '<canvas #canvas class="dashboard-ambient__canvas" aria-hidden="true"></canvas>',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true'
  }
})
export class DashboardAmbientComponent implements AfterViewInit, OnDestroy {
  private readonly hostRef = inject(ElementRef<HTMLElement>);
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly qualityService = inject(ThreeQualityService);
  private readonly qualityHelper = inject(ThreeQualityHelperService);

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private cyanCloud: THREE.Points | null = null;
  private violetCloud: THREE.Points | null = null;
  private frameId = 0;
  private resizeObserver: ResizeObserver | null = null;

  ngAfterViewInit(): void {
    if (!this.qualityService.enabled() || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const canvas = this.canvasRef().nativeElement;
    const host = this.hostRef.nativeElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
    this.camera.position.set(0, 0, 9.2);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: this.qualityService.getRendererAntialias(),
      powerPreference: 'high-performance'
    });
    this.qualityHelper.applyQualityToRenderer(this.renderer);

    this.cyanCloud = this.createCloud(
      this.qualityService.getMaxParticles(440),
      '#8b5cf6',
      0.042,
      0.64,
      2.6,
      4.8
    );
    this.violetCloud = this.createCloud(
      this.qualityService.getMaxParticles(280),
      '#7c3aed',
      0.03,
      0.56,
      1.9,
      4.2
    );

    if (this.cyanCloud) {
      this.scene.add(this.cyanCloud);
    }

    if (this.violetCloud) {
      this.scene.add(this.violetCloud);
    }

    this.onResize();
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(host);
    this.animate();
  }

  ngOnDestroy(): void {
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
    }

    this.resizeObserver?.disconnect();

    this.disposePoints(this.cyanCloud);
    this.disposePoints(this.violetCloud);
    this.renderer?.dispose();

    this.cyanCloud = null;
    this.violetCloud = null;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
  }

  private animate = () => {
    if (!this.scene || !this.camera || !this.renderer) {
      return;
    }

    this.frameId = requestAnimationFrame(this.animate);

    if (this.cyanCloud) {
      this.cyanCloud.rotation.y += 0.00085;
      this.cyanCloud.rotation.x += 0.00024;
    }

    if (this.violetCloud) {
      this.violetCloud.rotation.y -= 0.00062;
      this.violetCloud.rotation.x += 0.00018;
    }

    this.renderer.render(this.scene, this.camera);
  };

  private createCloud(
    count: number,
    color: string,
    size: number,
    opacity: number,
    minRadius: number,
    maxRadius: number
  ): THREE.Points {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);

    for (let i = 0; i < count; i += 1) {
      const radius = minRadius + Math.random() * (maxRadius - minRadius);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = radius * Math.cos(phi);
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color,
      size,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    return new THREE.Points(geometry, material);
  }

  private disposePoints(points: THREE.Points | null): void {
    if (!points) {
      return;
    }

    points.geometry.dispose();
    const material = points.material;
    if (material instanceof THREE.Material) {
      material.dispose();
    }
  }

  private onResize(): void {
    if (!this.renderer || !this.camera) {
      return;
    }

    const host = this.hostRef.nativeElement;
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.qualityService.getPixelRatio());
    this.renderer.setSize(width, height, false);
  }
}
