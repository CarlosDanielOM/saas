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
import { RouterLink } from '@angular/router';

import { DeviceCapabilityService } from '../../services/device-capability.service';
import { LanguageService } from '../../services/language.service';
import { SessionAuthService } from '../../services/session-auth.service';

type ThreeModule = typeof import('three');
type SceneMode = 'lattice' | 'crystals' | 'fractals';
type DashboardLink = ['/', string, 'dashboard'] | ['/login'];

interface LatticeNode {
  mesh: import('three').Mesh;
  position: import('three').Vector3;
  velocity: import('three').Vector3;
  energy: number;
}

interface LatticeConnection {
  line: import('three').Line;
  from: number;
  to: number;
  pulseOffset: number;
}

interface CrystalShard {
  mesh: import('three').Mesh;
  rotationAxis: import('three').Vector3;
  rotationSpeed: number;
  floatOffset: number;
  originalY: number;
  hueOffset: number;
}

interface FractalBranch {
  mesh: import('three').Mesh;
  depth: number;
  angle: number;
  swayOffset: number;
}

@Component({
  selector: 'app-not-found-page',
  imports: [RouterLink],
  templateUrl: './not-found-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class NotFoundPageComponent implements AfterViewInit, OnDestroy {
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
  readonly particleIndexes = Array.from({ length: 16 }, (_, index) => index);
  readonly isAdminViewer = computed(() => Boolean(this.session()?.appUser.administrating.length));
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
    return streamer ? ['/', streamer, 'dashboard'] : ['/login'];
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
    return streamer ? ['/', streamer, 'dashboard'] : ['/login'];
  });
  readonly lastViewedDashboardName = computed(() =>
    this.resolveDashboardName(this.lastViewedDashboardStreamer())
  );
  readonly messageKey = computed(() =>
    this.session()
      ? this.isAdminViewer() && this.hasSeparateLastViewedDashboard()
        ? 'notFound.messageAdminAuthenticated'
        : 'notFound.messageAuthenticated'
      : 'notFound.message'
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
  private readonly latticeNodes: LatticeNode[] = [];
  private readonly latticeConnections: LatticeConnection[] = [];
  private readonly crystals: CrystalShard[] = [];
  private readonly fractalBranches: FractalBranch[] = [];

  private ambientParticles: import('three').Points | null = null;
  private ambientParticlePositions: Float32Array | null = null;
  private ambientParticleBasePositions: Float32Array | null = null;
  private crystalDust: import('three').Points | null = null;

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

  ownDashboardLabel(): string {
    const name = this.ownDashboardName();
    return name
      ? this.t('notFound.actions.dashboardNamed', { name })
      : this.t('notFound.actions.dashboard');
  }

  lastViewedDashboardLabel(): string {
    const name = this.lastViewedDashboardName();
    return name
      ? this.t('notFound.actions.lastViewedDashboardNamed', { name })
      : this.t('notFound.actions.lastViewedDashboard');
  }

  myDashboardLabel(): string {
    const name = this.ownDashboardName();
    return name
      ? this.t('notFound.actions.myDashboardNamed', { name })
      : this.t('notFound.actions.myDashboard');
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
    this.scene.fog = new THREE.FogExp2(0x090205, 0.03);

    this.camera = new THREE.PerspectiveCamera(54, window.innerWidth / window.innerHeight, 0.1, 120);
    this.camera.position.set(0, 0, 13);

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
    this.sceneRoot.position.z = -1.5;
    this.scene.add(this.sceneRoot);

    this.createLights();
    this.createAmbientParticles(tier);

    switch (this.sceneMode()) {
      case 'lattice':
        this.createLattice(tier);
        break;
      case 'crystals':
        this.createCrystals(tier);
        break;
      case 'fractals':
        this.createFractals(tier);
        break;
    }

    this.isThreeJsReady.set(true);
    window.addEventListener('resize', this.handleResizeBound);
    this.animate();
  }

  private pickSceneMode(): SceneMode {
    const modes: SceneMode[] = ['lattice', 'crystals', 'fractals'];
    return modes[Math.floor(Math.random() * modes.length)] ?? 'lattice';
  }

  private createLights(): void {
    const THREE = this.three;
    if (!THREE || !this.scene) {
      return;
    }

    const ambient = new THREE.AmbientLight(0x3b0a10, 1.35);
    const key = new THREE.PointLight(0xef4444, 14, 35, 2);
    const fill = new THREE.PointLight(0xfb7185, 10, 28, 2);
    const warm = new THREE.PointLight(0xf97316, 8, 26, 2);
    const cyan = new THREE.PointLight(0x38bdf8, 3.5, 30, 2);

    key.position.set(3.5, 2.8, 10);
    fill.position.set(-4.8, -1.8, 9);
    warm.position.set(0, -4.5, 8.5);
    cyan.position.set(0, 3.8, 11);

    this.scene.add(ambient, key, fill, warm, cyan);
    this.pulseLights.push(key, fill, warm);
  }

  private createAmbientParticles(tier: 'low' | 'medium' | 'high'): void {
    const THREE = this.three;
    if (!THREE || !this.sceneRoot) {
      return;
    }

    const particleCount = tier === 'high' ? 520 : tier === 'medium' ? 320 : 200;
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const basePositions = new Float32Array(particleCount * 3);

    for (let index = 0; index < particleCount; index += 1) {
      const offset = index * 3;
      const radius = 6 + Math.random() * 18;
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
      color: 0xfda4af,
      size: tier === 'high' ? 0.065 : 0.08,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.ambientParticles = new THREE.Points(geometry, material);
    this.ambientParticles.rotation.x = 0.35;
    this.sceneRoot.add(this.ambientParticles);
    this.geometries.push(geometry);
    this.materials.push(material);
    this.ambientParticlePositions = positions;
    this.ambientParticleBasePositions = basePositions;
  }

  private createLattice(tier: 'low' | 'medium' | 'high'): void {
    const THREE = this.three;
    if (!THREE || !this.sceneRoot) {
      return;
    }

    const nodeCount = tier === 'high' ? 58 : tier === 'medium' ? 36 : 22;
    const maxConnections = tier === 'high' ? 4 : 3;
    const connectionDistance = tier === 'high' ? 3.6 : 3.1;
    const shellRadius = tier === 'high' ? 5.2 : 4.5;

    const nodeGeometry = new THREE.SphereGeometry(tier === 'high' ? 0.13 : 0.11, 10, 10);
    this.geometries.push(nodeGeometry);

    for (let index = 0; index < nodeCount; index += 1) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = 2.2 + Math.random() * shellRadius;
      const position = new THREE.Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta) * 0.7,
        radius * Math.cos(phi) * 0.6
      );

      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL(0.98 - Math.random() * 0.06, 0.86, 0.62),
        transparent: true,
        opacity: 0.92
      });
      const mesh = new THREE.Mesh(nodeGeometry, material);
      mesh.position.copy(position);
      this.sceneRoot.add(mesh);

      this.materials.push(material);
      this.latticeNodes.push({
        mesh,
        position,
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 0.022,
          (Math.random() - 0.5) * 0.016,
          (Math.random() - 0.5) * 0.014
        ),
        energy: Math.random()
      });
    }

    const connectionCounts = new Array<number>(nodeCount).fill(0);
    for (let from = 0; from < this.latticeNodes.length; from += 1) {
      if (connectionCounts[from] >= maxConnections) {
        continue;
      }

      for (let to = from + 1; to < this.latticeNodes.length; to += 1) {
        if (connectionCounts[from] >= maxConnections || connectionCounts[to] >= maxConnections) {
          continue;
        }

        const distance = this.latticeNodes[from].position.distanceTo(this.latticeNodes[to].position);
        if (distance > connectionDistance) {
          continue;
        }

        const lineGeometry = new THREE.BufferGeometry().setFromPoints([
          this.latticeNodes[from].position,
          this.latticeNodes[to].position
        ]);
        const lineMaterial = new THREE.LineBasicMaterial({
          color: 0xef4444,
          transparent: true,
          opacity: 0.3
        });
        const line = new THREE.Line(lineGeometry, lineMaterial);
        this.sceneRoot.add(line);
        this.geometries.push(lineGeometry);
        this.materials.push(lineMaterial);
        this.latticeConnections.push({
          line,
          from,
          to,
          pulseOffset: Math.random() * Math.PI * 2
        });
        connectionCounts[from] += 1;
        connectionCounts[to] += 1;
      }
    }
  }

  private createCrystals(tier: 'low' | 'medium' | 'high'): void {
    const THREE = this.three;
    if (!THREE || !this.sceneRoot) {
      return;
    }

    const crystalCount = tier === 'high' ? 16 : tier === 'medium' ? 10 : 7;
    const geometries = [
      new THREE.OctahedronGeometry(0.68, 0),
      new THREE.TetrahedronGeometry(0.8, 0),
      new THREE.IcosahedronGeometry(0.54, 0)
    ];
    this.geometries.push(...geometries);

    for (let index = 0; index < crystalCount; index += 1) {
      const geometry = geometries[index % geometries.length];
      const material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color().setHSL(0.98 - Math.random() * 0.07, 0.82, 0.58),
        metalness: 0.18,
        roughness: 0.12,
        transmission: tier === 'high' ? 0.42 : 0.14,
        thickness: 0.8,
        emissive: new THREE.Color(0x7f1d1d),
        emissiveIntensity: 0.45,
        transparent: true,
        opacity: 0.92
      });

      const mesh = new THREE.Mesh(geometry, material);
      const angle = (index / crystalCount) * Math.PI * 2;
      const radius = 2.2 + Math.random() * 4.8;
      const y = (Math.random() - 0.5) * 4.2;

      mesh.position.set(
        Math.cos(angle) * radius,
        y,
        Math.sin(angle) * radius * 0.6 - Math.random() * 2
      );
      mesh.scale.setScalar(0.72 + Math.random() * 1.05);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

      this.sceneRoot.add(mesh);
      this.materials.push(material);
      this.crystals.push({
        mesh,
        rotationAxis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        rotationSpeed: 0.004 + Math.random() * 0.009,
        floatOffset: Math.random() * Math.PI * 2,
        originalY: y,
        hueOffset: Math.random() * 0.06
      });
    }

    const dustGeometry = new THREE.BufferGeometry();
    const dustCount = tier === 'high' ? 120 : 70;
    const dustPositions = new Float32Array(dustCount * 3);
    for (let index = 0; index < dustPositions.length; index += 1) {
      dustPositions[index] = (Math.random() - 0.5) * 14;
    }
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
    const dustMaterial = new THREE.PointsMaterial({
      color: 0xfca5a5,
      size: tier === 'high' ? 0.08 : 0.1,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.crystalDust = new THREE.Points(dustGeometry, dustMaterial);
    this.sceneRoot.add(this.crystalDust);
    this.geometries.push(dustGeometry);
    this.materials.push(dustMaterial);
  }

  private createFractals(tier: 'low' | 'medium' | 'high'): void {
    const THREE = this.three;
    if (!THREE || !this.sceneRoot) {
      return;
    }

    const root = this.sceneRoot;

    const maxDepth = tier === 'high' ? 5 : tier === 'medium' ? 4 : 3;
    const rootBranches = tier === 'high' ? 5 : 4;

    const createBranch = (
      origin: import('three').Vector3,
      angle: number,
      depth: number,
      scale: number
    ): void => {
      if (depth > maxDepth) {
        return;
      }

      const length = 1.5 * scale;
      const endpoint = new THREE.Vector3(
        origin.x + Math.cos(angle) * length,
        origin.y + Math.sin(angle) * length,
        origin.z + (Math.random() - 0.5) * 0.32 * scale
      );
      const control = new THREE.Vector3(
        (origin.x + endpoint.x) / 2 + (Math.random() - 0.5) * 0.65 * scale,
        (origin.y + endpoint.y) / 2 + (Math.random() - 0.5) * 0.55 * scale,
        (origin.z + endpoint.z) / 2
      );

      const curve = new THREE.QuadraticBezierCurve3(origin, control, endpoint);
      const geometry = new THREE.TubeGeometry(curve, 10, 0.05 * scale, 8, false);
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(0.99 - depth * 0.025, 0.88, 0.54 + depth * 0.04),
        emissive: new THREE.Color(0x7f1d1d),
        emissiveIntensity: 0.55 - depth * 0.06,
        metalness: 0.52,
        roughness: 0.28,
        transparent: true,
        opacity: 0.96
      });

      const branchMesh = new THREE.Mesh(geometry, material);
      root.add(branchMesh);
      this.geometries.push(geometry);
      this.materials.push(material);
      this.fractalBranches.push({
        mesh: branchMesh,
        depth,
        angle,
        swayOffset: Math.random() * Math.PI * 2
      });

      const jointGeometry = new THREE.SphereGeometry(0.09 * scale, 10, 10);
      const jointMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL(0.98, 0.82, 0.72),
        transparent: true,
        opacity: 0.78
      });
      const joint = new THREE.Mesh(jointGeometry, jointMaterial);
      joint.position.copy(endpoint);
      root.add(joint);
      this.geometries.push(jointGeometry);
      this.materials.push(jointMaterial);

      if (depth === maxDepth) {
        return;
      }

      const branches = depth < 2 ? 2 : 3;
      for (let index = 0; index < branches; index += 1) {
        const newAngle = angle + (Math.random() - 0.5) * Math.PI * 0.92;
        createBranch(endpoint, newAngle, depth + 1, scale * 0.74);
      }
    };

    for (let index = 0; index < rootBranches; index += 1) {
      const startAngle = (index / rootBranches) * Math.PI * 2;
      createBranch(new THREE.Vector3(0, 0, 0), startAngle, 0, 1.24);
    }
  }

  private animate(): void {
    if (!this.renderer || !this.scene || !this.camera) {
      return;
    }

    this.time += 0.016;

    this.updateReactivePulse();
    this.animateAmbientParticles();

    switch (this.sceneMode()) {
      case 'lattice':
        this.animateLattice();
        break;
      case 'crystals':
        this.animateCrystals();
        break;
      case 'fractals':
        this.animateFractals();
        break;
    }

    if (this.sceneRoot) {
      this.sceneRoot.rotation.y += 0.0018;
      this.sceneRoot.rotation.x = Math.sin(this.time * 0.18) * 0.06;
    }

    this.camera.position.x = Math.sin(this.time * 0.22) * 0.55;
    this.camera.position.y = Math.cos(this.time * 0.17) * 0.42;
    this.camera.position.z = 12.8 + Math.sin(this.time * 0.12) * 0.45;
    this.camera.lookAt(0, 0, 0);

    this.renderer.render(this.scene, this.camera);
    this.animationFrameId = requestAnimationFrame(() => this.animate());
  }

  private updateReactivePulse(): void {
    const shell = this.shellRef().nativeElement;
    const time = this.time;

    const baseBeat = Math.pow(Math.max(0, Math.sin(time * 1.75)), 6);
    const shimmer = (Math.sin(time * 3.8 + 0.7) + 1) / 2;
    const flutter = (Math.sin(time * 6.4 + 1.3) + 1) / 2;
    const centerEcho = Math.pow(Math.max(0, Math.sin(time * 2.05 + 0.34)), 7);
    const leftEcho = Math.pow(Math.max(0, Math.sin(time * 2.05 + 0.08)), 7);
    const rightEcho = Math.pow(Math.max(0, Math.sin(time * 2.05 - 0.18)), 7);
    const glitchWindow = Math.pow(Math.max(0, Math.sin(time * 0.56 + 0.85)), 28);
    const glitchFlicker = 0.4 + ((Math.sin(time * 29 + Math.sin(time * 4.8)) + 1) / 2) * 0.6;

    let modeSync = 0;
    switch (this.sceneMode()) {
      case 'lattice':
        modeSync = Math.pow(Math.max(0, Math.sin(time * 2.55 + 0.4)), 5);
        break;
      case 'crystals':
        modeSync = (Math.sin(time * 2.15 + 1.1) + 1) / 2;
        break;
      case 'fractals':
        modeSync = (Math.sin(time * 1.25) + 1) / 2;
        break;
    }

    const redGlow = 0.42 + baseBeat * 0.9 + shimmer * 0.18;
    const purpleGlow = 0.16 + modeSync * 0.4 + flutter * 0.12;
    const scale = 1 + baseBeat * 0.022 + modeSync * 0.01;
    const rise = -(baseBeat * 5.5 + modeSync * 2.5);
    const tilt = modeSync * 0.6;
    const glitchIntensity = glitchWindow * glitchFlicker;

    shell.style.setProperty('--not-found-reactive-scale', scale.toFixed(4));
    shell.style.setProperty('--not-found-reactive-rise', `${rise.toFixed(2)}px`);
    shell.style.setProperty('--not-found-reactive-tilt', `${tilt.toFixed(2)}deg`);
    shell.style.setProperty('--not-found-red-glow', redGlow.toFixed(4));
    shell.style.setProperty('--not-found-purple-glow', purpleGlow.toFixed(4));
    shell.style.setProperty('--not-found-left-scale', (1 + leftEcho * 0.04).toFixed(4));
    shell.style.setProperty('--not-found-center-scale', (1 + centerEcho * 0.05).toFixed(4));
    shell.style.setProperty('--not-found-right-scale', (1 + rightEcho * 0.042).toFixed(4));
    shell.style.setProperty('--not-found-left-rise', `${(-leftEcho * 8.5).toFixed(2)}px`);
    shell.style.setProperty('--not-found-center-rise', `${(-centerEcho * 10.5).toFixed(2)}px`);
    shell.style.setProperty('--not-found-right-rise', `${(-rightEcho * 9).toFixed(2)}px`);
    shell.style.setProperty('--not-found-glitch-intensity', glitchIntensity.toFixed(4));
    shell.style.setProperty('--not-found-left-glitch-x', `${(-2.4 * glitchIntensity).toFixed(2)}px`);
    shell.style.setProperty('--not-found-center-glitch-x', `${(1.35 * glitchIntensity).toFixed(2)}px`);
    shell.style.setProperty('--not-found-right-glitch-x', `${(3.1 * glitchIntensity).toFixed(2)}px`);
    shell.style.setProperty('--not-found-left-glitch-y', `${(0.65 * glitchIntensity).toFixed(2)}px`);
    shell.style.setProperty('--not-found-center-glitch-y', `${(-0.45 * glitchIntensity).toFixed(2)}px`);
    shell.style.setProperty('--not-found-right-glitch-y', `${(0.9 * glitchIntensity).toFixed(2)}px`);
  }

  private animateAmbientParticles(): void {
    if (!this.ambientParticles || !this.ambientParticlePositions || !this.ambientParticleBasePositions) {
      return;
    }

    for (let index = 0; index < this.ambientParticlePositions.length; index += 3) {
      const waveSeed = this.time * 0.8 + index * 0.018;
      this.ambientParticlePositions[index] = this.ambientParticleBasePositions[index] + Math.sin(waveSeed) * 0.16;
      this.ambientParticlePositions[index + 1] = this.ambientParticleBasePositions[index + 1] + Math.cos(waveSeed * 1.12) * 0.18;
      this.ambientParticlePositions[index + 2] = this.ambientParticleBasePositions[index + 2] + Math.sin(waveSeed * 0.74) * 0.12;
    }

    this.ambientParticles.geometry.attributes['position'].needsUpdate = true;
    this.ambientParticles.rotation.y -= 0.0008;
  }

  private animateLattice(): void {
    const time = this.time;
    const boundary = 6.5;

    this.latticeNodes.forEach((node, index) => {
      node.position.add(node.velocity);
      const distance = node.position.length();
      if (distance > boundary) {
        node.velocity.multiplyScalar(-0.88);
        node.position.clampLength(0, boundary);
      }

      node.energy = 0.7 + Math.sin(time * 2.5 + index * 0.45) * 0.26;
      node.mesh.position.copy(node.position);
      node.mesh.scale.setScalar(0.9 + node.energy * 0.42);

      const material = node.mesh.material as import('three').MeshBasicMaterial;
      material.opacity = 0.58 + node.energy * 0.34;
    });

    this.latticeConnections.forEach((connection, index) => {
      const positions = connection.line.geometry.attributes['position'].array as Float32Array;
      const from = this.latticeNodes[connection.from].position;
      const to = this.latticeNodes[connection.to].position;

      positions[0] = from.x;
      positions[1] = from.y;
      positions[2] = from.z;
      positions[3] = to.x;
      positions[4] = to.y;
      positions[5] = to.z;
      connection.line.geometry.attributes['position'].needsUpdate = true;

      const material = connection.line.material as import('three').LineBasicMaterial;
      material.opacity = 0.12 + Math.sin(time * 3.1 + connection.pulseOffset + index * 0.09) * 0.16 + 0.18;
    });

    this.pulseLights.forEach((light, index) => {
      light.intensity = 5.5 + Math.sin(time * 2.4 + index) * 1.8;
    });
  }

  private animateCrystals(): void {
    const time = this.time;

    this.crystals.forEach((crystal, index) => {
      crystal.mesh.rotateOnAxis(crystal.rotationAxis, crystal.rotationSpeed);
      crystal.mesh.position.y = crystal.originalY + Math.sin(time * 1.05 + crystal.floatOffset) * 0.45;

      const material = crystal.mesh.material as import('three').MeshPhysicalMaterial;
      const hue = 0.98 - crystal.hueOffset + Math.sin(time * 0.42 + index * 0.5) * 0.015;
      material.color.setHSL(hue, 0.84, 0.6);
      material.emissiveIntensity = 0.34 + Math.sin(time * 2 + index) * 0.16;
      material.opacity = 0.76 + Math.sin(time * 1.4 + crystal.floatOffset) * 0.08;
    });

    if (this.crystalDust) {
      this.crystalDust.rotation.y += 0.0025;
      this.crystalDust.rotation.x = Math.sin(time * 0.3) * 0.18;
    }

    this.pulseLights.forEach((light, index) => {
      light.intensity = 6 + Math.sin(time * 2 + index * 0.7) * 2.2;
    });
  }

  private animateFractals(): void {
    const time = this.time;

    this.fractalBranches.forEach((branch, index) => {
      branch.mesh.rotation.z = Math.sin(time * 0.95 + branch.swayOffset + branch.depth * 0.6) * 0.05;
      branch.mesh.rotation.x = Math.cos(time * 0.58 + index * 0.04) * 0.02;

      const material = branch.mesh.material as import('three').MeshStandardMaterial;
      material.emissiveIntensity = 0.28 + Math.sin(time * 2.2 + branch.depth + index * 0.06) * 0.15;
      material.color.setHSL(0.99 - branch.depth * 0.025, 0.86, 0.56 + branch.depth * 0.03);
    });

    this.pulseLights.forEach((light, index) => {
      light.intensity = 6.4 + Math.sin(time * 2.8 + index * 0.8) * 2.4;
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
    this.crystalDust = null;
    this.latticeNodes.length = 0;
    this.latticeConnections.length = 0;
    this.crystals.length = 0;
    this.fractalBranches.length = 0;
    this.pulseLights.length = 0;
    this.geometries.length = 0;
    this.materials.length = 0;
    this.isThreeJsReady.set(false);
  }
}
