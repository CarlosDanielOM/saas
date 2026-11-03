import * as T from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { DuelCharacter } from '../duel-battle';

/**
 * Baked Blender assets for the extreme duel (sources: dimasite/tools/duel-blender).
 * Downloads are cached for the page's lifetime, so an OBS browser source pays for them once
 * and every later duel reuses the parsed models and textures.
 */
export const DUEL_ASSETS = '/assets/duel3d/';
export const CHARACTERS: readonly DuelCharacter[] = ['knight', 'mage', 'ronin'];
/** L violet (left), R amber (right), E crimson (enraged). */
export type Palette = 'L' | 'R' | 'E';

/** One cloth strip skinned to bone chains (written by build_duel.py). */
export interface ClothSpec {
  parent: string; chains: { bones: string[]; u: number }[];
  rest: number; taper: number; facing: number; flutter: number; stiff: number; seed: number; width: number; length: number;
  /** The wind the strip was draped with in Blender (0.1 when absent). */
  wind?: number;
}
export interface FighterAsset { gltf: GLTF; cloth: ClothSpec[] }
export interface FighterSkin { map: T.Texture; emissiveMap: T.Texture }

let loader: GLTFLoader | null = null;
const models = new Map<string, Promise<GLTF>>();
const skins = new Map<string, Promise<FighterSkin>>();
let cloth: Promise<Record<DuelCharacter, ClothSpec[]>> | null = null;
let warmed = false;

/** A failed download is forgotten, so the next duel can retry it. */
function cached<V>(cache: Map<string, Promise<V>>, key: string, load: () => Promise<V>): Promise<V> {
  let promise = cache.get(key);
  if (!promise) { promise = load(); promise.catch(() => cache.delete(key)); cache.set(key, promise); }
  return promise;
}

function model(name: string): Promise<GLTF> {
  return cached(models, name, () => {
    if (!loader) { loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder); }
    return loader.loadAsync(`${DUEL_ASSETS}${name}.glb`);
  });
}

function clothSpecs(): Promise<Record<DuelCharacter, ClothSpec[]>> {
  if (!cloth) {
    const promise = fetch(`${DUEL_ASSETS}cloth.json`).then(r => { if (!r.ok) throw new Error(`cloth.json ${r.status}`); return r.json(); });
    promise.catch(() => { if (cloth === promise) cloth = null; });
    cloth = promise;
  }
  return cloth;
}

export async function fighterAsset(character: DuelCharacter): Promise<FighterAsset> {
  const [gltf, specs] = await Promise.all([model(`duel_${character}`), clothSpecs()]);
  return { gltf, cloth: specs[character] ?? [] };
}

export function arenaAsset(): Promise<GLTF> { return model('duel_arena'); }

function texture(url: string): Promise<T.Texture> {
  return new T.TextureLoader().loadAsync(url).then(texture => {
    texture.flipY = false; texture.colorSpace = T.SRGBColorSpace; texture.anisotropy = 8; return texture;
  });
}

export function fighterSkin(character: DuelCharacter, palette: Palette): Promise<FighterSkin> {
  return cached(skins, `${character}_${palette}`, async () => {
    const [map, emissiveMap] = await Promise.all([texture(`${DUEL_ASSETS}textures/${character}_${palette}_base.webp`), texture(`${DUEL_ASSETS}textures/${character}_${palette}_emit.webp`)]);
    return { map, emissiveMap };
  });
}

/**
 * Called when a channel uses the extreme tier, before any duel starts: parses every fighter
 * model and warms the HTTP cache for the palette textures (decoded only when a duel needs them).
 * The arena is not preloaded: OBS overlays are transparent and never draw it.
 */
export function preloadDuel3d(): void {
  if (warmed) return; warmed = true;
  for (const character of CHARACTERS) {
    fighterAsset(character).catch(() => undefined);
    for (const palette of ['L', 'R', 'E'] as const) for (const kind of ['base', 'emit'])
      fetch(`${DUEL_ASSETS}textures/${character}_${palette}_${kind}.webp`, { priority: 'low' } as RequestInit).catch(() => undefined);
  }
}
