import * as T from 'three';
import { describe, expect, it } from 'vitest';
import { ARM_JOINTS, HIP_HEIGHT, RigCloth, bakeRig, buildRig, type ClaudeRig } from './duel-claude-3d-rig';
import type { ClaudeAssets } from './duel-claude-3d-assets';
import type { ClothSpec, FighterAsset, FighterSkin } from './duel-claude-3d-library';

/** A skinned box: vertices above y=split follow `upper`, the rest follow `lower`. */
function skinnedBox(bones: T.Bone[], lower: number, upper: number, split: number, material: T.Material, size = .2, center = new T.Vector3()): T.SkinnedMesh {
  const geometry = new T.BoxGeometry(size, size, size, 2, 2, 2).translate(center.x, center.y, center.z);
  const count = geometry.attributes['position'].count, index = new Uint16Array(count * 4), weight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) { index[i * 4] = geometry.attributes['position'].getY(i) > split ? upper : lower; weight[i * 4] = 1; }
  geometry.setAttribute('skinIndex', new T.Uint16BufferAttribute(index, 4)); geometry.setAttribute('skinWeight', new T.Float32BufferAttribute(weight, 4));
  const mesh = new T.SkinnedMesh(geometry, material);
  return mesh;
}

function worldVertex(mesh: T.SkinnedMesh, i: number): T.Vector3 {
  return mesh.getVertexPosition(i, new T.Vector3()).applyMatrix4(mesh.matrixWorld);
}

describe('duel frozen fighter (CPU skinning)', () => {
  it('matches three.js skinning for every vertex, one group per material, hidden meshes skipped', () => {
    const anchor = new T.Group(), root = new T.Group(); anchor.position.set(3, 2, -1); anchor.rotation.y = .4; anchor.scale.x = -1; anchor.add(root);
    const b0 = new T.Bone(), b1 = new T.Bone(); b1.position.y = .5; b0.add(b1); root.add(b0);
    const body = new T.MeshStandardMaterial(), glass = new T.MeshStandardMaterial(), hidden = new T.MeshStandardMaterial();
    const meshes = [skinnedBox([b0, b1], 0, 1, .55, body, .3, new T.Vector3(0, .5, 0)), skinnedBox([b0, b1], 0, 1, .55, glass, .1, new T.Vector3(.2, .7, 0)), skinnedBox([b0, b1], 0, 1, .55, hidden)];
    meshes[1].geometry.setAttribute('uv1', meshes[1].geometry.attributes['uv'].clone());
    meshes[2].visible = false;
    anchor.updateMatrixWorld(true);
    for (const mesh of meshes) { root.add(mesh); mesh.bind(new T.Skeleton([b0, b1])); }
    b0.rotation.z = .3; b1.rotation.x = -.8; b1.position.y = .55;
    anchor.updateMatrixWorld(true);
    const rig = { anchor, meshes } as unknown as ClaudeRig;
    const baked = bakeRig(rig, true);
    expect(baked.materials).toEqual([body, glass]);
    expect(baked.geometry.groups.map(g => g.materialIndex)).toEqual([0, 1]);
    expect(baked.sourceGroups).toEqual(baked.geometry.groups);
    expect(baked.origin.toArray()).toEqual([3, 2, -1]);
    expect(baked.geometry.attributes['uv1']).toBeDefined();
    const position = baked.geometry.attributes['position'];
    let offset = 0;
    for (const mesh of meshes.slice(0, 2)) {
      for (let i = 0; i < mesh.geometry.attributes['position'].count; i++) {
        const expected = worldVertex(mesh, i).sub(baked.origin), got = new T.Vector3().fromBufferAttribute(position as T.BufferAttribute, offset + i);
        expect(got.distanceTo(expected)).toBeLessThan(1e-5);
      }
      offset += mesh.geometry.attributes['position'].count;
    }
    baked.geometry.dispose();
  });
});

