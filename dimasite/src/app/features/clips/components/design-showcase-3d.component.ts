import { 
  Component, 
  ElementRef, 
  OnInit, 
  OnDestroy, 
  viewChild, 
  ChangeDetectionStrategy, 
  inject,
  input,
  output,
  effect,
  signal
} from '@angular/core';
import * as THREE from 'three';
import { ClipDesign } from '../clips.model';

interface Card3D {
  mesh: THREE.Mesh;
  originalY: number;
  floatOffset: number;
  rotationSpeed: number;
  design: ClipDesign;
}

@Component({
  selector: 'app-design-showcase-3d',
  template: `
    <div class="showcase-container" #container></div>
    <div class="design-overlay">
      <div class="design-info" [class.visible]="hoveredDesign()">
        @if (hoveredDesign()) {
          <div class="info-content" @infoEnter>
            <h3 class="design-title">{{ hoveredDesign()!.name }}</h3>
            <p class="design-desc">{{ hoveredDesign()!.description }}</p>
            <div class="design-features">
              @for (feature of hoveredDesign()!.features; track feature) {
                <span class="feature-tag">{{ feature }}</span>
              }
            </div>
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 400px;
      overflow: hidden;
    }

    .showcase-container {
      width: 100%;
      height: 100%;
      cursor: pointer;
    }

    canvas {
      display: block;
    }

    .design-overlay {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 2rem;
      background: linear-gradient(to top, rgba(0,0,0,0.8), transparent);
      pointer-events: none;
    }

    .design-info {
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.5s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .design-info.visible {
      opacity: 1;
      transform: translateY(0);
    }

    .info-content {
      max-width: 600px;
    }

    .design-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: white;
      margin: 0 0 0.5rem 0;
      text-shadow: 0 2px 10px rgba(0,0,0,0.5);
    }

    .design-desc {
      font-size: 0.95rem;
      color: rgba(255,255,255,0.8);
      margin: 0 0 1rem 0;
      line-height: 1.5;
    }

    .design-features {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .feature-tag {
      padding: 0.25rem 0.75rem;
      background: rgba(124, 58, 237, 0.3);
      border: 1px solid rgba(124, 58, 237, 0.5);
      border-radius: 9999px;
      font-size: 0.75rem;
      color: white;
      backdrop-filter: blur(4px);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DesignShowcase3DComponent implements OnInit, OnDestroy {
  private readonly container = viewChild<ElementRef>('container');
  
  readonly designs = input.required<ClipDesign[]>();
  readonly selectedDesignId = input<string | null>(null);
  readonly designSelect = output<ClipDesign>();
  
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private cards: Card3D[] = [];
  private animationId!: number;
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private hoveredCard: Card3D | null = null;
  
  hoveredDesign = signal<ClipDesign | null>(null);

  constructor() {
    effect(() => {
      const selectedId = this.selectedDesignId();
      this.updateCardHighlights(selectedId);
    });
  }

  ngOnInit(): void {
    this.initThreeJS();
    this.createCards();
    this.animate();
    this.setupInteraction();
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
    window.removeEventListener('click', this.onClick);
  }

  private initThreeJS(): void {
    const container = this.container()?.nativeElement;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    this.scene = new THREE.Scene();
    this.scene.background = null;

    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    this.camera.position.set(0, 0, 8);

    const isMobile = window.innerWidth < 768;
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: !isMobile,
      powerPreference: isMobile ? 'low-power' : 'high-performance'
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    // Add directional light
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 5, 5);
    this.scene.add(dirLight);

    // Add point lights for drama
    const pointLight1 = new THREE.PointLight(0x7c3aed, 1, 20);
    pointLight1.position.set(-5, 3, 2);
    this.scene.add(pointLight1);

    const pointLight2 = new THREE.PointLight(0x3b82f6, 1, 20);
    pointLight2.position.set(5, -3, 2);
    this.scene.add(pointLight2);

    window.addEventListener('resize', this.onResize);
  }

  private createCards(): void {
    const designs = this.designs();
    const cardWidth = 2.5;
    const cardHeight = 3.5;
    const spacing = 3.5;
    const totalWidth = (designs.length - 1) * spacing;
    const startX = -totalWidth / 2;

    designs.forEach((design, index) => {
      // Create card geometry
      const geometry = new THREE.BoxGeometry(cardWidth, cardHeight, 0.1);
      
      // Create materials for each face
      const materials = this.createCardMaterials(design);
      
      const mesh = new THREE.Mesh(geometry, materials);
      mesh.position.set(startX + index * spacing, 0, 0);
      mesh.rotation.y = (index - 1) * 0.2;
      
      this.scene.add(mesh);
      
      this.cards.push({
        mesh,
        originalY: 0,
        floatOffset: Math.random() * Math.PI * 2,
        rotationSpeed: 0.002 + Math.random() * 0.002,
        design
      });
    });
  }

  private createCardMaterials(design: ClipDesign): THREE.Material[] {
    const color = new THREE.Color(design.accentColor);
    
    // Create canvas texture for the front face
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 716;
    const ctx = canvas.getContext('2d')!;
    
    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, 512, 716);
    gradient.addColorStop(0, design.accentColor + '20');
    gradient.addColorStop(1, '#1a1a2e');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 716);
    
    // Border
    ctx.strokeStyle = design.accentColor;
    ctx.lineWidth = 8;
    ctx.strokeRect(20, 20, 472, 676);
    
    // Design number
    ctx.fillStyle = 'white';
    ctx.font = 'bold 120px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`D${design.designNumber}`, 256, 200);
    
    // Title
    ctx.font = 'bold 48px sans-serif';
    ctx.fillText(design.name, 256, 350);
    
    // Status badge
    ctx.fillStyle = design.status === 'stable' ? '#22c55e' : 
                    design.status === 'beta' ? '#3b82f6' : '#eab308';
    ctx.font = 'bold 32px sans-serif';
    ctx.fillText(design.status.toUpperCase(), 256, 450);
    
    // Premium badge
    if (design.premium || design.premiumPlus) {
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText('★ PREMIUM', 256, 550);
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    
    const sideMaterial = new THREE.MeshStandardMaterial({
      color: color,
      metalness: 0.3,
      roughness: 0.4
    });
    
    const frontMaterial = new THREE.MeshStandardMaterial({
      map: texture,
      metalness: 0.1,
      roughness: 0.3
    });
    
    // [right, left, top, bottom, front, back]
    return [
      sideMaterial, sideMaterial, sideMaterial, sideMaterial,
      frontMaterial, sideMaterial
    ];
  }

  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);
    
    const time = Date.now() * 0.001;
    
    this.cards.forEach((card, index) => {
      // Floating animation
      const floatY = Math.sin(time * 0.5 + card.floatOffset) * 0.3;
      card.mesh.position.y = card.originalY + floatY;
      
      // Gentle rotation
      if (card !== this.hoveredCard) {
        card.mesh.rotation.y += card.rotationSpeed;
      }
      
      // Selection highlight
      const isSelected = card.design.id === this.selectedDesignId();
      if (isSelected) {
        card.mesh.scale.setScalar(1.1 + Math.sin(time * 3) * 0.02);
        card.mesh.position.z = 1;
      } else if (card === this.hoveredCard) {
        card.mesh.scale.setScalar(1.05);
        card.mesh.position.z = 0.5;
      } else {
        card.mesh.scale.setScalar(1);
        card.mesh.position.z = 0;
      }
    });
    
    this.renderer.render(this.scene, this.camera);
  };

  private setupInteraction(): void {
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('click', this.onClick);
  }

  private onMouseMove = (event: MouseEvent): void => {
    const container = this.container()?.nativeElement;
    if (!container) return;
    
    const rect = container.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.cards.map(c => c.mesh));
    
    if (intersects.length > 0) {
      const intersectedMesh = intersects[0].object as THREE.Mesh;
      const card = this.cards.find(c => c.mesh === intersectedMesh);
      
      if (card && card !== this.hoveredCard) {
        this.hoveredCard = card;
        this.hoveredDesign.set(card.design);
        document.body.style.cursor = 'pointer';
        
        // Dramatic hover effect - tilt towards mouse
        gsap.to(card.mesh.rotation, {
          x: this.mouse.y * 0.3,
          y: this.mouse.x * 0.3 + (parseInt(card.design.id) - 2) * 0.2,
          duration: 0.5,
          ease: 'power2.out'
        });
      }
    } else {
      if (this.hoveredCard) {
        // Reset rotation
        gsap.to(this.hoveredCard.mesh.rotation, {
          x: 0,
          y: (parseInt(this.hoveredCard.design.id) - 2) * 0.2,
          duration: 0.5,
          ease: 'power2.out'
        });
        
        this.hoveredCard = null;
        this.hoveredDesign.set(null);
        document.body.style.cursor = 'default';
      }
    }
  };

  private onClick = (): void => {
    if (this.hoveredCard) {
      this.designSelect.emit(this.hoveredCard.design);
    }
  };

  private updateCardHighlights(selectedId: string | null): void {
    this.cards.forEach(card => {
      const isSelected = card.design.id === selectedId;
      if (isSelected) {
        gsap.to(card.mesh.position, {
          z: 1,
          duration: 0.5,
          ease: 'back.out(1.7)'
        });
      }
    });
  }

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

// Simple gsap-like animation helper
const gsap = {
  to: (target: any, props: { [key: string]: any, duration: number, ease?: string }) => {
    const start: { [key: string]: number } = {};
    const keys = Object.keys(props).filter(k => k !== 'duration' && k !== 'ease');
    
    keys.forEach(key => {
      start[key] = target[key];
    });
    
    const startTime = Date.now();
    const duration = props.duration * 1000;
    
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      
      keys.forEach(key => {
        target[key] = start[key] + (props[key] - start[key]) * eased;
      });
      
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    
    requestAnimationFrame(animate);
  }
};
