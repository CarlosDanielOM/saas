import * as T from 'three';
import { describe, expect, it } from 'vitest';
import { bakeRig, type ClaudeRig } from './duel-claude-3d-rig';

describe('duel frozen fighter batching', () => {
  it('preserves every transformed attribute/material and the source piece order for transparent fades', () => {
    const anchor = new T.Group(), root = new T.Group(), aura = new T.Mesh();
    anchor.position.set(3, 2, -1); anchor.rotation.y = .4; anchor.add(root); root.add(aura);
    const steel = new T.MeshStandardMaterial({ metalness: 1 }), cloth = new T.MeshStandardMaterial({ roughness: .8 });
    const expected = new Map<T.Material, Record<string, number[]>>();
    const source: { material: T.Material; attributes: Record<string, number[]> }[] = [];
    for (const [i, material] of [steel, cloth, steel, steel, cloth].entries()) {
      const mesh = new T.Mesh(new T.BoxGeometry(.2, .3, .4), material);
      mesh.position.set(i * .3, i * .2, -.1); mesh.rotation.z = i * .17; root.add(mesh);
      anchor.updateMatrixWorld(true);
      const geometry = mesh.geometry.toNonIndexed().applyMatrix4(new T.Matrix4().makeTranslation(-3, -2, 1).multiply(mesh.matrixWorld));
      const attributes = expected.get(material) ?? { position: [], normal: [], uv: [] };
      const piece: Record<string, number[]> = {};
      for (const name of ['position', 'normal', 'uv']) { piece[name] = Array.from(geometry.attributes[name].array); attributes[name].push(...piece[name]); }
      source.push({ material, attributes: piece });
      expected.set(material, attributes); geometry.dispose();
    }
    const hidden = new T.Group(); hidden.visible = false; root.add(hidden); hidden.add(new T.Mesh(new T.SphereGeometry(), steel));
    const rig = { anchor, root, aura, cloths: [] } as unknown as ClaudeRig;
    const baked = bakeRig(rig, true);
    expect(baked.materials).toEqual([steel, cloth]);
    expect(baked.geometry.groups).toHaveLength(2);
    expect(baked.origin.toArray()).toEqual([3, 2, -1]);
    for (const group of baked.geometry.groups) {
      const attributes = expected.get(baked.materials[group.materialIndex!])!;
      for (const name of ['position', 'normal', 'uv']) {
        const attribute = baked.geometry.attributes[name];
        expect(Array.from(attribute.array.slice(group.start * attribute.itemSize, (group.start + group.count) * attribute.itemSize))).toEqual(attributes[name]);
      }
    }
    expect(baked.sourceGroups).toHaveLength(source.length);
    // Source pieces alternate materials. Their relocated ranges must still reproduce the
    // original draw order and triangle order when double-sided transparent surfaces fade.
    for (const [index, group] of baked.sourceGroups.entries()) {
      expect(baked.materials[group.materialIndex!]).toBe(source[index].material);
      for (const name of ['position', 'normal', 'uv']) {
        const attribute = baked.geometry.attributes[name];
        expect(Array.from(attribute.array.slice(group.start * attribute.itemSize, (group.start + group.count) * attribute.itemSize))).toEqual(source[index].attributes[name]);
      }
    }
    baked.geometry.dispose();
  });
});
