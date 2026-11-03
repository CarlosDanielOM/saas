import * as T from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { DuelBattle, DuelSide, COMBO_HEAL, otherSide } from '../duel-battle';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { ClaudeAssets, Particles, coronaMaterial, createAssets, keepAlpha, flameMaterial, mistMaterial, runeFloorMaterial, runeGlyphMaterial, shaftMaterial, skyMaterial } from './duel-claude-3d-assets';
import { ARM_JOINTS, ClaudeRig, HIP_HEIGHT, SHIN, THIGH, bakeRig, buildRig, disposeRig, syncToggles } from './duel-claude-3d-rig';
import { type FighterAsset, type FighterSkin, type Palette, arenaAsset, fighterAsset, fighterSkin } from './duel-claude-3d-library';
import { MotionContext, Pose, activeTurn, attackPhase, fighterPose, strikePoses, ultimatePoses } from './duel-claude-3d-motion';
import { CombatEffects } from './duel-claude-3d-effects';
import { UltimateEffects } from './duel-claude-3d-ultimates';

export interface DuelSceneState { battle: DuelBattle; elapsed: number; started: boolean; paused: boolean; transparent: boolean }
export interface DuelSceneStats { fps: number; calls: number; triangles: number }
const clamp = T.MathUtils.clamp, smooth = (x: number) => { const p = clamp(x, 0, 1); return p * p * (3 - 2 * p); };
const pulse = (x: number) => (x <= 0 || x >= 1) ? 0 : Math.sin(x * Math.PI);
const FPS = 30, FRAME_MS = 1000 / FPS, BASE = -2.35, FACING = 1.0, SIDES: DuelSide[] = ['left', 'right'];

