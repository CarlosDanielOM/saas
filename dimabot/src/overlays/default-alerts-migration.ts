import { makeDesign, type AlertDesign, type OverlayScene } from './model.js';
import { makeDefaultDesign, type DefaultAlertLanguage } from './default-alerts.js';

/** The starter design every new studio got before the Dima default alerts (store.ts load(), until 2026-11-15). */
export function legacyStarterDesign(): AlertDesign {
  const design = makeDesign('starter', 'My alerts');
  design.events.bits.widgets[1].text = '$(user) sent $(cheer.amount) bits';
  design.events.raid.widgets[1].text = '$(raid.channel) arrived with $(raid.viewers) viewers';
  return design;
}
const canonical = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, (v as Record<string, unknown>)[key]])) : v);
/**
 * True only for a design nobody touched: the old starter's id, name, size and four layouts, with no looks (variants).
 * Its revision is ignored (saving an unchanged draft bumps it).
 */
export function isUntouchedStarter(design: AlertDesign): boolean {
  const { revision: _a, variants, ...rest } = design, { revision: _b, ...legacy } = legacyStarterDesign();
  const noLooks = !variants || Object.values(variants).every(list => !list?.length);
  return noLooks && canonical(rest) === canonical(legacy);
}
export interface StudioDoc { _id: string; revision: number; scenes: OverlayScene[]; designs: AlertDesign[] }
export interface DefaultAlertsUpgrade { designs: AlertDesign[]; scenes: OverlayScene[]; draft: string[]; published: string[] }
/**
 * Swaps untouched starter designs for the Dima defaults. The draft is replaced only when it is untouched; a published
 * copy only when the draft was replaced and that copy is untouched too (so drafts and OBS stay in step). Overlays whose
 * published copy changed get a new revision. Returns null when there is nothing to replace.
 */
export function upgradeDefaultAlerts(doc: StudioDoc, language: DefaultAlertLanguage): DefaultAlertsUpgrade | null {
  const draft = doc.designs.filter(isUntouchedStarter).map(d => d.id);
  if (!draft.length) return null;
  const fresh = (old: AlertDesign) => ({ ...makeDefaultDesign(old.id, old.name, language), revision: old.revision + 1 });
  const designs = doc.designs.map(d => draft.includes(d.id) ? fresh(d) : d), published: string[] = [];
  const scenes = doc.scenes.map(scene => {
    if (!scene.published?.designs.some(d => draft.includes(d.id) && isUntouchedStarter(d))) return scene;
    published.push(scene.id);
    return { ...scene, revision: scene.revision + 1, published: { ...scene.published, designs: scene.published.designs.map(d => draft.includes(d.id) && isUntouchedStarter(d) ? fresh(d) : d) } };
  });
  return { designs, scenes, draft, published };
}
