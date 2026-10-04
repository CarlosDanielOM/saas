import { createHash } from 'node:crypto';
import { change, load, object, string, validateState, OverlayError, type StudioState } from './store.js';
import { validateAssets } from './assets.js';
import { withAssetLibrary } from '../assets/library.js';

/** Append copies only: neither existing drafts nor published snapshots are replaced. */
export async function recoverCopies(channel: string, input: unknown): Promise<StudioState> {
  const body = object(input), recoveryId = string(body.recoveryId, 36);
  if (!/^[a-f0-9-]{36}$/.test(recoveryId)) throw new OverlayError('Invalid recovery request');
  const local = validateState(body, { schemaVersion: 1, revision: 0, scenes: [], designs: [] });
  const copyId = (kind: string, id: string) => 'recovered-' + createHash('sha256').update(`${recoveryId}:${kind}:${id}`).digest('hex').slice(0, 32);
  return withAssetLibrary(channel, async () => {
    const current = await load(channel);
    // Retrying after a lost HTTP response must not make another set of copies.
    if (local.scenes.every(s => current.scenes.some(saved => saved.id === copyId('scene', s.id)))
      && local.designs.every(d => current.designs.some(saved => saved.id === copyId('design', d.id)))) return current;
    if (current.scenes.length + local.scenes.length > 25 || current.designs.length + local.designs.length > 50) {
      throw new OverlayError('There is not enough room for recovery copies. Export your local draft before removing unused overlays or designs.', 409);
    }
    return change(channel, current.revision, async state => {
      const designs = local.designs.map(d => ({ ...d, id: copyId('design', d.id), name: `${d.name.slice(0, 65)} (recovered)` }));
      const scenes = local.scenes.map(s => ({ ...s, id: copyId('scene', s.id), name: `${s.name.slice(0, 65)} (recovered)`,
        widgets: s.widgets.map(w => ({ ...w, ...(w.designId ? { designId: copyId('design', w.designId) } : {}) })) }));
      const validated = validateState({ scenes: [...state.scenes, ...scenes], designs: [...state.designs, ...designs] }, state);
      await validateAssets(channel, validated); Object.assign(state, validated);
    });
  });
}
