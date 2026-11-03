import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { DuelCharacter, DuelSide } from '../duel-battle';
import type { ClaudeAssets } from './duel-claude-3d-assets';
import type { ClothSpec, FighterAsset, FighterSkin } from './duel-claude-3d-library';

/**
 * The extreme duel's fighters: baked Blender models (one skinned mesh each) driven by the
 * duel's own skeleton. Every fighter has a tree of plain joint groups (hips → spine → chest →
 * neck → head, two-bone arms, IK legs, weapon, props) that the choreography poses exactly as
 * before; the model's bones hang off those joints, so the GPU skins the mesh to the pose.
 * Models face +Z; the right fighter's stage is mirrored so both weapons stay on the camera side.
 */
export const ARM_JOINTS = ['hp', 'sp', 'ch', 'nk', 'hd', 'sR', 'eR', 'wR', 'sL', 'eL', 'wL'] as const;
export type ArmJoint = typeof ARM_JOINTS[number];
export const HIP_HEIGHT = 1.02, THIGH = .46, SHIN = .44, ANKLE = .08;
/** Emission is baked as color × strength; this keeps the glow below the bloom's blowout point. */
const EMISSIVE = .55, EMISSIVE_STRENGTH = 8;

export interface ClaudeRig {
  character: DuelCharacter; side: DuelSide;
  anchor: T.Group; root: T.Group; j: Record<ArmJoint, T.Group>;
  legs: { R: [T.Group, T.Group, T.Group]; L: [T.Group, T.Group, T.Group] };
  weapon: T.Group; bladeBase: T.Object3D; bladeTip: T.Object3D; focus: T.Object3D; tip: T.Object3D;
  sheathed: T.Object3D | null; gourdHand: T.Object3D | null; gourdBelt: T.Object3D | null;
  cloths: RigCloth[]; orbs: T.Object3D[]; aura: T.Mesh; book: T.Object3D | null; runes: T.Texture[];
  /** Skinned meshes (body, plus the mage's glass vials and rune band). */
  meshes: T.SkinnedMesh[];
  /** Body materials: emissive scaled by the pose's glow (base in userData.base). */
  glow: T.MeshStandardMaterial[];
  /** Added emissive light for hit flashes (a shader uniform on the body). */
  flash: T.Color;
  accent: T.Color;
  /** Props shown or hidden by the pose: their bone collapses to a point while hidden. */
  toggles: { group: T.Object3D; bone: T.Object3D }[];
  /** Per-rig resources; the model's geometry belongs to the shared asset cache. */
  owned: (T.Material | T.BufferGeometry | T.Texture)[];
}

const TINT: Record<DuelSide | 'enraged', string> = { left: '#b49cff', right: '#ffc06b', enraged: '#ff3a55' };

/** Bone chains of a draped strip, posed from the attachment's drag and the wind (stateless). */
export class RigCloth {
  private readonly qx = new T.Quaternion();
  private readonly qz = new T.Quaternion();
  private static readonly X = new T.Vector3(1, 0, 0);
  private static readonly Z = new T.Vector3(0, 0, 1);
  constructor(readonly parent: T.Object3D, private readonly spec: ClothSpec, private readonly chains: { u: number; bones: { bone: T.Object3D; rest: T.Quaternion }[] }[]) {}