/** A minimal stand-in for a baked fighter: bones named like the duel joints, at their rest places. */
function fakeFighter(): { asset: FighterAsset; chest: number } {
  const rest: Record<string, [string | null, T.Vector3]> = {
    root: [null, new T.Vector3()], hp: ['root', new T.Vector3(0, HIP_HEIGHT, 0)], sp: ['hp', new T.Vector3(0, .08, 0)], ch: ['sp', new T.Vector3(0, .3, 0)],
    cl0_0_0: ['ch', new T.Vector3(0, .4, -.2)], cl0_0_1: ['cl0_0_0', new T.Vector3(0, -.3, 0)],
  };
  const scene = new T.Group(), armature = new T.Group(); scene.add(armature);
  const bones = new Map<string, T.Bone>();
  // Joint bones carry an axis fix (like Blender's), so the test also covers non-identity rest frames.
  const axis = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), Math.PI);
  const world = new Map<string, T.Matrix4>();
  for (const [name, [parent, at]] of Object.entries(rest)) {
    const bone = new T.Bone(); bone.name = name; bones.set(name, bone);
    const parentWorld = parent ? world.get(parent)! : new T.Matrix4();
    const parentPosition = new T.Vector3().setFromMatrixPosition(parentWorld);
    const w = new T.Matrix4().compose(name.startsWith('cl') ? parentPosition.clone().add(at) : (parent ? parentPosition.clone().add(at) : at), name === 'ch' ? axis : new T.Quaternion(), new T.Vector3(1, 1, 1));
    world.set(name, w);
    new T.Matrix4().copy(parentWorld).invert().multiply(w).decompose(bone.position, bone.quaternion, bone.scale);
    (parent ? bones.get(parent)! : armature).add(bone);
  }
  const list = [...bones.values()], chest = list.findIndex(b => b.name === 'ch');
  const mesh = skinnedBox(list, list.findIndex(b => b.name === 'hp'), chest, HIP_HEIGHT + .3, new T.MeshStandardMaterial({ name: 'body' }), .3, new T.Vector3(0, HIP_HEIGHT + .3, 0));
  armature.add(mesh); scene.updateMatrixWorld(true); mesh.bind(new T.Skeleton(list));
  // Like a quantized glTF: positions stored scaled down, the scale folded into the inverse bind matrices.
  const k = 2.5; mesh.geometry.scale(1 / k, 1 / k, 1 / k);
  mesh.skeleton.boneInverses.forEach(inverse => inverse.multiply(new T.Matrix4().makeScale(k, k, k)));
  const cloth: ClothSpec[] = [{ parent: 'ch', chains: [{ bones: ['cl0_0_0', 'cl0_0_1'], u: 0 }], rest: .16, taper: 0, facing: 1, flutter: 1, stiff: 1, seed: 0, width: .6, length: 1.2, wind: .1 }];
  return { asset: { gltf: { scene } as unknown as FighterAsset['gltf'], cloth }, chest };
}

describe('duel fighter rig', () => {
  const skin = { map: new T.Texture(), emissiveMap: new T.Texture() } as FighterSkin;
  const assets = { runeBand: new T.Texture() } as unknown as ClaudeAssets;

  it('hangs the model bones off the duel joints without moving the mesh at rest', () => {
    const { asset } = fakeFighter();
    const source = asset.gltf.scene.children[0].children.find(o => (o as T.SkinnedMesh).isSkinnedMesh) as T.SkinnedMesh;
    const restVertices = Array.from({ length: source.geometry.attributes['position'].count }, (_, i) => worldVertex(source, i));
    const rig = buildRig('knight', 'left', false, asset, skin, assets);
    rig.anchor.updateMatrixWorld(true);
    const mesh = rig.meshes[0];
    restVertices.forEach((expected, i) => expect(worldVertex(mesh, i).distanceTo(expected)).toBeLessThan(1e-5));
    // Joint bones now live under the duel joints; cloth bones stay chained to their parent bone.
    expect(rig.j.ch.children.some(c => c.name === 'ch')).toBe(true);
    expect(rig.j.hp.children.some(c => c.name === 'hp')).toBe(true);
    expect(rig.cloths).toHaveLength(1);
    expect(ARM_JOINTS.every(name => rig.j[name])).toBe(true);
  });

  it('skins the model to the posed joints', () => {
    const { asset } = fakeFighter();
    const rig = buildRig('knight', 'left', false, asset, skin, assets);
    const mesh = rig.meshes[0], top = Array.from({ length: mesh.geometry.attributes['position'].count }, (_, i) => i).find(i => mesh.geometry.attributes['position'].getY(i) * 2.5 > HIP_HEIGHT + .4)!;
    rig.anchor.updateMatrixWorld(true);
    const before = worldVertex(mesh, top);
    rig.j.ch.rotation.x = .6; rig.anchor.updateMatrixWorld(true);
    const pivot = rig.j.ch.getWorldPosition(new T.Vector3());
    const expected = before.clone().sub(pivot).applyAxisAngle(new T.Vector3(1, 0, 0), .6).add(pivot);
    expect(worldVertex(mesh, top).distanceTo(expected)).toBeLessThan(1e-5);
  });

  it('flash and glow drive the body material', () => {
    const { asset } = fakeFighter();
    const rig = buildRig('knight', 'right', true, asset, skin, assets);
    expect(rig.glow).toHaveLength(1);
    expect(rig.glow[0].map).toBe(skin.map);
    expect(rig.glow[0].userData['body']).toBe(true);
    expect(rig.aura.visible).toBe(true);
    expect(rig.accent.getHexString()).toBe('ff3a55');
  });
});

describe('duel cloth bones', () => {
  it('leave the strip as modelled in the rest wind and lift it in a gust', () => {
    const bones = [new T.Bone(), new T.Bone(), new T.Bone()];
    bones.forEach((bone, i) => bone.quaternion.setFromEuler(new T.Euler(.1 * i, 0, .05)));
    const rest = bones.map(bone => bone.quaternion.clone());
    const spec: ClothSpec = { parent: 'ch', chains: [], rest: .16, taper: 0, facing: 1, flutter: 1, stiff: 1, seed: 2, width: .6, length: 1.2, wind: .25 };
    const cloth = new RigCloth(new T.Group(), spec, [{ u: .2, bones: bones.map((bone, i) => ({ bone, rest: rest[i] })) }]);
    cloth.update(0, new T.Vector3(), .25);
    bones.forEach((bone, i) => expect(bone.quaternion.angleTo(rest[i])).toBeLessThan(1e-6));
    cloth.update(0, new T.Vector3(), 1.2);
    expect(bones[2].quaternion.angleTo(rest[2])).toBeGreaterThan(.05);
  });
});
