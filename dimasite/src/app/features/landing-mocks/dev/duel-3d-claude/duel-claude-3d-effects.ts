import * as T from 'three';
import type { DuelCharacter, DuelTurn } from '../../../widgets/duel/duel-battle';
import { COMBO_HEAL, turnLength } from '../../../widgets/duel/duel-battle';
import { ClaudeAssets, Particles, additive, beamMaterial, hash, ringMaterial, shellMaterial, sprite } from './duel-claude-3d-assets';

const clamp = T.MathUtils.clamp, smooth = (x: number) => { const p = clamp(x, 0, 1); return p * p * (3 - 2 * p); };
const pulse = (x: number) => (x <= 0 || x >= 1) ? 0 : Math.sin(x * Math.PI);

/** Screen-level feedback the scene applies to the camera and the grade pass. */
export interface ScreenFx { shake: number; aberration: number; flash: number; flashColor: T.Color; exposure: number }

export interface CombatContext {
  turn: DuelTurn; time: number; attacker: DuelCharacter; defender: DuelCharacter;
  from: T.Vector3; to: T.Vector3; chest: T.Vector3; tipAt: (time: number) => T.Vector3;
  accent: T.Color; defenderAccent: T.Color; crit: boolean; lethal: boolean;
}

/** Ribbon smear following the blade between base and tip over the last few frames. */
export class Trail {
  readonly mesh: T.Mesh;
  private readonly position: T.BufferAttribute;
  readonly material: T.ShaderMaterial;
  constructor(readonly samples: number) {
    const geometry = new T.BufferGeometry(), positions = new Float32Array((samples + 1) * 2 * 3), uvs = new Float32Array((samples + 1) * 2 * 2), index: number[] = [];
    for (let i = 0; i <= samples; i++) { uvs.set([i / samples, 0, i / samples, 1], i * 4); if (i < samples) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
    this.position = new T.BufferAttribute(positions, 3); this.position.setUsage(T.DynamicDrawUsage);
    geometry.setAttribute('position', this.position); geometry.setAttribute('uv', new T.BufferAttribute(uvs, 2)); geometry.setIndex(index);
    this.material = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
      uniforms: { uColor: { value: new T.Color() }, uOpacity: { value: 1 } },
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `varying vec2 vUv;uniform vec3 uColor;uniform float uOpacity;void main(){float age=vUv.x;float a=pow(1.-age,2.4)*smoothstep(.3,.95,vUv.y)*.7;
        vec3 c=mix(vec3(1.),uColor,smoothstep(0.,.3,age))*(.55+(1.-age)*.65);gl_FragColor=vec4(c*a*uOpacity,1.);}`,
    });
    this.mesh = new T.Mesh(geometry, this.material); this.mesh.frustumCulled = false; this.mesh.visible = false;
  }
  set(points: { base: T.Vector3; tip: T.Vector3 }[], color: T.Color, opacity: number): void {
    for (let i = 0; i <= this.samples; i++) { const p = points[Math.min(i, points.length - 1)]; this.position.setXYZ(i * 2, p.base.x, p.base.y, p.base.z); this.position.setXYZ(i * 2 + 1, p.tip.x, p.tip.y, p.tip.z); }
    this.position.needsUpdate = true; this.material.uniforms['uColor'].value.copy(color); this.material.uniforms['uOpacity'].value = opacity; this.mesh.visible = true;
  }
}

