import { describe, expect, it, vi } from 'vitest';
import { DuelClaude3dScene, type DuelSceneState } from './duel-claude-3d-scene';

describe('duel shader preparation failure recovery', () => {
  it('restores the existing render target if optional preparation fails and does not retry every frame', () => {
    const original = {}, hdr = {}, dataset: Record<string, string> = {};
    let current = original;
    const compile = vi.fn(() => { throw new Error('driver preparation unavailable'); });
    const renderer = { getRenderTarget: () => current, setRenderTarget: (target: object) => { current = target; }, compile };
    // Exercise lifecycle handling without constructing a WebGL context in the unit runner.
    const scene = Object.assign(Object.create(DuelClaude3dScene.prototype), {
      renderer, composer: { renderTarget1: hdr }, canvas: { dataset }, scene: {}, camera: {},
      shadersFor: null, shadersTransparent: false, shaderPreparationCount: 0,
    }) as { prepareShaders(state: DuelSceneState): void };
    const state = { battle: {}, transparent: false } as DuelSceneState;
    expect(() => scene.prepareShaders(state)).not.toThrow();
    expect(current).toBe(original);
    expect(dataset['shaderPrep']).toBe('deferred');
    expect(Number(dataset['shaderPreparationMs'])).toBeGreaterThanOrEqual(0);
    scene.prepareShaders(state);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(dataset['shaderPreparationCount']).toBe('1');
  });
});
