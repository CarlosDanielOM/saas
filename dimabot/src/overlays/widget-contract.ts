/** Portable Overlay Studio module contract. Keep this file free of server/framework imports. */
export type WidgetPlacement = 'scene' | 'design';
export type WidgetDelivery = 'static' | 'state' | 'event';
export interface WidgetConfigField {
  readonly values?: readonly unknown[];
  readonly type?: 'string' | 'number' | 'boolean';
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
}
export interface WidgetDefinition {
  kind: string;
  configVersion: number;
  placements: readonly WidgetPlacement[];
  delivery: WidgetDelivery;
  defaultSize: { readonly width: number; readonly height: number };
  defaults: Readonly<Record<string, unknown>>;
  /** Module-owned fields, also accepted in their legacy flattened representation. */
  configFields?: Readonly<Record<string, WidgetConfigField>>;
  /** Omit a supported placement from its creation palette (saved widgets remain valid). */
  palette?: Partial<Record<WidgetPlacement, boolean>>;
  state?: { readonly source: string; readonly stateKey: string };
}
export const WIDGET_DEFINITIONS = [
  { kind: 'poll', configVersion: 1, placements: ['scene'], delivery: 'state', defaultSize: { width: 560, height: 360 }, defaults: { interactionDesign: 'card' }, configFields: { interactionDesign: { values: ['card', 'compact'] } }, state: { source: 'twitch-interactions', stateKey: 'poll' } },
  { kind: 'prediction', configVersion: 1, placements: ['scene'], delivery: 'state', defaultSize: { width: 560, height: 460 }, defaults: { interactionDesign: 'card' }, configFields: { interactionDesign: { values: ['card', 'compact'] } }, state: { source: 'twitch-interactions', stateKey: 'prediction' } },
  { kind: 'tts', configVersion: 1, placements: ['scene'], delivery: 'event', defaultSize: { width: 580, height: 160 }, defaults: {} },
  { kind: 'trigger', configVersion: 1, placements: ['scene'], delivery: 'event', defaultSize: { width: 300, height: 180 }, defaults: {} },
  { kind: 'clip', configVersion: 1, placements: ['scene'], delivery: 'event', defaultSize: { width: 300, height: 180 }, defaults: {} },
  { kind: 'alert', configVersion: 1, placements: ['scene'], delivery: 'event', defaultSize: { width: 640, height: 192 }, defaults: { events: ['sub', 'bits', 'follow', 'raid'] } },
  { kind: 'text', configVersion: 1, placements: ['scene', 'design'], palette: { scene: false }, delivery: 'static', defaultSize: { width: 400, height: 80 }, defaults: { text: '$(user)' } },
  { kind: 'image', configVersion: 1, placements: ['scene', 'design'], delivery: 'static', defaultSize: { width: 300, height: 180 }, defaults: {} },
  { kind: 'video', configVersion: 1, placements: ['scene', 'design'], delivery: 'static', defaultSize: { width: 300, height: 180 }, defaults: {} },
  { kind: 'animation', configVersion: 1, placements: ['design'], delivery: 'static', defaultSize: { width: 300, height: 180 }, defaults: {} },
  { kind: 'shape', configVersion: 1, placements: ['scene', 'design'], delivery: 'static', defaultSize: { width: 300, height: 180 }, defaults: {} }
] as const satisfies readonly WidgetDefinition[];
export type WidgetKind = typeof WIDGET_DEFINITIONS[number]['kind'];
export function getWidgetDefinition(kind: unknown): WidgetDefinition & { kind: WidgetKind } | undefined {
  return WIDGET_DEFINITIONS.find(definition => definition.kind === kind);
}
/** Placement support is independent of palette visibility. */
export function widgetKinds(placement: WidgetPlacement): WidgetKind[] {
  return WIDGET_DEFINITIONS.filter(definition => (definition.placements as readonly WidgetPlacement[]).includes(placement)).map(definition => definition.kind);
}
export interface ParsedWidgetModuleConfig { configVersion?: number; config?: Record<string, unknown>; legacy: Record<string, unknown> }
function validModuleValue(field: WidgetConfigField | undefined, value: unknown): boolean {
  if (!field) return false;
  if (field.values) return field.values.includes(value);
  if (field.type === 'string') return typeof value === 'string' && value.length > 0 && value.length <= (field.maxLength ?? 2000);
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= (field.min ?? -Number.MAX_VALUE) && value <= (field.max ?? Number.MAX_VALUE);
  return field.type === 'boolean' && typeof value === 'boolean';
}
/** Validate and copy only registered module fields; styling/media have separate host validation. */
export function parseWidgetModuleConfig(raw: Record<string, unknown>, placement: WidgetPlacement): ParsedWidgetModuleConfig | undefined {
  const definition = getWidgetDefinition(raw['kind']);
  if (!definition || !definition.placements.includes(placement) || (raw['configVersion'] === undefined ? 1 : raw['configVersion']) !== definition.configVersion) return undefined;
  const fields = definition.configFields ?? {};
  const legacy: Record<string, unknown> = {};
  const allFields = new Set(WIDGET_DEFINITIONS.flatMap(item => Object.keys((item as WidgetDefinition).configFields ?? {})));
  for (const key of allFields) if (raw[key] !== undefined) {
    if (!validModuleValue(fields[key], raw[key])) return undefined;
    legacy[key] = structuredClone(raw[key]);
  }
  const result: ParsedWidgetModuleConfig = { legacy };
  if (raw['configVersion'] !== undefined) result.configVersion = definition.configVersion;
  if (raw['config'] !== undefined) {
    if (!raw['config'] || typeof raw['config'] !== 'object' || Array.isArray(raw['config'])) return undefined;
    result.config = {};
    for (const [key, value] of Object.entries(raw['config'])) {
      if (!Object.hasOwn(fields, key) || !validModuleValue(fields[key], value)) return undefined;
      result.config[key] = structuredClone(value);
    }
  }
  return result;
}
export function validWidgetModuleConfig(raw: Record<string, unknown>, placement: WidgetPlacement): boolean {
  return parseWidgetModuleConfig(raw, placement) !== undefined;
}
/** A missing key means unavailable/unrequested; a null state explicitly clears that module. */
export interface WidgetStateEntry { revision: number; state: unknown }
export type WidgetStates = Record<string, WidgetStateEntry>;
export interface WidgetStateSnapshot { widgetStates: WidgetStates; serverTime: number; failedSources?: string[] }