/** An energy bolt: core, halo and a tapering tail of glows behind it. */
class Bolt {
  readonly group = new T.Group();
  private readonly core: T.Mesh;
  private readonly halo: T.Sprite;
  private readonly tail: T.Sprite[] = [];
  constructor(assets: ClaudeAssets) {
    this.core = new T.Mesh(new T.IcosahedronGeometry(.11, 2), new T.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
    this.halo = sprite(assets.radial, '#b49cff', 1.1);
    this.group.add(this.core, this.halo);
    for (let i = 0; i < 9; i++) { const s = sprite(assets.radial, '#b49cff', .7 - i * .06); this.tail.push(s); this.group.add(s); }
    this.group.visible = false;
  }
  place(path: (u: number) => T.Vector3, u: number, color: T.Color, size: number): void {
    this.group.visible = u >= 0 && u <= 1;
    if (!this.group.visible) return;
    const head = path(u); this.core.position.copy(head); this.core.scale.setScalar(size); this.halo.position.copy(head); this.halo.scale.setScalar(size * 1.4);
    this.halo.material.color.copy(color);
    for (let i = 0; i < this.tail.length; i++) {
      const s = this.tail[i], k = u - (i + 1) * .035; s.visible = k > 0; if (k > 0) { s.position.copy(path(k)); s.scale.setScalar(size * (.95 - i * .085)); s.material.color.copy(color); s.material.opacity = .9 - i * .09; }
    }
  }
}

export class CombatEffects {
  readonly root = new T.Group();
  readonly trail = new Trail(14);
  readonly particles: Particles[] = [];
  readonly fx: ScreenFx = { shake: 0, aberration: 0, flash: 0, flashColor: new T.Color('#fff'), exposure: 0 };
  private readonly sparks: Particles;
  private readonly embers: Particles;
  private readonly dust: Particles;
  private readonly motes: Particles;
  private readonly flare: T.Sprite;
  private readonly streaks: T.Sprite[];
  private readonly shock: T.Mesh;
  private readonly ground: T.Mesh;
  private readonly bolts: Bolt[];
  private readonly meteors: { rock: T.Mesh; fire: T.Mesh; glow: T.Sprite; blast: Particles }[] = [];
  private readonly pillar: T.Mesh;
  private readonly sigil: T.Mesh;
  private readonly column: T.Mesh;
  private readonly crescent: T.Mesh;
  private readonly ward: T.Mesh;
  private readonly aegis: T.Mesh;
  private readonly glyphs: T.Mesh[];
  private readonly feathers: T.InstancedMesh;
  private readonly light = new T.PointLight('#ffffff', 0, 9, 2);
  private readonly scratch = new T.Vector3();
  private readonly dummy = new T.Object3D();

