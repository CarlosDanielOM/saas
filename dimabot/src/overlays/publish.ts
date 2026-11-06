import { checkOverrides, type WidgetField } from '../custom_widgets/format.js';
import type { AlertDesign, OverlayScene } from './model.js';

export type PublishedOverlay = NonNullable<OverlayScene['published']>;
/** What publishing needs from each custom widget an overlay uses. */
export interface PublishWidget { id: string; name: string; revision: number; fields: readonly WidgetField[] }
/** A custom widget layer that can't be published as it is (`code` matches the API error codes). */
export class PublishBlocked extends Error {
  constructor(message: string, readonly status: number, readonly code: 'missing_widget' | 'invalid_value') { super(message); }
}

/**
 * The copy of one overlay that OBS plays. Publishing stores exactly this, and the Studio's live status
 * rebuilds it from the saved draft to compare, so whatever publishing adds here can never make a
 * published overlay look unpublished. Custom widget layers are pinned to their widget's latest revision.
 */
export function buildPublished(scene: OverlayScene, designs: readonly AlertDesign[], widgets: ReadonlyMap<string, PublishWidget>): PublishedOverlay {
  const published: PublishedOverlay = structuredClone({ width: scene.width, height: scene.height, widgets: scene.widgets, waitFor: scene.waitFor,
    designs: designs.filter(d => scene.widgets.some(w => w.designId === d.id)) });
  for (const layer of published.widgets) {
    if (layer.kind !== 'custom') continue;
    const id = layer.config?.['widgetId'], widget = typeof id === 'string' ? widgets.get(id) : undefined;
    if (!widget) throw new PublishBlocked('A custom widget in this overlay was deleted. Remove its layer before publishing.', 404, 'missing_widget');
    const checked = checkOverrides(widget.fields, layer.config?.['values']);
    if ('error' in checked) throw new PublishBlocked(`${widget.name}: ${checked.error}`, 400, 'invalid_value');
    layer.config = { widgetId: widget.id, revision: widget.revision, ...(Object.keys(checked.values).length ? { values: checked.values } : {}) };
  }
  return published;
}

/** Key order is not content. */
const canonical = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, (v as Record<string, unknown>)[key]])) : v);
/** Design revision numbers are left out: saving bumps them even when nothing changed. */
const content = (overlay: PublishedOverlay) => canonical({ ...overlay, designs: overlay.designs.map(({ revision: _revision, ...design }) => design) });

/**
 * Per overlay: true when publishing the saved draft now would not change what OBS plays. False when it
 * was never published, has changes to publish, or can't be published (e.g. a deleted custom widget).
 */
export function liveStatus(scenes: readonly OverlayScene[], designs: readonly AlertDesign[], widgets: ReadonlyMap<string, PublishWidget>): Record<string, boolean> {
  return Object.fromEntries(scenes.map(scene => {
    if (!scene.published) return [scene.id, false];
    try { return [scene.id, content(buildPublished(scene, designs, widgets)) === content(scene.published)]; }
    catch (error) { if (error instanceof PublishBlocked) return [scene.id, false]; throw error; }
  }));
}
