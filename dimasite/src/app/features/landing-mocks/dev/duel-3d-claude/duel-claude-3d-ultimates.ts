import * as T from 'three';
import type { DuelCharacter } from '../../../widgets/duel/duel-battle';
import { ClaudeAssets, GLSL_NOISE, Particles, Streaks, additive, beamMaterial, hash, ringMaterial, shaftMaterial, shellMaterial, sprite } from './duel-claude-3d-assets';
import { bladeGeometry } from './duel-claude-3d-rig';

const clamp = T.MathUtils.clamp, smooth = (x: number) => { const p = clamp(x, 0, 1); return p * p * (3 - 2 * p); };
const easeIn = (x: number) => clamp(x, 0, 1) ** 3, easeOut = (x: number) => 1 - (1 - clamp(x, 0, 1)) ** 3;
const pulse = (x: number) => (x <= 0 || x >= 1) ? 0 : Math.sin(x * Math.PI);

export interface CameraShot { pos: T.Vector3; look: T.Vector3; fov: number; roll: number }
interface CamKey { t: number; pos: [number, number, number]; look: [number, number, number]; fov: number; roll?: number }

/** Grade-pass and scene directives an ultimate requests this frame. */
export interface UltimateLook {
  shot: CameraShot | null; lensWorld: T.Vector3 | null; lens: number; ink: number; impact: number; flash: number; flashColor: T.Color;
  dark: number; tint: T.Color; tintAmount: number; aberration: number; shake: number; floor: T.Color; floorPower: number; bloodMoon: number; exposure: number;
  ripple: T.Vector3 | null; rippleAge: number; rippleStrength: number;
}

export interface UltimateContext {
  character: DuelCharacter; age: number; windup: number; from: T.Vector3; to: T.Vector3; dir: number; world: number;
  tip: T.Vector3; chest: T.Vector3; portrait: boolean;
}

const GHOST_COUNT = 6, CUT_COUNT = 15;

export class UltimateEffects {
  readonly root = new T.Group();
  readonly particles: Particles[] = [];
  readonly look: UltimateLook = { shot: null, lensWorld: null, lens: 0, ink: 0, impact: 0, flash: 0, flashColor: new T.Color(), dark: 0, tint: new T.Color(), tintAmount: 0, aberration: 0, shake: 0, floor: new T.Color(), floorPower: 0, bloodMoon: 0, exposure: 0, ripple: null, rippleAge: 0, rippleStrength: 0 };
  // Divine Judgment
  private readonly judgment = new T.Group();
  private readonly portal: T.Mesh;
  private readonly portalRings: T.Mesh[];
  private readonly rays: T.Mesh[] = [];
  private readonly wings: T.InstancedMesh;
  private readonly colossus = new T.Group();
  private readonly colossusMaterial: T.MeshStandardMaterial;
  private readonly heavenBeam: T.Mesh;
  private readonly chains: T.Mesh[] = [];
  private readonly pillar: T.Mesh;
  private readonly crack: T.Mesh;
  private readonly debris: T.InstancedMesh;
  private readonly feathers: T.InstancedMesh;
  // Black Hole
  private readonly singularity = new T.Group();
  private readonly horizon: T.Mesh;
  private readonly photon: T.Mesh;
  private readonly disk: T.Mesh;
  private readonly lensed: T.Mesh;
  private readonly jets: T.Mesh[] = [];
  private readonly circles: T.Mesh[] = [];
  private readonly nova: T.Mesh;
  private readonly rubble: T.InstancedMesh;
  // Blood Moon
  private readonly crimson = new T.Group();
  private readonly moon: T.Mesh;
  private readonly moonHalo: T.Sprite;
  private readonly petals: T.InstancedMesh;
  private readonly cuts: T.Mesh[] = [];
  readonly ghosts: T.Mesh[] = [];
  readonly avatar: T.Mesh[] = [];
  private readonly avatarWings: T.InstancedMesh;
  readonly ghostMaterial: T.ShaderMaterial;
  readonly halves: T.Mesh[] = [];
  readonly planes = [new T.Plane(), new T.Plane()];
  // Shared
  private readonly shock: T.Mesh;
  private readonly flare: T.Sprite;
  private readonly streak: T.Sprite;
  private readonly burst: Particles;
  private readonly streakBurst = new Streaks(260, 41);
  private readonly swirl: Particles;
  private readonly motes: Particles;
  private readonly light = new T.PointLight('#ffffff', 0, 16, 1.6);
  private readonly dummy = new T.Object3D();
  private readonly v = new T.Vector3();