  constructor(private readonly assets: ClaudeAssets) {
    const r = this.root;
    this.sparks = this.addParticles(160, 2); this.embers = this.addParticles(90, 3); this.dust = this.addParticles(70, 5); this.motes = this.addParticles(120, 7);
    this.flare = sprite(assets.radial, '#ffffff', 1); this.streaks = [sprite(assets.streak, '#ffffff', 1), sprite(assets.streak, '#ffffff', 1), sprite(assets.streak, '#ffffff', 1)];
    this.shock = new T.Mesh(new T.PlaneGeometry(1, 1), ringMaterial('#ffffff'));
    this.ground = new T.Mesh(new T.PlaneGeometry(1, 1), ringMaterial('#ffffff')); this.ground.rotation.x = -Math.PI / 2;
    this.bolts = [new Bolt(assets), new Bolt(assets), new Bolt(assets)];
    for (let i = 0; i < 4; i++) {
      const rock = new T.Mesh(new T.DodecahedronGeometry(.32, 1), new T.MeshStandardMaterial({ color: '#2b1a14', emissive: '#ff5a1e', emissiveIntensity: 2.2, roughness: .8, flatShading: true }));
      const fire = new T.Mesh(new T.ConeGeometry(.34, 2.6, 18, 1, true), beamMaterial('#ff7a2e')); fire.geometry.translate(0, 1.3, 0);
      const glow = sprite(assets.radial, '#ff8a3c', 2.2), blast = this.addParticles(70, 11 + i);
      rock.add(fire); this.meteors.push({ rock, fire, glow, blast }); r.add(rock, glow);
    }
    this.pillar = new T.Mesh(new T.CylinderGeometry(.75, .95, 12, 32, 1, true), beamMaterial('#ffe0a0')); this.pillar.geometry.translate(0, 6, 0);
    this.sigil = new T.Mesh(new T.PlaneGeometry(1, 1), additive('#ffd27a', assets.sigil)); this.sigil.rotation.x = -Math.PI / 2;
    this.column = new T.Mesh(new T.CylinderGeometry(.6, .85, 7, 32, 1, true), beamMaterial('#ffe7b0')); this.column.geometry.translate(0, 3.5, 0);
    this.crescent = new T.Mesh(new T.PlaneGeometry(1, 1), new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
      uniforms: { uColor: { value: new T.Color('#ff4d7a') }, uOpacity: { value: 1 } },
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `varying vec2 vUv;uniform vec3 uColor;uniform float uOpacity;void main(){vec2 p=(vUv-.5)*2.;float a=length(p)-.82;float b=length(p-vec2(-.3,0.))-.78;
        float m=smoothstep(.04,0.,a)*smoothstep(-.04,.02,b);float core=smoothstep(.02,0.,abs(a+.02))*smoothstep(-.04,.02,b);
        vec3 c=mix(uColor,vec3(1.),core);gl_FragColor=vec4(c*(m*.8+core*1.5)*uOpacity,1.);}`,
    }));
    this.ward = new T.Mesh(new T.SphereGeometry(1, 40, 24), shellMaterial('#b8a6ff'));
    this.aegis = new T.Mesh(new T.CircleGeometry(.75, 6), shellMaterial('#ffe0a0'));
    this.glyphs = [new T.Mesh(new T.PlaneGeometry(1, 1), additive('#9cffd0', assets.glyph)), new T.Mesh(new T.PlaneGeometry(1, 1), additive('#9cffd0', assets.glyph))];
    for (const g of this.glyphs) g.rotation.x = -Math.PI / 2;
    this.feathers = new T.InstancedMesh(new T.PlaneGeometry(.12, .48), additive('#fff1cf', assets.feather, .9), 14);
    this.feathers.frustumCulled = false;
    r.add(this.trail.mesh, this.flare, ...this.streaks, this.shock, this.ground, ...this.bolts.map(b => b.group), this.pillar, this.sigil, this.column, this.crescent, this.ward, this.aegis, ...this.glyphs, this.feathers, this.light);
    this.hide();
  }

  private addParticles(count: number, seed: number): Particles {
    const p = new Particles(count, this.assets.radial, seed); this.particles.push(p); this.root.add(p.points); return p;
  }

  hide(): void {
    for (const child of this.root.children) if (!(child instanceof T.Light)) child.visible = false;
    for (const p of this.particles) p.points.visible = false;
    for (const meteor of this.meteors) { meteor.rock.visible = meteor.glow.visible = false; }
    this.light.intensity = 0; this.fx.shake = this.fx.aberration = this.fx.flash = this.fx.exposure = 0;
  }

  /** Contact feedback: flash, crossing streaks, sparks, shock ring, dust and a light pop. */
  private impact(at: T.Vector3, age: number, color: T.Color, size: number, feet: T.Vector3): void {
    if (age < 0 || age > 1.2) return;
    const pop = age < .05 ? age / .05 : Math.exp(-(age - .05) * 9);
    this.flare.visible = pop > .01; this.flare.position.copy(at); this.flare.scale.setScalar(size * (.45 + pop * .85)); this.flare.material.color.copy(color).lerp(new T.Color('#fff'), .55); this.flare.material.opacity = pop;
    this.streaks.forEach((s, i) => {
      s.visible = pop > .01; s.position.copy(at); s.material.rotation = .35 + i * 1.05 + age * .4; s.material.color.copy(color).lerp(new T.Color('#fff'), .4);
      s.scale.set(size * (2.4 - i * .5) * (.4 + pop * .8), size * .22 * pop, 1); s.material.opacity = pop * .8;
    });
    this.sparks.set(0, at, age, { life: .55, speed: 9 * size, gravity: -7, spread: .85, size: 14 * size, a: '#ffffff', b: color });
    this.shock.visible = age < .45; this.shock.position.copy(at); this.shock.scale.setScalar(.6 + age * 7 * size);
    const ring = this.shock.material as T.ShaderMaterial; ring.uniforms['uProgress'].value = .2 + age / .45 * .8; ring.uniforms['uColor'].value.copy(color); ring.uniforms['uOpacity'].value = 1 - age / .45;
    this.dust.set(0, feet, age, { life: .9, speed: 3.2, gravity: .4, spread: .55, dir: { x: 0, y: .25, z: 0 }, size: 40, a: '#8f86b8', b: '#423a5c', opacity: .5 });
    this.light.position.copy(at).add(this.scratch.set(0, .3, .8)); this.light.color.copy(color); this.light.intensity = Math.max(this.light.intensity, pop * 14 * size);
    this.fx.shake = Math.max(this.fx.shake, pop * .14 * size); this.fx.aberration = Math.max(this.fx.aberration, pop * .006 * size);
  }

  update(ctx: CombatContext | null, world: number): void {
    this.hide();
    if (!ctx) return;
    const { turn, time, attacker, from, to, chest, accent } = ctx, age = (time - turn.at) / 1000, hit = (time - turn.hitAt) / 1000, windup = (turn.hitAt - turn.at) / 1000;
    const length = turnLength(turn) / 1000, dir = Math.sign(to.x - from.x) || 1, feet = this.scratch.clone().set(to.x, .05, to.z);
    const defended = !!turn.defended && turn.move !== 'special', broke = !!turn.defended && turn.move === 'special';
    const size = (turn.move === 'special' ? 1.45 : turn.move === 'heavy' ? 1.15 : .85) * (ctx.crit ? 1.3 : 1) * (ctx.lethal ? 1.25 : 1);
    const hitColor = ctx.crit ? new T.Color('#ffd27a') : accent.clone().lerp(new T.Color('#ffffff'), .25);

    if (turn.move === 'heal') { this.heal(ctx, age, hit, windup, world); return; }

    if (attacker === 'mage') {
      const tipLaunch = ctx.tipAt(turn.at + (turn.hitAt - turn.at) * .78);
      const path = (k: number, lift = .5, sway = 0) => { const p = new T.Vector3().lerpVectors(tipLaunch, chest, k); p.y += Math.sin(k * Math.PI) * lift; p.z += Math.sin(k * Math.PI) * sway; return p; };
      const travel = (age - windup * .78) / (windup * .22);
      if (turn.move === 'normal') this.bolts[0].place(k => path(k, .35), travel < 0 || travel > 1.02 ? -1 : Math.min(1, travel) ** 2, accent, .9);
      else if (turn.move === 'heavy') {
        for (let i = 0; i < 3; i++) {
          const orbit = (age - windup * .15) / (windup * .63), local = travel * 1.15 - i * .08;
          if (orbit <= 0 || local > 1.02) this.bolts[i].place(() => to, -1, accent, 1);
          else if (local < 0) {
            const tip = ctx.tipAt(time), a = world * 6 + i * 2.094; this.bolts[i].place(() => new T.Vector3(tip.x + Math.cos(a) * .32, tip.y + Math.sin(a) * .32, tip.z + .15), .5, accent, .55 * smooth(orbit * 2));
          } else this.bolts[i].place(k => path(k, .4 + i * .25, (i - 1) * .5), Math.min(1, local) ** 1.6, accent, .75);
        }
      } else {
        // Meteor Storm: four burning rocks rain in a staggered volley.
        for (let i = 0; i < 4; i++) {
          const m = this.meteors[i], land = windup - .16 + i * .07 - (i === 2 ? .1 : 0), start = land - .55, k = (age - start) / (land - start);
          const target = new T.Vector3(to.x + (i - 1.5) * .7 * (i === 2 ? 0 : 1), 0, to.z + (i % 2 ? .6 : -.5));
          const sky = new T.Vector3(target.x - dir * 3.5, 9, target.z - 1.5);
          if (k > 0 && k < 1) {
            const e = k * k; m.rock.visible = m.glow.visible = true; m.rock.position.lerpVectors(sky, target, e); m.glow.position.copy(m.rock.position);
            m.rock.lookAt(sky); m.rock.rotateX(Math.PI / 2); m.rock.scale.setScalar(.8 + i * .12);
            (m.fire.material as T.ShaderMaterial).uniforms['uTime'].value = world; (m.fire.material as T.ShaderMaterial).uniforms['uOpacity'].value = .9;
          }
          const blast = age - land;
          if (blast > 0 && blast < 1.1) {
            m.blast.set(0, target, blast, { life: .8, speed: 7, gravity: -5, spread: .7, size: 26, a: '#ffd59a', b: '#ff4d1f' });
            if (i === 0 || i === 3) this.impact(new T.Vector3(target.x, .6, target.z), blast, new T.Color('#ff8a3c'), 1.1, target);
          }
        }
        this.embers.set(0, new T.Vector3(to.x, .1, to.z), Math.max(0, hit), { life: 1.4, speed: 4, gravity: 1.5, spread: 1, size: 12, a: '#ffb36b', b: '#ff4d1f' });
        this.fx.exposure = -.15 * pulse((age - .1) / (windup + .4));
      }
    } else {
      // Melee: smear, lunge dust, and class specials.
      if (turn.move === 'special' && attacker === 'knight') {
        const glow = smooth((age - windup * .4) / (windup * .5)) * (1 - smooth((hit - .4) / .5));
        this.sigil.visible = glow > 0; this.sigil.position.set(to.x, .03, to.z); this.sigil.scale.setScalar(2.6 + glow * .4); this.sigil.rotation.z = world * .8;
        (this.sigil.material as T.MeshBasicMaterial).opacity = glow;
        const beam = hit > -.12 ? pulse((hit + .12) / .85) : 0;
        this.pillar.visible = beam > 0; this.pillar.position.set(to.x, 0, to.z); this.pillar.scale.set(.35 + beam * .45, 1, .35 + beam * .45);
        (this.pillar.material as T.ShaderMaterial).uniforms['uOpacity'].value = beam * .55; (this.pillar.material as T.ShaderMaterial).uniforms['uTime'].value = world;
        this.ground.visible = hit > 0 && hit < .7; this.ground.position.set(to.x, .04, to.z); this.ground.scale.setScalar(1 + hit * 9);
        const g = this.ground.material as T.ShaderMaterial; g.uniforms['uProgress'].value = .15 + hit / .7 * .85; g.uniforms['uColor'].value.set('#ffd27a'); g.uniforms['uOpacity'].value = 1 - hit / .7;
        this.fx.exposure = -.2 * pulse((age - windup * .3) / (windup * .9));
      }
      if (turn.move === 'special' && attacker === 'ronin') {
        const sweep = (age - windup * .9) / (windup * .25);
        if (sweep > 0 && sweep < 2.2) {
          this.crescent.visible = true; const k = clamp(sweep, 0, 1.6);
          this.crescent.position.set(from.x + dir * (1 + k * 3.6), 1.35, from.z + .3); this.crescent.scale.set(dir * 2.6, 2.6, 1); this.crescent.rotation.set(0, 0, dir * -.2);
          (this.crescent.material as T.ShaderMaterial).uniforms['uOpacity'].value = 1 - smooth((sweep - 1) / 1.2);
        }
      }
      const step = (age - windup * .7) / .3;
      if (step > 0 && step < 1.2) this.dust.set(0, new T.Vector3(from.x + dir * .4, .05, from.z), step * .3, { life: .7, speed: 2.4, gravity: .3, spread: .6, dir: { x: -dir, y: .3, z: 0 }, size: 34, a: '#7d74a3', b: '#3c3556', opacity: .45 });
    }

    // Contact.
    if (defended) {
      const k = hit;
      if (ctx.defender === 'knight') {
        const a = pulse((k + .06) / .5); this.aegis.visible = a > 0; this.aegis.position.set(to.x - dir * .55, 1.45, to.z + .35); this.aegis.lookAt(from.x, 1.45, from.z + 4);
        this.aegis.scale.setScalar(.8 + a * .5); (this.aegis.material as T.ShaderMaterial).uniforms['uOpacity'].value = a * 1.6;
        this.sparks.set(0, new T.Vector3(to.x - dir * .55, 1.45, to.z + .3), k, { life: .45, speed: 7, gravity: -9, spread: .7, dir: { x: -dir, y: .5, z: 0 }, size: 10, a: '#fff6d8', b: '#ffc06b' });
        this.fx.shake = Math.max(this.fx.shake, pulse(k / .25) * .05);
      } else if (ctx.defender === 'mage') {
        const a = pulse((k + .1) / .65); this.ward.visible = a > 0; this.ward.position.set(to.x, 1.35, to.z); this.ward.scale.setScalar(1.05 + a * .15);
        const s = this.ward.material as T.ShaderMaterial; s.uniforms['uOpacity'].value = a * .55; s.uniforms['uTime'].value = world; s.uniforms['uColor'].value.copy(ctx.defenderAccent);
      } else {
        const a = pulse((k + .05) / .35); this.streaks[0].visible = a > 0; this.streaks[0].position.set(to.x - dir * .3, 1.5, to.z + .4); this.streaks[0].scale.set(2.4 * a, .12, 1);
        this.streaks[0].material.color.set('#ffffff'); this.streaks[0].material.opacity = a; this.streaks[0].material.rotation = -.25 * dir;
      }
    } else if (turn.damage > 0 || broke) {
      if (broke) {
        const a = pulse((hit + .2) / .5); this.ward.visible = a > 0; this.ward.position.set(to.x, 1.35, to.z); this.ward.scale.setScalar(1.1 + Math.max(0, hit) * 2);
        const s = this.ward.material as T.ShaderMaterial; s.uniforms['uOpacity'].value = a * .5; s.uniforms['uCrack'].value = clamp(hit * 6 + .3, 0, 1); s.uniforms['uColor'].value.copy(ctx.defenderAccent);
        this.embers.set(0, new T.Vector3(to.x, 1.4, to.z), Math.max(0, hit), { life: .9, speed: 8, gravity: -8, spread: 1, size: 16, a: '#ffffff', b: ctx.defenderAccent });
      }
      this.impact(chest, hit, hitColor, size, feet);
    }

    // Combo heal on the blocker.
    if (turn.comboHeal) {
      const k = hit - COMBO_HEAL.delay / 1000;
      if (k > 0 && k < 1.2) this.motes.set(2, new T.Vector3(to.x, .2, to.z), k, { life: 1, speed: 2.2, radius: .7, size: 16, a: '#b8ffe0', b: '#3dffa8' });
    }
    if (length - age < 0) this.hide();
  }

  private heal(ctx: CombatContext, age: number, hit: number, windup: number, world: number): void {
    const at = ctx.from, character = ctx.attacker, show = smooth((age - .2) / .4) * (1 - smooth((age - 1.25) / .25));
    const color = new T.Color(character === 'knight' ? '#ffe3a6' : '#8dffcf');
    if (character === 'knight') {
      this.column.visible = show > 0; this.column.position.set(at.x, 0, at.z); this.column.scale.set(.45 + show * .3, 1, .45 + show * .3);
      const c = this.column.material as T.ShaderMaterial; c.uniforms['uOpacity'].value = show * (.28 + pulse(hit / .5) * .35); c.uniforms['uTime'].value = world;
      this.sigil.visible = show > 0; this.sigil.position.set(at.x, .03, at.z); this.sigil.scale.setScalar(2.4); this.sigil.rotation.z = -world * .5; (this.sigil.material as T.MeshBasicMaterial).opacity = show;
      this.feathers.visible = show > 0; (this.feathers.material as T.MeshBasicMaterial).opacity = show;
      for (let i = 0; i < 14; i++) {
        const k = (age * .45 + hash(i)) % 1, a = hash(i * 3) * Math.PI * 2, r = .3 + hash(i * 7) * .9;
        this.dummy.position.set(at.x + Math.cos(a) * r + Math.sin(age * 2 + i) * .15, 3.4 - k * 3.3, at.z + Math.sin(a) * r);
        this.dummy.rotation.set(Math.sin(age * 3 + i) * .6, a + age, Math.sin(age * 2.2 + i * 2) * .9); this.dummy.updateMatrix(); this.feathers.setMatrixAt(i, this.dummy.matrix);
      }
      this.feathers.instanceMatrix.needsUpdate = true;
    } else {
      for (let i = 0; i < 2; i++) {
        const g = this.glyphs[i], s = character === 'mage' ? show : show * (i === 0 ? 1 : 0);
        g.visible = s > 0; g.position.set(at.x, .04 + i * (character === 'mage' ? 2.6 : 0), at.z); g.scale.setScalar((1.9 + i * .3) * (.6 + s * .4)); g.rotation.z = (i ? -1 : 1) * world * .9;
        (g.material as T.MeshBasicMaterial).opacity = s; (g.material as T.MeshBasicMaterial).color.copy(character === 'mage' ? ctx.accent.clone().lerp(color, .5) : color);
      }
    }
    this.motes.set(2, new T.Vector3(at.x, .1, at.z), age - .2, { life: 1.2, speed: 2.4, radius: .8, size: 18, a: '#ffffff', b: color });
    if (hit > 0 && hit < .6) {
      this.ground.visible = true; this.ground.position.set(at.x, .05, at.z); this.ground.scale.setScalar(1 + hit * 6);
      const g = this.ground.material as T.ShaderMaterial; g.uniforms['uProgress'].value = .2 + hit / .6 * .8; g.uniforms['uColor'].value.copy(color); g.uniforms['uOpacity'].value = 1 - hit / .6;
      this.light.position.set(at.x, 1.5, at.z + .8); this.light.color.copy(color); this.light.intensity = (1 - hit / .6) * 12;
    }
  }
}
