import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { DuelCharacter, DuelSide } from '../../../widgets/duel/duel-battle';
import type { ClaudeAssets } from './duel-claude-3d-assets';

/**
 * Sculpted procedural fighters for the Claude 3D entry. Each fighter is a real skeleton
 * (hips → spine → chest → neck → head, two-bone arms and IK legs) wearing lathe, extrude
 * and tube geometry, with simulated cloth driven by the pose. Models face +Z; the right
 * fighter's stage is mirrored so both weapons stay on the camera side.
 */
export const ARM_JOINTS = ['hp', 'sp', 'ch', 'nk', 'hd', 'sR', 'eR', 'wR', 'sL', 'eL', 'wL'] as const;
export type ArmJoint = typeof ARM_JOINTS[number];
export const HIP_HEIGHT = 1.02, THIGH = .46, SHIN = .44, ANKLE = .08;

export interface ClaudeRig {
  character: DuelCharacter; side: DuelSide;
  anchor: T.Group; root: T.Group; j: Record<ArmJoint, T.Group>;
  legs: { R: [T.Group, T.Group, T.Group]; L: [T.Group, T.Group, T.Group] };
  weapon: T.Group; bladeBase: T.Object3D; bladeTip: T.Object3D; focus: T.Object3D; tip: T.Object3D;
  sheathed: T.Object3D | null; gourdHand: T.Object3D | null; gourdBelt: T.Object3D | null;
  cloths: Cloth[]; skirt: Skirt | null; orbs: T.Object3D[]; aura: T.Mesh;
  materials: T.MeshStandardMaterial[]; glow: T.MeshStandardMaterial[]; accent: T.Color;
}

/** A hanging cloth strip integrated as a chain from its attachment edge. */
export class Cloth {
  readonly mesh: T.Mesh;
  private readonly position: T.BufferAttribute;
  constructor(material: T.Material, readonly width: number, readonly length: number, private readonly cols: number, private readonly rows: number,
    private readonly options: { rest?: number; taper?: number; facing?: number; flutter?: number; stiff?: number; seed?: number } = {}) {
    const geometry = new T.PlaneGeometry(width, length, cols, rows);
    this.position = geometry.attributes['position'] as T.BufferAttribute;
    this.mesh = new T.Mesh(geometry, material); this.mesh.castShadow = true; this.mesh.frustumCulled = false; this.mesh.userData['dynamic'] = true;
    this.update(0, new T.Vector3(), 0);
  }
  /** drag is the attachment velocity in the cloth's parent frame; wind lifts the whole strip. */
  update(t: number, drag: T.Vector3, wind: number): void {
    const { rest = .12, taper = 0, facing = 1, flutter = 1, stiff = 1, seed = 0 } = this.options, seg = this.length / this.rows;
    const lift = T.MathUtils.clamp(drag.z * .32 * facing + wind, -.5, 1.45), side = T.MathUtils.clamp(-drag.x * .25, -.7, .7);
    for (let c = 0; c <= this.cols; c++) {
      const u = c / this.cols - .5; let x = u * this.width, y = 0, z = 0;
      for (let r = 0; r <= this.rows; r++) {
        const v = r / this.rows, i = r * (this.cols + 1) + c;
        if (r > 0) {
          const wave = Math.sin(t * (2.3 + wind * 3) - v * 5.5 + u * 2.4 + seed) * (.05 + wind * .16 + Math.abs(lift) * .05) * flutter;
          const theta = (rest + lift * Math.pow(v, .7 * stiff) + wave * v) * facing, phi = side * v + Math.sin(t * 1.7 - v * 3.8 + u * 3 + seed) * .06 * v * flutter;
          x += Math.sin(phi) * seg - u * this.width * taper / this.rows; y -= Math.cos(theta) * Math.cos(phi) * seg; z -= Math.sin(theta) * seg;
        }
        this.position.setXYZ(i, x, y, z);
      }
    }
    this.position.needsUpdate = true; this.mesh.geometry.computeVertexNormals();
  }
}

/** A lathe skirt (mage robe, ronin hakama hem) pushed by the legs and billowed by motion. */
export class Skirt {
  readonly mesh: T.Mesh;
  private readonly base: Float32Array;
  constructor(geometry: T.BufferGeometry, material: T.Material, private readonly top: number, private readonly bottom: number) {
    this.base = (geometry.attributes['position'].array as Float32Array).slice();
    this.mesh = new T.Mesh(geometry, material); this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.frustumCulled = false; this.mesh.userData['dynamic'] = true;
  }
  update(t: number, legR: number, legL: number, drag: T.Vector3, wind: number): void {
    const position = this.mesh.geometry.attributes['position'] as T.BufferAttribute, base = this.base;
    for (let i = 0; i < position.count; i++) {
      const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2], h = T.MathUtils.clamp((this.top - y) / (this.top - this.bottom), 0, 1);
      const a = Math.atan2(x, z), r = Math.hypot(x, z);
      const wR = Math.max(0, Math.cos(a + .55)), wL = Math.max(0, Math.cos(a - .55));
      const push = (Math.max(0, -legR) * wR + Math.max(0, -legL) * wL) * .55 * Math.pow(h, 1.2);
      const billow = 1 + h * h * (wind * .14 + Math.sin(t * 2.2 + a * 3) * .025 * (1 + wind * 2)) + h * .045 * Math.cos(a * 11 + Math.sin(t * .8) * .6);
      const nr = r * billow;
      position.setXYZ(i, Math.sin(a) * nr, y + h * h * wind * .06, Math.cos(a) * nr + push - h * h * T.MathUtils.clamp(drag.z, -3, 3) * .07);
    }
    position.needsUpdate = true; this.mesh.geometry.computeVertexNormals();
  }
}