  /** drag is the attachment velocity in the parent joint's frame; wind lifts the whole strip. */
  update(t: number, drag: T.Vector3, wind: number): void {
    const { facing, flutter, stiff, seed } = this.spec, restWind = this.spec.wind ?? .1;
    const lift = T.MathUtils.clamp(drag.z * .32 * facing + wind, -.5, 1.45), side = T.MathUtils.clamp(-drag.x * .25, -.7, .7);
    const restLift = T.MathUtils.clamp(restWind, -.5, 1.45);
    for (const chain of this.chains) {
      const K = chain.bones.length, u = chain.u;
      let previousTheta = 0, previousPhi = 0;
      for (let i = 0; i < K; i++) {
        // The model is draped at the rest wind; bones add the difference (same strip model as before).
        const v = (i + .5) / K;
        const wave = Math.sin(t * (2.3 + wind * 3) - v * 5.5 + u * 2.4 + seed) * (.05 + wind * .16 + Math.abs(lift) * .05) * flutter;
        const wave0 = Math.sin(-v * 5.5 + u * 2.4 + seed) * (.05 + restWind * .16 + Math.abs(restLift) * .05) * flutter;
        const theta = ((lift - restLift) * Math.pow(v, .7 * stiff) + (wave - wave0) * v) * facing;
        const phi = side * v + (Math.sin(t * 1.7 - v * 3.8 + u * 3 + seed) - Math.sin(-v * 3.8 + u * 3 + seed)) * .06 * v * flutter;
        const { bone, rest } = chain.bones[i];
        this.qx.setFromAxisAngle(RigCloth.X, theta - previousTheta); this.qz.setFromAxisAngle(RigCloth.Z, -(phi - previousPhi));
        bone.quaternion.copy(rest).multiply(this.qx).multiply(this.qz);
        previousTheta = theta; previousPhi = phi;
      }
    }
  }
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

/** The enraged fighter's column of crimson heat. */
function aura(enraged: boolean): T.Mesh {
  const mesh = new T.Mesh(new T.CylinderGeometry(.62, .8, 2.5, 32, 1, true), new T.ShaderMaterial({
    transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color('#ff2848') } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv;uniform float uTime;uniform vec3 uColor;float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
      float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
      void main(){float f=n(vec2(vUv.x*14.,vUv.y*3.-uTime*2.5))*n(vec2(vUv.x*7.+3.,vUv.y*5.-uTime*1.7));float a=f*smoothstep(1.,.05,vUv.y)*smoothstep(0.,.1,vUv.y);gl_FragColor=vec4(uColor*a*1.4,1.);}`,
  }));
  mesh.position.y = 1.15; mesh.visible = enraged; mesh.castShadow = false;
  return mesh;
}

/** The duel's joint tree, identical to the one the choreography was written for. */
function skeleton(character: DuelCharacter) {
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
  j.wR.add(weapon); weapon.position.set(0, -.07, .02); weapon.add(bladeBase, bladeTip, tip); j.ch.add(focus); focus.position.set(0, .15, .1);
  let sheathed: T.Group | null = null, gourdHand: T.Group | null = null, gourdBelt: T.Group | null = null, book: T.Group | null = null;
  const orbs: T.Object3D[] = [];
  if (character === 'knight') { bladeBase.position.set(0, 0, .2); bladeTip.position.set(0, 0, 1.28); tip.position.set(0, 0, 1.2); }
  if (character === 'mage') {
    bladeBase.position.set(0, 0, .9); bladeTip.position.set(0, 0, 1.45); tip.position.set(0, 0, 1.4);
    for (let i = 0; i < 3; i++) { const orb = new T.Object3D(); weapon.add(orb); orbs.push(orb); }
    book = group(); root.add(book);
  }
  if (character === 'ronin') {
    bladeBase.position.set(0, 0, .16); bladeTip.position.set(0, .08, 1.14); tip.position.set(0, .075, 1.1);
    const saya = group(); j.hp.add(saya); saya.position.set(.25, .06, .05); saya.rotation.set(-1.95, .12, .1);
    sheathed = group(); saya.add(sheathed); sheathed.visible = false;
    gourdBelt = group(); j.hp.add(gourdBelt); gourdBelt.position.set(-.24, .02, .06);
    gourdHand = group(); j.wL.add(gourdHand); gourdHand.position.set(0, -.08, .07); gourdHand.rotation.x = 1.5; gourdHand.visible = false;
  }
  return { anchor, root, j, legs, weapon, bladeBase, bladeTip, focus, tip, sheathed, gourdHand, gourdBelt, book, orbs };
}

/** Body material: palette textures plus an extra emissive term for hit flashes. */
function bodyMaterial(source: T.MeshStandardMaterial, skin: FighterSkin, flash: T.Color): T.MeshStandardMaterial {
  const material = source.clone();
  material.color.set('#ffffff'); material.map = skin.map; material.emissiveMap = skin.emissiveMap; material.emissive.set('#ffffff');
  material.emissiveIntensity = EMISSIVE_STRENGTH * EMISSIVE; material.side = T.DoubleSide;
  material.userData['base'] = material.emissiveIntensity; material.userData['body'] = true;
  const uniform = { value: flash };
  material.onBeforeCompile = shader => {
    shader.uniforms['uFlash'] = uniform;
    shader.fragmentShader = 'uniform vec3 uFlash;\n' + shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += uFlash;');
  };
  material.customProgramCacheKey = () => 'duel-body-flash';
  material.needsUpdate = true;
  return material;
}

/**
 * Dress a duel skeleton in a baked model. Each bone is re-parented under its joint with the
 * fixed offset it has at rest, so posing the joints poses the model; cloth bones stay chained.
 */
export function buildRig(character: DuelCharacter, side: DuelSide, enraged: boolean, asset: FighterAsset, skin: FighterSkin, assets: ClaudeAssets): ClaudeRig {
  const s = skeleton(character), owned: ClaudeRig['owned'] = [];
  const tint = TINT[enraged ? 'enraged' : side], flash = new T.Color(0, 0, 0);
  // Free props sit where the model has them at rest (they are re-posed every frame).
  if (s.book) { s.book.position.set(.62, 1.45, .2); s.book.rotation.set(-.5, 0, .25); }
  const model = cloneSkinned(asset.gltf.scene); s.root.add(model);
  s.anchor.updateMatrixWorld(true);
  const meshes: T.SkinnedMesh[] = [];
  model.traverse(object => { if ((object as T.SkinnedMesh).isSkinnedMesh) meshes.push(object as T.SkinnedMesh); });
  if (!meshes.length) throw new Error(`duel model ${character} has no skinned mesh`);
  const skeletonBones = meshes[0].skeleton.bones;
  // Rest transform of every bone in world space: the exported nodes are in the rest pose, which
  // shows the mesh as modelled. (Not the inverse bind matrices: mesh quantization folds its
  // dequantization scale into those.)
  const bind = new Map<T.Object3D, T.Matrix4>(skeletonBones.map(bone => [bone, bone.matrixWorld.clone()]));
  const byName = new Map(skeletonBones.map(bone => [bone.name, bone]));
  const drivers: Record<string, T.Object3D | null | undefined> = {
    root: s.root, ...s.j, tR: s.legs.R[0], kR: s.legs.R[1], aR: s.legs.R[2], tL: s.legs.L[0], kL: s.legs.L[1], aL: s.legs.L[2],
    wp: s.weapon, bk: s.book, gb: s.gourdBelt, gh: s.gourdHand, sh: s.sheathed, o0: s.orbs[0], o1: s.orbs[1], o2: s.orbs[2],
  };
  // Orbs circle the staff; their joints start where the model has them.
  s.orbs.forEach((orb, i) => { const bone = byName.get(`o${i}`); if (bone) { orb.position.setFromMatrixPosition(bind.get(bone)!).applyMatrix4(s.weapon.matrixWorld.clone().invert()); } });
  s.anchor.updateMatrixWorld(true);
  const local = new T.Matrix4();
  // Unmapped bones (cloth chains) keep their rest offset from their parent bone.
  for (const bone of skeletonBones) {
    const driver = drivers[bone.name]; if (!driver) continue;
    local.copy(driver.matrixWorld).invert().multiply(bind.get(bone)!).decompose(bone.position, bone.quaternion, bone.scale);
  }
  for (const bone of skeletonBones) { const driver = drivers[bone.name]; if (driver) driver.add(bone); }
  s.anchor.updateMatrixWorld(true);

  const glow: T.MeshStandardMaterial[] = [], runes: T.Texture[] = [];
  for (const mesh of meshes) {
    mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;
    const source = mesh.material as T.MeshStandardMaterial;
    if (source.name === 'glass') {
      mesh.material = new T.MeshPhysicalMaterial({ color: '#d8f6ff', roughness: .05, metalness: 0, clearcoat: 1, transparent: true, opacity: .45 }); mesh.castShadow = false;
    } else if (source.name === 'runes') {
      // The hem's glyph band glows and scrolls slowly around the robe.
      // (glTF stores V flipped relative to three's lathe UVs, hence the -1 repeat.)
      const band = assets.runeBand.clone(); band.repeat.set(5, -1); band.offset.y = 1; band.channel = 1; band.needsUpdate = true; runes.push(band); owned.push(band);
      mesh.material = new T.MeshBasicMaterial({ color: new T.Color(tint).lerp(new T.Color('#ffffff'), .25), map: band, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false, opacity: .9 });
      mesh.castShadow = false;
    } else { const body = bodyMaterial(source, skin, flash); mesh.material = body; glow.push(body); }
    owned.push(mesh.material as T.Material);
  }

  const rigAura = aura(enraged); s.root.add(rigAura); owned.push(rigAura.geometry, rigAura.material as T.Material);
  const toggles: ClaudeRig['toggles'] = [];
  for (const [group, name] of [[s.weapon, 'wp'], [s.sheathed, 'sh'], [s.gourdHand, 'gh'], [s.gourdBelt, 'gb']] as const) {
    const bone = byName.get(name); if (group && bone) toggles.push({ group, bone });
  }
  const cloths = asset.cloth.map(spec => new RigCloth(drivers[spec.parent] ?? byName.get(spec.parent)!, spec, spec.chains.map(chain => ({
    u: chain.u, bones: chain.bones.map(name => { const bone = byName.get(name)!; return { bone, rest: bone.quaternion.clone() }; }),
  }))));
  const rig: ClaudeRig = {
    character, side, anchor: s.anchor, root: s.root, j: s.j, legs: s.legs, weapon: s.weapon, bladeBase: s.bladeBase, bladeTip: s.bladeTip, focus: s.focus, tip: s.tip,
    sheathed: s.sheathed, gourdHand: s.gourdHand, gourdBelt: s.gourdBelt, cloths, orbs: s.orbs, aura: rigAura, book: s.book, runes,
    meshes, glow, flash, accent: new T.Color(tint), toggles, owned,
  };
  syncToggles(rig);
  return rig;
}

/** Hidden props collapse their bone (and everything skinned to it) to a point. */
export function syncToggles(rig: ClaudeRig): void {
  for (const { group, bone } of rig.toggles) bone.scale.setScalar(group.visible ? 1 : 1e-4);
}

export function disposeRig(rig: ClaudeRig): void {
  rig.anchor.removeFromParent();
  for (const resource of rig.owned) resource.dispose();
}

/**
 * Freeze the rig's current pose into one geometry (relative to its anchor), skinning on the
 * CPU exactly as the GPU does. Ghosts and the avatar use one draw; the split victim gets one
 * group per material (body, vials, rune band), drawn in the same order while it fades.
 */
export interface BakedRig {
  geometry: T.BufferGeometry; materials: T.Material[]; origin: T.Vector3;
  sourceGroups: T.BufferGeometry['groups'];
}

export function bakeRig(rig: ClaudeRig, groups: boolean): BakedRig {
  rig.anchor.updateMatrixWorld(true);
  const origin = new T.Vector3().setFromMatrixPosition(rig.anchor.matrixWorld);
  const meshes = rig.meshes.filter(mesh => { let visible = true; mesh.traverseAncestors(a => { if (!a.visible) visible = false; }); return visible && mesh.visible; });
  const withUv1 = meshes.some(mesh => !!mesh.geometry.attributes['uv1']);
  const geometries = meshes.map(mesh => skinnedSnapshot(mesh, origin, withUv1));
  const geometry = mergeGeometries(geometries, groups) ?? new T.BufferGeometry();
  for (const g of geometries) g.dispose();
  const materials = meshes.map(mesh => mesh.material as T.Material);
  return { geometry, materials, origin, sourceGroups: groups ? geometry.groups.map(group => ({ ...group })) : [] };
}

interface Unpacked { position: Float32Array; normal: Float32Array; uv: Float32Array | null; uv1: Float32Array | null; skinIndex: Uint16Array; skinWeight: Float32Array; index: Uint32Array | null }
/** Decoded (dequantized, de-interleaved) copies of a model's attributes, made once per geometry. */
const unpacked = new WeakMap<T.BufferGeometry, Unpacked>();

function unpack(geometry: T.BufferGeometry): Unpacked {
  let data = unpacked.get(geometry);
  if (!data) {
    // (Decoded glTF attributes may be interleaved and normalized; getComponent reads either.)
    const read = <A extends Float32Array | Uint16Array>(name: string, make: (n: number) => A): A | null => {
      const attribute = geometry.attributes[name] as T.BufferAttribute | undefined; if (!attribute) return null;
      const out = make(attribute.count * attribute.itemSize);
      for (let i = 0; i < attribute.count; i++) for (let c = 0; c < attribute.itemSize; c++) out[i * attribute.itemSize + c] = attribute.getComponent(i, c);
      return out;
    };
    data = {
      position: read('position', n => new Float32Array(n))!, normal: read('normal', n => new Float32Array(n))!, uv: read('uv', n => new Float32Array(n)), uv1: read('uv1', n => new Float32Array(n)),
      skinIndex: read('skinIndex', n => new Uint16Array(n))!, skinWeight: read('skinWeight', n => new Float32Array(n))!,
      index: geometry.index ? Uint32Array.from(geometry.index.array as ArrayLike<number>) : null,
    };
    unpacked.set(geometry, data);
  }
  return data;
}

const _bone = new T.Matrix4();

function skinnedSnapshot(mesh: T.SkinnedMesh, origin: T.Vector3, withUv1: boolean): T.BufferGeometry {
  const source = unpack(mesh.geometry), skeleton = mesh.skeleton;
  skeleton.update();
  // Per bone: world = bone · boneInverse · bindMatrix (attached bind mode), as a 3×4 affine.
  const bones = skeleton.bones.length, affine = new Float32Array(bones * 12);
  for (let b = 0; b < bones; b++) {
    const e = _bone.fromArray(skeleton.boneMatrices!, b * 16).multiply(mesh.bindMatrix).elements;
    affine.set([e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]], b * 12);
  }
  const count = source.position.length / 3, positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  const { position, normal, skinIndex, skinWeight } = source, m = new Float32Array(12);
  for (let i = 0; i < count; i++) {
    m.fill(0);
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[i * 4 + k]; if (w === 0) continue;
      const o = skinIndex[i * 4 + k] * 12;
      for (let c = 0; c < 12; c++) m[c] += affine[o + c] * w;
    }
    const x = position[i * 3], y = position[i * 3 + 1], z = position[i * 3 + 2];
    positions[i * 3] = m[0] * x + m[3] * y + m[6] * z + m[9] - origin.x;
    positions[i * 3 + 1] = m[1] * x + m[4] * y + m[7] * z + m[10] - origin.y;
    positions[i * 3 + 2] = m[2] * x + m[5] * y + m[8] * z + m[11] - origin.z;
    // Linear-blend normals, as the GPU skins them; renormalized.
    const nx = normal[i * 3], ny = normal[i * 3 + 1], nz = normal[i * 3 + 2];
    const tx = m[0] * nx + m[3] * ny + m[6] * nz, ty = m[1] * nx + m[4] * ny + m[7] * nz, tz = m[2] * nx + m[5] * ny + m[8] * nz, l = Math.hypot(tx, ty, tz) || 1;
    normals[i * 3] = tx / l; normals[i * 3 + 1] = ty / l; normals[i * 3 + 2] = tz / l;
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(positions, 3)); geometry.setAttribute('normal', new T.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new T.BufferAttribute(source.uv ? source.uv.slice() : new Float32Array(count * 2), 2));
  if (withUv1) geometry.setAttribute('uv1', new T.BufferAttribute(source.uv1 ? source.uv1.slice() : new Float32Array(count * 2), 2));
  if (source.index) geometry.setIndex(new T.BufferAttribute(source.index.slice(), 1));
  return geometry;
}
