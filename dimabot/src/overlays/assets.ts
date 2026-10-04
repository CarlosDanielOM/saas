import { AssetError, findAsset, registerAssetConsumer } from '../assets/library.js';
import { Studio, type StudioState } from './store.js';
import type { AlertLayout, OverlayScene } from './model.js';

type Snapshot = NonNullable<OverlayScene['published']>;
type AssetReference = { assetId?: string; kind: string };
const layoutAssets = (layout: AlertLayout): AssetReference[] => [...layout.widgets, ...(layout.sound ? [{ assetId: layout.sound.assetId, kind: 'audio' }] : [])];
export function snapshotAssets(snapshot: Snapshot): AssetReference[] {
  return [...snapshot.widgets, ...snapshot.designs.flatMap(d => Object.values(d.events).flatMap(layoutAssets))].filter(w => w.assetId);
}
function stateAssets(state: Pick<StudioState, 'scenes' | 'designs'>) {
  return [...state.scenes.flatMap(s => s.widgets), ...state.designs.flatMap(d => Object.values(d.events).flatMap(layoutAssets)), ...state.scenes.flatMap(s => s.published ? snapshotAssets(s.published) : [])].filter(w => w.assetId);
}
export async function validateAssets(owner: string, state: Pick<StudioState, 'scenes' | 'designs'>) {
  const assets = new Map<string, Awaited<ReturnType<typeof findAsset>>>();
  for (const widget of stateAssets(state)) {
    const asset = assets.get(widget.assetId!) ?? await findAsset(owner, widget.assetId!);
    assets.set(asset.id, asset);
    if (widget.kind !== asset.kind) throw new AssetError('asset_kind_mismatch');
  }
}
registerAssetConsumer('overlay-studio', async (owner, id) => {
  const state = await Studio.findById(owner).lean();
  return !!state && stateAssets(state).some(w => w.assetId === id);
});