type V3 = [number, number, number];
const v2 = (pairs: [number, number][]) => pairs.map(([r, y]) => new T.Vector2(r, y));

function add(parent: T.Object3D, geometry: T.BufferGeometry, material: T.Material, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: V3 = [1, 1, 1]): T.Mesh {
  const mesh = new T.Mesh(geometry, material); mesh.position.set(...p); mesh.rotation.set(...r); mesh.scale.set(...s);
  mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
}
const lathe = (points: [number, number][], segments = 28) => new T.LatheGeometry(v2(points), segments);
const sphere = (r: number, w = 24, h = 16, phiLength = Math.PI * 2, thetaLength = Math.PI) => new T.SphereGeometry(r, w, h, 0, phiLength, 0, thetaLength);
const rbox = (w: number, h: number, d: number, r = .02) => new RoundedBoxGeometry(w, h, d, 2, r);

/** Tube with a radius that varies along the curve (plumes, hat tips, staves, quillons). */
export function taperTube(points: T.Vector3[], radius: (u: number) => number, tubular = 24, radial = 10): T.BufferGeometry {
  const curve = new T.CatmullRomCurve3(points), frames = curve.computeFrenetFrames(tubular, false);
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], index: number[] = [];
  const point = new T.Vector3(), normal = new T.Vector3();
  for (let i = 0; i <= tubular; i++) {
    const u = i / tubular; curve.getPointAt(u, point); const r = radius(u), N = frames.normals[i], B = frames.binormals[i];
    for (let j = 0; j <= radial; j++) {
      const v = j / radial * Math.PI * 2, s = Math.sin(v), c = -Math.cos(v);
      normal.set(c * N.x + s * B.x, c * N.y + s * B.y, c * N.z + s * B.z).normalize();
      positions.push(point.x + r * normal.x, point.y + r * normal.y, point.z + r * normal.z); normals.push(normal.x, normal.y, normal.z); uvs.push(u, j / radial);
    }
  }
  for (let i = 0; i < tubular; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = (i + 1) * (radial + 1) + j;
    index.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3)); geometry.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2)); geometry.setIndex(index);
  return geometry;
}

/** Straight double-edged blade: length along +Z, edges along ±Y, flat faces along ±X. */
export function bladeGeometry(length: number, width: number, tip: number, thickness = .016): T.BufferGeometry {
  const shape = new T.Shape();
  shape.moveTo(-width / 2, 0); shape.lineTo(-width * .42, length - tip); shape.quadraticCurveTo(-width * .3, length - tip * .4, 0, length);
  shape.quadraticCurveTo(width * .3, length - tip * .4, width * .42, length - tip); shape.lineTo(width / 2, 0); shape.closePath();
  const geometry = new T.ExtrudeGeometry(shape, { depth: .002, bevelEnabled: true, bevelThickness: thickness, bevelSize: Math.min(width * .3, thickness * .9), bevelSegments: 1, curveSegments: 6 });
  geometry.translate(0, 0, -.001); geometry.rotateZ(Math.PI / 2); geometry.rotateY(Math.PI / 2); geometry.computeVertexNormals();
  return geometry;
}

/** Katana: gently curved single-edged blade with a kissaki. */
function katanaGeometry(length: number, width: number, sori: number): T.BufferGeometry {
  const shape = new T.Shape(), n = 18, edge: [number, number][] = [], spine: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const y = length * i / n, k = y / length, c = sori * k * k, w = width * (1 - .22 * k);
    edge.push([c - w * .5, y]); spine.push([c + w * .5, y]);
  }
  const end = sori + width * .39;
  shape.moveTo(...edge[0]); for (const p of edge.slice(1, -1)) shape.lineTo(...p);
  shape.quadraticCurveTo(sori - width * .3, length + width * .4, end, length + width * .55);
  for (const p of spine.slice(0, -1).reverse()) shape.lineTo(...p);
  shape.closePath();
  const geometry = new T.ExtrudeGeometry(shape, { depth: .002, bevelEnabled: true, bevelThickness: .011, bevelSize: .008, bevelSegments: 1, curveSegments: 8 });
  geometry.translate(0, 0, -.001); geometry.rotateZ(Math.PI / 2); geometry.rotateY(Math.PI / 2); geometry.computeVertexNormals();
  return geometry;
}

function extrude(shape: T.Shape, depth: number, bevel: number): T.BufferGeometry {
  const geometry = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 12 });
  geometry.translate(0, 0, -depth / 2); return geometry;
}

interface Mats {
  steel: T.MeshPhysicalMaterial; dark: T.MeshPhysicalMaterial; gold: T.MeshPhysicalMaterial; leather: T.MeshStandardMaterial;
  cloth: T.MeshPhysicalMaterial; clothDark: T.MeshPhysicalMaterial; trim: T.MeshPhysicalMaterial; skin: T.MeshStandardMaterial; wood: T.MeshStandardMaterial;
  glow: T.MeshStandardMaterial; eye: T.MeshStandardMaterial; lacquer: T.MeshPhysicalMaterial; straw: T.MeshStandardMaterial; crystal: T.MeshPhysicalMaterial;
}

