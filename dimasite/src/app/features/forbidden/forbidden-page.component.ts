import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  signal,
  viewChild
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { DeviceCapabilityService } from '../../services/device-capability.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';

type ThreeModule = typeof import('three');
type SceneMode = 'rings' | 'prisms' | 'grid';
type DashboardLink = ['/', string, 'dashboard'] | ['/'];

interface PermissionRing {
  mesh: import('three').Mesh;
  speed: number;
  axis: 'x' | 'y' | 'z';
}

interface GateBar {
  mesh: import('three').Mesh;
  pulseOffset: number;
  baseY: number;
}

interface PrismShard {
  mesh: import('three').Mesh;
  rotationAxis: import('three').Vector3;
  rotationSpeed: number;
  floatOffset: number;
  originalY: number;
  hueOffset: number;
}

interface GridBand {
  mesh: import('three').Mesh;
  speed: number;
  pulseOffset: number;
}

@Component({
  selector: 'app-forbidden-page',
  imports: [RouterLink],
  templateUrl: './forbidden-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ForbiddenPageComponent implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly deviceCapability = inject(DeviceCapabilityService);
  private readonly languageService = inject(LanguageService);
  private readonly sessionAuth = inject(SessionAuthService);
  private readonly shellRef = viewChild.required<ElementRef<HTMLElement>>('shell');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  readonly session = this.sessionAuth.session;
  readonly lastViewedStreamer = this.sessionAuth.lastViewedStreamer;
  readonly qualityTier = computed(() => this.deviceCapability.currentTier());
  readonly shouldUseCSSFallback = computed(() => this.deviceCapability.shouldUseCSSFallback());
  readonly isThreeJsReady = signal(false);
  readonly sceneMode = signal<SceneMode>(this.pickSceneMode());
  readonly particleIndexes = Array.from({ length: 14 }, (_, index) => index);
  readonly isEmbeddedLayout = signal(Boolean(this.route.snapshot.data['embeddedLayout']));
  readonly streamer = signal(this.resolveStreamer());
  readonly requestedPermission = signal(
    this.route.snapshot.queryParamMap.get('permission') ??
      (this.route.snapshot.data['previewPermission'] as string | undefined) ??
      ''
  );
  readonly requestedRoute = signal(this.route.snapshot.queryParamMap.get('from') ?? '');
  readonly isAdminViewer = computed(() => Boolean(this.session()?.appUser.administrating.length));
  readonly showPermissionBadge = computed(
    () => Boolean(this.requestedPermission()) && (this.isAdminViewer() || !this.isEmbeddedLayout())
  );
  readonly ownDashboardStreamer = computed(() => {
    const current = this.session();
    if (!current) {
      return '';
    }

    const channelID = current.appUser.twitch_user_id || current.twitchUser.id;
    return this.sessionAuth.toRouteStreamer(channelID);
  });
  readonly ownDashboardLink = computed<DashboardLink>(() => {
    const streamer = this.ownDashboardStreamer();
    return streamer ? ['/', streamer, 'dashboard'] : ['/'];
  });
  readonly ownDashboardName = computed(() => {
    const current = this.session();
    if (!current) {
      return '';
    }

    return current.twitchUser.display_name?.trim() || current.twitchUser.login?.trim() || '';
  });
  readonly lastViewedDashboardStreamer = computed(() => {
    const current = this.session();
    const lastViewed = this.lastViewedStreamer()?.trim().toLowerCase() ?? '';
    if (!current || !lastViewed) {
      return '';
    }

    const ownerLogin = current.twitchUser.login?.trim().toLowerCase() || '';
    const ownerChannelID = current.appUser.twitch_user_id?.trim().toLowerCase() || '';
    if (lastViewed === ownerLogin || lastViewed === ownerChannelID) {
      return lastViewed;
    }

    const isManagedChannel = current.appUser.administrating.some((entry) => {
      const channelName = entry.channelName?.trim().toLowerCase() || '';
      const channelID = entry.channelID?.trim().toLowerCase() || '';
      return lastViewed === channelName || lastViewed === channelID;
    });

    return isManagedChannel ? lastViewed : '';
  });
  readonly hasSeparateLastViewedDashboard = computed(() => {
    const lastViewed = this.lastViewedDashboardStreamer();
    const ownDashboard = this.ownDashboardStreamer();
    return Boolean(lastViewed) && lastViewed !== ownDashboard;
  });
  readonly lastViewedDashboardLink = computed<DashboardLink>(() => {
    const streamer = this.lastViewedDashboardStreamer();
    return streamer ? ['/', streamer, 'dashboard'] : ['/'];
  });
  readonly lastViewedDashboardName = computed(() =>
    this.resolveDashboardName(this.lastViewedDashboardStreamer())
  );
  readonly primaryActionLink = computed<DashboardLink>(() => {
    const routeStreamer = this.streamer().trim();
    if (routeStreamer) {
      return ['/', routeStreamer, 'dashboard'];
    }

    const ownDashboardStreamer = this.ownDashboardStreamer();
    return ownDashboardStreamer ? ['/', ownDashboardStreamer, 'dashboard'] : ['/'];
  });
  readonly primaryActionLabelKey = computed(() =>
    this.session() || this.streamer() ? 'forbidden.actions.dashboard' : 'forbidden.actions.home'
  );
  readonly messageKey = computed(() =>
    this.session() && this.isAdminViewer() && this.hasSeparateLastViewedDashboard()
      ? 'forbidden.messageAdminAuthenticated'
      : 'forbidden.message'
  );

  private three: ThreeModule | null = null;
  private renderer: import('three').WebGLRenderer | null = null;
  private scene: import('three').Scene | null = null;
  private camera: import('three').PerspectiveCamera | null = null;
  private sceneRoot: import('three').Group | null = null;
  private animationFrameId: number | null = null;
  private capabilityCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private time = 0;

  private readonly geometries: import('three').BufferGeometry[] = [];
  private readonly materials: import('three').Material[] = [];
  private readonly pulseLights: import('three').PointLight[] = [];
  private readonly rings: PermissionRing[] = [];
  private readonly gateBars: GateBar[] = [];
  private readonly prisms: PrismShard[] = [];
  private readonly gridBands: GridBand[] = [];

  private ambientParticles: import('three').Points | null = null;
  private ambientParticlePositions: Float32Array | null = null;
  private ambientParticleBasePositions: Float32Array | null = null;
  private prismDust: import('three').Points | null = null;
  private gridPlanes: Array<import('three').Mesh> = [];
  private shieldCore: import('three').Mesh | null = null;

  private readonly handleResizeBound = () => {
    this.handleResize();
  };

  ngAfterViewInit(): void {
    this.waitForCapabilities();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  t(key: string, params?: Record<string, string | number>): string {
    return this.languageService.translate(key, params);
  }

  primaryDashboardLabel(): string {
    const routeName = this.resolveDashboardName(this.streamer());
    const ownName = this.ownDashboardName();
    const name = routeName || ownName;
    return name
      ? this.t('forbidden.actions.dashboardNamed', { name })
      : this.t(this.primaryActionLabelKey());
  }

  lastViewedDashboardLabel(): string {
    const name = this.lastViewedDashboardName();
    return name
      ? this.t('forbidden.actions.lastViewedDashboardNamed', { name })
      : this.t('forbidden.actions.lastViewedDashboard');
  }

  myDashboardLabel(): string {
    const name = this.ownDashboardName();
    return name
      ? this.t('forbidden.actions.myDashboardNamed', { name })
      : this.t('forbidden.actions.myDashboard');
  }

  requestedPermissionLabel(): string {
    return this.requestedPermission();
  }

  requestedRouteLabel(): string {
    const value = this.requestedRoute();
    if (!value) {
      return '';
    }

    return value.length > 54 ? `${value.slice(0, 51)}...` : value;
  }

  private resolveStreamer(): string {
    return (
      this.route.snapshot.paramMap.get('streamer') ??
      this.route.snapshot.parent?.paramMap.get('streamer') ??
      ''
    );
  }

  private resolveDashboardName(streamer: string): string {
    const current = this.session();
    const normalizedStreamer = streamer.trim().toLowerCase();
    if (!current || !normalizedStreamer) {
      return '';
    }

    const ownerLogin = current.twitchUser.login?.trim().toLowerCase() || '';
    const ownerChannelID = current.appUser.twitch_user_id?.trim().toLowerCase() || '';
    if (normalizedStreamer === ownerLogin || normalizedStreamer === ownerChannelID) {
      return current.twitchUser.display_name?.trim() || current.twitchUser.login?.trim() || streamer;
    }

    const managedChannel = current.appUser.administrating.find((entry) => {
      const channelName = entry.channelName?.trim().toLowerCase() || '';
      const channelID = entry.channelID?.trim().toLowerCase() || '';
      return normalizedStreamer === channelName || normalizedStreamer === channelID;
    });

    return managedChannel?.channelName?.trim() || streamer;
  }

  private waitForCapabilities(): void {
    const capabilities = this.deviceCapability.getCapabilities();
    if (!capabilities) {
      this.capabilityCheckTimer = setTimeout(() => this.waitForCapabilities(), 100);
      return;
    }

    if (this.shouldUseCSSFallback()) {
      return;
    }

    void this.initThreeScene();
  }

  private async initThreeScene(): Promise<void> {
    if (this.renderer || this.shouldUseCSSFallback()) {
      return;
    }

    this.three = await import('three');
    const THREE = this.three;
    const canvas = this.canvasRef().nativeElement;
    const tier = this.qualityTier();

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x04101c, 0.028);

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 120);
    this.camera.position.set(0, 0, 14.5);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: tier === 'high',
      alpha: true,
      powerPreference: tier === 'high' ? 'high-performance' : 'low-power'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier === 'high' ? 2 : 1.25));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x000000, 0);

    this.sceneRoot = new THREE.Group();
    this.sceneRoot.position.z = -1.2;
    this.scene.add(this.sceneRoot);

    this.createLights();
    this.createAmbientParticles(tier);

    switch (this.sceneMode()) {
      case 'rings':
        this.createRingsScene(tier);
        break;
      case 'prisms':
        this.createPrismsScene(tier);
        break;
      case 'grid':
        this.createGridScene(tier);
        break;
    }

    this.isThreeJsReady.set(true);
    window.addEventListener('resize', this.handleResizeBound);
    this.animate();
  }

  private pickSceneMode(): SceneMode {
    const modes: SceneMode[] = ['rings', 'prisms', 'grid'];
    return modes[Math.floor(Math.random() * modes.length)] ?? 'rings';
  }

  private createLights(): void {
    const THREE = this.three;
    if (!THREE || !this.scene) {
      return;
    }

    const ambient = new THREE.AmbientLight(0x12304d, 1.2);
    const cyan = new THREE.PointLight(0x38bdf8, 12, 34, 2);
    const blue = new THREE.PointLight(0x2563eb, 10, 30, 2);
    const gold = new THREE.PointLight(0xfbbf24, 8, 26, 2);
    const mist = new THREE.PointLight(0x93c5fd, 5, 24, 2);

    cyan.position.set(4.2, 2.2, 11);
    blue.position.set(-4.8, -1.8, 9.5);
    gold.position.set(0, -4.8, 8);
    mist.position.set(0, 4.6, 10);

    this.scene.add(ambient, cyan, blue, gold, mist);
    this.pulseLights.push(cyan, blue, gold);
  }

  private createAmbientParticles(tier: 'low' | 'medium' | 'high'): void {
    const THREE = this.three;
    if (!THREE || !this.sceneRoot) {
      return;
    }

    const particleCount = tier === 'high' ? 420 : tier === 'medium' ? 280 : 180;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const basePositions = new Float32Array(particleCount * 3);

    for (let index = 0; index < particleCount; index += 1) {
      const offset = index * 3;
      const radius = 6 + Math.random() * 17;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI;

      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.cos(phi) * 0.55;
      const z = radius * Math.sin(phi) * Math.sin(theta);

      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = z;
      basePositions[offset] = x;
      basePositions[offset + 1] = y;
      basePositions[offset + 2] = z;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: 0x7dd3fc,
      size: tier === 'high' ? 0.06 : 0.08,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.ambientParticles = new THREE.Points(geometry, material);
    this.ambientParticles.rotation.x = 0.28;
    this.sceneRoot.add(this.ambientParticles);
    this.geometries.push(geometry);
    this.materials.push(material);
    this.ambientParticlePositions = positions;
    this.ambientParticleBasePositions = basePositions;
  }

  private createRingsScene(tier: 'low' | 'medium' | 'high'): void {
    const THREE = this.three;
    if (!THREE || !this.sceneRoot) {
      return;
    }

    const ringConfigs = [
      { radius: 2.8, tube: 0.06, color: 0x38bdf8, axis: 'x' as const, speed: 0.006 },
      { radius: 3.9, tube: 0.035, color: 0x2563eb, axis: 'y' as const, speed: -0.0048 },
      { radius: 5.1, tube: 0.028, color: 0xfbbf24, axis: 'z' as const, speed: 0.0035 }
    ];

    for (const config of ringConfigs) {
      const geometry = new THREE.TorusGeometry(config.radius, config.tube, 20, 180);
      const material = new THREE.MeshBasicMaterial({
        color: config.color,
        transparent: true,
        opacity: 0.3
      });
      const mesh = new THREE.Mesh(geometry, material);
      if (config.axis === 'x') {
        mesh.rotation.x = 1.18;
      }
      if (config.axis === 'y') {
        mesh.rotation.y = 0.92;
      }
      if (config.axis === 'z') {
        mesh.rotation.x = 1.56;
        mesh.rotation.y = 0.3;
      }

      this.sceneRoot.add(mesh);
      this.rings.push({ mesh, speed: config.speed, axis: config.axis });
      this.geometries.push(geometry);
      this.materials.push(material);
    }

    const coreGeometry = new THREE.SphereGeometry(1.35, 30, 30);
    const coreMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x0f3b66,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.26,
      roughness: 0.18,
      metalness: 0.28,
      transmission: 0.24,
      thickness: 0.7,
      transparent: true,
      opacity: 0.9
    });
    this.shieldCore = new THREE.Mesh(coreGeometry, coreMaterial);
    this.sceneRoot.add(this.shieldCore);
    this.geometries.push(coreGeometry);
    this.materials.push(coreMaterial);

    const barGeometry = new THREE.BoxGeometry(0.14, 1.7, 0.14);
    this.geometries.push(barGeometry);
    const barCount = tier === 'high' ? 20 : 14;
    for (let index = 0; index < barCount; index += 1) {
      const material = new THREE.MeshStandardMaterial({
        color: index % 4 === 0 ? 0xfbbf24 : 0x7dd3fc,
        emissive: index % 4 === 0 ? 0x7c5a10 : 0x12304d,
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.82,
        metalness: 0.45,
        roughness: 0.28
      });
      const mesh = new THREE.Mesh(barGeometry, material);
      const angle = (index / barCount) * Math.PI * 2;
      const radius = 6.2;
      const baseY = (Math.random() - 0.5) * 2.2;
      mesh.position.set(Math.cos(angle) * radius, baseY, Math.sin(angle) * radius * 0.38);
      mesh.rotation.z = angle;
      this.sceneRoot.add(mesh);
      this.gateBars.push({ mesh, pulseOffset: Math.random() * Math.PI * 2, baseY });
      this.materials.push(material);
    }
  }

  private createPrismsScene(tier: 'low' | 'medium' | 'high'): void {
    const THREE = this.three;
    if (!THREE || !this.sceneRoot) {
      return;
    }

    const prismCount = tier === 'high' ? 15 : tier === 'medium' ? 10 : 7;
    const geometries = [
      new THREE.OctahedronGeometry(0.7, 0),
      new THREE.TetrahedronGeometry(0.86, 0),
      new THREE.IcosahedronGeometry(0.56, 0)
    ];
    this.geometries.push(...geometries);

    for (let index = 0; index < prismCount; index += 1) {
      const geometry = geometries[index % geometries.length];
      const material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color().setHSL(0.57 + Math.random() * 0.07, 0.78, 0.62),
        metalness: 0.14,
        roughness: 0.1,
        transmission: tier === 'high' ? 0.45 : 0.18,
        thickness: 0.8,
        emissive: new THREE.Color(0x12304d),
        emissiveIntensity: 0.26,
        transparent: true,
        opacity: 0.9
      });
      const mesh = new THREE.Mesh(geometry, material);
      const angle = (index / prismCount) * Math.PI * 2;
      const radius = 2.6 + Math.random() * 4.4;
      const y = (Math.random() - 0.5) * 4;

      mesh.position.set(
        Math.cos(angle) * radius,
        y,
        Math.sin(angle) * radius * 0.58 - Math.random() * 1.7
      );
      mesh.scale.setScalar(0.72 + Math.random() * 0.94);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

      this.sceneRoot.add(mesh);
      this.prisms.push({
        mesh,
        rotationAxis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        rotationSpeed: 0.004 + Math.random() * 0.008,
        floatOffset: Math.random() * Math.PI * 2,
        originalY: y,
        hueOffset: Math.random() * 0.05
      });
      this.materials.push(material);
    }

    const dustGeometry = new THREE.BufferGeometry();
    const dustCount = tier === 'high' ? 110 : 70;
    const dustPositions = new Float32Array(dustCount * 3);
    for (let index = 0; index < dustPositions.length; index += 1) {
      dustPositions[index] = (Math.random() - 0.5) * 15;
    }
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
    const dustMaterial = new THREE.PointsMaterial({
      color: 0xbfdbfe,
      size: tier === 'high' ? 0.08 : 0.1,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.prismDust = new THREE.Points(dustGeometry, dustMaterial);
    this.sceneRoot.add(this.prismDust);
    this.geometries.push(dustGeometry);
    this.materials.push(dustMaterial);
  }

  private createGridScene(tier: 'low' | 'medium' | 'high'): void {
    const THREE = this.three;
    if (!THREE || !this.sceneRoot) {
      return;
    }

    const planeGeometry = new THREE.PlaneGeometry(15, 15, tier === 'high' ? 14 : 10, tier === 'high' ? 14 : 10);
    const planeMaterialA = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.16
    });
    const planeMaterialB = new THREE.MeshBasicMaterial({
      color: 0x2563eb,
      wireframe: true,
      transparent: true,
      opacity: 0.12
    });

    const planeA = new THREE.Mesh(planeGeometry, planeMaterialA);
    planeA.rotation.x = 1.18;
    planeA.position.y = -1.6;
    const planeB = new THREE.Mesh(planeGeometry, planeMaterialB);
    planeB.rotation.x = 1.38;
    planeB.rotation.y = 0.22;
    planeB.position.y = 1.2;
    planeB.position.z = -1.8;

    this.sceneRoot.add(planeA, planeB);
    this.gridPlanes = [planeA, planeB];
    this.geometries.push(planeGeometry);
    this.materials.push(planeMaterialA, planeMaterialB);

    const bandConfigs = [
      { radius: 2.3, tube: 0.05, color: 0x7dd3fc, speed: 0.007 },
      { radius: 3.6, tube: 0.03, color: 0x2563eb, speed: -0.005 },
      { radius: 4.8, tube: 0.028, color: 0xfbbf24, speed: 0.0038 }
    ];
    for (const config of bandConfigs) {
      const geometry = new THREE.TorusGeometry(config.radius, config.tube, 16, 180);
      const material = new THREE.MeshBasicMaterial({
        color: config.color,
        transparent: true,
        opacity: 0.32
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = 1.56;
      mesh.rotation.y = Math.random() * Math.PI * 0.4;
      this.sceneRoot.add(mesh);
      this.gridBands.push({ mesh, speed: config.speed, pulseOffset: Math.random() * Math.PI * 2 });
      this.geometries.push(geometry);
      this.materials.push(material);
    }

    const coreGeometry = new THREE.CylinderGeometry(0.85, 1.05, 1.8, 18, 1, true);
    const coreMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x12304d,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.22,
      roughness: 0.18,
      metalness: 0.44,
      transmission: 0.18,
      transparent: true,
      opacity: 0.88
    });
    this.shieldCore = new THREE.Mesh(coreGeometry, coreMaterial);
    this.sceneRoot.add(this.shieldCore);
    this.geometries.push(coreGeometry);
    this.materials.push(coreMaterial);

    const columnGeometry = new THREE.BoxGeometry(0.18, 3.1, 0.18);
    this.geometries.push(columnGeometry);
    for (let index = 0; index < 8; index += 1) {
      const material = new THREE.MeshStandardMaterial({
        color: index % 2 === 0 ? 0x7dd3fc : 0xfbbf24,
        emissive: 0x12304d,
        emissiveIntensity: 0.26,
        transparent: true,
        opacity: 0.78,
        metalness: 0.38,
        roughness: 0.26
      });
      const mesh = new THREE.Mesh(columnGeometry, material);
      const x = -5.2 + index * 1.5;
      const baseY = (Math.random() - 0.5) * 1.2;
      mesh.position.set(x, baseY, -0.7 + Math.sin(index) * 0.7);
      this.sceneRoot.add(mesh);
      this.gateBars.push({ mesh, pulseOffset: Math.random() * Math.PI * 2, baseY });
      this.materials.push(material);
    }
  }

  private animate(): void {
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }

    this.time += 0.016;
    this.updateShellPulse();
    this.animateAmbientParticles();

    switch (this.sceneMode()) {
      case 'rings':
        this.animateRingsScene();
        break;
      case 'prisms':
        this.animatePrismsScene();
        break;
      case 'grid':
        this.animateGridScene();
        break;
    }

    if (this.sceneRoot) {
      this.sceneRoot.rotation.y += 0.0014;
      this.sceneRoot.rotation.x = Math.sin(this.time * 0.16) * 0.04;
    }

    this.camera.position.x = Math.sin(this.time * 0.18) * 0.44;
    this.camera.position.y = Math.cos(this.time * 0.14) * 0.32;
    this.camera.position.z = 14.2 + Math.sin(this.time * 0.1) * 0.28;
    this.camera.lookAt(0, 0, 0);

    this.renderer.render(this.scene, this.camera);
    this.animationFrameId = requestAnimationFrame(() => this.animate());
  }

  private updateShellPulse(): void {
    const shell = this.shellRef().nativeElement;
    const beat = (Math.sin(this.time * 1.3) + 1) / 2;
    const shield = Math.pow(Math.max(0, Math.sin(this.time * 1.9 + 0.7)), 4);
    const gold = (Math.sin(this.time * 0.86 + 0.5) + 1) / 2;

    shell.style.setProperty('--forbidden-cyan-glow', (0.24 + beat * 0.42 + shield * 0.18).toFixed(4));
    shell.style.setProperty('--forbidden-gold-glow', (0.12 + gold * 0.28).toFixed(4));
    shell.style.setProperty('--forbidden-shield-scale', (1 + shield * 0.018).toFixed(4));
    shell.style.setProperty('--forbidden-shield-rise', `${(-shield * 4.2).toFixed(2)}px`);
  }

  private animateAmbientParticles(): void {
    if (!this.ambientParticles || !this.ambientParticlePositions || !this.ambientParticleBasePositions) {
      return;
    }

    for (let index = 0; index < this.ambientParticlePositions.length; index += 3) {
      const waveSeed = this.time * 0.72 + index * 0.015;
      this.ambientParticlePositions[index] = this.ambientParticleBasePositions[index] + Math.sin(waveSeed) * 0.12;
      this.ambientParticlePositions[index + 1] = this.ambientParticleBasePositions[index + 1] + Math.cos(waveSeed * 1.08) * 0.16;
      this.ambientParticlePositions[index + 2] = this.ambientParticleBasePositions[index + 2] + Math.sin(waveSeed * 0.66) * 0.1;
    }

    this.ambientParticles.geometry.attributes['position'].needsUpdate = true;
    this.ambientParticles.rotation.y -= 0.0006;
  }

  private animateRingsScene(): void {
    const time = this.time;

    this.rings.forEach((ring, index) => {
      ring.mesh.rotation[ring.axis] += ring.speed;
      const material = ring.mesh.material as import('three').MeshBasicMaterial;
      material.opacity = 0.18 + ((Math.sin(time * 2 + index) + 1) / 2) * 0.18;
    });

    this.gateBars.forEach((bar, index) => {
      const pulse = (Math.sin(time * 2.4 + bar.pulseOffset + index * 0.2) + 1) / 2;
      bar.mesh.position.y = bar.baseY + (pulse - 0.5) * 0.9;
      bar.mesh.scale.y = 0.78 + pulse * 0.48;
      const material = bar.mesh.material as import('three').MeshStandardMaterial;
      material.emissiveIntensity = 0.16 + pulse * 0.28;
    });

    if (this.shieldCore) {
      this.shieldCore.rotation.y += 0.004;
      this.shieldCore.scale.setScalar(0.96 + ((Math.sin(time * 1.8) + 1) / 2) * 0.08);
      const material = this.shieldCore.material as import('three').MeshPhysicalMaterial;
      material.emissiveIntensity = 0.18 + ((Math.sin(time * 2.1) + 1) / 2) * 0.16;
    }

    this.pulseLights.forEach((light, index) => {
      light.intensity = 4.6 + Math.sin(time * 2 + index * 0.8) * 1.4;
    });
  }

  private animatePrismsScene(): void {
    const time = this.time;

    this.prisms.forEach((prism, index) => {
      prism.mesh.rotateOnAxis(prism.rotationAxis, prism.rotationSpeed);
      prism.mesh.position.y = prism.originalY + Math.sin(time + prism.floatOffset) * 0.35;
      const material = prism.mesh.material as import('three').MeshPhysicalMaterial;
      material.color.setHSL(0.57 + prism.hueOffset + Math.sin(time * 0.35 + index * 0.4) * 0.012, 0.8, 0.62);
      material.emissiveIntensity = 0.16 + ((Math.sin(time * 1.8 + index) + 1) / 2) * 0.18;
    });

    if (this.prismDust) {
      this.prismDust.rotation.y += 0.0018;
      this.prismDust.rotation.x = Math.sin(time * 0.22) * 0.1;
    }

    this.pulseLights.forEach((light, index) => {
      light.intensity = 4.4 + Math.sin(time * 1.7 + index) * 1.2;
    });
  }

  private animateGridScene(): void {
    const time = this.time;

    this.gridPlanes.forEach((plane, index) => {
      plane.rotation.z += index === 0 ? 0.0009 : -0.0006;
      const material = plane.material as import('three').MeshBasicMaterial;
      material.opacity = 0.08 + ((Math.sin(time * 1.5 + index) + 1) / 2) * 0.08;
    });

    this.gridBands.forEach((band, index) => {
      band.mesh.rotation.y += band.speed;
      const material = band.mesh.material as import('three').MeshBasicMaterial;
      material.opacity = 0.16 + ((Math.sin(time * 2.2 + band.pulseOffset + index) + 1) / 2) * 0.16;
    });

    this.gateBars.forEach((bar, index) => {
      const pulse = (Math.sin(time * 2 + bar.pulseOffset + index * 0.25) + 1) / 2;
      bar.mesh.position.y = bar.baseY + (pulse - 0.5) * 0.5;
      const material = bar.mesh.material as import('three').MeshStandardMaterial;
      material.emissiveIntensity = 0.12 + pulse * 0.24;
      bar.mesh.scale.y = 0.86 + pulse * 0.22;
    });

    if (this.shieldCore) {
      this.shieldCore.rotation.y += 0.0032;
      this.shieldCore.rotation.x = Math.sin(time * 0.9) * 0.08;
      const material = this.shieldCore.material as import('three').MeshPhysicalMaterial;
      material.emissiveIntensity = 0.16 + ((Math.sin(time * 2.1) + 1) / 2) * 0.14;
    }

    this.pulseLights.forEach((light, index) => {
      light.intensity = 4.2 + Math.sin(time * 1.8 + index * 0.7) * 1.1;
    });
  }

  private handleResize(): void {
    if (!this.renderer || !this.camera) {
      return;
    }

    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private cleanup(): void {
    if (this.capabilityCheckTimer) {
      clearTimeout(this.capabilityCheckTimer);
      this.capabilityCheckTimer = null;
    }

    window.removeEventListener('resize', this.handleResizeBound);

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    for (const geometry of this.geometries) {
      geometry.dispose();
    }

    for (const material of this.materials) {
      material.dispose();
    }

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }

    this.three = null;
    this.scene = null;
    this.camera = null;
    this.sceneRoot = null;
    this.ambientParticles = null;
    this.ambientParticlePositions = null;
    this.ambientParticleBasePositions = null;
    this.prismDust = null;
    this.gridPlanes = [];
    this.shieldCore = null;
    this.rings.length = 0;
    this.gateBars.length = 0;
    this.prisms.length = 0;
    this.gridBands.length = 0;
    this.pulseLights.length = 0;
    this.geometries.length = 0;
    this.materials.length = 0;
    this.isThreeJsReady.set(false);
  }
}
