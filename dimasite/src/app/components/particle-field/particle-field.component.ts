import { Component, ElementRef, OnInit, OnDestroy, viewChild, ChangeDetectionStrategy, inject } from '@angular/core';
import * as THREE from 'three';
import { DeviceCapabilityService } from '../../services/device-capability.service';

@Component({
  selector: 'app-particle-field',
  template: `
    <div class="particle-container" #container></div>
  `,
  styles: `
    :host {
      display: block;
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      overflow: hidden;
    }
    .particle-container {
      width: 100%;
      height: 100%;
    }
    canvas {
      display: block;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ParticleFieldComponent implements OnInit, OnDestroy {
  private readonly container = viewChild<ElementRef>('container');
  private readonly deviceCapabilities = inject(DeviceCapabilityService);

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private particles!: THREE.Points;
  private animationId!: number;
  private mouseX = 0;
  private mouseY = 0;
  private targetMouseX = 0;
  private targetMouseY = 0;
  private isTouchDevice = false;

  ngOnInit(): void {
    this.isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.initThreeJS();
    this.createParticles();
    this.animate();
    if (!this.isTouchDevice) {
      this.setupMouseTracking();
    }
  }

  ngOnDestroy(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('resize', this.onResize);
  }

  private initThreeJS(): void {
    const container = this.container()?.nativeElement;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    this.camera.position.z = 50;

    const isMobile = this.isTouchDevice || window.innerWidth < 768;
    const pixelRatio = isMobile
      ? Math.min(window.devicePixelRatio, 1.5)
      : Math.min(window.devicePixelRatio, 2);

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: !isMobile,
      powerPreference: isMobile ? 'low-power' : 'high-performance'
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(pixelRatio);
    container.appendChild(this.renderer.domElement);

    window.addEventListener('resize', this.onResize);
  }

  private createParticles(): void {
    const isMobile = this.isTouchDevice || window.innerWidth < 768;
    const particleCount = isMobile ? 25 : 60;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const sizes = new Float32Array(particleCount);

    const color1 = new THREE.Color(0x7c3aed);
    const color2 = new THREE.Color(0x3b82f6);

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 100;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 100;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 50;

      const mixRatio = Math.random();
      const mixedColor = color1.clone().lerp(color2, mixRatio);
      colors[i * 3] = mixedColor.r;
      colors[i * 3 + 1] = mixedColor.g;
      colors[i * 3 + 2] = mixedColor.b;

      sizes[i] = Math.random() * 2 + 0.5;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 }
      },
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        uniform float time;
        
        void main() {
          vColor = color;
          vec3 pos = position;
          pos.y += sin(time * 0.5 + position.x * 0.1) * 2.0;
          pos.x += cos(time * 0.3 + position.y * 0.1) * 1.0;
          
          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          gl_PointSize = size * (300.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        
        void main() {
          float dist = distance(gl_PointCoord, vec2(0.5));
          if (dist > 0.5) discard;
          
          float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
          alpha *= 0.6;
          
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      transparent: true,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambientLight);
  }

  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);

    if (this.particles) {
      const isMobile = this.isTouchDevice || window.innerWidth < 768;
      const rotationSpeed = isMobile ? 0.00015 : 0.0003;
      const materialSpeed = isMobile ? 0.005 : 0.01;

      this.particles.rotation.y += rotationSpeed;
      this.particles.rotation.x += rotationSpeed * 0.5;

      if (!isMobile) {
        this.mouseX += (this.targetMouseX - this.mouseX) * 0.05;
        this.mouseY += (this.targetMouseY - this.mouseY) * 0.05;
        this.particles.rotation.x += (this.mouseY * 0.0001 - this.particles.rotation.x) * 0.02;
        this.particles.rotation.y += (this.mouseX * 0.0001 - this.particles.rotation.y) * 0.02;
      }

      const material = this.particles.material as THREE.ShaderMaterial;
      material.uniforms['time'].value += materialSpeed;
    }

    this.renderer.render(this.scene, this.camera);
  };

  private setupMouseTracking(): void {
    window.addEventListener('mousemove', this.onMouseMove);
  }

  private onMouseMove = (event: MouseEvent): void => {
    this.targetMouseX = event.clientX - window.innerWidth / 2;
    this.targetMouseY = event.clientY - window.innerHeight / 2;
  };

  private onResize = (): void => {
    const container = this.container()?.nativeElement;
    if (!container) return;
    
    const width = container.clientWidth;
    const height = container.clientHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };
}