function materials(side: DuelSide, enraged: boolean, assets: ClaudeAssets): Mats {
  const tint = enraged ? '#ff3a55' : side === 'left' ? '#b49cff' : '#ffc06b';
  const cloth = enraged ? '#6b1424' : side === 'left' ? '#3b2a7a' : '#8a4220', clothDark = enraged ? '#2d0710' : side === 'left' ? '#1b1638' : '#3b1b10';
  const bump = assets.noise;
  return {
    steel: new T.MeshPhysicalMaterial({ color: '#a7b0c4', metalness: 1, roughness: .34, bumpMap: bump, bumpScale: .6, clearcoat: .25, clearcoatRoughness: .3, envMapIntensity: .55 }),
    dark: new T.MeshPhysicalMaterial({ color: '#262c3d', metalness: .85, roughness: .38, bumpMap: bump, bumpScale: .8, clearcoat: .2 }),
    gold: new T.MeshPhysicalMaterial({ color: '#d9ad62', metalness: 1, roughness: .28, clearcoat: .4, clearcoatRoughness: .2, envMapIntensity: .7 }),
    leather: new T.MeshStandardMaterial({ color: '#3a2620', roughness: .75, bumpMap: bump, bumpScale: 1.5 }),
    cloth: new T.MeshPhysicalMaterial({ color: cloth, roughness: .82, sheen: 1, sheenColor: new T.Color(tint).multiplyScalar(.55), sheenRoughness: .45, side: T.DoubleSide, bumpMap: bump, bumpScale: .5 }),
    clothDark: new T.MeshPhysicalMaterial({ color: clothDark, roughness: .9, sheen: .6, sheenColor: new T.Color(tint).multiplyScalar(.3), side: T.DoubleSide }),
    trim: new T.MeshPhysicalMaterial({ color: '#d9ad5f', metalness: .6, roughness: .45, sheen: .5, side: T.DoubleSide }),
    skin: new T.MeshStandardMaterial({ color: '#d7a98a', roughness: .62 }),
    wood: new T.MeshStandardMaterial({ color: '#4a3020', roughness: .7, bumpMap: assets.straw, bumpScale: 2 }),
    glow: new T.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 3.2, roughness: .3 }),
    eye: new T.MeshStandardMaterial({ color: '#ffffff', emissive: tint, emissiveIntensity: 6 }),
    lacquer: new T.MeshPhysicalMaterial({ color: '#120d14', metalness: .1, roughness: .2, clearcoat: 1, clearcoatRoughness: .05 }),
    straw: new T.MeshStandardMaterial({ color: '#b89257', roughness: .88, map: assets.straw, bumpMap: assets.straw, bumpScale: 2.5, side: T.DoubleSide }),
    crystal: new T.MeshPhysicalMaterial({ color: tint, emissive: tint, emissiveIntensity: 2.2, metalness: 0, roughness: .05, clearcoat: 1, iridescence: 1, iridescenceIOR: 1.6 }),
  };
}