/**
 * Runs before bloom. A single NaN or infinite pixel (an extreme specular highlight
 * overflowing the half-float target, or undefined shader math on some GPUs) would
 * otherwise be smeared across the whole frame by the bloom blur and read as black.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: `uniform sampler2D tDiffuse;varying vec2 vUv;
    float safe(float x){return (isnan(x)||isinf(x)||!(x>=0.||x<0.))?0.:clamp(x,0.,96.);}
    void main(){vec4 c=texture2D(tDiffuse,vUv);gl_FragColor=vec4(safe(c.r),safe(c.g),safe(c.b),min(safe(c.a),1.));}`,
};

/** Polished flagstones: the mirrored scene, broken up by the baked stone relief (grout stays matte) and faded at the rim. */
const MirrorShader = {
  name: 'ClaudeArenaMirror',
  uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, uStone: { value: null }, uStrength: { value: .42 } },
  vertexShader: 'uniform mat4 textureMatrix;varying vec4 vMirror;varying vec2 vUv;void main(){vMirror=textureMatrix*vec4(position,1.);vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: `uniform sampler2D tDiffuse;uniform sampler2D uStone;uniform float uStrength;varying vec4 vMirror;varying vec2 vUv;
    void main(){vec2 suv=vec2(vUv.x,1.-vUv.y)*(9.28/9.5)+(1.-9.28/9.5)*.5;float g=texture2D(uStone,suv).r;vec4 m=vMirror;m.xy+=(g-.55)*.035*m.w;vec3 r=texture2DProj(tDiffuse,m).rgb;
      r=(any(isnan(r))||any(isinf(r)))?vec3(0.):min(r,vec3(24.));
      float edge=smoothstep(1.,.86,length(vUv-.5)*2.);float polish=.3+.7*smoothstep(.55,.85,g);
      gl_FragColor=vec4(r*uStrength*edge*polish,1.);}`,
};

/** Grade pass: gravitational lensing, ink (Blood Moon), impact frames, aberration, flash, vignette and grain. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uAspect: { value: 16 / 9 }, uTime: { value: 0 }, uLensPos: { value: new T.Vector2(.5, .5) }, uLensE: { value: 0 },
    uInk: { value: 0 }, uImpact: { value: 0 }, uAberration: { value: 0 }, uFlash: { value: 0 }, uFlashColor: { value: new T.Color('#fff') },
    uExposure: { value: 0 }, uVignette: { value: .55 }, uGrain: { value: .018 },
    uRipplePos: { value: new T.Vector2(.5, .5) }, uRippleAge: { value: 0 }, uRippleStrength: { value: 0 }, uTransparent: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: `uniform sampler2D tDiffuse;uniform float uAspect;uniform float uTime;uniform vec2 uLensPos;uniform float uLensE;uniform float uInk;uniform float uImpact;
    uniform float uAberration;uniform float uFlash;uniform vec3 uFlashColor;uniform float uExposure;uniform float uVignette;uniform float uGrain;uniform vec2 uRipplePos;uniform float uRippleAge;uniform float uRippleStrength;uniform float uTransparent;varying vec2 vUv;
    float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
    void main(){vec2 uv=vUv;float shadow=0.;
      if(uRippleStrength>0.){vec2 d=(uv-uRipplePos)*vec2(uAspect,1.);float r=max(length(d),1e-4);float x=(r-uRippleAge*.6)*13.;
        uv-=(d/r)/vec2(uAspect,1.)*exp(-x*x)*uRippleStrength*(1.-uRippleAge);}
      if(uLensE>0.0005){vec2 d=(uv-uLensPos)*vec2(uAspect,1.);float r=max(length(d),1e-4);float shift=min(uLensE*uLensE/r,.5);
        vec2 src=d-normalize(d)*shift;uv=uLensPos+src/vec2(uAspect,1.);shadow=smoothstep(uLensE*.62,uLensE*.5,r);}
      vec2 c=uv-.5;vec3 col=vec3(texture2D(tDiffuse,uv+c*uAberration).r,texture2D(tDiffuse,uv).g,texture2D(tDiffuse,uv-c*uAberration).b);
      col*=1.-shadow;col*=exp2(uExposure);
      float l=dot(col,vec3(.299,.587,.114));
      vec3 ink=mix(vec3(.012,0.,.006),vec3(.85,.03,.1),smoothstep(.07,.26,l));ink=mix(ink,vec3(1.,.9,.92)*1.3,smoothstep(1.3,2.4,l));
      col=mix(col,ink,uInk);
      if(uTransparent>.5){
        // OBS overlay: keep the stream visible; glows and bloom become partial alpha (premultiplied).
        float a=clamp(max(texture2D(tDiffuse,uv).a,max(col.r,max(col.g,col.b))),0.,1.);gl_FragColor=vec4(col,a);return;}
      if(uImpact>.5){float m=smoothstep(.42,.6,l);col=uImpact<1.5?mix(vec3(.01),vec3(1.,.96,.88)*1.6,m):mix(vec3(1.5),vec3(.03,0.,.04),m);}
      else col+=uFlashColor*uFlash;vec2 q=vUv-.5;col*=1.-dot(q,q)*uVignette;col+=(h(vUv*937.+uTime)-.5)*uGrain;
      gl_FragColor=vec4(col,1.);}`,
};

/** Emission scale for the baked arena (matches the fighters'). */
const ARENA_EMISSIVE = .55;

/**
 * The extreme duel: baked Blender fighters and arena (loaded once per page, see
 * duel-claude-3d-library) with live effects, cloth, choreography and post-processing.
 */
export class DuelClaude3dScene {
  private readonly renderer: T.WebGLRenderer;
  private readonly scene = new T.Scene();
  private readonly fog = new T.FogExp2('#070915', .03);
  private readonly camera = new T.PerspectiveCamera(34, 16 / 9, .1, 120);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly grade: ShaderPass;
  private readonly assets: ClaudeAssets;
  private readonly envMap: T.WebGLRenderTarget;
  private readonly environment = new T.Group();
  private readonly stages: Record<DuelSide, T.Group> = { left: new T.Group(), right: new T.Group() };
  private readonly combat: CombatEffects;
  private readonly ultimates: UltimateEffects;
  private readonly ambient: Particles;
  private readonly sky: T.ShaderMaterial;
  private readonly floor: T.ShaderMaterial;
  private readonly corona: T.ShaderMaterial;
  private readonly animated: T.ShaderMaterial[] = [];
  private readonly flames: { light: T.PointLight; base: number }[] = [];
  private readonly sway = { uTime: { value: 0 }, uWind: { value: .25 } };
  private readonly drift = { uTime: { value: 0 } };
  private readonly gate = new T.Group();
  private arenaAttached = false;
  private readonly loaded = new Map<string, unknown>();
  private readonly loading = new Set<string>();
  private readonly hemi = new T.HemisphereLight('#94a3d6', '#1a1730', .75);
  private readonly key = new T.DirectionalLight('#e3e8ff', 2.6);
  private readonly rims: T.SpotLight[] = [];
  private readonly gateLight = new T.PointLight('#8f6dff', 12, 16, 1.6);
  private mirror!: Reflector;
  private readonly contact: Record<DuelSide, T.Mesh> = { left: new T.Mesh(), right: new T.Mesh() };
  private readonly probe = new T.Mesh(new T.PlaneGeometry(.4, .4), new T.ShaderMaterial({ vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}', fragmentShader: 'uniform float uZero;void main(){gl_FragColor=vec4(vec3(uZero/uZero),1.);}', uniforms: { uZero: { value: 0 } } }));
  private readonly rigs: Partial<Record<DuelSide, ClaudeRig>> = {};
  private readonly observer: ResizeObserver;
  private readonly motion = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly matrix = new T.Matrix4();
  private readonly m3 = new T.Matrix3();
  private readonly v = new T.Vector3();
  private readonly look = new T.Vector3();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private previousBattle: DuelBattle | null = null;
  private preparationCount = 0;
  private halvesBakeCount = 0;
  private shadersFor: DuelBattle | null = null;
  private shadersTransparent = false;
  private shaderPreparationCount = 0;
  private dirty = true;
  private dead = false;
  private frameCount = 0;
  private statsAt = performance.now();
  private statsFrames = 0;
  private lastTime = -1;
  private lastFlags = '';
  private worldTime = 0;
  private lastTick = performance.now();
  private lastDraw = 0;
  private height = 450;
  private readonly intervals: number[] = [];

  constructor(private readonly canvas: HTMLCanvasElement, private readonly state: () => DuelSceneState, private readonly stats: (stats: DuelSceneStats) => void, private readonly failure: () => void) {
    this.renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1); this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = T.PCFShadowMap;
    this.renderer.toneMapping = T.ACESFilmicToneMapping; this.renderer.toneMappingExposure = .92; this.renderer.info.autoReset = false;
    this.assets = createAssets();
    const room = new RoomEnvironment(), pmrem = new T.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(room, .04); this.scene.environment = this.envMap.texture; this.scene.environmentIntensity = .38; room.dispose(); pmrem.dispose();
    this.scene.fog = this.fog;
    for (const side of SIDES) { this.stages[side].scale.x = side === 'left' ? 1 : -1; this.scene.add(this.stages[side]); this.stages[side].updateMatrixWorld(true); }
    this.combat = new CombatEffects(this.assets); this.ultimates = new UltimateEffects(this.assets);
    this.scene.add(this.environment, this.combat.root, this.ultimates.root, this.hemi);
    this.key.position.set(-3.5, 8.5, 6.5); this.key.castShadow = true; this.key.shadow.mapSize.set(2048, 2048);
    Object.assign(this.key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 }); this.key.shadow.normalBias = .03; this.key.shadow.bias = -.0004;
    this.scene.add(this.key);
    for (const [x, color] of [[-1, '#a58bff'], [1, '#ffb45c']] as const) {
      const rim = new T.SpotLight(color, 45, 16, .55, .85, 1.6); rim.position.set(x * 3.2, 4.6, -3.6); rim.target.position.set(x * 2.3, 1.2, 0); this.scene.add(rim, rim.target); this.rims.push(rim);
    }
    this.gateLight.position.set(0, 3.6, -3.2); this.scene.add(this.gateLight);
    const fill = new T.PointLight('#8ca2ff', 6, 18, 1.6); fill.position.set(0, 2.4, 7); this.scene.add(fill);
    this.sky = skyMaterial(); this.floor = runeFloorMaterial(); this.corona = coronaMaterial();
    this.ambient = new Particles(220, this.assets.radial, 41);
    this.buildEnvironment();
    const target = new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target); this.composer.addPass(new RenderPass(this.scene, this.camera)); this.composer.addPass(new ShaderPass(SanitizeShader));
    this.bloom = new UnrealBloomPass(new T.Vector2(800, 450), .42, .28, 1.25); this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader); this.composer.addPass(this.grade); this.composer.addPass(new OutputPass());
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas.parentElement!);
    this.motion.addEventListener('change', this.motionChanged); canvas.addEventListener('webglcontextlost', this.contextLost);
    canvas.dataset['fpsCap'] = String(FPS); canvas.dataset['renderer'] = 'claude';
    keepAlpha(this.scene); this.resize(); this.tick();
  }

  /** Live arena FX: sky, corona, rune light, flames, mist, shafts, motes and the mirror floor. The baked set joins in attachArena. */
  private buildEnvironment(): void {
    const env = this.environment;
    const sky = new T.Mesh(new T.SphereGeometry(60, 48, 24), this.sky); sky.frustumCulled = false; env.add(sky);
    const floor = new T.Mesh(new T.PlaneGeometry(9.3, 9.3), this.floor); floor.rotation.x = -Math.PI / 2; floor.position.y = .012; env.add(floor);
    // The broken moon gate turns slowly around its center; the eclipse corona burns behind it.
    this.gate.position.set(0, 3.7, -4.6); env.add(this.gate);
    const corona = new T.Mesh(new T.PlaneGeometry(9, 9), this.corona); corona.position.z = -.35; this.gate.add(corona);
    (corona.material as T.ShaderMaterial).uniforms['uIntensity'].value = 1;
    // Brazier flames and flickering light.
    for (const side of [-1, 1]) {
      const brazier = new T.Group(); brazier.position.set(side * 4.15, 0, -1.6); env.add(brazier);
      for (let k = 0; k < 2; k++) {
        const material = flameMaterial(side < 0 ? '#b08cff' : '#ff9a3c'); material.uniforms['uSeed'].value = k * 3 + side; this.animated.push(material);
        const flame = new T.Mesh(new T.PlaneGeometry(.75, 1.25), material); flame.position.y = 1.45; flame.rotation.y = k * Math.PI / 2 + .4; brazier.add(flame);
      }
      const light = new T.PointLight(side < 0 ? '#a98aff' : '#ffa04d', 9, 7, 1.8); light.position.y = 1.5; brazier.add(light); this.flames.push({ light, base: 9 });
    }
    // Mist sheets and light shafts.
    for (const [z, w, o] of [[-2.6, 14, .3], [3.6, 16, .18]] as const) {
      const mist = mistMaterial(); mist.uniforms['uOpacity'].value = o; this.animated.push(mist);
      const sheet = new T.Mesh(new T.PlaneGeometry(w, 2.4), mist); sheet.position.set(0, .5, z); env.add(sheet);
    }
    for (let i = 0; i < 3; i++) {
      const material = shaftMaterial(i === 1 ? '#c2a8ff' : '#8b7ad6', .07); this.animated.push(material);
      const shaft = new T.Mesh(new T.ConeGeometry(1.4 + i * .3, 8, 24, 1, true), material); shaft.position.set((i - 1) * 2.2, 3.4, -2.6); shaft.rotation.z = (i - 1) * -.28; env.add(shaft);
    }
    this.ambient.points.visible = true; env.add(this.ambient.points);
    // Polished floor: a half-resolution mirror of the scene over the flagstones (relief set in attachArena).
    this.mirror = new Reflector(new T.CircleGeometry(4.64, 128), { textureWidth: 512, textureHeight: 288, clipBias: .003, multisample: 0, shader: MirrorShader });
    const mirror = this.mirror.material as T.ShaderMaterial; mirror.transparent = true; mirror.depthWrite = false; mirror.blending = T.AdditiveBlending; mirror.uniforms['uStrength'].value = .26;
    this.mirror.rotation.x = -Math.PI / 2; this.mirror.position.y = .016; this.mirror.visible = false; env.add(this.mirror);
    // Soft contact shadows keep the fighters planted.
    for (const side of SIDES) {
      const shadow = new T.Mesh(new T.PlaneGeometry(1.7, 1.7), new T.MeshBasicMaterial({ color: '#000000', map: this.assets.radial, transparent: true, depthWrite: false, opacity: .6 }));
      shadow.rotation.x = -Math.PI / 2; shadow.renderOrder = 1; this.contact[side] = shadow; env.add(shadow);
    }
    // Test-only NaN source (enabled by a data attribute) proving the sanitize pass keeps the frame intact.
    this.probe.position.set(0, 1.6, 1); this.probe.visible = false; this.scene.add(this.probe);
  }

  /**
   * The baked set: flagstones, platform, rune inlays, moon gate, pillars, banners, braziers and
   * shards. Banners sway and shards drift in their vertex shaders; the gate turns as one piece.
   */
  private attachArena(gltf: GLTF): void {
    const arena = gltf.scene.clone(), meshes: T.Mesh[] = [];
    arena.traverse(object => { if ((object as T.Mesh).isMesh) meshes.push(object as T.Mesh); });
    let set: T.MeshStandardMaterial | null = null;
    const setMaterial = (source: T.MeshStandardMaterial) => {
      if (!set) { set = source.clone(); set.emissiveIntensity *= ARENA_EMISSIVE; }
      return set;
    };
    this.environment.add(arena); this.environment.updateMatrixWorld(true);
    for (const mesh of meshes) {
      const name = mesh.name, source = mesh.material as T.MeshStandardMaterial;
      mesh.castShadow = !/floor|runes/i.test(name); mesh.receiveShadow = !/runes/i.test(name);
      if (/runes/i.test(name)) { mesh.material = runeGlyphMaterial(this.floor); continue; }
      if (/floor/i.test(name)) { (this.mirror.material as T.ShaderMaterial).uniforms['uStone'].value = source.aoMap; this.mirror.visible = true; continue; }
      mesh.material = setMaterial(source);
      if (/gate/i.test(name)) this.gate.attach(mesh);
      if (/bannercloth/i.test(name)) animate(mesh, this.sway, true, `attribute float _sway;attribute float _seed;uniform float uTime;uniform float uWind;`, '',
        `float s=pow(_sway,1.4);transformed.z+=s*(sin(uTime*2.1-_sway*4.5+_seed)*(.05+uWind*.1)+uWind*.08);transformed.x+=s*sin(uTime*1.4-_sway*3.+_seed*1.7)*.035;`);
      // Each shard spins about its own center and bobs (the depth pass has no normals, hence the helper).
      if (/shards/i.test(name)) animate(mesh, this.drift, false, `attribute float _cx;attribute float _cy;attribute float _cz;attribute float _si;uniform float uTime;
        mat2 shardSpin(){float a=uTime*.2+_si;return mat2(cos(a),-sin(a),sin(a),cos(a));}`,
        `objectNormal.xz=shardSpin()*objectNormal.xz;`,
        `vec3 dC=vec3(_cx,_cy,_cz);transformed-=dC;transformed.xz=shardSpin()*transformed.xz;transformed+=dC+vec3(0.,sin(uTime*.8+_si)*.12,0.);`);
    }
    keepAlpha(arena); this.arenaAttached = true; this.shadersFor = null; this.dirty = true;
  }

  private readonly motionChanged = () => { this.dirty = true; };
  private readonly contextLost = (event: Event) => { event.preventDefault(); this.failure(); this.dispose(); };

  private resize(): void {
    if (this.dead) return;
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    // Supersample desktop, honor Retina phones, bound the total pixel workload.
    const density = Math.min(2, Math.max(1.35, window.devicePixelRatio || 1), 2048 / Math.max(1, rect.width));
    const w = Math.max(1, Math.round(rect.width * density)), h = Math.max(1, Math.round(rect.height * density));
    this.canvas.dataset['resolution'] = `${w}×${h}`; this.height = h;
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h); this.bloom.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    this.mirror.getRenderTarget().setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.grade.uniforms['uAspect'].value = w / h; this.dirty = true;
  }

  private readonly tick = (): void => {
    if (this.dead) return;
    const frameStart = performance.now(), snapshot = this.state(), reduced = this.motion.matches;
    const flags = `${snapshot.started}|${snapshot.paused}|${snapshot.transparent}`;
    const changed = this.lastTime !== snapshot.elapsed || this.previousBattle !== snapshot.battle || flags !== this.lastFlags;
    // Nothing is drawn until this battle's models (and, when visible, the arena) are in.
    const ready = this.ready(snapshot); this.canvas.dataset['assets'] = ready ? 'ready' : 'loading';
    if (ready && !document.hidden && (this.dirty || changed || !snapshot.paused && !reduced)) {
      const delta = Math.min(.1, (frameStart - this.lastTick) / 1000);
      if (!snapshot.paused && !reduced) this.worldTime += delta;
      this.update(snapshot, reduced ? 0 : this.worldTime, reduced);
      this.prepareShaders(snapshot);
      this.renderer.info.reset();
      this.composer.render();
      this.frameCount++; this.statsFrames++;
      this.canvas.dataset['frames'] = String(this.frameCount); this.canvas.dataset['drawCalls'] = String(this.renderer.info.render.calls);
      this.canvas.dataset['triangles'] = String(this.renderer.info.render.triangles);
      if (this.lastDraw) this.intervals.push(frameStart - this.lastDraw);
      if (this.intervals.length > 120) this.intervals.shift(); this.lastDraw = frameStart;
      if (frameStart - this.statsAt >= 1000) {
        this.stats({ fps: Math.round(this.statsFrames * 1000 / (frameStart - this.statsAt)), calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles });
        this.canvas.dataset['frameIntervals'] = JSON.stringify(this.intervals); this.statsAt = frameStart; this.statsFrames = 0;
      }
      this.lastTime = snapshot.elapsed; this.lastFlags = flags; this.dirty = false;
    }
    this.lastTick = frameStart;
    // Bound drawing to 30 FPS without catch-up bursts; paused scenes only redraw when dirty.
    this.timer = setTimeout(this.tick, Math.max(1, Math.ceil(FRAME_MS - (performance.now() - frameStart))));
  };

  /** Starts a download once; the value is kept for this scene when it arrives. A failure swaps arenas. */
  private need<V>(key: string, load: () => Promise<V>): V | undefined {
    if (this.loaded.has(key)) return this.loaded.get(key) as V;
    if (!this.loading.has(key)) {
      this.loading.add(key);
      load().then(value => { if (!this.dead) { this.loaded.set(key, value); this.dirty = true; } }, () => {
        if (this.dead) return; this.canvas.dataset['assets'] = 'failed'; this.failure(); this.dispose();
      }).finally(() => this.loading.delete(key));
    }
    return undefined;
  }

  private ready(state: DuelSceneState): boolean {
    let ready = true;
    for (const side of SIDES) {
      const character = state.battle.fighters[side], palette = paletteOf(state.battle, side);
      if (!this.need(`model:${character}`, () => fighterAsset(character))) ready = false;
      if (!this.need(`skin:${character}_${palette}`, () => fighterSkin(character, palette))) ready = false;
    }
    if (!state.transparent && !this.arenaAttached) { const gltf = this.need('arena', arenaAsset); if (gltf) this.attachArena(gltf); else ready = false; }
    return ready;
  }

  private rebuild(battle: DuelBattle): void {
    const preparationStart = performance.now();
    for (const side of SIDES) {
      const old = this.rigs[side]; if (old) disposeRig(old);
      const character = battle.fighters[side], palette = paletteOf(battle, side);
      const rig = buildRig(character, side, battle.enraged === side, this.loaded.get(`model:${character}`) as FighterAsset, this.loaded.get(`skin:${character}_${palette}`) as FighterSkin, this.assets);
      this.rigs[side] = rig; this.stages[side].add(rig.anchor);
    }
    // The Blood Moon bakes the ronin's afterimages once per battle.
    const ultimate = battle.turns.find(turn => turn.move === 'ultimate');
    const ghosts: T.BufferGeometry[] = [];
    if (ultimate && battle.fighters[ultimate.attacker] === 'ronin') {
      const rig = this.rigs[ultimate.attacker]!;
      for (const pose of strikePoses('ronin')) { this.apply(rig, pose); ghosts.push(bakeRig(rig, false).geometry); }
    }
    this.ultimates.setGhosts(ghosts); this.ultimates.setHalves(null);
    if (ultimate && battle.fighters[ultimate.attacker] === 'ronin') {
      const victim = otherSide(ultimate.attacker), rig = this.rigs[victim]!;
      // The victim is frozen before the first slash. Prepare its full-detail snapshot before
      // playback, instead of cloning geometry and materials in the middle of the ultimate.
      // Secondary motion used to depend on whichever frame crossed 1.5 s; sample that beat
      // deterministically, then retain the existing 2.6 s skeleton pose for the split.
      const time = ultimate.at + 1500;
      const context: MotionContext = { battle, time, started: true, world: time / 1000, health: healthAt(battle, time, true) };
      const pose = fighterPose(victim, context); this.apply(rig, pose);
      this.updateRigDetails(rig, victim, pose, context, time / 1000);
      this.apply(rig, fighterPose(victim, { ...context, time: ultimate.at + 2600 }));
      this.ultimates.setHalves(bakeRig(rig, true)); this.halvesBakeCount++;
    }
    // Divine Judgment bakes the knight's colossal avatar (sword raised, then pointed at the victim).
    const avatar: T.BufferGeometry[] = [];
    if (ultimate && battle.fighters[ultimate.attacker] === 'knight') {
      const rig = this.rigs[ultimate.attacker]!;
      for (const pose of ultimatePoses('knight', [.82, 1])) { this.apply(rig, pose); avatar.push(bakeRig(rig, false).geometry); }
    }
    this.ultimates.setAvatar(avatar);
    keepAlpha(this.scene);
    this.previousBattle = battle;
    this.canvas.dataset['preparationCount'] = String(++this.preparationCount);
    this.canvas.dataset['halvesBakeCount'] = String(this.halvesBakeCount);
    this.canvas.dataset['preparationMs'] = (performance.now() - preparationStart).toFixed(2);
    this.canvas.dataset['halvesGroups'] = String(this.ultimates.halves[0]?.geometry.groups.length ?? 0);
    this.canvas.dataset['halvesMaterialCount'] = String((this.ultimates.halves[0]?.material as T.Material[] | undefined)?.length ?? 0);
  }

  /** Issue hidden effect programs before combat, using the same HDR/fog variant as the real draw.
   * compile() also traverses invisible meshes, so it needs no temporary scene/visibility changes.
   * Keep preparation synchronous: no promise may outlive a battle's materials or this renderer.
   * Three's compile path does not prepare local-clipping variants; those still compile on use.
   */
  private prepareShaders(state: DuelSceneState): void {
    if (this.shadersFor === state.battle && this.shadersTransparent === state.transparent) return;
    this.shadersFor = state.battle; this.shadersTransparent = state.transparent;
    const previousTarget = this.renderer.getRenderTarget(), started = performance.now();
    try {
      this.renderer.setRenderTarget(this.composer.renderTarget1);
      this.renderer.compile(this.scene, this.camera);
      this.canvas.dataset['shaderPrep'] = 'compiled';
    } catch {
      // Preparation is optional; leave the normal render path available on unsupported drivers.
      this.canvas.dataset['shaderPrep'] = 'deferred';
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      this.canvas.dataset['shaderPreparationCount'] = String(++this.shaderPreparationCount);
      this.canvas.dataset['shaderPreparationMs'] = (performance.now() - started).toFixed(2);
    }
  }

  /** Pose → skeleton, with two-bone IK keeping feet planted on their targets. */
  private apply(rig: ClaudeRig, pose: Pose): void {
    rig.anchor.position.set(BASE + pose.r[0], pose.r[1], pose.r[2]); rig.anchor.rotation.set(0, 0, pose.tilt);
    rig.root.rotation.set(0, FACING + pose.yaw, 0); rig.root.scale.set(...pose.scale); rig.root.visible = !pose.hidden;
    rig.j.hp.position.set(pose.h[0], HIP_HEIGHT + pose.h[1], pose.h[2]);
    for (const name of ARM_JOINTS) rig.j[name].rotation.set(...pose.j[name]);
    rig.j.hp.updateMatrix(); this.matrix.copy(rig.j.hp.matrix).invert();
    for (const [legs, foot] of [[rig.legs.R, pose.fR], [rig.legs.L, pose.fL]] as const) {
      const [thigh, knee, ankle] = legs, d = this.v.set(...foot).applyMatrix4(this.matrix).sub(thigh.position);
      const phi = Math.atan2(d.x, -d.y), dy = -Math.hypot(d.x, d.y), dz = d.z;
      const len = clamp(Math.hypot(dy, dz), .15, THIGH + SHIN - .002);
      const knee_ = Math.PI - Math.acos(clamp((THIGH * THIGH + SHIN * SHIN - len * len) / (2 * THIGH * SHIN), -1, 1));
      const alpha = Math.atan2(dz, -dy), beta = Math.acos(clamp((THIGH * THIGH + len * len - SHIN * SHIN) / (2 * THIGH * len), -1, 1));
      thigh.rotation.set(-(alpha + beta), 0, phi); knee.rotation.set(knee_, 0, 0);
      ankle.rotation.set(alpha + beta - knee_ - pose.j.hp[0], -pose.j.hp[1] * .6, -phi);
    }
    rig.weapon.visible = !(rig.sheathed && pose.sheathed); if (rig.sheathed) rig.sheathed.visible = pose.sheathed;
    if (rig.gourdHand && rig.gourdBelt) { rig.gourdHand.visible = pose.gourd; rig.gourdBelt.visible = !pose.gourd; }
    syncToggles(rig);
    for (const material of rig.glow) material.emissiveIntensity = (material.userData['base'] as number) * pose.glow;
    rig.flash.set(pose.flashColor).multiplyScalar(pose.flash * .22);
  }

  /** World-space position of a fighter's anchor for a given pose (stages mirror the right side). */
  private anchorWorld(side: DuelSide, pose: Pose, out: T.Vector3): T.Vector3 { return out.set((side === 'left' ? 1 : -1) * (BASE + pose.r[0]), pose.r[1], pose.r[2]); }

  /** Secondary mesh motion is shared by live fighters and their prepared ultimate snapshots. */
  private updateRigDetails(rig: ClaudeRig, side: DuelSide, pose: Pose, ctx: MotionContext, clock: number): void {
    const before = fighterPose(side, { ...ctx, time: Math.max(0, ctx.time - 40), world: ctx.world - .04 });
    const velocity = this.anchorWorld(side, pose, new T.Vector3()).sub(this.anchorWorld(side, before, this.v)).multiplyScalar(ctx.started ? 25 : 0);
    rig.anchor.updateMatrixWorld(true);
    for (const cloth of rig.cloths) {
      this.m3.setFromMatrix4(cloth.parent.matrixWorld).invert();
      cloth.update(clock + (side === 'left' ? 0 : 1.3), velocity.clone().applyMatrix3(this.m3), pose.wind);
    }
    for (const runes of rig.runes) runes.offset.x = -clock * .04;
    if (rig.book) { rig.book.position.set(.62 + Math.sin(clock * .9) * .05, 1.45 + Math.sin(clock * 1.7) * .07, .2); rig.book.rotation.set(-.5 + Math.sin(clock * 1.3) * .08, clock * .35, .25); }
    rig.orbs.forEach((orb, i) => { const a = clock * 2.2 + i * 2.094; orb.position.set(Math.cos(a) * .22, Math.sin(a) * .22, 1.4 + Math.sin(clock * 3 + i) * .05); });
    (rig.aura.material as T.ShaderMaterial).uniforms['uTime'].value = clock;
  }

  private update(state: DuelSceneState, world: number, reduced: boolean): void {
    if (this.previousBattle !== state.battle) this.rebuild(state.battle);
    const battle = state.battle, transparent = state.transparent;
    this.environment.visible = !transparent; this.scene.fog = transparent ? null : this.fog; this.renderer.setClearColor('#0a0d1c', transparent ? 0 : 1);
    const time = state.started ? state.elapsed : 0, clock = state.started ? time / 1000 : world;
    const health = healthAt(battle, time, state.started), ctx: MotionContext = { battle, time, started: state.started, world, health };
    const done = state.started && time >= battle.duration, last = battle.turns.at(-1)!;
    const turn = state.started && !done ? activeTurn(battle, time) : null, ultimate = turn?.move === 'ultimate' ? turn : null;
    const poses = {} as Record<DuelSide, Pose>;
    // Fighters, cloth and IK.
    for (const side of SIDES) {
      const rig = this.rigs[side]!, pose = fighterPose(side, ctx); poses[side] = pose; this.apply(rig, pose);
      this.updateRigDetails(rig, side, pose, ctx, clock);
      const hips = rig.j.hp.getWorldPosition(this.v), lift = clamp(hips.y - .9, 0, 3), shadow = this.contact[side];
      shadow.visible = !pose.hidden; shadow.position.set(hips.x, .02, hips.z); shadow.scale.setScalar(1 + lift * .35 + pose.tilt * .5);
      (shadow.material as T.MeshBasicMaterial).opacity = .62 * (1 - clamp(lift / 2.2, 0, .85));
    }
    this.probe.visible = this.canvas.dataset['nanProbe'] === '1';
    // Effects.
    const positions = Object.fromEntries(SIDES.map(side => [side, this.anchorWorld(side, { ...poses[side], r: [0, 0, 0] }, new T.Vector3())])) as Record<DuelSide, T.Vector3>;
    const tipAt = (side: DuelSide) => (at: number) => {
      const rig = this.rigs[side]!; this.apply(rig, fighterPose(side, { ...ctx, time: at })); rig.anchor.updateMatrixWorld(true);
      const p = rig.tip.getWorldPosition(new T.Vector3()); this.apply(rig, poses[side]); rig.anchor.updateMatrixWorld(true); return p;
    };
    if (turn && !ultimate) {
      const attacker = turn.attacker, defender = otherSide(attacker);
      this.combat.update({
        turn, time, attacker: battle.fighters[attacker], defender: battle.fighters[defender], from: positions[attacker], to: positions[defender],
        chest: positions[defender].clone().setY(1.5), tipAt: tipAt(attacker), accent: this.rigs[attacker]!.accent, defenderAccent: this.rigs[defender]!.accent,
        crit: !!turn.crit, lethal: turn === last,
      }, world);
    } else this.combat.update(null, world);
    const portrait = this.camera.aspect < 1.4;
    if (ultimate) {
      const attacker = ultimate.attacker, rig = this.rigs[attacker]!;
      rig.anchor.updateMatrixWorld(true);
      this.ultimates.update({
        character: battle.fighters[attacker], age: (time - ultimate.at) / 1000, windup: (ultimate.hitAt - ultimate.at) / 1000, from: positions[attacker], to: positions[otherSide(attacker)],
        dir: attacker === 'left' ? 1 : -1, world: clock, tip: rig.tip.getWorldPosition(new T.Vector3()), chest: rig.focus.getWorldPosition(new T.Vector3()), portrait,
      });
    } else this.ultimates.update(null);
    this.trail(battle, turn, time, ctx, poses);
    // Camera direction.
    const look = this.ultimates.look, fx = this.combat.fx;
    let pos = new T.Vector3(Math.sin(world * .12) * .5, portrait ? 2.6 : 2.15, portrait ? 11.8 : 8.7), fov = portrait ? 38 : 34, roll = 0;
    this.look.set(0, 1.45, 0);
    if (state.started && time < 1300) { const k = 1 - smooth(time / 1300); pos.y += k * 2.4; pos.z += k * 2.2; this.look.y += k * .6; }
    else if (state.started && time < 3700) pos.z -= smooth((time - 1300) / 2400) * .5;
    if (turn && !ultimate && !reduced) {
      const defender = positions[otherSide(turn.attacker)], length = (turn.move === 'heal' ? 1500 : 0) || (turn.hitAt - turn.at) + 700;
      const w = pulse((time - turn.at) / length) * (turn.move === 'special' ? 1 : turn.move === 'heal' ? .5 : .6), focus = turn.move === 'heal' ? positions[turn.attacker] : defender;
      pos.x += focus.x * .2 * w; this.look.x += focus.x * .3 * w; pos.z -= (turn.move === 'special' ? 1.6 : 1) * w; pos.y -= .3 * w;
    }
    if (state.started && !ultimate && last.move !== 'ultimate' && time >= last.hitAt && !reduced) {
      // Knockout: a slow push on the falling fighter before the hero shot.
      const k = pulse((time - last.hitAt) / 2200), loser = positions[otherSide(battle.winner)];
      pos.lerp(new T.Vector3(loser.x * .55, 1.6, portrait ? 9.4 : 7.2), k * .7); this.look.lerp(new T.Vector3(loser.x * .8, 1.0, 0), k * .7);
    }
    if (look.shot && !reduced) { pos = look.shot.pos; this.look.copy(look.shot.look); fov = look.shot.fov; roll = look.shot.roll; }
    if (done) {
      const winner = this.rigs[battle.winner]!; winner.anchor.updateMatrixWorld(true);
      const w = winner.focus.getWorldPosition(new T.Vector3()), side = Math.sign(w.x) || 1;
      pos = reduced ? pos : new T.Vector3(w.x - side * 1.6 + Math.sin(world * .25) * .35, 1.75, portrait ? 8.6 : 6.6); this.look.set(w.x - side * .2, 1.45, w.z); fov = portrait ? 40 : 34;
    }
    const shake = reduced ? 0 : Math.max(fx.shake, look.shake);
    pos.x += Math.sin(time * .093) * shake; pos.y += Math.cos(time * .121) * shake * .8;
    this.camera.position.copy(pos); this.camera.fov = fov; this.camera.updateProjectionMatrix(); this.camera.lookAt(this.look); this.camera.rotateZ(roll);
    for (const particles of [...this.combat.particles, ...this.ultimates.particles, this.ambient]) particles.setScale(this.height, fov);
    // Atmosphere, light and grade.
    const dark = look.dark, sky = this.sky.uniforms;
    sky['uTime'].value = world; sky['uDark'].value = dark; sky['uRed'].value = look.ink; sky['uTintAmount'].value = look.tintAmount; (sky['uTint'].value as T.Color).copy(look.tint);
    this.floor.uniforms['uTime'].value = clock; this.floor.uniforms['uPower'].value = look.floorPower;
    (this.floor.uniforms['uColor'].value as T.Color).set(battle.enraged ? '#ff3a55' : '#7b63e6').lerp(look.floor, look.floorPower);
    const pulseAt = turn && !ultimate && turn.move !== 'heal' && time >= turn.hitAt ? (time - turn.hitAt) / 700 : -1; this.floor.uniforms['uPulse'].value = pulseAt > 1 ? -1 : pulseAt;
    this.corona.uniforms['uTime'].value = world; (this.corona.uniforms['uColor'].value as T.Color).set('#c7a6ff').lerp(new T.Color('#ff2a48'), look.bloodMoon);
    for (const material of this.animated) material.uniforms['uTime'].value = world;
    this.sway.uTime.value = world; this.sway.uWind.value = .25 + Math.sin(world * .6) * .1; this.drift.uTime.value = world;
    this.flames.forEach((flame, i) => { flame.light.intensity = flame.base * (1 - dark * .6) * (.85 + Math.sin(world * 13 + i * 3) * .08 + Math.sin(world * 7.3 + i) * .07); });
    this.gate.rotation.z = Math.sin(world * .1) * .04;
    this.ambient.set(4, { x: 0, y: -.2, z: -.5 }, world, { life: 9, speed: 4.5, radius: 6, size: 5, a: '#cbbcff', b: '#ffcf9a', opacity: .55 * (1 - dark * .5) });
    this.hemi.intensity = .75 * (1 - dark * .65); this.key.intensity = 2.6 * (1 - dark * .55); this.gateLight.intensity = 12 * (1 - dark * .4) + look.bloodMoon * 30;
    this.gateLight.color.set('#8f6dff').lerp(new T.Color('#ff2a48'), look.bloodMoon);
    this.rims.forEach(rim => { rim.intensity = 45 * (1 - dark * .3); });
    const g = this.grade.uniforms; g['uTransparent'].value = transparent ? 1 : 0;
    const ripple = look.rippleStrength > 0 ? look : fx;
    if (ripple.ripple && ripple.rippleStrength > 0 && !reduced) {
      const p = ripple.ripple.clone().project(this.camera); (g['uRipplePos'].value as T.Vector2).set(p.x * .5 + .5, p.y * .5 + .5);
      g['uRippleAge'].value = ripple.rippleAge; g['uRippleStrength'].value = ripple.rippleStrength;
    } else g['uRippleStrength'].value = 0;
    g['uTime'].value = (time % 1000) + world; g['uInk'].value = look.ink; g['uImpact'].value = reduced ? 0 : look.impact;
    g['uAberration'].value = reduced ? 0 : Math.max(fx.aberration, look.aberration); g['uExposure'].value = fx.exposure + look.exposure;
    const flash = Math.max(fx.flash, look.flash) * (reduced ? .3 : 1); g['uFlash'].value = flash * .32; (g['uFlashColor'].value as T.Color).copy(look.flash > fx.flash ? look.flashColor : fx.flashColor);
    if (look.lensWorld && look.lens > .001) {
      const projected = look.lensWorld.clone().project(this.camera), distance = this.camera.position.distanceTo(look.lensWorld);
      (g['uLensPos'].value as T.Vector2).set(projected.x * .5 + .5, projected.y * .5 + .5);
      g['uLensE'].value = Math.abs(look.lens) / distance / (2 * Math.tan(fov * Math.PI / 360)) * 1.55;
    } else g['uLensE'].value = 0;
    this.bloom.strength = ultimate ? .45 : .42;
    // Telemetry for checks.
    this.canvas.dataset['ultimate'] = ultimate ? battle.fighters[ultimate.attacker] : '';
    this.canvas.dataset['elapsed'] = String(time); this.canvas.dataset['fighters'] = `${battle.fighters.left},${battle.fighters.right}`;
    this.canvas.dataset['visible'] = SIDES.map(side => poses[side].hidden ? 0 : 1).join(',');
    this.canvas.dataset['trail'] = this.combat.trail.mesh.visible ? '1' : '0';
    this.canvas.dataset['lens'] = (g['uLensE'].value as number).toFixed(3); this.canvas.dataset['ink'] = look.ink.toFixed(2);
    this.canvas.dataset['halves'] = String(this.ultimates.halves.filter(h => h.visible).length);
    this.canvas.dataset['avatar'] = String(this.ultimates.avatar.filter(m => m.visible).length);
  }

  /** Smear trails sample the real blade arc over the last frames (deterministic: poses are pure). */
  private trail(battle: DuelBattle, turn: ReturnType<typeof activeTurn>, time: number, ctx: MotionContext, poses: Record<DuelSide, Pose>): void {
    if (!turn || turn.move === 'heal' || this.motion.matches) return;
    const side = turn.attacker, character = battle.fighters[side];
    let opacity = 0;
    if (turn.move === 'ultimate') {
      const age = time - turn.at;
      if (character === 'knight') opacity = pulse((age - 2580) / 420);
      if (character === 'ronin') opacity = pulse((age - 2190) / 320);
    } else if (character !== 'mage') { const p = attackPhase(turn, time); opacity = smooth((p - .8) / .06) * (1 - smooth((p - 1.15) / .2)); }
    if (opacity <= .01) return;
    // Samples are taken relative to the fighter, so a dash shows the blade arc, not a sheet.
    const rig = this.rigs[side]!, points: { base: T.Vector3; tip: T.Vector3 }[] = [], here = this.anchorWorld(side, poses[side], new T.Vector3());
    let travel = 0;
    for (let i = 0; i <= this.combat.trail.samples; i++) {
      const at = Math.max(turn.at, time - i * 9), pose = fighterPose(side, { ...ctx, time: at }), shift = here.clone().sub(this.anchorWorld(side, pose, this.v));
      this.apply(rig, pose); rig.anchor.updateMatrixWorld(true);
      const point = { base: rig.bladeBase.getWorldPosition(new T.Vector3()).add(shift), tip: rig.bladeTip.getWorldPosition(new T.Vector3()).add(shift) };
      if (points.length) travel += point.tip.distanceTo(points[points.length - 1].tip);
      points.push(point);
    }
    this.apply(rig, poses[side]); rig.anchor.updateMatrixWorld(true);
    opacity *= smooth((travel - .25) / .6);
    if (opacity > .01) this.combat.trail.set(points, rig.accent, opacity);
  }

  dispose(): void {
    if (this.dead) return; this.dead = true; clearTimeout(this.timer);
    this.observer.disconnect(); this.motion.removeEventListener('change', this.motionChanged); this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    for (const side of SIDES) { const rig = this.rigs[side]; if (rig) disposeRig(rig); }
    this.ultimates.setGhosts([]); this.ultimates.setAvatar([]); this.ultimates.setHalves(null); this.mirror.dispose();
    this.envMap.dispose(); disposeObject(this.scene); this.assets.dispose();
    for (const pass of this.composer.passes) pass.dispose(); this.composer.dispose();
    this.key.shadow.dispose(); for (const rim of this.rims) rim.shadow.dispose();
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}

function paletteOf(battle: DuelBattle, side: DuelSide): Palette { return battle.enraged === side ? 'E' : side === 'left' ? 'L' : 'R'; }

/**
 * Vertex animation for a baked arena piece (also applied to its shadow). The piece's node
 * transform is baked into its geometry first, so the shader works in arena coordinates.
 */
function animate(mesh: T.Mesh, uniforms: Record<string, T.IUniform>, doubleSided: boolean, head: string, normal: string, vertex: string): void {
  mesh.updateMatrix();
  const geometry = mesh.geometry.clone();
  for (const name of ['position', 'normal']) {
    const attribute = geometry.getAttribute(name) as T.BufferAttribute, data = new Float32Array(attribute.count * 3);
    for (let i = 0; i < attribute.count; i++) { data[i * 3] = attribute.getX(i); data[i * 3 + 1] = attribute.getY(i); data[i * 3 + 2] = attribute.getZ(i); }
    geometry.setAttribute(name, new T.BufferAttribute(data, 3));
  }
  geometry.applyMatrix4(mesh.matrix); mesh.geometry = geometry; mesh.matrix.identity(); mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  const inject = (shader: T.WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = head + '\n' + shader.vertexShader
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + normal)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vertex);
  };
  const material = (mesh.material as T.MeshStandardMaterial).clone(); if (doubleSided) material.side = T.DoubleSide;
  material.onBeforeCompile = inject; material.customProgramCacheKey = () => 'duel-arena-' + mesh.name; mesh.material = material;
  const depth = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
  depth.onBeforeCompile = inject; depth.customProgramCacheKey = () => 'duel-arena-depth-' + mesh.name; mesh.customDepthMaterial = depth;
}

export function healthAt(battle: DuelBattle, time: number, started: boolean): Record<DuelSide, number> {
  const max = battle.maxHp ?? 100, health = { left: max, right: max };
  if (started) for (const turn of battle.turns) {
    if (time < turn.hitAt) break;
    if (turn.move === 'heal') health[turn.attacker] = Math.min(max, health[turn.attacker] + (turn.heal ?? 0));
    else { const defender = otherSide(turn.attacker); health[defender] = Math.max(0, health[defender] - turn.damage); if (turn.comboHeal && time >= turn.hitAt + COMBO_HEAL.delay) health[defender] = Math.min(max, health[defender] + turn.comboHeal); }
  }
  return health;
}

function disposeObject(root: T.Object3D): void {
  const geometries = new Set<T.BufferGeometry>(), materials = new Set<T.Material>();
  root.traverse(object => { if (object instanceof T.Mesh || object instanceof T.Points) { geometries.add(object.geometry); for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material); } });
  for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose();
}
