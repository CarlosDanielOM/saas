import { layoutSounds, type AlertDesign, type AlertEvent, type AlertLayout } from './overlay-model.generated';

/**
 * Editor-only forms of the shared overlay model (overlay-model.generated.ts): the editor keeps `sounds` only, merges
 * recovery copies and saves from the previous editor, and drops Bits looks from before shared Bits rules.
 */
/** In-memory form for the editor: `sounds` only (omitted when empty), every sound with a unique id, no legacy `sound` key. */
export function withSoundList(layout: AlertLayout): AlertLayout {
  const { sound: _legacy, sounds: _list, ...rest } = layout, seen = new Set<string>();
  const sounds = layoutSounds(layout).map((sound, index) => {
    let id = typeof sound.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(sound.id) && !seen.has(sound.id) ? sound.id : '';
    for (let n = index + 1; !id || seen.has(id); n++) id = 'sound-' + n;
    seen.add(id); return { ...sound, id };
  });
  return sounds.length ? { ...rest, sounds } : rest;
}
/** Every layout of a design in the editor's form (see `withSoundList`). */
export function withDesignSoundLists(design: AlertDesign): AlertDesign {
  const events = Object.fromEntries(Object.entries(design.events).map(([kind, layout]) => [kind, withSoundList(layout)])) as Record<AlertEvent, AlertLayout>;
  if (!design.variants) return { ...design, events };
  const variants = Object.fromEntries(Object.entries(design.variants).map(([kind, list]) => [kind, list?.map(v => ({ ...v, layout: withSoundList(v.layout) }))]));
  return { ...design, events, variants };
}
/**
 * A layout saved by the previous editor, which kept `sounds` untouched and edited only `sound` (same rules as the API
 * applies to a save without `writer`): `sound` replaces the fields of `sounds[0]`; no `sound` = it removed `sounds[0]`.
 */
export function mergeOldEditorSounds(layout: AlertLayout): AlertLayout {
  const { sound, sounds } = layout;
  if (!sounds) return layout;
  const { sound: _legacy, ...rest } = layout;
  if (sound) return { ...rest, sounds: sounds.length ? [{ ...sound, id: sounds[0].id }, ...sounds.slice(1)] : [{ id: 'sound', ...sound }] };
  return { ...rest, sounds: sounds.slice(1) };
}
/** Bits looks from before shared rules (amount ranges, no `ruleId`) can't be saved anymore; drop them. */
export function withoutLegacyBitsLooks(design: AlertDesign): AlertDesign {
  const bits = design.variants?.bits;
  if (!bits?.some(v => !v.ruleId)) return design;
  return { ...design, variants: { ...design.variants, bits: bits.filter(v => !!v.ruleId) } };
}