export function buildRig(character: DuelCharacter, side: DuelSide, enraged: boolean, assets: ClaudeAssets): ClaudeRig {
  const m = materials(side, enraged, assets);
  const anchor = new T.Group(), root = new T.Group(); anchor.add(root);
  const group = () => new T.Group();
  const j = Object.fromEntries(ARM_JOINTS.map(name => [name, group()])) as Record<ArmJoint, T.Group>;
  root.add(j.hp); j.hp.position.y = HIP_HEIGHT;
  j.hp.add(j.sp); j.sp.position.y = .08; j.sp.add(j.ch); j.ch.position.y = .3; j.ch.add(j.nk); j.nk.position.y = .36; j.nk.add(j.hd); j.hd.position.y = .1;
  const shoulder = character === 'knight' ? .33 : character === 'ronin' ? .29 : .27;
  j.ch.add(j.sR, j.sL); j.sR.position.set(-shoulder, .27, 0); j.sL.position.set(shoulder, .27, 0);
  j.sR.add(j.eR); j.sL.add(j.eL); j.eR.position.y = j.eL.position.y = -.34; j.eR.add(j.wR); j.eL.add(j.wL); j.wR.position.y = j.wL.position.y = -.3;
  const leg = (x: number): [T.Group, T.Group, T.Group] => {
    const thigh = group(), knee = group(), ankle = group(); thigh.rotation.order = 'ZYX';
    j.hp.add(thigh); thigh.position.set(x, -.04, 0); thigh.add(knee); knee.position.y = -THIGH; knee.add(ankle); ankle.position.y = -SHIN;
    return [thigh, knee, ankle];
  };
  const legs = { R: leg(-.13), L: leg(.13) };
  const weapon = group(), bladeBase = new T.Object3D(), bladeTip = new T.Object3D(), focus = new T.Object3D(), tip = new T.Object3D();
  j.wR.add(weapon); weapon.position.set(0, -.07, .02); weapon.add(bladeBase, bladeTip); j.ch.add(focus); focus.position.set(0, .15, .1);
  const rig: ClaudeRig = { character, side, anchor, root, j, legs, weapon, bladeBase, bladeTip, focus, tip, sheathed: null, gourdHand: null, gourdBelt: null,
    cloths: [], skirt: null, orbs: [], aura: new T.Mesh(), materials: [], glow: [m.glow, m.eye, m.crystal], accent: new T.Color(m.glow.color) };

  // Shared limbs: hands, plus per-class shells added below.
  for (const [wrist, elbow, shoulderJ] of [[j.wR, j.eR, j.sR], [j.wL, j.eL, j.sL]] as const) {
    add(wrist, rbox(.09, .11, .1, .03), character === 'knight' ? m.steel : character === 'mage' ? m.skin : m.leather, [0, -.04, .01]);
    add(elbow, sphere(.06, 16, 12), character === 'knight' ? m.gold : m.dark, [0, 0, 0]);
    void shoulderJ;
  }
  if (character === 'knight') knight(rig, m, assets); else if (character === 'mage') mage(rig, m); else ronin(rig, m);

  // Enraged aura: a column of crimson heat around the streamer's fighter.
  rig.aura = new T.Mesh(new T.CylinderGeometry(.62, .8, 2.5, 32, 1, true), new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color('#ff2848') } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv;uniform float uTime;uniform vec3 uColor;float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
      void main(){float f=n(vec2(vUv.x*14.,vUv.y*3.-uTime*2.5))*n(vec2(vUv.x*7.+3.,vUv.y*5.-uTime*1.7));float a=f*smoothstep(1.,.05,vUv.y)*smoothstep(0.,.1,vUv.y);gl_FragColor=vec4(uColor*a*1.4,1.);}`,
  }));
  rig.aura.position.y = 1.15; rig.aura.visible = enraged; rig.aura.castShadow = false; root.add(rig.aura);

  for (const part of [j.hp, j.sp, j.ch, j.nk, j.hd, j.sR, j.eR, j.wR, j.sL, j.eL, j.wL, weapon, ...legs.R, ...legs.L]) batch(part);
  const seen = new Set<T.Material>();
  root.traverse(object => { if (object instanceof T.Mesh && object.material instanceof T.MeshStandardMaterial && !seen.has(object.material)) { seen.add(object.material); rig.materials.push(object.material); } });
  return rig;
}

function boot(rig: ClaudeRig, m: Mats, armored: boolean): void {
  for (const [thigh, knee, ankle] of [rig.legs.R, rig.legs.L]) {
    add(ankle, rbox(.15, .1, .3, .045), armored ? m.steel : m.leather, [0, -.03, .06]);
    if (armored) { add(ankle, sphere(.08, 16, 10, Math.PI * 2, Math.PI / 2), m.steel, [0, -.02, .18], [Math.PI / 2, 0, 0], [1, 1.4, .6]); add(knee, sphere(.085, 18, 12), m.steel, [0, 0, .03]); add(knee, new T.ConeGeometry(.04, .1, 8), m.gold, [0, 0, .12], [Math.PI / 2, 0, 0]); }
    void thigh;
  }
}

function knight(rig: ClaudeRig, m: Mats, assets: ClaudeAssets): void {
  const { j, legs } = rig;
  // Fauld and belt.
  add(j.hp, lathe([[.2, .1], [.24, .02], [.27, -.08], [.3, -.2], [.29, -.22]]), m.steel, [0, 0, 0], [0, 0, 0], [1, 1, .8]);
  add(j.hp, new T.TorusGeometry(.235, .025, 8, 32), m.leather, [0, .07, 0], [Math.PI / 2, 0, 0], [1, .8, 1]);
  add(j.hp, rbox(.12, .09, .04, .015), m.gold, [0, .07, .2]);
  for (let i = 0; i < 3; i++) add(j.hp, lathe([[.25 + i * .02, 0], [.285 + i * .02, -.06]], 28), m.steel, [0, -.02 - i * .065, 0], [0, 0, 0], [1, 1, .8]);
  // Abdomen mail and breastplate.
  add(j.sp, lathe([[.16, -.06], [.2, .05], [.21, .2], [.2, .32]]), m.dark, [0, 0, 0], [0, 0, 0], [1, 1, .82]);
  add(j.ch, lathe([[.18, -.04], [.25, .05], [.31, .18], [.32, .28], [.27, .37], [.15, .43], [.1, .45]], 36), m.steel, [0, 0, 0], [0, 0, 0], [1, 1, .74]);
  add(j.ch, rbox(.025, .4, .03, .01), m.steel, [0, .2, .24], [-.08, 0, 0]);
  add(j.ch, new T.TorusGeometry(.2, .018, 8, 36), m.gold, [0, -.02, 0], [Math.PI / 2, 0, 0], [1.05, .78, 1]);
  add(j.ch, lathe([[.11, 0], [.15, .04], [.14, .1]], 24), m.gold, [0, .4, 0]);
  const sun = new T.Shape(); for (let i = 0; i <= 16; i++) { const a = i / 16 * Math.PI * 2, r = i % 2 ? .035 : .075; sun.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  add(j.ch, extrude(sun, .01, .006), m.glow, [0, .24, .232], [-.15, 0, 0]);
  add(j.ch, new T.TorusGeometry(.085, .008, 6, 32), m.gold, [0, .24, .228], [-.15, 0, 0]);
  // Pauldrons: three lames with gilded edges.
  for (const [shoulder, dir] of [[j.sR, -1], [j.sL, 1]] as const) {
    for (let i = 0; i < 3; i++) {
      add(shoulder, sphere(.17 - i * .015, 24, 12, Math.PI * 2, Math.PI / 2), m.steel, [dir * (.02 + i * .012), .05 - i * .07, 0], [0, 0, dir * -(.5 + i * .18)], [1, .75, 1.05]);
      add(shoulder, new T.TorusGeometry(.165 - i * .015, .01, 6, 30), m.gold, [dir * (.02 + i * .012), .05 - i * .07, 0], [Math.PI / 2, dir * -(.5 + i * .18), 0], [1, 1.05, 1]);
    }
    add(shoulder, new T.CapsuleGeometry(.07, .16, 6, 14), m.dark, [0, -.18, 0]);
    add(shoulder, lathe([[.08, -.04], [.09, .08], [.075, .12]]), m.steel, [0, -.26, 0]);
  }
  for (const elbow of [j.eR, j.eL]) {
    add(elbow, lathe([[.07, -.02], [.075, -.12], [.085, -.24], [.065, -.27]]), m.steel);
    add(elbow, new T.TorusGeometry(.083, .009, 6, 24), m.gold, [0, -.23, 0], [Math.PI / 2, 0, 0]);
  }
  // Great helm: rounded crown, visor slit, crest plume.
  add(j.hd, lathe([[.0, -.14], [.15, -.14], [.17, -.04], [.175, .08], [.16, .18], [.11, .25], [.0, .27]], 36), m.steel, [0, .1, 0], [0, 0, 0], [1, 1, 1.05]);
  add(j.hd, rbox(.24, .028, .04, .01), m.eye, [0, .12, .165]);
  add(j.hd, rbox(.022, .1, .04, .008), m.eye, [0, .06, .17]);
  add(j.hd, rbox(.03, .3, .03, .01), m.gold, [0, .2, .17], [-.25, 0, 0]);
  add(j.hd, new T.TorusGeometry(.17, .012, 8, 32), m.gold, [0, -.02, .02], [Math.PI / 2, 0, 0]);
  const plume = taperTube([new T.Vector3(0, .36, .1), new T.Vector3(0, .46, -.04), new T.Vector3(0, .42, -.22), new T.Vector3(0, .24, -.36), new T.Vector3(0, .02, -.4)], u => .075 * Math.sin(Math.PI * Math.min(1, u * 1.15 + .08)) + .006, 28, 10);
  add(j.hd, plume, m.cloth, [0, 0, 0], [0, 0, 0], [.7, 1, 1]);
  add(j.nk, lathe([[.09, -.06], [.1, .06]], 20), m.dark);
  // Legs: cuisses, greaves and sabatons.
  for (const [thigh, knee] of [legs.R, legs.L]) {
    add(thigh, lathe([[.1, -.02], [.125, -.12], [.11, -.34], [.09, -.42]]), m.steel, [0, 0, 0], [0, 0, 0], [1, 1, .9]);
    add(knee, lathe([[.075, -.04], [.09, -.14], [.085, -.3], [.07, -.4]]), m.steel, [0, 0, 0], [0, 0, 0], [1, 1, .95]);
  }
  boot(rig, m, true);
  // Longsword: beveled steel, luminous fuller, curved quillons, wrapped grip.
  const w = rig.weapon;
  add(w, bladeGeometry(1.12, .09, .16), m.steel, [0, 0, .12]);
  add(w, rbox(.006, .012, .82, .003), m.glow, [.017, 0, .5]); add(w, rbox(.006, .012, .82, .003), m.glow, [-.017, 0, .5]);
  add(w, taperTube([new T.Vector3(0, -.2, .02), new T.Vector3(0, -.1, .1), new T.Vector3(0, 0, .11), new T.Vector3(0, .1, .1), new T.Vector3(0, .2, .02)], u => .018 + Math.abs(u - .5) * .02, 16, 8), m.gold);
  add(w, new T.CylinderGeometry(.026, .03, .22, 12), m.leather, [0, 0, -.01], [Math.PI / 2, 0, 0]);
  add(w, sphere(.04, 16, 12), m.gold, [0, 0, -.14]); add(w, new T.OctahedronGeometry(.022), m.glow, [0, 0, -.17]);
  rig.bladeBase.position.set(0, 0, .2); rig.bladeTip.position.set(0, 0, 1.28); rig.tip.position.set(0, 0, 1.2); rig.weapon.add(rig.tip);
  // Kite shield on the off hand.
  const kite = new T.Shape(); kite.moveTo(-.25, .3); kite.quadraticCurveTo(0, .38, .25, .3); kite.lineTo(.23, -.04); kite.quadraticCurveTo(.16, -.32, 0, -.48); kite.quadraticCurveTo(-.16, -.32, -.23, -.04); kite.closePath();
  const shield = new T.Group(); j.wL.add(shield); shield.position.set(.03, .02, .1);
  add(shield, extrude(kite, .03, .022), m.dark, [0, 0, 0]);
  const rim = new T.Shape(); rim.moveTo(-.25, .3); rim.quadraticCurveTo(0, .38, .25, .3); rim.lineTo(.23, -.04); rim.quadraticCurveTo(.16, -.32, 0, -.48); rim.quadraticCurveTo(-.16, -.32, -.23, -.04); rim.closePath();
  const hole = new T.Path(); hole.moveTo(-.215, .27); hole.lineTo(-.198, -.03); hole.quadraticCurveTo(-.135, -.27, 0, -.415); hole.quadraticCurveTo(.135, -.27, .198, -.03); hole.lineTo(.215, .27); hole.quadraticCurveTo(0, .335, -.215, .27); rim.holes.push(hole);
  add(shield, extrude(rim, .012, .01), m.gold, [0, 0, .035]);
  add(shield, extrude(sun, .01, .008), m.gold, [0, .06, .05], [0, 0, 0], [1.6, 1.6, 1]);
  add(shield, rbox(.03, .5, .012, .006), m.glow, [0, -.04, .044]); add(shield, rbox(.32, .03, .012, .006), m.glow, [0, .1, .044]);
  // Cape and tabards.
  const cape = new Cloth(m.cloth, .62, 1.22, 8, 14, { rest: .16, taper: -.35, flutter: 1 });
  j.ch.add(cape.mesh); cape.mesh.position.set(0, .4, -.2); rig.cloths.push(cape);
  for (const [z, facing] of [[.22, -1], [-.2, 1]] as const) {
    const tabard = new Cloth(m.cloth, .26, .5, 3, 8, { rest: .04, facing, flutter: .5, seed: z * 9 });
    j.hp.add(tabard.mesh); tabard.mesh.position.set(0, .02, z); rig.cloths.push(tabard);
  }
  void assets;
}

function mage(rig: ClaudeRig, m: Mats): void {
  const { j } = rig;
  // Robe skirt: a flared lathe the legs push from inside.
  const skirtGeometry = lathe([[.2, .08], [.24, -.1], [.3, -.35], [.38, -.62], [.46, -.88], [.47, -.92]], 40);
  const skirt = new Skirt(skirtGeometry, m.cloth, .08, -.92); j.hp.add(skirt.mesh); skirt.mesh.scale.z = .85; rig.skirt = skirt;
  add(j.hp, lathe([[.465, -.86], [.475, -.9], [.47, -.93]], 40), m.trim, [0, 0, 0], [0, 0, 0], [1, 1, .85]);
  add(j.hp, new T.TorusGeometry(.215, .03, 8, 32), m.trim, [0, .06, 0], [Math.PI / 2, 0, 0], [1, .85, 1]);
  add(j.hp, rbox(.07, .07, .03, .015), m.glow, [0, .06, .19]);
  // Upper robe, cowl and brooch.
  add(j.sp, lathe([[.19, -.04], [.2, .1], [.2, .32]]), m.cloth, [0, 0, 0], [0, 0, 0], [1, 1, .82]);
  add(j.ch, lathe([[.19, -.02], [.24, .12], [.27, .26], [.24, .36], [.14, .44]], 32), m.cloth, [0, 0, 0], [0, 0, 0], [1, 1, .8]);
  add(j.ch, lathe([[.13, .34], [.25, .36], [.27, .4], [.18, .48], [.1, .46]], 32), m.clothDark, [0, 0, 0], [0, 0, 0], [1, 1, .9]);
  add(j.ch, new T.OctahedronGeometry(.05), m.crystal, [0, .3, .2], [0, 0, 0], [1, 1.4, .6]);
  add(j.ch, new T.TorusGeometry(.055, .01, 6, 24), m.trim, [0, .3, .195]);
  for (const x of [-.08, .08]) add(j.ch, rbox(.03, .36, .01, .005), m.trim, [x, .14, .21], [-.1, 0, 0]);
  // Bell sleeves.
  for (const [shoulder, elbow] of [[j.sR, j.eR], [j.sL, j.eL]] as const) {
    add(shoulder, sphere(.1, 18, 12), m.cloth, [0, -.02, 0]);
    add(shoulder, lathe([[.08, 0], [.09, -.18], [.085, -.34]]), m.cloth);
    add(elbow, lathe([[.08, .02], [.11, -.12], [.17, -.28], [.19, -.32], [.0, -.31]], 24), m.cloth, [0, 0, .015]);
    add(elbow, new T.TorusGeometry(.185, .012, 6, 28), m.trim, [0, -.315, .015], [Math.PI / 2, 0, 0]);
  }
  // Shadowed face, glowing eyes and a wizard hat with a bent tip.
  add(j.hd, sphere(.15, 24, 16), new T.MeshStandardMaterial({ color: '#0d0b16', roughness: .9 }), [0, .1, .01], [0, 0, 0], [1, 1.1, .95]);
  for (const x of [-.055, .055]) add(j.hd, new T.CapsuleGeometry(.014, .03, 4, 8), m.eye, [x, .11, .135], [0, 0, Math.PI / 2]);
  add(j.hd, lathe([[.08, 0], [.36, .0], [.42, -.03], [.42, -.045], [.34, -.02], [.08, -.02]], 40), m.cloth, [0, .2, 0]);
  const hat = taperTube([new T.Vector3(0, .18, 0), new T.Vector3(0, .38, -.02), new T.Vector3(.02, .58, -.06), new T.Vector3(.1, .72, -.14), new T.Vector3(.26, .74, -.2)], u => .19 * Math.pow(1 - u, 1.15) + .006, 32, 20);
  add(j.hd, hat, m.cloth);
  add(j.hd, new T.TorusGeometry(.172, .022, 8, 36), m.trim, [0, .23, 0], [Math.PI / 2, 0, 0]);
  add(j.hd, new T.OctahedronGeometry(.035), m.crystal, [0, .235, .17]);
  // Gnarled staff with a crescent claw holding a floating crystal.
  const w = rig.weapon;
  const shaft = taperTube([new T.Vector3(0, 0, -.95), new T.Vector3(.02, .01, -.4), new T.Vector3(-.01, -.01, .2), new T.Vector3(.015, .02, .8), new T.Vector3(0, 0, 1.18)], u => .03 + .008 * Math.sin(u * 40) + (u > .9 ? (u - .9) * .25 : 0), 48, 10);
  add(w, shaft, m.wood);
  for (const z of [-.2, .55, .95]) add(w, new T.TorusGeometry(.04, .01, 6, 20), m.trim, [0, 0, z]);
  for (const dir of [-1, 1]) add(w, taperTube([new T.Vector3(0, 0, 1.16), new T.Vector3(dir * .1, 0, 1.24), new T.Vector3(dir * .14, 0, 1.42), new T.Vector3(dir * .06, 0, 1.56)], u => .022 * (1 - u) + .005, 20, 8), m.trim);
  const crystal = add(w, new T.OctahedronGeometry(.075, 0), m.crystal, [0, 0, 1.4], [0, 0, 0], [1, 1, 1.7]);
  crystal.add(rig.tip);
  rig.bladeBase.position.set(0, 0, .9); rig.bladeTip.position.set(0, 0, 1.45);
  for (let i = 0; i < 3; i++) { const orb = add(w, new T.IcosahedronGeometry(.022, 1), m.glow, [0, 0, 1.4]); orb.userData['dynamic'] = true; rig.orbs.push(orb); }
  // Stole: two ribbons falling over the chest.
  for (const x of [-.11, .11]) {
    const stole = new Cloth(m.trim, .075, .75, 1, 10, { rest: -.08, facing: -1, flutter: .7, seed: x * 30 });
    j.ch.add(stole.mesh); stole.mesh.position.set(x, .38, .19); rig.cloths.push(stole);
  }
  const back = new Cloth(m.clothDark, .5, .8, 6, 10, { rest: .12, taper: .2, flutter: .8 });
  j.ch.add(back.mesh); back.mesh.position.set(0, .42, -.17); rig.cloths.push(back);
  boot(rig, m, false);
}

function ronin(rig: ClaudeRig, m: Mats): void {
  const { j, legs } = rig;
  // Hakama: pleated, flared per leg so lunges read clearly.
  const pleat = (points: [number, number][]) => {
    const geometry = lathe(points, 36), position = geometry.attributes['position'] as T.BufferAttribute;
    for (let i = 0; i < position.count; i++) { const x = position.getX(i), z = position.getZ(i), a = Math.atan2(x, z), k = 1 + .07 * Math.cos(a * 9); position.setX(i, x * k); position.setZ(i, z * k); }
    geometry.computeVertexNormals(); return geometry;
  };
  for (const [thigh, knee] of [legs.R, legs.L]) {
    add(thigh, pleat([[.13, .06], [.17, -.15], [.2, -.46]]), m.clothDark);
    add(knee, pleat([[.19, .04], [.23, -.2], [.27, -.38], [.26, -.4]]), m.clothDark);
  }
  add(j.hp, pleat([[.22, .1], [.26, -.06], [.3, -.16]]), m.clothDark);
  // Obi with a knot at the back, saya on the left hip.
  add(j.hp, new T.TorusGeometry(.21, .055, 10, 36), m.cloth, [0, .08, 0], [Math.PI / 2, 0, 0], [1, .82, 1.2]);
  add(j.hp, sphere(.06, 16, 12), m.cloth, [0, .08, -.19], [0, 0, 0], [1.6, .9, .7]);
  const saya = new T.Group(); j.hp.add(saya); saya.position.set(.25, .06, .05); saya.rotation.set(-1.95, .12, .1);
  add(saya, new T.CylinderGeometry(.024, .03, .95, 12), m.lacquer, [0, .5, 0], [0, 0, 0], [1, 1, .55]);
  add(saya, new T.TorusGeometry(.032, .006, 6, 16), m.gold, [0, .05, 0], [Math.PI / 2, 0, 0]);
  // Sheathed katana: shown while the real one is put away in the ultimate.
  const sheathed = new T.Group(); saya.add(sheathed); sheathed.position.set(0, 0, 0);
  add(sheathed, new T.CylinderGeometry(.045, .045, .012, 20), m.gold, [0, -.02, 0]);
  add(sheathed, new T.CylinderGeometry(.022, .026, .28, 10), m.leather, [0, -.16, 0]);
  rig.sheathed = sheathed; sheathed.visible = false;
  const gourdBelt = new T.Group(); j.hp.add(gourdBelt); gourdBelt.position.set(-.24, .02, .06);
  const gourd = (parent: T.Object3D) => { add(parent, sphere(.07, 16, 12), m.wood, [0, -.07, 0]); add(parent, sphere(.05, 16, 12), m.wood, [0, .02, 0]); add(parent, new T.CylinderGeometry(.015, .02, .05, 8), m.cloth, [0, .08, 0]); };
  gourd(gourdBelt); rig.gourdBelt = gourdBelt;
  const gourdHand = new T.Group(); j.wL.add(gourdHand); gourdHand.position.set(0, -.08, .07); gourdHand.rotation.x = 1.5; gourd(gourdHand); gourdHand.visible = false; rig.gourdHand = gourdHand;
  // Kimono top with crossed collar and wide sleeves.
  add(j.sp, lathe([[.18, -.06], [.2, .1], [.21, .32]]), m.clothDark, [0, 0, 0], [0, 0, 0], [1, 1, .85]);
  add(j.ch, lathe([[.2, -.04], [.25, .1], [.29, .24], [.27, .34], [.15, .42]], 32), m.cloth, [0, 0, 0], [0, 0, 0], [1, 1, .8]);
  for (const dir of [-1, 1]) add(j.ch, rbox(.06, .5, .02, .008), m.trim, [dir * .06, .2, .2], [-.12, 0, dir * .42]);
  add(j.ch, new T.TorusGeometry(.12, .025, 8, 24), m.clothDark, [0, .41, 0], [Math.PI / 2, 0, 0]);
  for (const [shoulder, elbow] of [[j.sR, j.eR], [j.sL, j.eL]] as const) {
    add(shoulder, sphere(.11, 18, 12), m.cloth, [0, -.02, 0]);
    add(shoulder, lathe([[.1, 0], [.14, -.2], [.16, -.36]]), m.cloth);
    add(elbow, lathe([[.07, 0], [.075, -.24]]), m.skin);
    add(elbow, lathe([[.08, -.1], [.088, -.26]]), m.dark);
    const sleeve = new Cloth(m.cloth, .22, .34, 2, 6, { rest: .5, facing: 1, flutter: .6 });
    shoulder.add(sleeve.mesh); sleeve.mesh.position.set(0, -.3, -.05); rig.cloths.push(sleeve);
  }
  // Masked face, glowing eyes, kasa hat with straw strands and a chin cord.
  add(j.hd, sphere(.13, 24, 16), m.skin, [0, .1, .01], [0, 0, 0], [1, 1.12, 1]);
  add(j.hd, sphere(.135, 24, 12, Math.PI * 2, Math.PI / 2), m.clothDark, [0, .07, .012], [Math.PI, 0, 0], [1, .9, 1.02]);
  for (const x of [-.048, .048]) add(j.hd, new T.CapsuleGeometry(.011, .03, 4, 8), m.eye, [x, .12, .118], [0, 0, Math.PI / 2 + (x > 0 ? -.2 : .2)]);
  add(j.hd, lathe([[.0, .44], [.08, .41], [.3, .3], [.52, .17], [.56, .145], [.55, .135], [.3, .27], [.08, .38], [0, .4]], 48), m.straw, [0, -.05, 0]);
  add(j.hd, new T.TorusGeometry(.545, .008, 6, 64), m.trim, [0, .093, 0], [Math.PI / 2, 0, 0]);
  add(j.hd, new T.TorusGeometry(.15, .006, 6, 28, Math.PI), m.cloth, [0, .12, 0], [0, Math.PI / 2, Math.PI]);
  // Katana: curved blade with a luminous hamon, tsuba and wrapped tsuka.
  const w = rig.weapon;
  add(w, katanaGeometry(1.0, .062, .07), m.steel, [0, 0, .12]);
  const hamon = taperTube(Array.from({ length: 8 }, (_, i) => { const k = i / 7, y = 1.0 * k; return new T.Vector3(0, .07 * k * k - .023 + .0068 * k, .12 + y); }), u => .0045 * (1 - u * .5), 32, 6);
  add(w, hamon, m.glow, [.0, 0, 0], [0, 0, 0], [3.2, 1, 1]);
  add(w, new T.CylinderGeometry(.065, .065, .014, 24), m.gold, [0, 0, .1], [Math.PI / 2, 0, 0], [1, 1, .8]);
  add(w, new T.CylinderGeometry(.023, .027, .3, 10), m.leather, [0, 0, -.04], [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 5; i++) add(w, new T.OctahedronGeometry(.02), m.trim, [0, 0, -.16 + i * .055], [0, 0, 0], [1.2, .5, 1]);
  add(w, new T.CylinderGeometry(.028, .025, .02, 12), m.gold, [0, 0, -.195], [Math.PI / 2, 0, 0]);
  rig.bladeBase.position.set(0, 0, .16); rig.bladeTip.position.set(0, .08, 1.14); rig.tip.position.set(0, .075, 1.1); rig.weapon.add(rig.tip);
  // Long trailing scarf.
  const scarf = new Cloth(m.glow.clone(), .13, 1.45, 1, 18, { rest: .7, taper: .25, flutter: 1.4, stiff: .7 });
  (scarf.mesh.material as T.MeshStandardMaterial).emissiveIntensity = .55; (scarf.mesh.material as T.MeshStandardMaterial).side = T.DoubleSide;
  rig.glow.push(scarf.mesh.material as T.MeshStandardMaterial);
  j.nk.add(scarf.mesh); scarf.mesh.position.set(.04, .02, -.12); rig.cloths.push(scarf);
  boot(rig, m, false);
}

/** Collapse each joint's static pieces into one mesh per material (cloth stays dynamic). */
function batch(parent: T.Group): void {
  const groups = new Map<T.Material, T.Mesh[]>();
  for (const child of parent.children) if (child instanceof T.Mesh && child.children.length === 0 && !Array.isArray(child.material) && child.geometry.index && child.userData['dynamic'] !== true) {
    const list = groups.get(child.material) ?? []; list.push(child); groups.set(child.material, list);
  }
  for (const [material, meshes] of groups) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map(mesh => { mesh.updateMatrix(); return mesh.geometry.clone().applyMatrix4(mesh.matrix); });
    const merged = mergeGeometries(geometries, false); for (const geometry of geometries) geometry.dispose();
    if (!merged) continue;
    for (const mesh of meshes) { parent.remove(mesh); mesh.geometry.dispose(); }
    const mesh = new T.Mesh(merged, material); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh);
  }
}

/**
 * Freeze the rig's current pose into one geometry (relative to its anchor). Ghosts use a
 * single draw; the split victim keeps one material group per source mesh.
 */
export function bakeRig(rig: ClaudeRig, groups: boolean): { geometry: T.BufferGeometry; materials: T.Material[]; origin: T.Vector3 } {
  rig.anchor.updateMatrixWorld(true);
  // World orientation (mirroring included), relative to the fighter's feet.
  const origin = new T.Vector3().setFromMatrixPosition(rig.anchor.matrixWorld);
  const inverse = new T.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z), geometries: T.BufferGeometry[] = [], mats: T.Material[] = [];
  rig.root.traverse(object => {
    if (!(object instanceof T.Mesh) || !object.visible || object === rig.aura || Array.isArray(object.material)) return;
    let visible = true; object.traverseAncestors(a => { if (!a.visible) visible = false; }); if (!visible) return;
    const g = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes['uv']) g.setAttribute('uv', new T.Float32BufferAttribute(new Float32Array(g.attributes['position'].count * 2), 2));
    g.applyMatrix4(new T.Matrix4().multiplyMatrices(inverse, object.matrixWorld)); geometries.push(g); mats.push(object.material);
  });
  const geometry = mergeGeometries(geometries, groups) ?? new T.BufferGeometry();
  for (const g of geometries) g.dispose();
  return { geometry, materials: mats, origin };
}