  constructor(private readonly assets: ClaudeAssets) {
    this.root.add(this.judgment, this.singularity, this.crimson, this.light);
    // ---- Divine Judgment ---------------------------------------------------------------
    this.portal = new T.Mesh(new T.CircleGeometry(4.8, 96), new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
      uniforms: { uTime: { value: 0 }, uOpen: { value: 0 } },
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `varying vec2 vUv;uniform float uTime;uniform float uOpen;${GLSL_NOISE}
      void main(){vec2 p=(vUv-.5)*2.;float r=length(p);float a=atan(p.y,p.x);
        float swirl=fbm(vec2(a*2.+r*4.-uTime*.6,r*3.-uTime*.3))*fbm(vec2(a*3.-uTime*.2,r*6.));
        float hole=smoothstep(uOpen*.42,uOpen*.42-.12,r);float clouds=smoothstep(.15,.6,swirl)*smoothstep(1.,.55,r)*smoothstep(uOpen*.36,uOpen*.5,r);
        vec3 c=vec3(1.,.82,.45)*clouds*1.4+vec3(1.,.95,.8)*hole*2.4+vec3(1.,.7,.3)*exp(-abs(r-uOpen*.45)*18.)*1.6;
        gl_FragColor=vec4(c*uOpen*.65,1.);}`,
    }));
    this.portal.rotation.x = Math.PI / 2;
    this.portalRings = [0, 1].map(i => { const m = new T.Mesh(new T.PlaneGeometry(1, 1), additive('#ffd27a', assets.sigil)); m.rotation.x = Math.PI / 2; m.scale.setScalar(i ? 4.6 : 6.8); return m; });
    for (let i = 0; i < 7; i++) { const ray = new T.Mesh(new T.ConeGeometry(.07 + hash(i) * .08, 9, 10, 1, true), shaftMaterial('#ffe3a6', .45)); ray.geometry.translate(0, -4.5, 0); this.rays.push(ray); }
    this.judgment.add(this.portal, ...this.portalRings, ...this.rays);
    this.wings = new T.InstancedMesh(new T.PlaneGeometry(.26, 1.25).translate(0, .62, 0), additive('#ffd58c', assets.feather, .95), 36); this.wings.frustumCulled = false;
    this.colossusMaterial = new T.MeshStandardMaterial({ color: '#fff3d6', emissive: '#ff9f3a', emissiveIntensity: .3, metalness: .85, roughness: .22, transparent: true });
    const blade = new T.Mesh(bladeGeometry(6.4, .62, 1.1, .1), this.colossusMaterial);
    const core = new T.Mesh(bladeGeometry(6.0, .16, .8, .12), additive('#ffe2a0', null, .28)); core.position.z = .2;
    const guard = new T.Mesh(new T.BoxGeometry(.3, 2.4, .32), this.colossusMaterial); guard.position.z = -.1;
    const grip = new T.Mesh(new T.CylinderGeometry(.13, .15, 1.3, 12), this.colossusMaterial); grip.rotation.x = Math.PI / 2; grip.position.z = -.8;
    const halo = new T.Mesh(new T.TorusGeometry(.75, .05, 8, 48), additive('#ffd27a')); halo.position.z = -1.0;
    for (const m of [blade, core, guard, grip, halo]) this.colossus.add(m);
    this.colossus.rotation.x = Math.PI / 2;
    this.heavenBeam = new T.Mesh(new T.CylinderGeometry(.09, .2, 1, 16, 1, true), beamMaterial('#fff0c8')); this.heavenBeam.geometry.translate(0, .5, 0);
    for (let i = 0; i < 3; i++) this.chains.push(new T.Mesh(new T.TorusGeometry(1, .035, 8, 64), additive('#ffd27a')));
    this.pillar = new T.Mesh(new T.CylinderGeometry(1.4, 1.9, 16, 40, 1, true), beamMaterial('#ffe9b8')); this.pillar.geometry.translate(0, 8, 0);
    this.crack = new T.Mesh(new T.PlaneGeometry(1, 1), additive('#ffc66b', assets.crack)); this.crack.rotation.x = -Math.PI / 2;
    this.debris = new T.InstancedMesh(new T.DodecahedronGeometry(.13, 0), new T.MeshStandardMaterial({ color: '#2a3047', roughness: .6, metalness: .3, emissive: '#ffb860', emissiveIntensity: .6, flatShading: true }), 28); this.debris.frustumCulled = false;
    this.feathers = new T.InstancedMesh(new T.PlaneGeometry(.12, .5), additive('#fff1cf', assets.feather, .9), 24); this.feathers.frustumCulled = false;
    this.avatarWings = new T.InstancedMesh(new T.PlaneGeometry(.26, 1.25).translate(0, .62, 0), additive('#ffd58c', assets.feather, .5), 44); this.avatarWings.frustumCulled = false;
    this.judgment.add(this.wings, this.colossus, this.heavenBeam, ...this.chains, this.pillar, this.crack, this.debris, this.feathers, this.avatarWings);
    // ---- Black Hole --------------------------------------------------------------------
    this.horizon = new T.Mesh(new T.SphereGeometry(1, 48, 32), new T.MeshBasicMaterial({ color: '#000000' }));
    this.photon = new T.Mesh(new T.RingGeometry(1.0, 1.14, 96), additive('#fff0ff'));
    const accretion = (lensed: boolean) => new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 }, uView: { value: 0 } },
      vertexShader: 'varying vec2 vP;void main(){vP=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `varying vec2 vP;uniform float uTime;uniform float uOpacity;uniform float uView;${GLSL_NOISE}
      void main(){float r=length(vP);float a=atan(vP.y,vP.x);float k=(r-1.25)/2.6;
        float turb=fbm(vec2(a*3.-uTime*2.2/(r*.6),r*5.-uTime*.4))*.7+fbm(vec2(a*9.-uTime*3./r,r*14.))*.4;
        vec3 hot=mix(vec3(1.,.96,1.),vec3(1.,.55,.85),smoothstep(0.,.35,k));hot=mix(hot,vec3(.5,.25,1.),smoothstep(.3,.95,k));
        float doppler=${lensed ? '1.' : '1.+.75*cos(a-uView)'};
        float fall=smoothstep(1.,.0,k)*smoothstep(-.02,.06,k);float alpha=fall*(.35+turb*.95)*doppler;
        ${lensed ? 'alpha*=smoothstep(-.2,.6,vP.y/r);' : ''}
        gl_FragColor=vec4(hot*alpha*uOpacity*1.5,1.);}`,
    });
    this.disk = new T.Mesh(new T.RingGeometry(1.25, 3.85, 160, 4), accretion(false));
    this.lensed = new T.Mesh(new T.RingGeometry(1.15, 2.4, 128, 2), accretion(true));
    for (const s of [-1, 1]) { const jet = new T.Mesh(new T.CylinderGeometry(.02, .35, 7, 20, 1, true), beamMaterial('#c9a6ff')); jet.geometry.translate(0, 3.5, 0); jet.rotation.z = s > 0 ? 0 : Math.PI; this.jets.push(jet); }
    for (let i = 0; i < 3; i++) this.circles.push(new T.Mesh(new T.PlaneGeometry(1, 1), additive('#c9a6ff', assets.glyph)));
    this.nova = new T.Mesh(new T.SphereGeometry(1, 48, 32), shellMaterial('#f2d8ff', false));
    this.rubble = new T.InstancedMesh(new T.DodecahedronGeometry(.16, 0), new T.MeshStandardMaterial({ color: '#1d2333', roughness: .5, metalness: .4, emissive: '#7a4dff', emissiveIntensity: .5, flatShading: true }), 30); this.rubble.frustumCulled = false;
    this.singularity.add(this.horizon, this.photon, this.disk, this.lensed, ...this.jets);
    this.root.add(...this.circles, this.nova, this.rubble);
    // ---- Blood Moon --------------------------------------------------------------------
    this.moon = new T.Mesh(new T.SphereGeometry(1.7, 64, 40), new T.ShaderMaterial({
      transparent: true, depthWrite: false, toneMapped: false, uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 } },
      vertexShader: 'varying vec3 vN;varying vec3 vP;varying vec3 vV;void main(){vN=normalize(normalMatrix*normal);vP=position;vec4 mv=modelViewMatrix*vec4(position,1.);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
      fragmentShader: `varying vec3 vN;varying vec3 vP;varying vec3 vV;uniform float uOpacity;uniform float uTime;${GLSL_NOISE}
      void main(){float n=fbm(vP.xy*1.6+vP.z*.7);float craters=smoothstep(.55,.75,fbm(vP.xy*3.+4.));float lit=clamp(dot(vN,normalize(vec3(-.4,.5,1.))),0.,1.);
        vec3 c=mix(vec3(.45,.02,.06),vec3(1.,.18,.2),n)*(.35+lit*.9)-craters*.12;float rim=pow(max(0.,1.-abs(dot(vN,vV))),3.);
        gl_FragColor=vec4((c+vec3(1.,.2,.25)*rim*1.5)*1.6,uOpacity);}`,
    }));
    this.moonHalo = sprite(assets.radial, '#ff2d48', 9);
    this.petals = new T.InstancedMesh(new T.PlaneGeometry(.11, .11), new T.MeshBasicMaterial({ map: assets.petal, color: '#ff5d7c', transparent: true, depthWrite: false, side: T.DoubleSide, toneMapped: false }), 70); this.petals.frustumCulled = false;
    for (let i = 0; i < CUT_COUNT; i++) {
      const cut = new T.Mesh(new T.PlaneGeometry(1, 1), new T.ShaderMaterial({
        transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
        uniforms: { uOpacity: { value: 1 }, uWhite: { value: 0 } },
        vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
        fragmentShader: `varying vec2 vUv;uniform float uOpacity;uniform float uWhite;void main(){float y=abs(vUv.y-.5)*2.;float x=vUv.x;float body=smoothstep(1.,.0,y)*smoothstep(0.,.12,x)*smoothstep(1.,.75,x);
          float core=smoothstep(.25,0.,y);vec3 c=mix(vec3(1.,.1,.25),vec3(1.),core*.8+uWhite);gl_FragColor=vec4(c*body*uOpacity*(1.1+uWhite*.7),1.);}`,
      }));
      this.cuts.push(cut);
    }
    this.ghostMaterial = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false, uniforms: { uOpacity: { value: 1 } },
      vertexShader: 'varying vec3 vN;varying vec3 vV;void main(){vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
      fragmentShader: 'varying vec3 vN;varying vec3 vV;uniform float uOpacity;void main(){float rim=pow(max(0.,1.-abs(dot(vN,vV))),2.5);gl_FragColor=vec4(vec3(1.,.1,.25)*(rim*.75+.03)*uOpacity,1.);}',
    });
    this.crimson.add(this.moon, this.moonHalo, this.petals, ...this.cuts);
    // ---- Shared ------------------------------------------------------------------------
    this.shock = new T.Mesh(new T.PlaneGeometry(1, 1), ringMaterial('#ffffff')); this.shock.rotation.x = -Math.PI / 2;
    this.flare = sprite(assets.radial, '#ffffff', 1); this.streak = sprite(assets.streak, '#ffffff', 1);
    this.burst = this.addParticles(260, 21); this.swirl = this.addParticles(320, 23); this.motes = this.addParticles(160, 29);
    this.root.add(this.shock, this.flare, this.streak, this.streakBurst.mesh);
    this.hide();
  }

  private addParticles(count: number, seed: number): Particles { const p = new Particles(count, this.assets.radial, seed); this.particles.push(p); this.root.add(p.points); return p; }

  /** Ghost afterimages and split halves are baked per battle by the scene. */
  setGhosts(geometries: T.BufferGeometry[]): void {
    for (const ghost of this.ghosts) { this.crimson.remove(ghost); ghost.geometry.dispose(); }
    this.ghosts.length = 0;
    for (const geometry of geometries) { const ghost = new T.Mesh(geometry, this.ghostMaterial); ghost.frustumCulled = false; this.ghosts.push(ghost); this.crimson.add(ghost); }
  }
  private readonly halfOrigin = new T.Vector3();
/** The spectral avatar: the knight baked in two poses, drawn as translucent gold light. */
  setAvatar(geometries: T.BufferGeometry[]): void {
    for (const mesh of this.avatar) { this.judgment.remove(mesh); mesh.geometry.dispose(); (mesh.material as T.Material).dispose(); }
    this.avatar.length = 0;
    for (const geometry of geometries) {
      const material = new T.ShaderMaterial({
        transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false, uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 } },
        vertexShader: 'varying vec3 vN;varying vec3 vV;varying float vY;void main(){vN=normalize(normalMatrix*normal);vec4 w=modelMatrix*vec4(position,1.);vY=w.y;vec4 mv=viewMatrix*w;vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
        fragmentShader: `varying vec3 vN;varying vec3 vV;varying float vY;uniform float uOpacity;uniform float uTime;
          void main(){float rim=pow(max(0.,1.-abs(dot(vN,vV))),2.2);float bands=.55+.45*sin(vY*5.-uTime*4.);float rise=smoothstep(-1.,4.,vY);
            vec3 c=mix(vec3(1.,.6,.2),vec3(1.,.96,.82),rim)*(rim*1.9+.16+.16*bands)*(.65+.35*rise);gl_FragColor=vec4(c*uOpacity,1.);}`,
      });
      const mesh = new T.Mesh(geometry, material); mesh.frustumCulled = false; this.avatar.push(mesh); this.judgment.add(mesh);
    }
  }

  setHalves(baked: { geometry: T.BufferGeometry; materials: T.Material[]; origin: T.Vector3 } | null): void {
    for (const half of this.halves) { this.root.remove(half); for (const m of half.material as T.Material[]) m.dispose(); }
    if (this.halves[0]) this.halves[0].geometry.dispose();
    this.halves.length = 0;
    if (!baked) return;
    this.halfOrigin.copy(baked.origin);
    for (let i = 0; i < 2; i++) {
      const materials = baked.materials.map(material => { const m = material.clone(); m.userData['glow'] = material instanceof T.MeshStandardMaterial && material.emissiveIntensity > 1; m.clippingPlanes = [this.planes[i]]; m.side = T.DoubleSide; m.transparent = true; return m; });
      const half = new T.Mesh(baked.geometry, materials); half.frustumCulled = false; this.halves.push(half); this.root.add(half);
    }
  }

  hide(): void {
    this.judgment.visible = this.singularity.visible = this.crimson.visible = false;
    for (const child of [...this.root.children, ...this.judgment.children, ...this.crimson.children]) if (child !== this.judgment && child !== this.singularity && child !== this.crimson && !(child instanceof T.Light)) child.visible = false;
    this.light.intensity = 0;
    const l = this.look; l.shot = null; l.lensWorld = null; l.ripple = null; l.rippleAge = l.rippleStrength = 0; l.lens = l.ink = l.impact = l.flash = l.dark = l.tintAmount = l.aberration = l.shake = l.floorPower = l.bloodMoon = l.exposure = 0;
  }

  update(ctx: UltimateContext | null): void {
    this.hide();
    if (!ctx) return;
    const { character, age, windup } = ctx, hit = age - windup, l = this.look;
    l.shot = this.camera(ctx);
    // Impact frame: two high-contrast frames at contact (skipped under reduced motion by the scene).
    l.impact = hit >= 0 && hit < .045 ? 1 : hit >= .045 && hit < .09 ? 2 : 0;
    l.flash = hit >= 0 ? Math.exp(-hit * 9) : 0; l.shake = hit >= 0 ? Math.exp(-hit * 3) * .22 : 0; l.aberration = hit >= 0 ? Math.exp(-hit * 5) * .012 : 0;
    if (character === 'knight') this.divineJudgment(ctx, hit);
    else if (character === 'mage') this.blackHole(ctx, hit);
    else this.bloodMoon(ctx, hit);
  }

  private camera(ctx: UltimateContext): CameraShot {
    const { from, to, dir, character, age } = ctx, fx = from.x, tx = to.x, mid = (fx + tx) / 2;
    const keys: Record<DuelCharacter, CamKey[]> = {
      knight: [
        { t: 0, pos: [fx + dir * 1.9, .9, 3.6], look: [fx, 1.0, 0], fov: 30 },
        { t: .85, pos: [fx + dir * 1.35, .55, 4.4], look: [fx, 1.45, 0], fov: 33 },
        { t: 1.45, pos: [fx - dir * .5, .6, 6.2], look: [fx + dir * .9, 3.4, 0], fov: 46, roll: -dir * .04 },
        { t: 2.05, pos: [mid - dir * 1.2, 1.8, 13.2], look: [tx * .75, 4.3, 0], fov: 50 },
        { t: 2.55, pos: [tx - dir * 3.4, 1.4, 8.6], look: [tx, 3.2, 0], fov: 46 },
        { t: 2.8, pos: [tx - dir * 3.8, 1.8, 9.6], look: [tx, 1.7, 0], fov: 44 },
        { t: 4.7, pos: [mid * .3, 2.5, 11.6], look: [tx * .45, 1.5, 0], fov: 38 },
      ],
      mage: [
        { t: 0, pos: [fx + dir * 2.2, 1.2, 4.6], look: [fx, 1.6, 0], fov: 34 },
        { t: .9, pos: [fx - dir * 1.7, .8, 7.0], look: [fx + dir * 1.4, 2.2, 0], fov: 40, roll: dir * .03 },
        { t: 1.75, pos: [fx - dir * 1.7, 1.5, 8.2], look: [tx, 3.0, 0], fov: 44, roll: dir * .05 },
        { t: 2.5, pos: [tx - dir * 1.2, 2.3, 7.4], look: [tx, 3.2, 0], fov: 40, roll: -dir * .04 },
        { t: 2.8, pos: [tx - dir * 1.8, 2.4, 9.4], look: [tx, 2.4, 0], fov: 46 },
        { t: 4.7, pos: [mid * .3, 2.6, 11.8], look: [mid * .3, 1.6, 0], fov: 38 },
      ],
      ronin: [
        { t: 0, pos: [fx + dir * 1.7, 1.25, 3.6], look: [fx, 1.3, 0], fov: 30 },
        { t: .95, pos: [fx + dir * 1.25, .72, 3.0], look: [fx + dir * .1, 1.42, 0], fov: 30 },
        { t: 1.3, pos: [fx + dir * 1.15, .7, 2.85], look: [fx + dir * .1, 1.42, 0], fov: 28 },
        { t: 1.42, pos: [tx - dir * 2.4, 1.4, 6.2], look: [tx, 1.5, 0], fov: 40 },
        { t: 2.1, pos: [tx + dir * 1.6, 1.9, 6.4], look: [tx, 1.4, 0], fov: 42, roll: dir * .03 },
        { t: 2.5, pos: [tx + dir * 3.2, 1.15, 4.9], look: [tx + dir * 1.1, 1.3, 0], fov: 35 },
        { t: 2.8, pos: [tx + dir * 3.3, 1.3, 5.7], look: [tx + dir * .7, 1.35, 0], fov: 37 },
        { t: 4.7, pos: [mid * .3, 2.5, 11.6], look: [tx * .45, 1.5, 0], fov: 38 },
      ],
    };
    const list = keys[character]; let i = 0; while (i < list.length - 2 && list[i + 1].t <= age) i++;
    const a = list[i], b = list[i + 1], k = smooth((age - a.t) / (b.t - a.t));
    const lerp = (x: [number, number, number], y: [number, number, number]) => new T.Vector3(x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k);
    const shot = { pos: lerp(a.pos, b.pos), look: lerp(a.look, b.look), fov: a.fov + (b.fov - a.fov) * k, roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * k };
    // Narrow (portrait) frames back off so both fighters and the effect stay framed.
    if (ctx.portrait) { shot.pos.sub(shot.look).multiplyScalar(1.3).add(shot.look); shot.fov += 6; }
    return shot;
  }

  private divineJudgment(ctx: UltimateContext, hit: number): void {
    const { age, to, from, world, dir } = ctx, l = this.look, gold = new T.Color('#ffd27a');
    this.judgment.visible = true;
    l.dark = smooth(age / .5) * (1 - smooth(hit / 1.2)) * .75; l.tint.set('#ffcf7a'); l.tintAmount = smooth((age - 1.0) / .6) * (1 - smooth((hit - .6) / 1.2)) * .7;
    l.floor.copy(gold); l.floorPower = smooth(age / .6) * (1 - smooth((hit - .4) / 1));
    l.flashColor.set('#fff1cc'); l.exposure = -.25 * smooth(age / .5) * (1 - smooth(hit / .3));
    // Rising motes around the kneeling knight.
    this.motes.set(2, new T.Vector3(from.x, .05, from.z), age - .2, { life: 1.6, speed: 1.8, radius: 1.1, size: 16, a: '#fff6dc', b: '#ffc966', opacity: 1 - smooth(hit / .5) });
    // Sword beam to the heavens.
    const beam = smooth((age - 1.15) / .2) * (1 - smooth((age - 2.5) / .2));
    this.heavenBeam.visible = beam > 0; this.heavenBeam.position.copy(ctx.tip); this.heavenBeam.scale.set(1 + beam, 14 * beam, 1 + beam);
    (this.heavenBeam.material as T.ShaderMaterial).uniforms['uOpacity'].value = beam * .5; (this.heavenBeam.material as T.ShaderMaterial).uniforms['uTime'].value = world;
    // The heavens part over the victim.
    const open = smooth((age - 1.1) / .65) * (1 - smooth((hit - .8) / 1));
    this.portal.visible = open > 0; this.portal.position.set(to.x, 8.2, to.z); (this.portal.material as T.ShaderMaterial).uniforms['uOpen'].value = open; (this.portal.material as T.ShaderMaterial).uniforms['uTime'].value = world;
    this.portalRings.forEach((ring, i) => { ring.visible = open > 0; ring.position.set(to.x, 7.9 - i * .25, to.z); ring.rotation.z = (i ? -1 : 1) * age * .6; (ring.material as T.MeshBasicMaterial).opacity = open * (i ? .8 : .55); });
    this.rays.forEach((ray, i) => {
      ray.visible = open > 0; const a = i / this.rays.length * Math.PI * 2 + age * .1; ray.position.set(to.x + Math.cos(a) * 1.4, 8.2, to.z + Math.sin(a) * 1.2);
      ray.rotation.set(Math.sin(a) * .18, 0, -Math.cos(a) * .18); (ray.material as T.ShaderMaterial).uniforms['uOpacity'].value = open * (.5 + .3 * Math.sin(world * 2 + i)); (ray.material as T.ShaderMaterial).uniforms['uTime'].value = world;
    });
    // Wings unfurl behind the knight.
    const unfurl = easeOut((age - .95) / .7), wingFade = 1 - smooth((hit - .3) / .9);
    this.wings.visible = unfurl > 0 && wingFade > 0 && this.avatar.length === 0; (this.wings.material as T.MeshBasicMaterial).opacity = .55 * wingFade;
    for (let s = 0; s < 2; s++) for (let i = 0; i < 18; i++) {
      const side = s ? 1 : -1, row = i % 3, n = Math.floor(i / 3), spread = (n / 5) * (.35 + unfurl * 1.25) + .1;
      this.dummy.position.set(from.x - dir * .25 + side * .1, 1.75 + row * .05, from.z - .35);
      this.dummy.rotation.set(-.2 - row * .1, side * .4 - dir * .6, side * (spread + row * .08) + Math.sin(world * 2 + n) * .03 * unfurl);
      const length = (1.15 + n * .32 - row * .25) * (.3 + unfurl * .7); this.dummy.scale.set(1 + row * .2, length, 1); this.dummy.updateMatrix(); this.wings.setMatrixAt(s * 18 + i, this.dummy.matrix);
    }
    this.wings.instanceMatrix.needsUpdate = true;
    // The colossal blade emerges, hovers, then falls.
    const emerge = easeOut((age - 1.5) / .8), plunge = easeIn((age - 2.6) / .2), embedded = hit >= 0;
    const y = embedded ? 6.55 : 17.5 - emerge * 8.9 - plunge * 2.05 + Math.sin(age * 30) * .03 * smooth((age - 2.3) / .3);
    this.colossus.visible = emerge > 0 && hit < 1.75; this.colossus.position.set(to.x, y, to.z + .1); this.colossus.rotation.z = Math.PI / 2 + (1 - emerge) * .8 + Math.sin(age * .7) * .05;
    this.colossusMaterial.opacity = 1 - smooth((hit - 1.1) / .6);
    // A colossal spectral knight rises behind its champion: sword to the heavens, then judgment.
    const rise = easeOut((age - 1.1) / .9), vanish = 1 - smooth((hit - .6) / .9), strike = smooth((age - 2.5) / .3);
    const statue = new T.Vector3(from.x - dir * 1.1, -5.2 + rise * 4.7, -4.9);
    this.avatar.forEach((mesh, i) => {
      const weight = i === 0 ? 1 - strike : strike; mesh.visible = rise > 0 && vanish > 0 && weight > .01;
      mesh.position.copy(statue); mesh.scale.setScalar(3.1); mesh.rotation.set(0, -dir * .55, 0);
      const u = (mesh.material as T.ShaderMaterial).uniforms; u['uOpacity'].value = rise * vanish * weight * .95; u['uTime'].value = age;
    });
    this.avatarWings.visible = rise > 0 && vanish > 0; (this.avatarWings.material as T.MeshBasicMaterial).opacity = .45 * rise * vanish;
    for (let s = 0; s < 2; s++) for (let i = 0; i < 22; i++) {
      const side = s ? 1 : -1, row = i % 2, n = Math.floor(i / 2), spread = (n / 10) * (.5 + rise * 1.1) + .15;
      this.dummy.position.set(statue.x + side * .3, statue.y + 5.2 + row * .2, statue.z - .7);
      this.dummy.rotation.set(-.15, dir * .3, side * (spread + row * .1) + Math.sin(age * 1.5 + n) * .04);
      this.dummy.scale.set(3 + row, (3.4 + n * .5 - row * .8) * (.4 + rise * .6), 1); this.dummy.updateMatrix(); this.avatarWings.setMatrixAt(s * 22 + i, this.dummy.matrix);
    }
    this.avatarWings.instanceMatrix.needsUpdate = true;
    // Chains of light bind the victim.
    const bind = smooth((age - 1.35) / .5);
    this.chains.forEach((chain, i) => {
      chain.visible = bind > 0 && hit < .15; chain.position.set(to.x, .7 + i * .65, to.z); chain.rotation.set(Math.PI / 2 + Math.sin(i * 2 + age) * .2, 0, age * (i % 2 ? 2 : -2));
      chain.scale.setScalar(1.6 - bind * (.95 - i * .08)); (chain.material as T.MeshBasicMaterial).opacity = bind;
    });
    // Impact.
    if (embedded) {
      const k = hit;
      this.pillar.visible = k < 1.2; this.pillar.position.set(to.x, 0, to.z); this.pillar.scale.set(.45 + easeOut(k / .3) * .45, 1, .45 + easeOut(k / .3) * .45);
      (this.pillar.material as T.ShaderMaterial).uniforms['uOpacity'].value = (1 - smooth(k / .65)) * .45; (this.pillar.material as T.ShaderMaterial).uniforms['uTime'].value = world;
      this.crack.visible = true; this.crack.position.set(to.x, .035, to.z); this.crack.scale.setScalar(2 + easeOut(k / .15) * 5.5); (this.crack.material as T.MeshBasicMaterial).opacity = (1 - smooth((k - .8) / 1)) * 1.3;
      this.shockwave(to, k, gold, 12);
      this.burst.set(0, new T.Vector3(to.x, 1, to.z), k, { life: 1.1, speed: 12, gravity: -5, spread: .9, size: 16, a: '#ffffff', b: '#ffbf5a' });
      this.streakBurst.set(new T.Vector3(to.x, .4, to.z), k, { life: 1.1, speed: 22, gravity: -9, spread: .7, width: .035, trail: .06, a: '#fff6dc', b: '#ffb84d' });
      this.wave(new T.Vector3(to.x, .8, to.z), k, .045);
      this.debris.visible = k < 1.6;
      for (let i = 0; i < 28; i++) {
        const a = hash(i) * Math.PI * 2, speed = 3 + hash(i * 3) * 5, up = 4 + hash(i * 5) * 5, t = Math.min(k, 1.6);
        this.dummy.position.set(to.x + Math.cos(a) * speed * t * .6, Math.max(.05, up * t - 6 * t * t), to.z + Math.sin(a) * speed * t * .6);
        this.dummy.rotation.set(t * 7 + i, t * 5, i); this.dummy.scale.setScalar(.6 + hash(i * 9) * 1.2); this.dummy.updateMatrix(); this.debris.setMatrixAt(i, this.dummy.matrix);
      }
      this.debris.instanceMatrix.needsUpdate = true;
      this.feathers.visible = true; (this.feathers.material as T.MeshBasicMaterial).opacity = (1 - smooth((k - 1.2) / .6)) * .9;
      for (let i = 0; i < 24; i++) {
        const a = hash(i * 2) * Math.PI * 2, r = .5 + hash(i * 4) * 3.2, fall = k * (.6 + hash(i) * .5);
        this.dummy.position.set(to.x + Math.cos(a) * r + Math.sin(k * 2 + i) * .3, 5.5 - fall * 2.6 + hash(i * 6) * 2, to.z + Math.sin(a) * r * .6);
        this.dummy.rotation.set(Math.sin(k * 3 + i) * .7, a + k, Math.sin(k * 2.4 + i * 3)); this.dummy.updateMatrix(); this.feathers.setMatrixAt(i, this.dummy.matrix);
      }
      this.feathers.instanceMatrix.needsUpdate = true;
      this.light.position.set(to.x, 3, to.z + 1.5); this.light.color.copy(gold); this.light.intensity = Math.exp(-k * 2) * 60;
    } else {
      this.light.position.set(to.x, 6, to.z + 1); this.light.color.copy(gold); this.light.intensity = open * 25 + bind * 10;
    }
    void dir;
  }

  private blackHole(ctx: UltimateContext, hit: number): void {
    const { age, windup, to, from, world, dir } = ctx, l = this.look, violet = new T.Color('#b49cff');
    const center = new T.Vector3(to.x + dir * .2, 3.35, to.z);
    l.dark = smooth((age - .4) / .6) * (1 - smooth(hit / 1)) * .85; l.tint.set('#7a3cff'); l.tintAmount = smooth((age - .6) / .8) * (1 - smooth(hit / 1.4)) * .65;
    l.floor.copy(violet); l.floorPower = smooth(age / .6) * (1 - smooth((hit - .3) / 1)); l.flashColor.set('#f4e2ff'); l.exposure = -.2 * smooth((age - .5) / .6) * (1 - smooth(hit / .3));
    // Glyph circles at the mage's feet, chest and behind.
    const glyph = smooth(age / .5) * (1 - smooth((hit - .4) / .6));
    this.circles.forEach((circle, i) => {
      circle.visible = glyph > 0; (circle.material as T.MeshBasicMaterial).opacity = glyph * (i === 0 ? 1 : .7);
      if (i === 0) { circle.position.set(from.x, .05, from.z); circle.rotation.set(-Math.PI / 2, 0, world * .7); circle.scale.setScalar(3.2); }
      else if (i === 1) { circle.position.set(from.x, 1.2 + 1.0, from.z); circle.rotation.set(-Math.PI / 2 + .25, 0, -world * 1.1); circle.scale.setScalar(1.9); }
      else { circle.position.set(from.x - dir * .4, 2.6, from.z - .8); circle.rotation.set(0, dir * .5, world * .4); circle.scale.setScalar(2.8); }
    });
    // Growth, collapse, supernova.
    const grow = easeIn((age - .7) / .35) * .14 + smooth((age - 1.05) / 1.45) * .86, collapse = easeIn((age - 2.52) / .26);
    const size = hit >= 0 ? 0 : Math.max(.02, grow * (1 - collapse * .97)) * .95;
    this.singularity.visible = size > .01; for (const child of this.singularity.children) child.visible = true; this.singularity.position.copy(center); this.singularity.scale.setScalar(size);
    this.disk.rotation.set(-Math.PI / 2 + .22, 0, -world * .6); this.lensed.lookAt(this.v.copy(center).add(new T.Vector3(0, 0, 10)));
    const view = Math.atan2(-dir, 1);
    for (const mesh of [this.disk, this.lensed]) { const m = mesh.material as T.ShaderMaterial; m.uniforms['uTime'].value = world; m.uniforms['uView'].value = view; m.uniforms['uOpacity'].value = smooth((age - 1.0) / .6); }
    this.photon.lookAt(this.v.copy(center).add(new T.Vector3(0, 0, 10)));
    this.jets.forEach(jet => { (jet.material as T.ShaderMaterial).uniforms['uOpacity'].value = smooth((age - 1.6) / .5) * .9; (jet.material as T.ShaderMaterial).uniforms['uTime'].value = world; jet.rotation.x = .22; });
    l.lensWorld = center.clone(); l.lens = hit >= 0 ? Math.max(0, .9 - hit * 3) * (hit < .25 ? Math.cos(hit * 40) : 0) : size * (1 + collapse * 1.4);
    // Matter spirals in: particles and floor rubble.
    this.swirl.set(1, center, age - .8, { life: 1.4, radius: 5 * (1 - collapse * .6), size: 13, a: '#f6e4ff', b: '#8f63ff', opacity: hit < 0 ? 1 : 0 });
    this.rubble.visible = hit < 0 && age > 1.1;
    for (let i = 0; i < 30; i++) {
      const start = 1.1 + hash(i) * .9, k = clamp((age - start) / (windup - start + .02), 0, 1), a0 = hash(i * 3) * Math.PI * 2, r0 = 2.2 + hash(i * 5) * 3.2;
      const a = a0 + k * k * 9, r = r0 * (1 - easeIn(k)) + .1, h = .1 + (center.y - .1) * smooth(k * 1.4);
      this.dummy.position.set(center.x + Math.cos(a) * r, k <= 0 ? .1 : h, center.z + Math.sin(a) * r * .7); this.dummy.rotation.set(k * 9 + i, k * 6, 0);
      this.dummy.scale.setScalar(k >= 1 ? 0 : (.6 + hash(i * 7)) * (1 - k * .7)); this.dummy.updateMatrix(); this.rubble.setMatrixAt(i, this.dummy.matrix);
    }
    this.rubble.instanceMatrix.needsUpdate = true;
    if (hit >= 0) {
      const k = hit; this.nova.visible = k < 1.4; this.nova.position.copy(center); this.nova.scale.setScalar(.3 + easeOut(k / 1.2) * 7.5);
      const n = this.nova.material as T.ShaderMaterial; n.uniforms['uOpacity'].value = (1 - smooth(k / 1.2)) * .45; n.uniforms['uColor'].value.set('#c9a2ff');
      this.flare.visible = k < .8; this.flare.position.copy(center); this.flare.scale.setScalar(2 + easeOut(k / .2) * 6); this.flare.material.opacity = .7 * (1 - smooth(k / .6)); this.flare.material.color.set('#f2e6ff');
      this.streak.visible = k < .7; this.streak.position.copy(center); this.streak.scale.set(28 * easeOut(k / .15), 1.2, 1); this.streak.material.opacity = 1 - smooth(k / .7); this.streak.material.color.set('#d9c4ff');
      this.burst.set(0, center, k, { life: 1.2, speed: 14, gravity: -2, spread: 1, size: 16, a: '#ffffff', b: '#a77bff' });
      this.streakBurst.set(center, k, { life: 1.2, speed: 26, gravity: -1, spread: 1, width: .03, trail: .07, a: '#f6ecff', b: '#9a6bff' });
      this.wave(center, k, .06);
      this.shockwave(new T.Vector3(to.x, 0, to.z), k, violet, 13);
      this.light.position.copy(center); this.light.color.set('#d8c2ff'); this.light.intensity = Math.exp(-k * 2.2) * 70;
    } else { this.light.position.copy(center); this.light.color.copy(violet); this.light.intensity = size * 18; }
  }

  private bloodMoon(ctx: UltimateContext, hit: number): void {
    const { age, to, from, world, dir } = ctx, l = this.look, red = new T.Color('#ff2d55');
    this.crimson.visible = true;
    l.dark = smooth(age / .6) * (1 - smooth((hit - .2) / 1.2)) * .9; l.tint.set('#ff1f3d'); l.tintAmount = smooth((age - .3) / .7) * (1 - smooth((hit - .3) / 1.3));
    l.floor.copy(red); l.floorPower = smooth((age - .3) / .6) * (1 - smooth((hit - .5) / 1));
    l.ink = smooth((age - .7) / .4) * (1 - smooth((hit - .12) / .7)); l.bloodMoon = smooth((age - .45) / .7) * (1 - smooth((hit - .8) / 1));
    l.flashColor.set('#ffe6ea');
    // Blood moon rises inside the gate.
    this.moon.visible = l.bloodMoon > 0; this.moon.position.set(0, 1.6 + l.bloodMoon * 2.0, -4.15); (this.moon.material as T.ShaderMaterial).uniforms['uOpacity'].value = l.bloodMoon;
    this.moonHalo.visible = this.moon.visible; this.moonHalo.position.copy(this.moon.position).setZ(-4.3); this.moonHalo.material.opacity = l.bloodMoon * .55;
    // Petals ride a slow cyclone around the arena.
    this.petals.visible = true; (this.petals.material as T.MeshBasicMaterial).opacity = smooth(age / .5) * (1 - smooth((hit - 1) / .8));
    for (let i = 0; i < 70; i++) {
      const a = hash(i) * Math.PI * 2 + age * (.5 + hash(i * 3) * .6) + (hit > 0 ? hit * 2.5 : 0), r = 1.6 + hash(i * 5) * 4.6 + (hit > 0 ? hit * 3 : 0);
      this.dummy.position.set(Math.cos(a) * r, .2 + ((hash(i * 7) * 4 + age * (.25 + hash(i) * .3)) % 4.5), Math.sin(a) * r * .55);
      this.dummy.rotation.set(age * 3 + i, age * 2 + i * 2, age + i); this.dummy.scale.setScalar(.8 + hash(i * 11) * .9); this.dummy.updateMatrix(); this.petals.setMatrixAt(i, this.dummy.matrix);
    }
    this.petals.instanceMatrix.needsUpdate = true;
    // The ronin vanishes: a bright streak where they stood.
    const vanish = age - 1.32;
    if (vanish > -.05 && vanish < .35) {
      const k = pulse((vanish + .05) / .4); this.streak.visible = true; this.streak.position.set(from.x + dir * .6, 1.4, from.z + .2); this.streak.scale.set(7 * k, .35, 1); this.streak.material.color.set('#ffd6de'); this.streak.material.opacity = k;
      this.burst.set(0, new T.Vector3(from.x, 1.2, from.z), vanish, { life: .7, speed: 6, gravity: -2, spread: 1, size: 14, a: '#ffffff', b: '#ff2d55' });
      this.streakBurst.set(new T.Vector3(from.x, 1.2, from.z), vanish, { life: .5, speed: 14, gravity: 0, spread: .35, dir: { x: dir, y: .1, z: 0 }, width: .02, trail: .08, a: '#ffffff', b: '#ff2d55' });
    }
    // Afterimages appear one by one around the frozen victim, each with its cuts.
    const ghostFade = 1 - smooth(hit / .2);
    this.ghosts.forEach((ghost, i) => {
      const appear = 1.4 + i * .13, k = smooth((age - appear) / .08); ghost.visible = k > 0 && ghostFade > 0;
      const a = (i / GHOST_COUNT) * Math.PI * 2 + .4, radius = 1.35;
      // Baked ghosts face the attacker's own heading; mirrored ones face the opposite way.
      const mirror = i % 2 ? -1 : 1;
      ghost.position.set(to.x + Math.cos(a) * radius, i % 2 ? .25 : 0, to.z + Math.sin(a) * radius * .8); ghost.scale.set(mirror, 1, 1);
      ghost.rotation.set(0, Math.atan2(to.x - ghost.position.x, to.z - ghost.position.z) - dir * mirror + (i % 2 ? .25 : -.2), 0);
    });
    this.ghostMaterial.uniforms['uOpacity'].value = ghostFade * (.8 + Math.sin(world * 20) * .08);
    this.cuts.forEach((cut, i) => {
      const appear = 1.42 + Math.floor(i / 2.5) * .13, k = smooth((age - appear) / .06), white = hit >= 0 ? Math.exp(-hit * 6) : 0;
      cut.visible = k > 0 && (hit < .55);
      cut.position.set(to.x + (hash(i) - .5) * .5, .7 + hash(i * 3) * 1.4, to.z + .35 + (hash(i * 5) - .5) * .4);
      cut.rotation.set((hash(i * 7) - .5) * .5, (hash(i * 9) - .5) * .8, hash(i * 11) * Math.PI);
      cut.scale.set(3.4 * (.6 + .4 * k) * (1 + white * .4), (.035 + hash(i) * .03) * (1 + white * 3), 1);
      const m = cut.material as T.ShaderMaterial; m.uniforms['uOpacity'].value = k * (hit >= 0 ? 1 - smooth(hit / .55) : .85 + Math.sin(world * 30 + i) * .15); m.uniforms['uWhite'].value = white;
    });
    // The victim falls apart along the first cut: each half keeps its side of a moving plane.
    if (hit >= 0 && this.halves.length === 2) {
      const k = hit, normal = new T.Vector3(dir * .55, 1, .25).normalize(), origin = new T.Vector3(to.x, 1.25, to.z), slide = easeOut(k / .5) * .55, fall = Math.max(0, k - .2);
      const offsets = [normal.clone().multiplyScalar(slide).add(new T.Vector3(dir * fall * .9, -fall * fall * 1.1, 0)), normal.clone().multiplyScalar(-slide * .4)];
      this.planes[0].setFromNormalAndCoplanarPoint(normal, origin.clone().add(offsets[0]));
      this.planes[1].setFromNormalAndCoplanarPoint(normal.clone().negate(), origin.clone().add(offsets[1]));
      const glow = Math.exp(-k * 3);
      this.halves.forEach((half, i) => {
        half.visible = k < 1.7; half.position.copy(this.halfOrigin).add(offsets[i]);
        for (const m of half.material as T.MeshStandardMaterial[]) { m.opacity = 1 - smooth((k - 1) / .6); if (m.emissive && !m.userData['glow']) m.emissive.setRGB(glow, glow * .08, glow * .15); }
      });
      this.burst.set(0, origin, k, { life: 1, speed: 9, gravity: -6, spread: 1, size: 12, a: '#ffd6de', b: '#ff2d55', opacity: .7 });
      this.streakBurst.set(origin, k, { life: .9, speed: 16, gravity: -6, spread: .95, width: .022, trail: .05, a: '#fff0f3', b: '#ff2d55' });
      this.wave(origin, k, .04);
      this.shockwave(new T.Vector3(to.x, 0, to.z), k, red, 11);
      this.light.position.set(to.x, 2, to.z + 1.2); this.light.color.copy(red); this.light.intensity = Math.exp(-k * 2.5) * 50;
    } else if (hit < 0) { this.light.position.set(0, 3.5, -2.5); this.light.color.copy(red); this.light.intensity = l.bloodMoon * 30; }
  }

  private wave(at: T.Vector3, k: number, strength: number): void {
    if (k >= 0 && k < 1) { this.look.ripple = at.clone(); this.look.rippleAge = k; this.look.rippleStrength = strength; }
  }

  private shockwave(at: T.Vector3, k: number, color: T.Color, size: number): void {
    this.shock.visible = k < .9; this.shock.position.set(at.x, .06, at.z); this.shock.scale.setScalar(1 + easeOut(k / .9) * size);
    const m = this.shock.material as T.ShaderMaterial; m.uniforms['uProgress'].value = .1 + k / .9 * .9; m.uniforms['uColor'].value.copy(color); m.uniforms['uOpacity'].value = 1.4 * (1 - smooth(k / .9));
  }
}
